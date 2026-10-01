"""Bot brain for the CTF demo. Pure decision logic: snapshot in -> intents out.

Bots play through the same WebSocket protocol as the browser ({"t":"input"} held keys,
{"t":"fire", x, y} aim point), so the server applies exactly the same rules, cooldown
and damage to them. Self-check: python scripts/bot_ai.py

Priorities (first that applies wins):
  1/2. enemy carries our flag      -> chase the carrier
  3.   our flag is dropped         -> go touch it (server returns it)
  4.   our flag is home            -> attackers go for the enemy flag, carrier heads home
                                     (one bot per team defends instead and circles its base)
  5.   an enemy is visible          -> close in on the nearest one
  6.   nothing to do               -> patrol own side / midfield
Shooting runs alongside movement: nearest visible enemy, after a short reaction delay,
with a little aim error.
"""

import math
import random
from collections import deque

CELL = 20
SIGHT = 520  # px: bots don't snipe across the whole map
REACTION_S = 0.3
AIM_SD = 0.06  # radians of aim noise
FIRE_GAP_S = (0.55, 0.75)  # server cooldown is 0.5 s; bots don't hit it frame-perfectly


class Brain:
    def __init__(self, me: str, gmap: dict, rng: random.Random | None = None):
        self.me, self.map, self.rng = me, gmap, rng or random.Random()
        self.w, self.h, self.r = gmap["w"], gmap["h"], gmap["playerR"]
        self.cols, self.rows = self.w // CELL, self.h // CELL
        self.free = [[not self._blocked((c + 0.5) * CELL, (r + 0.5) * CELL) for c in range(self.cols)] for r in range(self.rows)]
        self.keys: dict = {}
        self.path: list[tuple[float, float]] = []
        self.goal: tuple[float, float] | None = None
        self.repath_at = 0.0
        self.seen: dict[str, float] = {}  # enemy id -> when it came into view
        self.next_fire = 0.0
        self.patrol: tuple[float, float] | None = None
        self.patrol_until = 0.0
        self.stuck_at, self.stuck_pos, self.jitter_until, self.jitter = 0.0, (0.0, 0.0), 0.0, {}

    # ─────────────── geometry ───────────────

    def _blocked(self, x: float, y: float, pad: float | None = None) -> bool:
        r = self.r + 2 if pad is None else pad
        if x < r or y < r or x > self.w - r or y > self.h - r:
            return True
        return any(wx - r < x < wx + ww + r and wy - r < y < wy + wh + r for wx, wy, ww, wh in self.map["walls"])

    def clear(self, a, b, pad: float | None = None, step: float = 8) -> bool:
        """Straight segment a->b stays out of walls (inflated by pad)."""
        n = max(1, int(math.dist(a, b) / step))
        return not any(self._blocked(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, pad) for i in range(n + 1))

    def _cell(self, x, y):
        return min(self.cols - 1, max(0, int(x // CELL))), min(self.rows - 1, max(0, int(y // CELL)))

    def _nearest_free(self, c, r):
        for rad in range(0, 6):
            for dc in range(-rad, rad + 1):
                for dr in range(-rad, rad + 1):
                    cc, rr = c + dc, r + dr
                    if 0 <= cc < self.cols and 0 <= rr < self.rows and self.free[rr][cc]:
                        return cc, rr
        return c, r

    def find_path(self, a, b) -> list[tuple[float, float]]:
        """BFS on a 20 px grid (walls inflated by the player radius), then string-pulled."""
        start, goal = self._nearest_free(*self._cell(*a)), self._nearest_free(*self._cell(*b))
        prev = {start: None}
        q = deque([start])
        while q:
            cur = q.popleft()
            if cur == goal:
                break
            c, r = cur
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                n = (c + dc, r + dr)
                if n in prev or not (0 <= n[0] < self.cols and 0 <= n[1] < self.rows) or not self.free[n[1]][n[0]]:
                    continue
                if dc and dr and not (self.free[r][c + dc] and self.free[r + dr][c]):
                    continue  # no corner cutting
                prev[n] = cur
                q.append(n)
        if goal not in prev:
            return [b]
        cells, cur = [], goal
        while cur:
            cells.append(((cur[0] + 0.5) * CELL, (cur[1] + 0.5) * CELL))
            cur = prev[cur]
        cells.reverse()
        cells[-1] = b if not self._blocked(*b) else cells[-1]
        cells[0] = a if not self._blocked(*a) else cells[0]  # pull from where we really are, not the cell centre
        out, i = [], 0
        while i < len(cells) - 1:  # keep the farthest waypoint we can walk to in a straight line
            j = len(cells) - 1
            while j > i + 1 and not self.clear(cells[i], cells[j]):
                j -= 1
            out.append(cells[j])
            i = j
        return out or [b]

    # ─────────────── decision ───────────────

    def think(self, s: dict, now: float) -> list[dict]:
        players = {p["id"]: p for p in s["players"]}
        me = players.get(self.me)
        if not me or s["state"] != "PLAYING":
            return self._set_keys({})
        if not me["alive"]:
            self.path, self.goal, self.seen = [], None, {}
            return self._set_keys({})
        team = me["team"]
        pos = (me["x"], me["y"])
        own = next(f for f in s["flags"] if f["team"] == team)
        enemy_flag = next(f for f in s["flags"] if f["team"] != team)
        base = next((b["x"], b["y"]) for b in self.map["bases"] if b["team"] == team)
        # One defender per team (second bot by id); more than that stalemates 4v4 (defenders +
        # spawns next to base). Chosen among bots so a human never "takes" the defender slot.
        mates = sorted(p["id"] for p in s["players"] if p["team"] == team and p.get("bot"))
        if self.me not in mates:
            mates = sorted(p["id"] for p in s["players"] if p["team"] == team)
        attacker = mates.index(self.me) != 1
        enemies = [p for p in s["players"] if p["team"] != team and p["alive"]]
        visible = [e for e in enemies if math.dist(pos, (e["x"], e["y"])) <= SIGHT and self.clear(pos, (e["x"], e["y"]), pad=4, step=10)]
        vis_ids = {e["id"] for e in visible}
        self.seen = {i: self.seen.get(i, now) for i in vis_ids}

        if own["state"] == "CARRIED":
            goal = (own["x"], own["y"])  # 1/2: stop the carrier
        elif own["state"] == "DROPPED":
            goal = (own["x"], own["y"])  # 3: recover
        elif me["carryingFlag"]:
            goal = base  # 4: bring it home
        elif attacker and enemy_flag["state"] != "CARRIED":
            goal = (enemy_flag["x"], enemy_flag["y"])  # 4: go steal
        elif enemy_flag["state"] == "CARRIED" and enemy_flag["carrierId"] != self.me and attacker:
            goal = (enemy_flag["x"], enemy_flag["y"])  # escort our carrier
        elif visible:
            e = min(visible, key=lambda e: math.dist(pos, (e["x"], e["y"])))
            goal = (e["x"], e["y"])  # 5: fight
        else:
            goal = self._patrol(team, base if not attacker else None, now)  # 6
        out = self._steer(pos, goal, now)

        target = min(visible, key=lambda e: (not e["carryingFlag"], math.dist(pos, (e["x"], e["y"]))), default=None)
        if target and now - self.seen[target["id"]] >= REACTION_S and now >= self.next_fire:
            ang = math.atan2(target["y"] - pos[1], target["x"] - pos[0]) + self.rng.gauss(0, AIM_SD)
            d = math.dist(pos, (target["x"], target["y"]))
            out.append({"t": "fire", "x": round(pos[0] + math.cos(ang) * d, 1), "y": round(pos[1] + math.sin(ang) * d, 1)})
            self.next_fire = now + self.rng.uniform(*FIRE_GAP_S)
        return out

    def _patrol(self, team: str, guard, now: float):
        """Defenders circle their own base; everyone else roams own side / midfield."""
        if self.patrol is None or now > self.patrol_until:
            for _ in range(20):
                if guard:
                    ang, rad = self.rng.uniform(0, 2 * math.pi), self.rng.uniform(70, 200)
                    x, y = guard[0] + math.cos(ang) * rad, guard[1] + math.sin(ang) * rad
                else:
                    x = self.rng.uniform(160, self.w / 2 + 60)
                    x = x if team == "RED" else self.w - x
                    y = self.rng.uniform(60, self.h - 60)
                if not self._blocked(x, y):
                    break
            self.patrol, self.patrol_until = (x, y), now + self.rng.uniform(2.5, 5)
        return self.patrol

    def _steer(self, pos, goal, now: float) -> list[dict]:
        if self.goal is None or math.dist(goal, self.goal) > 40 or now >= self.repath_at or not self.path:
            self.goal, self.path, self.repath_at = goal, self.find_path(pos, goal), now + 0.6
        while self.path and math.dist(pos, self.path[0]) < 8:
            self.path.pop(0)
        if self.patrol and math.dist(pos, self.patrol) < 12:
            self.patrol_until = 0  # reached: pick a new patrol point next time
        # Unstick: if we've been pushing keys without moving, wiggle briefly.
        if now < self.jitter_until:
            return self._set_keys(self.jitter)
        if any(self.keys.values()) and now - self.stuck_at > 0.8:
            if math.dist(pos, self.stuck_pos) < 3:
                self.jitter = {k: self.rng.random() < 0.5 for k in ("up", "down", "left", "right")}
                self.jitter_until, self.path = now + 0.3, []
            self.stuck_at, self.stuck_pos = now, pos
        if not self.path:
            return self._set_keys({})
        tx, ty = self.path[0]
        dx, dy = tx - pos[0], ty - pos[1]
        return self._set_keys({"right": dx > 4, "left": dx < -4, "down": dy > 4, "up": dy < -4})

    def _set_keys(self, keys: dict) -> list[dict]:
        keys = {k: bool(keys.get(k)) for k in ("up", "down", "left", "right")}
        if keys == self.keys:
            return []
        self.keys = keys
        return [{"t": "input", **keys}]


if __name__ == "__main__":  # self-check against the real map/rules: python scripts/bot_ai.py
    import sys

    sys.path.insert(0, "services/game-service")
    from app.sim import MAP, TEAMS, Game

    # Navigation: every spawn reaches the enemy flag around the centre block and lane walls.
    b = Brain("x", MAP, random.Random(1))
    for sx, sy in [(60, 260), (60, 440), (1140, 260), (1140, 440)]:
        path = b.find_path((sx, sy), (1200 - sx, 350))
        assert all(b.clear(p, q, pad=14) for p, q in zip([(sx, sy)] + path, path)), "path cuts through a wall"

    def play(n: int, seed: int, max_s: float = 300):
        """Run bots-only n v n against the real sim at 30 Hz; bots think at 10 Hz."""
        rng = random.Random(seed)
        g = Game([[{"id": f"r{i}"} for i in range(n)], [{"id": f"b{i}"} for i in range(n)]], 0)
        brains = {pid: Brain(pid, MAP, random.Random(rng.random())) for pid in g.players}
        seen = {"fire": 0, "deaths": 0, "stolen": 0}
        t = 0
        while t < max_s * 1000 and not g.ended:
            t += 33
            g.step(t)
            if t % 99 == 0:
                snap = g.snapshot(t)
                dead = {p["id"] for p in snap["players"] if not p["alive"]}
                seen["deaths"] += len(dead - seen.setdefault("dead", set()))
                seen["dead"] = dead
                seen["stolen"] += sum(f["state"] == "CARRIED" for f in snap["flags"])
                for pid, br in brains.items():
                    for m in br.think(snap, t / 1000):
                        if m["t"] == "input":
                            g.set_keys(pid, m)
                        else:
                            seen["fire"] += 1
                            g.fire(pid, m["x"], m["y"], t)
        return g, t, seen

    for n in (1, 2, 4):
        g, t, seen = play(n, seed=n)
        assert seen["fire"] > 0 and seen["stolen"] > 0 and seen["deaths"] > 0, seen
        assert g.ended, f"{n}v{n} bots-only match did not finish in time"
        result = f"{TEAMS[g.winner]} won"
        print(f"{n}v{n} bots: {result} after {t / 1000:.0f}s game time, {seen['fire']} shots, {seen['deaths']} deaths, flag held {seen['stolen']} samples")
    print("bot_ai ok")
