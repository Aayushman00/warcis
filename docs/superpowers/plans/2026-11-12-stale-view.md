# Stale View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `STALE` game mode: each team sees enemies (and enemy bullets) as they were some ms ago. The lag rises when the team is hurt and drains over time. Rising lag *freezes* the enemy picture like a real network stall; draining plays it back fast until caught up. Spike/Sync pickups stall the enemy's view or resync your own.

**Architecture:** `Game.snapshot(viewer_team=…)` already filters per team (cloak), and `main.py:75` already builds one snapshot per team. Add a per-tick position history, a per-team target `lag_ms`, and a per-team **view clock** `view_t` that never moves backward: `view_t[t] = max(view_t[t], now - lag_ms[t])`. Enemy player `x/y` come from history at `view_t[viewer]`; enemy shots are back-projected along their straight path to `view_t`. Hits, damage, pickups and scoring use true positions. `STALE` reuses TDM scoring (kills to win).

**Tech Stack:** Python sim (`services/game-service/app/sim.py`, self-checking via `python -m app.sim`), FastAPI matchmaking, React 19 + canvas client.

**Spec:** none; pitch in chat. Values below were checked by replaying hits from bots-only TDM matches (see "Tuning evidence").

## Design calls

- New mode `STALE` = TDM rules (first to `KILLS_TO_WIN`, sudden death, tiebreak) plus the lag mechanic. Not a modifier on CTF/KOTH.
- **View clock, not rewind.** When lag rises, `view_t` holds still, so enemies freeze in place (a lag spike) instead of jumping backward. When lag drains, `view_t` advances faster than real time, so enemies play back at ~1.3× until caught up. The picture never runs backward, which also keeps the client's 100 ms interpolation (`render.ts` `INTERP_MS`) smooth.
- **Enemy shots are stale too.** A live bullet reveals the shooter's true spot, and the rifle fires every ~128 ms, so live shots would cancel the mechanic. An enemy shot is sent only once `s.born <= view_t[viewer]`, at `s.x - s.vx * (now - view_t) / 1000` (shots fly straight, so this is exact). Collisions stay live: you can be hit by a bullet you cannot see yet.
- Enemy `hp`, `alive`, `kills` stay live. A **dead** enemy is shown at its live position (the kill confirms where they really were). History stores `None` for dead **and** invisible players, so a respawned enemy is `hidden` until history catches up (no ghost walking around the death spot) and an ended cloak never reveals where they hid.
- Lag rises on damage to a teammate: `min(LAG_HIT_MAX_MS, amount * LAG_PER_HP_MS // team_size)`, total capped at `LAG_MAX_MS`. Divided by team size because team damage grows with headcount (bots: ~9 dmg/s per team in 1v1, ~49 in 4v4). The per-hit cap stops one sniper hit maxing the meter in 1v1.
- Drain `LAG_DRAIN_MS_PER_S`; the team behind on score drains ×`TRAIL_DRAIN_MULT` (catch-up rule against the hurt → blind → hurt-more spiral).
- **Spike** (pickup): enemy team `lag_ms += SPIKE_MS`, allowed past `LAG_MAX_MS` up to `LAG_CEIL_MS`. Through the view clock this is a freeze of their view; a second Spike extends it, bounded by the ceiling. No separate freeze state.
- **Sync** (pickup): picker's team `lag_ms = 0`; `view_t` snaps to `now` (resync).
- Pickups: 2 Spike (contested, centre top/bottom) + 2 Sync (one per half), touch radius `TOUCH`, respawn per kind, inactive during intro and after the match ends.
- Both teams' `lag` and `behind` (`now - view_t`) go to both teams. Client shows a stall while `behind < lag`, catch-up while `behind > lag`.
- Accepted live leaks: enemy barriers, emotes (drawn on the ghost, only their timing is live), killfeed. Revisit after playtest.

## Tunables (top of `sim.py`)

| Constant | Value | Effect |
|---|---|---|
| `LAG_PER_HP_MS` | 20 | ms per HP taken, divided by team size |
| `LAG_HIT_MAX_MS` | 600 | most one hit can add |
| `LAG_MAX_MS` | 1200 | damage cap (~260 px of enemy drift at `SPEED` 220) |
| `LAG_DRAIN_MS_PER_S` | 300 | drain; playback runs at 1.3× while catching up |
| `TRAIL_DRAIN_MULT` | 1.5 | drain multiplier for the team behind on score |
| `SPIKE_MS` | 1000 | added to the enemy team's lag by a Spike |
| `LAG_CEIL_MS` | 2000 | hard ceiling, reachable only through Spike |
| `HIST_MS` | `LAG_CEIL_MS + 200` | history kept |
| `PICKUP_RESPAWN_MS` | `{"SPIKE": 25_000, "SYNC": 12_000}` | Spike is stronger, so rarer |
| `PICKUPS` | Spike `(600, 110)`, `(600, 590)`; Sync `(340, 350)`, `(860, 350)` | mirrored left/right |

## Tuning evidence

Hits from bots-only TDM matches replayed through each rule set (lag in ms: mean / p90 / share of time at 0):

| Rules | 1v1 | 2v2 | 4v4 |
|---|---|---|---|
| Old: 10 per HP, cap 2000, drain 250 | 160 / 618 / 65% | 701 / 1380 / 15% | **1565 / 1967 / 6%** (pinned at cap) |
| This plan: 20 ÷ team size, cap 1200, drain 300 | 262 / 962 / 59% | 364 / 913 / 32% | 342 / 783 / 22% |

Target band for playtest: mean 250–500, p90 800–1100, at-zero 20–60% at every team size. Bots aim worse than people, so Task 9 re-measures with the real mode and prints these numbers.

## Global Constraints

- All tunables in the constants block at the top of `sim.py`, named as above.
- Sim stays pure; tests are asserts in the `__main__` block of `sim.py` using the existing `new/run/put/lo` helpers. No test framework.
- An invisible (cloaked) enemy never yields coordinates, stale or live.
- Snapshot for `viewer_team=None` stays unfiltered and live (players and shots).
- Lag rise, drain and view clock are integer and tick-size independent (same pattern as HP regen in `step()`).
- No Claude co-author lines in commits.

## Review Focus

- View clock never decreases, including across Sync, Spike and `restore`.
- History lookup older than history (match start, after `restore`): clamp to oldest entry, or live position if history is empty. Never raise.
- Respawned enemy: hidden until history has them alive; never a ghost at the death spot.
- Cloak that just ended: history `None` keeps the hiding spot hidden.
- Enemy shot not yet visible (`born > view_t`) is not in the snapshot at all, not even its id.
- `viewer_team=None`: live rows and live shots.
- Both teams touch pickups on the same tick; Spike past the ceiling clamps to `LAG_CEIL_MS`.
- Pickups never trigger during intro or after `ended`.

---

### Task 1: STALE mode accepted by the sim, scored like TDM

**Files:**
- Modify: `services/game-service/app/sim.py` (`MODES`, `TARGET`, the TDM check at `_damage` ~line 492, `new()` test helper)

**Interfaces:**
- Produces: `MODES = ("CTF", "TDM", "KOTH", "STALE")`; `TARGET["STALE"] = KILLS_TO_WIN`; `Game.kills_mode -> bool` property (True for TDM and STALE); test helper `new(n=1, red=None, blue=None, mode="CTF")`.

- [ ] **Step 1: Failing test** in the `__main__` block: `g = new(mode="STALE")`; one kill by `r0` on `b0` gives `g.scores == [1, 0]`; `g.snapshot(0)["flags"] == []`; `g.snapshot(0)["target"] == KILLS_TO_WIN`; `g.snapshot(0)["hill"] is None`.
- [ ] **Step 2: Run** `cd services/game-service && python -m app.sim` → FAIL (unknown mode).
- [ ] **Step 3: Implement.** `grep -n '"TDM"' app/sim.py`; replace the scoring check with `self.kills_mode`. Flag/hill gating stays keyed on `CTF`/`KOTH`.
- [ ] **Step 4: Run** → PASS, all existing asserts still pass.
- [ ] **Step 5: Commit** `feat(sim): add STALE mode scored like TDM`

### Task 2: History, view clock and stale enemy rows

**Files:**
- Modify: `services/game-service/app/sim.py` (constants, `Game.__init__`, `step`, `snapshot.row`)

**Interfaces:**
- Consumes: Task 1.
- Produces: constants `LAG_MAX_MS`, `LAG_CEIL_MS`, `HIST_MS`; `Game.lag_ms: list[int]` (index = viewing team; target ms behind; starts `[0, 0]`); `Game.view_t: list[int]` (starts `[started, started]`); `Game.hist: deque[tuple[int, dict[str, tuple[float, float] | None]]]`; `Game._record(now) -> None` (`None` for dead or invisible players; drop entries older than `now - HIST_MS`); `Game._clock(now) -> None` (`view_t[t] = max(view_t[t], now - lag_ms[t])`); `Game._seen(viewer: int, p: Player) -> tuple[float, float] | None`.

- [ ] **Step 1: Failing tests.**
  (a) STALE, `r0` walks right, BLUE `lag_ms[1] = 500` set from the start: at t=2000 BLUE sees `r0` where it was at t=1500; `viewer_team=0` and `None` see live.
  (b) **Stall, not rewind:** lag 0 until t=2000, then `lag_ms[1] = 600`: BLUE's `r0.x` at t=2000…2600 is constant (frozen), then advances again; it is never less than any earlier value.
  (c) Cloak: `r0` ASSASSIN invisible t=1000–2000, BLUE lag 1500: at t=2500 BLUE row has `hidden` true and `x is None`.
  (d) Respawn: `r0` dies at t=1000 and respawns at t=4000, BLUE lag 1000: at t=4500 BLUE row is `hidden`; at t=5100 it shows the spawn-side position.
  (e) Dead enemy row `x` equals live `p.x`.
  (f) `lag_ms[1] = 2000` at t=100: row uses oldest entry or live, no exception.
  (g) In CTF, `lag_ms` is ignored even if set.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `step()`, after movement and only when `mode == "STALE"` and past intro: `_clock(now)` then `_record(now)`. In `row()`: if `mode == "STALE"`, `viewer_team is not None`, `p.team != viewer_team`, `p.alive`, not invisible → `_seen(viewer_team, p)`; `None` → `hidden` (reuse the existing hidden path so no coordinates leak). Lookup: newest entry with `t <= view_t[viewer]`, clamp to oldest, live if history empty.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): STALE view clock and history-backed enemy rows`

### Task 3: Lag rises on damage, drains over time

**Files:**
- Modify: `services/game-service/app/sim.py` (constants, `_damage`, `step`, `snapshot` top level)

**Interfaces:**
- Produces: `LAG_PER_HP_MS`, `LAG_HIT_MAX_MS`, `LAG_DRAIN_MS_PER_S`, `TRAIL_DRAIN_MULT`; snapshot keys `"lag": {"RED": int, "BLUE": int}` (target) and `"behind": {"RED": int, "BLUE": int}` (`now - view_t`). Both zero outside STALE.

- [ ] **Step 1: Failing tests.**
  1v1: 14 damage to BLUE → `lag_ms[1] == 280`, RED unchanged; 70 damage → +600 (hit cap).
  2v2: 14 damage → +140.
  Many hits cap at `LAG_MAX_MS`; a value above it (set by a Spike) is not lowered by a hit.
  Drain: from 900, 1 s later → 600; from 900 with BLUE behind on score → 450; never below 0.
  Tick-size independence: `run(..., dt=33)` vs `dt=100` end equal.
  `behind` grows at 1 ms per ms while stalled and shrinks at drain rate while catching up.
  CTF damage leaves `lag_ms == [0, 0]`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `_damage`, STALE only: `n = sum(q.team == p.team for q in self.players.values())`; `add = min(LAG_HIT_MAX_MS, amount * LAG_PER_HP_MS // n)`; `lag = max(lag, min(LAG_MAX_MS, lag + add))`. Drain in `step()` before `_clock`, integer and tick-size independent: `now * rate // 1000 - t0 * rate // 1000`, rate multiplied by `TRAIL_DRAIN_MULT` for the trailing team. Skip while intro is running.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): STALE lag rises on damage and drains`

### Task 4: Stale enemy shots

**Files:**
- Modify: `services/game-service/app/sim.py` (`snapshot` `"shots"`)

**Interfaces:**
- Consumes: Task 2. No new keys; the `shots` list is filtered per viewer.

- [ ] **Step 1: Failing tests.** STALE, BLUE lag 500 reached (view clock caught up), `r0` fires at t: BLUE snapshot at t+200 has no row with that shot id; at t+600 it has the shot at `born_x + vx * 0.1` (within 0.1 px). Own shots and `viewer_team=None` are live. A shot that hit a BLUE player before becoming visible never appears. CTF shots unchanged.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** For `mode == "STALE"`, `viewer_team is not None`, `s.team != viewer_team`: skip if `s.born > view_t[viewer]`, else send `x - vx * (now - view_t) / 1000` (same for `y`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): enemy shots follow the STALE view clock`

### Task 5: Spike and Sync pickups

**Files:**
- Modify: `services/game-service/app/sim.py` (new `Pickup` dataclass, `PICKUPS`, `PICKUP_RESPAWN_MS`, `SPIKE_MS`, `Game.pickups`, `Game._pickups(now)`, `step`, `snapshot`, startup asserts)

**Interfaces:**
- Produces: `@dataclass Pickup(id: int, kind: str, x: float, y: float, ready_at: int = 0)`, `kind in ("SPIKE", "SYNC")`; `PICKUPS: tuple[tuple[str, float, float], ...]` (table above); snapshot key `"pickups": [{"id", "kind", "x", "y", "readyAt"}]` (empty outside STALE).

- [ ] **Step 1: Failing tests.**
  Sync: BLUE player on a Sync with `lag_ms[1] = 900` → `lag_ms[1] == 0`, `view_t[1] == now`, `ready_at == now + PICKUP_RESPAWN_MS["SYNC"]`, not re-triggerable before then.
  Spike: BLUE player on a Spike with `lag_ms[0] = 0` → `lag_ms[0] == SPIKE_MS`; RED's view of BLUE is frozen for `SPIKE_MS`, then plays back. Spike with `lag_ms[0] = 1500` → `LAG_CEIL_MS`.
  Dead player does not collect. No collection during intro or when `g.ended`. Both teams on separate pickups in the same tick both apply.
  Startup: `assert not _hits_wall(x, y, TOUCH)` for every pickup point.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `_pickups(now)` in `step()` after movement and before `_clock`, STALE only.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): Spike and Sync pickups for STALE`

### Task 6: Checkpoint and restore

**Files:**
- Modify: `services/game-service/app/sim.py` (`checkpoint`, `restore`)

**Interfaces:**
- Consumes: Tasks 2–5. Checkpoint keys `"lagMs": [int, int]`, `"pickups": [{"id", "readyAt"}]`. Older checkpoints lacking them restore with defaults. History and `view_t` are **not** persisted; `restore` sets `view_t[t] = now - lag_ms[t]` (no stall, no rewind) and history refills from live.

- [ ] **Step 1: Failing test.** STALE game with lag and a used pickup → `Game.restore(g.checkpoint(t), t)` gives equal `lag_ms` and pickup `ready_at`; a CTF checkpoint without the keys restores; restored snapshot does not raise with empty history.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both directions; `restore` rebuilds `Pickup`s from `PICKUPS` ids, then applies saved `readyAt`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): checkpoint STALE lag and pickups`

### Task 7: Mode wiring across services, bots and client types

**Files:**
- Modify: `services/matchmaking-service/app/services/queue.py:370` (mode loop) and every other mode list from `grep -rn '"TDM"' services/ scripts/`; `services/common/warcis_common/` if modes are enumerated there; `scripts/bot_ai.py:143` (`s.get("mode") in ("TDM", "STALE")`, otherwise STALE bots run CTF logic); `frontend/src/api.ts:151` (`GameMode`); `frontend/src/data.ts:20` (mode card `{ id: 'stale', name: 'Stale View', short: 'STALE', blurb: 'You see enemies as they were moments ago. Getting hurt freezes your view. Grab Sync, Spike theirs.' }` and `modeLabel`); `frontend/src/Hub.tsx:400` (`TDM || KOTH || STALE` hides captures); `frontend/src/Game.tsx:318` (`tdm` flag covers STALE).
- `services/game-service/app/main.py` reads `m["mode"] in MODES`, so no edit once `MODES` has `STALE`.

**Interfaces:**
- Consumes: Task 1. Produces: `STALE` selectable in the lobby, queueable, carried on the match document.

- [ ] **Step 1: Failing check.** Extend `scripts/ctf_e2e.py` with a 1v1 STALE match modelled on the TDM block at `scripts/ctf_e2e.py:669`: assert `st["mode"] == "STALE"`, `st["target"] == 40`, `st["flags"] == []`, `st["lag"] == {"RED": 0, "BLUE": 0}`, `len(st["pickups"]) == 4`.
- [ ] **Step 2: Run** `docker compose up --build -d` then the e2e script → FAIL.
- [ ] **Step 3: Implement** the edits above; `npx tsc --noEmit` in `frontend/` passes.
- [ ] **Step 4: Run** e2e → PASS; `cd frontend && npm run build` clean; `python scripts/bot_ai.py` still passes.
- [ ] **Step 5: Commit** `feat: STALE mode queueable end to end`

### Task 8: Client HUD, pickups and the stall look

**Files:**
- Modify: `frontend/src/game/render.ts` (`Snapshot` gains `lag`, `behind`, `pickups`; draw pickups; enemy look), `frontend/src/Game.tsx` (lag meters), `frontend/src/game/hud.css`, `frontend/src/game-sandbox.tsx` (`?mode=stale` with scripted lag/pickups).

**Interfaces:**
- Consumes: snapshot keys from Tasks 3 and 5. Types: `GPickup = { id: number; kind: 'SPIKE' | 'SYNC'; x: number; y: number; readyAt: number }`; `Snapshot.lag?: Record<Team, number>`, `Snapshot.behind?: Record<Team, number>`, `Snapshot.pickups?: GPickup[]`.

- [ ] **Step 1:** Types plus a sandbox scenario (`?mode=stale`) cycling lag 0 → 700 (stall) → drain (catch-up) → Spike, so every state is visible in `npm run dev`.
- [ ] **Step 2:** Render pickups (distinct glyph/colour per kind; dimmed with a countdown ring while `readyAt > now`). Enemies: ghost alpha scaling with own-team `behind`; **stall** (`behind < lag`): scanline/colour-fringe on enemy sprites and enemy shots; **catch-up** (`behind > lag`): short motion streaks. Respect `prefers-reduced-motion` (static tint only).
- [ ] **Step 3:** HUD: own meter prominent, enemy meter small, value in ms, `role="meter"` with `aria-valuenow`/`aria-valuemax`; touch layout must not overlap `TouchControls`.
- [ ] **Step 4: Verify** with browser tools against the sandbox: screenshots at lag 0, stalled, catching up, Spiked; no console errors; check that shot impact effects do not fire mid-air for stale enemy shots that vanished on a live hit; `npm run build` clean.
- [ ] **Step 5: Commit** `feat(client): STALE lag meters, pickups and stall effects`

### Task 9: Bot pickups, soak with lag stats, docs

**Files:**
- Modify: `scripts/bot_ai.py` (pickup behaviour; aim uses the stale rows it is given, intentionally), `scripts/ctf_e2e.py` (4v4 STALE bot soak finishes without exceptions), `README.md` (Gameplay: STALE rules and the tunables table).

- [ ] **Step 1: Failing check.** In `bot_ai.py`'s self-check: `play(4, seed=7, mode="STALE")` and `play(1, seed=1, mode="STALE")` end before the hard stop, at least one pickup is collected, and the run prints per-team lag mean / p90 / at-zero share.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Bot detours to the nearest ready pickup within 300 px when it is a Spike, or a Sync with own-team lag ≥ 500. README section.
- [ ] **Step 4: Run** → PASS. If the printed lag stats leave the target band (Tuning evidence), adjust `LAG_PER_HP_MS` first, then `LAG_DRAIN_MS_PER_S`, and record the new numbers in the README. If 4v4 STALE no longer reaches 40 kills before the hard stop, note it for a `KILLS_TO_WIN` override. Run `python -m app.sim` once more.
- [ ] **Step 5: Commit** `feat: STALE bots, soak stats and docs`

## Self-review notes

- Coverage: mode (T1), view clock + stale rows (T2), lag meter (T3), stale shots (T4), Spike/Sync (T5), persistence (T6), lobby/bots wiring (T7), client (T8), bot pickups/soak/docs (T9).
- Names match across tasks: `lag_ms`, `view_t`, `hist`, `_record`, `_clock`, `_seen`, `Pickup`, `PICKUPS`, snapshot keys `lag`, `behind`, `pickups`.
- Dropped from the first draft: separate freeze state and pinned rows (Spike now rides the view clock), `frozenUntil` key, freeze checkpoint.
- Known ceiling: history is per tick (30 Hz), so stale positions are quantised to one tick. Fine for ≤ 2 s of lag.
