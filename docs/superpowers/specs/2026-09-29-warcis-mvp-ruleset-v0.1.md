# WARCIS — MVP Ruleset v0.1

Status: draft for review. Scope: WARCIS v1 (Team Wipe, 1 map, 3 characters).
Goal: two developers implementing this document build the same game.

Conventions:
- All times are **server time in milliseconds**. The server ticks at **20 Hz (50 ms)**. "At time T" means "on the first tick with server time ≥ T".
- `clamp(x, lo, hi)` bounds x. `floor`, `round` (half up) are standard.
- All tunable numbers live in §12 Constants. Where a rule shows a number, §12 is the source of truth.
- "Paid" means the resource is deducted immediately. Resources never go below 0; an action whose cost exceeds the current pool cannot start.

---

## 1. Match setup

**Input.** A match starts from a roster: a mode (`1v1`, `2v2`, `4v4`), two teams (Team A, Team B) of equal size N ∈ {1, 2, 4}, and for each player a display name and a character. The roster may come from a room-code lobby or from the hub's match document; gameplay does not care which.

**Team formation.** Teams are fixed for the match. Slots are numbered A1..AN and B1..BN. Character duplicates are allowed, including on the same team.

**Starting values.** Each player starts with:
- HP = character MaxHP
- MP = 50% of character MaxMP (rounded down)
- Stamina = 100% of character MaxStamina
- Revives remaining = 1

**Positions.** The one map ("Arena") has Team A slots on the left, Team B slots on the right, and the Overcharge node in the center. Positions are fixed. **Players cannot move.** Positions are presentation only and **do not affect targeting, range, or power.**

**Visibility.** Everything below is visible to every player at all times:
- Every player's name, character, HP, state (§2), and whether they hold an Overcharge buff.
- Every locked attack: attacker, target, technique, attack power A, window countdown, and the committed defenders (§4).
- The Overcharge node state and the match clock.

Visible to **teammates only**: MP, Stamina, technique cooldowns.

Hidden from everyone except the attacker: an attack's technique and target **before it locks**. Others only see that the attacker is in `TypingAttack`.

**Visible enemy.** An enemy player whose state is Alive (any state in §2 except `Downed` and `Eliminated`). Only visible enemies can be targeted.

**Match flow.** `Countdown` (5 000 ms, no actions) → `Main` (0:00–3:00) → `FinalClash` (from 3:00) → `Ended`. The match clock reads 0:00 when Main starts.

**Regeneration.** Every tick, each Alive player regenerates MP and Stamina at their character rates (per second × 0.05), capped at max. Regen continues in every Alive state, including while typing. There is no HP regeneration.

---

## 2. Player state machine

Every player is always in exactly one state.

| State | Group | Meaning |
|---|---|---|
| `Idle` | Alive | Free to act |
| `TypingAttack` | Alive, busy | Typing an attack challenge |
| `Committed` | Alive, busy | Committed to defend one attack; waiting for that attack's window to close |
| `TypingDefense` | Alive, busy | Typing a defense challenge |
| `Capturing` | Alive, busy | Typing the Overcharge capture challenge |
| `Reviving` | Alive, busy | Typing a revive challenge on a Downed teammate |
| `Downed` | Out | 0 HP, can be revived |
| `Eliminated` | Out | Permanently out for the match |

**Universal rules**
- Only an `Idle` player can start an attack, a capture, or a revive.
- An Alive player can be targeted by attacks in every Alive state. Being attacked never changes their state by itself.
- **Commit override:** a player in `TypingAttack`, `Capturing`, or `Reviving` may commit to an open defense window. Doing so cancels their current action **without refund**, then they enter `Committed`.
- Any Alive player whose HP reaches 0 goes to `Downed` or `Eliminated` (§6), no matter what state they were in. Their current action is cancelled without refund and any commitment is removed.

**Transitions**

| From | Event | To |
|---|---|---|
| `Idle` | Starts an attack (§3) | `TypingAttack` |
| `Idle` | Commits to a window (§4) | `Committed` |
| `Idle` | Starts a capture (§7) | `Capturing` |
| `Idle` | Starts a revive (§6) | `Reviving` |
| `TypingAttack` | Submits a valid attack, or it fizzles, or it times out, or they cancel | `Idle` |
| `TypingAttack` / `Capturing` / `Reviving` | Commit override | `Committed` |
| `Committed` | Their commitment's window closes | `TypingDefense` |
| `Committed` | Switches to another open window (§4, once) | `Committed` (new attack) |
| `Committed` | Attack voided (§5) | `Idle` |
| `TypingDefense` | Finishes the prompt, or its time limit expires, or the attack is voided | `Idle` |
| `Capturing` | Completes, fails, times out, cancels, or is voided because someone else captured | `Idle` |
| `Reviving` | Completes, fails, times out, cancels, or is voided | `Idle` |
| Any Alive | HP reaches 0 | `Downed` or `Eliminated` (§6) |
| `Downed` | Revive completes | `Idle` |
| `Downed` | Bleed-out expires, or Final Clash starts | `Eliminated` |

A `Committed` player cannot withdraw. Their only moves are to wait or use their one switch.

---

## 3. Attack rules

### 3.1 Starting an attack
An `Idle` player picks a technique from their kit. It must be off cooldown and they must have MP ≥ its cost. Then:
1. **The MP cost is paid immediately.**
2. The player enters `TypingAttack` and gets that technique's prompt (§3.3).
3. The challenge clock starts at the server time the start request is accepted (`t0`).

### 3.2 Target selection
- The attacker picks a target: any visible enemy. It defaults to the last enemy they targeted, or to the lowest slot number if that enemy isn't visible.
- They can change the target any number of times, for free, before the attack locks.
- The target in effect at lock time is final. If that target is not visible at lock time (for example, Downed during typing), the attack is **voided** and the MP is refunded in full.
- Fork (§9) needs two targets. Rules are in §9.

### 3.3 Typing challenge (shared by every challenge in this document)
- The prompt is lowercase words from a fixed word list, joined by single spaces, with no punctuation. Its length is the target length L (§12) ±3 characters, with the chosen words' length counting.
- Each player gets their own random prompt.
- **Stop-on-error input.** The cursor only moves forward when the typed key matches the prompt character at the cursor. A wrong key counts as an error and the cursor stays put. Backspace does nothing and is not counted.
- `correct` = number of correct keystrokes = final cursor position.
- `errors` = number of wrong keystrokes.
- **Accuracy:** `acc = correct / (correct + errors)`. If no keys were pressed, acc = 0.
- **Completion:** `comp = correct / L_actual`, where L_actual is the prompt's real length.
- **Elapsed:** `elapsed_ms` = time from the challenge's start to the last correct keystroke, capped at the time limit. If correct = 0, elapsed_ms = time limit.
- **WPM:** `wpm = (correct / 5) / (elapsed_ms / 60 000)`.
- **Speed multiplier:** `m = clamp(0.7 + wpm / 200, 0.85, 1.30)`.
  - 30 WPM → 0.85 (floor), 60 → 1.00, 100 → 1.20, 120 and above → 1.30 (cap).
  - The best typer's advantage over a 30-WPM typer is at most 1.30 / 0.85 ≈ 1.53×. The per-action cap keeps speed from winning on its own. MP regen and cooldowns cap throughput (§8.3).
- **Accuracy gate:** if `acc < 0.85`, the challenge **fails**. Failed means no effect, and the cost is not refunded.
- The time limit is per challenge type (§12). The challenge ends when comp = 1 or the time limit is reached.

**Measurement and latency.** The client records each keystroke with a timestamp relative to when the prompt was displayed locally, and sends the full log (streamed, or all at once on finish). The server recomputes every value from the log. Keystrokes timestamped after the time limit are dropped. The server accepts logs until `start + limit + 300 ms grace`. After that it uses whatever it has received. v1 trusts client timestamps (friends-only). Autotyper and macro detection comes before any public play.

### 3.4 Attack power and lock
- An attack must be **completed** (comp = 1) within its time limit, with acc ≥ 0.85. Otherwise it **fizzles**: the MP stays spent, no cooldown starts, and the player returns to `Idle`.
- On success the attack **locks** at the server time the final keystroke is accepted:
  - `A = TechniqueBase × m × OverchargeMult × PhaseMult`
  - `OverchargeMult` = 1.5 if the attacker holds Overcharge (consumed by this attack), else 1.0.
  - `PhaseMult` = 2.0 if the attack locks at or after 3:00, else 1.0.
  - A is kept as a float. It is shown rounded to an integer.
- **A locked attack cannot be changed.** Nothing about it can change after lock: target, A, technique, special rules. It resolves even if the attacker is later Downed, Eliminated, or disconnected.
- The technique's cooldown starts at lock. The attacker returns to `Idle` at lock. There is no extra recovery time.

### 3.5 Cancel and disconnect
- Before lock, the attacker can cancel at any time. The MP is not refunded and no cooldown starts.
- If the attacker disconnects before lock, it counts as a cancel. If they disconnect after lock, nothing changes.

---

## 4. Defense commitment rules

### 4.1 Window
- The window opens **at the lock tick** of an attack and lasts **3 000 ms** (Pin: 1 500 ms, §9).
- Everyone on the target's team who is Alive can commit, **including the target**. Committing to an attack aimed at a teammate is called intercepting; the rules are the same.
- **The target is not auto-committed.** Someone has to commit on purpose. That keeps "ignore it and keep attacking" a real option.
- Commit requests are judged on **server receipt time**. A commit counts if it arrives before `window_close`. Clients show the countdown finishing **200 ms early** so players don't click too late.

### 4.2 Committing
- Allowed from `Idle`, or from `TypingAttack` / `Capturing` / `Reviving` through commit override (§2).
- **Cost:** pay 20 Stamina when committing (Tactician: 15, §9). If you don't have enough Stamina, you can't commit.
- A player holds **at most one commitment at a time**.
- Display: the attack card shows each committed defender's portrait in commit order. Their state label reads `Committed → <target>`. Teammates and enemies both see it.

### 4.3 Overlapping windows
- Any number of attacks can be open at once, including several aimed at the same target. Each attack has its own window, its own defenders, and its own resolution.
- A player who is already `Committed` (or `TypingDefense`) on attack X can't commit to attack Y. The only way into Y is the switch rule, and only while still `Committed`.

### 4.4 The one-switch rule
- A `Committed` player may move their commitment from attack X to attack Y if **both** windows are still open.
- **Cost:** pay 10 Stamina. The original 20 is not refunded and not charged again.
- **One switch per defense instance.** A commitment created by switching is marked `switched = true` and can't be switched again. The player then stays on Y until it resolves.
- The player can't switch back to X, and can't commit to X again after leaving.
- **No withdrawing.** Once committed, the player can't go back to `Idle` by choice. This stops the troll play of committing so teammates stay out, then backing out so the target takes the full hit.

### 4.5 Defense typing
- **At window_close, every defender still committed to that attack enters `TypingDefense` at the same moment.** Each gets their own defense prompt, and the challenge clock starts at window_close.
- A defender who finishes early goes back to `Idle` right away. The resolution waits for the others.
- **A committed or typing defender cannot attack, capture, or revive.** The entire cost of defending is being busy for up to 3 s + 6 s.

---

## 5. Defense resolution

### 5.1 Individual defense power
For each defender i, after their defense challenge ends:
- If acc_i < 0.85 → `D_i = 0`
- Otherwise → `D_i = DefBase_i × m_i × comp_i × TraitMult_i`

Unlike an attack, a defense doesn't have to be completed; partial completion counts through comp. `TraitMult` comes from the character's defense mechanic (§9). The default is 1.0.

### 5.2 Combined defense
Sort defenders by D_i, highest first. Break ties by commit order.

`D = Σ w_k × D_(k)`, with weights `w = [1.00, 0.60, 0.40, 0.30]`

This stops a full-team stack from blocking everything automatically. Four average defenders give 2.3× one defender, not 4×. A Tactician defender always gets w = 1.00 (§9).

Pierce (§9) multiplies D by 0.5 for its own attack.

### 5.3 Resolution time
The attack resolves at the **earliest** of:
- the window closing with zero committed defenders;
- every defender's challenge ending (finished or timed out);
- `window_close + 6 000 ms` (defense time limit).

### 5.4 Damage
- `raw = A − D`
- If `raw ≤ 0` → **BLOCKED**. Nobody takes damage.
- Otherwise → `dmg = max(1, round(raw))`. There is no cap beyond A itself.
- **Zero defenders:** D = 0, so the target takes `round(A)`.

A failed defense still reduces the damage by D. Every keystroke counts, and a defense is never all-or-nothing.

### 5.5 Distribution
- **With defenders:** the damage is split among the committed defenders only. The target takes no share unless they committed.
  - `share = floor(dmg / n)`, where n is the number of defenders.
  - The remainder `r = dmg mod n` is spread 1 point each to the r defenders with the **highest current HP**. Ties go to the lowest slot number.
  - A defender who timed out, failed accuracy, or disconnected still takes their share. Committing means sharing the risk.
- **Without defenders:** the target takes all of it.
- Damage is applied at resolution time. If several attacks resolve on the same tick, apply them in lock order.
- If a player's share is more than their HP, they drop to 0 (§6). The extra damage is lost; it doesn't carry over.

### 5.6 Target or defender goes down before resolution
- **Target down before window_close:** the attack is **voided**. Every committed defender gets their Stamina refunded in full and returns to `Idle`.
- **Target down after window_close** (defenders already typing): the attack still resolves normally against the defenders. They chose to take it, and this keeps the timeline simple.
- **A defender down mid-defense:** that defender's D_i = 0 and they're removed from the split. The split is recomputed over the defenders still Alive. If none are Alive, the target takes the damage, provided the target is still Alive.

**General void rule:** any action the server voids (as opposed to one the player cancels) refunds its cost in full.

---

## 6. Downed and revive

### 6.1 Going down
When an Alive player's HP reaches 0:
- If **Revives remaining = 1** and the phase is Main → `Downed`. The bleed-out timer starts at **15 000 ms**.
- Otherwise (no revives left, or Final Clash) → `Eliminated`.

On either change: the player's current action is cancelled without refund, their commitment is removed (§5.6), their Overcharge buff is lost, and their MP and Stamina are frozen (no regen). Attacks the player already locked still resolve (§3.4).

A Downed player **cannot act**. Enemies can't target them. They see the full battlefield, their bleed-out countdown, and who is reviving them, with a progress bar.

### 6.2 Reviving
- **Who can revive:** any `Idle` teammate. The Downed player must have Revives remaining = 1, and nobody else can already be reviving them. **One reviver per Downed player.**
- **Cost:** pay 40 Stamina when the revive starts.
- **Challenge:** a revive prompt (L = 25, limit 8 000 ms). It must be completed (comp = 1) with acc ≥ 0.85.
- **Deadline:** the bleed-out timer keeps running during a revive. If bleed-out reaches 0 first, the revive fails, and the player is Eliminated.
- **The reviver can be attacked** and stays targetable. If they're Downed, the revive fails. They can also leave the revive through commit override, or cancel it. Both lose the Stamina.
- **On success:** the Downed player becomes `Idle` with **HP = 30% of MaxHP** (rounded down) and the MP/Stamina they had when they went down. Revives remaining = 0.
- **On failure** (accuracy, timeout, cancel, or interrupt): the Downed player stays Downed and their bleed-out keeps running. Another teammate can try if there's time.

### 6.3 No infinite revives
Each player can be revived **once per match**. Going down a second time means Eliminated. So a team gets at most N revives per match, and there are no revives at all in Final Clash. In 1v1 there's no teammate, so going down means losing.

### 6.4 Team wipe
Checked at the end of every tick. **A team loses when none of its players are Alive** (all Downed or Eliminated).
- If exactly one team is wiped, the other team wins.
- If both teams are wiped on the same tick, it's a **Draw**.
- The match state becomes `Ended` and all pending actions are dropped.

---

## 7. Overcharge objective

### 7.1 Spawn
- Spawns at match clock **0:30, 1:15, 2:00, and 2:45**, always at the center node.
- **Only one is ever active.** An uncaptured Overcharge expires **25 000 ms** after it spawns. The next spawn time always comes after the previous one has expired.
- A spawn warning is shown to everyone **5 s before** it appears.

### 7.2 Capture
- Any `Idle` player on either team can start a capture while the Overcharge is active. There's no limit on how many players capture at once.
- **Cost:** pay 30 Stamina at start.
- **Challenge:** a capture prompt (L = 30, limit 10 000 ms). It must be completed with acc ≥ 0.85.
- **First valid completion by server receipt time wins.** Every other capture in progress is **voided** (Stamina refunded) and those players return to `Idle`. Race ties on the same tick go to the lower slot, with Team A before Team B for equal slot numbers.
  - The prompt is short, so the typing-speed edge in a race is about 1–3 s. The real decision is whether to commit a player at all.
  - A player who is `Capturing` can be attacked. They can use commit override to defend, which abandons the capture.
- Everyone sees who is capturing, with a progress bar.

### 7.3 Effect
- The capturer gains **Overcharge**: their next attack that locks gets `OverchargeMult = 1.5`.
- The buff is used up by that attack. It expires if unused for 30 000 ms, and it's lost if the holder is Downed or Eliminated.
- It stacks with Final Clash (1.5 × 2.0 = 3.0×). This is deliberate: the 2:45 spawn is a big late swing.
- Holders are marked with an icon visible to all players.

---

## 8. Final Clash

### 8.1 Trigger
At match clock **3:00**, if the match hasn't ended, the phase becomes `FinalClash`. A banner is shown to everyone at 2:50 and at 3:00.

### 8.2 Rule changes (effective from the 3:00 tick)
1. **Attack ×2:** PhaseMult = 2.0 for attacks locked at or after 3:00. Attacks locked before 3:00 keep PhaseMult 1.0 even if they resolve later.
2. **No revives:** every revive in progress is voided (Stamina refunded), and every Downed player becomes `Eliminated`. Anyone reaching 0 HP from now on is Eliminated immediately.
3. **Attrition:** every Alive player loses **1% of MaxHP per second**, applied as `MaxHP × 0.0005` per tick and totalled with fractions. HP is floored at display time, and a player is out when their accumulated HP ≤ 0. Attrition damage can Eliminate. This guarantees the match ends by about **4:40** even if nobody attacks.
4. Overcharge doesn't spawn after 3:00. The 2:45 node can still be captured until it expires (3:10), and any buff already held still works.

### 8.3 Why this closes stalling
Stalling means not attacking and saving Stamina to turtle-defend. In Main, turtling can't block everything because stacked defense is capped by the weights (§5.2). In Final Clash, attrition makes waiting a guaranteed loss of HP, and ×2 attack beats most stacks.

---

## 9. Characters

Three fixed characters. Each has 3 techniques (Quick / Heavy / Special) and 1 defense mechanic. **Special techniques only change existing pipeline parameters.** There's no status-effect system in v1.

### 9.1 Stats

| Stat | Warden | Striker | Tactician |
|---|---|---|---|
| MaxHP | 1200 | 900 | 1000 |
| MaxMP | 80 | 110 | 100 |
| MP regen /s | 1.5 | 2.5 | 2.0 |
| MaxStamina | 120 | 90 | 110 |
| Stamina regen /s | 6 | 5 | 6 |
| DefBase | 120 | 80 | 100 |

### 9.2 Techniques

| Character | Technique | Type | Base | MP | Cooldown | L | Time limit | Special rule |
|---|---|---|---|---|---|---|---|---|
| Warden | Jab | Quick | 80 | 12 | 0 s | 20 | 8 s | — |
| Warden | Slam | Heavy | 260 | 40 | 10 s | 50 | 17 s | — |
| Warden | Pin | Special | 150 | 25 | 8 s | 35 | 12 s | Defense window is **1 500 ms** instead of 3 000 |
| Striker | Flurry | Quick | 100 | 14 | 0 s | 20 | 8 s | — |
| Striker | Execute | Heavy | 300 | 45 | 12 s | 55 | 18 s | — |
| Striker | Pierce | Special | 170 | 30 | 8 s | 35 | 12 s | Combined D × 0.5 for this attack |
| Tactician | Probe | Quick | 80 | 10 | 0 s | 20 | 8 s | — |
| Tactician | Barrage | Heavy | 240 | 40 | 10 s | 50 | 17 s | — |
| Tactician | Fork | Special | 140 ×2 | 35 | 10 s | 40 | 13 s | Creates **two** locked attacks (below) |

**Fork.** The attacker picks two targets before lock. The two targets must be different enemies if at least two are visible; otherwise both hits go to the same enemy. At lock, Fork makes two independent attacks, each with `A = 140 × m × OM × PM`. Overcharge applies to both hits and is used up once. They lock on the same tick, and each has its own 3 000 ms window. A player holds only one commitment at a time, so a single target can only defend one of the two hits.

### 9.3 Defense mechanics (one per character; the result on success is always a clean block)

| Character | Mechanic | Rule |
|---|---|---|
| Warden | **Bulwark** | TraitMult = 1.25 when defending an attack aimed at a teammate (not themselves) |
| Striker | **Parry** | Defense prompt L = 12 instead of 18 (same 6 s limit), so full completion is much easier |
| Tactician | **Anchor** | Commit costs 15 Stamina instead of 20, and their D always gets weight 1.00 in §5.2 (it takes no slot in the sorted weight list; the other defenders use the weights in order) |

### 9.4 Reference numbers (m = 1.0, no buffs)
- 1 average defender (DefBase 100) blocks every Quick completely, and cuts a Heavy 260 to 160.
- Two defenders (100, 100): D = 160, so Slam deals 100, split 50/50.
- Four defenders (100 each): D = 230, so Striker Execute (300) still deals 70 through a full-team stack.
- An undefended Execute at 1.3× = 390, which is 43% of a Striker's HP.

---

## 10. Network, lobby, and disconnects

- **Server is the authority** for all state, timers, resources, and outcomes. Clients send intents: `start_attack`, `set_target`, `cancel`, `commit`, `switch`, `start_capture`, `start_revive`, and the keystroke log. The server broadcasts state diffs every tick.
- **Intent ordering:** intents are processed in server-receipt order within a tick. Rule checks (enough Stamina, window open, state allows it) use the state at processing time. An intent that fails its check is dropped, and the client gets a reason code.
- **Latency handling** is limited to three things: 200 ms early countdowns on the client (§4.1), a 300 ms grace for keystroke logs (§3.3), and client-relative keystroke timestamps. v1 has no other lag compensation.
- **Disconnect:** the player stays in the match as a normal player who sends no intents. All rules still apply to them: they can be targeted, their commitments count with D = 0, and they take attrition. **v1 has no reconnect.**
- **Lobby (v1):** a 6-character room code. The host picks the mode, players pick a team and character, and the host starts when both teams are full and equal size. There are no accounts; guest names are 1–16 characters and unique within the room.

---

## 11. UI requirements (minimum for readability in 4v4)

1. **Incoming panel (your team):** one card per open attack on your team, sorted by time left in its window. Each card shows the attacker, the target, the technique icon, A, a countdown ring, and the committed defenders' portraits, next to a big **DEFEND** button (or **SWITCH**, if you're already committed and have a switch left).
2. **Outgoing panel (enemy team):** the same cards, read-only, for attacks your team has locked on enemies. You can see whether they're defending.
3. **Portrait strip:** every player shows HP, a state badge (idle / attacking / committed / defending / capturing / reviving / downed / out), and an Overcharge icon. Teammate portraits also show MP and Stamina bars.
4. **Attack lines:** a line from attacker to target is drawn from lock until resolution. It's colored by team and thicker for higher A.
5. **Typing area:** one area in the bottom center. When a defense challenge starts, it replaces any other prompt the player sees.
6. **Hotkeys:** keys 1–3 pick a technique. Tab cycles targets. F1–F4 commit to incoming cards 1–4. Esc cancels. Letter keys are reserved for typing while a challenge is active.
7. **Result popups** at the target: `BLOCKED`, `−N` (per defender), and `FIZZLE`.

---

## 12. Constants

| Name | Value |
|---|---|
| Tick | 50 ms (20 Hz) |
| Countdown | 5 000 ms |
| Main phase length | 180 000 ms |
| Start MP | 50% MaxMP |
| Accuracy gate | 0.85 |
| Speed multiplier | clamp(0.7 + wpm/200, 0.85, 1.30) |
| Defense window | 3 000 ms (Pin 1 500 ms) |
| Client countdown lead | 200 ms |
| Keystroke-log grace | 300 ms |
| Defense prompt L / time limit | 18 chars (Parry 12) / 6 000 ms |
| Commit cost | 20 Stamina (Tactician 15) |
| Switch cost | 10 Stamina |
| Switches per defense instance | 1 |
| Stack weights | [1.00, 0.60, 0.40, 0.30] |
| Minimum damage when not blocked | 1 |
| Bleed-out | 15 000 ms |
| Revive cost / L / time limit | 40 Stamina / 25 chars / 8 000 ms |
| Revive HP | 30% MaxHP |
| Revives per player | 1 |
| Overcharge spawns | 0:30, 1:15, 2:00, 2:45 |
| Overcharge lifetime / warning | 25 000 ms / 5 000 ms |
| Capture cost / L / time limit | 30 Stamina / 30 chars / 10 000 ms |
| Overcharge multiplier / buff expiry | 1.5 / 30 000 ms |
| Final Clash attack multiplier | 2.0 |
| Final Clash attrition | 1% MaxHP per second |

---

## 13. Decisions this ruleset made that the scope left open (review these)

1. **Failed defense still reduces damage** (`dmg = A − D`) instead of letting the full attack through. It makes defense continuous, and a clean block is the case D ≥ A.
2. **Diminishing stack weights** keep "all 4 defend everything" from making the team unkillable.
3. **No withdrawing** from a commitment. Only one switch is allowed.
4. **Target is not auto-committed.**
5. **Costs are paid at start.** Actions the player cancels don't refund; actions the server voids refund in full.
6. **Attacks lock on completion only.** Defenses count partial completion.
7. **One revive per player,** and the bleed-out keeps running during a revive.
8. **Final Clash attrition** (1% HP/s) is what actually guarantees the match ends. ×2 attack alone doesn't.
9. **Target down before its window closes voids the attack.** After the window closes, the defenders take it.
10. **No movement.** Positions are presentation only.
