"""Bot players for demos: real accounts driving the public API like a client would.

    docker compose --profile demo up bots
    BOT_PARTIES=2,1,3,1 python scripts/bots.py      (from the host)

Each entry in BOT_PARTIES is one party (size 1-4). Bots befriend their leader, join the
party, queue for Squad, ready up on MATCH FOUND, leave a few seconds after everyone
is ready, then queue again. 2+1+3+1 = 7 bots: one human is enough to complete a 4v4.
"""

import os
import time

from api import ApiFail, Client

PASSWORD = os.environ.get("BOT_PASSWORD", "botpass123")
SIZES = [int(s) for s in os.environ.get("BOT_PARTIES", "2,1,3,1").split(",") if s.strip()]
NAMES = ["Nocturne", "Rook", "Zephyr", "Calyx", "Ironwren", "Pax", "Dusk", "Morrow", "Kestrel", "Nimbus",
         "Tallis", "Orrin", "Vex", "Saltmoth", "Juno", "Brask"]
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

    all_ready_since: dict[str, float] = {}
    while True:
        for g in groups:
            for b in g:
                quiet(b.call, "POST", "/users/me/heartbeat")
            leader = g[0]
            s = quiet(leader.status)
            if isinstance(s, ApiFail):
                continue
            if s["state"] == "idle":
                form(g)
                r = quiet(leader.call, "POST", "/matchmaking/queue", {"mode": "squad"})
                if isinstance(r, ApiFail):
                    print(f"[bots] {leader.me['name']} queue: {r}", flush=True)
            elif s["state"] in ("found", "entered"):
                m = s["match"]
                for b in g:
                    if b.me["id"] not in m["ready"]:
                        quiet(b.call, "POST", f"/matchmaking/matches/{m['match_id']}/ready")
                total = sum(len(t["players"]) for t in m["teams"])
                if len(m["ready"]) >= total:
                    since = all_ready_since.setdefault(m["match_id"], time.time())
                    if time.time() - since > 8:  # give humans time to see the ready state and enter
                        for b in g:
                            quiet(b.call, "POST", f"/matchmaking/matches/{m['match_id']}/leave")
                        print(f"[bots] {leader.me['name']}'s party finished match {m['match_id'][:8]}", flush=True)
        time.sleep(1.5)


if __name__ == "__main__":
    main()
