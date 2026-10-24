# Plan: Classes, Weapons, Abilities and the Match Lobby

Status: **plan only, nothing implemented.** All seven decisions in §13 are **approved by the user** and are authoritative requirements. Written against `feature/match-results-history` @ `6462bbd`.
Baseline self-checks pass on that commit: `python -m app.sim` → `sim ok`, `python -m app.services.packing` → `packing ok`,
`python scripts/bot_ai.py` → `bot_ai ok`.

Notation used throughout:

- **[FACT]** something read in the code at the cited `file:line`.
- **[REC]** a recommendation of this plan. The implementer follows it; it may be changed only for a concrete engineering reason that is reported back. Items the user decided are not [REC]: they are the approved decisions in §13 (cited as "Decision N").

---

## 1. Existing match lifecycle and who owns each transition

### 1.1 Facts

| # | Transition | Owner (authoritative writer) | Where | Store |
|---|---|---|---|---|
| 1 | Party snapshot → queue entry `WAITING` | matchmaking-service `enqueue` (validates leader / size / invites against party-service) | `services/matchmaking-service/app/services/queue.py:47` | Mongo `matchmaking_queue` |
| 2 | Re-validation of `(party_id, version)` | matchmaking `tick` → party-service `/internal/parties/validate` (Postgres is source of truth for parties) | `queue.py:308-313` | Postgres read, Mongo write |
| 3 | `WAITING` → `MATCHED`, match doc `FOUND` | matcher `_create_match` (conditional claim + compensating rollback) | `queue.py:263-292` | Mongo `matches` |
| 4 | Player readies (`$addToSet ready`) | `ready()` conditional on `status: FOUND` | `queue.py:183-199` | Mongo |
| 5 | `FOUND` → `COUNTDOWN` (`countdown_ends_at = now + COUNTDOWN_S`) | the last `ready()` call, conditional on `FOUND`, exactly one racer wins | `queue.py:192-198` | Mongo |
| 6 | `FOUND` → `CANCELLED` (timeout) | matcher `tick`, `created_at < now - READY_TIMEOUT` (45 s default). Sets no `reason` (only the event has `reason=ready_timeout`) | `queue.py:298-301` | Mongo |
| 7 | `FOUND`/`COUNTDOWN` → `CANCELLED` (decline) | `leave()` with `reason: player_left` | `queue.py:221-226` | Mongo |
| 8 | `COUNTDOWN` → `IN_PROGRESS`, `entered = player_ids` | `_start_if_due`, called by **both** `tick` and `status()` polling, conditional on `COUNTDOWN` | `queue.py:202-213`, `:133-134`, `:302-303` | Mongo |
| 9 | Game room created | game-service `open_room` on first WS connection; **refuses unless `status == IN_PROGRESS` and no `result`** | `services/game-service/app/main.py:84-107` | RAM + Mongo `game_checkpoints` |
| 10 | Roster → simulation | `Game([team["players"] for team in m["teams"]], t)`; team 0 = RED, 1 = BLUE | `main.py:101`, `sim.py:101-109` | RAM |
| 11 | Simulation (movement, shots, damage, death, respawn, flags, capture) | `Game.step` in `run()` at 30 Hz; client intents applied by the WS reader between ticks (single asyncio thread, no awaits inside sim) | `main.py:149-169`, `sim.py:149-230` | RAM |
| 12 | Checkpoint every 3 s + on graceful stop | `run()` / lifespan | `main.py:162-164`, `:205-206` | Mongo `game_checkpoints` |
| 13 | Restore after restart | `recover_on_startup` (≤600 s old, match still `IN_PROGRESS`) or lazily in `open_room` | `main.py:122-139`, `:105-107` | Mongo |
| 14 | Result written once (`result: {$exists: false}` guard) + `MATCH_ENDED`/`PLAYER_RESULT` events | game-service `_record_result` | `main.py:174-197` | Mongo `matches`, `match_events` |
| 15 | `IN_PROGRESS` → `COMPLETED` | `leave()` / `retire_ended()` (rematch), last leaver completes | `queue.py:216-257` | Mongo |
| 16 | History / career stats | derived on read from `matches.result` | `services/matchmaking-service/app/services/stats.py` | Mongo |

Other facts that drive this plan:

- **[FACT]** The frontend routes purely on polled `GET /matchmaking/status` (1.5 s, `frontend/src/App.tsx:10,84`): `found`/`countdown` → `<Found>`, `entered` → `<Game>` (`frontend/src/Matchmaking.tsx:45-46`). There is no lobby WebSocket.
- **[FACT]** The lobby cannot be bypassed today because game-service rejects any match that is not `IN_PROGRESS` (`main.py:96-97`), and only the server moves a match to `IN_PROGRESS`. This property must be kept: **the new gate is "ready requires a valid server-stored loadout"**.
- **[FACT]** One snapshot dict is built per tick and sent to every socket (`main.py:155-156`); the initial snapshot on connect is also global (`main.py:238`). Every player's `x`/`y` goes to everyone (`sim.py:304-347`). Invisibility is impossible without per-viewer snapshots.
- **[FACT]** Shot resolution (`sim.py:176-193`): victim = the *first player in dict order* whose distance to the tick segment is small enough (not the first along the path); the wall test checks only the segment **endpoint** (`_hits_wall(nx, ny, SHOT_R)`). At 650 px/s × 33 ms ≈ 22 px per tick this is fine against 40 px walls. A sniper round (≥1 500 px/s ≈ 50 px/tick) and any thin barrier (12 px) would tunnel. A shot can also hit a player standing behind a wall corner in the same tick.
- **[FACT]** Damage is a single constant (`DAMAGE = 25`, `sim.py:15`, `_damage` `:195`); HP is a single constant (`HP = 100`) used in `_spawn` (`:121`) and asserted as `100` in `ctf_e2e.py:141`; the HUD draws 4 × 25 HP segments (`Game.tsx:627-628`) and the renderer hides the HP bar at `hp < 100` (`render.ts`, `drawPlayer`).
- **[FACT]** Client autofire sends `fire` at most every 100 ms while LMB is held (`Game.tsx:356-361`); the server silently drops fire inside the cooldown (`sim.py:137`). With any cooldown not equal to a multiple of the client gate, the real fire rate is quantised (e.g. 160 ms cooldown → ~200 ms actual).
- **[FACT]** The client mirrors x for team 1 on the way in (`viewSnap`, `Game.tsx:66-76`) and out (`fire`, `sendInput`, `Game.tsx:189-190`). Every new world-space field (barriers, ability aim) must go through the same mirror.
- **[FACT]** Bots ready instantly by polling status every 1.5 s (`scripts/bots.py:102-109`) and fire on a fixed 0.55-0.75 s gap tuned to the old 500 ms cooldown (`scripts/bot_ai.py:186`). `bot_ai` reads every enemy's `x`/`y` (`bot_ai.py:287-288`). The bots E2E watcher attributes shots by distance to every player (`ctf_e2e.py:314`).
- **[FACT]** Checkpoints use wall-clock epoch ms so timers survive restarts (`main.py:47-48`, `sim.py:238-239`); `restore` raises `ValueError` on inconsistency rather than inventing state, and tolerates missing fields from older checkpoints with `.get` (`sim.py:271`).
- **[FACT]** `services/common/warcis_common/` is copied into both game-service and matchmaking-service images (`services/*/Dockerfile`, `PYTHONPATH=/srv/common`); its `__init__.py` is empty, so a new pure module there imports without env vars.
- **[FACT]** Test convention: no pytest; pure modules carry an `if __name__ == "__main__":` self-check (`sim.py:361`, `packing.py`, `stats.py`, `bot_ai.py`), plus full-stack scripts `scripts/e2e.py` and `scripts/ctf_e2e.py`.
- **[FACT, unrelated]** `README.md:213` documents a `/enter` route that no longer exists. Fix it while editing the README; nothing else.

### 1.2 New lifecycle ([REC])

Keep the Mongo status names. **`FOUND` becomes the Match Lobby.** Renaming it would break `PRE_GAME`, `status()`'s `found` state, bots, `e2e.py` and `ctf_e2e.py` for no gain.

```
queue WAITING ──matcher──▶ FOUND (lobby: select loadout, then ready) ──last ready──▶ COUNTDOWN ──deadline──▶ IN_PROGRESS ──▶ COMPLETED
                            │  owner: matchmaking-service, Mongo `matches`                │ (loadouts frozen)      │ game-service reads
                            ├─ lobby deadline passes ─▶ CANCELLED reason=lobby_timeout       │                        │ loadouts once at room
                            └─ any player declines   ─▶ CANCELLED reason=player_left  ◀──────┘ (decline still allowed in COUNTDOWN, as today)
```

- "Match Found" is a **client-only reveal** (about 2 s of animation the first time the client sees a new `match_id` in state `found`). It is not a server state and there is no server-enforced accept step (Decision 1).
- Invariants enforced in Mongo with single-document conditional updates:
  1. `ready` ⊆ players with a valid `loadouts[uid]`.
  2. `loadouts[uid]` cannot change once `uid ∈ ready` or `status ≠ FOUND`.
  3. `IN_PROGRESS` ⇒ every player has a loadout (follows from 1 + "all ready").
- game-service keeps its existing gate (`IN_PROGRESS` only) and reads `loadouts` from the same match document it already reads for the roster.

---

## 2. Files and functions that change

| File | Function / area | Change |
|---|---|---|
| `services/common/warcis_common/loadout.py` (**new**, the only new Python module) | — | `CLASSES = ("ASSAULTER","GUARDIAN","ASSASSIN")`, `WEAPONS = ("ASSAULT_RIFLE","SHOTGUN","SNIPER_RIFLE")`, `DEFAULT_LOADOUT = {"class": "ASSAULTER", "weapon": "ASSAULT_RIFLE"}`, `def valid(d) -> bool`, self-check. IDs only; **no balance numbers** (those belong to the sim). |
| `services/matchmaking-service/app/schemas/mm.py` | add `LoadoutIn` | `class_: Literal[...] = Field(alias="class")`, `weapon: Literal[...]`. Literals are built from `loadout.CLASSES/WEAPONS`. |
| `services/matchmaking-service/app/api/routes.py` | add route | `PUT /matchmaking/matches/{match_id}/loadout` → `queue.set_loadout`. The gateway already proxies PUT (`gateway/app/main.py:259`). |
| `services/matchmaking-service/app/services/queue.py` | `_create_match` | insert `loadouts: {}` and `lobby_ends_at: now() + READY_TIMEOUT`. |
| | **new** `set_loadout(match_id, user_id, cls, weapon)` | see §5.2. |
| | `ready` | add the loadout guard to the conditional filter (§5.2). |
| | `match_view` | add `loadouts` (filtered, §6.3), `lobby_ends_at`. |
| | `status` | notice for `reason == "lobby_timeout"`. |
| | `tick` | expire on `lobby_ends_at` (with a legacy `created_at` fallback) and set `reason: "lobby_timeout"`. |
| | `READY_TIMEOUT` default | 45 → 60 s (env var name unchanged; update `docker-compose.yml:61`). |
| `services/matchmaking-service/app/services/stats.py` | `result_view` | none; the new per-player `class`/`weapon` keys pass through as data. Self-check gains one row carrying them. |
| `services/game-service/app/sim.py` | constants | class and weapon tables, ability and barrier constants (§3, §9). |
| | `Player` | new fields (§3.1). |
| | **new** `Barrier` dataclass | §3.2. |
| | `Game.__init__` | read `class`/`weapon` from each roster dict (default `DEFAULT_LOADOUT` if absent), `barriers=[]`. |
| | `_spawn` | `hp = max_hp(p)`; clear `invisible_until`, dash. |
| | `fire` | weapon-driven cooldown, pellets, speed, TTL, damage; reveal the shooter (§7.5). |
| | **new** `ability(pid, ax, ay, now)` | dispatch on class (§7.3-7.5). |
| | `step` | expire invisibility and barriers; dash-aware `_move`; swept `_shots`. |
| | `_move` | dash integration with sub-stepping. |
| | `_shots` | rewrite as swept earliest-hit resolution (§7.1). |
| | `_damage(p, now, by, amount)` | variable damage, reveal on `amount > 0`, end dash/invisibility on death. |
| | `_flags` | enemy-flag pickup reveals the carrier. |
| | `checkpoint` / `restore` / `result` / `snapshot(…, viewer_team)` | §4, §7.7. |
| | `MAP` | unchanged. A new `CATALOG` dict (class/weapon/ability numbers the HUD needs) is sent in `hello`. |
| | self-check block | extend (§10.1). |
| `services/game-service/app/main.py` | `open_room` | merge `m.get("loadouts")` into the roster dicts passed to `Game(...)`. |
| | `run` | build **two** snapshots per tick (one per team) and send each socket its team's view. |
| | `play` | initial snapshot per team; new message `{"t":"ability","x","y"}`; `hello` gains `catalog`. |
| | docstring | protocol update. |
| `scripts/bots.py` | `main` loop | `PUT …/loadout` before `POST …/ready`; deterministic varied loadout per bot. |
| `scripts/bot_ai.py` | `Brain.__init__`, `think` | per-weapon fire gap and engagement range; skip enemies with `x is None`; simple Q usage; self-check passes loadouts. |
| `scripts/api.py` | — | none. |
| `scripts/e2e.py` | matchmaking section | loadouts before ready; new rejection checks (§10.2). |
| `scripts/ctf_e2e.py` | `form_match`, `play`, `recovery`, `run_bots` | lobby flow, per-class max HP, new scenarios (§10.3-10.4); handle `x: null`. |
| `frontend/src/api.ts` | DTOs | `Loadout`, `ClassId`, `WeaponId`; `MatchDTO.loadouts`, `lobby_ends_at`; optional `class`/`weapon` on `PlayerResult`. |
| `frontend/src/Matchmaking.tsx` | `Found` → `Lobby` | reveal, class and weapon pickers, READY gated on the server-confirmed loadout, deadline. |
| `frontend/src/App.tsx` | `<Matchmaking>` props | `onLoadout(id, loadout)` → `act(() => api(PUT …))`. |
| `frontend/src/game/classes.ts` (**new**) | — | display names, blurbs, and a `drawAvatar(ctx, cls, …)` shared by the lobby (small canvas or SVG) and `render.ts`. |
| `frontend/src/game/render.ts` | `GPlayer`, `Snapshot`, `GShot`, `draw`, `drawPlayer` | new fields; hidden players skipped; ally-invisible translucency; class silhouettes; per-weapon visuals; barriers; snap (not interpolate) when a player's hidden state flips; dashes interpolate. |
| `frontend/src/Game.tsx` | `viewSnap`, `hudOf`, input effect, footer HUD | mirror barriers; `KeyQ` → ability with mirrored aim; autofire gated by weapon cooldown from `hello.catalog`; ability and weapon HUD; HP segments from `maxHp`. |
| `frontend/src/game/hud.css` | — | ability chip and cooldown ring. |
| `frontend/src/Scoreboard.tsx`, `Profile.tsx` | — | optional class icon when the `class` field exists. |
| `README.md` | gameplay, API, Mongo sections | document all of the above. |

Not touched: auth-service, party-service, Postgres schema, gateway, `packing.py`, `party_client.py`, nginx.

---

## 3. State definitions

### 3.1 Player (sim, RAM)

Existing fields stay. Added ([REC]):

```python
pclass: str = "ASSAULTER"          # "class" is reserved in Python; JSON key is "class"
weapon: str = "ASSAULT_RIFLE"
hp: int                            # initialised to CLASS[pclass]["hp"], no longer the HP constant
last_fire: int = -10**9            # was -FIRE_COOLDOWN_MS; must be "long ago" for any weapon
ability_ready_at: int = 0          # epoch ms; Q is usable when now >= this. 0 = ready at match start
invisible_until: int | None = None # Assassin; None = visible
dash_from: int | None = None       # Assaulter; dash window [dash_from, dash_until)
dash_until: int | None = None
dash_dx: float = 0.0               # unit direction, fixed at activation
dash_dy: float = 0.0
```

Helpers: `max_hp(p)`, `invisible(p, now) -> bool` (`invisible_until is not None and now < invisible_until`), `_reveal(p)` (sets `invisible_until = None`).

### 3.2 Barrier (sim, RAM, checkpointed)

```python
@dataclass
class Barrier:
    id: int
    owner: str
    team: int
    x: float; y: float; w: float; h: float   # axis-aligned rect, same convention as WALLS
    hp: int
    expires_at: int
```

`Game.barriers: list[Barrier]`, `Game._barrier_id`. At most one live barrier per owner.

### 3.3 Shot (sim, RAM, not checkpointed, as today)

Add `damage: int`, `ttl: int`, `weapon: str`. `vx`/`vy` already carry the speed.

### 3.4 Match document (Mongo `matches`, owned by matchmaking-service)

```js
loadouts: { "<user_id>": { class: "GUARDIAN", weapon: "SHOTGUN", at: ISODate } },  // {} at creation
lobby_ends_at: ISODate,                                                              // created_at + READY_TIMEOUT
reason: "lobby_timeout" | "player_left"                                              // on CANCELLED; lobby_timeout is new
result.players[i].class, result.players[i].weapon                                    // written by game-service; absent on old results
```

[REC] Key `loadouts` by user id. User ids are Postgres `gen_random_uuid()` strings (hex and hyphens only), so they are safe Mongo field names, and per-key conditional updates stay single-document atomic. `set_loadout` asserts `user_id in m["player_ids"]` before building the field path. That check is the defence against `.`/`$` injection, and the id comes from the verified JWT, never from the body.

### 3.5 Visibility

Visibility is derived per viewer at snapshot time and never stored. For a viewer on team `T`, player `p` is **hidden** iff `p.team != T and invisible(p, now) and not game.ended`.

---

## 4. Protocol changes

### 4.1 HTTP (matchmaking)

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| PUT | `/matchmaking/matches/{id}/loadout` | `{"class": ClassId, "weapon": WeaponId}` | 200, same body as `GET /status` | 400 `INVALID_REQUEST` (bad enum, via the existing validation handler); 404 `MATCH_NOT_FOUND` (not your match); 409 `LOADOUT_LOCKED` (you are ready, or status ≠ `FOUND`) |
| POST | `/matchmaking/matches/{id}/ready` | — | unchanged | **new** 409 `LOADOUT_REQUIRED` when you have no loadout; existing 409 `MATCH_NOT_READYABLE` |

`MatchDTO` additions: `loadouts: Record<userId, {class, weapon}>` (filtered, §6.3) and `lobby_ends_at: string | null`.

### 4.2 WebSocket client → server

| Message | Status | Notes |
|---|---|---|
| `{"t":"input", up,down,left,right}` | unchanged | ignored for movement while dashing |
| `{"t":"fire", x, y}` | unchanged shape | weapon comes from server state; the client cannot choose it |
| `{"t":"ability", x, y}` | **new** | aim point in world coords, mirrored by the client like `fire`. Validated exactly like `fire` (`int/float`, finite). Dropped silently if dead, ended, on cooldown, or invalid (same policy as `fire`). |
| `{"t":"ping", c}` | unchanged | |

No client message can set class, weapon, HP, cooldown or position. **The loadout comes only from the match document.**

### 4.3 WebSocket server → client

`hello`: `{"t":"hello","you","map","catalog"}`, where `catalog = {classes: {ID: {hp, ability, abilityCooldownMs, abilityDurationMs}}, weapons: {ID: {cooldownMs, damage, pellets, range}}, fireRateMult: {ASSAULTER: 0.8}}`. The HUD uses it for cooldown rings and to gate client autofire. Nothing in it is authoritative.

`state` snapshot. Per player:

```ts
class: ClassId; weapon: WeaponId; maxHp: number
x: number | null; y: number | null   // null ⇔ hidden from this viewer
hidden: boolean                       // true ⇔ x/y nulled for this viewer
invisible: boolean                    // only ever true for self/allies; always false in enemy-team views
dashing: boolean                      // false when hidden
abilityReadyAt: number | null         // self/allies only; null for enemies
```

Top-level `barriers: {id, owner, team, x, y, w, h, hp, maxHp, expiresAt}[]` go to both teams; barriers are not hidden. `shots[i].w` carries the weapon id (for visuals). A hidden player's shots never exist, because firing reveals (§7.5).

[REC] **Keep events snapshot-derived**, as `Game.tsx:202-260` does today (dash start = `dashing` false→true; barrier appear/disappear = id diff; reveal = `hidden` true→false). No new event channel. Backward compatible: every change is an additive key, except `x`/`y` becoming nullable, which only affects consumers updated in this plan.

---

## 5. Match lobby: transitions, reconnects, timeouts

### 5.1 States (server)

`FOUND` (lobby) → `COUNTDOWN` → `IN_PROGRESS`; `FOUND`/`COUNTDOWN` → `CANCELLED`. Per player within `FOUND`: `NO_LOADOUT` → `SELECTED` (changeable) → `READY` (locked). Players may change their loadout freely until they ready; readying locks it, and there is no un-ready and no change afterwards (Decision 3).

### 5.2 Exact Mongo operations

```python
# set_loadout: single conditional update; enforces "FOUND", "mine", "not ready".
r = await matches.update_one(
    {"match_id": mid, "status": "FOUND", "player_ids": uid, "ready": {"$ne": uid}},
    {"$set": {f"loadouts.{uid}": {"class": c, "weapon": w, "at": now()}}})
if not r.matched_count:
    m = await _own_match(mid, uid)            # 404 if not mine
    raise ApiError(409, "LOADOUT_LOCKED", ...)
if changed: await log(mid, "LOADOUT_SELECTED", uid, **{"class": c, "weapon": w})

# ready: the loadout guard joins the existing FOUND condition (same single document, same atomic op).
before = await matches.find_one_and_update(
    {"match_id": mid, "status": "FOUND", f"loadouts.{uid}": {"$exists": True}},
    {"$addToSet": {"ready": uid}}, return_document=BEFORE)
if not before:  # disambiguate for the error code only
    m = await _own_match(mid, uid)
    raise ApiError(409, "LOADOUT_REQUIRED" if m["status"] == "FOUND" and uid not in m.get("loadouts", {}) else "MATCH_NOT_READYABLE", ...)
# the rest of ready() (COUNTDOWN flip conditional on FOUND) is unchanged
```

`set_loadout` and `ready` on the same player are serialised by Mongo's per-document atomicity. Either the loadout write lands first and ready sees it, or ready lands first and the loadout write fails its `ready: {$ne}` condition. Neither can produce "ready with a different or no loadout".

### 5.3 Timeouts

- **[REC]** One deadline for the whole lobby: `lobby_ends_at = created_at + READY_TIMEOUT` (default 60 s). Stored, so the UI shows the server's deadline instead of computing one.
- `tick`: `{"status": "FOUND", "$or": [{"lobby_ends_at": {"$lt": now}}, {"lobby_ends_at": {"$exists": False}, "created_at": {"$lt": now - READY_TIMEOUT}}]}` → conditional `FOUND` → `CANCELLED`, `reason: "lobby_timeout"`, `ended_at`. The `$or` branch covers lobby documents created before the deploy.
- A player who has not selected cannot be ready, so on timeout the match is cancelled for everyone. This is today's semantics: no auto-assigned loadout, no auto-start and no partial requeue (Decision 4).
- `status()` notice: `lobby_timeout` → "Match cancelled: not every player picked a loadout and readied up."
- `COUNTDOWN` has no timeout (unchanged) and lasts 3 s.
- Race "last ready vs timeout": both are conditional on `status: FOUND`; exactly one wins. If the timeout wins, the ready call's `$addToSet` may land on a cancelled document; the COUNTDOWN flip then fails and the client sees `idle` plus a notice. Unchanged from today.

### 5.4 Reconnects and refreshes

- The lobby holds no client state. Selected loadout, ready flag and deadline all come from `GET /status`. A refresh or a second tab re-renders the same lobby, with the selection pre-highlighted from `match.loadouts[me]`.
- The client may highlight a pick optimistically, but READY is enabled only when `match.loadouts[me.id]` exists in the latest server response. The PUT returns the fresh status, so there is no extra poll.
- A closed tab simply never readies, and the lobby times out (as today). [REC] No presence check in the lobby: out of scope, and the timeout already bounds it.
- Disconnect during `COUNTDOWN`/`IN_PROGRESS`: unchanged. The WS reconnect loop (`Game.tsx:299-309`) resumes the same room; the class and weapon come back with the snapshot.
- Bots reconnecting after a game-service restart: unchanged; their loadout is on the match document.

---

## 6. Security, hidden information, races, compatibility

### 6.1 Server authority / bypass

| Risk | Mitigation |
|---|---|
| Client skips the lobby and opens the WS early | Existing `IN_PROGRESS` gate (`main.py:96-97`), plus `IN_PROGRESS` now implies every loadout is set (§1.2). |
| Client sends a forged class, weapon or stats over the WS | No such message exists; the sim reads loadouts only from the match document. |
| Client picks an invalid id | Pydantic `Literal` → 400; the game side re-validates with `loadout.valid` when merging, logs, and falls back to `DEFAULT_LOADOUT` (defence in depth; unreachable through the API). |
| Loadout written for someone else | The path key is the JWT `sub`; the filter requires `player_ids: uid`. |
| Field-path injection through `user_id` | `uid` is from the verified JWT and checked against `player_ids` before use. |
| Changing loadout after ready or during countdown | Conditional filter → 409 `LOADOUT_LOCKED`. |
| Ability or fire spam | Server cooldown timestamps; invalid messages dropped. [FACT] There is no per-socket message rate limit today; a flood costs CPU only. Out of scope; note it in the README limits. |
| `bot=1` query flag | [FACT] Any client can label itself a bot (`main.py:233-234`). Display only, pre-existing. Unchanged. |

### 6.2 Hidden-information leaks (in game)

| Leak vector | Mitigation |
|---|---|
| Broadcast snapshot carries invisible enemy x/y | Per-team snapshots (§3.5). Hidden player row keeps id/name/team/class/weapon/alive/hp/stats, with `x=y=null`, `dashing=false`, `carryingFlag=false`, `abilityReadyAt=null`. |
| Initial snapshot on connect (`main.py:238`) | Must use the viewer's team as well. Easy to miss: add an E2E assertion on the first frame. |
| Flag follows its carrier (`sim.py:223`) | Picking up the enemy flag reveals; activation is refused while carrying. A hidden player therefore never holds a flag. |
| Shots expose the shooter's position | Firing reveals (§7.5). The reveal happens in `fire()` before the shot is appended, so no snapshot holds a hidden player with a shot. |
| Damage numbers or HP change on a hidden enemy | Positive damage reveals in the same `_damage` call, so the next snapshot already has coordinates. |
| Enemy cooldowns | `abilityReadyAt = null` for enemies. |
| Lobby: enemy picks visible before the start (counter-picking) | `match_view` returns only own-team loadouts while `status ∈ {FOUND, COUNTDOWN}`, and all of them once `IN_PROGRESS` (Decision 2). Enemy `ready` indicators stay visible, as today. |
| `match_events` `LOADOUT_SELECTED` | Not exposed by any route; audit only. |
| End of match | `snapshot` treats `ended` as everyone visible, so the scoreboard and final frame show all players. |

Residual and accepted: an enemy can infer that "player X went invisible near here", because X vanishes from the last visible position. This is inherent to the mechanic.

### 6.3 `match_view` filter ([REC])

```python
mine = my_team index
show = m["status"] == "IN_PROGRESS" or m.get("result")
loadouts = {pid: {"class": l["class"], "weapon": l["weapon"]}
            for pid, l in m.get("loadouts", {}).items()
            if show or pid in {p["id"] for p in m["teams"][mine]["players"]}}
```

Factor this as a pure function `visible_loadouts(m, my_team)` so the stats-style self-check can cover it without Mongo.

### 6.4 Race conditions (game-service)

- Intents are applied in the WS reader between `step()` calls on one asyncio loop, and the sim methods never await, so each sim call is atomic. [FACT] `fire()` uses `now_ms()` at receipt (`main.py:249`); `ability()` does the same.
- A dash activated between ticks: integrate by **window overlap**, `d = max(0, min(now, dash_until) - max(self.last, dash_from))`. The dash distance is then exact and independent of tick jitter.
- A ready cooldown and death in the same tick: `ability()` checks `p.alive`; `_damage` ending a dash or invisibility is idempotent.
- Checkpoint during a dash: the dash is not persisted (like held keys, `sim.py:267`); the position is.
- Two snapshot views built in one tick from the same state, back to back with no await, so both teams see the same tick.

### 6.5 Backward compatibility

| Item | Risk | Handling |
|---|---|---|
| Lobby documents in `FOUND` at deploy | No `loadouts` / `lobby_ends_at` | `$or` timeout fallback; `ready` requires a loadout, which the new UI can set (`loadouts.<uid>` `$set` creates the map). |
| `IN_PROGRESS` matches / checkpoints at deploy | Players without class/weapon | `Game.__init__` and `restore` default to `DEFAULT_LOADOUT`; `hp = min(hp, max_hp)`. A **present but unknown** class or weapon in a checkpoint is corruption → `ValueError` → `ABANDONED` (existing policy, `main.py:110-116`). |
| Old results without class/weapon | History UI | Fields are optional in `PlayerResult`; stats aggregation does not read them. |
| Cached old frontend bundle | Cannot set a loadout → cannot ready | It times out cleanly. Ship frontend and backend together (single compose build); note in the README. |
| `x/y` nullable | `bot_ai`, `ctf_e2e` watcher, renderer, `Game.tsx` `events`/`hudOf` | All updated in this plan; grep every `p["x"]`, `p.x` and `.x -`. |
| `hp == 100` assumptions | `ctf_e2e.py:141`, HUD segments, renderer HP bar | Use `maxHp`. |
| `FIRE_COOLDOWN_MS`, `DAMAGE`, `HP` constants | sim self-check and bot_ai | Removed or replaced; update every reference (`grep -n "DAMAGE\|FIRE_COOLDOWN_MS\|\bHP\b"`). |
| `READY_TIMEOUT_S` 45 → 60 | `e2e.py` does not wait on it | Safe. |

---

## 7. Gameplay semantics

### 7.1 Projectile collision (rewrite of `_shots`)

Per shot per tick, segment `A → B` (`B = A + v·dt`). Find the **smallest `t ∈ [0,1]`** among:

1. **Walls and map bounds:** segment-vs-AABB slab test against each wall inflated by `SHOT_R`, and against the bounds inset by `SHOT_R`. Earliest entry `t`.
2. **Enemy barriers** (`b.team != shot.team`, `b.hp > 0`): the same slab test on the barrier rect inflated by `SHOT_R`.
3. **Enemy players** (`p.alive`, `p.team != shot.team`): ray-vs-circle with radius `PLAYER_R + SHOT_R`, first root in `[0,1]`; a start already inside the circle counts as `t = 0`. Hidden enemies **are** hit (they stay damageable).

Then resolve the earliest: wall → shot dies; barrier → `barrier.hp -= shot.damage`, shot dies, barrier removed at `hp <= 0`; player → `_damage(p, now, shot.owner, shot.damage)`, shot dies. Ties: wall/barrier before player (cover wins). TTL: drop when `now - born >= ttl` (checked before the sweep, as today). There is no friendly fire (unchanged). Own-team barriers do not block (Decision 5).

Two helpers, both pure and self-checked: `_seg_rect_t(ax, ay, bx, by, rect, pad) -> float | None` and `_seg_circle_t(ax, ay, bx, by, cx, cy, r) -> float | None`. This replaces the existing `_seg_dist2` use for shots and fixes both tunnelling and "hit through a wall corner" (§1.1).

### 7.2 Damage, death and respawn

- `_damage(p, now, by, amount)`: if `amount <= 0` return; `_reveal(p)`; `p.hp -= amount`; if `hp > 0` return. Death: as today (`hp = 0`, `alive = False`, `respawn_at = now + RESPAWN_MS`, `killed_by`, kill/death counters, flag drop at the death position), **plus** `invisible_until = None` and `dash_from = dash_until = None`.
- Respawn (`_spawn`): `hp = CLASS[pclass].hp`, visible, no dash. **Cooldowns are not reset** by death or respawn; `ability_ready_at` keeps running (it is wall clock). `last_fire` is kept.
- The Guardian's barrier **outlives the Guardian's death** and expires or breaks normally (Decision 5).
- Respawn time stays 3000 ms. No spawn protection (not requested).

### 7.3 Assaulter: dash

- Activation: alive, not ended, `now >= ability_ready_at`, not already dashing. Direction = normalised held keys; if no keys are held, the normalised aim vector; if both are zero, ignore and consume nothing.
- Sets `dash_from = now`, `dash_until = now + DASH_MS`, `ability_ready_at = now + DASH_CD_MS`.
- Movement in `_move`: during the overlap window, move at `DASH_SPEED` along `(dash_dx, dash_dy)`; for the remainder of `dt`, normal key movement. Sub-step every move in increments ≤ `PLAYER_R / 2` (7 px) with the existing axis-separated `_hits_wall` slide, so a dash cannot cross a 40 px wall. (Normal movement at 220 px/s already moves less than 7 px per tick.)
- **Damageable throughout** (the requirement): there are no i-frames, so `_shots` treats a dashing player like any other.
- Can fire during a dash and can carry the flag ([REC], playtest). The dash does not pass through other players (there is no player-player collision today) or through walls.

### 7.4 Guardian: barrier

- Activation: alive, not ended, ready. Aim vector `u` (zero → ignore, consume nothing). Snap to an axis: `|ux| >= |uy|` → vertical slab (`w = BARRIER_THICK`, `h = BARRIER_LEN`), else horizontal (`w = BARRIER_LEN`, `h = BARRIER_THICK`). Centre = player + `u·BARRIER_OFFSET`.
- Validity: the rect lies fully in bounds and does not overlap any wall. If not, retry with the offset stepped back 10 px down to `PLAYER_R + BARRIER_THICK/2`. If still invalid, ignore and consume nothing (no cooldown spent).
- Remove the owner's existing live barrier (cannot happen with the default numbers, since cooldown > lifetime; it is enforced anyway), append the new `Barrier(hp=BARRIER_HP, expires_at=now + BARRIER_MS)`, and set `ability_ready_at = now + BARRIER_CD_MS`.
- Blocks **enemy projectiles only**; does **not** block movement for anyone (Decision 5), so bot pathing and the player movement code are unchanged. Takes the projectile's full damage. Removed in `step` when `now >= expires_at` or `hp <= 0`.
- [REC] Axis-aligned rather than rotated: it reuses the wall collision and rendering code, and on this map's axis-aligned geometry it reads naturally.

### 7.5 Assassin: invisibility

- Activation (Decision 6): alive, not ended, ready, **not carrying a flag** (refused without consuming the cooldown). Sets `invisible_until = now + INVIS_MS` and `ability_ready_at = now + INVIS_CD_MS`. The cooldown counts from activation; an early reveal gives no refund.
- Ends immediately on (Decision 6): expiry (cleared in `step`), **any positive damage** (requirement), **firing** (`fire()` reveals before appending the shot), **picking up the enemy flag** (`_flags`), death, and match end.
- Unaffected by invisibility: movement speed, flag *return* by touching your own dropped flag (it still reveals nothing extra, since the flag simply goes home), and being hit.
- Viewer rules: §3.5. Allies and self see `invisible: true` and render at about 35 % opacity with a shimmer.

### 7.6 Weapons and fire

`fire(pid, ax, ay, now)`: `cd = WEAPON[w].cooldown * (ASSAULTER_FIRE_MULT if pclass == ASSAULTER else 1)`, rounded to an int. Reject if `now - last_fire < cd`. `_reveal(p)`. Base angle `θ` toward the aim point. Shotgun: `n` pellets at evenly spaced angles `θ + spread·(i/(n-1) - 0.5)`, **deterministic, no RNG**, so self-checks and E2E are reproducible. Each pellet is its own `Shot` with the weapon's damage, speed and TTL. Shots start at the player's centre, as today.

### 7.7 Checkpoint and restore

`checkpoint()` adds per player `class`, `weapon`, `abilityReadyAt`, `invisibleUntil`, and top-level `barriers: [{id, owner, team(TEAMS name), x, y, w, h, hp, expiresAt}]` plus `barrierSeq`.

`restore()`: player `class`/`weapon` are missing → default (legacy); present but invalid → `ValueError`. `hp = min(hp, max_hp)`. Cooldown and invisibility timestamps are restored as-is (wall clock, so after downtime they may already have elapsed; `step` clears them). Dash is never restored. Barriers are restored as-is; `restore` raises if a barrier's `team` disagrees with its owner's team or its owner is unknown. Shots are not restored (unchanged).

Round-trip property (extend the existing assertion at `sim.py:385`): `Game.restore(cp, t).checkpoint(saved_at) == cp`.

`result()` adds `class` and `weapon` per player, so they flow into `PLAYER_RESULT` event data and history. Stats aggregation is unchanged.

### 7.8 Per-viewer snapshot

`snapshot(now, connected, bots, viewer_team: int | None = None)`. `None` gives the full, unfiltered view (self-checks and `bot_ai` self-play). In `run()`: `views = {team: g.snapshot(t, keys, bots, team) for team in (0, 1)}`; send `views[g.players[uid].team]` to each socket.

---

## 8. Frontend

- **Lobby (`Matchmaking.tsx`)** replaces `Found`:
  - A "MATCH FOUND" reveal (about 2 s) plays the first time the client sees a new `match_id`, then gives way to the lobby.
  - Two rows of cards: Class (avatar, name, HP, Q description) and Weapon (name, role).
  - The team panel shows each ally's avatar and pick (from `match.loadouts`) and READY ticks. The enemy panel shows names and READY ticks only, until the start.
  - The deadline comes from `lobby_ends_at`.
  - READY is disabled until `match.loadouts[me.id]` exists; after READY the cards lock.
  - "Decline" is unchanged (`leave`).
  - Error codes `LOADOUT_LOCKED`/`LOADOUT_REQUIRED` show in the existing toast.
- **Avatars (`game/classes.ts`)**: one `drawAvatar(ctx, cls, teamColors, r)` used by both the canvas and the lobby. Silhouettes keep the team colour as the body fill, so teams still read first:
  - Assaulter: slim body, forward chevron visor, twin back thrusters.
  - Guardian: larger squared, hex-shouldered body with a front shield plate.
  - Assassin: hooded teardrop body with a narrow slit visor.

  Add a small class glyph next to the name label. Weapon visuals by barrel: rifle medium; shotgun short and wide; sniper long and thin with a muzzle line.
- **`render.ts`**:
  - Skip players with `x === null`.
  - Snap rather than interpolate when `hidden` flips (`q.hidden !== p.hidden` or either `x` is null). A dash moves about 32 px per tick, so it interpolates normally under the existing `> 80` px teleport rule.
  - Translucent self and allies when `invisible`; dash streak when `dashing`.
  - Barriers as team-tinted slabs with an HP bar and a fade near `expiresAt`.
  - Pellet and sniper tracer styles from `shot.w`.
  - Enemy HP bar shown when `hp < maxHp`.
- **`Game.tsx`**:
  - `viewSnap` mirrors barriers (`x → w - x - bw`) and skips null `x`.
  - `KeyQ` keydown → `send({t: 'ability', ...mirroredAim})`, using the current cursor world position, tracked on every mousemove even when not firing.
  - Autofire: replace the fixed 100 ms gate with `cooldownMs(weapon, class)` from `hello.catalog`, and the 50 ms interval with `requestAnimationFrame` or 16 ms. The server stays authoritative; this only removes the quantisation found in §1.1.
  - HUD: weapon name, Q chip with a cooldown ring (`abilityReadyAt` vs `renderTime()`), active-effect timer; HP segments scale with `maxHp` (e.g. one segment per 25 HP).
  - `hudOf` roster pips still list hidden enemies (the alive state is public).
  - `events()`: guard hit/death effects against null coordinates (use the last known position, or skip the effect).

---

## 9. Initial balance values

Baseline today: 100 HP, 25 dmg, 500 ms cooldown (50 DPS, 4 hits, TTK about 1.5 s), shot 650 px/s with 1.5 s TTL, map 1200×700, speed 220 px/s.

| Classes | HP | Q | Duration | Cooldown | Other | Playtest? |
|---|---|---|---|---|---|---|
| Assaulter | **85** | Dash | 160 ms | **5 000 ms** | 160 px total (1 000 px/s); fire cooldown ×**0.8** | dash distance and cooldown: **yes** |
| Guardian | **140** | Barrier | **8 000 ms** | **14 000 ms** | 90 × 12 px, **150 HP**, offset 40 px | barrier HP, length, cooldown: **yes** |
| Assassin | **100** | Invisibility | **5 000 ms** | **15 000 ms** | reveal on damage/fire/flag pickup | duration, cooldown, HP: **yes, highest risk** |

| Weapons | Damage | Pellets | Cooldown | Speed | TTL → range | Notes | Playtest? |
|---|---|---|---|---|---|---|---|
| Assault Rifle | **14** | 1 | **160 ms** | 700 px/s | 1 100 ms → ~770 px | 87.5 DPS | moderate |
| Shotgun | **9** | **7**, fan 0.36 rad | **850 ms** | 650 px/s | 420 ms → ~270 px | 63 per full volley | spread and range: **yes** |
| Sniper Rifle | **70** | 1 | **1 500 ms** | 1 600 px/s | 900 ms → ~1 440 px | never one-shots any class | damage vs Assaulter 85: **yes** |

Derived hits-to-kill (TTK at the base cooldown):

| Weapon | Assaulter 85 HP | Assassin 100 HP | Guardian 140 HP |
|---|---|---|---|
| AR | 7 hits (0.96 s) | 8 hits (1.12 s) | 10 hits (1.44 s) |
| Shotgun, full volley | 2 volleys (0.85 s) | 2 volleys (0.85 s) | 3 volleys (1.70 s) |
| Sniper | 2 hits (1.5 s) | 2 hits (1.5 s) | 2 hits (1.5 s) |

An Assaulter wielder's cooldown is 0.8×: AR 128 ms, shotgun 680 ms, sniper 1 200 ms. These are close to the old 1.5 s TTK while giving each weapon a distinct range band.

Values that most need playtesting:

1. Invisibility uptime (33 %) combined with flag play.
2. Sniper 70 damage paired with a 1 200 ms Assaulter cooldown.
3. Barrier denial at choke points (the `540..660 × 240..460` centre block lanes).
4. Shotgun range on a 1200 px map.
5. Dash + flag-carry escapes.

All numbers live in one table in `sim.py` and are surfaced through `catalog`; nothing is hard-coded on the client.

---

## 10. Tests

### 10.1 Unit (self-checks; `python -m app.sim`, `python -m warcis_common.loadout`, `python -m app.services.stats`, `python scripts/bot_ai.py`)

`sim.py`:

1. Every class spawns at its own max HP; respawn restores class max HP.
2. Weapon cooldowns are enforced per weapon, and the Assaulter multiplier applies (`fire` at `cd-1` rejected, at `cd` accepted).
3. A shotgun produces exactly `n` deterministic pellets with the expected angles; point-blank all hit, for `n × 9`.
4. The sniper does not tunnel: a shot fired at a target directly behind the 40 px wall `(230,140,40,140)` dies at the wall, with dt values of 33 ms and 100 ms.
5. Earliest hit along the path: two enemies on the line, the nearer is damaged regardless of dict order.
6. Wall before player: a target just behind a wall corner within one tick's segment is not hit.
7. Barrier blocks an enemy shot and takes damage; an own-team shot passes; the barrier breaks at 0 HP; it expires at `expires_at`; players of both teams walk through it unimpeded (no movement collision); an AR shot at 33 ms dt never tunnels the 12 px slab.
8. Barrier placement into a wall steps back or is rejected without consuming the cooldown; a barrier never overlaps a wall.
9. Dash moves `160 ± 2` px in open space independent of tick size (one step of 500 ms vs steps of 10 ms); it stops at walls without crossing them; the player is damageable mid-dash; the cooldown is enforced.
10. Invisibility: the enemy-view snapshot has `x is None`, `hidden`, `abilityReadyAt is None`; the ally view has coordinates and `invisible`; a full view (`viewer_team=None`) has coordinates. Revealed by 1 damage; **not** revealed by 0-damage calls; revealed by `fire` (no snapshot ever contains a hidden player plus their shot); revealed by enemy-flag pickup; cannot activate while carrying; expiry reveals.
11. Death clears dash and invisibility, keeps the cooldown, and the dead Guardian's barrier stays, still blocks enemy shots, and expires or breaks normally.
12. Checkpoint round-trip with an active barrier, active invisibility and pending cooldowns: `restore(cp).checkpoint(saved) == cp`. A legacy checkpoint without class/weapon/barriers restores with defaults and clamps HP; an unknown class raises `ValueError`; a barrier with a mismatched team raises `ValueError`.
13. `result()` includes class and weapon.
14. Ended game: all views unhidden.

Other self-checks:

- `loadout.py`: `valid` accepts all 9 combos and rejects unknown/missing keys and wrong types.
- `stats.py`: `history_item` passes `class` through; `visible_loadouts` filters by status.
- `bot_ai.py`: self-play in 1v1/2v2/4v4 with **mixed loadouts** (cycle all 9) still finishes; bots use Q at least once per class; no crash with hidden enemies.

### 10.2 Integration (`scripts/e2e.py`, stack running)

- Fresh match: `ready` without a loadout → 409 `LOADOUT_REQUIRED`.
- Invalid class → 400 `INVALID_REQUEST`; an outsider's `PUT loadout` → 404 `MATCH_NOT_FOUND`.
- `PUT` then change it again → the last write wins and is visible in an ally's status; an **enemy's** status does not contain it.
- `ready` → a further `PUT` → 409 `LOADOUT_LOCKED`.
- All ready → `countdown`; `PUT` → 409 `LOADOUT_LOCKED`; `entered`; now the enemy sees all loadouts.
- Lobby timeout: run with `READY_TIMEOUT_S` lowered (e.g. 5 s via `.env`); one player never selects → `idle` with the lobby notice and `reason == lobby_timeout`. If changing the env var in the shared stack is undesirable, gate this case behind an env flag in the script.
- A player may `PUT` several different loadouts before readying; the last one is the one the game uses.
- Duplicate classes and weapons on one team (all four allies the same) are accepted and the match starts; no composition error exists.
- During `COUNTDOWN`, an enemy's status still lacks the loadouts (they appear only at `IN_PROGRESS`), while enemy `ready` flags are visible throughout.
- After a lobby timeout, nobody is auto-assigned a loadout, no match enters `IN_PROGRESS`, and no one is re-queued (status is `idle`, not `searching`).
- Existing checks keep passing (the ready loop now sets a loadout first).

### 10.3 Multiplayer E2E (`scripts/ctf_e2e.py`)

- `form_match(n, loadouts=...)` sets loadouts before ready; the existing 1v1/2v2/4v4 scenarios still pass, with `hp == maxHp` per class replacing `hp == 100`.
- New `python scripts/ctf_e2e.py abilities` (2v2):
  - **First frame per socket is team-filtered**: after RED-Assassin activates and a BLUE client then connects, the BLUE `hello` + first `state` already have `x: null`.
  - Invisibility: the RED ally socket sees coordinates; both BLUE sockets see `null`; a BLUE shot that hits it → both BLUE sockets see coordinates within 2 ticks.
  - Barrier: RED-Guardian deploys between itself and BLUE; BLUE fires sniper rounds; the Guardian's HP is unchanged and the barrier HP falls by 70 per hit; the barrier disappears on breaking.
  - Dash: Assaulter x increases by about 160 px within 300 ms; a BLUE shot landing mid-dash reduces HP.
  - Lobby bypass: opening the WS while the match is `FOUND` → `error` `MATCH_NOT_STARTED`.
- `run_bots`: tolerate `x: null` in the shot-attribution heuristic; assert bots used at least 2 distinct classes.

### 10.4 Recovery (`ctf_e2e.py recovery`, plus `CTF_CRASH=1`)

Before the restart, have an active barrier with known HP, an Assassin invisible with more than 6 s remaining (raise duration via a test-only path, or chain activation right before the 3.5 s wait; otherwise assert the cooldown instead) and a Guardian on cooldown. After the restart assert: same barrier id, HP and `expiresAt`; the same `abilityReadyAt`; class and weapon preserved; enemy-view hidden state consistent with `invisibleUntil` vs the server clock; the match continues to capture. Also restore a checkpoint written by the pre-feature code (craft one in the sim self-check, item 12).

---

## 11. Ordered implementation plan (dependency-aware)

Each step ends with its listed checks green. Commit per step.

1. **Shared catalog**: `services/common/warcis_common/loadout.py` + self-check. *Depends on nothing.*
2. **Sim core, no abilities yet**:
   - class and weapon tables; `Player`/`Shot` fields; per-class HP; weapon-driven `fire`;
   - swept `_shots` with the two helpers; `_damage(amount)`; `result()` fields;
   - checkpoint/restore of class and weapon with legacy defaults;
   - update every `HP`/`DAMAGE`/`FIRE_COOLDOWN_MS` reference in the self-check.

   *Check:* `python -m app.sim` (items 1-6, 12 partial, 13). Fix `bot_ai.py` self-check constants so it still passes.
3. **Sim abilities**: dash (with sub-stepping), barrier, invisibility, reveal rules, death interactions, per-viewer `snapshot`, barrier/ability checkpointing. *Check:* items 7-14. *Depends on 2.*
4. **Game-service wiring** (`main.py`): merge loadouts in `open_room`; `ability` message; per-team views in `run` **and** in the initial send in `play`; `catalog` in `hello`; docstring. *Depends on 3.* *Check:* boot the service; `ctf_e2e.py 1` still passes with default loadouts (matches without `loadouts` → defaults).
5. **Matchmaking lobby**: schema, route, `set_loadout`, `ready` guard, `_create_match` fields, `visible_loadouts` + `match_view`, `tick` timeout + reason, `status` notice, `READY_TIMEOUT` default and compose. *Depends on 1.* It can be built in parallel with 2-4, but merge after 4 so the game side already accepts loadouts.
6. **Scripts**: `e2e.py` lobby checks; `bots.py` loadout before ready; `bot_ai.py` per-weapon gaps and ranges, Q usage, `x is None`. *Depends on 4 and 5.* *Check:* `e2e.py`, `bot_ai.py`, `ctf_e2e.py 1 2 4`.
7. **Frontend**: `api.ts` types → `classes.ts` avatars → `Lobby` in `Matchmaking.tsx` + `App.tsx` handler → `render.ts` (null coordinates, avatars, barriers, shots, invisibility, dash snap) → `Game.tsx` (mirroring, Q, autofire gate, HUD) → `hud.css` → optional class icons in `Scoreboard`/`Profile`. *Depends on 4 and 5.* *Check:* `npm run build`, `npm run lint`, then a manual 1-human + 7-bots match in the browser covering all 3 classes and weapons.
8. **New E2E scenarios**: `ctf_e2e.py abilities`, extended `recovery`, `run_bots` tolerance. *Depends on 6 and 7* (7 only for a manual cross-check).
9. **README**: gameplay rules, protocol, API table (fix the stale `/enter`), Mongo fields, balance table, known limits (no WS rate limit; cached-bundle note). *Last.*

---

## 12. Acceptance criteria

1. A client cannot reach `IN_PROGRESS` or open a live game socket without every player in the match having a server-stored, valid loadout and having readied. Verified by `e2e.py` (409s) and `ctf_e2e.py abilities` (WS refused in `FOUND`).
2. Loadouts are freely changeable until the player readies; they are immutable after the player readies and after the lobby leaves `FOUND`; any attempt then returns 409 `LOADOUT_LOCKED`. There is no un-ready.
3. A lobby not completed by `lobby_ends_at` is `CANCELLED` as a whole with `reason: lobby_timeout`; no defaults are assigned and nobody is re-queued; every member sees `idle` with a notice within one poll.
4. During `FOUND` and `COUNTDOWN`, `GET /matchmaking/status` shows the caller's own team's loadouts and no enemy loadouts (enemy `ready` flags stay visible); both teams' loadouts appear from `IN_PROGRESS`.
5. In game, each class spawns and respawns at its HP (85/140/100); each weapon's damage, cooldown, pellets and range match §9 within one tick; the Assaulter fires 25 % faster.
6. Dash moves about 160 px, never crosses walls, and the dashing player takes damage.
7. A barrier stops every enemy projectile type (including sniper rounds at 100 ms tick gaps), passes own-team shots, never blocks any player's movement, takes damage, breaks at 0 HP, expires on time, and persists after its owner dies.
8. While invisible, an Assassin's coordinates **never** appear in any frame sent to an enemy socket, including the first frame after connect. Any positive damage, firing or enemy-flag pickup reveals them in the next frame; activation is refused while carrying a flag; allies always see them.
9. Every class is visually distinguishable on the canvas and in the lobby, for allies and (when visible) enemies.
10. A game-service restart (graceful or SIGKILL) preserves class, weapon, HP, cooldowns, invisibility timers and barriers from the last checkpoint. Legacy checkpoints restore with defaults; corrupt ones become `ABANDONED`.
11. Results, history and career stats are unchanged in shape apart from optional `class`/`weapon` per player; old history rows still render.
12. Any combination of classes and weapons is accepted on a team, including duplicates.
13. All existing checks still pass: `sim ok`, `packing ok`, `stats ok`, `bot_ai ok`, `e2e.py`, `ctf_e2e.py 1 2 4 recovery bots`. The bots still fill a 4v4 and finish the match.

---

## 13. Decisions (all approved)

**Decision status: all seven decisions below have been approved by the user and are authoritative requirements, not open questions.** The reasoning is kept for the implementer.

What is *not* decided by the user and stays open: balance numbers and gameplay-feel values in §9 (to be tuned by playtesting), and the [REC] implementation choices (for example axis-aligned barriers, deterministic shotgun spread, a 60 s lobby deadline, dash-while-firing and dash-while-carrying being allowed). Those are engineering defaults that may be adjusted if testing shows a problem. No user decision is outstanding.

1. **"Match Found" is a client-side visual reveal only.** It is not a server-enforced accept step. The existing `FOUND` state becomes the match lobby. A real accept step would have added a status, a second timeout and a second cancellation path.
2. **Enemy loadouts are hidden during the lobby.** In `FOUND` and `COUNTDOWN` players see their own team's class and weapon selections, not the enemy's; enemy readiness indicators stay visible. Both teams' loadouts become visible when the match starts (`IN_PROGRESS`). This avoids counter-picking.
3. **Readying locks the loadout.** Players change class and weapon freely until they ready. There is no un-ready and no change afterwards. Un-ready would have needed a new endpoint and reopened the COUNTDOWN race.
4. **A lobby timeout cancels the entire match.** No defaults are assigned to players who did not select, and the match is not partially re-queued. This is today's semantics; the alternatives would have changed the queue lifecycle.
5. **Guardian barrier.** It blocks enemy projectiles only, does not block player movement, survives its owner's death, stays destructible and expires after its configured lifetime. Blocking movement would have let a Guardian seal the flag stand or a corridor and required bot pathing changes.
6. **Assassin invisibility.** It ends immediately on any positive damage, on firing a weapon, or on picking up the enemy flag, and cannot be activated while carrying a flag. Without "firing reveals", a hidden shooter's shots would either leak its position or be unfair.
7. **No team composition restrictions.** Duplicate classes and weapons are permitted on the same team.
