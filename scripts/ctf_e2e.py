"""Full-stack CTF check: form a real match through the queue, then play it over WebSockets.

    pip install httpx websockets
    python scripts/ctf_e2e.py 1     # 1v1  (two solos, fill off)
    python scripts/ctf_e2e.py 2     # 2v2  (two parties of 2, fill off)
    python scripts/ctf_e2e.py 4     # 4v4  (eight solos, fill on)   default: all three
    python scripts/ctf_e2e.py recovery   # restart game-service mid-match (needs docker compose)
    CTF_CRASH=1 python scripts/ctf_e2e.py recovery   # same, but SIGKILL instead of a clean stop
    python scripts/ctf_e2e.py bots       # 1 human + 7 bots (docker compose --profile demo up -d bots)

Stack running, bots stopped. Goes through nginx (:8080) -> gateway -> game-service, the
same path a browser uses. Every player holds its own socket; the scenario checks that all
2N clients see the same authoritative combat, flag drop/return and capture.
"""

import asyncio
import json
import math
import os
import subprocess
import sys
import time
import uuid

import websockets
from api import ApiFail, Client

WS = os.environ.get("WS_URL", "ws://localhost:8080/api/game/ws")
RED_BASE, BLUE_FLAG = (110, 350), (1090, 350)
LANE = [(60, 350), (500, 350), (500, 180), (700, 180), (700, 350), (1090, 350)]  # red spawn -> blue flag, around walls


def form_match(n: int) -> tuple[str, list[Client], list[Client]]:
    tag = uuid.uuid4().hex[:5]
    players = [Client().register(f"ctf{n}{i}{tag}", "password123") for i in range(2 * n)]
    fill = n == 4  # 4v4 fills from solos; 1v1/2v2 queue fixed-size parties with fill off
    leaders = players if fill else players[::n]
    if not fill and n > 1:
        for lead in leaders:
            for mate in players[players.index(lead) + 1 : players.index(lead) + n]:
                lead.befriend(mate)
                lead.invite_and_join(mate)
    for lead in leaders:
        lead.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": fill})
    for _ in range(30):
        s = players[0].status()
        if s["state"] == "found":
            break
        time.sleep(0.5)
    m = s["match"]
    ids = {c.me["id"]: c for c in players}
    assert {p["id"] for t in m["teams"] for p in t["players"]} == set(ids), "match has players from outside this test"
    for c in players:
        c.call("POST", f"/matchmaking/matches/{m['match_id']}/ready")
    for _ in range(20):  # server-driven countdown, no manual enter
        if players[0].status()["state"] == "entered":
            break
        time.sleep(0.5)
    else:
        raise AssertionError("match never started after everyone readied")
    red = [ids[p["id"]] for p in m["teams"][0]["players"]]
    blue = [ids[p["id"]] for p in m["teams"][1]["players"]]
    assert len(red) == len(blue) == n
    return m["match_id"], red, blue


class Seat:
    """One player's socket, always holding the latest snapshot it received."""

    def __init__(self, client: Client, ws):
        self.id, self.ws, self.s, self.states = client.me["id"], ws, None, 0

    async def pump(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if msg["t"] == "state":
                self.s, self.states = msg, self.states + 1

    def me(self, pid=None):
        return next(p for p in self.s["players"] if p["id"] == (pid or self.id))

    def flag(self, team):
        return next(f for f in self.s["flags"] if f["team"] == team)

    async def send(self, **m):
        await self.ws.send(json.dumps(m))

    async def until(self, cond, timeout=15.0):
        end = time.time() + timeout
        while time.time() < end:
            if self.s and cond(self.s):
                return self.s
            await asyncio.sleep(0.02)
        raise AssertionError(f"timed out waiting on {cond.__code__.co_firstlineno}")

    async def walk(self, points, stop=lambda s: s["state"] == "ENDED"):
        for tx, ty in points:
            while True:
                await asyncio.sleep(0.03)
                p = self.me()
                dx, dy = tx - p["x"], ty - p["y"]
                if abs(dx) < 6 and abs(dy) < 6 or stop(self.s) or not p["alive"]:
                    break
                await self.send(t="input", right=dx > 5, left=dx < -5, down=dy > 5, up=dy < -5)
            if stop(self.s) or not self.me()["alive"]:
                break
        await self.send(t="input")

    async def kill_once(self, victim: "Seat"):
        hp = self.me(victim.id)["hp"]
        while self.me(victim.id)["hp"] == hp:
            v = self.me(victim.id)
            await self.send(t="fire", x=v["x"], y=v["y"])
            await asyncio.sleep(0.55)

    async def kill(self, victim: "Seat"):
        """Shoot at the victim's server position until the server says it is dead."""
        while self.me(victim.id)["alive"]:
            v = self.me(victim.id)
            await self.send(t="fire", x=v["x"], y=v["y"])
            await asyncio.sleep(0.55)


async def play(mid: str, red: list[Client], blue: list[Client]) -> None:
    n = len(red)
    async with websockets.connect(f"{WS}/{mid}?token=bad") as bad:
        assert json.loads(await bad.recv())["t"] == "error"

    sockets = [await websockets.connect(f"{WS}/{mid}?token={c.token}") for c in red + blue]
    seats = []
    for c, ws in zip(red + blue, sockets):
        hello = json.loads(await ws.recv())
        assert hello["t"] == "hello" and hello["you"] == c.me["id"]
        seats.append(Seat(c, ws))
    pumps = [asyncio.create_task(s.pump()) for s in seats]
    R, B = seats[:n], seats[n:]
    try:
        for s in seats:
            await s.until(lambda st: all(p["connected"] for p in st["players"]))
        st = R[0].s
        assert len(st["players"]) == 2 * n and all(p["alive"] and p["hp"] == 100 for p in st["players"])
        assert [f["state"] for f in st["flags"]] == ["AT_BASE", "AT_BASE"]
        print(f"  {2 * n} sockets connected, all spawned at 100 HP")

        # Combat: red0 and blue0 meet in the top lane; red0 kills blue0 (4 x 25 dmg).
        await asyncio.gather(R[0].walk([(60, 350), (500, 350), (500, 180)]), B[0].walk([(1140, 350), (700, 350), (700, 180)]))
        await R[0].kill(B[0])
        dead = B[0].me()
        assert dead["hp"] == 0 and not dead["alive"] and dead["respawnAt"]
        for s in seats:  # every client agrees
            await s.until(lambda st: not next(p for p in st["players"] if p["id"] == B[0].id)["alive"])
        await B[0].until(lambda st: B[0].me()["alive"], timeout=5)
        assert B[0].me()["hp"] == 100 and B[0].me()["x"] > 1000
        print("  kill + 3 s respawn seen by all clients")

        # Flag drop on death: red0 grabs blue flag, blue0 (at home) shoots the carrier.
        await R[0].walk(LANE[3:])
        await R[0].until(lambda st: R[0].flag("BLUE")["carrierId"] == R[0].id)
        assert R[0].me()["carryingFlag"]
        await R[0].walk([(1000, 350)])  # step off the flag stand so the drop point differs from base
        await B[0].kill(R[0])
        await B[0].until(lambda st: B[0].flag("BLUE")["state"] == "DROPPED")
        f = B[0].flag("BLUE")
        assert f["carrierId"] is None and abs(f["x"] - 1000) < 12, f
        print("  carrier killed -> flag DROPPED at death position")

        # Own team recovers it by touching it.
        await B[0].walk([(f["x"], f["y"])], stop=lambda st: B[0].flag("BLUE")["state"] == "AT_BASE")
        await B[0].until(lambda st: B[0].flag("BLUE")["state"] == "AT_BASE")
        assert (B[0].flag("BLUE")["x"], B[0].flag("BLUE")["y"]) == BLUE_FLAG
        print("  own team touched dropped flag -> AT_BASE")

        # Capture with the last red player (red0 in 1v1), blue0 parked off the lane.
        runner = R[-1]
        await B[0].walk([(1140, 600)])
        await runner.until(lambda st: runner.me()["alive"], timeout=5)
        start = runner.me()
        await runner.walk([(start["x"], 350)] + LANE[1:])
        await runner.until(lambda st: runner.flag("BLUE")["carrierId"] == runner.id)
        await runner.walk(list(reversed(LANE))[1:-1] + [RED_BASE])
        for s in seats:
            await s.until(lambda st: st["scores"]["RED"] == 1)
            assert s.s["state"] == "PLAYING" and s.s["scores"]["BLUE"] == 0 and s.s["roundWinner"] == "RED"
        print(f"  capture -> RED scores round 1 (match continues) on all {2 * n} clients")
    finally:
        for p in pumps:
            p.cancel()
        for ws in sockets:
            await ws.close()


async def recovery(mid: str, red: list[Client], blue: list[Client]) -> None:
    """Mid-match state (carrier, damage, positions) survives a game-service restart."""

    async def seats():
        socks = [await websockets.connect(f"{WS}/{mid}?token={c.token}") for c in red + blue]
        out = []
        for c, ws in zip(red + blue, socks):
            hello = json.loads(await ws.recv())
            assert hello["t"] == "hello", hello
            out.append(Seat(c, ws))
        return out, [asyncio.create_task(x.pump()) for x in out]

    both, pumps = await seats()
    R, B = both[0], both[1]
    await R.until(lambda st: all(p["connected"] for p in st["players"]))
    # red: steal the flag; blue: take some damage in the lane
    await asyncio.gather(R.walk(LANE[:3]), B.walk([(1140, 350), (700, 350), (700, 180)]))
    await R.kill_once(B)
    await R.walk(LANE[3:])
    await R.until(lambda st: R.flag("BLUE")["carrierId"] == R.id)
    await R.walk([(1000, 440)])
    await asyncio.sleep(3.5)  # at least one periodic checkpoint after the last change
    before = R.s
    for p in pumps:
        p.cancel()
    t0 = time.time()
    if os.environ.get("CTF_CRASH"):  # hard kill: no shutdown checkpoint, only the periodic one
        subprocess.run(["docker", "compose", "kill", "game-service"], check=True, capture_output=True)
        subprocess.run(["docker", "compose", "start", "game-service"], check=True, capture_output=True)
    else:
        subprocess.run(["docker", "compose", "restart", "game-service"], check=True, capture_output=True)
    print(f"  game-service {'killed and started' if os.environ.get('CTF_CRASH') else 'restarted'} in {time.time() - t0:.1f}s")
    for _ in range(40):  # service is still booting right after restart
        try:
            both, pumps = await seats()
            break
        except (OSError, AssertionError, websockets.ConnectionClosed):
            await asyncio.sleep(0.5)
    R, B = both
    await R.until(lambda st: all(p["connected"] for p in st["players"]))
    after = R.s
    for p0 in before["players"]:
        p1 = next(p for p in after["players"] if p["id"] == p0["id"])
        assert abs(p1["x"] - p0["x"]) < 1 and abs(p1["y"] - p0["y"]) < 1 and p1["hp"] == p0["hp"] and p1["carryingFlag"] == p0["carryingFlag"], (p0, p1)
    assert R.flag("BLUE")["carrierId"] == R.id and after["elapsed"] >= before["elapsed"]
    print(f"  restored: carrier + positions + HP (blue at {B.me()['hp']} HP), clock {before['elapsed'] // 1000}s -> {after['elapsed'] // 1000}s")
    await R.walk(list(reversed(LANE))[1:-1] + [RED_BASE])
    await B.until(lambda st: st["scores"]["RED"] == 1)
    assert B.s["state"] == "PLAYING"
    print("  match continued to a capture after restart")
    for p in pumps:
        p.cancel()
    for x in both:
        await x.ws.close()


def run_recovery() -> None:
    mid, red, blue = form_match(1)
    print(f"recovery 1v1 match {mid[:8]}")
    asyncio.run(recovery(mid, red, blue))
    for c in red + blue:
        c.call("POST", f"/matchmaking/matches/{mid}/leave")
    print("RECOVERY E2E PASSED")


def run_bots(max_s: float = 660) -> None:
    """One passive human in a 4v4 with the 7 demo bots: bots must move, fight, take flags,
    survive a game-service restart (reconnect on their own) and finish the match."""
    human = Client().register(f"ctfh{uuid.uuid4().hex[:5]}", "password123")
    human.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": True})
    for _ in range(90):
        try:
            human.call("POST", "/users/me/heartbeat")  # stale presence gets a queued party invalidated
            s = human.status()
        except ApiFail:  # matchmaking status() can 500 while the matcher claims our entry; poll again
            time.sleep(1)
            continue
        if s["state"] == "found" and len(s["match"]["ready"]) >= 7:
            break
        time.sleep(1)
    else:
        raise AssertionError("no 4v4 with the bots formed (are the bots running and idle?)")
    mid = s["match"]["match_id"]
    human.call("POST", f"/matchmaking/matches/{mid}/ready")
    for _ in range(20):
        if human.status()["state"] == "entered":
            break
        time.sleep(0.5)
    else:
        raise AssertionError("match never started after the human readied")
    print(f"1 human + 7 bots, match {mid[:8]}")

    async def watch():
        stats = {"moved": set(), "shots": set(), "deaths": 0, "stolen": 0, "returned": 0, "respawned": 0}
        start_pos, prev, restarted, reconnected = {}, None, False, False
        t0 = time.time()
        while time.time() - t0 < max_s:
            try:
                async with websockets.connect(f"{WS}/{mid}?token={human.token}") as ws:
                    assert json.loads(await ws.recv())["t"] == "hello"
                    async for raw in ws:
                        st = json.loads(raw)
                        bots = {p["id"] for p in st["players"] if p["bot"]}
                        for p in st["players"]:
                            start_pos.setdefault(p["id"], (p["x"], p["y"]))
                            if p["id"] in bots and math.dist(start_pos[p["id"]], (p["x"], p["y"])) > 100:
                                stats["moved"].add(p["id"])
                        if prev:
                            was = {p["id"]: p for p in prev["players"]}
                            for p in st["players"]:
                                q = was.get(p["id"])
                                stats["deaths"] += bool(q and q["alive"] and not p["alive"])
                                stats["respawned"] += bool(q and not q["alive"] and p["alive"])
                            for f, g in zip(prev["flags"], st["flags"]):
                                stats["stolen"] += g["state"] == "CARRIED" and f["state"] != "CARRIED"
                                stats["returned"] += g["state"] == "AT_BASE" and f["state"] == "DROPPED"
                            new = {x["id"] for x in st["shots"]} - {x["id"] for x in prev["shots"]}
                            for sh in st["shots"]:
                                if sh["id"] in new:
                                    shooter = min((p for p in st["players"] if p["team"] == sh["team"]), key=lambda p: math.dist((p["x"], p["y"]), (sh["x"], sh["y"])))
                                    if shooter["id"] in bots:
                                        stats["shots"].add(shooter["id"])
                        prev = st
                        if not restarted and time.time() - t0 > 6 and len(bots) == 7 and all(p["connected"] for p in st["players"]):
                            print(f"  {time.time() - t0:.0f}s, restarting game-service: {len(stats['moved'])}/7 bots moved, {len(stats['shots'])} bots fired, {stats['deaths']} deaths, flag steals {stats['stolen']}")
                            restarted = True
                            subprocess.run(["docker", "compose", "restart", "game-service"], check=True, capture_output=True)
                            break  # our socket dies with the service; reconnect below
                        if restarted and not reconnected and all(p["connected"] for p in st["players"]):
                            reconnected = True
                            print(f"  after restart: all 7 bots reconnected at {time.time() - t0:.0f}s")
                        if st["state"] == "ENDED":
                            mine = next(p for p in st["players"] if p["id"] == human.me["id"])
                            print(f"  {st['winner']} TEAM WINS after {st['elapsed'] // 1000}s: human (on {mine['team']}) {'won' if st['winner'] == mine['team'] else 'lost'}")
                            return {**stats, "reconnected": reconnected}
            except (OSError, websockets.ConnectionClosed, websockets.InvalidHandshake):
                await asyncio.sleep(1)
        raise AssertionError(f"bots match did not finish in {max_s}s: {stats}")

    st = asyncio.run(watch())
    assert st.pop("reconnected"), "bots did not reconnect after the restart"
    assert len(st["moved"]) == 7 and len(st["shots"]) >= 4 and st["deaths"] and st["respawned"] and st["stolen"], st
    print(f"  totals: {st['deaths']} deaths, {st['respawned']} respawns, {st['stolen']} flag steals, {st['returned']} flag returns")
    human.call("POST", f"/matchmaking/matches/{mid}/leave")
    print("BOTS E2E PASSED")


def run(n: int) -> None:
    mid, red, blue = form_match(n)
    print(f"{n}v{n} match {mid[:8]}")
    asyncio.run(play(mid, red, blue))
    for c in red + blue:
        c.call("POST", f"/matchmaking/matches/{mid}/leave")
    assert red[0].status()["state"] == "idle"
    print(f"{n}v{n} CTF E2E PASSED")


if __name__ == "__main__":
    for arg in sys.argv[1:] or ["1", "2", "4"]:
        {"recovery": run_recovery, "bots": run_bots}.get(arg, lambda: run(int(arg)))()
