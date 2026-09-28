/* CTF client rendering: snapshot interpolation + canvas drawing + short-lived effects.
   Server is authoritative; this file never decides anything, it only shows server
   snapshots ~INTERP_MS in the past, smoothly. */

export type Team = 'RED' | 'BLUE'
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
}
export type GFlag = { team: Team; x: number; y: number; state: 'AT_BASE' | 'CARRIED' | 'DROPPED'; carrierId: string | null; returnAt: number | null }
export type GShot = { id: number; team: Team; x: number; y: number }
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
  playerR: number
  shotR: number
}

export const COLOR: Record<Team, string> = { RED: '#ef4444', BLUE: '#3b82f6' }
const LIGHT: Record<Team, string> = { RED: '#fca5a5', BLUE: '#93c5fd' }
const DARK: Record<Team, string> = { RED: '#7f1d1d', BLUE: '#1e3a8a' }
const INTERP_MS = 100 // ~3 snapshots at 30 Hz

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
    this.burst(x, y, 7, '#fff7cc', 120, 260, t, 2)
    this.burst(x, y, 5, LIGHT[team], 80, 300, t, 2.5)
    this.floaters.push({ x, y: y - 20, born: t, text: `-${dmg}`, color: '#fde68a' })
  }

  death(pid: string, x: number, y: number, team: Team, t: number) {
    const a = this.a(pid, x, y)
    a.diedAt = t
    a.deathX = x
    a.deathY = y
    this.burst(x, y, 18, COLOR[team], 160, 600, t, 3.5)
    this.rings.push({ x, y, born: t, life: 450, color: COLOR[team], r0: 10, r1: 46 })
  }

  flagEvent(x: number, y: number, team: Team, t: number, big = false) {
    this.rings.push({ x, y, born: t, life: big ? 900 : 600, color: COLOR[team], r0: 12, r1: big ? 120 : 60 })
    this.burst(x, y, big ? 30 : 12, LIGHT[team], big ? 220 : 120, big ? 900 : 500, t, 3)
  }

  private burst(x: number, y: number, n: number, color: string, speed: number, life: number, t: number, size: number) {
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift()
      const ang = Math.random() * Math.PI * 2
      const v = speed * (0.4 + Math.random() * 0.6)
      this.particles.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, born: t, life: life * (0.6 + Math.random() * 0.4), color, size })
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

    this.drawBases(ctx, B, t)
    for (const f of B.flags) {
      if (f.state === 'AT_BASE') this.drawFlag(ctx, f.x, f.y, f.team, t, 1)
      else if (f.state === 'DROPPED') this.drawDropped(ctx, f, t)
    }

    // Shots with a short trail.
    const prevShots = new Map(A.shots.map((s) => [s.id, s]))
    for (const s of B.shots) {
      const q = prevShots.get(s.id)
      if (!q) continue // appears next frame, from its real position
      const x = q.x + (s.x - q.x) * k
      const y = q.y + (s.y - q.y) * k
      const len = Math.hypot(s.x - q.x, s.y - q.y) || 1
      const dx = (s.x - q.x) / len
      const dy = (s.y - q.y) / len
      const g = ctx.createLinearGradient(x - dx * 26, y - dy * 26, x, y)
      g.addColorStop(0, 'transparent')
      g.addColorStop(1, LIGHT[s.team])
      ctx.strokeStyle = g
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x - dx * 26, y - dy * 26)
      ctx.lineTo(x, y)
      ctx.stroke()
      ctx.shadowColor = COLOR[s.team]
      ctx.shadowBlur = 10
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(x, y, map.shotR, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
    }

    // Death markers for players waiting to respawn.
    for (const p of B.players) {
      if (p.alive) continue
      const a = this.anim.get(p.id)
      if (!a || t < a.diedAt) continue
      const fade = Math.min(1, (t - a.diedAt) / 400)
      ctx.globalAlpha = 0.35 * fade
      ctx.strokeStyle = COLOR[p.team]
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(a.deathX - 7, a.deathY - 7)
      ctx.lineTo(a.deathX + 7, a.deathY + 7)
      ctx.moveTo(a.deathX + 7, a.deathY - 7)
      ctx.lineTo(a.deathX - 7, a.deathY + 7)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Players: me last so I'm always on top.
    const order = B.players.filter((p) => p.alive).sort((a, b) => Number(a.id === this.me) - Number(b.id === this.me))
    for (const p of order) this.drawPlayer(ctx, p, pos.get(p.id)!, t, B)

    this.drawEffects(ctx, t)
  }

  private drawBases(ctx: CanvasRenderingContext2D, s: Snapshot, t: number) {
    for (const b of this.map.bases) {
      const home = s.flags.find((f) => f.team === b.team)?.state === 'AT_BASE'
      const pulse = 0.5 + 0.5 * Math.sin(t / 220)
      ctx.strokeStyle = COLOR[b.team]
      ctx.globalAlpha = home ? 0.55 : 0.35 + 0.5 * pulse
      ctx.lineWidth = home ? 2 : 3
      ctx.setLineDash(home ? [] : [10, 8])
      ctx.lineDashOffset = -t / 40
      ctx.beginPath()
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
  }

  private drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, team: Team, t: number, scale: number, glow = true) {
    if (glow) {
      const pulse = 0.75 + 0.25 * Math.sin(t / 300)
      const g = ctx.createRadialGradient(x, y, 2, x, y, 34 * scale)
      g.addColorStop(0, COLOR[team] + '66')
      g.addColorStop(1, 'transparent')
      ctx.globalAlpha = pulse
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, 34 * scale, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
    // stand + pole
    ctx.fillStyle = '#0b0d13aa'
    ctx.beginPath()
    ctx.ellipse(x, y + 12 * scale, 9 * scale, 3.5 * scale, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#d1d5db'
    ctx.lineWidth = 2.5 * scale
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x, y + 12 * scale)
    ctx.lineTo(x, y - 20 * scale)
    ctx.stroke()
    // waving cloth
    const w = 22 * scale
    const h = 13 * scale
    const top = y - 20 * scale
    ctx.fillStyle = COLOR[team]
    ctx.beginPath()
    ctx.moveTo(x, top)
    for (let i = 1; i <= 6; i++) {
      const u = i / 6
      ctx.lineTo(x + w * u, top + Math.sin(t / 140 - u * 3) * 2.2 * u * scale)
    }
    for (let i = 6; i >= 0; i--) {
      const u = i / 6
      ctx.lineTo(x + w * u, top + h + Math.sin(t / 140 - u * 3) * 2.2 * u * scale)
    }
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = DARK[team]
    ctx.lineWidth = 1
    ctx.stroke()
  }

  private drawDropped(ctx: CanvasRenderingContext2D, f: GFlag, t: number) {
    const bob = Math.sin(t / 180) * 2
    this.drawFlag(ctx, f.x, f.y + bob, f.team, t, 0.9)
    if (f.returnAt) {
      // countdown ring until the automatic return
      const left = Math.max(0, Math.min(1, (f.returnAt - t) / 10_000))
      ctx.strokeStyle = COLOR[f.team]
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(f.x, f.y, 26, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = '#ffffff22'
      ctx.beginPath()
      ctx.arc(f.x, f.y, 26, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: GPlayer, at: { x: number; y: number }, t: number, s: Snapshot) {
    const R = this.map.playerR
    const { x, y } = at
    const a = this.a(p.id, x, y)
    const vx = x - a.lastX
    const vy = y - a.lastY
    const moving = Math.hypot(vx, vy) > 0.3
    if (moving) {
      a.walk += Math.hypot(vx, vy) * 0.18
      if (t - a.shotAt > 350) a.facing = Math.atan2(vy, vx)
    }
    a.lastX = x
    a.lastY = y
    const facing = p.id === this.me && this.myAim !== null && t - a.shotAt > 350 ? this.myAim : a.facing
    ctx.globalAlpha = p.connected ? 1 : 0.4

    // carried enemy flag: glow ring under the carrier, flag on their back
    const carried = p.carryingFlag ? s.flags.find((f) => f.carrierId === p.id) : null
    if (carried) {
      const pulse = 0.6 + 0.4 * Math.sin(t / 150)
      ctx.strokeStyle = COLOR[carried.team]
      ctx.lineWidth = 3
      ctx.globalAlpha *= pulse
      ctx.beginPath()
      ctx.arc(x, y, R + 9, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = p.connected ? 1 : 0.4
    }

    // shadow
    ctx.fillStyle = '#00000055'
    ctx.beginPath()
    ctx.ellipse(x + 2, y + R * 0.7, R * 0.95, R * 0.45, 0, 0, Math.PI * 2)
    ctx.fill()

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(facing)
    // feet swing while walking
    const swing = moving ? Math.sin(a.walk) * 5 : 0
    ctx.fillStyle = DARK[p.team]
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.ellipse(swing * side, side * R * 0.55, 5, 3.6, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    // gun, with recoil
    const recoil = Math.max(0, 1 - (t - a.shotAt) / 90) * 4
    ctx.fillStyle = '#1f2937'
    ctx.fillRect(R * 0.3 - recoil, -3, R + 4, 6)
    ctx.fillStyle = '#4b5563'
    ctx.fillRect(R * 0.3 - recoil, -3, R + 4, 2)
    // body
    const breathe = moving ? 1 : 1 + Math.sin(t / 400) * 0.03
    const g = ctx.createRadialGradient(-R * 0.3, -R * 0.35, 2, 0, 0, R)
    g.addColorStop(0, LIGHT[p.team])
    g.addColorStop(1, COLOR[p.team])
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, R * breathe, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = DARK[p.team]
    ctx.lineWidth = 2
    ctx.stroke()
    // visor
    ctx.fillStyle = '#0b1220'
    ctx.beginPath()
    ctx.ellipse(R * 0.45, 0, 3.5, 7, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#e0f2fe'
    ctx.fillRect(R * 0.45, -4, 1.5, 3)
    // muzzle flash
    if (t - a.shotAt < 70) {
      ctx.fillStyle = '#fff7cc'
      ctx.shadowColor = '#fbbf24'
      ctx.shadowBlur = 14
      ctx.beginPath()
      ctx.arc(R * 1.45 + 4, 0, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
    }
    // hit flash
    if (t - a.hitAt < 120) {
      ctx.globalAlpha = (1 - (t - a.hitAt) / 120) * 0.85
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(0, 0, R + 1, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = p.connected ? 1 : 0.4
    }
    ctx.restore()

    if (carried) this.drawFlag(ctx, x - 6, y - R - 6, carried.team, t, 0.8, false)

    // me: rotating dashed ring
    if (p.id === this.me) {
      ctx.strokeStyle = '#ffffffcc'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 5])
      ctx.lineDashOffset = t / 60
      ctx.beginPath()
      ctx.arc(x, y, R + 5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // HP bar + name
    const bw = 34
    const top = y - R - (carried ? 34 : 14)
    ctx.fillStyle = '#000000aa'
    roundRect(ctx, x - bw / 2 - 1, top - 1, bw + 2, 6, 3)
    ctx.fill()
    ctx.fillStyle = p.hp > 50 ? '#3ddc84' : p.hp > 25 ? '#f5b83d' : '#f0506e'
    roundRect(ctx, x - bw / 2, top, (bw * p.hp) / 100, 4, 2)
    ctx.fill()
    ctx.font = '600 11px Inter, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#000000aa'
    const label = p.connected ? (p.bot ? `${p.name} · BOT` : p.name) : `${p.name} · OFFLINE`
    ctx.fillText(label, x + 1, y + R + 15)
    ctx.fillStyle = p.id === this.me ? '#ffffff' : '#d1d5db'
    ctx.fillText(label, x, y + R + 14)
    ctx.globalAlpha = 1
  }

  private drawEffects(ctx: CanvasRenderingContext2D, t: number) {
    // particles (simple ballistic fade; dt derived from age so no per-frame state)
    let n = 0
    for (const p of this.particles) {
      const age = t - p.born
      if (age < 0) {
        this.particles[n++] = p
        continue
      }
      if (age > p.life) continue
      const s = age / 1000
      const drag = 1 - Math.min(1, age / p.life) * 0.6
      ctx.globalAlpha = 1 - age / p.life
      ctx.fillStyle = p.color
      ctx.fillRect(p.x + p.vx * s * drag - p.size / 2, p.y + p.vy * s * drag - p.size / 2, p.size, p.size)
      this.particles[n++] = p
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
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - (1 - u) ** 2), 0, Math.PI * 2)
      ctx.stroke()
    }
    this.rings.length = n
    n = 0
    ctx.font = '800 14px "Chakra Petch", sans-serif'
    ctx.textAlign = 'center'
    for (const f of this.floaters) {
      const age = t - f.born
      if (age > 700) continue
      this.floaters[n++] = f
      if (age < 0) continue
      ctx.globalAlpha = 1 - age / 700
      ctx.fillStyle = '#000'
      ctx.fillText(f.text, f.x + 1, f.y - age / 25 + 1)
      ctx.fillStyle = f.color
      ctx.fillText(f.text, f.x, f.y - age / 25)
    }
    this.floaters.length = n
    ctx.globalAlpha = 1
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(0, w), h, Math.min(r, Math.max(0, w) / 2))
}

/** Static map layer, painted once per match. */
function paintBackground(map: GMap): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = map.w * 2
  c.height = map.h * 2
  const ctx = c.getContext('2d')!
  ctx.scale(2, 2)
  ctx.fillStyle = '#0e121b'
  ctx.fillRect(0, 0, map.w, map.h)
  // ground tiles
  const T = 40
  for (let y = 0; y < map.h; y += T) {
    for (let x = 0; x < map.w; x += T) {
      ctx.fillStyle = (x / T + y / T) % 2 ? '#111724' : '#0f1420'
      ctx.fillRect(x, y, T, T)
    }
  }
  ctx.strokeStyle = '#ffffff08'
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
  // territory tint
  const tint = (x0: number, x1: number, team: Team) => {
    const g = ctx.createLinearGradient(x0, 0, x1, 0)
    g.addColorStop(0, COLOR[team] + '1f')
    g.addColorStop(1, COLOR[team] + '00')
    ctx.fillStyle = g
    ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), map.h)
  }
  tint(0, map.w / 2, 'RED')
  tint(map.w, map.w / 2, 'BLUE')
  // midline + centre circle
  ctx.strokeStyle = '#ffffff14'
  ctx.lineWidth = 2
  ctx.setLineDash([12, 12])
  ctx.beginPath()
  ctx.moveTo(map.w / 2, 0)
  ctx.lineTo(map.w / 2, map.h)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(map.w / 2, map.h / 2, 150, 0, Math.PI * 2)
  ctx.stroke()
  // bases
  for (const b of map.bases) {
    const g = ctx.createRadialGradient(b.x, b.y, 4, b.x, b.y, b.r * 1.8)
    g.addColorStop(0, COLOR[b.team] + '40')
    g.addColorStop(1, COLOR[b.team] + '00')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(b.x, b.y, b.r * 1.8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLOR[b.team] + '18'
    ctx.beginPath()
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = COLOR[b.team] + '55'
    ctx.setLineDash([4, 6])
    ctx.beginPath()
    ctx.arc(b.x, b.y, b.r - 12, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#0b0d13'
    ctx.strokeStyle = COLOR[b.team] + '99'
    ctx.beginPath()
    ctx.arc(b.x, b.y + 12, 13, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  // walls: drop shadow, body, lit top edge
  for (const [x, y, w, h] of map.walls) {
    ctx.fillStyle = '#00000066'
    ctx.beginPath()
    ctx.roundRect(x + 5, y + 7, w, h, 5)
    ctx.fill()
    const g = ctx.createLinearGradient(x, y, x, y + h)
    g.addColorStop(0, '#343d52')
    g.addColorStop(1, '#232a3a')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 5)
    ctx.fill()
    ctx.strokeStyle = '#151a26'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.strokeStyle = '#56627e'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x + 4, y + 1.5)
    ctx.lineTo(x + w - 4, y + 1.5)
    ctx.stroke()
  }
  // border
  ctx.strokeStyle = '#ffffff1a'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, map.w - 2, map.h - 2)
  return c
}
