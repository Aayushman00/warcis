"""WARCIS game-service: authoritative Capture The Flag server over WebSocket.

    WS /game/ws/{match_id}?token=<JWT>[&bot=1]

The roster comes from the match document matchmaking created (teams[0] = RED,
teams[1] = BLUE). Clients (humans and bots alike) send intents only:
    {"t": "input", "up", "down", "left", "right"}   held keys
    {"t": "fire", "x", "y"}                          aim point in world coordinates
    {"t": "ability", "x", "y"}                       Q: dash / barrier / invisibility, aimed like a shot
    {"t": "ping", "c"}                               echoed back as {"t": "pong", "c"}
The server simulates at TICK_HZ and broadcasts {"t": "state", ...} to every client.
`bot=1` only adds a display label; bots get no other difference.
Class and weapon are never sent by a client: they come from the `loadouts` the match lobby stored on
the match document (matchmaking-service). Each team receives its own snapshot, so an invisible
Assassin's coordinates are never sent to the enemy team.

Persistence: the simulation lives in RAM. Every CHECKPOINT_MS a small snapshot goes to
MongoDB `game_checkpoints` (one doc per match). On startup, recent PLAYING checkpoints of
IN_PROGRESS matches are restored and players reconnect into them. A capture scores a
round; first to 3, or the higher score at 10:00, ends the match. Level at 10:00 is sudden death
(no respawns, next capture wins); still level at 12:00, objective progress, then kills, decide,
else it is a draw (stored as winner TIE). The server
writes `result` (winner, scores, how it was decided, per-player kills / deaths / captures) onto the match and logs
MATCH_ENDED and one PLAYER_RESULT per player; the match itself is still closed by
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
from warcis_common import loadout
from warcis_common.errors import ApiError
from warcis_common.security import decode_token

from app.sim import CATALOG, MAP, TEAMS, Game

TICK_HZ = 30
CHECKPOINT_MS = 3000
RECOVER_WINDOW_S = 600  # on startup, only checkpoints newer than this are restored
KEEP_ENDED_S = 60  # keep a finished room so late reconnects still see the result screen
RESULT_ATTEMPTS = 4  # writes of the final result before giving up (the room stays loaded meanwhile)
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

    def views(self, t: int) -> dict[int, dict]:
        """One snapshot per team, built from the same state: what a team may not see is left out here."""
        return {team: self.game.snapshot(t, self.sockets.keys(), self.bots, team) for team in (0, 1)}


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


def roster(m: dict) -> list[list[dict]]:
    """Teams of {id, name, class, weapon} from the match document. The lobby guarantees a valid loadout for
    every player of a started match; the default only covers matches created before loadouts existed."""
    picks = m.get("loadouts") or {}
    out = []
    for team in m["teams"]:
        row = []
        for p in team["players"]:
            pick = picks.get(p["id"])
            if pick is not None and not loadout.valid(pick):
                log(f"match {m['match_id']}: invalid loadout for {p['id']}, using the default")
                pick = None
            row.append({**p, **{k: (pick or loadout.DEFAULT_LOADOUT)[k] for k in ("class", "weapon")}})
        out.append(row)
    return out


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
            w = m["result"]["winner"]
            raise ApiError(409, "MATCH_ENDED", "DRAW" if w == "TIE" else f"{w} TEAM WINS")
        if m["status"] != "IN_PROGRESS":
            raise ApiError(409, "MATCH_NOT_STARTED", "Match is not in progress.")
        cp = await checkpoints.find_one({"match_id": match_id})
        t = now_ms()
        if cp is None:  # first player in: a brand-new game, checkpointed before anyone can act
            room = Room(match_id, Game(roster(m), t))
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
            views = room.views(t)
            await asyncio.gather(*(_send(ws, views[g.players[uid].team]) for uid, ws in list(room.sockets.items())))
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
    """Write the final per-player result onto the match document and into match_events.

    `result` is set once (the `$exists: False` guard): the match document is what history and
    profile stats are computed from, the events are the append-only audit trail of the same fact.
    """
    g = room.game
    result = {**g.result(g.ended_at), "at": datetime.now(timezone.utc)}  # g.ended_at = the final capture / timeout tick, not when the write happens
    for attempt in range(1, RESULT_ATTEMPTS + 1):
        try:
            done = await matches.update_one({"match_id": room.match_id, "result": {"$exists": False}}, {"$set": {"result": result}})
            if done.modified_count:
                at = result["at"]
                await events.insert_many(
                    [{"match_id": room.match_id, "type": "MATCH_ENDED", "user_id": g.capturer, "at": at,
                      "data": {"winner": result["winner"], "decided_by": result["decided_by"], "duration_ms": result["duration_ms"]}}]
                    + [{"match_id": room.match_id, "type": "PLAYER_RESULT", "user_id": p["id"], "at": at,
                        "data": {k: p[k] for k in ("team", "class", "weapon", "outcome", "kills", "deaths", "captures")}}
                       for p in result["players"]]
                )
            return
        except Exception as e:  # the result was already broadcast; retry briefly, never kill the room over a DB write
            log(f"could not record result for {room.match_id} (attempt {attempt}): {e!r}")
            await asyncio.sleep(attempt)


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
    await ws.send_json({"t": "hello", "you": me.id, "map": MAP, "catalog": CATALOG})
    room.sockets[me.id] = ws
    if bot:
        room.bots.add(me.id)
    g = room.game
    # Current state right away: a finished room no longer ticks, and a late joiner (or a
    # reconnect) should see the result / the arena without waiting for the next broadcast.
    await _send(ws, room.views(now_ms())[g.players[me.id].team])
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
            elif msg.get("t") == "ability":
                x, y = msg.get("x"), msg.get("y")
                if isinstance(x, (int, float)) and isinstance(y, (int, float)) and math.isfinite(x) and math.isfinite(y):
                    g.ability(me.id, x, y, now_ms())
            elif msg.get("t") == "ping" and isinstance(msg.get("c"), (int, float)):
                await _send(ws, {"t": "pong", "c": msg["c"]})  # client measures round-trip time
    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        if room.sockets.get(me.id) is ws:
            del room.sockets[me.id]
            g.set_keys(me.id, {})  # a dropped client stops moving; its player state is kept for reconnect
