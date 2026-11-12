# Stale View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `STALE` game mode: each team sees enemies where they were N ms ago, N rises when the team is hurt and drains over time, and Spike/Sync pickups freeze the enemy's view or clear your own lag.

**Architecture:** `Game.snapshot(viewer_team=…)` already filters per team (cloak). Add a per-tick position history and a per-team `lag_ms`; when the viewer is on the other team, enemy `x/y` come from history at `now - lag_ms`. Hits, shots and flags keep using true positions. `STALE` reuses TDM scoring (kills to win). Pickups are new sim entities.

**Tech Stack:** Python sim (`services/game-service/app/sim.py`, self-checking via `python -m app.sim`), FastAPI matchmaking, React 19 + canvas client.

**Spec:** none. User skipped brainstorming ("make a plan"); the pitch is in the chat. Every item under "Design calls" below is the planner's call, not the user's.

## Design calls (change any before building)

- New mode `STALE` = TDM rules (first to `KILLS_TO_WIN`, sudden death, tiebreak) plus the lag mechanic. Not a modifier on CTF/KOTH, so existing modes keep their feel.
- Only enemy **player x/y** are stale. Enemy `hp`, `alive`, `kills` stay live. Dead enemies show at their live position.
- Enemy **shots stay live** (they reveal the shooter's true position). Accepted leak: shooting gives you away.
- Lag rises `LAG_PER_HP_MS = 10` per HP of damage taken by a teammate, capped at `LAG_MAX_MS = 2000`, drains `LAG_DRAIN_MS_PER_S = 250`. Sniper hit (70) = +700 ms.
- Spike: enemy team's view of *you* freezes at what they currently see for `FREEZE_MS = 2000`; a second Spike refreshes, does not stack. Sync: picker's team `lag_ms = 0`.
- Pickups: 2 Spike + 2 Sync at mirrored points, touch radius `TOUCH`, respawn `PICKUP_RESPAWN_MS = 15_000`, inactive during intro and after the match ends.
- Both teams' lag is sent to both teams (enemy lag is the cue to Spike).
- No smoothing when lag jumps up (enemy snaps back in time once). Add slewing only if playtest shows it is nauseating.

## Global Constraints

- All tunables in the constants table at the top of `sim.py`, named as above.
- Sim stays pure; tests are asserts in the `__main__` block of `sim.py` using the existing `new/run/put/lo` helpers. No test framework.
- An invisible (cloaked) enemy never yields coordinates, stale or live.
- Snapshot for `viewer_team=None` stays unfiltered and live.
- No Claude co-author lines in commits.

## Review Focus

- Cloaked enemy while stale: history stores `None` for invisible players, so a cloak that just ended never reveals where they hid.
- Lookup older than history (match start, after `restore`): clamp to oldest entry, or live position if history is empty. Never raise.
- Dead enemy: shown at live position, not a stale ghost walking around.
- `viewer_team=None`: live rows, no lag fields crash.
- Both teams touch pickups on the same tick; Spike on an already-frozen team refreshes, does not stack.
- Pickups never trigger during intro, intermission, or after `ended`.

---

### Task 1: STALE mode accepted by the sim, scored like TDM

**Files:**
- Modify: `services/game-service/app/sim.py` (`MODES`, `TARGET`, every `self.mode == "TDM"` / `"TDM"` site, `new()` helper)

**Interfaces:**
- Produces: `MODES = ("CTF", "TDM", "KOTH", "STALE")`; `TARGET["STALE"] = KILLS_TO_WIN`; `Game.kills_mode -> bool` (True for TDM and STALE); test helper `new(n=1, red=None, blue=None, mode="CTF")`.

- [ ] **Step 1: Failing test** in the `__main__` block: `g = new(mode="STALE")`; one kill by `r0` on `b0` gives `g.scores == [1, 0]`; `g.snapshot(0)["flags"] == []`; `g.snapshot(0)["target"] == KILLS_TO_WIN`.
- [ ] **Step 2: Run** `cd services/game-service && python -m app.sim` → FAIL (`unknown mode STALE`).
- [ ] **Step 3: Implement.** `grep -n '"TDM"' app/sim.py` and replace each mode check with `self.kills_mode`; flags/hill gating stays keyed on `CTF`/`KOTH`, so STALE has neither.
- [ ] **Step 4: Run** same command → PASS, and all existing asserts still pass.
- [ ] **Step 5: Commit** `feat(sim): add STALE mode scored like TDM`

### Task 2: Position history and stale enemy rows

**Files:**
- Modify: `services/game-service/app/sim.py` (`Game.__init__`, `step`, `snapshot`)

**Interfaces:**
- Consumes: Task 1.
- Produces: constants `HIST_MS = LAG_MAX_MS + 200`, `LAG_MAX_MS = 2000`; `Game.lag_ms: list[int]` (index = viewing team, ms its view of enemies is behind; starts `[0, 0]`); `Game._record(now: int) -> None` (append `(now, {pid: (x, y) | None})`, `None` when invisible; drop entries older than `HIST_MS`); `Game._seen(viewer: int, p: Player, now: int) -> tuple[float, float] | None` (position `viewer` sees for enemy `p`; `None` = hidden).

- [ ] **Step 1: Failing tests.** (a) STALE game, `lag_ms[1] = 500`, `b0` sees `r0` at the position `r0` had 500 ms ago while `r0` walks right; `viewer_team=0` and `None` still see live. (b) `r0` ASSASSIN cloaked at t=1000 then visible at t=2000, BLUE lag 1500: BLUE row for `r0` has `hidden` true and `x is None` (history had `None`). (c) `lag_ms[1] = 2000` at t=100: row uses oldest entry, no exception. (d) dead enemy row `x` equals live `p.x`. (e) in CTF `lag_ms` is ignored even if set.
- [ ] **Step 2: Run** `python -m app.sim` → FAIL.
- [ ] **Step 3: Implement.** Call `_record` at the end of `step()` only when `mode == "STALE"` and past intro. In `snapshot.row()`: if `mode == "STALE"`, `viewer_team is not None`, `p.team != viewer_team`, `p.alive`, and not currently invisible, then take `_seen(...)`; `None` → `hidden`. History lookup: newest entry with `t <= now - lag_ms`, clamp to oldest, live fallback if empty. `deque` is fine.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): enemy rows lag by the viewing team's lag_ms in STALE`

### Task 3: Lag meter rises on damage, drains over time

**Files:**
- Modify: `services/game-service/app/sim.py` (`_damage`, `step`, `snapshot` top level)

**Interfaces:**
- Produces: `LAG_PER_HP_MS = 10`, `LAG_DRAIN_MS_PER_S = 250`; snapshot key `"lag": {"RED": int, "BLUE": int}`.

- [ ] **Step 1: Failing tests.** 70 damage to a BLUE player sets `lag_ms[1] == 700` (RED unchanged); run 1 s → `450`; 10 000 damage across hits caps at `LAG_MAX_MS`; drain never goes below 0; tick size independence (`run(..., dt=33)` vs `dt=100` end within 1 ms-step rounding of each other); `snapshot()["lag"] == {"RED": …, "BLUE": …}`; CTF damage leaves `lag_ms` at `[0, 0]`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `_damage`, `STALE` only, add `amount * LAG_PER_HP_MS` capped. Drain in `step()` using `now - t0` like the HP regen does (integer, tick-size independent). Skip drain while intro/intermission paused.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): STALE lag rises on damage and drains`

### Task 4: Spike and Sync pickups

**Files:**
- Modify: `services/game-service/app/sim.py` (new `Pickup` dataclass, `PICKUPS`, `Game.pickups`, `Game.freeze`, `Game._pickups(now)`, `step`, `_seen`, `snapshot`, startup asserts that pickup points are not inside walls)

**Interfaces:**
- Produces: `@dataclass Pickup(id: int, kind: str, x: float, y: float, ready_at: int = 0)` with `kind in ("SPIKE", "SYNC")`; `PICKUPS: tuple[tuple[str, float, float], ...]` (2 Spike + 2 Sync, mirrored left/right); `FREEZE_MS = 2000`, `PICKUP_RESPAWN_MS = 15_000`; `Game.freeze: list[tuple[int, dict[str, tuple[float, float] | None]] | None]` indexed by **viewing** team (until-ms, pinned rows); snapshot keys `"pickups": [{"id", "kind", "x", "y", "readyAt"}]` and `"frozenUntil": {"RED": int|None, "BLUE": int|None}`.

- [ ] **Step 1: Failing tests.** Sync: BLUE player on a Sync with `lag_ms[1] = 900` → `lag_ms[1] == 0`, pickup `ready_at == now + PICKUP_RESPAWN_MS`, not re-triggerable before then. Spike: BLUE player on a Spike → RED's view of BLUE players is pinned to what RED saw at pickup; BLUE moves 200 px, RED still sees the pinned position until `now + FREEZE_MS`, then live (minus lag). Second Spike during freeze refreshes the deadline. Dead player does not collect. No collection during intro or when `g.ended`. Both teams on separate pickups same tick both apply. Pickup points: `assert not _hits_wall(x, y, TOUCH)`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `_pickups(now)` runs in `step()` after movement, `STALE` only. Pinned rows are captured via `_seen` for the victim team at the pickup tick. `_seen` checks `freeze[viewer]` first, then history.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): Spike and Sync pickups for STALE`

### Task 5: Checkpoint and restore

**Files:**
- Modify: `services/game-service/app/sim.py` (`checkpoint`, `restore`)

**Interfaces:**
- Consumes: Tasks 2–4. Checkpoint keys: `"lagMs": [int, int]`, `"pickups": [{"id","kind","readyAt"}]`, `"freeze": [{"until": int, "rows": {pid: [x, y] | null}} | null, …]`. Older checkpoints lacking them restore with defaults. History is **not** persisted.

- [ ] **Step 1: Failing test.** STALE game with lag, a used pickup, an active freeze → `Game.restore(g.checkpoint(t), t)` gives equal `lag_ms`, pickup `ready_at`, freeze; a CTF checkpoint without the keys still restores; restored game snapshot does not raise with empty history (live positions until history refills).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both directions; `restore` rebuilds `Pickup` list from `PICKUPS` ids then applies saved `readyAt`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sim): checkpoint STALE lag, pickups and freezes`

### Task 6: Mode wiring across services and client types

**Files:**
- Modify: `services/matchmaking-service/app/services/queue.py:370` (mode loop) and every other `"TDM"` mode list found by `grep -rn '"TDM"' services/ scripts/`; `services/common/warcis_common/` if modes are enumerated there; `frontend/src/api.ts:151` (`GameMode`); `frontend/src/data.ts:21` (mode card: `{ id: 'stale', name: 'Stale View', short: 'STALE', blurb: 'You see enemies as they were seconds ago. Getting hurt makes it worse. Grab Sync, spike their view.' }`, and `modeLabel`); `frontend/src/Hub.tsx:400` (`TDM || KOTH || STALE` hides captures); `frontend/src/Game.tsx` (`tdm` flag covers STALE for scoreboard/kickers).
- `services/game-service/app/main.py:133` already reads `m["mode"] in MODES`, so it needs no edit once `MODES` includes `STALE`.

**Interfaces:**
- Consumes: Task 1. Produces: `STALE` selectable in the lobby, queueable, and carried on the match document.

- [ ] **Step 1: Failing check.** Extend `scripts/ctf_e2e.py` with a 1v1 STALE match modelled on the KOTH block at `scripts/ctf_e2e.py:687`: queue `STALE`, assert `st["mode"] == "STALE"`, `st["target"] == 40`, `st["flags"] == []`, `st["lag"] == {"RED": 0, "BLUE": 0}`, `len(st["pickups"]) == 4`.
- [ ] **Step 2: Run** `docker compose up --build -d` then the e2e script → FAIL.
- [ ] **Step 3: Implement** the edits above; `npx tsc --noEmit` in `frontend/` must pass.
- [ ] **Step 4: Run** e2e → PASS; `cd frontend && npm run build` clean.
- [ ] **Step 5: Commit** `feat: STALE mode queueable end to end`

### Task 7: Client HUD, pickups, and stale look

**Files:**
- Modify: `frontend/src/game/render.ts` (`Snapshot` type gains `lag`, `frozenUntil`, `pickups`; draw pickups; tint enemies by lag), `frontend/src/Game.tsx` (lag meter HUD), `frontend/src/game/hud.css`, `frontend/src/game-sandbox.tsx` (add `?mode=stale` with fake lag/pickups for visual iteration).

**Interfaces:**
- Consumes: snapshot keys from Tasks 3–4. Types: `GPickup = { id: number; kind: 'SPIKE' | 'SYNC'; x: number; y: number; readyAt: number }`; `Snapshot.lag?: Record<Team, number>`, `Snapshot.frozenUntil?: Record<Team, number | null>`, `Snapshot.pickups?: GPickup[]`.

- [ ] **Step 1:** Add types and a sandbox scenario (`?mode=stale`) that animates enemy ghosts behind a true-position outline so the effect is visible in `npm run dev`.
- [ ] **Step 2:** Render pickups (distinct glyph/colour per kind, dimmed with a countdown ring while `readyAt > now`), enemy sprites at ghost alpha scaling with own-team `lag`, and a "FROZEN" cue while own-team view is frozen (`frozenUntil[myTeam] > now`).
- [ ] **Step 3:** HUD: two meters (yours prominent, enemy small) with ms value, in `Game.tsx`; accessible label (`role="meter"`, `aria-valuenow`); touch layout must not overlap `TouchControls`.
- [ ] **Step 4: Verify** with the browser tools against `npm run dev` sandbox: screenshot at lag 0, 700, frozen; no console errors; `npm run build` clean.
- [ ] **Step 5: Commit** `feat(client): STALE lag meter, pickups and ghosted enemies`

### Task 8: Bots, docs, playtest knobs

**Files:**
- Modify: `scripts/bot_ai.py` (walk to nearest ready Sync when own `lag` ≥ 600, to a Spike when enemy lag ≥ 600 and none frozen; aim uses the stale rows it is given, intentionally), `README.md` (Gameplay section: STALE rules and the tunables table), `scripts/ctf_e2e.py` (add a bot soak: 4v4 STALE finishes without exceptions).

- [ ] **Step 1: Failing check.** `python scripts/bot_ai.py` with a `play(4, seed=7, mode="STALE")` case asserting the match ends and `seen` shows at least one pickup collected.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** bot pickup behaviour and README section.
- [ ] **Step 4: Run** → PASS; run `python -m app.sim` once more.
- [ ] **Step 5: Commit** `feat: STALE bots, e2e soak and docs`

## Self-review notes

- Coverage: lag meter (T3), stale view (T2), true-position hits (unchanged `_shots`), Spike/Sync (T4), persistence (T5), lobby/mode (T6), client (T7), bots/docs (T8).
- Names match across tasks: `lag_ms`, `freeze`, `Pickup`, `PICKUPS`, `_seen`, `_record`, snapshot keys `lag`, `frozenUntil`, `pickups`.
- Known ceiling: history is per tick (30 Hz), so stale positions are quantised to one tick. Fine for 2 s of lag.
