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

/** Movement may happen: same gates as the server's step (intro, intermission, match over). */
export const movable = (s: { state: string; elapsed: number; resumesAt: number | null }) => s.state === 'PLAYING' && s.elapsed >= INTRO_MS && !s.resumesAt
