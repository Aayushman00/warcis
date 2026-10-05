"""Queue and match lifecycle on MongoDB.

Queue entry status:  WAITING -> MATCHED | CANCELLED | INVALIDATED
Match status:        FOUND (ready check) -> COUNTDOWN (everyone ready) -> IN_PROGRESS -> COMPLETED
                     FOUND | COUNTDOWN -> CANCELLED (ready check timed out, or a player left)
"""

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

from warcis_common.errors import ApiError
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.db.mongo import events, matches, queue
from app.services import party_client
from app.services.packing import TEAM_SIZE, fifo, matchups, pack, unfilled_matchups

READY_TIMEOUT = timedelta(seconds=int(os.environ.get("READY_TIMEOUT_S", "45")))
COUNTDOWN = timedelta(seconds=int(os.environ.get("COUNTDOWN_S", "3")))
PRE_GAME = ["FOUND", "COUNTDOWN"]
ACTIVE = [*PRE_GAME, "IN_PROGRESS"]
wake = asyncio.Event()  # set on enqueue so the matcher runs immediately instead of waiting a tick
_tick_lock = asyncio.Lock()


def now() -> datetime:
    return datetime.now(timezone.utc)


async def log(match_id: str, kind: str, user_id: str | None = None, **data) -> None:
    await events.insert_one({"match_id": match_id, "type": kind, "user_id": user_id, "at": now(), "data": data})


def _active_match_filter(user_id: str) -> dict:
    return {"player_ids": user_id, "status": {"$in": ACTIVE}, "left": {"$ne": user_id}}


# ─────────────── queue ───────────────


async def enqueue(user_id: str, mode: str, fill: bool = True) -> dict:
    party = await party_client.party_for_queue(user_id)  # authoritative snapshot from Postgres
    size = len(party["members"])
    if party["leader_id"] != user_id:
        raise ApiError(403, "NOT_LEADER", "Only the party leader can start matchmaking.")
    if party["pending_invites"]:
        raise ApiError(409, "INVITES_PENDING", "Wait for pending invites to be answered or cancel them.")
    if not 1 <= size <= TEAM_SIZE:
        raise ApiError(409, "INVALID_PARTY_SIZE", "Party size must be between 1 and 4.")

    ids = [m["id"] for m in party["members"]]
    existing = await queue.find_one({"party_id": party["party_id"], "status": "WAITING"})
    if existing and existing["party_version"] == party["version"] and existing["mode"] == mode.upper() and existing["fill"] == fill:
        return await status(user_id)  # idempotent: same party, same snapshot, already queued
    if existing:  # party changed or switched mode/fill since queuing: replace the stale entry
        await queue.update_one({"_id": existing["_id"], "status": "WAITING"}, {"$set": {"status": "INVALIDATED"}})
    if await queue.find_one({"player_ids": {"$in": ids}, "status": "WAITING"}):
        raise ApiError(409, "ALREADY_QUEUED", "A party member is already in another queue.")
    if await matches.find_one({"player_ids": {"$in": ids}, "status": {"$in": ACTIVE}, "left": {"$nin": ids}}):
        raise ApiError(409, "IN_MATCH", "A party member is still in a match.")

    try:
        await queue.insert_one(
            {
                "queue_id": str(uuid.uuid4()),
                "party_id": party["party_id"],
                "party_version": party["version"],
                "leader_id": party["leader_id"],
                "mode": mode.upper(),
                "fill": fill,
                "players": party["members"],  # denormalized name snapshot: queue docs are short-lived
                "player_ids": ids,
                "size": size,
                "joined_at": now(),
                "status": "WAITING",
            }
        )
    except DuplicateKeyError:
        pass  # concurrent double-click: the unique partial index kept exactly one entry
    wake.set()
    return await status(user_id)


async def cancel(user_id: str) -> None:
    """Any party member may pull the party out of the queue. Idempotent."""
    await queue.update_many({"player_ids": user_id, "status": "WAITING"}, {"$set": {"status": "CANCELLED", "ended_at": now()}})


async def waiting() -> list[dict]:
    """Who is searching right now. Demo bots poll this to decide when to fill in for humans."""
    return [
        {"party_id": e["party_id"], "player_ids": e["player_ids"], "joined_at": e["joined_at"].isoformat(), "fill": e["fill"]}
        async for e in queue.find({"status": "WAITING"})
    ]


# ─────────────── status (polled by clients) ───────────────


def _team_view(team: list[dict]) -> dict:
    return {
        "players": [p for e in team for p in e["players"]],
        "parties": [{"party_id": e["party_id"], "players": e["player_ids"]} for e in team],
    }


def match_view(m: dict, user_id: str) -> dict:
    mine = next(i for i, t in enumerate(m["teams"]) if any(p["id"] == user_id for p in t["players"]))
    return {
        "match_id": m["match_id"],
        "mode": m["mode"],
        "status": m["status"],
        "created_at": m["created_at"].isoformat(),
        "teams": m["teams"],
        "my_team": mine,
        "ready": m["ready"],
        "entered": m["entered"],
        "countdown_ends_at": m["countdown_ends_at"].isoformat() if m.get("countdown_ends_at") else None,
    }


async def status(user_id: str) -> dict:
    m = await matches.find_one(_active_match_filter(user_id), sort=[("created_at", -1)])
    if m:
        if m["status"] == "COUNTDOWN":
            m = await _start_if_due(m) or m
        # Derived from status, not `entered`: the server enters everyone at once, and a legacy
        # IN_PROGRESS row with the user missing from `entered` used to render as a dead "found" screen.
        state = "entered" if m["status"] == "IN_PROGRESS" else "countdown" if m["status"] == "COUNTDOWN" else "found"
        return {"state": state, "match": match_view(m, user_id)}

    entry = await queue.find_one({"player_ids": user_id, "status": "WAITING"})
    if not entry:
        last = await matches.find_one({"player_ids": user_id, "status": "CANCELLED"}, sort=[("created_at", -1)])
        recent = last and now() - last["ended_at"] < timedelta(seconds=10)
        notice = "Match cancelled: a player left." if recent and last.get("reason") == "player_left" else "Match cancelled: not every player readied up."
        return {"state": "idle", "notice": notice if recent else None}

    waiting = await queue.find({"status": "WAITING", "mode": entry["mode"]}).to_list(None)
    # The matcher may claim our entry between the two reads above. Keep it in the pool so the
    # preview still finds our team (the next poll sees the match) instead of raising StopIteration.
    waiting = [e for e in waiting if e["queue_id"] != entry["queue_id"]] + [entry]
    if entry["fill"]:
        pool = [e for e in waiting if e["fill"]]
        team = next(t for t in pack(pool) if any(e["queue_id"] == entry["queue_id"] for e in t))
        # Show our own party first, then the parties we'd currently be grouped with.
        team = [entry] + [e for e in fifo(team) if e["queue_id"] != entry["queue_id"]]
    else:
        team = [entry]  # fill off: never grouped with anyone else while searching
    return {
        "state": "searching",
        "queue": {
            "mode": entry["mode"],
            "fill": entry["fill"],
            "party_id": entry["party_id"],
            "leader_id": entry["leader_id"],
            "size": entry["size"],
            "joined_at": entry["joined_at"].isoformat(),
            "players_in_queue": sum(e["size"] for e in waiting),
            "team": _team_view(team),
        },
    }


# ─────────────── match lifecycle ───────────────


async def _own_match(match_id: str, user_id: str) -> dict:
    m = await matches.find_one({"match_id": match_id, "player_ids": user_id})
    if not m:
        raise ApiError(404, "MATCH_NOT_FOUND", "Match not found.")
    return m


async def ready(match_id: str, user_id: str) -> dict:
    await _own_match(match_id, user_id)
    before = await matches.find_one_and_update(
        {"match_id": match_id, "status": "FOUND"}, {"$addToSet": {"ready": user_id}}, return_document=ReturnDocument.BEFORE
    )
    if not before:
        raise ApiError(409, "MATCH_NOT_READYABLE", "This match is no longer accepting ready checks.")
    if user_id not in before["ready"]:
        await log(match_id, "PLAYER_READY", user_id)
    if set(before["player_ids"]) <= set(before["ready"]) | {user_id}:
        # Conditional on FOUND: of several racing last-readiers exactly one starts the countdown.
        go = await matches.update_one(
            {"match_id": match_id, "status": "FOUND"}, {"$set": {"status": "COUNTDOWN", "countdown_ends_at": now() + COUNTDOWN}}
        )
        if go.modified_count:
            await log(match_id, "COUNTDOWN_STARTED")
    return await status(user_id)


async def _start_if_due(m: dict) -> dict | None:
    """COUNTDOWN -> IN_PROGRESS once the deadline passed; every player is entered by the server."""
    if m["countdown_ends_at"].replace(tzinfo=timezone.utc) > now():
        return None
    r = await matches.find_one_and_update(
        {"match_id": m["match_id"], "status": "COUNTDOWN"},
        {"$set": {"status": "IN_PROGRESS", "entered": m["player_ids"]}},
        return_document=ReturnDocument.AFTER,
    )
    if r:
        await log(m["match_id"], "MATCH_STARTED")
    return r or await matches.find_one({"match_id": m["match_id"]})


async def leave(match_id: str, user_id: str) -> None:
    """End-of-demo 'Return to hub'. Match completes once everyone has left."""
    # Add and read back in one atomic step: every concurrent leaver sees all earlier leaves, so
    # the last one always completes the match (a separate read here left matches IN_PROGRESS).
    # Leaving before the game starts voids the match for everyone.
    cancelled = await matches.update_one(
        {"match_id": match_id, "player_ids": user_id, "status": {"$in": PRE_GAME}},
        {"$set": {"status": "CANCELLED", "ended_at": now(), "reason": "player_left"}},
    )
    if cancelled.modified_count:
        await log(match_id, "MATCH_CANCELLED", user_id, reason="player_left")
    m = await matches.find_one_and_update(
        {"match_id": match_id, "player_ids": user_id}, {"$addToSet": {"left": user_id}}, return_document=ReturnDocument.AFTER
    )
    if not m:
        raise ApiError(404, "MATCH_NOT_FOUND", "Match not found.")
    await log(match_id, "PLAYER_LEFT", user_id)
    if set(m["player_ids"]) <= set(m["left"]):
        done = await matches.update_one({"match_id": match_id, "status": {"$nin": ["COMPLETED", "CANCELLED"]}}, {"$set": {"status": "COMPLETED", "ended_at": now()}})
        if done.modified_count:  # exactly one of the racing leavers logs it
            await log(match_id, "MATCH_COMPLETED")


# ─────────────── matcher ───────────────


async def _create_match(mode: str, a: list[dict], b: list[dict]) -> None:
    entries = a + b
    match_id = str(uuid.uuid4())
    oids = [e["_id"] for e in entries]
    # Claim: conditional update only succeeds for entries still WAITING. If a player
    # cancelled in between, release whatever we did claim and let the next tick retry.
    claimed = await queue.update_many(
        {"_id": {"$in": oids}, "status": "WAITING"}, {"$set": {"status": "MATCHED", "match_id": match_id}}
    )
    if claimed.modified_count != len(oids):
        await queue.update_many({"_id": {"$in": oids}, "match_id": match_id}, {"$set": {"status": "WAITING"}, "$unset": {"match_id": ""}})
        return
    try:
        await matches.insert_one(
            {
                "match_id": match_id,
                "mode": mode,
                "status": "FOUND",
                "teams": [_team_view(a), _team_view(b)],
                "player_ids": [pid for e in entries for pid in e["player_ids"]],
                "ready": [],
                "entered": [],
                "left": [],
                "created_at": now(),
            }
        )
    except Exception:  # compensate: put entries back in the queue
        await queue.update_many({"match_id": match_id}, {"$set": {"status": "WAITING"}, "$unset": {"match_id": ""}})
        raise
    await log(match_id, "MATCH_CREATED", parties=[e["party_id"] for e in entries])


async def tick() -> None:
    async with _tick_lock:
        # Expire ready checks nobody completed (closed tab, etc.).
        expired = matches.find({"status": "FOUND", "created_at": {"$lt": now() - READY_TIMEOUT}})
        async for m in expired:
            await matches.update_one({"_id": m["_id"], "status": "FOUND"}, {"$set": {"status": "CANCELLED", "ended_at": now()}})
            await log(m["match_id"], "MATCH_CANCELLED", reason="ready_timeout")
        async for m in matches.find({"status": "COUNTDOWN", "countdown_ends_at": {"$lte": now()}}):
            await _start_if_due(m)

        waiting = await queue.find({"status": "WAITING"}).to_list(None)
        if not waiting:
            return
        # Re-validate every queued snapshot against Postgres in ONE call. If party-service
        # is down this raises and no match is formed: we never match on unverified state.
        stale = await party_client.stale(list({(e["party_id"], e["party_version"]) for e in waiting}))
        if stale:
            await queue.update_many({"party_id": {"$in": list(stale)}, "status": "WAITING"}, {"$set": {"status": "INVALIDATED"}})
            waiting = [e for e in waiting if e["party_id"] not in stale]

        for mode in ("SQUAD",):
            pool = [e for e in waiting if e["mode"] == mode]
            for a, b in matchups([e for e in pool if e["fill"]]):
                await _create_match(mode, a, b)
            for a, b in unfilled_matchups([e for e in pool if not e["fill"]]):
                await _create_match(mode, a, b)


async def run_forever() -> None:
    while True:
        try:
            await asyncio.wait_for(wake.wait(), timeout=1.0)
        except TimeoutError:
            pass
        wake.clear()
        try:
            await tick()
        except Exception as e:  # keep the loop alive; next tick retries
            print(f"[matcher] tick failed: {e!r}", flush=True)
