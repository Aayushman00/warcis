"""Capture The Flag simulation. Pure logic: no I/O, time is passed in (ms), so the
server stays authoritative and the rules are testable. Self-check: python -m app.sim

Team 0 = RED (left), team 1 = BLUE (right). First valid capture ends the match.
"""

import math
from dataclasses import dataclass, field

TEAMS = ("RED", "BLUE")
W, H = 1200, 700
PLAYER_R = 14
SPEED = 220  # px/s
HP = 100
DAMAGE = 25
FIRE_COOLDOWN_MS = 500
SHOT_SPEED = 650  # px/s
SHOT_R = 4
SHOT_TTL_MS = 1500
RESPAWN_MS = 3000
FLAG_RETURN_MS = 10_000
TOUCH = PLAYER_R + 12  # player-to-flag pickup distance
BASE_R = 60

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


@dataclass
class Player:
    id: str
    name: str
    team: int
    x: float = 0.0
    y: float = 0.0
    hp: int = HP
    alive: bool = True
    respawn_at: int | None = None
    carrying_flag: bool = False
    keys: dict = field(default_factory=lambda: {"up": False, "down": False, "left": False, "right": False})
    last_fire: int = -FIRE_COOLDOWN_MS


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


def _hits_wall(x: float, y: float, r: float) -> bool:
    if x < r or y < r or x > W - r or y > H - r:
        return True
    for wx, wy, ww, wh in WALLS:
        cx, cy = min(max(x, wx), wx + ww), min(max(y, wy), wy + wh)
        if (x - cx) ** 2 + (y - cy) ** 2 < r * r:
            return True
    return False


def _seg_dist2(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2


class Game:
    def __init__(self, teams: list[list[dict]], now: int):
        """teams: [[{id, name}, ...] RED, [...] BLUE], straight from the match document."""
        self.players: dict[str, Player] = {}
        for t, roster in enumerate(teams):
            for i, p in enumerate(roster):
                pl = Player(p["id"], p.get("name", ""), t)
                self._spawn(pl, i)
                self.players[pl.id] = pl
        self.flags = [Flag(t, *BASES[t]) for t in (0, 1)]
        self.shots: list[Shot] = []
        self._shot_id = 0
        self.started = now
        self.last = now
        self.winner: int | None = None
        self.capturer: str | None = None

    def _spawn(self, p: Player, slot: int | None = None) -> None:
        if slot is None:
            slot = [q.id for q in self.players.values() if q.team == p.team].index(p.id)
        p.x, p.y = SPAWNS[p.team][slot % len(SPAWNS[p.team])]
        p.hp, p.alive, p.respawn_at, p.carrying_flag = HP, True, None, False

    @property
    def ended(self) -> bool:
        return self.winner is not None

    # ─────────────── intents from clients ───────────────

    def set_keys(self, pid: str, keys: dict) -> None:
        p = self.players.get(pid)
        if p:
            p.keys = {k: bool(keys.get(k)) for k in p.keys}

    def fire(self, pid: str, ax: float, ay: float, now: int) -> None:
        """Client sends only where it aims; origin, cooldown and direction are server-side."""
        p = self.players.get(pid)
        if not p or not p.alive or self.ended or now - p.last_fire < FIRE_COOLDOWN_MS:
            return
        dx, dy = ax - p.x, ay - p.y
        d = math.hypot(dx, dy)
        if d < 1e-6:
            return
        p.last_fire = now
        self._shot_id += 1
        self.shots.append(Shot(self._shot_id, p.id, p.team, p.x, p.y, dx / d * SHOT_SPEED, dy / d * SHOT_SPEED, now))

    # ─────────────── simulation ───────────────

    def step(self, now: int) -> None:
        dt = max(0, now - self.last) / 1000
        self.last = now
        if self.ended:
            return
        for p in self.players.values():
            if not p.alive and p.respawn_at is not None and now >= p.respawn_at:
                self._spawn(p)
        for p in self.players.values():
            if p.alive:
                self._move(p, dt)
        self._shots(dt, now)
        self._flags(now)

    def _move(self, p: Player, dt: float) -> None:
        k = p.keys
        dx, dy = k["right"] - k["left"], k["down"] - k["up"]
        if not dx and not dy:
            return
        n = math.hypot(dx, dy)
        step = SPEED * dt / n
        # Axis-separated so players slide along walls instead of sticking.
        if not _hits_wall(p.x + dx * step, p.y, PLAYER_R):
            p.x += dx * step
        if not _hits_wall(p.x, p.y + dy * step, PLAYER_R):
            p.y += dy * step

    def _shots(self, dt: float, now: int) -> None:
        live = []
        for s in self.shots:
            nx, ny = s.x + s.vx * dt, s.y + s.vy * dt
            victim = next(
                (
                    p
                    for p in self.players.values()
                    if p.alive and p.team != s.team and _seg_dist2(p.x, p.y, s.x, s.y, nx, ny) <= (PLAYER_R + SHOT_R) ** 2
                ),
                None,
            )
            if victim:
                self._damage(victim, now)
            elif not _hits_wall(nx, ny, SHOT_R) and now - s.born < SHOT_TTL_MS:
                s.x, s.y = nx, ny
                live.append(s)
        self.shots = live

    def _damage(self, p: Player, now: int) -> None:
        p.hp -= DAMAGE
        if p.hp > 0:
            return
        p.hp, p.alive, p.respawn_at = 0, False, now + RESPAWN_MS
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
            if p.carrying_flag:
                enemy.x, enemy.y = p.x, p.y
                bx, by = BASES[p.team]
                # Capture only while our own flag is safely home.
                if own.state == "AT_BASE" and math.hypot(p.x - bx, p.y - by) <= BASE_R:
                    self.winner = p.team
                    self.capturer = p.id
                    return

    def _return(self, f: Flag) -> None:
        f.state, f.carrier_id, f.dropped_at = "AT_BASE", None, None
        f.x, f.y = BASES[f.team]

    # ─────────────── broadcast ───────────────

    def snapshot(self, now: int) -> dict:
        r = lambda v: round(v, 1)  # noqa: E731
        return {
            "t": "state",
            "now": now,
            "elapsed": now - self.started,
            "state": "ENDED" if self.ended else "PLAYING",
            "winner": TEAMS[self.winner] if self.ended else None,
            "players": [
                {
                    "id": p.id,
                    "name": p.name,
                    "team": TEAMS[p.team],
                    "x": r(p.x),
                    "y": r(p.y),
                    "hp": p.hp,
                    "alive": p.alive,
                    "respawnAt": p.respawn_at,
                    "carryingFlag": p.carrying_flag,
                }
                for p in self.players.values()
            ],
            "flags": [
                {"team": TEAMS[f.team], "x": r(f.x), "y": r(f.y), "state": f.state, "carrierId": f.carrier_id} for f in self.flags
            ],
            "shots": [{"id": s.id, "team": TEAMS[s.team], "x": r(s.x), "y": r(s.y)} for s in self.shots],
        }


MAP = {
    "w": W,
    "h": H,
    "walls": WALLS,
    "bases": [{"team": TEAMS[t], "x": x, "y": y, "r": BASE_R} for t, (x, y) in enumerate(BASES)],
    "playerR": PLAYER_R,
    "shotR": SHOT_R,
}


if __name__ == "__main__":  # self-check: python -m app.sim
    for t in (0, 1):
        for x, y in SPAWNS[t]:
            assert not _hits_wall(x, y, PLAYER_R), "spawn inside wall"

    def new(n=1):
        return Game([[{"id": f"r{i}"} for i in range(n)], [{"id": f"b{i}"} for i in range(n)]], 0)

    # Same rules for 1v1 / 2v2 / 4v4: everyone spawns alive at full HP.
    for n in (1, 2, 4):
        g = new(n)
        assert len(g.players) == 2 * n and all(p.alive and p.hp == HP for p in g.players.values())

    # Movement is server-side and blocked by walls.
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    x0 = r0.x
    g.set_keys("r0", {"right": True})
    g.step(100)
    assert r0.x > x0
    g.set_keys("r0", {})

    # Fire cooldown and damage: 4 hits kill, dead player drops nothing if not carrying.
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    r0.x, r0.y, b0.x, b0.y = 600, 150, 700, 150
    t = 0
    g.fire("r0", 700, 150, t)
    g.fire("r0", 700, 150, t + 100)  # on cooldown
    assert len(g.shots) == 1
    for i in range(4):
        t = 1000 * (i + 1)
        g.fire("r0", b0.x, b0.y, t)
        for k in range(1, 11):
            g.step(t + 20 * k)
    assert b0.hp == 0 and not b0.alive and b0.respawn_at is not None
    assert r0.alive and r0.hp == HP
    g.fire("b0", r0.x, r0.y, t + 1000)  # dead cannot shoot
    assert not g.shots
    g.step(b0.respawn_at)
    assert b0.alive and b0.hp == HP and (b0.x, b0.y) == SPAWNS[1][0]

    # Pickup: own flag cannot be picked up; enemy flag can.
    g = new()
    r0, b0 = g.players["r0"], g.players["b0"]
    b0.x, b0.y = BASES[1]
    g.step(10)
    assert g.flags[1].state == "AT_BASE" and not b0.carrying_flag
    r0.x, r0.y = BASES[1]
    g.step(20)
    assert g.flags[1].state == "CARRIED" and g.flags[1].carrier_id == "r0" and r0.carrying_flag

    # Death drops flag at death position; own team touching it returns it home.
    r0.x, r0.y = 800, 350
    g.step(30)
    r0.hp = DAMAGE
    g._damage(r0, 40)
    f = g.flags[1]
    assert f.state == "DROPPED" and (f.x, f.y) == (800, 350) and f.carrier_id is None and not r0.carrying_flag
    b0.x, b0.y = 800, 350
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
    r0.x, r0.y = BASES[1]
    g.step(10)  # red carries blue flag
    b0.x, b0.y = BASES[0]
    g.step(20)  # blue carries red flag
    r0.x, r0.y = BASES[0][0] + 30, BASES[0][1]
    b0.x, b0.y = 600, 50
    g.step(30)
    assert not g.ended, "captured while own flag away"
    b0.hp = DAMAGE
    g._damage(b0, 40)  # red flag dropped at b0
    r2 = g.players["r0"]
    r2.x, r2.y = 600, 50  # red carrier returns own flag by touching it (still carrying blue)
    g.step(50)
    assert g.flags[0].state == "AT_BASE" and r2.carrying_flag
    r2.x, r2.y = BASES[0]
    g.step(60)
    assert g.ended and TEAMS[g.winner] == "RED" and g.snapshot(60)["winner"] == "RED"

    # After the end nothing moves or fires.
    g.set_keys("r0", {"up": True})
    y = r2.y
    g.step(1000)
    g.fire("b0", 0, 0, 5000)
    assert r2.y == y and not g.shots
    print("sim ok")
