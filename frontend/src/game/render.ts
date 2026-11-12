/* CTF client rendering: snapshot interpolation + canvas drawing + short-lived effects.
   Server is authoritative; this file never decides anything, it only shows server
   snapshots ~INTERP_MS in the past, smoothly. Colors come from tokens.ts. */

import type { ClassId, DecidedBy, WeaponId } from '../api'
import { bloom, drawAvatar, drawWeapon, gunOf } from './classes'
import { spawnTracers, stepTracer, type ShotSpec, type Tracer } from './predict'
import { alpha, color, font, team as TC, type Team } from './tokens'

export type { Team }
/** Emote glyphs; the index is what the wire carries (the server accepts 0..EMOTES.length-1). */
export const EMOTES = ['👍', '😂', '😡', '❓', '🔥', '💀', '👋', 'GG'] as const

export type GPlayer = {
  id: string
  name: string
  team: Team
  class: ClassId
  weapon: WeaponId
  maxHp: number
  x: number | null // null: an invisible enemy, whose position the server does not send
  y: number | null
  hidden: boolean // true exactly when x / y are null
  invisible: boolean // me or an ally under invisibility (enemies never get this: they get `hidden`)
  dashing: boolean
  abilityReadyAt: number | null // mine and my allies' only
  hp: number
  alive: boolean
  emote: number | null // index into EMOTES while the server says it is showing
  respawnAt: number | null
  carryingFlag: boolean
  connected: boolean
  bot: boolean
  killedBy: string | null
  captures: number
  kills: number
  deaths: number
  rating: number // server-computed ranking score
}
export type GFlag = { team: Team; x: number; y: number; state: 'AT_BASE' | 'CARRIED' | 'DROPPED'; carrierId: string | null; returnAt: number | null }
export type GShot = { id: number; owner: string; team: Team; x: number; y: number; w: WeaponId }
export type GBarrier = { id: number; owner: string; team: Team; x: number; y: number; w: number; h: number; hp: number; maxHp: number; expiresAt: number }
/** King of the Hill: the live zone. owner = the one team standing on it; contested = both are. */
export type GHill = { x: number; y: number; r: number; owner: Team | null; contested: boolean; movesAt: number; everyMs: number }
/** STALE: Spike adds lag to the enemy team, Sync zeroes your own. Ready once server time reaches readyAt. */
export type GPickup = { id: number; kind: 'SPIKE' | 'SYNC'; x: number; y: number; readyAt: number }
export type Snapshot = {
  t: 'state'
  hill?: GHill | null // KOTH only
  lag?: Record<Team, number> // STALE: ms each team's view of the enemy should run behind (0 elsewhere)
  behind?: Record<Team, number> // STALE: ms it actually runs behind now; < lag = stalled, >= lag (and > 0) = catching up
  pickups?: GPickup[] // STALE only
  now: number
  elapsed: number
  matchMs: number // regulation; level scores there start sudden death
  hardStopMs: number // sudden death ends here and the tiebreak decides
  suddenDeath: boolean // no respawns, next capture wins
  state: 'PLAYING' | 'ENDED'
  winner: Team | null // ENDED with no winner = draw
  decidedBy: DecidedBy | null
  progress: Record<Team, number> // furthest flag carry this round, % of the way home (the 6:00 tiebreak)
  scores: Record<Team, number>
  round: number
  resumesAt: number | null // set while the intermission after a capture runs
  roundWinner: Team | null
  capturer: string | null
  players: GPlayer[]
  flags: GFlag[]
  shots: GShot[]
  barriers: GBarrier[]
}
export type GMap = {
  w: number
  h: number
  walls: [number, number, number, number][]
  bases: { team: Team; x: number; y: number; r: number }[]
  spawns: { team: Team; x: number; y: number }[]
  playerR: number
  shotR: number
}

const INTERP_MS = 100 // ~3 snapshots at 30 Hz
const TAU = Math.PI * 2
export const LAG_MAX_MS = 1200 // mirrors sim.LAG_MAX_MS (damage cap), display only
export const LAG_CEIL_MS = 2000 // mirrors sim.LAG_CEIL_MS (Spike ceiling), display only
const PICKUP_RESPAWN_MS = { SPIKE: 25_000, SYNC: 12_000 } // mirrors sim.PICKUP_RESPAWN_MS, display only
const STALL_EPS = 40 // ms: behind trailing lag by about a tick is not a stall yet, so the look does not flicker

/** STALE: my view of the enemy is frozen (behind < lag) or replaying fast (behind > 0 and >= lag: any lag above 0 is
 *  draining, so behind == lag means the view is gaining on live); null = live. */
export const staleState = (lag: number, behind: number) => (lag - behind > STALL_EPS ? 'stall' : behind > 0 ? 'catch' : null)
type Look = { ghost: number; state: ReturnType<typeof staleState> }

/* ─────────────── interpolation ─────────────── */

export class Timeline {
  private snaps: Snapshot[] = []
  private offset: number | null = null // server clock - performance.now()

  push(s: Snapshot) {
    const est = s.now - performance.now()
    // The least-delayed packet gives the best estimate; drift down slowly so jitter doesn't shake time.
    this.offset = this.offset === null || est > this.offset ? est : this.offset + (est - this.offset) * 0.02
    this.snaps.push(s)
    if (this.snaps.length > 30) this.snaps.shift()
  }

  reset() {
    this.snaps = []
    this.offset = null
  }

  latest() {
    return this.snaps[this.snaps.length - 1] ?? null
  }

  /** Server time currently being displayed. */
  renderTime() {
    return this.offset === null ? 0 : performance.now() + this.offset - INTERP_MS
  }

  /** Snapshot pair around render time and the blend factor between them. */
  bracket(t: number): [Snapshot, Snapshot, number] | null {
    const s = this.snaps
    if (!s.length) return null
    if (t <= s[0].now) return [s[0], s[0], 0]
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].now <= t) {
        const a = s[i - 1]
        const b = s[i]
        return t >= b.now ? [b, b, 0] : [a, b, (t - a.now) / (b.now - a.now)]
      }
    }
    return [s[s.length - 1], s[s.length - 1], 0]
  }
}

/* ─────────────── effects ─────────────── */

type Particle = { x: number; y: number; vx: number; vy: number; born: number; life: number; color: string; size: number }
type Floater = { x: number; y: number; born: number; text: string; color: string }
type Ring = { x: number; y: number; born: number; life: number; color: string; r0: number; r1: number }
type Anim = { facing: number; walk: number; shotAt: number; hitAt: number; lastX: number; lastY: number; diedAt: number; deathX: number; deathY: number; emote: number | null; emoteAt: number }

const MAX_PARTICLES = 240

export class Renderer {
  private bg: HTMLCanvasElement
  private particles: Particle[] = []
  private floaters: Floater[] = []
  private rings: Ring[] = []
  private anim = new Map<string, Anim>()
  private pending: { at: number; run: () => void }[] = []
  private tracers: Tracer[] = []
  private map: GMap
  private me: string
  private calm = matchMedia('(prefers-reduced-motion: reduce)') // live: STALE effects drop to a static tint
  myAim: number | null = null
  mePos: { x: number; y: number } | null = null // set each frame by the Predictor
  cooldowns: Record<string, number> = {} // class id -> Q cooldown ms, from the server's hello catalog

  constructor(map: GMap, me: string) {
    this.map = map
    this.me = me
    this.bg = paintBackground(map)
  }

  /** Queue an effect at server time `at`, so it plays when interpolation reaches that moment. */
  at(at: number, run: () => void) {
    this.pending.push({ at, run })
  }

  private a(id: string, x: number, y: number): Anim {
    let a = this.anim.get(id)
    if (!a) this.anim.set(id, (a = { facing: 0, walk: 0, shotAt: -1e9, hitAt: -1e9, lastX: x, lastY: y, diedAt: -1e9, deathX: x, deathY: y, emote: null, emoteAt: -1e9 }))
    return a
  }

  /** I fired: tracers, muzzle flash and recoil start now from where I am drawn, not when the server's copy shows up. */
  fire(from: { x: number; y: number }, aim: { x: number; y: number }, w: WeaponId, spec: ShotSpec, t: number) {
    this.tracers.push(...spawnTracers(from, aim, w, spec, t))
    this.shot(this.me, from.x, from.y, aim.x - from.x, aim.y - from.y, t)
  }

  shot(pid: string, x: number, y: number, dx: number, dy: number, t: number) {
    const a = this.a(pid, x, y)
    a.facing = Math.atan2(dy, dx)
    a.shotAt = t
  }

  hit(pid: string, x: number, y: number, dmg: number, team: Team, t: number) {
    this.a(pid, x, y).hitAt = t
    this.burst(x, y, 6, '#FFFFFF', 130, 240, t, 2)
    this.burst(x, y, 5, TC[team].light, 90, 300, t, 2.5)
    this.floaters.push({ x, y: y - 22, born: t, text: `${dmg}`, color: TC[team].ink })
  }

  death(pid: string, x: number, y: number, team: Team, t: number) {
    const a = this.a(pid, x, y)
    a.diedAt = t
    a.deathX = x
    a.deathY = y
    this.burst(x, y, 16, TC[team].base, 170, 560, t, 3)
    this.rings.push({ x, y, born: t, life: 420, color: TC[team].light, r0: 8, r1: 40 })
  }

  flagEvent(x: number, y: number, team: Team, t: number, big = false) {
    this.rings.push({ x, y, born: t, life: big ? 900 : 560, color: TC[team].base, r0: 10, r1: big ? 110 : 54 })
    if (big) this.burst(x, y, 22, TC[team].light, 200, 800, t, 2.5)
  }

  private burst(x: number, y: number, n: number, c: string, speed: number, life: number, t: number, size: number) {
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift()
      const ang = Math.random() * TAU
      const v = speed * (0.4 + Math.random() * 0.6)
      this.particles.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, born: t, life: life * (0.6 + Math.random() * 0.4), color: c, size })
    }
  }

  draw(ctx: CanvasRenderingContext2D, tl: Timeline) {
    const t = tl.renderTime()
    const br = tl.bracket(t)
    const { map } = this
    ctx.drawImage(this.bg, 0, 0, map.w, map.h)
    if (!br) return
    const [A, B, k] = br
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= t) {
        this.pending[i].run()
        this.pending.splice(i, 1)
      }
    }

    // Interpolated positions (a respawn teleport snaps instead of sliding across the map).
    const prev = new Map(A.players.map((p) => [p.id, p]))
    const pos = new Map<string, { x: number; y: number }>()
    for (const p of B.players) {
      if (p.x === null || p.y === null) continue // invisible enemy: nothing to draw
      const q = prev.get(p.id)
      // slide from the previous snapshot, but snap after a teleport (respawn) or when the player just became visible
      const from = q && q.x !== null && q.y !== null && Math.abs(q.x - p.x) + Math.abs(q.y - p.y) <= 80 ? { x: q.x, y: q.y } : null
      pos.set(p.id, from ? { x: from.x + (p.x - from.x) * k, y: from.y + (p.y - from.y) * k } : { x: p.x, y: p.y })
    }
    if (this.mePos && pos.has(this.me)) pos.set(this.me, { ...this.mePos }) // me: predicted now, not interpolated 100 ms ago
    const mine = B.players.find((p) => p.id === this.me)
    // STALE: enemies fade the further behind my team's view runs, and show whether that view is frozen or catching up
    const lag = mine ? (B.lag?.[mine.team] ?? 0) : 0
    const behind = mine ? (B.behind?.[mine.team] ?? 0) : 0
    const look: Look | null = lag || behind ? { ghost: 1 - 0.45 * Math.min(1, behind / LAG_CEIL_MS), state: staleState(lag, behind) } : null

    this.drawBases(ctx, B, t, mine)
    if (B.hill) this.drawHill(ctx, B.hill, t)
    for (const f of B.flags) {
      if (f.state === 'AT_BASE') this.drawStandingFlag(ctx, f.x, f.y, f.team, t)
      else if (f.state === 'DROPPED') this.drawDropped(ctx, f, t)
    }
    for (const q of B.pickups ?? []) this.drawPickup(ctx, q, t)

    for (const b of B.barriers) this.drawBarrier(ctx, b, t)

    // Shots with a short trail (a long bright streak for the sniper, a stub for pellets).
    const prevShots = new Map(A.shots.map((s) => [s.id, s]))
    ctx.lineCap = 'round'
    for (const s of B.shots) {
      if (s.owner === this.me) continue // mine are the local tracers below
      const q = prevShots.get(s.id)
      if (!q) continue // appears next frame, from its real position
      const len = Math.hypot(s.x - q.x, s.y - q.y) || 1
      const [x, y] = [q.x + (s.x - q.x) * k, q.y + (s.y - q.y) * k]
      const stale = look && mine && s.team !== mine.team
      if (stale) ctx.globalAlpha = look.ghost
      this.drawShot(ctx, x, y, (s.x - q.x) / len, (s.y - q.y) / len, s.w, s.team)
      if (stale && look.state === 'stall' && !this.calm.matches) {
        // colour fringe: the head splits into a cyan and a team-light ghost either side
        const j = 2 + Math.sin(t / 45)
        ctx.globalAlpha = 0.6 * look.ghost
        ctx.fillStyle = color.neon
        ctx.fillRect(x - j - 2, y - 2, 4, 4)
        ctx.fillStyle = TC[s.team].light
        ctx.fillRect(x + j - 2, y - 2, 4, 4)
      }
      ctx.globalAlpha = 1
    }
    if (mine) {
      const rects = B.barriers.filter((b) => b.team !== mine.team && b.hp > 0).map((b): [number, number, number, number] => [b.x, b.y, b.w, b.h])
      const foes = B.players.filter((p) => p.alive && p.team !== mine.team && pos.has(p.id)).map((p) => ({ ...pos.get(p.id)!, r: this.map.playerR }))
      this.tracers = this.tracers.filter((s) => {
        const live = stepTracer(s, t, this.map, rects, foes)
        const v = Math.hypot(s.vx, s.vy)
        this.drawShot(ctx, s.x, s.y, s.vx / v, s.vy / v, s.w as WeaponId, mine.team)
        return live
      })
    }

    // Where the fallen went down, until they respawn.
    for (const p of B.players) {
      if (p.alive) continue
      const a = this.anim.get(p.id)
      if (!a || t < a.diedAt) continue
      ctx.globalAlpha = 0.4 * Math.min(1, (t - a.diedAt) / 400)
      ctx.strokeStyle = TC[p.team].base
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(a.deathX - 6, a.deathY - 6)
      ctx.lineTo(a.deathX + 6, a.deathY + 6)
      ctx.moveTo(a.deathX + 6, a.deathY - 6)
      ctx.lineTo(a.deathX - 6, a.deathY + 6)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Players; me last so I'm always on top.
    const order = B.players.filter((p) => p.alive && pos.has(p.id)).sort((a, b) => Number(a.id === this.me) - Number(b.id === this.me))
    for (const p of order) this.drawPlayer(ctx, p, pos.get(p.id)!, t, B, mine && p.team !== mine.team ? look : null)
    if (mine?.alive && mine.carryingFlag) this.drawHomeArrow(ctx, pos.get(mine.id)!, mine.team, t)

    this.drawEffects(ctx, t)
  }

  private drawShot(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, w: WeaponId, team: Team) {
    const tail = w === 'SNIPER_RIFLE' ? 80 : w === 'SHOTGUN' ? 12 : 28
    const g = ctx.createLinearGradient(x - dx * tail, y - dy * tail, x, y)
    g.addColorStop(0, alpha(TC[team].base, 0))
    g.addColorStop(1, TC[team].light)
    ctx.strokeStyle = g
    ctx.lineWidth = w === 'SNIPER_RIFLE' ? 2.2 : w === 'SHOTGUN' ? 2 : 3
    ctx.beginPath()
    ctx.moveTo(x - dx * tail, y - dy * tail)
    ctx.lineTo(x, y)
    ctx.stroke()
    bloom(ctx, TC[team].base, x, y, w === 'SNIPER_RIFLE' ? 14 : 9)
    ctx.fillStyle = '#FFFFFF'
    ctx.beginPath()
    ctx.arc(x, y, this.map.shotR - (w === 'SHOTGUN' ? 1.6 : 0.5), 0, TAU)
    ctx.fill()
  }

  private drawBarrier(ctx: CanvasRenderingContext2D, b: GBarrier, t: number) {
    const c = TC[b.team]
    const left = b.expiresAt - t
    const fade = left < 1200 ? 0.45 + 0.4 * Math.sin(t / 70) : 1 // flickers out in its last second
    ctx.save()
    ctx.globalAlpha = 0.9 * fade
    bloom(ctx, c.base, b.x + b.w / 2, b.y + b.h / 2, b.w / 2 + 14, b.h / 2 + 14)
    ctx.fillStyle = alpha(c.deep, 0.85)
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.w, b.h, 3)
    ctx.fill()
    ctx.strokeStyle = c.light
    ctx.lineWidth = 1.5
    ctx.stroke()
    // cracks as it takes damage
    const hurt = 1 - b.hp / b.maxHp
    ctx.strokeStyle = alpha('#FFFFFF', 0.5)
    ctx.lineWidth = 1
    ctx.beginPath()
    const long = b.h >= b.w
    for (let i = 1; i <= Math.floor(hurt * 6); i++) {
      const f = (i * 0.37) % 1
      if (long) {
        ctx.moveTo(b.x, b.y + b.h * f)
        ctx.lineTo(b.x + b.w, b.y + b.h * ((f + 0.12) % 1))
      } else {
        ctx.moveTo(b.x + b.w * f, b.y)
        ctx.lineTo(b.x + b.w * ((f + 0.12) % 1), b.y + b.h)
      }
    }
    ctx.stroke()
    ctx.restore()
  }

  /** The hill: tinted by whoever holds it, dashed while contested, with an inner arc running down to its next move. */
  private drawHill(ctx: CanvasRenderingContext2D, h: GHill, t: number) {
    const c = h.owner ? TC[h.owner].base : '#FFFFFF'
    const pulse = 0.5 + 0.5 * Math.sin(t / 240)
    ctx.beginPath()
    ctx.arc(h.x, h.y, h.r, 0, TAU)
    ctx.fillStyle = alpha(c, h.owner ? 0.1 + 0.08 * pulse : 0.05)
    ctx.fill()
    ctx.strokeStyle = c
    ctx.lineWidth = 2
    ctx.globalAlpha = h.owner ? 0.9 : h.contested ? 0.5 + 0.4 * pulse : 0.45
    ctx.setLineDash(h.contested ? [10, 8] : [])
    ctx.lineDashOffset = -t / 50
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(h.x, h.y, h.r - 7, -TAU / 4, -TAU / 4 + TAU * Math.max(0, Math.min(1, (h.movesAt - t) / h.everyMs)))
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  /** STALE pickup: amber diamond with a spike line (Spike) or green disc with a cycle arrow (Sync). While it respawns
   *  it is dimmed with a ring running down to readyAt. */
  private drawPickup(ctx: CanvasRenderingContext2D, q: GPickup, t: number) {
    const spike = q.kind === 'SPIKE'
    const c = spike ? color.signal : color.hpHigh
    const left = q.readyAt - t
    ctx.save()
    ctx.translate(q.x, q.y)
    if (left <= 0) bloom(ctx, c, 0, 0, 26 + (this.calm.matches ? 0 : 3 * Math.sin(t / 260)))
    ctx.globalAlpha = left <= 0 ? 1 : 0.35
    ctx.fillStyle = alpha(color.void, 0.85)
    ctx.strokeStyle = c
    ctx.lineWidth = 2
    ctx.lineCap = ctx.lineJoin = 'round'
    const line = (pts: number[][]) => pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.beginPath()
    if (spike) line([[0, -15], [15, 0], [0, 15], [-15, 0], [0, -15]])
    else ctx.arc(0, 0, 13, 0, TAU)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    if (spike) {
      line([[-8, 3], [-4, 3], [-1, -6], [2, 6], [4, 3], [8, 3]])
      ctx.stroke()
    } else {
      const a = Math.PI * 1.35 // open ring with an arrowhead at its end: "reset"
      const [rx, ry, tx, ty] = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a)]
      ctx.arc(0, 0, 6, -0.4, a)
      ctx.stroke()
      ctx.fillStyle = c
      ctx.beginPath()
      ctx.moveTo(6 * rx + 3 * tx, 6 * ry + 3 * ty)
      ctx.lineTo(9 * rx - 2 * tx, 9 * ry - 2 * ty)
      ctx.lineTo(3 * rx - 2 * tx, 3 * ry - 2 * ty)
      ctx.fill()
    }
    if (left > 0) {
      ctx.globalAlpha = 0.9
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(0, 0, 21, -Math.PI / 2, -Math.PI / 2 + Math.min(1, left / PICKUP_RESPAWN_MS[q.kind]) * TAU)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** STALE enemy look. Stall: a jittering cyan / team colour fringe and scrolling scanlines (frozen picture).
   *  Catch-up: short streaks trailing the motion (fast replay). Reduced motion: one static tint for both. */
  private drawStale(ctx: CanvasRenderingContext2D, x: number, y: number, vx: number, vy: number, team: Team, state: 'stall' | 'catch', t: number, dim: number) {
    const R = this.map.playerR + 2
    ctx.save()
    if (this.calm.matches) {
      ctx.globalAlpha = dim * 0.22
      ctx.fillStyle = color.neon
      ctx.beginPath()
      ctx.arc(x, y, R, 0, TAU)
      ctx.fill()
    } else if (state === 'stall') {
      const j = 2 + 1.2 * Math.sin(t / 45)
      ctx.lineWidth = 2
      ctx.globalAlpha = dim * 0.7
      for (const [dx, c] of [[-j, color.neon], [j, TC[team].light]] as const) {
        ctx.strokeStyle = c
        ctx.beginPath()
        ctx.arc(x + dx, y, R, 0, TAU)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(x, y, R, 0, TAU)
      ctx.clip()
      ctx.globalAlpha = dim * 0.4
      ctx.fillStyle = color.void
      for (let sy = y - R + ((t / 40) % 4); sy < y + R; sy += 4) ctx.fillRect(x - R, sy, 2 * R, 1.5)
    } else {
      const v = Math.hypot(vx, vy)
      if (v > 0.3) {
        const [ux, uy] = [vx / v, vy / v]
        ctx.strokeStyle = TC[team].light
        ctx.lineWidth = 2
        ctx.lineCap = 'round'
        for (const o of [-0.55, 0, 0.55]) {
          const sx = x - ux * R - uy * o * R
          const sy = y - uy * R + ux * o * R
          ctx.globalAlpha = dim * (0.6 - Math.abs(o) * 0.4)
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.lineTo(sx - ux * 18, sy - uy * 18)
          ctx.stroke()
        }
      }
    }
    ctx.restore()
  }

  private drawBases(ctx: CanvasRenderingContext2D, s: Snapshot, t: number, mine?: GPlayer) {
    for (const b of this.map.bases) {
      const home = !s.flags.length || s.flags.find((f) => f.team === b.team)?.state === 'AT_BASE' // TDM: no flags, every base is calm
      const c = TC[b.team]
      // Carrier's own base: a stronger, breathing boundary says "bring it here".
      const target = mine?.alive && mine.carryingFlag && mine.team === b.team
      const pulse = 0.5 + 0.5 * Math.sin(t / 240)
      ctx.strokeStyle = c.base
      ctx.lineWidth = target ? 3 : 2
      ctx.globalAlpha = target ? 0.55 + 0.45 * pulse : home ? 0.7 : 0.35 + 0.35 * pulse
      ctx.setLineDash(home ? [] : [10, 8])
      ctx.lineDashOffset = -t / 50
      ctx.beginPath()
      ctx.arc(b.x, b.y, b.r, 0, TAU)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
  }

  private drawCloth(ctx: CanvasRenderingContext2D, x: number, top: number, team: Team, t: number, scale: number) {
    const w = 24 * scale
    const h = 15 * scale
    const wave = (u: number) => Math.sin(t / 150 - u * 3.2) * 2.4 * u * scale
    ctx.beginPath()
    ctx.moveTo(x, top)
    for (let i = 1; i <= 8; i++) ctx.lineTo(x + w * (i / 8), top + wave(i / 8))
    ctx.lineTo(x + w * 0.82, top + h * 0.5 + wave(0.82)) // swallowtail notch
    ctx.lineTo(x + w, top + h + wave(1))
    for (let i = 7; i >= 0; i--) ctx.lineTo(x + w * (i / 8), top + h + wave(i / 8))
    ctx.closePath()
    ctx.fillStyle = TC[team].base
    ctx.fill()
    ctx.strokeStyle = TC[team].deep
    ctx.lineWidth = 1.5
    ctx.stroke()
    // highlight fold
    ctx.strokeStyle = alpha('#FFFFFF', 0.35)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x + 2, top + 3)
    ctx.lineTo(x + w * 0.6, top + 3 + wave(0.6))
    ctx.stroke()
  }

  private drawPole(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
    ctx.strokeStyle = '#0B1017'
    ctx.lineWidth = 4.5 * scale
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x, y + 12 * scale)
    ctx.lineTo(x, y - 22 * scale)
    ctx.stroke()
    ctx.strokeStyle = '#D6DEEA'
    ctx.lineWidth = 2.2 * scale
    ctx.stroke()
  }

  /** Ground beacon: a ring that keeps expanding from the flag so it's findable mid-fight. */
  private beacon(ctx: CanvasRenderingContext2D, x: number, y: number, team: Team, t: number) {
    const u = (t % 1600) / 1600
    ctx.strokeStyle = TC[team].base
    ctx.globalAlpha = 0.55 * (1 - u)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.ellipse(x, y + 12, 10 + u * 34, (10 + u * 34) * 0.42, 0, 0, TAU)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  private drawStandingFlag(ctx: CanvasRenderingContext2D, x: number, y: number, team: Team, t: number) {
    this.beacon(ctx, x, y, team, t)
    this.drawPole(ctx, x, y, 1)
    this.drawCloth(ctx, x + 1, y - 22, team, t, 1)
  }

  private drawDropped(ctx: CanvasRenderingContext2D, f: GFlag, t: number) {
    this.beacon(ctx, f.x, f.y, f.team, t)
    ctx.save()
    ctx.translate(f.x, f.y + 8)
    ctx.rotate(-0.35 + Math.sin(t / 260) * 0.04) // lying tilted on the ground
    this.drawPole(ctx, 0, -8, 0.85)
    this.drawCloth(ctx, 1, -26, f.team, t, 0.85)
    ctx.restore()
    if (f.returnAt) {
      const left = Math.max(0, Math.min(1, (f.returnAt - t) / 10_000))
      ctx.lineCap = 'round'
      ctx.strokeStyle = alpha(color.ink, 0.12)
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(f.x, f.y, 28, 0, TAU)
      ctx.stroke()
      ctx.strokeStyle = TC[f.team].light
      ctx.beginPath()
      ctx.arc(f.x, f.y, 28, -Math.PI / 2, -Math.PI / 2 + left * TAU)
      ctx.stroke()
    }
  }

  private drawHomeArrow(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, team: Team, t: number) {
    const base = this.map.bases.find((b) => b.team === team)!
    if (Math.hypot(base.x - at.x, base.y - at.y) < base.r) return
    const ang = Math.atan2(base.y - at.y, base.x - at.x)
    ctx.save()
    ctx.translate(at.x, at.y)
    ctx.rotate(ang)
    ctx.fillStyle = TC[team].light
    for (let i = 0; i < 3; i++) {
      const phase = ((t / 420 + i / 3) % 1)
      ctx.globalAlpha = Math.sin(phase * Math.PI) * 0.9
      const d = 28 + phase * 16
      ctx.beginPath()
      ctx.moveTo(d + 6, 0)
      ctx.lineTo(d - 2, -6)
      ctx.lineTo(d, 0)
      ctx.lineTo(d - 2, 6)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
    ctx.globalAlpha = 1
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: GPlayer, at: { x: number; y: number }, t: number, s: Snapshot, look: Look | null) {
    const R = this.map.playerR
    const { x, y } = at
    const c = TC[p.team]
    const isMe = p.id === this.me
    const a = this.a(p.id, x, y)
    const vx = x - a.lastX
    const vy = y - a.lastY
    const moving = Math.hypot(vx, vy) > 0.3
    if (moving) {
      a.walk += Math.hypot(vx, vy) * 0.2
      if (t - a.shotAt > 350) a.facing = Math.atan2(vy, vx)
    }
    a.lastX = x
    a.lastY = y
    const facing = isMe && this.myAim !== null && t - a.shotAt > 350 ? this.myAim : a.facing
    // An invisible ally (or me) is a faint shimmer; enemies that are invisible are never drawn at all.
    const dim = (p.connected ? 1 : 0.4) * (p.invisible ? 0.3 + 0.08 * Math.sin(t / 130) : 1) * (look?.ghost ?? 1)
    ctx.globalAlpha = dim

    // ground shadow
    ctx.fillStyle = alpha('#000000', 0.45)
    ctx.beginPath()
    ctx.ellipse(x + 2, y + R * 0.75, R, R * 0.42, 0, 0, TAU)
    ctx.fill()

    const carried = p.carryingFlag ? s.flags.find((f) => f.carrierId === p.id) : null
    if (carried) {
      // thin ring in the stolen flag's color: carriers read from across the map
      ctx.strokeStyle = TC[carried.team].base
      ctx.lineWidth = 2
      ctx.globalAlpha = dim * (0.55 + 0.45 * Math.sin(t / 160))
      ctx.beginPath()
      ctx.arc(x, y, R + 7, 0, TAU)
      ctx.stroke()
      ctx.globalAlpha = dim
    }

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(facing)
    // dash afterimages, trailing behind the way we are facing
    if (p.dashing) {
      for (let i = 3; i >= 1; i--) {
        ctx.save()
        ctx.globalAlpha = dim * (0.32 - i * 0.07)
        ctx.translate(-i * 12, 0)
        drawAvatar(ctx, p.class, c, R, 1, t, true)
        ctx.restore()
      }
    }
    // feet
    const swing = moving ? Math.sin(a.walk) * 5 : 0
    ctx.fillStyle = c.deep
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.ellipse(swing * side - 1, side * R * 0.55, 5, 3.6, 0, 0, TAU)
      ctx.fill()
    }
    // weapon (with recoil): the silhouette tells the rifle, shotgun and sniper apart
    const recoil = Math.max(0, 1 - (t - a.shotAt) / 90) * 4
    const gun = gunOf(p.weapon, R)
    drawWeapon(ctx, p.weapon, c, R, recoil)
    // body: the class silhouette in the team's colors
    drawAvatar(ctx, p.class, c, R, moving ? 1 : 1 + Math.sin(t / 420) * 0.025, t, true)
    // muzzle flash
    if (t - a.shotAt < 70) {
      const m = gun.len + R * 0.2
      bloom(ctx, c.light, m + 6, 0, 14, 11)
      ctx.fillStyle = '#FFF6D6'
      ctx.beginPath()
      ctx.moveTo(m + 6, 0)
      ctx.lineTo(m + 1, -4)
      ctx.lineTo(m + 11, 0)
      ctx.lineTo(m + 1, 4)
      ctx.closePath()
      ctx.fill()
    }
    // hit flash
    if (t - a.hitAt < 120) {
      ctx.globalAlpha = dim * (1 - (t - a.hitAt) / 120) * 0.85
      ctx.fillStyle = '#FFFFFF'
      ctx.beginPath()
      ctx.arc(0, 0, R + 1, 0, TAU)
      ctx.fill()
      ctx.globalAlpha = dim
    }
    ctx.restore()
    if (look?.state) this.drawStale(ctx, x, y, vx, vy, p.team, look.state, t, dim)

    if (carried) {
      this.drawPole(ctx, x - 7, y - R - 6, 0.7)
      this.drawCloth(ctx, x - 6, y - R - 21, carried.team, t, 0.7)
    }

    // team ring: BLUE solid, RED dashed, so team never depends on color alone
    ctx.strokeStyle = TC[p.team].base
    ctx.lineWidth = 1.5
    ctx.globalAlpha = dim * 0.7
    ctx.setLineDash(p.team === 'RED' ? [3, 3] : [])
    ctx.beginPath()
    ctx.arc(x, y, R + 3, 0, TAU)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = dim

    // my Q: a grey ring fills while it recharges; white once the skill is ready
    if (isMe && p.alive) {
      const total = this.cooldowns[p.class] ?? 0
      const left = Math.max(0, (p.abilityReadyAt ?? 0) - t)
      const ready = !total || left === 0
      ctx.strokeStyle = ready ? '#FFFFFF' : '#8A93A0'
      ctx.lineWidth = 2
      ctx.globalAlpha = dim * (ready ? 0.95 : 0.8)
      ctx.beginPath()
      ctx.arc(x, y, R + 6, -Math.PI / 2, -Math.PI / 2 + (ready ? 1 : 1 - Math.min(1, left / total)) * TAU)
      ctx.stroke()
      ctx.globalAlpha = dim
    }

    // HP (others only; mine lives in the HUD) + name
    const top = y - R - (carried ? 30 : 12)
    if (!isMe && p.hp < p.maxHp) {
      const bw = 30
      ctx.fillStyle = alpha('#000000', 0.6)
      ctx.beginPath()
      ctx.roundRect(x - bw / 2 - 1, top - 1, bw + 2, 5, 2)
      ctx.fill()
      ctx.fillStyle = p.hp > p.maxHp / 2 ? color.hpHigh : p.hp > p.maxHp / 4 ? color.hpMid : color.hpLow
      ctx.beginPath()
      ctx.roundRect(x - bw / 2, top, (bw * p.hp) / p.maxHp, 3, 1.5)
      ctx.fill()
    }
    if (isMe) {
      const bob = Math.sin(t / 300) * 1.5
      const my = top - 6 + bob
      ctx.fillStyle = '#FFFFFF'
      ctx.beginPath()
      ctx.moveTo(x, my + 6)
      ctx.lineTo(x - 6, my - 2)
      ctx.lineTo(x + 6, my - 2)
      ctx.closePath()
      ctx.fill()
    }
    this.drawName(ctx, p, x, y + R + 10, isMe)
    ctx.globalAlpha = 1
    this.drawEmote(ctx, p, a, x, top - (isMe ? 22 : 14), t)
  }

  /** Speech bubble over the player; pops in over 120 ms. Drawn at full alpha so a cloaked ally's emote still reads. */
  private drawEmote(ctx: CanvasRenderingContext2D, p: GPlayer, a: Anim, x: number, y: number, t: number) {
    if (p.emote === null || !p.alive) return void (a.emote = null)
    if (a.emote !== p.emote) (a.emote = p.emote), (a.emoteAt = t)
    const glyph = EMOTES[p.emote]
    if (!glyph) return
    const k = Math.min(1, (t - a.emoteAt) / 120)
    const pop = 0.6 + 0.4 * k * (2 - k) // ease-out
    ctx.save()
    ctx.translate(x, y - 14)
    ctx.scale(pop, pop)
    ctx.globalAlpha = k
    ctx.font = `${glyph.length > 1 ? '700 14px ' + font.display : '20px ' + font.text}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const w = Math.max(30, ctx.measureText(glyph).width + 14)
    ctx.fillStyle = alpha('#0B0E14', 0.82)
    ctx.strokeStyle = TC[p.team].base
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.roundRect(-w / 2, -15, w, 30, 10)
    ctx.moveTo(-5, 15) // little tail pointing at the player
    ctx.lineTo(0, 21)
    ctx.lineTo(5, 15)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(glyph, 0, 1)
    ctx.restore()
  }

  /** Name in a dark pill below the sprite, ellipsized to a max width, with a team shape marker (circle = BLUE, diamond = RED). */
  private drawName(ctx: CanvasRenderingContext2D, p: GPlayer, x: number, y: number, isMe: boolean) {
    const MAX = 78
    ctx.font = `600 11px ${font.text}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let name = p.name
    while (name.length > 1 && ctx.measureText(name).width > MAX) name = name.slice(0, -1)
    if (name !== p.name) name = name.trimEnd() + '…'
    const tw = ctx.measureText(name).width
    const w = tw + 24
    const h = 16
    const left = x - w / 2
    ctx.fillStyle = alpha(color.void, 0.72)
    ctx.beginPath()
    ctx.roundRect(left, y, w, h, 8)
    ctx.fill()
    const mx = left + 9
    const my = y + h / 2
    ctx.fillStyle = TC[p.team].base
    ctx.beginPath()
    if (p.team === 'BLUE') ctx.arc(mx, my, 3, 0, TAU)
    else {
      ctx.moveTo(mx, my - 3.6)
      ctx.lineTo(mx + 3.6, my)
      ctx.lineTo(mx, my + 3.6)
      ctx.lineTo(mx - 3.6, my)
      ctx.closePath()
    }
    ctx.fill()
    ctx.fillStyle = isMe ? '#FFFFFF' : color.ink
    ctx.fillText(name, left + 16, my + 0.5)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
  }

  private drawEffects(ctx: CanvasRenderingContext2D, t: number) {
    let n = 0
    for (const p of this.particles) {
      const age = t - p.born
      if (age > p.life) continue
      this.particles[n++] = p
      if (age < 0) continue
      const s = age / 1000
      const drag = 1 - Math.min(1, age / p.life) * 0.6
      ctx.globalAlpha = 1 - age / p.life
      ctx.fillStyle = p.color
      ctx.fillRect(p.x + p.vx * s * drag - p.size / 2, p.y + p.vy * s * drag - p.size / 2, p.size, p.size)
    }
    this.particles.length = n
    n = 0
    for (const r of this.rings) {
      const age = t - r.born
      if (age > r.life) continue
      this.rings[n++] = r
      if (age < 0) continue
      const u = age / r.life
      ctx.globalAlpha = 1 - u
      ctx.strokeStyle = r.color
      ctx.lineWidth = 3 * (1 - u) + 1
      ctx.beginPath()
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - (1 - u) ** 2), 0, TAU)
      ctx.stroke()
    }
    this.rings.length = n
    n = 0
    ctx.font = `800 15px ${font.display}`
    ctx.textAlign = 'center'
    ctx.lineWidth = 3
    ctx.strokeStyle = alpha('#000000', 0.7)
    for (const f of this.floaters) {
      const age = t - f.born
      if (age > 650) continue
      this.floaters[n++] = f
      if (age < 0) continue
      ctx.globalAlpha = 1 - (age / 650) ** 2
      const fy = f.y - age / 28
      ctx.strokeText(f.text, f.x, fy)
      ctx.fillStyle = f.color
      ctx.fillText(f.text, f.x, fy)
    }
    this.floaters.length = n
    ctx.globalAlpha = 1
  }
}

/* ─────────────── static map layer ─────────────── */

/** Painted once per match at 2x. Deterministic (seeded), so every client sees the same floor. */
function paintBackground(map: GMap): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = map.w * 2
  c.height = map.h * 2
  const ctx = c.getContext('2d')!
  ctx.scale(2, 2)
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

  // floor plates with slight tone variation
  ctx.fillStyle = color.ground
  ctx.fillRect(0, 0, map.w, map.h)
  const T = 50
  for (let y = 0; y < map.h; y += T) {
    for (let x = 0; x < map.w; x += T) {
      ctx.fillStyle = alpha(color.groundAlt, 0.4 + rnd() * 0.6)
      ctx.fillRect(x + 1, y + 1, T - 2, T - 2)
    }
  }
  // cyan grid lines between the floor plates
  ctx.strokeStyle = alpha(color.neon, 0.07)
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = T; x < map.w; x += T) (ctx.moveTo(x, 0), ctx.lineTo(x, map.h))
  for (let y = T; y < map.h; y += T) (ctx.moveTo(0, y), ctx.lineTo(map.w, y))
  ctx.stroke()
  ctx.fillStyle = alpha(color.ink, 0.05)
  for (let y = T; y < map.h; y += T) for (let x = T; x < map.w; x += T) ctx.fillRect(x - 1, y - 1, 2, 2)

  // territory: a soft wash from each side, fading before midfield
  for (const t of ['RED', 'BLUE'] as const) {
    const left = map.bases.find((b) => b.team === t)!.x < map.w / 2
    const g = ctx.createLinearGradient(left ? 0 : map.w, 0, map.w / 2, 0)
    g.addColorStop(0, alpha(TC[t].base, 0.14))
    g.addColorStop(1, alpha(TC[t].base, 0))
    ctx.fillStyle = g
    ctx.fillRect(left ? 0 : map.w / 2, 0, map.w / 2, map.h)
  }

  // midfield: contested zone ring, hatch band along the centre line
  const cx = map.w / 2
  const cy = map.h / 2
  ctx.strokeStyle = alpha(color.neon, 0.22)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, 170, 0, TAU)
  ctx.stroke()
  ctx.save()
  ctx.beginPath()
  ctx.rect(cx - 6, 0, 12, map.h)
  ctx.clip()
  ctx.strokeStyle = alpha(color.ink, 0.06)
  for (let y = -20; y < map.h + 20; y += 10) {
    ctx.beginPath()
    ctx.moveTo(cx - 8, y)
    ctx.lineTo(cx + 8, y + 12)
    ctx.stroke()
  }
  ctx.restore()

  // bases: glow, boundary, pedestal
  for (const b of map.bases) {
    const tc = TC[b.team]
    const g = ctx.createRadialGradient(b.x, b.y, 4, b.x, b.y, b.r * 2)
    g.addColorStop(0, alpha(tc.base, 0.22))
    g.addColorStop(1, alpha(tc.base, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(b.x, b.y, b.r * 2, 0, TAU)
    ctx.fill()
    ctx.fillStyle = alpha(tc.base, 0.08)
    ctx.beginPath()
    ctx.arc(b.x, b.y, b.r, 0, TAU)
    ctx.fill()
    // hex pedestal under the flag
    ctx.beginPath()
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + Math.PI / 6
      ctx.lineTo(b.x + Math.cos(a) * 17, b.y + 12 + Math.sin(a) * 9)
    }
    ctx.closePath()
    ctx.fillStyle = '#0B1017'
    ctx.fill()
    ctx.strokeStyle = alpha(tc.base, 0.8)
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // walls: extruded blocks (side face, lit top, inset panel, edge highlight, bolts)
  const H = 7
  for (const [x, y, w, h] of map.walls) {
    ctx.fillStyle = alpha('#000000', 0.5)
    ctx.beginPath()
    ctx.roundRect(x + 4, y + H + 4, w, h, 4)
    ctx.fill()
    ctx.fillStyle = color.wallSide
    ctx.beginPath()
    ctx.roundRect(x, y + H, w, h, 4)
    ctx.fill()
    const g = ctx.createLinearGradient(x, y, x + w * 0.3, y + h)
    g.addColorStop(0, color.wallTopLit)
    g.addColorStop(1, color.wallTop)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 4)
    ctx.fill()
    ctx.strokeStyle = alpha('#000000', 0.35)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x + 5, y + 5, w - 10, h - 10, 2)
    ctx.stroke()
    ctx.strokeStyle = alpha(color.neon, 0.4) // thin cyan outline around the lit top face
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4)
    ctx.stroke()
    ctx.strokeStyle = alpha(color.neon, 0.9) // lighter cyan top edge
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(x + 4, y + 0.8)
    ctx.lineTo(x + w - 4, y + 0.8)
    ctx.stroke()
    ctx.fillStyle = alpha(color.ink, 0.18)
    for (const [bx, by] of [[x + 3, y + 3], [x + w - 5, y + 3], [x + 3, y + h - 5], [x + w - 5, y + h - 5]]) ctx.fillRect(bx, by, 2, 2)
  }

  // arena frame
  ctx.strokeStyle = alpha(color.neon, 0.4)
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, map.w - 2, map.h - 2)
  return c
}

