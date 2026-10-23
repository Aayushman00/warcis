"""Full-stack CTF check: form a real match through the queue, then play it over WebSockets.

    pip install httpx websockets
    python scripts/ctf_e2e.py 1     # 1v1  (two solos, fill off)
    python scripts/ctf_e2e.py 2     # 2v2  (two parties of 2, fill off)
    python scripts/ctf_e2e.py 4     # 4v4  (eight solos, fill on)   default: all three
    python scripts/ctf_e2e.py recovery   # restart game-service mid-match (needs docker compose)
    CTF_CRASH=1 python scripts/ctf_e2e.py recovery   # same, but SIGKILL instead of a clean stop
    python scripts/ctf_e2e.py bots       # 1 human + 7 bots (docker compose --profile demo up -d bots)
    python scripts/ctf_e2e.py abilities  # classes: invisibility privacy, barrier, dash, over real sockets

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
CLASSES = ("ASSAULTER", "GUARDIAN", "ASSASSIN")
WEAPONS = ("ASSAULT_RIFLE", "SHOTGUN", "SNIPER_RIFLE")
COMBOS = [(c, w) for c in CLASSES for w in WEAPONS]
RED_BASE, BLUE_FLAG = (110, 350), (1090, 350)
LANE = [(60, 350), (500, 350), (500, 180), (700, 180), (700, 350), (1090, 350)]  # red spawn -> blue flag, around walls


def default_pick(team: int, seat: int) -> tuple[str, str]:
    """The fighters (seat 0) keep the baseline Assaulter + rifle the scenarios were written for; everyone else varies."""
    return ("ASSAULTER", "ASSAULT_RIFLE") if seat == 0 else COMBOS[(seat * 4 + team) % len(COMBOS)]


async def _bypass(mid: str, token: str) -> dict:
    async with websockets.connect(f"{WS}/{mid}?token={token}") as ws:
        return json.loads(await ws.recv())


def form_match(n: int, pick=default_pick) -> tuple[str, list[Client], list[Client]]:
    """Queue, then go through the lobby like a browser: pick class + weapon (pick(team, seat)), ready, countdown."""
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
    red = [ids[p["id"]] for p in m["teams"][0]["players"]]
    blue = [ids[p["id"]] for p in m["teams"][1]["players"]]
    err = asyncio.run(_bypass(m["match_id"], players[0].token))  # the lobby cannot be skipped by opening the game socket early
    assert err["t"] == "error" and err["code"] == "MATCH_NOT_STARTED", err
    for team, side in enumerate((red, blue)):
        for seat, c in enumerate(side):
            cls, weapon = pick(team, seat)
            c.call("PUT", f"/matchmaking/matches/{m['match_id']}/loadout", {"class": cls, "weapon": weapon})
    for c in players:
        c.call("POST", f"/matchmaking/matches/{m['match_id']}/ready")
    for _ in range(20):  # server-driven countdown, no manual enter
        if players[0].status()["state"] == "entered":
            break
        time.sleep(0.5)
    else:
        raise AssertionError("match never started after everyone readied")
    assert len(red) == len(blue) == n
    return m["match_id"], red, blue


class Seat:
    """One player's socket, always holding the latest snapshot it received."""

    def __init__(self, client: Client, ws):
        self.id, self.ws, self.s, self.states = client.me["id"], ws, None, 0
        self.log: list[dict] = []  # every state frame received, in order

    async def pump(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if msg["t"] == "state":
                self.s, self.states = msg, self.states + 1
                self.log.append(msg)

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
        assert len(st["players"]) == 2 * n and all(p["alive"] and p["hp"] == p["maxHp"] for p in st["players"])
        assert {p["maxHp"] for p in st["players"]} <= {85, 100, 140}
        assert [f["state"] for f in st["flags"]] == ["AT_BASE", "AT_BASE"]
        print(f"  {2 * n} sockets connected, all spawned at their class's full HP")

        # Combat: red0 and blue0 meet in the top lane; red0 kills blue0 (4 x 25 dmg).
        await asyncio.gather(R[0].walk([(60, 350), (500, 350), (500, 180)]), B[0].walk([(1140, 350), (700, 350), (700, 180)]))
        await R[0].kill(B[0])
        dead = B[0].me()
        assert dead["hp"] == 0 and not dead["alive"] and dead["respawnAt"]
        for s in seats:  # every client agrees
            await s.until(lambda st: not next(p for p in st["players"] if p["id"] == B[0].id)["alive"])
        await B[0].until(lambda st: B[0].me()["alive"], timeout=5)
        assert B[0].me()["hp"] == B[0].me()["maxHp"] and B[0].me()["x"] > 1000
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
    # Abilities in flight: red's Guardian drops a barrier, blue's Assassin cloaks.
    await R.send(t="ability", x=1000, y=350)
    await B.send(t="ability", x=0, y=0)
    await R.until(lambda st: st["barriers"])
    await B.until(lambda st: B.me()["invisible"])
    bar0, ready_r, ready_b, cloaked_at = R.s["barriers"][0], R.me()["abilityReadyAt"], B.me()["abilityReadyAt"], B.s["now"]
    assert R.me()["abilityReadyAt"] > R.s["now"] + 10_000 and B.me()["abilityReadyAt"] > B.s["now"] + 10_000
    await asyncio.sleep(3.3)  # at least one periodic checkpoint after the last change
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
        if p0["x"] is not None and p1["x"] is not None:  # the cloaked blue player has no coordinates in red's view
            assert abs(p1["x"] - p0["x"]) < 1 and abs(p1["y"] - p0["y"]) < 1, (p0, p1)
        assert p1["hp"] == p0["hp"] and p1["carryingFlag"] == p0["carryingFlag"], (p0, p1)
        assert (p1["class"], p1["weapon"], p1["maxHp"]) == (p0["class"], p0["weapon"], p0["maxHp"]), (p0, p1)
    assert R.flag("BLUE")["carrierId"] == R.id and after["elapsed"] >= before["elapsed"]
    assert R.me()["abilityReadyAt"] == ready_r and B.me()["abilityReadyAt"] == ready_b, "ability cooldowns must survive the restart"
    if after["now"] < bar0["expiresAt"]:  # the barrier clock keeps running through the downtime
        kept = [b for b in R.s["barriers"] if b["id"] == bar0["id"]]
        assert kept and kept[0]["hp"] == bar0["hp"] and kept[0]["expiresAt"] == bar0["expiresAt"], (bar0, R.s["barriers"])
        print("  restored: barrier (same id, HP and expiry)")
    if after["now"] < cloaked_at + 5000:
        assert B.me()["invisible"] and next(p for p in R.s["players"] if p["id"] == B.id)["hidden"], "invisibility lost or leaked after the restart"
        print("  restored: invisibility still hidden from the enemy")
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
    mid, red, blue = form_match(1, pick=lambda team, seat: ("GUARDIAN", "ASSAULT_RIFLE") if team == 0 else ("ASSASSIN", "ASSAULT_RIFLE"))
    print(f"recovery 1v1 match {mid[:8]}")
    asyncio.run(recovery(mid, red, blue))
    for c in red + blue:
        c.call("POST", f"/matchmaking/matches/{mid}/leave")
    print("RECOVERY E2E PASSED")


async def open_seats(mid: str, clients: list[Client]):
    socks = [await websockets.connect(f"{WS}/{mid}?token={c.token}") for c in clients]
    seats = []
    for c, ws in zip(clients, socks):
        hello = json.loads(await ws.recv())
        assert hello["t"] == "hello" and hello["you"] == c.me["id"] and {"classes", "weapons"} <= set(hello["catalog"]), hello
        seats.append(Seat(c, ws))
    return seats, [asyncio.create_task(x.pump()) for x in seats]


async def close_seats(seats, pumps):
    for p in pumps:
        p.cancel()
    for x in seats:
        await x.ws.close()


async def first_state(mid: str, client: Client) -> dict:
    """What a (re)connecting client receives before anything else: hello, then the first state frame."""
    async with websockets.connect(f"{WS}/{mid}?token={client.token}") as ws:
        assert json.loads(await ws.recv())["t"] == "hello"
        msg = json.loads(await ws.recv())
        assert msg["t"] == "state", msg
        return msg


async def invisibility(mid, red, blue) -> None:
    """red[0] is an Assassin. Enemy sockets must never receive its coordinates while it is invisible."""
    seats, pumps = await open_seats(mid, red + blue)
    (R0, R1), (B0, B1) = seats[:2], seats[2:]
    try:
        for s in seats:
            await s.until(lambda st: all(p["connected"] for p in st["players"]))
        assert R0.me()["class"] == "ASSASSIN" and R0.me()["maxHp"] == 100 and B1.me(B1.id)["maxHp"] == 140 and B0.me(B0.id)["maxHp"] == 85
        # both lanes to the top edge, where red0 and blue0 see each other along y = 30
        await asyncio.gather(R0.walk([(60, 30), (400, 30)]), B0.walk([(1140, 30), (800, 30)]), B1.walk([(1140, 350)]), R1.walk([(60, 350)]))
        await R0.send(t="ability", x=1000, y=30)
        await R0.until(lambda st: R0.me()["invisible"])
        t_cloak = next(f["now"] for f in R0.log if next(p for p in f["players"] if p["id"] == R0.id)["invisible"])
        await R1.until(lambda st: R1.me(R0.id)["invisible"] and R1.me(R0.id)["x"] is not None)  # the ally still sees it
        await B0.until(lambda st: B0.me(R0.id)["hidden"])
        await asyncio.sleep(1.0)
        for b in (B0, B1):
            late = [f for f in b.log if f["now"] > t_cloak + 60]  # ticks after the activation reached the enemy view
            row = [next(p for p in f["players"] if p["id"] == R0.id) for f in late]
            assert row and all(p["x"] is None and p["y"] is None and p["hidden"] and not p["invisible"] and not p["dashing"] for p in row), "invisible coordinates reached the enemy"
            assert all(p["abilityReadyAt"] is None for p in row)
        print("  invisible: allies see the Assassin, enemy frames carry no coordinates")
        # A fresh connection (refresh / reconnect) must be filtered from its very first frame.
        # (The newest socket of a player wins, so blue1 and red1 are done after this; blue0 carries on.)
        first = await first_state(mid, blue[1])
        row = next(p for p in first["players"] if p["id"] == R0.id)
        assert row["x"] is None and row["hidden"], "first frame after (re)connect leaked the invisible player"
        again = await first_state(mid, red[1])
        assert next(p for p in again["players"] if p["id"] == R0.id)["x"] is not None
        print("  invisible: first frame after a reconnect is filtered too")
        # A hit reveals it: blue0 (sniper) shoots at where red0 really is.
        spot = R0.me()
        await B0.send(t="fire", x=spot["x"], y=spot["y"])
        await B0.until(lambda st: B0.me(R0.id)["x"] is not None and not B0.me(R0.id)["hidden"], timeout=4)
        assert R0.me()["hp"] < 100 and not R0.me()["invisible"]
        print(f"  invisible: a hit revealed it ({R0.me()['hp']} HP left)")
        # Firing reveals too: cloak again once the cooldown allows, shoot, never visible-with-shot-while-hidden.
        await R0.until(lambda st: R0.s["now"] >= R0.me()["abilityReadyAt"], timeout=20)
        await R0.send(t="ability", x=1000, y=30)
        await R0.until(lambda st: R0.me()["invisible"])
        await R0.send(t="fire", x=1000, y=30)
        await B0.until(lambda st: B0.me(R0.id)["x"] is not None, timeout=3)
        for f in B0.log:  # no frame ever holds a hidden shooter next to its own fresh shot
            hid = next(p for p in f["players"] if p["id"] == R0.id)["hidden"]
            assert not (hid and any(sh["owner"] == R0.id for sh in f["shots"]))
        print("  invisible: firing revealed it, and no frame showed a hidden shooter with its shot")
    finally:
        await close_seats(seats, pumps)


async def barrier(mid, red, blue) -> None:
    """red0 Guardian behind a barrier, blue0 Assaulter with a sniper rifle (70 per hit)."""
    seats, pumps = await open_seats(mid, red + blue)
    G, S = seats
    try:
        for s in seats:
            await s.until(lambda st: all(p["connected"] for p in st["players"]))
        assert G.me()["maxHp"] == 140 and S.me(S.id)["maxHp"] == 85
        await asyncio.gather(G.walk([(60, 350), (300, 350)]), S.walk([(1140, 350), (700, 350), (700, 180), (500, 180), (480, 350)]))
        await G.send(t="ability", x=480, y=350)
        await S.until(lambda st: len(st["barriers"]) == 1)
        bar = S.s["barriers"][0]
        assert bar["team"] == "RED" and bar["hp"] == bar["maxHp"] == 150 and 310 < bar["x"] + bar["w"] / 2 < 370, bar
        await G.send(t="ability", x=480, y=350)  # still on cooldown: ignored
        assert G.me()["abilityReadyAt"] - G.s["now"] > 10_000
        hp0 = G.me()["hp"]
        for expect_hp in (80, 10):  # the barrier soaks the sniper rounds
            await S.send(t="fire", x=300, y=350)
            await S.until(lambda st: st["barriers"] and st["barriers"][0]["hp"] == expect_hp, timeout=3)
            assert G.me()["hp"] == hp0
            await asyncio.sleep(1.6)
        await S.send(t="fire", x=300, y=350)
        await S.until(lambda st: not st["barriers"], timeout=3)  # the third round breaks it...
        assert G.me()["hp"] == hp0
        await asyncio.sleep(1.6)
        await S.send(t="fire", x=300, y=350)  # ...and the next one reaches the Guardian
        await G.until(lambda st: G.me()["hp"] == hp0 - 70, timeout=3)
        print("  barrier: absorbed 3 sniper rounds (150 -> 80 -> 10 -> broken), the 4th hit the Guardian")
    finally:
        await close_seats(seats, pumps)


async def dash(mid, red, blue) -> None:
    """red0 Assaulter dashes while blue0 (rifle) is shooting at it."""
    seats, pumps = await open_seats(mid, red + blue)
    A, G = seats
    try:
        for s in seats:
            await s.until(lambda st: all(p["connected"] for p in st["players"]))
        await asyncio.gather(A.walk([(60, 30), (400, 30)]), G.walk([(1140, 30), (620, 30)]))
        assert A.me()["maxHp"] == 85 and A.me()["class"] == "ASSAULTER"
        stop = asyncio.Event()

        async def suppress():
            while not stop.is_set():
                a = G.me(A.id)
                await G.send(t="fire", x=a["x"], y=a["y"])
                await asyncio.sleep(0.2)

        row = lambda f: next(p for p in f["players"] if p["id"] == A.id)  # noqa: E731
        task = asyncio.create_task(suppress())
        await asyncio.sleep(0.5)  # rounds are in flight
        # Baseline = the last frame received BEFORE the cast. The server moves the dash for the part of its fixed
        # 160 ms window that has elapsed at each tick, so the first frame after the cast already shows a partial
        # dash (about 5-35 px): measuring from it undercounts. A holds still, so check the baseline really is rest.
        n0 = len(A.log)
        rest = [row(f) for f in A.log[max(0, n0 - 5) : n0]]
        base = rest[-1]
        assert len(rest) >= 3 and base["alive"] and not base["dashing"], base
        assert all(abs(r["x"] - base["x"]) < 0.05 and abs(r["y"] - base["y"]) < 0.05 for r in rest), f"A was not at rest: {[(r['x'], r['y']) for r in rest]}"
        assert abs(base["y"] - 30) < 8 and 100 < base["x"] < 450, f"A must be in the open top lane (walls start at y=60), got {base}"  # nothing to block 160 px
        await A.send(t="ability", x=900, y=30)  # no keys held: dash toward the aim point
        await A.until(lambda st: A.me()["dashing"], timeout=2)
        await A.until(lambda st: not A.me()["dashing"], timeout=2)
        stop.set()
        await task
        await asyncio.sleep(0.3)  # frames after the dash: the final position must be stable, i.e. the dash is over
        frames = A.log[n0:]  # snapshots that arrived after the request was sent (the first ones may already be mid-dash)
        d = [i for i, f in enumerate(frames) if row(f)["dashing"]]
        assert d and d == list(range(d[0], d[-1] + 1)), f"dashing frames are not one contiguous run: {d}"
        done = frames[d[-1] + 1 :]  # first non-dashing frame onward
        assert len(done) >= 3, "no settled frames after the dash"
        end = row(done[0])
        assert all(abs(row(f)["x"] - end["x"]) < 0.05 for f in done), "still moving after the dash ended"
        moved = math.hypot(end["x"] - base["x"], end["y"] - base["y"])  # the dash aims at (900, 30), so allow the tiny y component
        # Open ground, no keys held: the server dash is 160 px (it is exact in the sim self-check). 157..163 leaves room for
        # the 0.1 px snapshot rounding only; a missing, short or doubled dash fails it.
        assert 157 <= moved <= 163, f"dash covered {moved:.1f}px"
        assert abs(end["y"] - base["y"]) < 3 and end["x"] > base["x"], f"dash went the wrong way: {base['x']},{base['y']} -> {end['x']},{end['y']}"
        assert all(row(f)["alive"] for f in frames), "A died or respawned during the measurement"
        win = [base] + [row(f) for f in frames]
        hits = [i for i in range(1, len(win)) if win[i]["dashing"] and win[i]["hp"] < win[i - 1]["hp"]]  # incl. the first frame
        assert hits, "the dashing player was never damageable"
        ready = row(frames[-1])["abilityReadyAt"]
        await A.send(t="ability", x=900, y=30)  # on cooldown
        await asyncio.sleep(0.4)
        assert not A.me()["dashing"] and A.me()["abilityReadyAt"] == ready
        print(f"  dash: {moved:.0f} px in ~160 ms, took damage mid-dash ({len(hits)} hit frames), cooldown enforced")
    finally:
        await close_seats(seats, pumps)


def run_abilities() -> None:
    mid, red, blue = form_match(2, pick=lambda team, seat: [[("ASSASSIN", "ASSAULT_RIFLE"), ("ASSAULTER", "ASSAULT_RIFLE")], [("ASSAULTER", "SNIPER_RIFLE"), ("GUARDIAN", "ASSAULT_RIFLE")]][team][seat])
    print(f"abilities 2v2 match {mid[:8]}: invisibility")
    asyncio.run(invisibility(mid, red, blue))
    for c in red + blue:
        c.call("POST", f"/matchmaking/matches/{mid}/leave")
    mid, red, blue = form_match(1, pick=lambda team, seat: ("GUARDIAN", "ASSAULT_RIFLE") if team == 0 else ("ASSAULTER", "SNIPER_RIFLE"))
    print(f"abilities 1v1 match {mid[:8]}: barrier")
    asyncio.run(barrier(mid, red, blue))
    for c in red + blue:
        c.call("POST", f"/matchmaking/matches/{mid}/leave")
    mid, red, blue = form_match(1, pick=lambda team, seat: ("ASSAULTER", "ASSAULT_RIFLE") if team == 0 else ("GUARDIAN", "ASSAULT_RIFLE"))
    print(f"abilities 1v1 match {mid[:8]}: dash")
    asyncio.run(dash(mid, red, blue))
    for c in red + blue:
        c.call("POST", f"/matchmaking/matches/{mid}/leave")
    print("ABILITIES E2E PASSED")


def run_bots(max_s: float = 780) -> None:  # 12:00 hard stop + room for the restart
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
    human.call("PUT", f"/matchmaking/matches/{mid}/loadout", {"class": "GUARDIAN", "weapon": "SHOTGUN"})
    human.call("POST", f"/matchmaking/matches/{mid}/ready")
    for _ in range(20):
        if human.status()["state"] == "entered":
            break
        time.sleep(0.5)
    else:
        raise AssertionError("match never started after the human readied")
    print(f"1 human + 7 bots, match {mid[:8]}")

    async def watch():
        stats = {"moved": set(), "shots": set(), "deaths": 0, "stolen": 0, "returned": 0, "respawned": 0, "classes": set(), "hidden": 0, "barriers": 0}
        start_pos, prev, restarted, reconnected = {}, None, False, False
        t0 = time.time()
        while time.time() - t0 < max_s:
            try:
                async with websockets.connect(f"{WS}/{mid}?token={human.token}") as ws:
                    assert json.loads(await ws.recv())["t"] == "hello"
                    async for raw in ws:
                        st = json.loads(raw)
                        bots = {p["id"] for p in st["players"] if p["bot"]}
                        stats["hidden"] += sum(p["hidden"] for p in st["players"])  # an invisible bot arrives without coordinates
                        stats["barriers"] = max(stats["barriers"], len(st["barriers"]))
                        stats["classes"] |= {p["class"] for p in st["players"] if p["id"] in bots}
                        for p in st["players"]:
                            if p["x"] is None:
                                continue
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
                                    shooter = min((p for p in st["players"] if p["team"] == sh["team"] and p["x"] is not None), key=lambda p: math.dist((p["x"], p["y"]), (sh["x"], sh["y"])))
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
                            verdict = f"{st['winner']} TEAM WINS" if st["winner"] else "DRAW"
                            print(f"  {verdict} ({st['decidedBy']}) after {st['elapsed'] // 1000}s: human (on {mine['team']}) {'won' if st['winner'] == mine['team'] else 'did not win'}")
                            return {**stats, "reconnected": reconnected}
            except (OSError, websockets.ConnectionClosed, websockets.InvalidHandshake):
                await asyncio.sleep(1)
        raise AssertionError(f"bots match did not finish in {max_s}s: {stats}")

    st = asyncio.run(watch())
    assert st.pop("reconnected"), "bots did not reconnect after the restart"
    assert len(st["moved"]) == 7 and len(st["shots"]) >= 4 and st["deaths"] and st["respawned"] and st["stolen"], st
    assert len(st["classes"]) >= 2, f"bots all picked the same class: {st['classes']}"
    print(f"  classes in play {sorted(st['classes'])}, {st['hidden']} hidden-player frames, up to {st['barriers']} barriers at once")
    print(f"  totals: {st['deaths']} deaths, {st['respawned']} respawns, {st['stolen']} flag steals, {st['returned']} flag returns")
    human.call("POST", f"/matchmaking/matches/{mid}/leave")
    print("BOTS E2E PASSED")


def check_result_and_rematch(mid: str, red: list[Client], blue: list[Client]) -> None:
    """The finished game left a per-player result, history and career stats, and the party can queue again."""
    n = len(red)
    res = None
    for _ in range(20):  # game-service writes the result right after the capture tick
        res = red[0].status()["match"]["result"]
        if res:
            break
        time.sleep(0.25)
    assert res and res["winner"] == "RED" and res["capturer"] in {c.me["id"] for c in red}, res
    by_id = {p["id"]: p for p in res["players"]}
    assert set(by_id) == {c.me["id"] for c in red + blue}
    assert all(p["outcome"] == ("WIN" if p["team"] == "RED" else "LOSS") for p in res["players"])
    assert sum(p["captures"] for p in res["players"]) == 1 and by_id[res["capturer"]]["captures"] == 1
    assert all(p["class"] in CLASSES and p["weapon"] in WEAPONS for p in res["players"]), "the result records what each player played"
    assert by_id[red[0].me["id"]]["kills"] >= 1 and by_id[blue[0].me["id"]]["kills"] >= 1  # the combat steps in play()
    assert res["duration_ms"] > 0
    print("  result stored on the match: winner, capturer, per-player kills / deaths / captures")

    h = red[0].call("GET", "/matchmaking/history")
    top = h["items"][0]
    assert top["match_id"] == mid and top["outcome"] == "WIN" and top["my_team"] == "RED" and len(top["players"]) == 2 * n
    assert {(p["id"], p["class"], p["weapon"]) for p in top["players"]} == {(p["id"], p["class"], p["weapon"]) for p in res["players"]}, "history shows the same classes and weapons"
    assert blue[0].call("GET", "/matchmaking/history")["items"][0]["outcome"] == "LOSS"
    ids = ",".join(c.me["id"] for c in red + blue)
    stats = red[0].call("GET", f"/matchmaking/stats?ids={ids}")  # fresh accounts: this was their only finished match
    for c in red + blue:
        mine, st = by_id[c.me["id"]], stats[c.me["id"]]
        won = mine["outcome"] == "WIN"
        assert (st["matches"], st["wins"], st["losses"]) == (1, int(won), int(not won)), st
        assert (st["kills"], st["deaths"], st["captures"]) == (mine["kills"], mine["deaths"], mine["captures"]), st
    print("  history + career stats match the stored result")

    # Play again: the party leader queues from the end screen; that retires the finished match for the party.
    fill = n == 4
    for c in red + blue:  # a browser heartbeats every 10 s; matchmaking drops a queued party with an offline member
        c.call("POST", "/users/me/heartbeat")
    for lead in red:
        try:
            lead.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": fill})
            break
        except ApiFail as e:
            assert e.code == "NOT_LEADER", e
    else:
        raise AssertionError("nobody on red could queue again")
    assert lead.status()["state"] == "searching"
    for c in red:  # teammates still on the scoreboard are moved to the new search with the party
        if c is not lead and not fill:
            assert c.status()["state"] == "searching"
    lead.call("DELETE", "/matchmaking/queue")
    print("  play again: party re-queued straight from the end screen")


def run(n: int) -> None:
    mid, red, blue = form_match(n)
    print(f"{n}v{n} match {mid[:8]}")
    asyncio.run(play(mid, red, blue))
    check_result_and_rematch(mid, red, blue)
    for c in red + blue:
        c.call("POST", f"/matchmaking/matches/{mid}/leave")
    assert red[0].status()["state"] == "idle"
    print(f"{n}v{n} CTF E2E PASSED")


if __name__ == "__main__":
    for arg in sys.argv[1:] or ["1", "2", "4"]:
        {"recovery": run_recovery, "bots": run_bots, "abilities": run_abilities}.get(arg, lambda: run(int(arg)))()
