"""WARCIS game-service: authoritative Capture The Flag server over WebSocket.

    WS /game/ws/{match_id}?token=<JWT>

The roster comes from the match document matchmaking created (teams[0] = RED,
teams[1] = BLUE). Clients send intents only:
    {"t": "input", "up", "down", "left", "right"}   held keys
    {"t": "fire", "x", "y"}                          aim point in world coordinates
The server simulates at TICK_HZ and broadcasts {"t": "state", ...} to every client.
On capture it writes `result` onto the match and logs MATCH_ENDED; the match itself is
still closed by matchmaking's existing /leave flow ("Return to hub").
"""

import asyncio
import math
import os
import time
from datetime import datetime, timezone

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pymongo import AsyncMongoClient
from warcis_common.errors import ApiError
from warcis_common.security import decode_token

from app.sim import MAP, TEAMS, Game

TICK_HZ = 30
KEEP_ENDED_S = 60  # keep a finished room so late reconnects still see the result screen
IDLE_DROP_S = 120  # nobody connected this long -> drop the room

client = AsyncMongoClient(os.environ["MONGO_URL"], tz_aware=True)
db = client[os.environ.get("MONGO_DB", "warcis")]
matches, events = db["matches"], db["match_events"]


def now_ms() -> int:
    return int(time.monotonic() * 1000)


class Room:
    def __init__(self, match_id: str, game: Game):
        self.match_id, self.game = match_id, game
        self.sockets: dict[str, WebSocket] = {}


# ponytail: rooms live in this process's memory, so run one replica and a restart loses
# live matches. Shard rooms by match_id (or move state to Redis) when that matters.
rooms: dict[str, Room] = {}
_rooms_lock = asyncio.Lock()


async def open_room(match_id: str, user_id: str) -> Room:
    async with _rooms_lock:
        room = rooms.get(match_id)
        if room:
            if user_id not in room.game.players:
                raise ApiError(403, "NOT_IN_MATCH", "You are not in this match.")
            return room
        m = await matches.find_one({"match_id": match_id, "player_ids": user_id})
        if not m:
            raise ApiError(404, "MATCH_NOT_FOUND", "Match not found.")
        if m.get("result"):
            raise ApiError(409, "MATCH_ENDED", f"{m['result']['winner']} TEAM WINS")
        if m["status"] != "IN_PROGRESS":
            raise ApiError(409, "MATCH_NOT_STARTED", "Match is not in progress.")
        room = Room(match_id, Game([t["players"] for t in m["teams"]], now_ms()))
        rooms[match_id] = room
        asyncio.create_task(run(room))
        return room


async def _send(ws: WebSocket, msg: dict) -> None:
    try:
        await ws.send_json(msg)
    except Exception:
        pass  # socket closing; its reader loop cleans up


async def run(room: Room) -> None:
    g, idle_since = room.game, None
    try:
        while True:
            t = now_ms()
            g.step(t)
            snap = g.snapshot(t, room.sockets.keys())
            await asyncio.gather(*(_send(ws, snap) for ws in list(room.sockets.values())))
            if g.ended:
                await _record_result(room)
                await asyncio.sleep(KEEP_ENDED_S)
                return
            idle_since = None if room.sockets else idle_since or t
            if idle_since and t - idle_since > IDLE_DROP_S * 1000:
                return
            await asyncio.sleep(1 / TICK_HZ)
    finally:
        rooms.pop(room.match_id, None)


async def _record_result(room: Room) -> None:
    g = room.game
    winner = TEAMS[g.winner]
    try:
        await matches.update_one(
            {"match_id": room.match_id}, {"$set": {"result": {"winner": winner, "capturer": g.capturer, "at": datetime.now(timezone.utc)}}}
        )
        await events.insert_one(
            {"match_id": room.match_id, "type": "MATCH_ENDED", "user_id": g.capturer, "at": datetime.now(timezone.utc), "data": {"winner": winner}}
        )
    except Exception as e:  # the result was already broadcast; don't kill the room over a DB write
        print(f"[game] could not record result for {room.match_id}: {e!r}", flush=True)


app = FastAPI(title="WARCIS game-service")


@app.get("/health")
def health():
    return {"ok": True, "rooms": len(rooms)}


@app.websocket("/game/ws/{match_id}")
async def play(ws: WebSocket, match_id: str, token: str = ""):
    await ws.accept()
    try:
        me = decode_token(token)  # browsers can't set headers on a WebSocket, so the JWT rides in the query
        room = await open_room(match_id, me.id)
    except ApiError as e:
        await ws.send_json({"t": "error", "code": e.code, "message": e.message})
        await ws.close()
        return

    old = room.sockets.get(me.id)
    if old:  # same player reconnected (refresh / second tab): newest socket wins
        await old.close()
    await ws.send_json({"t": "hello", "you": me.id, "map": MAP})
    room.sockets[me.id] = ws
    g = room.game
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            if msg.get("t") == "input":
                g.set_keys(me.id, msg)
            elif msg.get("t") == "fire":
                x, y = msg.get("x"), msg.get("y")
                if isinstance(x, (int, float)) and isinstance(y, (int, float)) and math.isfinite(x) and math.isfinite(y):
                    g.fire(me.id, x, y, now_ms())
    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        if room.sockets.get(me.id) is ws:
            del room.sockets[me.id]
            g.set_keys(me.id, {})  # a dropped client stops moving
