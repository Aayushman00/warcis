"""Full-stack CTF check: 1v1 via the real queue, then play it over the WebSocket.

    pip install httpx websockets && python scripts/ctf_e2e.py      (stack running, bots stopped)

Goes through nginx (:8080) -> gateway -> game-service, the same path a browser uses.
"""
import asyncio, json, os, time, uuid

import websockets
from api import Client

WS = os.environ.get("WS_URL", "ws://localhost:8080/api/game/ws")
tag = uuid.uuid4().hex[:5]
a = Client().register(f"ctfA{tag}", "password123")
b = Client().register(f"ctfB{tag}", "password123")
for c in (a, b):
    c.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": False})
for _ in range(30):
    s = a.status()
    if s["state"] == "found":
        break
    time.sleep(0.5)
m = a.status()["match"]
mid = m["match_id"]
assert {p["id"] for t in m["teams"] for p in t["players"]} == {a.me["id"], b.me["id"]}, "not our 1v1"
for c in (a, b):
    c.call("POST", f"/matchmaking/matches/{mid}/ready")
for c in (a, b):
    c.call("POST", f"/matchmaking/matches/{mid}/enter")
red_is_a = m["teams"][0]["players"][0]["id"] == a.me["id"]
print("match", mid, "A is", "RED" if red_is_a else "BLUE")


async def recv_state(ws):
    while True:
        msg = json.loads(await ws.recv())
        if msg["t"] == "state":
            return msg


async def main():
    async with websockets.connect(f"{WS}/{mid}?token=bad") as bad:
        msg = json.loads(await bad.recv())
        assert msg["t"] == "error", msg
        print("bad token rejected:", msg["message"])

    async with websockets.connect(f"{WS}/{mid}?token={a.token}") as wa, websockets.connect(f"{WS}/{mid}?token={b.token}") as wb:
        hello = json.loads(await wa.recv())
        assert hello["t"] == "hello" and hello["you"] == a.me["id"]
        s = await recv_state(wa)
        me = next(p for p in s["players"] if p["id"] == a.me["id"])
        assert me["hp"] == 100 and me["alive"] and not me["carryingFlag"]
        assert [f["state"] for f in s["flags"]] == ["AT_BASE", "AT_BASE"]
        team = me["team"]
        print("spawned", me)

        # client cannot set its own hp/position: unknown fields are ignored
        await wa.send(json.dumps({"t": "input", "hp": 9999, "x": 1090, "y": 350}))
        await wb.send(json.dumps({"t": "fire", "x": 600, "y": 350}))
        await wb.send(json.dumps({"t": "fire", "x": 600, "y": 350}))  # cooldown
        s = await recv_state(wa)
        me = next(p for p in s["players"] if p["id"] == a.me["id"])
        assert me["hp"] == 100 and me["x"] < 200 and len(s["shots"]) == 1, (me, s["shots"])

        # Walk A: enemy flag and back, routing around walls.
        mirror = (lambda x: x) if team == "RED" else (lambda x: 1200 - x)
        out = [(mirror(x), y) for x, y in [(60, 350), (500, 350), (500, 180), (700, 180), (700, 350), (1090, 350)]]

        async def walk(points):
            for tx, ty in points:
                while True:
                    s = await recv_state(wa)
                    me = next(p for p in s["players"] if p["id"] == a.me["id"])
                    dx, dy = tx - me["x"], ty - me["y"]
                    if abs(dx) < 6 and abs(dy) < 6 or s["state"] == "ENDED":
                        break
                    await wa.send(json.dumps({"t": "input", "right": dx > 5, "left": dx < -5, "down": dy > 5, "up": dy < -5}))
            await wa.send(json.dumps({"t": "input"}))
            return s

        s = await walk(out)
        enemy_flag = next(f for f in s["flags"] if f["team"] != team)
        assert enemy_flag["state"] == "CARRIED" and enemy_flag["carrierId"] == a.me["id"], enemy_flag
        print("picked up enemy flag")
        s = await walk(list(reversed(out))[1:-1] + [(mirror(110), 350)])
        assert s["state"] == "ENDED" and s["winner"] == team, (s["state"], s["winner"])
        sb = await recv_state(wb)
        while sb["state"] != "ENDED":
            sb = await recv_state(wb)
        assert sb["winner"] == team
        print("captured:", team, "TEAM WINS (both clients saw it)")
        # after end: no movement
        await wa.send(json.dumps({"t": "input", "up": True}))


asyncio.run(main())
time.sleep(0.5)
st = a.status()
assert st["state"] == "entered"
for c in (a, b):
    c.call("POST", f"/matchmaking/matches/{mid}/leave")
assert a.status()["state"] == "idle"
print("returned to hub; CTF E2E PASSED")
