"""Player stats and match history, derived from the `result` that game-service writes onto
finished match documents. Nothing is stored twice: a stats row is an aggregate over `matches`,
so it can never drift from the matches themselves. Self-check: python -m app.services.stats
"""

from datetime import datetime

from warcis_common.errors import ApiError

from app.db.mongo import matches

MAX_STATS_IDS = 50
MAX_HISTORY = 50
ZERO = {"matches": 0, "wins": 0, "losses": 0, "kills": 0, "deaths": 0, "captures": 0}


def _shape(row: dict | None) -> dict:
    """One player's aggregate row -> the public stats object (adds the derived ratios)."""
    r = {k: int((row or {}).get(k, 0)) for k in ZERO}
    r["losses"] = r["matches"] - r["wins"]
    r["kd"] = round(r["kills"] / max(r["deaths"], 1), 2)
    r["win_rate"] = round(r["wins"] / r["matches"], 3) if r["matches"] else None
    return r


async def player_stats(user_ids: list[str]) -> dict[str, dict]:
    """Career totals for each id (zeros for players who never finished a match).

    Only matches with a recorded `result` count: cancelled or abandoned matches have none.
    """
    ids = list(dict.fromkeys(user_ids))[:MAX_STATS_IDS]
    cursor = await matches.aggregate(
        [
            {"$match": {"player_ids": {"$in": ids}, "result": {"$exists": True}}},
            {"$unwind": "$result.players"},
            {"$match": {"result.players.id": {"$in": ids}}},
            {
                "$group": {
                    "_id": "$result.players.id",
                    "matches": {"$sum": 1},
                    "wins": {"$sum": {"$cond": [{"$eq": ["$result.players.team", "$result.winner"]}, 1, 0]}},
                    "kills": {"$sum": "$result.players.kills"},
                    "deaths": {"$sum": "$result.players.deaths"},
                    "captures": {"$sum": "$result.players.captures"},
                }
            },
        ]
    )
    rows = {row["_id"]: row async for row in cursor}
    return {i: _shape(rows.get(i)) for i in ids}


def result_view(m: dict) -> dict | None:
    r = m.get("result")
    if not r:
        return None
    return {
        "winner": r["winner"],
        "capturer": r.get("capturer"),
        "duration_ms": r.get("duration_ms", 0),
        "ended_at": r["at"].isoformat() if r.get("at") else None,
        "players": r["players"],
    }


def history_item(m: dict, user_id: str) -> dict:
    r = result_view(m)
    mine = next(p for p in r["players"] if p["id"] == user_id)
    return {
        "match_id": m["match_id"],
        "mode": m["mode"],
        "played_at": m["created_at"].isoformat(),
        "outcome": mine["outcome"],
        "my_team": mine["team"],
        "me": {k: mine[k] for k in ("kills", "deaths", "captures")},
        **r,
    }


async def history(user_id: str, limit: int, before: str | None) -> dict:
    """Newest-first finished matches of one player, keyset-paged on `created_at`."""
    q: dict = {"player_ids": user_id, "result": {"$exists": True}}
    if before:
        try:
            q["created_at"] = {"$lt": datetime.fromisoformat(before)}
        except ValueError:
            raise ApiError(400, "INVALID_CURSOR", "`before` must be an ISO timestamp.")
    limit = max(1, min(limit, MAX_HISTORY))
    docs = await matches.find(q).sort("created_at", -1).limit(limit + 1).to_list(None)
    page = docs[:limit]
    return {
        "items": [history_item(m, user_id) for m in page],
        "next_before": page[-1]["created_at"].isoformat() if len(docs) > limit else None,
    }


if __name__ == "__main__":  # self-check of the pure shaping code (the aggregation itself needs MongoDB)
    from datetime import timezone

    assert _shape(None) == {"matches": 0, "wins": 0, "losses": 0, "kills": 0, "deaths": 0, "captures": 0, "kd": 0.0, "win_rate": None}
    s = _shape({"matches": 4, "wins": 3, "kills": 9, "deaths": 4, "captures": 2})
    assert s["losses"] == 1 and s["kd"] == 2.25 and s["win_rate"] == 0.75
    assert _shape({"matches": 1, "wins": 0, "kills": 3, "deaths": 0})["kd"] == 3.0  # no deaths: kills, not a division by zero

    t = datetime(2026, 1, 1, tzinfo=timezone.utc)
    players = [
        {"id": "a", "name": "A", "team": "RED", "outcome": "WIN", "kills": 2, "deaths": 1, "captures": 1},
        {"id": "b", "name": "B", "team": "BLUE", "outcome": "LOSS", "kills": 1, "deaths": 2, "captures": 0},
    ]
    m = {"match_id": "m1", "mode": "SQUAD", "created_at": t, "result": {"winner": "RED", "capturer": "a", "duration_ms": 61000, "at": t, "players": players}}
    h = history_item(m, "b")
    assert h["outcome"] == "LOSS" and h["my_team"] == "BLUE" and h["me"] == {"kills": 1, "deaths": 2, "captures": 0}
    assert h["winner"] == "RED" and h["duration_ms"] == 61000 and len(h["players"]) == 2
    assert result_view({"match_id": "x"}) is None
    print("stats ok")
