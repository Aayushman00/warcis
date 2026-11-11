import type { GMap } from './render'

/* Client-side prediction for MY player only. Without it my own movement showed up a full round trip plus the
   100 ms interpolation buffer after the key press. Here I move at once with the server's rules (same speed,
   same circle-vs-rect walls, axis-separated sliding), and every snapshot nudges me toward the truth.

   Inputs are held state, not numbered commands, so reconciliation is by time: the server position in a snapshot
   matches where I predicted myself ~one round trip ago. The difference is eased in, and the stored history is
   shifted by the same amount so the next snapshot does not correct the same error twice. */

const SPEED = 220 // px/s, mirrors game-service sim.SPEED
const INTRO_MS = 3000 // mirrors sim.INTRO_MS: nobody moves during 3-2-1
const HALF_TICK = 17 // an input waits on average half a 30 Hz tick before the server applies it
const EASE = 0.2 // share of the remaining error removed per snapshot (~150 ms to settle at 30 Hz)
const SNAP = 220 // further off than this (round reset, long hitch) jumps instead of sliding through walls
const KEEP_MS = 1000

type P = { x: number; y: number }

export class Predictor {
  pos: P | null = null
  dir: P = { x: 0, y: 0 } // unit vector or zero, view space
  rtt = 100 // smoothed round trip, ms
  private canMove = false
  private last = 0
  private hist: { t: number; x: number; y: number }[] = []
  private map: GMap

  constructor(map: GMap) {
    this.map = map
  }

  setRtt(ms: number) {
    this.rtt += (ms - this.rtt) * 0.2
  }

  /** Advance one render frame. */
  step(now: number) {
    const dt = Math.min(0.1, Math.max(0, now - this.last) / 1000) // a background tab must not teleport me
    this.last = now
    const p = this.pos
    if (!p) return
    if (this.canMove && (this.dir.x || this.dir.y)) {
      const vx = this.dir.x * SPEED * dt
      const vy = this.dir.y * SPEED * dt
      if (!this.hits(p.x + vx, p.y)) p.x += vx
      if (!this.hits(p.x, p.y + vy)) p.y += vy
    }
    this.hist.push({ t: now, x: p.x, y: p.y })
    while (this.hist.length && this.hist[0].t < now - KEEP_MS) this.hist.shift()
  }

  /** A snapshot arrived with my authoritative position (null = dead or not on the map). */
  server(x: number | null, y: number | null, canMove: boolean, now: number) {
    this.canMove = canMove
    if (x === null || y === null) {
      this.pos = null
      this.hist = []
      return
    }
    if (!this.pos) {
      this.pos = { x, y }
      return
    }
    const then = now - this.rtt - HALF_TICK
    let h: P = this.pos
    for (let i = this.hist.length - 1; i >= 0; i--) {
      if (this.hist[i].t <= then) {
        h = this.hist[i]
        break
      }
    }
    const ex = x - h.x
    const ey = y - h.y
    if (Math.hypot(ex, ey) > SNAP) {
      this.pos = { x, y }
      this.hist = []
      return
    }
    const cx = ex * EASE
    const cy = ey * EASE
    this.pos.x += cx
    this.pos.y += cy
    for (const e of this.hist) {
      e.x += cx
      e.y += cy
    }
  }

  private hits(x: number, y: number) {
    const r = this.map.playerR
    if (x < r || y < r || x > this.map.w - r || y > this.map.h - r) return true
    return this.map.walls.some(([wx, wy, ww, wh]) => {
      const cx = Math.min(Math.max(x, wx), wx + ww)
      const cy = Math.min(Math.max(y, wy), wy + wh)
      return (x - cx) ** 2 + (y - cy) ** 2 < r * r
    })
  }
}

/* My own shots, drawn the instant I fire from where I am drawn (predicted, "now"). The server's copies of them
   live on the interpolated clock ~100 ms + a round trip behind, so while moving they appeared to leave from where
   I used to be. These are cosmetic only: hits, damage and kills still come from the server. */

type Rect = [number, number, number, number]
export type ShotSpec = { speed: number; pellets: number; spread: number; ttlMs: number }
export type Tracer = { x: number; y: number; vx: number; vy: number; born: number; at: number; ttl: number; w: string }

/** Same deterministic fan as sim.fire; aiming at myself fires nothing, like the server. */
export function spawnTracers(from: P, aim: P, w: string, spec: ShotSpec, t: number): Tracer[] {
  const dx = aim.x - from.x
  const dy = aim.y - from.y
  if (Math.hypot(dx, dy) < 1e-6) return []
  const base = Math.atan2(dy, dx)
  const n = spec.pellets
  return Array.from({ length: n }, (_, i) => {
    const a = base + (n > 1 ? spec.spread * (i / (n - 1) - 0.5) : 0)
    return { x: from.x, y: from.y, vx: Math.cos(a) * spec.speed, vy: Math.sin(a) * spec.speed, born: t, at: t, ttl: spec.ttlMs, w }
  })
}

/** Advance to time t in steps of at most 6 px (nothing tunnels a 12 px barrier). False once it hits a wall,
 *  the map edge, a rect or a circle, or its range runs out; it then stays at the last free point. */
export function stepTracer(s: Tracer, t: number, map: GMap, rects: Rect[], circles: { x: number; y: number; r: number }[]): boolean {
  const end = Math.min(t, s.born + s.ttl)
  const secs = Math.max(0, end - s.at) / 1000
  const R = map.shotR
  const inRect = (x: number, y: number, [rx, ry, rw, rh]: Rect) => x > rx - R && x < rx + rw + R && y > ry - R && y < ry + rh + R
  const n = Math.max(1, Math.ceil((Math.hypot(s.vx, s.vy) * secs) / 6))
  for (let i = 0; i < n; i++) {
    const x = s.x + (s.vx * secs) / n
    const y = s.y + (s.vy * secs) / n
    if (x < R || y < R || x > map.w - R || y > map.h - R || map.walls.some((w) => inRect(x, y, w)) || rects.some((r) => inRect(x, y, r)) || circles.some((c) => Math.hypot(x - c.x, y - c.y) < c.r + R))
      return false
    s.x = x
    s.y = y
  }
  s.at = end
  return t < s.born + s.ttl
}

/** Movement may happen: same gates as the server's step (intro, intermission, match over). */
export const movable = (s: { state: string; elapsed: number; resumesAt: number | null }) => s.state === 'PLAYING' && s.elapsed >= INTRO_MS && !s.resumesAt
