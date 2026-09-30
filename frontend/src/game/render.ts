/* CTF client rendering: snapshot interpolation + canvas drawing + short-lived effects.
   Server is authoritative; this file never decides anything, it only shows server
   snapshots ~INTERP_MS in the past, smoothly. Colors come from tokens.ts. */

import { alpha, color, font, team as TC, type Team } from './tokens'

export type { Team }
export type GPlayer = {
  id: string
  name: string
  team: Team
  x: number
  y: number
  hp: number
  alive: boolean
  respawnAt: number | null
  carryingFlag: boolean
  connected: boolean
  bot: boolean
  killedBy: string | null
}
export type GFlag = { team: Team; x: number; y: number; state: 'AT_BASE' | 'CARRIED' | 'DROPPED'; carrierId: string | null; returnAt: number | null }
export type GShot = { id: number; owner: string; team: Team; x: number; y: number }
export type Snapshot = {
  t: 'state'
  now: number
  elapsed: number
  state: 'PLAYING' | 'ENDED'
  winner: Team | null
  players: GPlayer[]
  flags: GFlag[]
  shots: GShot[]
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
type Anim = { facing: number; walk: number; shotAt: number; hitAt: number; lastX: number; lastY: number; diedAt: number; deathX: number; deathY: number }

const MAX_PARTICLES = 240

export class Renderer {
  private bg: HTMLCanvasElement
  private particles: Particle[] = []
  private floaters: Floater[] = []
  private rings: Ring[] = []
  private anim = new Map<string, Anim>()
  private pending: { at: number; run: () => void }[] = []
  private map: GMap
  private me: string
  myAim: number | null = null

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
    if (!a) this.anim.set(id, (a = { facing: 0, walk: 0, shotAt: -1e9, hitAt: -1e9, lastX: x, lastY: y, diedAt: -1e9, deathX: x, deathY: y }))
    return a
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
      const q = prev.get(p.id)
      const tp = !q || Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > 80
      pos.set(p.id, tp ? { x: p.x, y: p.y } : { x: q.x + (p.x - q.x) * k, y: q.y + (p.y - q.y) * k })
    }
    const mine = B.players.find((p) => p.id === this.me)

    this.drawBases(ctx, B, t, mine)
    for (const f of B.flags) {
      if (f.state === 'AT_BASE') this.drawStandingFlag(ctx, f.x, f.y, f.team, t)
      else if (f.state === 'DROPPED') this.drawDropped(ctx, f, t)
    }

    // Shots with a short trail.
    const prevShots = new Map(A.shots.map((s) => [s.id, s]))
    ctx.lineCap = 'round'
    for (const s of B.shots) {
      const q = prevShots.get(s.id)
      if (!q) continue // appears next frame, from its real position
      const x = q.x + (s.x - q.x) * k
      const y = q.y + (s.y - q.y) * k
      const len = Math.hypot(s.x - q.x, s.y - q.y) || 1
      const dx = (s.x - q.x) / len
      const dy = (s.y - q.y) / len
      const g = ctx.createLinearGradient(x - dx * 28, y - dy * 28, x, y)
      g.addColorStop(0, alpha(TC[s.team].base, 0))
      g.addColorStop(1, TC[s.team].light)
      ctx.strokeStyle = g
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(x - dx * 28, y - dy * 28)
      ctx.lineTo(x, y)
      ctx.stroke()
      ctx.shadowColor = TC[s.team].base
      ctx.shadowBlur = 8
      ctx.fillStyle = '#FFFFFF'
      ctx.beginPath()
      ctx.arc(x, y, this.map.shotR - 0.5, 0, TAU)
      ctx.fill()
      ctx.shadowBlur = 0
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
    const order = B.players.filter((p) => p.alive).sort((a, b) => Number(a.id === this.me) - Number(b.id === this.me))
    for (const p of order) this.drawPlayer(ctx, p, pos.get(p.id)!, t, B)
    if (mine?.alive && mine.carryingFlag) this.drawHomeArrow(ctx, pos.get(mine.id)!, mine.team, t)

    this.drawEffects(ctx, t)
  }

  private drawBases(ctx: CanvasRenderingContext2D, s: Snapshot, t: number, mine?: GPlayer) {
    for (const b of this.map.bases) {
      const home = s.flags.find((f) => f.team === b.team)?.state === 'AT_BASE'
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

  private drawPlayer(ctx: CanvasRenderingContext2D, p: GPlayer, at: { x: number; y: number }, t: number, s: Snapshot) {
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
    const dim = p.connected ? 1 : 0.4
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
    // feet
    const swing = moving ? Math.sin(a.walk) * 5 : 0
    ctx.fillStyle = c.deep
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.ellipse(swing * side - 1, side * R * 0.55, 5, 3.6, 0, 0, TAU)
      ctx.fill()
    }
    // weapon (with recoil)
    const recoil = Math.max(0, 1 - (t - a.shotAt) / 90) * 4
    ctx.fillStyle = '#0B1017'
    ctx.beginPath()
    ctx.roundRect(R * 0.2 - recoil, -3.5, R + 6, 7, 2)
    ctx.fill()
    ctx.fillStyle = '#3A4557'
    ctx.fillRect(R * 0.2 - recoil + 2, -3.5, R + 2, 2)
    // body: dark rim, team fill, light rim on the lit side
    const breathe = moving ? 1 : 1 + Math.sin(t / 420) * 0.025
    ctx.fillStyle = '#0B1017'
    ctx.beginPath()
    ctx.arc(0, 0, (R + 1.5) * breathe, 0, TAU)
    ctx.fill()
    const g = ctx.createRadialGradient(-R * 0.35, -R * 0.35, 1, 0, 0, R)
    g.addColorStop(0, c.light)
    g.addColorStop(0.55, c.base)
    g.addColorStop(1, c.deep)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, R * breathe, 0, TAU)
    ctx.fill()
    // visor facing forward
    ctx.fillStyle = '#081019'
    ctx.beginPath()
    ctx.ellipse(R * 0.42, 0, 3.8, 7.5, 0, 0, TAU)
    ctx.fill()
    ctx.fillStyle = c.ink
    ctx.fillRect(R * 0.42, -4.5, 1.6, 3.5)
    // muzzle flash
    if (t - a.shotAt < 70) {
      ctx.fillStyle = '#FFF6D6'
      ctx.shadowColor = c.light
      ctx.shadowBlur = 12
      ctx.beginPath()
      ctx.moveTo(R + 12, 0)
      ctx.lineTo(R + 7, -4)
      ctx.lineTo(R + 17, 0)
      ctx.lineTo(R + 7, 4)
      ctx.closePath()
      ctx.fill()
      ctx.shadowBlur = 0
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

    if (carried) {
      this.drawPole(ctx, x - 7, y - R - 6, 0.7)
      this.drawCloth(ctx, x - 6, y - R - 21, carried.team, t, 0.7)
    }

    // me: crisp white outline + a small marker overhead
    if (isMe) {
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(x, y, R + 3.5, 0, TAU)
      ctx.stroke()
    }

    // HP (others only; mine lives in the HUD) + name
    const top = y - R - (carried ? 30 : 12)
    if (!isMe && p.hp < 100) {
      const bw = 30
      ctx.fillStyle = alpha('#000000', 0.6)
      ctx.beginPath()
      ctx.roundRect(x - bw / 2 - 1, top - 1, bw + 2, 5, 2)
      ctx.fill()
      ctx.fillStyle = p.hp > 50 ? color.hpHigh : p.hp > 25 ? color.hpMid : color.hpLow
      ctx.beginPath()
      ctx.roundRect(x - bw / 2, top, (bw * p.hp) / 100, 3, 1.5)
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
    this.drawName(ctx, p, x, y + R + 15, isMe)
    ctx.globalAlpha = 1
  }

  private drawName(ctx: CanvasRenderingContext2D, p: GPlayer, x: number, y: number, isMe: boolean) {
    ctx.font = `600 11px ${font.text}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    const tag = !p.connected ? 'OFFLINE' : p.bot ? 'BOT' : null
    const nameW = ctx.measureText(p.name).width
    ctx.font = `700 8px ${font.text}`
    const tagW = tag ? ctx.measureText(tag).width + 8 : 0
    const total = nameW + (tag ? tagW + 4 : 0)
    const x0 = x - total / 2
    ctx.font = `600 11px ${font.text}`
    ctx.lineWidth = 3
    ctx.strokeStyle = alpha('#000000', 0.7)
    ctx.textAlign = 'left'
    ctx.strokeText(p.name, x0, y)
    ctx.fillStyle = isMe ? '#FFFFFF' : color.ink
    ctx.fillText(p.name, x0, y)
    if (tag) {
      const tx = x0 + nameW + 4
      ctx.fillStyle = p.connected ? alpha(color.ink, 0.14) : alpha(color.signal, 0.2)
      ctx.beginPath()
      ctx.roundRect(tx, y - 9, tagW, 11, 2)
      ctx.fill()
      ctx.font = `700 8px ${font.text}`
      ctx.fillStyle = p.connected ? color.dim : color.signal
      ctx.fillText(tag, tx + 4, y - 1)
    }
    ctx.textAlign = 'center'
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
  // plate seams + rivet dots at corners
  ctx.strokeStyle = alpha('#000000', 0.35)
  ctx.lineWidth = 1
  for (let x = 0; x <= map.w; x += T) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, map.h)
    ctx.stroke()
  }
  for (let y = 0; y <= map.h; y += T) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(map.w, y + 0.5)
    ctx.stroke()
  }
  ctx.fillStyle = alpha(color.ink, 0.05)
  for (let y = T; y < map.h; y += T) for (let x = T; x < map.w; x += T) ctx.fillRect(x - 1, y - 1, 2, 2)

  // territory: a soft wash from each side, fading before midfield
  for (const t of ['RED', 'BLUE'] as const) {
    const left = map.bases.find((b) => b.team === t)!.x < map.w / 2
    const g = ctx.createLinearGradient(left ? 0 : map.w, 0, map.w / 2, 0)
    g.addColorStop(0, alpha(TC[t].base, 0.1))
    g.addColorStop(1, alpha(TC[t].base, 0))
    ctx.fillStyle = g
    ctx.fillRect(left ? 0 : map.w / 2, 0, map.w / 2, map.h)
  }

  // midfield: contested zone ring, hatch band along the centre line, corner ticks
  const cx = map.w / 2
  const cy = map.h / 2
  ctx.strokeStyle = alpha(color.ink, 0.07)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, 170, 0, TAU)
  ctx.stroke()
  ctx.setLineDash([2, 10])
  ctx.beginPath()
  ctx.arc(cx, cy, 196, 0, TAU)
  ctx.stroke()
  ctx.setLineDash([])
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

  // bases: glow, boundary, tick ring, pedestal, spawn pads
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
    ctx.strokeStyle = alpha(tc.base, 0.5)
    ctx.lineWidth = 1.5
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU
      ctx.beginPath()
      ctx.moveTo(b.x + Math.cos(a) * (b.r - 10), b.y + Math.sin(a) * (b.r - 10))
      ctx.lineTo(b.x + Math.cos(a) * (b.r - (i % 6 ? 6 : 2)), b.y + Math.sin(a) * (b.r - (i % 6 ? 6 : 2)))
      ctx.stroke()
    }
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
  for (const s of map.spawns) {
    const tc = TC[s.team]
    const dir = s.x < map.w / 2 ? 1 : -1 // arrow points toward midfield
    ctx.fillStyle = alpha(tc.base, 0.07)
    ctx.strokeStyle = alpha(tc.base, 0.35)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(s.x - 16, s.y - 16, 32, 32, 5)
    ctx.fill()
    ctx.stroke()
    ctx.strokeStyle = alpha(tc.base, 0.5)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(s.x - 4 * dir, s.y - 6)
    ctx.lineTo(s.x + 3 * dir, s.y)
    ctx.lineTo(s.x - 4 * dir, s.y + 6)
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
    ctx.strokeStyle = color.wallEdge
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(x + 4, y + 0.8)
    ctx.lineTo(x + w - 4, y + 0.8)
    ctx.stroke()
    ctx.fillStyle = alpha(color.ink, 0.18)
    for (const [bx, by] of [[x + 3, y + 3], [x + w - 5, y + 3], [x + 3, y + h - 5], [x + w - 5, y + h - 5]]) ctx.fillRect(bx, by, 2, 2)
  }

  // arena frame
  ctx.strokeStyle = alpha(color.ink, 0.12)
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, map.w - 2, map.h - 2)
  return c
}

