"""Bot players for demos: real accounts driving the public API like a client would.

    docker compose --profile demo up bots
    BOT_PARTIES=2,1,3,1 python scripts/bots.py      (from the host)

Each entry in BOT_PARTIES is one party (size 1-4). Bots befriend their leader, join the
party and idle until a human has searched alone for 15-20 s (JOIN_DELAY_S), then queue for
Squad, ready up instantly on MATCH FOUND and play Capture The Flag over the same WebSocket protocol as the browser (brain: bot_ai.py). When the game
ends they return to the hub; they leave the queue if the human stops searching. 2+1+3+1 = 7 bots: one human is enough to
complete a 4v4. If the game-service restarts mid-match, each bot reconnects on its own.
"""

import json
import os
import random
import threading
import time

from websockets.exceptions import ConnectionClosed, InvalidHandshake
from websockets.sync.client import connect as ws_connect

from api import API, ApiFail, Client
from bot_ai import Brain

PASSWORD = os.environ.get("BOT_PASSWORD", "botpass123")
SIZES = [int(s) for s in os.environ.get("BOT_PARTIES", "2,1,3,1").split(",") if s.strip()]
NAMES = ["Nocturne", "Rook", "Zephyr", "Calyx", "Ironwren", "Pax", "Dusk", "Morrow", "Kestrel", "Nimbus",
         "Tallis", "Orrin", "Vex", "Saltmoth", "Juno", "Brask"]
WS_URL = API.replace("http", "ws", 1) + "/game/ws"
JOIN_DELAY_S = (15.0, 20.0)  # how long a human searches alone before the bots queue up for them
RECONNECT_FOR_S = 90  # keep retrying a lost game connection this long (covers a game-service restart)
assert sum(SIZES) <= len(NAMES) and all(1 <= s <= 4 for s in SIZES), "BOT_PARTIES: sizes 1-4, at most 16 bots"


def quiet(fn, *args):
    try:
        return fn(*args)
    except ApiFail as e:
        return e


def form(group: list[Client]) -> None:
    leader, *rest = group
    party = leader.state()["party"]
    have = {m["id"] for m in party["members"]} if party else set()
    for b in rest:
        if b.me["id"] in have:
            continue
        quiet(b.call, "POST", "/social/party/leave")
        quiet(leader.befriend, b)
        quiet(leader.invite_and_join, b)


def connect() -> list[list[Client]]:
    it = iter(NAMES)
    groups = [[Client().login_or_register(next(it), PASSWORD) for _ in range(n)] for n in SIZES]
    for g in groups:
        form(g)
        print(f"[bots] party {'+'.join(b.me['name'] for b in g)}", flush=True)
    return groups


def main() -> None:
    while True:
        try:
            groups = connect()
            break
        except Exception as e:  # gateway not up yet
            print(f"[bots] waiting for API: {e}", flush=True)
            time.sleep(3)

    sessions: dict[str, threading.Thread] = {}  # bot id -> thread playing its current match
    bot_ids = {b.me["id"] for g in groups for b in g}
    join_at: dict[tuple[str, str], float] = {}  # (human party id, joined_at) -> when the bots come
    done: set[tuple[str, str]] = set()  # (bot id, match id) already played and left
    while True:
        waiting = quiet(groups[0][0].call, "GET", "/matchmaking/queue/waiting")
        if isinstance(waiting, ApiFail):
            time.sleep(1.5)
            continue
        humans = {(e["party_id"], e["joined_at"]) for e in waiting if not set(e["player_ids"]) & bot_ids}
        now = time.monotonic()
        for k in humans:  # independent random 15-20 s wait per searching human party
            join_at.setdefault(k, now + random.uniform(*JOIN_DELAY_S))
        for k in set(join_at) - humans:
            del join_at[k]
        summon = any(now >= t for t in join_at.values())
        for g in groups:
            for b in g:
                quiet(b.call, "POST", "/users/me/heartbeat")
            leader = g[0]
            s = quiet(leader.status)
            if isinstance(s, ApiFail):
                continue
            if s["state"] == "searching" and not humans:  # the human gave up: don't fight other bots
                quiet(leader.call, "DELETE", "/matchmaking/queue")
            elif s["state"] == "idle" and summon:
                form(g)
                r = quiet(leader.call, "POST", "/matchmaking/queue", {"mode": "squad"})
                if isinstance(r, ApiFail):
                    print(f"[bots] {leader.me['name']} queue: {r}", flush=True)
            elif s["state"] in ("found", "countdown", "entered"):
                m = s["match"]
                mid = m["match_id"]
                for b in g:
                    if b.me["id"] not in m["ready"]:  # bots accept instantly
                        quiet(b.call, "POST", f"/matchmaking/matches/{mid}/ready")
                if s["state"] != "entered":  # the server starts the match after its countdown
                    continue
                for b in g:
                    bid = b.me["id"]
                    if (bid, mid) in done or (bid in sessions and sessions[bid].is_alive()):
                        continue
                    done.add((bid, mid))
                    sessions[bid] = threading.Thread(target=play_match, args=(b.token, b.me["name"], mid), daemon=True)
                    sessions[bid].start()
        time.sleep(1.5)


def play_match(token: str, name: str, match_id: str) -> None:
    """One bot, one match: think at ~10 Hz on the latest snapshot, send intents, leave at the end."""
    brain, lost_since = None, None
    url = f"{WS_URL}/{match_id}?token={token}&bot=1"
    while True:
        try:
            with ws_connect(url, open_timeout=5) as ws:
                hello = json.loads(ws.recv(timeout=5))
                if hello["t"] == "error":  # ended, unrecoverable or not ours: nothing to play
                    print(f"[bots] {name}: {hello['message']}", flush=True)
                    break
                if lost_since:
                    print(f"[bots] {name} reconnected to {match_id[:8]}", flush=True)
                lost_since = None
                brain = brain or Brain(hello["you"], hello["map"], random.Random())
                next_think = 0.0
                while True:
                    msg = json.loads(ws.recv(timeout=5))
                    if msg["t"] != "state":
                        continue
                    if msg["state"] == "ENDED":
                        print(f"[bots] {name}: {msg['winner']} TEAM WINS", flush=True)
                        time.sleep(3)  # let humans read the end screen before the match empties
                        break
                    now = time.monotonic()
                    if now >= next_think:
                        next_think = now + 0.1
                        for out in brain.think(msg, now):
                            ws.send(json.dumps(out))
            break
        except (ConnectionClosed, InvalidHandshake, OSError, TimeoutError) as e:
            lost_since = lost_since or time.monotonic()
            if time.monotonic() - lost_since > RECONNECT_FOR_S:
                print(f"[bots] {name} gave up on {match_id[:8]}: {e!r}", flush=True)
                break
            time.sleep(1)
    quiet(Client(token).call, "POST", f"/matchmaking/matches/{match_id}/leave")


if __name__ == "__main__":
    main()
