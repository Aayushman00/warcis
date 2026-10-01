"""WARCIS game-service: authoritative Capture The Flag server over WebSocket.

    WS /game/ws/{match_id}?token=<JWT>[&bot=1]

The roster comes from the match document matchmaking created (teams[0] = RED,
teams[1] = BLUE). Clients (humans and bots alike) send intents only:
    {"t": "input", "up", "down", "left", "right"}   held keys
    {"t": "fire", "x", "y"}                          aim point in world coordinates
    {"t": "ping", "c"}                               echoed back as {"t": "pong", "c"}
The server simulates at TICK_HZ and broadcasts {"t": "state", ...} to every client.
`bot=1` only adds a display label; bots get no other difference.

Persistence: the simulation lives in RAM. Every CHECKPOINT_MS a small snapshot goes to
MongoDB `game_checkpoints` (one doc per match). On startup, recent PLAYING checkpoints of
IN_PROGRESS matches are restored and players reconnect into them. On capture the server
writes `result` onto the match and logs MATCH_ENDED; the match itself is still closed by
matchmaking's existing /leave flow ("Return to hub").
"""

import asyncio
import math
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pymongo import AsyncMongoClient
from warcis_common.errors import ApiError
from warcis_common.security import decode_token

from app.sim import MAP, TEAMS, Game

TICK_HZ = 30
CHECKPOINT_MS = 3000
RECOVER_WINDOW_S = 600  # on startup, only checkpoints newer than this are restored
KEEP_ENDED_S = 60  # keep a finished room so late reconnects still see the result screen
IDLE_DROP_S = 120  # nobody connected this long -> checkpoint and unload the room

client = AsyncMongoClient(os.environ["MONGO_URL"], tz_aware=True)
db = client[os.environ.get("MONGO_DB", "warcis")]
matches, events, checkpoints = db["matches"], db["match_events"], db["game_checkpoints"]


def now_ms() -> int:
    return int(time.time() * 1000)  # wall clock: checkpoint timestamps must mean the same after a restart


def log(msg: str) -> None:
    print(f"[game] {msg}", flush=True)


class Room:
    def __init__(self, match_id: str, game: Game):
        self.match_id, self.game = match_id, game
        self.sockets: dict[str, WebSocket] = {}
        self.bots: set[str] = set()
        self.saved_at = 0
        self.saving: asyncio.Task | None = None


# Rooms are in this process's memory (one replica). Checkpoints make a restart survivable.
rooms: dict[str, Room] = {}
_rooms_lock = asyncio.Lock()


async def save_checkpoint(match_id: str, doc: dict) -> None:
    try:
        await checkpoints.replace_one(
            {"match_id": match_id}, {**doc, "match_id": match_id, "timestamp": datetime.now(timezone.utc)}, upsert=True
        )
    except Exception as e:  # next checkpoint retries; the live game never waits on Mongo
        log(f"checkpoint failed for {match_id}: {e!r}")


def start(room: Room) -> Room:
    rooms[room.match_id] = room
    asyncio.create_task(run(room))
    return room


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
        cp = await checkpoints.find_one({"match_id": match_id})
        t = now_ms()
        if cp is None:  # first player in: a brand-new game, checkpointed before anyone can act
            room = Room(match_id, Game([team["players"] for team in m["teams"]], t))
            await save_checkpoint(match_id, room.game.checkpoint(t))
            room.saved_at = t
            return start(room)
        if cp["status"] != "PLAYING":
            raise ApiError(409, "MATCH_UNRECOVERABLE", "This match could not be recovered.")
        return start(_restore(cp, t))


def _restore(cp: dict, t: int) -> Room:
    try:
        room = Room(cp["match_id"], Game.restore(cp, t))
    except (KeyError, ValueError, TypeError) as e:
        log(f"match {cp['match_id']} unrecoverable: bad checkpoint ({e!r})")
        asyncio.create_task(checkpoints.update_one({"match_id": cp["match_id"]}, {"$set": {"status": "ABANDONED", "reason": repr(e)}}))
        raise ApiError(409, "MATCH_UNRECOVERABLE", "This match could not be recovered.")
    room.saved_at = t
    log(f"match {cp['match_id']} restored from checkpoint {(t - cp['saved_at']) / 1000:.1f}s old")
    return room


async def recover_on_startup() -> None:
    """Reload rooms for matches that were live when the service went down."""
    async with _rooms_lock:
        async for cp in checkpoints.find({"status": "PLAYING"}):
            mid = cp["match_id"]
            m = await matches.find_one({"match_id": mid})
            if not m or m["status"] != "IN_PROGRESS" or m.get("result"):
                reason = "match is no longer in progress"
            elif now_ms() - cp["saved_at"] > RECOVER_WINDOW_S * 1000:
                reason = f"checkpoint older than {RECOVER_WINDOW_S}s"
            else:
                try:
                    start(_restore(cp, now_ms()))
                except ApiError:
                    pass  # already logged and marked
                continue
            log(f"match {mid} not recovered: {reason}")
            await checkpoints.update_one({"match_id": mid}, {"$set": {"status": "ABANDONED", "reason": reason}})


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
            snap = g.snapshot(t, room.sockets.keys(), room.bots)
            await asyncio.gather(*(_send(ws, snap) for ws in list(room.sockets.values())))
            if g.ended:
                await _record_result(room)
                await save_checkpoint(room.match_id, g.checkpoint(t))
                await asyncio.sleep(KEEP_ENDED_S)
                return
            if t - room.saved_at >= CHECKPOINT_MS and not (room.saving and not room.saving.done()):
                room.saved_at = t
                room.saving = asyncio.create_task(save_checkpoint(room.match_id, g.checkpoint(t)))
            idle_since = None if room.sockets else idle_since or t
            if idle_since and t - idle_since > IDLE_DROP_S * 1000:
                await save_checkpoint(room.match_id, g.checkpoint(t))  # reconnect restores it
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
        log(f"could not record result for {room.match_id}: {e!r}")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await checkpoints.create_index("match_id", unique=True)
    await recover_on_startup()
    yield
    t = now_ms()  # graceful stop (docker restart): final checkpoint of every live room
    await asyncio.gather(*(save_checkpoint(r.match_id, r.game.checkpoint(t)) for r in list(rooms.values()) if not r.game.ended))


app = FastAPI(title="WARCIS game-service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True, "rooms": len(rooms)}


@app.websocket("/game/ws/{match_id}")
async def play(ws: WebSocket, match_id: str, token: str = "", bot: int = 0):
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
    if bot:
        room.bots.add(me.id)
    g = room.game
    # Current state right away: a finished room no longer ticks, and a late joiner (or a
    # reconnect) should see the result / the arena without waiting for the next broadcast.
    await _send(ws, g.snapshot(now_ms(), room.sockets.keys(), room.bots))
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
            elif msg.get("t") == "ping" and isinstance(msg.get("c"), (int, float)):
                await _send(ws, {"t": "pong", "c": msg["c"]})  # client measures round-trip time
    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        if room.sockets.get(me.id) is ws:
            del room.sockets[me.id]
            g.set_keys(me.id, {})  # a dropped client stops moving; its player state is kept for reconnect
