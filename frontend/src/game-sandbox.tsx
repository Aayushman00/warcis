/* Dev-only: the in-match client against a fake in-browser server, no backend. `npm run dev` -> /game.html. Not linked from the app.
   A fake WebSocket replaces the game-service: same messages (hello, state, input / fire / ability / ping), a much simpler sim. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import type { ClassId, MatchDTO, WeaponId } from './api'
import type { Player } from './data'
import { CLASS_IDS, WEAPON_IDS } from './game/classes'
import type { GFlag, GMap, GPlayer, GShot, Snapshot, Team } from './game/render'
import { Game } from './Game'

const ME: Player = { id: 'me', name: 'You', tag: '0001', status: 'online' }
const names = ['You', 'Rook', 'Zephyr', 'Calyx', 'Dusk', 'Morrow', 'Kestrel', 'Nimbus']
const ids = names.map((_, i) => (i ? `p${i}` : 'me'))
const q = new URLSearchParams(location.search)
const myClass = (q.get('class') as ClassId) || 'ASSAULTER'
const myWeapon = (q.get('weapon') as WeaponId) || 'ASSAULT_RIFLE'

// Copied from services/game-service/app/sim.py (MAP, CATALOG). Team 0 = RED on the left.
const ys = [210, 260, 440, 490]
const MAP: GMap = {
  w: 1200,
  h: 700,
  walls: [[230, 140, 40, 140], [930, 140, 40, 140], [230, 420, 40, 140], [930, 420, 40, 140], [420, 60, 120, 40], [660, 60, 120, 40], [420, 600, 120, 40], [660, 600, 120, 40], [560, 240, 80, 220]],
  bases: [{ team: 'RED', x: 110, y: 350, r: 60 }, { team: 'BLUE', x: 1090, y: 350, r: 60 }],
  spawns: [...ys.map((y) => ({ team: 'RED' as Team, x: 60, y })), ...ys.map((y) => ({ team: 'BLUE' as Team, x: 1140, y }))],
  playerR: 14,
  shotR: 4,
}
const CLASS = {
  ASSAULTER: { hp: 85, fireMult: 0.8, ability: 'DASH', cooldownMs: 5000, durationMs: 160 },
  GUARDIAN: { hp: 140, fireMult: 1.0, ability: 'BARRIER', cooldownMs: 14000, durationMs: 8000 },
  ASSASSIN: { hp: 100, fireMult: 1.0, ability: 'INVISIBILITY', cooldownMs: 15000, durationMs: 5000 },
}
const WEAPON = {
  ASSAULT_RIFLE: { cooldownMs: 160, damage: 14, pellets: 1, spread: 0, speed: 700, ttlMs: 1100 },
  SHOTGUN: { cooldownMs: 850, damage: 9, pellets: 7, spread: 0.36, speed: 650, ttlMs: 420 },
  SNIPER_RIFLE: { cooldownMs: 1500, damage: 70, pellets: 1, spread: 0, speed: 1600, ttlMs: 900 },
}
const SPEED = 220, PR = 14, SR = 4, RESPAWN_MS = 3000, FLAG_RETURN_MS = 10000, TOUCH = PR + 12, ROUNDS_TO_WIN = 3, MATCH_MS = 600000, TICK_MS = 33
const TEAMS: Team[] = ['RED', 'BLUE']
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]
const foe = (t: Team): Team => (t === 'RED' ? 'BLUE' : 'RED')
const base = (t: Team) => MAP.bases.find((b) => b.team === t)!

type P = GPlayer & { x: number; y: number; vx: number; vy: number; nextFire: number; invisUntil: number; dashUntil: number; held: Record<string, boolean> }
type S = GShot & { vx: number; vy: number; dmg: number; exp: number }

const hitsWall = (x: number, y: number, r: number) =>
  MAP.walls.some(([wx, wy, w, h]) => x + r > wx && x - r < wx + w && y + r > wy && y - r < wy + h) || x < r || y < r || x > MAP.w - r || y > MAP.h - r

/** The whole match in a closure: `onState` gets a snapshot every tick, `handle` takes the client's messages. */
function createSim(onState: (s: Snapshot) => void) {
  const t0 = Date.now()
  const spawnAt = (team: Team, i: number) => MAP.spawns.filter((s) => s.team === team)[i % 4]
  const players: P[] = ids.map((id, i) => {
    const team = TEAMS[Math.floor(i / 4)]
    const cls = i ? pick(CLASS_IDS) : myClass
    const weapon = i ? pick(WEAPON_IDS) : myWeapon
    const sp = spawnAt(team, i)
    return {
      id, name: names[i], team, class: cls, weapon, maxHp: CLASS[cls].hp, x: sp.x, y: sp.y, hidden: false, invisible: false, dashing: false, abilityReadyAt: 0, hp: CLASS[cls].hp,
      alive: true, respawnAt: null, carryingFlag: false, connected: true, bot: i > 0, killedBy: null, captures: 0, kills: 0, deaths: 0, rating: 0,
      vx: 0, vy: 0, nextFire: 0, invisUntil: 0, dashUntil: 0, held: {},
    }
  })
  const me = players[0]
  const flags: GFlag[] = MAP.bases.map((b) => ({ team: b.team, x: b.x, y: b.y, state: 'AT_BASE', carrierId: null, returnAt: null }))
  let shots: S[] = []
  let sid = 0
  const scores: Record<Team, number> = { RED: 0, BLUE: 0 }
  let round = 1
  let state: 'PLAYING' | 'ENDED' = 'PLAYING'
  let winner: Team | null = null
  let capturer: string | null = null

  const move = (p: P, dx: number, dy: number) => {
    if (!hitsWall(p.x + dx, p.y, PR)) p.x += dx
    if (!hitsWall(p.x, p.y + dy, PR)) p.y += dy
  }
  const fire = (p: P, tx: number, ty: number, now: number) => {
    const w = WEAPON[p.weapon]
    if (!p.alive || now < p.nextFire) return
    p.nextFire = now + w.cooldownMs / CLASS[p.class].fireMult
    p.invisUntil = 0
    const a = Math.atan2(ty - p.y, tx - p.x)
    for (let i = 0; i < w.pellets; i++) {
      const b = a + (Math.random() - 0.5) * w.spread
      shots.push({ id: ++sid, owner: p.id, team: p.team, x: p.x, y: p.y, w: p.weapon, vx: Math.cos(b) * w.speed, vy: Math.sin(b) * w.speed, dmg: w.damage, exp: now + w.ttlMs })
    }
  }
  const ability = (p: P, tx: number, ty: number, now: number) => {
    if (!p.alive || now < (p.abilityReadyAt ?? 0)) return
    const c = CLASS[p.class]
    p.abilityReadyAt = now + c.cooldownMs
    if (p.class === 'ASSAULTER') {
      const a = Math.atan2(ty - p.y, tx - p.x)
      for (let d = 0; d < 160; d += 8) move(p, Math.cos(a) * 8, Math.sin(a) * 8)
      p.dashUntil = now + c.durationMs
    } else if (p.class === 'ASSASSIN') p.invisUntil = now + c.durationMs
    // ponytail: no Guardian barrier here, add it when you need to see barriers.
  }
  const kill = (v: P, by: P, now: number) => {
    Object.assign(v, { alive: false, hp: 0, respawnAt: now + RESPAWN_MS, killedBy: by.id })
    v.deaths++
    by.kills++
    if (v.carryingFlag) {
      const f = flags.find((x) => x.carrierId === v.id)!
      Object.assign(f, { state: 'DROPPED', carrierId: null, returnAt: now + FLAG_RETURN_MS, x: v.x, y: v.y })
      v.carryingFlag = false
    }
  }
  // ponytail: bots steer straight at their goal and slide along walls; they snag on the centre block sometimes.
  const bot = (p: P, now: number) => {
    const goal = p.carryingFlag ? base(p.team) : flags.find((f) => f.team === foe(p.team))!
    const dx = goal.x - p.x, dy = goal.y - p.y
    const d = Math.hypot(dx, dy) || 1
    p.vx = (dx / d) * SPEED * 0.7
    p.vy = (dy / d) * SPEED * 0.7
    const t = players.find((o) => o.alive && o.team !== p.team && Math.hypot(o.x - p.x, o.y - p.y) < 380)
    if (t && Math.random() < 0.5) fire(p, t.x, t.y, now)
  }

  const step = () => {
    const now = Date.now(), dt = TICK_MS / 1000
    if (state === 'PLAYING') {
      for (const p of players) {
        if (!p.alive) {
          if (p.respawnAt !== null && now >= p.respawnAt) {
            const sp = spawnAt(p.team, players.indexOf(p))
            Object.assign(p, { alive: true, hp: p.maxHp, x: sp.x, y: sp.y, respawnAt: null, killedBy: null })
          }
          continue
        }
        if (p.bot) bot(p, now)
        else {
          const h = p.held
          p.vx = ((h.right ? 1 : 0) - (h.left ? 1 : 0)) * SPEED
          p.vy = ((h.down ? 1 : 0) - (h.up ? 1 : 0)) * SPEED
          if (p.vx && p.vy) {
            p.vx *= Math.SQRT1_2
            p.vy *= Math.SQRT1_2
          }
        }
        move(p, p.vx * dt, p.vy * dt)
        p.dashing = now < p.dashUntil
        p.invisible = now < p.invisUntil
        for (const f of flags) {
          if (Math.hypot(f.x - p.x, f.y - p.y) > TOUCH) continue
          if (f.team !== p.team && f.state !== 'CARRIED' && !p.carryingFlag) {
            Object.assign(f, { state: 'CARRIED', carrierId: p.id, returnAt: null })
            p.carryingFlag = true
          } else if (f.team === p.team && f.state === 'DROPPED') Object.assign(f, { state: 'AT_BASE', x: base(f.team).x, y: base(f.team).y, returnAt: null })
        }
        const own = flags.find((f) => f.team === p.team)!
        const b = base(p.team)
        if (p.carryingFlag && own.state === 'AT_BASE' && Math.hypot(b.x - p.x, b.y - p.y) < b.r) {
          const f = flags.find((x) => x.carrierId === p.id)!
          Object.assign(f, { state: 'AT_BASE', carrierId: null, x: base(f.team).x, y: base(f.team).y })
          p.carryingFlag = false
          p.captures++
          scores[p.team]++
          capturer = p.id
          round++
          if (scores[p.team] >= ROUNDS_TO_WIN) {
            state = 'ENDED'
            winner = p.team
          }
        }
      }
      for (const f of flags) {
        const c = players.find((p) => p.id === f.carrierId)
        if (c) Object.assign(f, { x: c.x, y: c.y })
        else if (f.state === 'DROPPED' && f.returnAt !== null && now >= f.returnAt) Object.assign(f, { state: 'AT_BASE', x: base(f.team).x, y: base(f.team).y, returnAt: null })
      }
      shots = shots.filter((s) => {
        s.x += s.vx * dt
        s.y += s.vy * dt
        if (now > s.exp || hitsWall(s.x, s.y, SR)) return false
        const v = players.find((p) => p.alive && p.team !== s.team && Math.hypot(p.x - s.x, p.y - s.y) < PR + SR)
        if (!v) return true
        v.hp -= s.dmg
        if (v.hp <= 0) kill(v, players.find((p) => p.id === s.owner)!, now)
        return false
      })
    }
    for (const p of players) p.rating = p.captures * 100 + p.kills * 10 - p.deaths * 3
    onState({
      t: 'state', now, elapsed: now - t0, matchMs: MATCH_MS, hardStopMs: 720000, suddenDeath: false, state, winner, decidedBy: state === 'ENDED' ? 'ROUNDS' : null,
      progress: { RED: 0, BLUE: 0 }, // ponytail: the 12:00 tiebreak progress is not simulated
      scores: { ...scores }, round, resumesAt: null, roundWinner: null, capturer,
      players: players.map(({ vx: _a, vy: _b, nextFire: _c, invisUntil: _d, dashUntil: _e, held: _f, ...p }) => p),
      flags: flags.map((f) => ({ ...f })),
      shots: shots.map(({ vx: _a, vy: _b, dmg: _c, exp: _d, ...s }) => s),
      barriers: [],
    })
  }
  const timer = setInterval(step, TICK_MS)

  const handle = (m: { t: string; c?: number; x?: number; y?: number } & Record<string, boolean | number | string | undefined>, reply: (m: object) => void) => {
    const now = Date.now()
    if (m.t === 'input') me.held = { up: !!m.up, down: !!m.down, left: !!m.left, right: !!m.right }
    else if (m.t === 'fire') fire(me, m.x!, m.y!, now)
    else if (m.t === 'ability') ability(me, m.x!, m.y!, now)
    else if (m.t === 'ping') reply({ t: 'pong', c: m.c })
  }
  return { handle, stop: () => clearInterval(timer) }
}

class FakeWS {
  static OPEN = 1
  readyState = 1
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  private sim
  constructor(_url: string) {
    const emit = (m: object) => this.onmessage?.({ data: JSON.stringify(m) })
    this.sim = createSim(emit)
    setTimeout(() => emit({ t: 'hello', you: ME.id, map: MAP, catalog: { classes: CLASS } }), 0)
  }
  send(data: string) {
    this.sim.handle(JSON.parse(data), (m) => this.onmessage?.({ data: JSON.stringify(m) }))
  }
  close() {
    this.readyState = 3
    this.sim.stop()
  }
}
;(window as unknown as { WebSocket: unknown }).WebSocket = FakeWS

const match = {
  match_id: 'sandbox',
  mode: 'SQUAD',
  status: 'ENTERED',
  created_at: new Date().toISOString(),
  teams: [0, 1].map((t) => ({ players: ids.slice(t * 4, t * 4 + 4).map((id, i) => ({ id, name: names[t * 4 + i], tag: id })), parties: [] })),
  my_team: 0,
  ready: ids,
  entered: ids,
  loadouts: {},
  lobby_ends_at: null,
  countdown_ends_at: null,
  result: null,
} as MatchDTO

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="mx-auto w-full max-w-[1440px] p-4 lg:p-6">
      <Game match={match} me={ME} onExit={() => location.reload()} />
    </div>
  </StrictMode>,
)
