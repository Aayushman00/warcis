"""End-to-end check of every server-side rule, through the gateway.

    python scripts/e2e.py            (stack must be running; API_URL defaults to localhost:8000/api)

Uses fresh random usernames each run, so it is safe to re-run against a live database.
"""

import secrets
import time

from api import ApiFail, Client

PW = "hunter22"
run = secrets.token_hex(3)


def user(name: str) -> Client:
    return Client().register(f"{name}_{run}", PW)


def expect(code: str, fn, *args):
    try:
        fn(*args)
    except ApiFail as e:
        assert e.code == code, f"expected {code}, got {e}"
        print(f"  ok  rejected with {e.status} {code}")
        return
    raise AssertionError(f"expected {code}, call succeeded")


def wait_for(fn, pred, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if pred(v):
            return v
        time.sleep(0.4)
    raise AssertionError(f"timed out; last value: {v}")


print("auth")
a, b, c, d = user("ana"), user("bo"), user("cy"), user("dee")
expect("ACCOUNT_EXISTS", Client().register, a.me["name"], PW)
expect("INVALID_CREDENTIALS", Client().login, a.me["name"], "wrongpass")
expect("INVALID_TOKEN", Client("not.a.jwt").state)
expect("UNAUTHENTICATED", Client().state)
assert Client().login(a.me["name"].upper(), PW).me["id"] == a.me["id"]  # case-insensitive login
print("  ok  register/login/JWT")

print("friends")
a.call("POST", "/social/friend-requests", {"username": b.me["name"]})
assert b.state()["requests"]["incoming"][0]["user"]["id"] == a.me["id"]
expect("REQUEST_PENDING", a.call, "POST", "/social/friend-requests", {"username": b.me["name"]})
expect("CANNOT_ADD_SELF", a.call, "POST", "/social/friend-requests", {"username": a.me["name"]})
expect("USER_NOT_FOUND", a.call, "POST", "/social/friend-requests", {"username": f"{b.me['name']}#0000"})
req = b.state()["requests"]["incoming"][0]
expect("REQUEST_NOT_FOUND", c.call, "POST", f"/social/friend-requests/{req['id']}/accept")  # not addressed to C
b.call("POST", f"/social/friend-requests/{req['id']}/accept")
assert [f["id"] for f in a.state()["friends"]] == [b.me["id"]]
assert [f["id"] for f in b.state()["friends"]] == [a.me["id"]]
expect("ALREADY_FRIENDS", a.call, "POST", "/social/friend-requests", {"username": b.me["name"]})
a.befriend(c), a.befriend(d)
print("  ok  request -> accept -> mutual friendship")

print("party")
expect("NOT_FRIENDS", c.call, "POST", "/social/party/invitations", {"user_id": d.me["id"]})
a.call("POST", "/social/party/invitations", {"user_id": b.me["id"]})
expect("INVITE_PENDING", a.call, "POST", "/social/party/invitations", {"user_id": b.me["id"]})
expect("INVITES_PENDING", a.call, "POST", "/matchmaking/queue", {"mode": "squad"})
inv = b.state()["invitations"][0]
b.call("POST", f"/social/invitations/{inv['id']}/accept")
pa, pb = a.state()["party"], b.state()["party"]
assert pa["id"] == pb["id"] and len(pa["members"]) == 2 and pa["leader_id"] == a.me["id"]
print("  ok  2 / 4 visible to both members")
expect("NOT_LEADER", b.call, "POST", "/matchmaking/queue", {"mode": "squad"})
expect("NOT_LEADER", b.call, "DELETE", f"/social/party/members/{a.me['id']}")
a.invite_and_join(c)
assert len(a.state()["party"]["members"]) == 3
print("  ok  3 / 4")
a.invite_and_join(d)
assert len(d.state()["party"]["members"]) == 4
print("  ok  4 / 4")
e = user("eve")
a.befriend(e)
expect("PARTY_FULL", a.call, "POST", "/social/party/invitations", {"user_id": e.me["id"]})
off = user("off")
a.befriend(off)
off.call("POST", "/auth/logout")
expect("USER_UNAVAILABLE", a.call, "POST", "/social/party/invitations", {"user_id": off.me["id"]})

print("kick / leave / leadership")
a.call("DELETE", f"/social/party/members/{d.me['id']}")
assert d.state()["party"] is None and len(a.state()["party"]["members"]) == 3
a.invite_and_join(d)
v_before = a.state()["party"]["version"]
a.call("POST", "/social/party/leave")
pb = b.state()["party"]
assert pb["leader_id"] == b.me["id"] and len(pb["members"]) == 3 and pb["version"] > v_before
print("  ok  leader left -> longest member promoted, version bumped")
b.invite_and_join(a)
assert len(b.state()["party"]["members"]) == 4 and a.state()["party"]["leader_id"] == b.me["id"]

print("matchmaking")
expect("RANDOM_SOLO_ONLY", b.call, "POST", "/matchmaking/queue", {"mode": "random"})
s1 = b.call("POST", "/matchmaking/queue", {"mode": "squad"})
s2 = b.call("POST", "/matchmaking/queue", {"mode": "squad"})  # idempotent
assert s1["state"] == s2["state"] == "searching" and s1["queue"]["party_id"] == s2["queue"]["party_id"]
assert a.status()["state"] == "searching"  # members see the party's queue state too
print("  ok  premade 4 queued once (idempotent), members see searching")

# Other side: a 2-party + two solos combine into the opponent team.
f, g, h = user("fin"), user("gus"), user("hal")
e.befriend(f)
e.invite_and_join(f)
e.call("POST", "/matchmaking/queue", {"mode": "squad"})
assert e.status()["queue"]["size"] == 2
g.call("POST", "/matchmaking/queue", {"mode": "squad"})
h.call("POST", "/matchmaking/queue", {"mode": "squad"})
m = wait_for(h.status, lambda s: s["state"] == "found")["match"]
teams = [{p["id"] for p in t["players"]} for t in m["teams"]]
premade = {x.me["id"] for x in (a, b, c, d)}
assert premade in teams, "full premade must stay together"
other = next(t for t in m["teams"] if t["parties"] and {p["id"] for p in t["players"]} != premade)
assert sorted(len(p["players"]) for p in other["parties"]) == [1, 1, 2]
print("  ok  match found: [4 premade] vs [2 + 1 + 1]")

everyone = (a, b, c, d, e, f, g, h)
expect("NOT_ALL_READY", a.call, "POST", f"/matchmaking/matches/{m['match_id']}/enter")
for x in everyone:
    assert x.status()["state"] == "found"
    x.call("POST", f"/matchmaking/matches/{m['match_id']}/ready")
assert a.call("POST", f"/matchmaking/matches/{m['match_id']}/enter")["state"] == "entered"
expect("MATCH_NOT_FOUND", user("zed").call, "POST", f"/matchmaking/matches/{m['match_id']}/ready")
for x in everyone:
    x.call("POST", f"/matchmaking/matches/{m['match_id']}/leave")
assert a.status()["state"] == "idle"
print("  ok  ready check -> enter -> leave, outsiders rejected")

print("cross-db consistency")
i, j = user("ivy"), user("jo")
i.befriend(j)
i.invite_and_join(j)
i.call("POST", "/matchmaking/queue", {"mode": "squad"})
j.call("POST", "/social/party/leave")  # Postgres changes while the Mongo entry is WAITING
wait_for(i.status, lambda s: s["state"] == "idle")
print("  ok  stale queue entry invalidated after party changed in Postgres")
k = user("kai")
k.call("POST", "/matchmaking/queue", {"mode": "random"})
k.call("DELETE", "/matchmaking/queue")
k.call("DELETE", "/matchmaking/queue")  # idempotent
assert k.status()["state"] == "idle"
print("  ok  solo random queue + idempotent cancel")

print("\nALL E2E CHECKS PASSED")
