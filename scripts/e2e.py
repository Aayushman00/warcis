"""End-to-end check of every server-side rule, through the gateway.

    python scripts/e2e.py            (stack must be running; API_URL defaults to localhost:8000/api)

Uses fresh random usernames each run, so it is safe to re-run against a live database.
Set E2E_READY_TIMEOUT_S to the stack's READY_TIMEOUT_S (a small value such as 8) to also check the lobby timeout.
Assumes nobody else is queued (stop the demo bots first: `docker compose stop bots`,
their queue entries expire once their heartbeat is older than PRESENCE_TIMEOUT_S).
"""

import os
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
mid = m["match_id"]
assert m["ready"] == [] and m["status"] == "FOUND", "nobody is auto-ready"
assert m["loadouts"] == {} and m["lobby_ends_at"], "an empty lobby with a server-side deadline"
time.sleep(1.5)
assert a.status()["state"] == "found", "match must not start by itself"

print("match lobby")
LOADOUT = f"/matchmaking/matches/{mid}/loadout"
pick = lambda c, w: {"class": c, "weapon": w}  # noqa: E731
expect("LOADOUT_REQUIRED", a.call, "POST", f"/matchmaking/matches/{mid}/ready")
print("  ok  ready without a loadout is refused")
expect("INVALID_REQUEST", a.call, "PUT", LOADOUT, pick("WIZARD", "SHOTGUN"))
expect("INVALID_REQUEST", a.call, "PUT", LOADOUT, pick("GUARDIAN", "BAZOOKA"))
expect("INVALID_REQUEST", a.call, "PUT", LOADOUT, {"class": "GUARDIAN"})
zed = user("zed")  # an outsider
expect("MATCH_NOT_FOUND", zed.call, "PUT", LOADOUT, pick("GUARDIAN", "SHOTGUN"))
assert a.status()["match"]["loadouts"] == {}, "a rejected pick must not be stored"
print("  ok  invalid picks and outsiders are rejected, nothing stored")
a.call("PUT", LOADOUT, pick("ASSASSIN", "SNIPER_RIFLE"))
st = a.call("PUT", LOADOUT, pick("GUARDIAN", "SHOTGUN"))  # freely changeable until ready; the last pick wins
assert st["state"] == "found" and st["match"]["loadouts"][a.me["id"]] == pick("GUARDIAN", "SHOTGUN")
for x in (b, c, d):  # duplicates on a team are fine: the whole premade is Guardian + Shotgun
    x.call("PUT", LOADOUT, pick("GUARDIAN", "SHOTGUN"))
assert set(b.status()["match"]["loadouts"]) == {a.me["id"], b.me["id"], c.me["id"], d.me["id"]}, "teammates see each other's picks"
for x, (cls, w) in zip((e, f, g, h), (("ASSAULTER", "ASSAULT_RIFLE"), ("ASSASSIN", "SNIPER_RIFLE"), ("ASSAULTER", "SHOTGUN"), ("GUARDIAN", "ASSAULT_RIFLE"))):
    x.call("PUT", LOADOUT, pick(cls, w))
theirs = {x.me["id"] for x in (e, f, g, h)}
assert not theirs & set(a.status()["match"]["loadouts"]), "enemy picks must stay hidden in the lobby"
assert not {x.me["id"] for x in (a, b, c, d)} & set(e.status()["match"]["loadouts"]), "enemy picks must stay hidden in the lobby"
print("  ok  picks change freely, duplicates allowed, teammates see them, the enemy team does not")

for n, x in enumerate(everyone, 1):
    st = x.call("POST", f"/matchmaking/matches/{mid}/ready")
    if n == 1:
        expect("LOADOUT_LOCKED", a.call, "PUT", LOADOUT, pick("ASSAULTER", "ASSAULT_RIFLE"))
        assert a.status()["match"]["loadouts"][a.me["id"]] == pick("GUARDIAN", "SHOTGUN"), "readying locks the loadout"
        print("  ok  readying locks the loadout")
    if n < len(everyone):
        assert st["state"] == "found" and len(st["match"]["ready"]) == n, "not started until ALL ready"
        assert len(everyone[-1].status()["match"]["ready"]) == n  # other clients see it (server-persisted)
assert st["state"] == "countdown" and st["match"]["countdown_ends_at"], "last ready starts the countdown"
expect("MATCH_NOT_READYABLE", a.call, "POST", f"/matchmaking/matches/{mid}/ready")
expect("LOADOUT_LOCKED", e.call, "PUT", LOADOUT, pick("ASSAULTER", "ASSAULT_RIFLE"))  # also locked during the countdown
during = a.status()
if during["state"] == "countdown":  # a 3 s window: the enemy's picks are still hidden
    assert not theirs & set(during["match"]["loadouts"]), "enemy picks hidden during the countdown"
wait_for(a.status, lambda s: s["state"] == "entered", timeout=8)
assert all(x.status()["state"] == "entered" for x in everyone)
for x in (a, e):  # revealed once the match starts
    assert len(x.status()["match"]["loadouts"]) == 8, "both teams' loadouts are visible once the match is running"
expect("LOADOUT_LOCKED", e.call, "PUT", LOADOUT, pick("ASSAULTER", "ASSAULT_RIFLE"))
expect("MATCH_NOT_FOUND", zed.call, "POST", f"/matchmaking/matches/{mid}/ready")
for x in everyone:
    x.call("POST", f"/matchmaking/matches/{m['match_id']}/leave")
assert a.status()["state"] == "idle"
print("  ok  found -> explicit ready -> countdown -> in progress -> leave, outsiders rejected")

print("cross-db consistency")
i, j = user("ivy"), user("jo")
i.befriend(j)
i.invite_and_join(j)
i.call("POST", "/matchmaking/queue", {"mode": "squad"})
j.call("POST", "/social/party/leave")  # Postgres changes while the Mongo entry is WAITING
wait_for(i.status, lambda s: s["state"] == "idle")
print("  ok  stale queue entry invalidated after party changed in Postgres")
k = user("kai")
k.call("POST", "/matchmaking/queue", {"mode": "squad"})
k.call("DELETE", "/matchmaking/queue")
k.call("DELETE", "/matchmaking/queue")  # idempotent
assert k.status()["state"] == "idle"
print("  ok  solo queue + idempotent cancel")

print("fill off")
l, m2 = user("lea"), user("moe")
l.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": False})
m2.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": False})
found = wait_for(l.status, lambda s: s["state"] == "found")["match"]
assert sorted(len(t["players"]) for t in found["teams"]) == [1, 1]
l.call("PUT", f"/matchmaking/matches/{found['match_id']}/loadout", pick("ASSASSIN", "SHOTGUN"))
l.call("POST", f"/matchmaking/matches/{found['match_id']}/ready")
m2.call("POST", f"/matchmaking/matches/{found['match_id']}/leave")  # leaving during the ready check voids it
assert m2.status()["state"] == "idle"
assert wait_for(l.status, lambda s: s["state"] == "idle")["notice"]
print("  ok  fill off: two solo parties matched as-is, never combined")

if os.environ.get("E2E_READY_TIMEOUT_S"):
    wait = int(os.environ["E2E_READY_TIMEOUT_S"])
    print(f"lobby timeout ({wait} s)")
    p, q = user("pat"), user("quin")
    p.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": False})
    q.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": False})
    lobby = wait_for(p.status, lambda s: s["state"] == "found")["match"]
    p.call("PUT", f"/matchmaking/matches/{lobby['match_id']}/loadout", pick("GUARDIAN", "SHOTGUN"))
    p.call("POST", f"/matchmaking/matches/{lobby['match_id']}/ready")  # quin never picks
    time.sleep(wait + 3)
    for x in (p, q):
        s = x.status()
        assert s["state"] == "idle", f"expected the whole match cancelled, got {s['state']}"  # not re-queued, not started
    assert "loadout" in p.status()["notice"] or "loadout" in q.status()["notice"]
    expect("MATCH_NOT_READYABLE", q.call, "POST", f"/matchmaking/matches/{lobby['match_id']}/ready")
    print("  ok  an incomplete lobby cancels the whole match: no defaults assigned, nobody re-queued")

if os.environ.get("E2E_LOBBY_DEADLINE"):  # needs docker compose: moves the deadline in Mongo directly
    import subprocess

    print("lobby deadline (no ready or pick lands after lobby_ends_at, even before the matcher's next tick)")
    p, q = user("rhea"), user("sol")
    p.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": False})
    q.call("POST", "/matchmaking/queue", {"mode": "squad", "fill": False})
    lobby = wait_for(p.status, lambda s: s["state"] == "found")["match"]
    mid = lobby["match_id"]
    for x in (p, q):
        x.call("PUT", f"/matchmaking/matches/{mid}/loadout", pick("GUARDIAN", "SHOTGUN"))
    p.call("POST", f"/matchmaking/matches/{mid}/ready")
    js = f'db.getSiblingDB(process.env.MONGO_DB || "warcis").matches.updateOne({{match_id: "{mid}", status: "FOUND"}}, {{$set: {{lobby_ends_at: new Date(Date.now() - 200)}}}})'
    subprocess.run(["docker", "compose", "exec", "-T", "mongodb", "sh", "-c",
                    f'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval \'{js}\''],
                   check=True, capture_output=True)
    expect("MATCH_NOT_READYABLE", q.call, "POST", f"/matchmaking/matches/{mid}/ready")
    expect("LOADOUT_LOCKED", q.call, "PUT", f"/matchmaking/matches/{mid}/loadout", pick("ASSASSIN", "SHOTGUN"))
    for x in (p, q):
        assert wait_for(x.status, lambda s: s["state"] == "idle")["state"] == "idle"  # cancelled by the tick, never started
    print("  ok  an expired lobby refuses the last ready and any pick, then is cancelled as a whole")

print("\nALL E2E CHECKS PASSED")
