"""Capture The Flag simulation. Pure logic: no I/O, time is passed in (ms), so the
server stays authoritative and the rules are testable. Self-check: python -m app.sim

Team 0 = RED (left), team 1 = BLUE (right). A capture scores a round. First to ROUNDS_TO_WIN, or the higher score at
MATCH_MS, wins. Level at MATCH_MS: sudden death, respawns off and the next capture wins. Still level at HARD_STOP_MS, the
match is finalized: more objective progress (furthest flag carry this round) wins, then more kills, else a draw.

Every player has a class (HP, one Q ability) and a weapon (fire rate, damage, range), chosen
independently in the match lobby and read from the match document. Class and weapon ids are the
ones in warcis_common.loadout; every balance number lives in the tables below.
"""

import math
from dataclasses import dataclass, field

TEAMS = ("RED", "BLUE")
W, H = 1200, 700
PLAYER_R = 14
SPEED = 220  # px/s
SHOT_R = 4
RESPAWN_MS = 3000
FLAG_RETURN_MS = 10_000
TOUCH = PLAYER_R + 12  # player-to-flag pickup distance
BASE_R = 60
ROUNDS_TO_WIN = 3
MATCH_MS = 600_000  # regulation; level scores here start sudden death
HARD_STOP_MS = 720_000  # sudden death ends here and the tiebreak decides
INTERMISSION_MS = 4000  # frozen pause after a non-final capture, then the arena resets
MOVE_STEP = PLAYER_R / 2  # a dash never advances more than this between wall checks
# Walking keeps its pre-dash behaviour: one wall check per normal tick (220 px/s * 33 ms = 7.3 px), split only on a
# long tick so it still cannot tunnel. Splitting every tick in two shifted where players stop against walls, and bots
# then snagged on the centre block's corners (self-play stuck time 4 % -> 24 % in 1v1).
WALK_STEP = PLAYER_R

# ─────────────── classes and weapons (initial balance; see the plan, section 9) ───────────────

DEFAULT_LOADOUT = {"class": "ASSAULTER", "weapon": "ASSAULT_RIFLE"}

DASH_MS, DASH_DIST = 160, 160
BARRIER_LEN, BARRIER_THICK, BARRIER_HP, BARRIER_OFFSET = 90, 12, 150, 40

CLASS = {
    "ASSAULTER": {"hp": 85, "fireMult": 0.8, "ability": "DASH", "cooldownMs": 5000, "durationMs": DASH_MS},
    "GUARDIAN": {"hp": 140, "fireMult": 1.0, "ability": "BARRIER", "cooldownMs": 14_000, "durationMs": 8000},
    "ASSASSIN": {"hp": 100, "fireMult": 1.0, "ability": "INVISIBILITY", "cooldownMs": 15_000, "durationMs": 5000},
}
WEAPON = {
    "ASSAULT_RIFLE": {"cooldownMs": 160, "damage": 14, "pellets": 1, "spread": 0.0, "speed": 700, "ttlMs": 1100},
    "SHOTGUN": {"cooldownMs": 850, "damage": 9, "pellets": 7, "spread": 0.36, "speed": 650, "ttlMs": 420},
    "SNIPER_RIFLE": {"cooldownMs": 1500, "damage": 70, "pellets": 1, "spread": 0.0, "speed": 1600, "ttlMs": 900},
}
CATALOG = {"classes": CLASS, "weapons": WEAPON}  # sent in `hello` so the HUD can draw cooldowns; never trusted

BASES = ((110, H / 2), (W - 110, H / 2))
SPAWNS = tuple(tuple((x, H / 2 + dy) for dy in (-90, 90, -140, 140)) for x in (60, W - 60))


def _mirror(x, y, w, h):
    return [(x, y, w, h), (W - x - w, y, w, h)]


# Axis-aligned walls (x, y, w, h), mirrored left/right.
WALLS = [
    *_mirror(230, 140, 40, 140),
    *_mirror(230, 420, 40, 140),
    *_mirror(420, 60, 120, 40),
    *_mirror(420, 600, 120, 40),
    (560, 240, 80, 220),  # centre block
]
# Slabs just outside the arena, so shots meet the map edge like any other wall.
EDGES = [(-50, -50, W + 100, 50), (-50, H, W + 100, 50), (-50, -50, 50, H + 100), (W, -50, 50, H + 100)]


@dataclass
class Player:
    id: str
    name: str
    team: int
    pclass: str = DEFAULT_LOADOUT["class"]
    weapon: str = DEFAULT_LOADOUT["weapon"]
    x: float = 0.0
    y: float = 0.0
    hp: int = 100
    alive: bool = True
    respawn_at: int | None = None
    carrying_flag: bool = False
    keys: dict = field(default_factory=lambda: {"up": False, "down": False, "left": False, "right": False})
    last_fire: int = -10**9
    killed_by: str | None = None  # display only: who landed the last hit, while dead
    kills: int = 0
    deaths: int = 0
    captures: int = 0
    ability_ready_at: int = 0  # epoch ms; Q is usable once now >= this
    invisible_until: int | None = None  # Assassin; None = visible
    dash_from: int | None = None  # Assaulter; the dash covers [dash_from, dash_until)
    dash_until: int | None = None
    dash_dx: float = 0.0
    dash_dy: float = 0.0

    @property
    def max_hp(self) -> int:
        return CLASS[self.pclass]["hp"]


def rating(p: Player) -> float:
    """Ranking score: 2*captures + K/D. Deaths floor at 1 so a deathless player isn't infinite."""
    return round(2 * p.captures + p.kills / max(p.deaths, 1), 2)


@dataclass
class Flag:
    team: int
    x: float
    y: float
    state: str = "AT_BASE"  # AT_BASE | CARRIED | DROPPED
    carrier_id: str | None = None
    dropped_at: int | None = None


@dataclass
class Shot:
    id: int
    owner: str
    team: int
    x: float
    y: float
    vx: float
    vy: float
    born: int
    damage: int = 0
    ttl: int = 1000
    weapon: str = "ASSAULT_RIFLE"


@dataclass
class Barrier:
    id: int
    owner: str
    team: int
    x: float  # top-left, same convention as WALLS
    y: float
    w: float
    h: float
    hp: int
    expires_at: int


def _hits_wall(x: float, y: float, r: float) -> bool:
    if x < r or y < r or x > W - r or y > H - r:
        return True
    for wx, wy, ww, wh in WALLS:
        cx, cy = min(max(x, wx), wx + ww), min(max(y, wy), wy + wh)
        if (x - cx) ** 2 + (y - cy) ** 2 < r * r:
            return True
    return False


def _seg_rect_t(ax, ay, bx, by, rect, pad) -> float | None:
    """First t in [0, 1] at which segment a->b is inside `rect` grown by `pad` (slab test).
    0 if it starts inside, None if it never touches."""
    rx, ry, rw, rh = rect
    lo, hi = 0.0, 1.0
    for a, d, mn, mx in ((ax, bx - ax, rx - pad, rx + rw + pad), (ay, by - ay, ry - pad, ry + rh + pad)):
        if abs(d) < 1e-12:
            if a < mn or a > mx:
                return None
            continue
        t1, t2 = (mn - a) / d, (mx - a) / d
        if t1 > t2:
            t1, t2 = t2, t1
        lo, hi = max(lo, t1), min(hi, t2)
        if lo > hi:
            return None
    return lo


def _seg_circle_t(ax, ay, bx, by, cx, cy, r) -> float | None:
    """First t in [0, 1] at which segment a->b is within r of c; 0 if it starts inside."""
    dx, dy = bx - ax, by - ay
    fx, fy = ax - cx, ay - cy
    c = fx * fx + fy * fy - r * r
    if c <= 0:
        return 0.0
    a = dx * dx + dy * dy
    if a < 1e-12:
        return None
    b = 2 * (fx * dx + fy * dy)
    disc = b * b - 4 * a * c
    if disc < 0:
        return None
    t = (-b - math.sqrt(disc)) / (2 * a)
    return t if 0 <= t <= 1 else None


def _rects_overlap(a, b) -> bool:
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def _loadout_of(d: dict) -> tuple[str, str]:
    cls, weapon = d.get("class") or DEFAULT_LOADOUT["class"], d.get("weapon") or DEFAULT_LOADOUT["weapon"]
    if cls not in CLASS or weapon not in WEAPON:
        raise ValueError(f"unknown loadout {cls}/{weapon} for player {d.get('id')}")
    return cls, weapon


class Game:
    def __init__(self, teams: list[list[dict]], now: int):
        """teams: [[{id, name, class?, weapon?}, ...] RED, [...] BLUE], from the match document.
        A missing class/weapon (a match created before loadouts existed) means the default;
        an unknown one is corruption and raises ValueError."""
        self.players: dict[str, Player] = {}
        for t, roster in enumerate(teams):
            for i, p in enumerate(roster):
                cls, weapon = _loadout_of(p)
                pl = Player(p["id"], p.get("name", ""), t, cls, weapon)
                self._spawn(pl, i)
                self.players[pl.id] = pl
        self.flags = [Flag(t, *BASES[t]) for t in (0, 1)]
        self.shots: list[Shot] = []
        self.barriers: list[Barrier] = []
        self._shot_id = 0
        self._barrier_id = 0
        self.started = now
        self.last = now
        self.scores = [0, 0]
        self.round = 1
        self.resume_at: int | None = None  # set during the intermission after a capture
        self.round_winner: int | None = None
        self.over = False
        self.ended_at: int | None = None
        self.winner: int | None = None  # match winner; None once over means a draw
        self.capturer: str | None = None
        self.sudden_death = False  # level at MATCH_MS: no respawns, next capture wins
        self.progress = [0, 0]  # per team, this round: furthest carry of the enemy flag toward home, in % (1 = picked up)
        self.decided_by: str | None = None  # ROUNDS | SCORE | SUDDEN_DEATH | OBJECTIVE | KILLS | DRAW

    def _spawn(self, p: Player, slot: int | None = None) -> None:
        if slot is None:
            slot = [q.id for q in self.players.values() if q.team == p.team].index(p.id)
        p.x, p.y = SPAWNS[p.team][slot % len(SPAWNS[p.team])]
        p.hp, p.alive, p.respawn_at, p.carrying_flag, p.killed_by = p.max_hp, True, None, False, None
        p.invisible_until = p.dash_from = p.dash_until = None  # cooldowns are wall-clock and keep running

    @property
    def ended(self) -> bool:
        return self.over

    @staticmethod
    def invisible(p: Player, now: int) -> bool:
        return p.invisible_until is not None and now < p.invisible_until

    # ─────────────── intents from clients ───────────────

    def set_keys(self, pid: str, keys: dict) -> None:
        p = self.players.get(pid)
        if p:
            p.keys = {k: bool(keys.get(k)) for k in p.keys}

    def fire(self, pid: str, ax: float, ay: float, now: int) -> None:
        """Client sends only where it aims; origin, cooldown, weapon and direction are server-side."""
        p = self.players.get(pid)
        if not p or not p.alive or self.ended or self.resume_at is not None:
            return
        wp = WEAPON[p.weapon]
        if now - p.last_fire < round(wp["cooldownMs"] * CLASS[p.pclass]["fireMult"]):
            return
        dx, dy = ax - p.x, ay - p.y
        d = math.hypot(dx, dy)
        if d < 1e-6:
            return
        p.last_fire = now
        p.invisible_until = None  # firing gives the shooter away; revealed before any shot exists
        base, n = math.atan2(dy, dx), wp["pellets"]
        for i in range(n):  # deterministic fan: no RNG, so rules and tests are reproducible
            ang = base + (wp["spread"] * (i / (n - 1) - 0.5) if n > 1 else 0.0)
            self._shot_id += 1
            self.shots.append(
                Shot(self._shot_id, p.id, p.team, p.x, p.y, math.cos(ang) * wp["speed"], math.sin(ang) * wp["speed"], now,
                     wp["damage"], wp["ttlMs"], p.weapon)
            )

    def ability(self, pid: str, ax: float, ay: float, now: int) -> None:
        """Q. A request that cannot take effect is ignored and costs nothing."""
        p = self.players.get(pid)
        if not p or not p.alive or self.ended or self.resume_at is not None or now < p.ability_ready_at:
            return
        kind = CLASS[p.pclass]["ability"]
        ux, uy = ax - p.x, ay - p.y
        d = math.hypot(ux, uy)
        if kind == "DASH":
            if p.dash_until is not None and now < p.dash_until:
                return
            k = p.keys
            dx, dy = k["right"] - k["left"], k["down"] - k["up"]
            n = math.hypot(dx, dy)
            if not n:  # standing still: dash toward the aim point
                if d < 1e-6:
                    return
                dx, dy, n = ux, uy, d
            p.dash_dx, p.dash_dy = dx / n, dy / n
            p.dash_from, p.dash_until = now, now + DASH_MS
        elif kind == "BARRIER":
            if d < 1e-6 or not self._place_barrier(p, ux / d, uy / d, now):
                return
        else:  # INVISIBILITY
            if p.carrying_flag:
                return
            p.invisible_until = now + CLASS[p.pclass]["durationMs"]
        p.ability_ready_at = now + CLASS[p.pclass]["cooldownMs"]

    def _place_barrier(self, p: Player, ux: float, uy: float, now: int) -> bool:
        vertical = abs(ux) >= abs(uy)  # a slab across the dominant aim axis
        w, h = (BARRIER_THICK, BARRIER_LEN) if vertical else (BARRIER_LEN, BARRIER_THICK)
        off = BARRIER_OFFSET
        while off >= PLAYER_R + BARRIER_THICK / 2:
            r = (p.x + ux * off - w / 2, p.y + uy * off - h / 2, w, h)
            if r[0] >= 0 and r[1] >= 0 and r[0] + w <= W and r[1] + h <= H and not any(_rects_overlap(r, wall) for wall in WALLS):
                self.barriers = [b for b in self.barriers if b.owner != p.id]  # one live barrier per Guardian
                self._barrier_id += 1
                self.barriers.append(Barrier(self._barrier_id, p.id, p.team, *r, BARRIER_HP, now + CLASS[p.pclass]["durationMs"]))
                return True
            off -= 10
        return False

    # ─────────────── simulation ───────────────

    def step(self, now: int) -> None:
        t0 = self.last
        self.last = now
        if self.ended:
            return
        if now - self.started >= HARD_STOP_MS:
            self._tiebreak(now)
            return
        if now - self.started >= MATCH_MS and not self.sudden_death:
            if self.scores[0] != self.scores[1]:
                self._finish(now, int(self.scores[1] > self.scores[0]), "SCORE")
                return
            self.sudden_death = True  # whoever is down now stays down; a pending intermission still resets the arena
            for p in self.players.values():
                p.respawn_at = None
        if self.resume_at is not None:
            if now < self.resume_at:
                return
            self._new_round()
        for p in self.players.values():
            if not p.alive and p.respawn_at is not None and now >= p.respawn_at:
                self._spawn(p)
            if p.invisible_until is not None and now >= p.invisible_until:
                p.invisible_until = None
        self.barriers = [b for b in self.barriers if b.hp > 0 and now < b.expires_at]
        for p in self.players.values():
            if p.alive:
                self._move(p, t0, now)
        self._shots(max(0, now - t0) / 1000, now)
        self._flags(now)

    def _advance(self, p: Player, vx: float, vy: float, secs: float, step: float = MOVE_STEP) -> None:
        """Move at velocity (vx, vy) for `secs`, checking walls at least every `step` px so nothing tunnels.
        Axis-separated so players slide along walls instead of sticking."""
        n = max(1, math.ceil(math.hypot(vx, vy) * secs / step))
        sx, sy = vx * secs / n, vy * secs / n
        for _ in range(n):
            if not _hits_wall(p.x + sx, p.y, PLAYER_R):
                p.x += sx
            if not _hits_wall(p.x, p.y + sy, PLAYER_R):
                p.y += sy

    def _move(self, p: Player, t0: int, t1: int) -> None:
        secs = max(0, t1 - t0) / 1000
        if p.dash_until is not None:
            # The dash covers a fixed time window, so its length does not depend on tick jitter.
            on = max(0, min(t1, p.dash_until) - max(t0, p.dash_from)) / 1000
            if on:
                speed = DASH_DIST / (DASH_MS / 1000)
                self._advance(p, p.dash_dx * speed, p.dash_dy * speed, on)
            secs -= on
            if t1 >= p.dash_until:
                p.dash_from = p.dash_until = None
        k = p.keys
        dx, dy = k["right"] - k["left"], k["down"] - k["up"]
        if secs > 0 and (dx or dy):
            n = math.hypot(dx, dy)
            self._advance(p, dx / n * SPEED, dy / n * SPEED, secs, WALK_STEP)

    def _shots(self, dt: float, now: int) -> None:
        """Each shot sweeps its whole path this tick and stops at the first thing along it."""
        live = []
        for s in self.shots:
            nx, ny = s.x + s.vx * dt, s.y + s.vy * dt
            best: tuple[float, int, object] | None = None  # (t, 0 = cover / 1 = player, target)

            def consider(t, kind, target):
                nonlocal best
                if t is not None and (best is None or (t, kind) < best[:2]):
                    best = (t, kind, target)

            for rect in WALLS + EDGES:
                consider(_seg_rect_t(s.x, s.y, nx, ny, rect, SHOT_R), 0, None)
            for b in self.barriers:
                if b.team != s.team and b.hp > 0:
                    consider(_seg_rect_t(s.x, s.y, nx, ny, (b.x, b.y, b.w, b.h), SHOT_R), 0, b)
            for p in self.players.values():  # hidden enemies are hit like anyone else
                if p.alive and p.team != s.team:
                    consider(_seg_circle_t(s.x, s.y, nx, ny, p.x, p.y, PLAYER_R + SHOT_R), 1, p)
            if best:
                target = best[2]
                if isinstance(target, Barrier):
                    target.hp -= s.damage
                elif isinstance(target, Player):
                    self._damage(target, now, s.owner, s.damage)
            elif now - s.born < s.ttl:
                s.x, s.y = nx, ny
                live.append(s)
        self.shots = live
        self.barriers = [b for b in self.barriers if b.hp > 0]

    def _reveal(self, p: Player) -> None:
        p.invisible_until = None

    def _damage(self, p: Player, now: int, by: str | None = None, amount: int = 0) -> None:
        if amount <= 0:
            return
        self._reveal(p)  # any positive damage ends invisibility
        p.hp -= amount
        if p.hp > 0:
            return
        p.hp, p.alive, p.respawn_at, p.killed_by = 0, False, None if self.sudden_death else now + RESPAWN_MS, by
        p.dash_from = p.dash_until = None
        p.deaths += 1
        killer = self.players.get(by) if by else None
        if killer and killer.team != p.team:
            killer.kills += 1
        if p.carrying_flag:
            f = self.flags[1 - p.team]
            f.state, f.carrier_id, f.x, f.y, f.dropped_at = "DROPPED", None, p.x, p.y, now
            p.carrying_flag = False

    def _flags(self, now: int) -> None:
        for f in self.flags:
            if f.state == "DROPPED" and now - f.dropped_at >= FLAG_RETURN_MS:
                self._return(f)
        for p in self.players.values():
            if not p.alive:
                continue
            own, enemy = self.flags[p.team], self.flags[1 - p.team]
            if own.state == "DROPPED" and math.hypot(p.x - own.x, p.y - own.y) <= TOUCH:
                self._return(own)
            if enemy.state in ("AT_BASE", "DROPPED") and math.hypot(p.x - enemy.x, p.y - enemy.y) <= TOUCH:
                enemy.state, enemy.carrier_id, enemy.dropped_at = "CARRIED", p.id, None
                p.carrying_flag = True
                self._reveal(p)  # a flag carrier is never hidden
            if p.carrying_flag:
                enemy.x, enemy.y = p.x, p.y
                bx, by = BASES[p.team]
                carry = 1 - math.hypot(p.x - bx, p.y - by) / math.dist(BASES[0], BASES[1])
                self.progress[p.team] = max(self.progress[p.team], min(100, max(1, round(100 * carry))))
                # Capture only while our own flag is safely home.
                if own.state == "AT_BASE" and math.hypot(p.x - bx, p.y - by) <= BASE_R:
                    self._score(p, now)
                    return

    def _score(self, p: Player, now: int) -> None:
        self.scores[p.team] += 1
        p.captures += 1
        self.capturer, self.round_winner = p.id, p.team
        if self.sudden_death:
            self._finish(now, p.team, "SUDDEN_DEATH")
        elif self.scores[p.team] >= ROUNDS_TO_WIN:
            self._finish(now, p.team, "ROUNDS")
        else:
            self.resume_at = now + INTERMISSION_MS

    def team_kills(self) -> list[int]:
        return [sum(p.kills for p in self.players.values() if p.team == t) for t in (0, 1)]

    def _tiebreak(self, now: int) -> None:
        """HARD_STOP_MS with scores still level: objective progress, then kills, then a draw."""
        for a, b, how in ((*self.scores, "SCORE"), (*self.progress, "OBJECTIVE"), (*self.team_kills(), "KILLS")):
            if a != b:
                return self._finish(now, int(b > a), how)
        self._finish(now, None, "DRAW")

    def _finish(self, now: int, winner: int | None, how: str) -> None:
        self.over, self.ended_at, self.resume_at = True, now, None
        self.winner, self.decided_by = winner, how

    def _new_round(self) -> None:
        for f in self.flags:
            self._return(f)
        self.shots, self.barriers = [], []
        for p in self.players.values():
            self._spawn(p)
        self.round += 1
        self.resume_at = self.round_winner = None
        self.progress = [0, 0]

    def _return(self, f: Flag) -> None:
        f.state, f.carrier_id, f.dropped_at = "AT_BASE", None, None
        f.x, f.y = BASES[f.team]

    # ─────────────── checkpoint (low-frequency persistence) ───────────────
    # Times are the caller's clock (epoch ms in the service), so they survive a restart.

    def checkpoint(self, now: int) -> dict:
        return {
            "status": "ENDED" if self.ended else "PLAYING",
            "saved_at": now,
            "started": self.started,
            "winner": TEAMS[self.winner] if self.winner is not None else None,
            "capturer": self.capturer,
            "scores": self.scores,
            "round": self.round,
            "resumeAt": self.resume_at,
            "roundWinner": TEAMS[self.round_winner] if self.round_winner is not None else None,
            "suddenDeath": self.sudden_death,
            "progress": self.progress,
            "decidedBy": self.decided_by,
            "players": [
                {"id": p.id, "name": p.name, "team": TEAMS[p.team], "class": p.pclass, "weapon": p.weapon,
                 "x": p.x, "y": p.y, "hp": p.hp, "alive": p.alive, "respawnAt": p.respawn_at, "carryingFlag": p.carrying_flag,
                 "kills": p.kills, "deaths": p.deaths, "captures": p.captures,
                 "abilityReadyAt": p.ability_ready_at, "invisibleUntil": p.invisible_until}
                for p in self.players.values()
            ],
            "flags": [
                {"team": TEAMS[f.team], "state": f.state, "x": f.x, "y": f.y, "carrierId": f.carrier_id,
                 "returnAt": f.dropped_at + FLAG_RETURN_MS if f.state == "DROPPED" else None}
                for f in self.flags
            ],
            "barriers": [
                {"id": b.id, "owner": b.owner, "team": TEAMS[b.team], "x": b.x, "y": b.y, "w": b.w, "h": b.h,
                 "hp": b.hp, "expiresAt": b.expires_at}
                for b in self.barriers
            ],
            "barrierSeq": self._barrier_id,
        }

    @classmethod
    def restore(cls, cp: dict, now: int) -> "Game":
        """Rebuild from checkpoint(). Raises ValueError on an inconsistent checkpoint
        rather than inventing state. Checkpoints written before loadouts existed restore with the default."""
        teams = [[p for p in cp["players"] if p["team"] == t] for t in TEAMS]
        g = cls(teams, cp["started"])
        g.last = now  # held keys and dashes are not persisted, and no catch-up step across the downtime
        for d in cp["players"]:
            p = g.players[d["id"]]
            p.x, p.y, p.alive, p.respawn_at, p.carrying_flag = d["x"], d["y"], d["alive"], d["respawnAt"], d["carryingFlag"]
            p.hp = min(d["hp"], p.max_hp)
            p.kills, p.deaths, p.captures = d.get("kills", 0), d.get("deaths", 0), d.get("captures", 0)  # older checkpoints have none
            p.ability_ready_at, p.invisible_until = d.get("abilityReadyAt", 0), d.get("invisibleUntil")
        for f, d in zip(g.flags, sorted(cp["flags"], key=lambda d: TEAMS.index(d["team"]))):
            f.state, f.x, f.y, f.carrier_id = d["state"], d["x"], d["y"], d["carrierId"]
            f.dropped_at = d["returnAt"] - FLAG_RETURN_MS if d["state"] == "DROPPED" else None
            carrier = g.players.get(f.carrier_id) if f.carrier_id else None
            if (f.state == "CARRIED") != bool(carrier and carrier.carrying_flag and carrier.team != f.team and carrier.alive):
                raise ValueError(f"{TEAMS[f.team]} flag state {f.state} disagrees with carrier {f.carrier_id}")
            if carrier and g.invisible(carrier, now):
                carrier.invisible_until = None  # cannot happen in play; never restore a hidden carrier
        for d in cp.get("barriers", []):
            owner = g.players.get(d["owner"])
            if owner is None or TEAMS.index(d["team"]) != owner.team:
                raise ValueError(f"barrier {d['id']} disagrees with its owner {d['owner']}")
            g.barriers.append(Barrier(d["id"], d["owner"], owner.team, d["x"], d["y"], d["w"], d["h"], d["hp"], d["expiresAt"]))
        g._barrier_id = max([cp.get("barrierSeq", 0), *(b.id for b in g.barriers)])
        g.scores, g.round, g.resume_at = list(cp.get("scores", g.scores)), cp.get("round", 1), cp.get("resumeAt")
        rw = cp.get("roundWinner")
        g.round_winner = TEAMS.index(rw) if rw else None
        g.capturer = cp.get("capturer")
        g.sudden_death, g.progress = cp.get("suddenDeath", False), list(cp.get("progress", g.progress))
        if cp.get("status") == "ENDED":
            g.over, g.ended_at = True, now
            g.winner = TEAMS.index(cp["winner"]) if cp.get("winner") else None
            g.decided_by = cp.get("decidedBy") or ("DRAW" if g.winner is None else "SCORE")  # older checkpoints have none
        return g

    def result(self, now: int) -> dict:
        """Final per-player result of an ended match; this is what matchmaking-side history and stats read."""
        if not self.ended:
            raise ValueError("match has not ended")
        return {
            "winner": TEAMS[self.winner] if self.winner is not None else "TIE",  # stored results say TIE for a draw
            "scores": {TEAMS[t]: self.scores[t] for t in (0, 1)},
            "capturer": self.capturer,
            "decided_by": self.decided_by,
            "progress": {TEAMS[t]: self.progress[t] for t in (0, 1)},
            "team_kills": {TEAMS[t]: k for t, k in enumerate(self.team_kills())},
            "duration_ms": max(0, now - self.started),
            "players": [
                {
                    "id": p.id,
                    "name": p.name,
                    "team": TEAMS[p.team],
                    "class": p.pclass,
                    "weapon": p.weapon,
                    "outcome": "TIE" if self.winner is None else "WIN" if p.team == self.winner else "LOSS",
                    "rating": rating(p),
                    "kills": p.kills,
                    "deaths": p.deaths,
                    "captures": p.captures,
                }
                for p in self.players.values()
            ],
        }

    # ─────────────── broadcast ───────────────

    def snapshot(self, now: int, connected=frozenset(), bots=frozenset(), viewer_team: int | None = None) -> dict:
        """connected: ids with a live socket. Others (dropped clients) stay in the match:
        they keep their state, can be shot and hold flags, but send no input.
        bots: display-only label; bots play through the same socket protocol as humans.
        viewer_team: whose eyes this is. An invisible enemy is sent without coordinates (and without
        its ability timer), so the position never reaches that client. None = the unfiltered view."""
        r = lambda v: round(v, 1)  # noqa: E731

        def row(p: Player) -> dict:
            inv = self.invisible(p, now) and not self.ended
            hidden = inv and viewer_team is not None and p.team != viewer_team
            friendly = viewer_team is None or p.team == viewer_team
            return {
                "id": p.id,
                "name": p.name,
                "team": TEAMS[p.team],
                "class": p.pclass,
                "weapon": p.weapon,
                "maxHp": p.max_hp,
                "x": None if hidden else r(p.x),
                "y": None if hidden else r(p.y),
                "hidden": hidden,
                "invisible": inv and not hidden,
                "dashing": not hidden and p.dash_until is not None and now < p.dash_until,
                "abilityReadyAt": p.ability_ready_at if friendly else None,
                "hp": p.hp,
                "alive": p.alive,
                "respawnAt": p.respawn_at,
                "carryingFlag": p.carrying_flag,
                "connected": p.id in connected,
                "bot": p.id in bots,
                "killedBy": p.killed_by,
                "kills": p.kills,
                "deaths": p.deaths,
                "captures": p.captures,
                "rating": rating(p),
            }

        return {
            "t": "state",
            "now": now,
            "elapsed": (now if self.ended_at is None else self.ended_at) - self.started,
            "matchMs": MATCH_MS,
            "hardStopMs": HARD_STOP_MS,
            "suddenDeath": self.sudden_death,
            "state": "ENDED" if self.ended else "PLAYING",
            "winner": TEAMS[self.winner] if self.winner is not None else None,  # ENDED + None = draw
            "decidedBy": self.decided_by,
            "progress": {TEAMS[t]: self.progress[t] for t in (0, 1)},
            "scores": {TEAMS[t]: self.scores[t] for t in (0, 1)},
            "round": self.round,
            "resumesAt": self.resume_at,
            "roundWinner": TEAMS[self.round_winner] if self.round_winner is not None else None,
            "capturer": self.capturer,
            "players": [row(p) for p in self.players.values()],
            "flags": [
                {
                    "team": TEAMS[f.team],
                    "x": r(f.x),
                    "y": r(f.y),
                    "state": f.state,
                    "carrierId": f.carrier_id,
                    "returnAt": f.dropped_at + FLAG_RETURN_MS if f.state == "DROPPED" else None,
                }
                for f in self.flags
            ],
            "shots": [{"id": s.id, "owner": s.owner, "team": TEAMS[s.team], "x": r(s.x), "y": r(s.y), "w": s.weapon} for s in self.shots],
            "barriers": [
                {"id": b.id, "owner": b.owner, "team": TEAMS[b.team], "x": r(b.x), "y": r(b.y), "w": b.w, "h": b.h,
                 "hp": b.hp, "maxHp": BARRIER_HP, "expiresAt": b.expires_at}
                for b in self.barriers
            ],
        }


MAP = {
    "w": W,
    "h": H,
    "walls": WALLS,
    "bases": [{"team": TEAMS[t], "x": x, "y": y, "r": BASE_R} for t, (x, y) in enumerate(BASES)],
    "spawns": [{"team": TEAMS[t], "x": x, "y": y} for t in (0, 1) for x, y in SPAWNS[t]],
    "playerR": PLAYER_R,
    "shotR": SHOT_R,
}


if __name__ == "__main__":  # self-check: python -m app.sim
    import os
    import sys

    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "common"))
    from warcis_common import loadout as ids

    assert tuple(CLASS) == ids.CLASSES and tuple(WEAPON) == ids.WEAPONS and DEFAULT_LOADOUT == ids.DEFAULT_LOADOUT, "catalog drifted from warcis_common.loadout"
    for t in (0, 1):
        for x, y in SPAWNS[t]:
            assert not _hits_wall(x, y, PLAYER_R), "spawn inside wall"

    def new(n=1, red=None, blue=None):
        def roster(prefix, lo):
            return [{"id": f"{prefix}{i}", **(lo[i] if lo and i < len(lo) else {})} for i in range(n)]
        return Game([roster("r", red), roster("b", blue)], 0)

    def lo(c="ASSAULTER", w="ASSAULT_RIFLE"):
        return {"class": c, "weapon": w}

    def run(g, t0, t1, dt=33):
        t = t0
        while t < t1:
            t = min(t + dt, t1)
            g.step(t)
        return t

    def put(p, x, y):
        p.x, p.y = x, y

    # Same rules for 1v1 / 2v2 / 4v4: everyone spawns alive at their class's full HP.
    for n in (1, 2, 4):
        g = new(n)
        assert len(g.players) == 2 * n and all(p.alive and p.hp == 85 for p in g.players.values())
    g = new(1, red=[lo("GUARDIAN")], blue=[lo("ASSASSIN", "SNIPER_RIFLE")])
    assert (g.players["r0"].hp, g.players["b0"].hp) == (140, 100)
    g.players["r0"].hp = 1
    g._damage(g.players["r0"], 0, "b0", 5)
    g.step(RESPAWN_MS)
    assert g.players["r0"].alive and g.players["r0"].hp == 140, "respawn restores the class's max HP"
    assert new(1, red=[lo("GUARDIAN", "SHOTGUN")]).players["r0"].weapon == "SHOTGUN"  # class and weapon are independent
    g = new(2, red=[lo("GUARDIAN", "SHOTGUN"), lo("GUARDIAN", "SHOTGUN")])  # duplicates on a team are fine
    assert [p.pclass for p in g.players.values()][:2] == ["GUARDIAN", "GUARDIAN"]
    try:
        new(1, red=[lo("WIZARD")])
        raise AssertionError("unknown class accepted")
    except ValueError:
        pass

    # Fire cooldown is per weapon, and the Assaulter fires 25 % faster.
    for cls, weapon, cd in [("ASSAULTER", "ASSAULT_RIFLE", 128), ("GUARDIAN", "ASSAULT_RIFLE", 160), ("ASSASSIN", "SHOTGUN", 850),
                            ("ASSAULTER", "SHOTGUN", 680), ("GUARDIAN", "SNIPER_RIFLE", 1500), ("ASSAULTER", "SNIPER_RIFLE", 1200)]:
        g = new(1, red=[lo(cls, weapon)])
        put(g.players["r0"], 600, 150)
        g.fire("r0", 700, 150, 10_000)
        n0 = len(g.shots)
        g.fire("r0", 700, 150, 10_000 + cd - 1)
        assert len(g.shots) == n0, (cls, weapon, "fired inside its cooldown")
        g.fire("r0", 700, 150, 10_000 + cd)
        assert len(g.shots) == 2 * n0, (cls, weapon, "did not fire when the cooldown elapsed")

    # Shotgun: a deterministic fan; at point blank every pellet lands.
    g = new(1, red=[lo("GUARDIAN", "SHOTGUN")], blue=[lo("GUARDIAN")])
    r0, b0 = g.players["r0"], g.players["b0"]
    put(r0, 600, 150), put(b0, 640, 150)
    g.fire("r0", 700, 150, 0)
    angles = [math.atan2(s.vy, s.vx) for s in g.shots]
    assert len(g.shots) == 7 and angles == sorted(angles) and abs(angles[0] + angles[-1]) < 1e-9 and abs(angles[-1] - angles[0] - 0.36) < 1e-9
    run(g, 0, 300)
    assert b0.hp == 140 - 7 * 9 and not g.shots, b0.hp
    # ...and at long range most of the volley misses (pellets also die after their short TTL).
    g = new(1, red=[lo("GUARDIAN", "SHOTGUN")], blue=[lo("GUARDIAN")])
    put(g.players["r0"], 400, 150), put(g.players["b0"], 800, 150)
    g.fire("r0", 800, 150, 0)
    run(g, 0, 1500)
    assert g.players["b0"].hp == 140 and not g.shots

    # Sniper: no tunnelling through a 40 px wall at any tick size; a shot never hits a player behind cover.
    for dt in (33, 100, 250):
        g = new(1, red=[lo("GUARDIAN", "SNIPER_RIFLE")], blue=[lo("GUARDIAN")])
        put(g.players["r0"], 150, 200), put(g.players["b0"], 350, 200)  # the wall (230, 140, 40, 140) is between
        g.fire("r0", 350, 200, 0)
        run(g, 0, 900, dt)
        assert g.players["b0"].hp == 140 and not g.shots, (dt, g.players["b0"].hp)
    g = new(1, red=[lo("GUARDIAN", "SNIPER_RIFLE")], blue=[lo("GUARDIAN")])
    put(g.players["r0"], 200, 130), put(g.players["b0"], 300, 180)  # the segment clips the wall's top-left corner
    g.fire("r0", 300, 180, 0)
    run(g, 0, 600, 100)
    assert g.players["b0"].hp == 140, "hit a player through a wall corner"
    g = new(1, red=[lo("GUARDIAN", "SNIPER_RIFLE")], blue=[lo("GUARDIAN")])
    put(g.players["r0"], 600, 150), put(g.players["b0"], 900, 150)
    g.fire("r0", 900, 150, 0)
    run(g, 0, 400, 33)
    assert g.players["b0"].hp == 140 - 70 and not g.shots  # open ground: a hit costs 70, whatever the tick size
    g = new(1, red=[lo("GUARDIAN", "SNIPER_RIFLE")])
    put(g.players["r0"], 1100, 150)
    g.fire("r0", 1190, 150, 0)
    run(g, 0, 200, 100)
    assert not g.shots, "shot flew out of the arena"

    # The nearer enemy along the path takes the hit, regardless of player order.
    g = Game([[{"id": "r0", "class": "GUARDIAN", "weapon": "SNIPER_RIFLE"}], [{"id": "far", "class": "GUARDIAN"}, {"id": "near", "class": "GUARDIAN"}]], 0)
    put(g.players["r0"], 600, 150), put(g.players["far"], 700, 150), put(g.players["near"], 650, 150)
    g.fire("r0", 700, 150, 0)
    g.step(100)
    assert g.players["near"].hp == 140 - 70 and g.players["far"].hp == 140

    # Barrier: blocks enemy shots (and takes their damage), lets own shots through, breaks, expires.
    def barrier_game():
        g = new(2, red=[lo("GUARDIAN"), lo("ASSAULTER")], blue=[lo("ASSAULTER"), lo("GUARDIAN")])
        put(g.players["r0"], 300, 350), put(g.players["r1"], 200, 350)
        put(g.players["b0"], 500, 350), put(g.players["b1"], 900, 100)
        g.step(1000)
        g.ability("r0", 700, 350, 1000)
        return g

    g = barrier_game()
    assert len(g.barriers) == 1 and g.players["r0"].ability_ready_at == 1000 + 14_000
    bar = g.barriers[0]
    assert (bar.w, bar.h, bar.hp, bar.expires_at) == (BARRIER_THICK, BARRIER_LEN, BARRIER_HP, 1000 + 8000)
    assert bar.x < 340 < bar.x + bar.w and bar.team == 0
    g.fire("b0", 300, 350, 1000)  # enemy shot at the Guardian: stopped by the barrier
    run(g, 1000, 1600)
    assert g.players["r0"].hp == 140 and bar.hp == BARRIER_HP - 14 and not g.shots
    g.fire("r1", 700, 350, 1600)  # own shot passes the barrier and hits the enemy behind it
    run(g, 1600, 2400)
    assert g.players["b0"].hp == 85 - 14, g.players["b0"].hp
    for i in range(12):  # keep firing: it breaks at 0 HP and later shots reach the Guardian
        g.fire("b0", 300, 350, 3000 + i * 200)
        run(g, 3000 + i * 200, 3000 + (i + 1) * 200)
    run(g, 5400, 6200)
    assert not g.barriers and g.players["r0"].hp < 140
    # 33 ms ticks and a 100 ms tick never tunnel the thin slab either
    for dt in (33, 100):
        g = barrier_game()
        g.fire("b0", 300, 350, 1000)
        run(g, 1000, 1700, dt)
        assert g.players["r0"].hp == 140 and g.barriers[0].hp == BARRIER_HP - 14, dt
    g = barrier_game()
    run(g, 1000, 1000 + 8000 - 1)
    assert len(g.barriers) == 1
    g.step(1000 + 8000)
    assert not g.barriers, "barrier outlived its lifetime"
    # Nobody is blocked by it, friend or foe.
    g = barrier_game()
    put(g.players["b0"], 380, 350), put(g.players["r1"], 300, 330)
    g.set_keys("b0", {"left": True}), g.set_keys("r1", {"right": True})
    run(g, 1000, 1500)
    assert g.players["b0"].x < 300 and g.players["r1"].x > 380, "a barrier blocked movement"
    # It survives its owner's death, still blocks, and expires normally.
    g = barrier_game()
    g._damage(g.players["r0"], 1100, "b0", 200)
    assert not g.players["r0"].alive and len(g.barriers) == 1
    g.fire("b0", 300, 350, 1200)
    run(g, 1200, 1900)
    assert g.barriers[0].hp == BARRIER_HP - 14
    g.step(1000 + 8000)
    assert not g.barriers
    # Re-casting is only possible after the cooldown, and replaces the old barrier.
    g = barrier_game()
    g.ability("r0", 700, 350, 5000)
    assert g.barriers[0].id == 1, "ability used inside its cooldown"
    g.step(1000 + 14_000)
    g.ability("r0", 700, 350, 1000 + 14_000)
    assert len(g.barriers) == 1 and g.barriers[0].id == 2
    # Placement: backs off from a wall, and is refused (cooldown kept) when it cannot fit at all.
    g = new(1, red=[lo("GUARDIAN")])
    put(g.players["r0"], 200, 300)
    g.ability("r0", 400, 300, 0)
    b = g.barriers[0]
    assert not any(_rects_overlap((b.x, b.y, b.w, b.h), wall) for wall in WALLS) and b.x + b.w > 200
    g = new(1, red=[lo("GUARDIAN")])
    put(g.players["r0"], 216, 210)
    g.ability("r0", 400, 210, 0)
    assert not g.barriers and g.players["r0"].ability_ready_at == 0
    g.ability("r0", 216, 210, 0)  # aiming at yourself is nothing
    assert not g.barriers and g.players["r0"].ability_ready_at == 0

    # Dash: ~160 px whatever the tick size, damageable throughout, stopped by walls, on a cooldown.
    for dt in (500, 33, 10):
        g = new(1, red=[lo("ASSAULTER")])
        put(g.players["r0"], 100, 350)
        g.step(1000)
        g.ability("r0", 700, 350, 1000)
        assert g.players["r0"].ability_ready_at == 6000
        run(g, 1000, 1500, dt)
        assert abs(g.players["r0"].x - 100 - 160) <= 2 and g.players["r0"].y == 350, (dt, g.players["r0"].x)
    g = new(1, red=[lo("ASSAULTER")])
    put(g.players["r0"], 150, 200)
    g.step(1000)
    g.ability("r0", 700, 200, 1000)
    run(g, 1000, 1400, 33)
    assert g.players["r0"].x <= 230 - PLAYER_R + 0.01, "dashed into a wall"
    g = new(1, red=[lo("ASSAULTER")])
    put(g.players["r0"], 450, 350)
    g.set_keys("r0", {"up": True})
    g.step(1000)
    g.ability("r0", 1000, 350, 1000)  # held keys decide the direction
    run(g, 1000, 1500)
    assert g.players["r0"].y < 350 - 150 and abs(g.players["r0"].x - 450) < 1
    g = new(1, red=[lo("ASSAULTER")], blue=[lo("GUARDIAN", "SNIPER_RIFLE")])
    put(g.players["r0"], 100, 30), put(g.players["b0"], 400, 30)  # the top edge has an open lane
    g.step(1000)
    g.ability("r0", 700, 30, 1000)
    g.fire("b0", 100, 30, 1000)  # the round meets the dashing player at about t = 1115
    run(g, 1000, 1080, 20)
    assert g.snapshot(1080)["players"][0]["dashing"], "dash not reported"
    run(g, 1080, 1300, 20)
    assert g.players["r0"].hp == 85 - 70 and g.players["r0"].dash_until is None and not g.snapshot(1300)["players"][0]["dashing"], "damage ignored mid-dash"
    g.ability("r0", 700, 350, 2000)
    assert g.players["r0"].dash_until is None, "dash used inside its cooldown"
    g.ability("r0", 700, 350, 6000)
    assert g.players["r0"].dash_until == 6160

    # Invisibility: enemies get no coordinates, allies and the owner do; every reveal rule holds.
    def sneak(**kw):
        g = new(2, red=[lo("ASSASSIN", "ASSAULT_RIFLE"), lo()], blue=[lo("GUARDIAN"), lo()])
        put(g.players["r0"], 600, 150), put(g.players["b0"], 700, 150)
        g.step(1000)
        g.ability("r0", 0, 0, 1000)
        return g

    g = sneak()
    assert g.players["r0"].invisible_until == 6000 and g.players["r0"].ability_ready_at == 16_000
    foe, ally, full = (next(p for p in g.snapshot(1100, viewer_team=v)["players"] if p["id"] == "r0") for v in (1, 0, None))
    assert foe["x"] is None and foe["y"] is None and foe["hidden"] and not foe["invisible"] and foe["abilityReadyAt"] is None and not foe["dashing"]
    assert ally["x"] == 600 and ally["invisible"] and not ally["hidden"] and ally["abilityReadyAt"] == 16_000
    assert full["x"] == 600 and full["invisible"] and not full["hidden"]
    assert "600" not in repr(g.snapshot(1100, viewer_team=1)["players"][0]), "coordinates leaked"
    assert next(p for p in g.snapshot(1100, viewer_team=0)["players"] if p["id"] == "b0")["abilityReadyAt"] is None  # enemy cooldowns are private
    g.step(5999)
    assert next(p for p in g.snapshot(5999, viewer_team=1)["players"] if p["id"] == "r0")["hidden"]
    g.step(6000)  # expiry reveals
    assert g.players["r0"].invisible_until is None and next(p for p in g.snapshot(6000, viewer_team=1)["players"] if p["id"] == "r0")["x"] == 600
    g = sneak()  # any positive damage reveals; zero does not
    g._damage(g.players["r0"], 1100, "b0", 0)
    assert g.players["r0"].invisible_until is not None
    g._damage(g.players["r0"], 1100, "b0", 1)
    assert g.players["r0"].invisible_until is None and next(p for p in g.snapshot(1100, viewer_team=1)["players"] if p["id"] == "r0")["x"] == 600
    g = sneak()  # a hidden player can still be shot, and the hit reveals it
    g.fire("b0", 600, 150, 1100)
    run(g, 1100, 1300)
    assert g.players["r0"].hp == 100 - 14 and g.players["r0"].invisible_until is None
    g = sneak()  # firing reveals before the shot exists, so no frame has a hidden shooter next to a shot
    g.fire("r0", 700, 150, 1100)
    snap = g.snapshot(1100, viewer_team=1)
    assert g.shots and next(p for p in snap["players"] if p["id"] == "r0")["x"] == 600 and not any(p["hidden"] for p in snap["players"])
    g = sneak()  # picking up the enemy flag reveals
    put(g.players["r0"], *BASES[1])
    g.step(1200)
    assert g.players["r0"].carrying_flag and g.players["r0"].invisible_until is None
    g.ability("r0", 0, 0, 20_000)  # ...and invisibility cannot start while carrying (nothing is spent)
    assert g.players["r0"].invisible_until is None and g.players["r0"].ability_ready_at == 16_000
    g = sneak()  # death clears it and keeps the cooldown
    g._damage(g.players["r0"], 1100, "b0", 500)
    assert g.players["r0"].invisible_until is None and g.players["r0"].ability_ready_at == 16_000
    g.step(1100 + RESPAWN_MS)
    assert g.players["r0"].alive and g.players["r0"].invisible_until is None and g.players["r0"].ability_ready_at == 16_000
    g = sneak()  # the match end shows everybody
    g.over, g.winner, g.capturer = True, 0, "r1"
    assert not any(p["hidden"] for p in g.snapshot(1100, viewer_team=1)["players"])

    # Checkpoint round-trip: mid-match state (carrier, dropped flag, dead player) survives.
    g = new(2)
    r0, b0, b1 = g.players["r0"], g.players["b0"], g.players["b1"]
    put(r0, *BASES[1])
    g.step(10)  # r0 carries blue flag
    put(b1, *BASES[0])
    g.step(20)  # b1 carries red flag
    g._damage(b1, 30, None, 85)  # red flag dropped, b1 dead
    cp = g.checkpoint(40)
    h = Game.restore(cp, 5000)
    assert h.checkpoint(40) == cp
    assert h.flags[0].dropped_at == 30 and h.players["b1"].respawn_at == 30 + RESPAWN_MS and h.players["r0"].carrying_flag
    h.step(5000)  # downtime elapsed: b1 respawns, dropped flag timer keeps running from the checkpoint clock
    assert h.players["b1"].alive and h.flags[0].state == "DROPPED" and not h.ended
    bad = dict(cp, players=[dict(p, carryingFlag=False) for p in cp["players"]])
    try:
        Game.restore(bad, 0)
        raise AssertionError("inconsistent checkpoint accepted")
    except ValueError:
        pass

    # ...including classes, weapons, cooldowns, invisibility and barriers.
    g = barrier_game()
    g.fire("b0", 300, 350, 1100)
    run(g, 1100, 1700)
    g.ability("r1", 700, 350, 1700)  # an Assaulter dash (not persisted)
    g.ability("b1", 600, 600, 1700)
    cp = g.checkpoint(1700)
    assert cp["barriers"][0]["hp"] == BARRIER_HP - 14 and cp["players"][0]["class"] == "GUARDIAN" and cp["players"][0]["abilityReadyAt"] == 15_000
    h = Game.restore(cp, 9000)
    assert h.checkpoint(1700) == cp and h.players["r0"].pclass == "GUARDIAN" and h.barriers[0].hp == BARRIER_HP - 14 and h._barrier_id == g._barrier_id
    assert h.players["r1"].dash_until is None
    g = sneak()
    cp = g.checkpoint(1500)
    h = Game.restore(cp, 1500)
    assert h.checkpoint(1500) == cp and h.players["r0"].invisible_until == 6000 and h.players["r0"].ability_ready_at == 16_000
    assert next(p for p in h.snapshot(1500, viewer_team=1)["players"] if p["id"] == "r0")["x"] is None, "restored Assassin is visible"
    h.step(6001)
    assert h.players["r0"].invisible_until is None
    # Checkpoints written before loadouts existed still load (default loadout, HP clamped to it).
    old = g.checkpoint(1500)
    for d in old["players"]:
        for k in ("class", "weapon", "abilityReadyAt", "invisibleUntil"):
            del d[k]
        d["hp"] = 100
    del old["barriers"], old["barrierSeq"]
    h = Game.restore(old, 1600)
    assert all(p.pclass == "ASSAULTER" and p.weapon == "ASSAULT_RIFLE" and p.hp == 85 for p in h.players.values()) and not h.barriers
    for mangle in (lambda c: c["players"][0].update({"class": "WIZARD"}), lambda c: c["players"][0].update({"weapon": "BAZOOKA"}),
                   lambda c: c["barriers"][0].update({"team": "BLUE"}), lambda c: c["barriers"][0].update({"owner": "ghost"})):
        cp = barrier_game().checkpoint(1300)
        mangle(cp)
        try:
            Game.restore(cp, 0)
            raise AssertionError("corrupt checkpoint accepted")
        except ValueError:
            pass

    # Movement is server-side and blocked by walls.
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    x0 = r0.x
    g.set_keys("r0", {"right": True})
    g.step(100)
    assert r0.x > x0
    g.set_keys("r0", {})
    # Walking is one wall check per normal tick, as before dashes existed: a 7.3 px step that would touch the
    # wall (230, 140, 40, 140) is refused whole, not split into a half step that gets closer.
    g = new()
    put(g.players["r0"], 210, 200)
    g.set_keys("r0", {"right": True})
    g.step(33)
    assert g.players["r0"].x == 210, g.players["r0"].x
    # ...and a long tick (a server hitch) is still split, so walking never tunnels through a wall.
    g = new()
    put(g.players["r0"], 150, 200)
    g.set_keys("r0", {"right": True})
    g.step(1000)
    assert g.players["r0"].x <= 230 - PLAYER_R, g.players["r0"].x

    # Kills: the default Assaulter (85 HP) dies to 7 rifle hits; the dead can't shoot; kill credit is the shooter's.
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    put(r0, 600, 150), put(b0, 700, 150)
    t = 0
    g.fire("r0", 700, 150, t)
    g.fire("r0", 700, 150, t + 100)  # on cooldown (128 ms for an Assaulter)
    assert len(g.shots) == 1
    for i in range(7):
        t = 1000 * (i + 1)
        g.fire("r0", b0.x, b0.y, t)
        for k in range(1, 11):
            g.step(t + 20 * k)
    assert b0.hp == 0 and not b0.alive and b0.respawn_at is not None
    assert g.snapshot(t)["players"][1]["killedBy"] == "r0"  # kill feed attribution comes from the server
    assert (r0.kills, r0.deaths, b0.kills, b0.deaths) == (1, 0, 0, 1)  # the kill is credited to the shooter only
    with_stats = g.snapshot(t)["players"]
    assert (with_stats[0]["kills"], with_stats[1]["deaths"]) == (1, 1)
    assert r0.alive and r0.hp == 85
    g.fire("b0", r0.x, r0.y, t + 1000)  # dead cannot shoot
    assert not g.shots
    g.step(b0.respawn_at)
    assert b0.alive and b0.hp == 85 and b0.killed_by is None and (b0.x, b0.y) == SPAWNS[1][0]

    # Pickup: own flag cannot be picked up; enemy flag can.
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    put(b0, *BASES[1])
    g.step(10)
    assert g.flags[1].state == "AT_BASE" and not b0.carrying_flag
    put(r0, *BASES[1])
    g.step(20)
    assert g.flags[1].state == "CARRIED" and g.flags[1].carrier_id == "r0" and r0.carrying_flag

    # Death drops flag at death position; own team touching it returns it home.
    put(r0, 800, 350)
    g.step(30)
    g._damage(r0, 40, None, r0.hp)
    f = g.flags[1]
    assert f.state == "DROPPED" and (f.x, f.y) == (800, 350) and f.carrier_id is None and not r0.carrying_flag
    put(b0, 800, 350)
    g.step(50)
    assert f.state == "AT_BASE" and (f.x, f.y) == BASES[1]

    # Auto-return after 10 s untouched.
    g = new()
    f = g.flags[0]
    f.state, f.x, f.y, f.dropped_at = "DROPPED", 600, 50, 0
    g.step(FLAG_RETURN_MS - 1)
    assert f.state == "DROPPED"
    g.step(FLAG_RETURN_MS)
    assert f.state == "AT_BASE"

    # Capture blocked while own flag is away; valid once it is home.
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    put(r0, *BASES[1])
    g.step(10)  # red carries blue flag
    put(b0, *BASES[0])
    g.step(20)  # blue carries red flag
    put(r0, BASES[0][0] + 30, BASES[0][1])
    put(b0, 600, 50)
    g.step(30)
    assert not g.ended, "captured while own flag away"
    g._damage(b0, 40, None, b0.hp)  # red flag dropped at b0
    r2 = g.players["r0"]
    put(r2, 600, 50)  # red carrier returns own flag by touching it (still carrying blue)
    g.step(50)
    assert g.flags[0].state == "AT_BASE" and r2.carrying_flag
    put(r2, *BASES[0])
    g.step(60)
    assert not g.ended and g.scores == [1, 0] and g.round_winner == 0 and g.resume_at == 60 + INTERMISSION_MS
    assert r2.captures == 1 and b0.captures == 0 and b0.deaths == 1 and b0.kills == 0  # b0 died to _damage with no killer
    snap = g.snapshot(60, {"r0"})
    assert snap["scores"] == {"RED": 1, "BLUE": 0} and snap["roundWinner"] == "RED" and snap["resumesAt"] == g.resume_at
    assert [p["connected"] for p in snap["players"]] == [True, False]

    # Intermission freezes the sim (no moves, shots or Q); then the arena resets for the next round.
    g.set_keys("r0", {"up": True})
    y = r2.y
    g.step(1000)
    g.fire("b0", 0, 0, 1000)
    g.ability("r0", 0, 0, 1000)
    assert r2.y == y and not g.shots and g.round == 1
    g.set_keys("r0", {})
    g.step(60 + INTERMISSION_MS)
    assert g.round == 2 and g.resume_at is None and g.round_winner is None and g.scores == [1, 0]
    assert all(f.state == "AT_BASE" for f in g.flags) and not r2.carrying_flag and (r2.x, r2.y) == SPAWNS[0][0]

    # Stats: a kill counts for the shooter, a death for the victim; rating = 2*captures + K/D.
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    assert rating(r0) == 0
    g._damage(b0, 10, "r0", b0.hp)
    assert (r0.kills, b0.deaths, b0.kills) == (1, 1, 0) and rating(r0) == 1.0 and rating(b0) == 0
    r0.captures = 2
    assert rating(r0) == 5.0
    p0 = g.snapshot(10)["players"][0]
    assert (p0["captures"], p0["kills"], p0["deaths"], p0["rating"]) == (2, 1, 0, 5.0)

    def cap(g, team, now):
        """Team `team` captures: its player steps on the enemy flag, then onto its own base."""
        p = next(q for q in g.players.values() if q.team == team)
        p.x, p.y = BASES[1 - team]
        g.step(now + 1)
        p.x, p.y = BASES[team]
        g.step(now + 2)

    # First to ROUNDS_TO_WIN ends the match immediately, with a winner; nothing moves or fires after.
    g = new()
    t = 0
    for _ in range(ROUNDS_TO_WIN - 1):
        cap(g, 0, t)
        assert not g.ended
        t += 10_000
        g.step(t)  # intermission over
    cap(g, 0, t)
    assert g.ended and g.winner == 0 and g.scores == [ROUNDS_TO_WIN, 0] and g.snapshot(t)["winner"] == "RED"
    assert g.players["r0"].captures == ROUNDS_TO_WIN
    g.set_keys("r0", {"up": True})
    y = g.players["r0"].y
    g.step(t + 5000)
    g.fire("b0", 0, 0, t + 5000)
    g.ability("r0", 0, 0, t + 5000)
    assert g.players["r0"].y == y and not g.shots  # nothing moves after the end

    # result(): what history and career stats read. Class and weapon are kept; a draw is a TIE for everyone.
    res = g.result(t + 1000)
    assert res["winner"] == "RED" and res["scores"] == {"RED": ROUNDS_TO_WIN, "BLUE": 0} and res["capturer"] == "r0"
    assert [(p["id"], p["outcome"], p["captures"], p["deaths"]) for p in res["players"]] == [("r0", "WIN", ROUNDS_TO_WIN, 0), ("b0", "LOSS", 0, 0)]
    assert all(p["class"] == "ASSAULTER" and p["weapon"] == "ASSAULT_RIFLE" for p in res["players"])
    assert Game.restore(g.checkpoint(t), t + 100).result(t + 1000) == res  # stats survive a restart, even on an ended match
    old = g.checkpoint(t)
    for d in old["players"]:
        for k in ("kills", "deaths", "captures"):
            del d[k]
    assert Game.restore(old, t + 100).players["r0"].captures == 0  # checkpoints written before stats existed still load

    # Regulation: the higher score at MATCH_MS wins, and the unfinished round is discarded.
    g = new()
    cap(g, 1, 0)
    g.step(MATCH_MS - 1)
    assert not g.ended
    g.step(MATCH_MS)
    assert g.ended and TEAMS[g.winner] == "BLUE" and g.decided_by == "SCORE" and g.snapshot(MATCH_MS)["elapsed"] == MATCH_MS

    # Level at MATCH_MS: sudden death. Nobody respawns (already dead players included); the next capture wins.
    g = new(2)
    cap(g, 0, 0)
    g.step(10_000)
    cap(g, 1, 20_000)
    g.step(30_000)
    r1, b1 = g.players["r1"], g.players["b1"]
    g._damage(r1, MATCH_MS - 1000, "b1", r1.hp)  # due back at MATCH_MS + 2000
    g.step(MATCH_MS)
    s = g.snapshot(MATCH_MS)
    assert not g.ended and g.sudden_death and s["suddenDeath"] and s["state"] == "PLAYING" and s["hardStopMs"] == HARD_STOP_MS
    assert r1.respawn_at is None
    g.step(MATCH_MS + 5000)
    assert not r1.alive, "respawned in sudden death"
    g._damage(b1, MATCH_MS + 5000, "r0", b1.hp)
    assert b1.respawn_at is None and g.snapshot(MATCH_MS + 5000)["players"][3]["respawnAt"] is None
    cap(g, 1, MATCH_MS + 6000)  # b0 is still up
    assert g.ended and g.winner == 1 and g.decided_by == "SUDDEN_DEATH" and g.scores == [1, 2] and g.round == 3
    res = g.result(MATCH_MS + 7000)
    assert res["winner"] == "BLUE" and res["decided_by"] == "SUDDEN_DEATH"

    # A capture's intermission running into MATCH_MS: the next round still starts with everyone up, in sudden death.
    g = new()
    cap(g, 0, 0)
    g.step(10_000)
    cap(g, 1, MATCH_MS - 2000)
    g._damage(g.players["r0"], MATCH_MS - 1000, None, 999)  # cannot happen while frozen; the reset must cover it anyway
    g.step(MATCH_MS)
    assert g.sudden_death and g.resume_at is not None
    g.step(MATCH_MS + INTERMISSION_MS)
    assert all(p.alive for p in g.players.values()) and g.resume_at is None and not g.ended

    # HARD_STOP_MS, still level: objective progress first (furthest carry this round, a pickup counts as 1 %).
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    r0.x, r0.y = BASES[1]
    g.step(100)
    assert g.progress == [1, 0]
    r0.x = BASES[1][0] - 245  # a quarter of the way home
    g.step(200)
    assert g.progress == [25, 0]
    g._damage(r0, 300, "b0", r0.hp)  # dropped; progress stays, and blue has more kills
    g.step(HARD_STOP_MS - 1)
    assert not g.ended and g.sudden_death
    g.step(HARD_STOP_MS)
    s = g.snapshot(HARD_STOP_MS)
    assert g.ended and g.winner == 0 and g.decided_by == "OBJECTIVE" and s["decidedBy"] == "OBJECTIVE" and s["progress"] == {"RED": 25, "BLUE": 0}
    res = g.result(HARD_STOP_MS)
    assert res["progress"] == {"RED": 25, "BLUE": 0} and res["team_kills"] == {"RED": 0, "BLUE": 1}
    assert [p["outcome"] for p in res["players"]] == ["WIN", "LOSS"]
    h = Game.restore(g.checkpoint(HARD_STOP_MS), HARD_STOP_MS + 10)
    assert h.ended and h.winner == 0 and h.decided_by == "OBJECTIVE" and h.result(HARD_STOP_MS) == res

    # A new round wipes progress: only the round in play counts.
    g = new()
    g.players["b0"].x, g.players["b0"].y = BASES[0]
    g.step(100)
    assert g.progress == [0, 1]
    g._new_round()
    assert g.progress == [0, 0]

    # Progress level: more kills wins. Everything level: a draw, a TIE in the stored result.
    g = new()
    g._damage(g.players["r0"], 100, "b0", 999)
    g.step(MATCH_MS)
    assert g.sudden_death and not g.players["r0"].alive
    g.step(HARD_STOP_MS)
    assert g.ended and g.winner == 1 and g.decided_by == "KILLS"
    g = new()
    g.step(MATCH_MS)
    p = Game.restore(g.checkpoint(MATCH_MS + 10), MATCH_MS + 10)  # sudden death survives a restart
    assert p.sudden_death and not p.ended
    g.step(HARD_STOP_MS)
    s = g.snapshot(HARD_STOP_MS)
    assert g.ended and g.winner is None and g.decided_by == "DRAW" and s["winner"] is None and s["decidedBy"] == "DRAW"
    res = g.result(HARD_STOP_MS)
    assert res["winner"] == "TIE" and res["decided_by"] == "DRAW" and {p["outcome"] for p in res["players"]} == {"TIE"}
    g = new()
    g.step(HARD_STOP_MS + 50_000)  # a server back from a long outage: straight to the tiebreak, never past it
    assert g.ended and g.decided_by == "DRAW"
    g = new()
    cap(g, 0, 0)
    g.step(HARD_STOP_MS)  # level never happened: the score still decides even if the clock jumps past both marks
    assert g.ended and g.winner == 0 and g.decided_by == "SCORE"

    # Checkpoint keeps score, round, stats, intermission; an ENDED checkpoint restores as ended.
    g = new()
    cap(g, 0, 0)
    g.players["b0"].deaths = 3
    cp = g.checkpoint(100)
    h = Game.restore(cp, 200)
    assert h.scores == [1, 0] and h.resume_at == g.resume_at and h.round_winner == 0 and h.players["r0"].captures == 1 and h.players["b0"].deaths == 3
    g.step(MATCH_MS)
    h = Game.restore(g.checkpoint(MATCH_MS), MATCH_MS)
    assert h.ended and h.winner == 0
    print("sim ok")
