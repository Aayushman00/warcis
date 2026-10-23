/* The match lobby's armory: a live stage that shows the build you are making (class + weapon, drawn exactly as the
   arena will), and the class and weapon pickers. Everything here is presentation: the lobby still sends only the
   chosen ids, and the server owns the loadout, the ready flags and the clock. */

import { useEffect, useLayoutEffect, useRef, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import type { ClassId, WeaponId } from './api'
import { BUILD, CLASS_IDS, CLASS_INFO, drawAvatar, drawWeapon, gunOf, WEAPON_IDS, WEAPON_INFO, type Rating } from './game/classes'
import { sfx, unlockAudio } from './game/sfx'
import { team as TC } from './game/tokens'

const TAU = Math.PI * 2
const BASE_R = 14 // the arena's player radius: the lobby scales the same drawing up instead of redrawing it

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A canvas sized to its box at device resolution, redrawn every frame (or once, with reduced motion). */
function useCanvasLoop(draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(draw)
  useLayoutEffect(() => {
    drawRef.current = draw
  })
  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    let raf = 0
    const still = reducedMotion()
    const frame = (t: number) => {
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      drawRef.current(ctx, w, h, still ? 0 : t)
      if (!still) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])
  return ref
}

/** A class avatar, idling: the arena drawing at lobby size. `side` picks the team colors (you are always blue). */
export function ClassAvatar({ cls, side = 'ally', size = 56, weapon }: { cls: ClassId; side?: 'ally' | 'foe'; size?: number; weapon?: WeaponId }) {
  const pal = side === 'ally' ? TC.BLUE : TC.RED
  const ref = useCanvasLoop((ctx, w, h, t) => {
    const k = (Math.min(w, h) * 0.3) / BASE_R
    ctx.translate(w / 2 - (weapon ? BASE_R * k * 0.12 : 0), h / 2)
    ctx.scale(k, k)
    ctx.rotate(-0.35 + Math.sin(t / 1300) * 0.12)
    if (weapon) drawWeapon(ctx, weapon, pal, BASE_R)
    drawAvatar(ctx, cls, pal, BASE_R, 1 + Math.sin(t / 420) * 0.025, t)
  })
  return <canvas ref={ref} style={{ width: size, height: size }} aria-label={CLASS_INFO[cls].name} role="img" />
}

/** An enemy whose pick is still hidden: their class is revealed only when the match starts. */
export function HiddenAvatar({ size = 36 }: { size?: number }) {
  return (
    <span
      className="grid place-items-center rounded-full border border-dashed border-foe/40 bg-foe/[0.06] font-display font-bold text-foe/70"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title="Enemy picks are hidden until the match starts"
    >
      ?
    </span>
  )
}

/* ─────────────── stage ─────────────── */

type Shot = { at: number; ang: number; weapon: WeaponId }
type Spark = { x: number; y: number; vx: number; vy: number; life: number; born: number }

const STAGE_COOLDOWN: Record<WeaponId, number> = { ASSAULT_RIFLE: 150, SHOTGUN: 650, SNIPER_RIFLE: 1300 } // test fire only

/**
 * The build on a pedestal, at hero size. It turns to face the pointer and test-fires on click, so the pick feels
 * like a character in your hands; switching class materializes the new body, switching weapon racks it.
 */
function HeroStage({ cls, weapon, locked, children }: { cls: ClassId | undefined; weapon: WeaponId | undefined; locked: boolean; children?: ReactNode }) {
  const st = useRef({
    aim: -0.3, // radians, eased toward the pointer
    want: -0.3,
    pointer: false,
    swapAt: -1e9, // class materialize start
    rackAt: -1e9, // weapon equip start
    shotAt: -1e9,
    shots: [] as Shot[],
    sparks: [] as Spark[],
    seen: { cls, weapon, locked }, // the props as of the last frame: a change starts its animation
    lockedAt: -1e9,
    now: 0,
  })

  const pal = TC.BLUE
  const burst = (n: number) => {
    const s = st.current
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const v = 60 + Math.random() * 160
      s.sparks.push({ x: 0, y: 0, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 500 + Math.random() * 400, born: s.now })
    }
  }
  const ref = useCanvasLoop((ctx, w, h, t) => {
    const s = st.current
    s.now = t
    if (cls !== s.seen.cls) {
      s.swapAt = t
      if (cls) burst(26)
    }
    if (weapon !== s.seen.weapon) s.rackAt = t
    if (locked && !s.seen.locked) {
      s.lockedAt = t
      burst(40)
    }
    s.seen = { cls, weapon, locked }
    const cx = w / 2
    const cy = h * 0.52
    const k = Math.min(w * 0.9, h * 1.1) / 100 // avatar scale: the arena's R=14 body at hero size
    const gold = '#F5B83D'
    const accent = locked ? gold : pal.base

    // floor: spotlight and a slow perspective grid
    const spot = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(w, h) * 0.6)
    spot.addColorStop(0, pal.base + '2e')
    spot.addColorStop(1, pal.base + '00')
    ctx.fillStyle = spot
    ctx.fillRect(0, 0, w, h)
    ctx.save()
    ctx.strokeStyle = pal.light + '14'
    ctx.lineWidth = 1
    const hz = cy + BASE_R * k * 0.6
    for (let i = 0; i < 9; i++) {
      const y = hz + Math.pow(((i + ((t / 2400) % 1)) / 9), 2) * (h - hz)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    for (let i = -8; i <= 8; i++) {
      ctx.beginPath()
      ctx.moveTo(cx + i * 18, hz)
      ctx.lineTo(cx + i * 120, h)
      ctx.stroke()
    }
    ctx.restore()

    // pedestal: two counter-rotating rings, gold once locked in
    ctx.save()
    ctx.translate(cx, cy + BASE_R * k * 1.05)
    ctx.scale(1, 0.38)
    const pr = BASE_R * k * 1.9
    const ring = (rad: number, dash: number[], speed: number, a: string, lw: number) => {
      ctx.save()
      ctx.rotate((t / 1000) * speed)
      ctx.setLineDash(dash)
      ctx.strokeStyle = a
      ctx.lineWidth = lw
      ctx.beginPath()
      ctx.arc(0, 0, rad, 0, TAU)
      ctx.stroke()
      ctx.restore()
    }
    ctx.shadowColor = accent
    ctx.shadowBlur = 18
    ring(pr, [], 0, accent + '90', 2)
    ctx.shadowBlur = 0
    ring(pr * 1.14, [10, 14], 0.35, accent + '60', 1.5)
    ring(pr * 0.82, [3, 9], -0.6, accent + '50', 1.2)
    const disc = ctx.createRadialGradient(0, 0, 1, 0, 0, pr)
    disc.addColorStop(0, accent + '40')
    disc.addColorStop(1, accent + '00')
    ctx.fillStyle = disc
    ctx.beginPath()
    ctx.arc(0, 0, pr, 0, TAU)
    ctx.fill()
    ctx.restore()

    // motes rising off the pedestal
    for (let i = 0; i < 18; i++) {
      const ph = ((t / 3800 + i * 0.137) % 1)
      const x = cx + Math.sin(i * 12.9898) * pr * 0.95 + Math.sin(t / 900 + i) * 4
      const y = cy + BASE_R * k * 1.05 - ph * h * 0.6
      ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.55
      ctx.fillStyle = i % 4 ? pal.light : accent
      ctx.fillRect(x, y, 2, 2)
    }
    ctx.globalAlpha = 1

    if (!cls) {
      // nothing picked yet: a hologram outline inviting a pick
      ctx.save()
      ctx.translate(cx, cy)
      ctx.strokeStyle = pal.light + '55'
      ctx.setLineDash([4, 6])
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(0, 0, BASE_R * k, 0, TAU)
      ctx.stroke()
      ctx.restore()
      return
    }

    // aim: follow the pointer, otherwise a slow idle sweep
    if (!s.pointer) s.want = -0.25 + Math.sin(t / 1700) * 0.45
    let d = s.want - s.aim
    d = Math.atan2(Math.sin(d), Math.cos(d))
    s.aim += d * 0.14

    // class switch: scale pop with overshoot and a scan band
    const sw = Math.min(1, (t - s.swapAt) / 520)
    const pop = sw < 1 ? 0.55 + 0.45 * (1 - Math.pow(1 - sw, 3)) + Math.sin(sw * Math.PI) * 0.12 : 1
    const rack = Math.max(0, 1 - (t - s.rackAt) / 260)
    const sinceShot = t - s.shotAt
    const recoil = Math.max(0, 1 - sinceShot / 110) * (weapon === 'SHOTGUN' ? 7 : weapon === 'SNIPER_RIFLE' ? 9 : 3.5) + rack * 6
    const bob = Math.sin(t / 520) * BASE_R * k * 0.04

    // ground shadow
    ctx.fillStyle = '#00000080'
    ctx.beginPath()
    ctx.ellipse(cx, cy + BASE_R * k * 1.05, BASE_R * k * 1.2, BASE_R * k * 0.4, 0, 0, TAU)
    ctx.fill()

    ctx.save()
    ctx.translate(cx, cy + bob)
    ctx.scale(k * pop, k * pop)
    ctx.rotate(s.aim)
    if (weapon) drawWeapon(ctx, weapon, pal, BASE_R, recoil / k)
    drawAvatar(ctx, cls, pal, BASE_R, 1 + Math.sin(t / 420) * 0.02, t)
    // muzzle flash
    if (weapon && sinceShot < 70) {
      const m = gunOf(weapon, BASE_R).len + BASE_R * 0.2
      ctx.fillStyle = '#FFF6D6'
      ctx.shadowColor = pal.light
      ctx.shadowBlur = 14
      ctx.beginPath()
      ctx.moveTo(m + 7, 0)
      ctx.lineTo(m + 1, -4.5)
      ctx.lineTo(m + 13, 0)
      ctx.lineTo(m + 1, 4.5)
      ctx.closePath()
      ctx.fill()
      ctx.shadowBlur = 0
    }
    ctx.restore()

    // tracers
    s.shots = s.shots.filter((sh) => t - sh.at < 260)
    for (const sh of s.shots) {
      const a = 1 - (t - sh.at) / 260
      const fan = sh.weapon === 'SHOTGUN' ? [-0.18, -0.09, 0, 0.09, 0.18] : [0]
      const muzzle = (gunOf(sh.weapon, BASE_R).len + BASE_R * 0.2) * k
      for (const f of fan) {
        const ang = sh.ang + f
        const x0 = cx + Math.cos(ang) * muzzle
        const y0 = cy + Math.sin(ang) * muzzle
        const reach = sh.weapon === 'SHOTGUN' ? Math.min(w, h) * 0.35 : Math.max(w, h)
        const g = ctx.createLinearGradient(x0, y0, x0 + Math.cos(ang) * reach, y0 + Math.sin(ang) * reach)
        g.addColorStop(0, '#FFF6D6')
        g.addColorStop(1, pal.light + '00')
        ctx.globalAlpha = a
        ctx.strokeStyle = g
        ctx.lineWidth = sh.weapon === 'SNIPER_RIFLE' ? 2.4 : 1.6
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(x0 + Math.cos(ang) * reach, y0 + Math.sin(ang) * reach)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // sparks (class swap burst, lock-in burst)
    s.sparks = s.sparks.filter((p) => t - p.born < p.life)
    for (const p of s.sparks) {
      const age = (t - p.born) / 1000
      ctx.globalAlpha = 1 - (t - p.born) / p.life
      ctx.fillStyle = locked ? gold : pal.light
      ctx.fillRect(cx + p.x + p.vx * age, cy + p.y + p.vy * age + 60 * age * age, 2.5, 2.5)
    }
    ctx.globalAlpha = 1

    // scan band while materializing
    if (sw < 1) {
      const y = cy - BASE_R * k * 1.6 + sw * BASE_R * k * 3.2
      const band = ctx.createLinearGradient(0, y - 14, 0, y + 14)
      band.addColorStop(0, pal.light + '00')
      band.addColorStop(0.5, pal.light + 'aa')
      band.addColorStop(1, pal.light + '00')
      ctx.fillStyle = band
      ctx.fillRect(cx - BASE_R * k * 2.2, y - 14, BASE_R * k * 4.4, 28)
    }
    // lock-in flash
    const lk = (t - s.lockedAt) / 600
    if (lk >= 0 && lk < 1) {
      ctx.strokeStyle = gold
      ctx.globalAlpha = 1 - lk
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(cx, cy, BASE_R * k * (1.3 + lk * 2.4), 0, TAU)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  })

  const point = (e: RPointerEvent<HTMLCanvasElement>) => {
    const s = st.current
    const r = e.currentTarget.getBoundingClientRect()
    s.pointer = true
    s.want = Math.atan2(e.clientY - r.top - r.height * 0.52, e.clientX - r.left - r.width / 2)
  }
  const fire = (e: RPointerEvent<HTMLCanvasElement>) => {
    const s = st.current
    unlockAudio()
    point(e)
    if (!cls || !weapon || s.now - s.shotAt < STAGE_COOLDOWN[weapon]) return
    s.aim = s.want // a shot snaps the aim: the tracer leaves where you clicked
    s.shotAt = s.now
    s.shots.push({ at: s.now, ang: s.aim, weapon })
    sfx.shoot(true)
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[radial-gradient(ellipse_at_50%_35%,#10213a,#0a0f17_70%)]">
      <canvas
        ref={ref}
        className={`block h-[300px] w-full sm:h-[400px] ${cls && weapon ? 'cursor-crosshair' : ''}`}
        onPointerMove={point}
        onPointerLeave={() => (st.current.pointer = false)}
        onPointerDown={fire}
        role="img"
        aria-label={cls && weapon ? `${CLASS_INFO[cls].name} with ${WEAPON_INFO[weapon].name}` : 'No build chosen yet'}
      />
      {children}
    </div>
  )
}

/* ─────────────── bits ─────────────── */

export function Pips({ value, of = 5, tone = 'bg-ally' }: { value: number; of?: number; tone?: string }) {
  return (
    <span className="flex gap-0.5" aria-label={`${value} of ${of}`}>
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={`h-1.5 w-2 skew-x-[-20deg] rounded-[1px] sm:w-3 transition-colors duration-300 ${i < value ? tone : 'bg-white/10'}`} />
      ))}
    </span>
  )
}

function StatBar({ label, value, delay = 0 }: { label: string; value: Rating | 0; delay?: number }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-center gap-2">
      <span className="font-display text-[10px] font-semibold tracking-[0.16em] text-ink-300 uppercase">{label}</span>
      <span className="relative h-2 overflow-hidden rounded-full bg-white/[0.07]">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-ally/70 to-ally shadow-[0_0_12px_rgb(76_201_240/0.6)] transition-[width] duration-500 ease-out"
          style={{ width: `${(value / 5) * 100}%`, transitionDelay: `${delay}ms` }}
        />
      </span>
    </div>
  )
}

const Key = ({ k }: { k: string }) => (
  <kbd className="hidden h-5 sm:grid min-w-5 place-items-center rounded border border-white/15 bg-ink-950/70 px-1 font-display text-[10px] font-bold text-ink-300 shadow-[inset_0_-1px_0_rgb(255_255_255/0.08)]">
    {k}
  </kbd>
)

/** Weapon silhouettes for the picker (side view; the arena shows them top-down). */
export function WeaponArt({ id, className = '' }: { id: WeaponId; className?: string }) {
  const body = 'fill-ink-100/90'
  const trim = 'fill-ally'
  return (
    <svg viewBox="0 0 140 44" className={className} aria-hidden>
      {id === 'ASSAULT_RIFLE' && (
        <g>
          <path className={body} d="M8 18h18l4-4h44l3 3h28v6H76l-6 4H42l-4 4H22l-4 6H8l4-8H8z" />
          <path className={body} d="M50 27h9l-3 13h-8z" />
          <rect className={body} x="105" y="18.5" width="24" height="3" rx="1" />
          <rect className={trim} x="40" y="16.5" width="24" height="2" rx="1" />
          <rect className={body} x="52" y="9" width="14" height="4" rx="1.5" />
        </g>
      )}
      {id === 'SHOTGUN' && (
        <g>
          <path className={body} d="M6 20l14-4h26l4 3h68v5H50l-4 3H32l-6 9H12l6-9H8z" />
          <rect className={body} x="50" y="26" width="58" height="4" rx="1.5" />
          <rect className={trim} x="62" y="25" width="22" height="7" rx="2" />
          <rect className="fill-ink-950" x="112" y="20.5" width="6" height="1.5" />
        </g>
      )}
      {id === 'SNIPER_RIFLE' && (
        <g>
          <path className={body} d="M4 19l16-3h22l4 3h28v5H50l-4 3H30l-6 7H12l5-8H6z" />
          <rect className={body} x="72" y="19.5" width="58" height="2.6" rx="1" />
          <rect className={body} x="126" y="18" width="10" height="5.6" rx="1" />
          <rect className={body} x="38" y="8" width="34" height="6" rx="3" />
          <circle className={trim} cx="70" cy="11" r="2.2" />
          <path className={body} d="M48 14h4v5h-4zM58 14h4v5h-4z" />
          <path className={body} d="M84 22l-6 14M88 22l6 14" stroke="currentColor" strokeWidth="1.6" />
        </g>
      )}
    </svg>
  )
}

/* ─────────────── the armory ─────────────── */

const CLASS_KEYS = ['1', '2', '3']
const WEAPON_KEYS = ['4', '5', '6']

/**
 * The stage plus both pickers. `onPick` gets a partial pick (class or weapon); `onReady` is the R hotkey.
 * Hotkeys: 1-3 class, 4-6 weapon, R ready. Picks are refused while `locked`.
 */
export function Armory({
  cls,
  weapon,
  locked,
  canReady,
  onPick,
  onReady,
  restored,
}: {
  cls?: ClassId
  weapon?: WeaponId
  locked: boolean
  canReady: boolean
  onPick: (p: { class?: ClassId; weapon?: WeaponId }) => void
  onReady: () => void
  restored: boolean
}) {
  const pick = (p: { class?: ClassId; weapon?: WeaponId }) => {
    if (locked) return
    unlockAudio()
    if (p.class && p.class !== cls) sfx.select()
    if (p.weapon && p.weapon !== weapon) sfx.equip()
    onPick(p)
  }
  const pickRef = useRef(pick)
  const readyRef = useRef({ canReady, onReady })
  useLayoutEffect(() => {
    pickRef.current = pick
    readyRef.current = { canReady, onReady }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return
      const ci = CLASS_KEYS.indexOf(e.key)
      const wi = WEAPON_KEYS.indexOf(e.key)
      if (ci >= 0) pickRef.current({ class: CLASS_IDS[ci] })
      else if (wi >= 0) pickRef.current({ weapon: WEAPON_IDS[wi] })
      else if ((e.key === 'r' || e.key === 'R') && readyRef.current.canReady) readyRef.current.onReady()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const c = cls ? CLASS_INFO[cls] : null
  const w = weapon ? WEAPON_INFO[weapon] : null
  const tempo = (Math.min(5, (w?.rate ?? 0) + (cls === 'ASSAULTER' ? 1 : 0)) || 0) as Rating | 0

  const hover = () => !locked && sfx.hover()

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]" aria-label="Choose your class and weapon">
      <HeroStage cls={cls} weapon={weapon} locked={locked}>
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <p className="label !text-ally/80">{locked ? 'Locked in' : 'Your build'}</p>
            <h2
              key={cls && weapon ? BUILD[cls][weapon] : 'none'}
              className="animate-rise font-display text-3xl leading-none font-bold tracking-[0.08em] text-ink-100 uppercase [text-shadow:0_0_30px_rgb(76_201_240/0.45)] sm:text-5xl"
            >
              {cls && weapon ? BUILD[cls][weapon] : cls ? c!.name : 'Pick a class'}
            </h2>
            <p className="mt-0.5 text-sm text-ink-300">
              {c ? c.name : 'No class'} <span className="text-ink-400">·</span> {w ? w.name : 'no weapon yet'}
            </p>
          </div>
          {c && (
            <span className="shrink-0 rounded-full border border-ally/30 bg-ally/10 px-2.5 py-1 font-display text-[10px] font-bold tracking-[0.2em] text-ally uppercase">
              {c.role}
            </span>
          )}
        </div>
        {locked && (
          <div className="pointer-events-none absolute top-24 right-4 sm:top-28 sm:right-6">
            <span className="animate-stamp rounded-md border-2 border-gold px-3 py-1 font-display text-xl font-bold sm:px-4 sm:text-2xl tracking-[0.3em] text-gold uppercase [text-shadow:0_0_24px_rgb(245_184_61/0.6)] -rotate-6 bg-ink-950/40 backdrop-blur-[1px]">
              Locked in
            </span>
          </div>
        )}
        <div className="pointer-events-none grid gap-3 bg-ink-950/80 p-4 sm:absolute sm:inset-x-0 sm:bottom-0 sm:grid-cols-[1fr_auto] sm:items-end sm:bg-transparent sm:bg-gradient-to-t sm:from-ink-950/95 sm:via-ink-950/70 sm:to-transparent sm:p-5 sm:pt-12">
          <div className="grid gap-1.5">
            <StatBar label="Health" value={c?.health ?? 0} />
            <StatBar label="Damage" value={w?.damage ?? 0} delay={60} />
            <StatBar label="Fire rate" value={tempo} delay={120} />
            <StatBar label="Range" value={w?.range ?? 0} delay={180} />
          </div>
          {c ? (
            <div className="flex items-start gap-2 sm:max-w-[260px] rounded-lg border border-gold/25 bg-gold/[0.06] p-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-md border border-gold/50 bg-ink-950 font-display text-sm font-bold text-gold shadow-[0_0_14px_rgb(245_184_61/0.35)]">Q</span>
              <span className="text-xs leading-snug text-ink-300">
                <b className="font-display tracking-wider text-gold uppercase">{c.qName}</b>
                <br />
                {c.q}
              </span>
            </div>
          ) : (
            <p className="text-xs text-ink-400">Click the stage to test-fire once you have a weapon.</p>
          )}
        </div>
      </HeroStage>

      <div className="flex flex-col gap-5">
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <p className="label">Class</p>
            {restored && !locked && <span className="animate-rise text-[11px] text-ink-400">Your last build is equipped</span>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {CLASS_IDS.map((id, i) => {
              const on = cls === id
              const info = CLASS_INFO[id]
              return (
                <button
                  key={id}
                  onClick={() => pick({ class: id })}
                  onMouseEnter={hover}
                  disabled={locked}
                  aria-pressed={on}
                  aria-keyshortcuts={CLASS_KEYS[i]}
                  className={`group relative overflow-hidden rounded-xl border p-2 text-left sm:p-3 transition duration-200 disabled:cursor-not-allowed ${
                    on
                      ? 'border-gold/80 bg-gradient-to-b from-gold/[0.14] to-gold/[0.03] shadow-[0_0_0_1px_rgb(245_184_61/0.35),0_12px_30px_-12px_rgb(245_184_61/0.55)]'
                      : 'border-white/10 bg-white/[0.03] enabled:hover:-translate-y-0.5 enabled:hover:border-ally/40 enabled:hover:bg-ally/[0.05] enabled:hover:shadow-[0_10px_28px_-14px_rgb(76_201_240/0.6)]'
                  } ${locked && !on ? 'opacity-35' : ''}`}
                >
                  {on && <span className="animate-shine pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 skew-x-[-20deg] bg-gradient-to-r from-transparent via-white/15 to-transparent" />}
                  <span className="flex items-start justify-between">
                    <ClassAvatar cls={id} size={56} />
                    <Key k={CLASS_KEYS[i]} />
                  </span>
                  <span className="mt-1 block truncate font-display text-sm leading-tight font-bold tracking-wider uppercase sm:text-lg">{info.name}</span>
                  <span className={`block font-display text-[10px] font-bold tracking-[0.2em] uppercase ${on ? 'text-gold' : 'text-ally/80'}`}>{info.role}</span>
                  <span className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-1.5 gap-y-1 text-[9px] text-ink-400 sm:gap-x-2 sm:text-[10px]">
                    Health <Pips value={info.health} tone={on ? 'bg-gold' : 'bg-ally'} />
                    Q <span className="font-display font-bold tracking-wider text-ink-300 uppercase">{info.qName}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section>
          <p className="label mb-2">Weapon</p>
          <div className="grid grid-cols-3 gap-2">
            {WEAPON_IDS.map((id, i) => {
              const on = weapon === id
              const info = WEAPON_INFO[id]
              const tone = on ? 'bg-gold' : 'bg-ally'
              return (
                <button
                  key={id}
                  onClick={() => pick({ weapon: id })}
                  onMouseEnter={hover}
                  disabled={locked}
                  aria-pressed={on}
                  aria-keyshortcuts={WEAPON_KEYS[i]}
                  className={`group relative overflow-hidden rounded-xl border p-2 text-left sm:p-3 transition duration-200 disabled:cursor-not-allowed ${
                    on
                      ? 'border-gold/80 bg-gradient-to-b from-gold/[0.14] to-gold/[0.03] shadow-[0_0_0_1px_rgb(245_184_61/0.35),0_12px_30px_-12px_rgb(245_184_61/0.55)]'
                      : 'border-white/10 bg-white/[0.03] enabled:hover:-translate-y-0.5 enabled:hover:border-ally/40 enabled:hover:bg-ally/[0.05] enabled:hover:shadow-[0_10px_28px_-14px_rgb(76_201_240/0.6)]'
                  } ${locked && !on ? 'opacity-35' : ''}`}
                >
                  {on && <span className="animate-shine pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 skew-x-[-20deg] bg-gradient-to-r from-transparent via-white/15 to-transparent" />}
                  <span className="flex items-start justify-between gap-2">
                    <WeaponArt id={id} className={`h-10 w-full max-w-[120px] transition duration-300 ${on ? 'drop-shadow-[0_0_10px_rgb(245_184_61/0.5)]' : 'opacity-80 group-hover:opacity-100'}`} />
                    <Key k={WEAPON_KEYS[i]} />
                  </span>
                  <span className="mt-1 block font-display text-sm leading-tight font-bold tracking-wider uppercase sm:text-base">{info.name}</span>
                  <span className="hidden text-[11px] text-ink-400 sm:block">{info.pitch}</span>
                  <span className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-1.5 gap-y-1 text-[9px] text-ink-400 sm:gap-x-2 sm:text-[10px]">
                    Damage <Pips value={info.damage} tone={tone} />
                    Rate <Pips value={info.rate} tone={tone} />
                    Range <Pips value={info.range} tone={tone} />
                  </span>
                </button>
              )
            })}
          </div>
          <p className="mt-2 hidden flex-wrap items-center gap-1.5 text-[11px] text-ink-400 sm:flex">
            Any class can carry any weapon. <Key k="1" />–<Key k="3" /> class · <Key k="4" />–<Key k="6" /> weapon · <Key k="R" /> ready
          </p>
        </section>
      </div>
    </div>
  )
}
