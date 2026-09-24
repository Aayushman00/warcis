import os

from pymongo import ASCENDING, DESCENDING, AsyncMongoClient

client = AsyncMongoClient(os.environ["MONGO_URL"], tz_aware=True)
db = client[os.environ.get("MONGO_DB", "warcis")]

queue = db["matchmaking_queue"]
matches = db["matches"]
events = db["match_events"]


async def ensure_indexes() -> None:
    # A party can hold at most one WAITING entry: the DB enforces "cannot queue twice".
    await queue.create_index(
        [("party_id", ASCENDING)], unique=True, partialFilterExpression={"status": "WAITING"}, name="one_waiting_per_party"
    )
    await queue.create_index([("status", ASCENDING), ("mode", ASCENDING), ("joined_at", ASCENDING)])
    await queue.create_index([("player_ids", ASCENDING), ("status", ASCENDING)])
    await matches.create_index([("match_id", ASCENDING)], unique=True)
    await matches.create_index([("player_ids", ASCENDING), ("created_at", DESCENDING)])
    await events.create_index([("match_id", ASCENDING), ("at", ASCENDING)])
