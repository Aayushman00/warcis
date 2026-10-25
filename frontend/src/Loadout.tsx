/* The match lobby's armory: a live stage that shows the build you are making (class + weapon, drawn exactly as the
   arena will), and the class and weapon pickers. Everything here is presentation: the lobby still sends only the
   chosen ids, and the server owns the loadout, the ready flags and the clock. */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ClassId, WeaponId } from './api'
import { BUILD, CLASS_IDS, CLASS_INFO, drawAvatar, drawWeapon, WEAPON_IDS, WEAPON_INFO, type Rating } from './game/classes'
import { sfx, unlockAudio } from './game/sfx'
import { team as TC } from './game/tokens'
import { Icon } from './ui'

const TAU = Math.PI * 2
const BASE_R = 14 // the arena's player radius: the lobby scales the same drawing up instead of redrawing it

/** A canvas sized to its box at device resolution, drawn once per render (no animation loop). */
function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = c.clientHeight
    c.width = Math.round(w * dpr)
    c.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw(ctx, w, h)
  })
  return ref
}

/** A class avatar: the arena drawing at lobby size. `side` picks the team colors (you are always blue). */
export function ClassAvatar({ cls, side = 'ally', size = 56, weapon }: { cls: ClassId; side?: 'ally' | 'foe'; size?: number; weapon?: WeaponId }) {
  const pal = side === 'ally' ? TC.BLUE : TC.RED
  const ref = useCanvas((ctx, w, h) => {
    const k = (Math.min(w, h) * 0.3) / BASE_R
    ctx.translate(w / 2 - (weapon ? BASE_R * k * 0.12 : 0), h / 2)
    ctx.scale(k, k)
    ctx.rotate(-0.35)
    if (weapon) drawWeapon(ctx, weapon, pal, BASE_R)
    drawAvatar(ctx, cls, pal, BASE_R, 1, 0)
  })
  return <canvas ref={ref} style={{ width: size, height: size }} aria-label={CLASS_INFO[cls].name} role="img" />
}

/* ─────────────── stage ─────────────── */

/** The build at hero size: still, redrawn only when the class or weapon changes. A gold ring marks a locked-in pick. */
function HeroStage({ cls, weapon, locked, children }: { cls: ClassId | undefined; weapon: WeaponId | undefined; locked: boolean; children?: ReactNode }) {
  const pal = TC.BLUE
  const ref = useCanvas((ctx, w, h) => {
    const cx = w / 2
    const cy = h * 0.5
    const k = Math.min(w * 0.9, h * 1.1) / 100 // avatar scale: the arena's R=14 body at hero size
    ctx.strokeStyle = locked ? getComputedStyle(document.documentElement).getPropertyValue('--color-gold').trim() : pal.light + '55'
    ctx.lineWidth = 2
    ctx.setLineDash(cls ? [] : [4, 6])
    ctx.beginPath()
    ctx.arc(cx, cy, BASE_R * k * 1.7, 0, TAU)
    ctx.stroke()
    ctx.setLineDash([])
    if (!cls) return // nothing picked yet: an empty ring
    ctx.translate(cx, cy)
    ctx.scale(k, k)
    ctx.rotate(-0.25)
    if (weapon) drawWeapon(ctx, weapon, pal, BASE_R)
    drawAvatar(ctx, cls, pal, BASE_R, 1, 0)
  })
  return (
    <div className="relative min-h-[470px] flex-1 sm:min-h-[360px] lg:min-h-[240px] overflow-hidden rounded-[10px] border border-neon/25 bg-ink-850 lg:col-start-2 lg:row-start-1">
      <div aria-hidden className="pointer-events-none absolute inset-0 animate-breathe bg-[radial-gradient(circle_at_50%_46%,color-mix(in_srgb,var(--color-ally)_30%,transparent),color-mix(in_srgb,var(--color-ally)_8%,transparent)_38%,transparent_62%)]" />
      <canvas
        ref={ref}
        className="absolute inset-0 block h-full w-full animate-float"
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
        <span key={i} className={`h-1.5 w-3 skew-x-[-20deg] rounded-[1px] transition-colors duration-150 ${i < value ? tone : 'bg-white/10'}`} />
      ))}
    </span>
  )
}

/** Segmented stat row: same pips as the pick cards, "n / 5", which pick it comes from, and a hover diff (+2 green / -1 red). */
function StatBar({ label, value, from, diff = 0 }: { label: string; value: Rating | 0; from: 'Class' | 'Weapon'; diff?: number }) {
  return (
    <div className="grid grid-cols-[72px_auto_36px] items-center gap-2 sm:grid-cols-[72px_auto_36px_52px_auto]">
      <span className="font-display text-[11px] font-semibold tracking-[0.16em] text-ink-100 uppercase">{label}</span>
      <Pips value={value} />
      <span className="text-right font-display text-xs font-bold text-ink-100 tabular-nums">{value ? `${value} / 5` : '–'}</span>
      <span className="hidden text-[10px] font-semibold tracking-wider text-ink-300 uppercase sm:block">{from}</span>
      <span className={`hidden min-w-24 whitespace-nowrap sm:block font-display text-xs font-bold tabular-nums ${diff > 0 ? 'text-online' : 'text-foe'}`} aria-live="polite">
        {diff ? `${diff > 0 ? '+' : '−'}${Math.abs(diff)} ${label}` : ''}
      </span>
    </div>
  )
}

const Key = ({ k }: { k: string }) => (
  <kbd className="hidden h-5 sm:grid min-w-5 place-items-center rounded border border-white/15 bg-ink-950/70 px-1 font-display text-[10px] font-bold text-ink-100 shadow-[inset_0_-1px_0_rgb(255_255_255/0.08)]">
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

/** One pick card. Class and weapon cards both use it, so the title, subtitle and stats sit on the same lines in every card. */
function PickCard({
  on,
  locked,
  onPick,
  onHover,
  onLeave,
  k,
  visual,
  title,
  subtitle,
  children,
}: {
  on: boolean
  locked: boolean
  onPick: () => void
  onHover: () => void
  onLeave: () => void
  k: string
  visual: ReactNode
  title: string
  subtitle: ReactNode
  children: ReactNode
}) {
  return (
    <button
      onClick={onPick}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onFocus={onHover}
      onBlur={onLeave}
      disabled={locked}
      aria-pressed={on}
      aria-keyshortcuts={k}
      className={`relative flex h-full min-w-0 flex-col rounded-[10px] border p-2 text-left sm:p-3 transition duration-150 focus-visible:ring-2 focus-visible:ring-gold/70 focus-visible:outline-none disabled:cursor-not-allowed ${
        on
          ? 'border-gold bg-gradient-to-b from-gold/[0.18] to-gold/[0.05] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-gold)_55%,transparent),0_0_24px_color-mix(in_srgb,var(--color-gold)_35%,transparent)]'
          : 'border-neon/25 bg-gradient-to-b from-white/[0.05] to-white/[0.02] enabled:hover:border-neon/70 enabled:hover:from-white/[0.08]'
      } ${locked && !on ? 'opacity-40' : ''}`}
    >
      {on && (
        <span aria-hidden className="absolute -top-2 -right-2 grid size-5 place-items-center rounded-full bg-gold text-ink-950 shadow-[0_0_12px_color-mix(in_srgb,var(--color-gold)_70%,transparent)]">
          <Icon name="check" className="size-3" />
        </span>
      )}
      <span className="flex h-11 items-center justify-between gap-2">
        {visual}
        <Key k={k} />
      </span>
      <span className="mt-2 block font-display text-xs leading-4 font-bold uppercase sm:truncate sm:text-sm sm:tracking-wider">{title}</span>
      <span className={`hidden h-4 truncate text-[11px] sm:block leading-4 ${on ? 'text-gold' : 'text-ink-100/80'}`}>{subtitle}</span>
      <span className="mt-2 hidden grid-cols-[auto_1fr] sm:grid items-center gap-x-2 gap-y-1 text-[11px] text-ink-100/80">{children}</span>
    </button>
  )
}


const CLASS_KEYS = ['1', '2', '3']
const WEAPON_KEYS = ['4', '5', '6']

/**
 * The stage plus both pickers. `onPick` gets a partial pick (class or weapon);
 * Hotkeys: 1-3 class, 4-6 weapon (R, hold to ready, lives in the lobby). Picks are refused while `locked`.
 */
export function Armory({
  cls,
  weapon,
  locked,
  onPick,
}: {
  cls?: ClassId
  weapon?: WeaponId
  locked: boolean
  onPick: (p: { class?: ClassId; weapon?: WeaponId }) => void
}) {
  const pick = (p: { class?: ClassId; weapon?: WeaponId }) => {
    if (locked) return
    unlockAudio()
    if (p.class && p.class !== cls) sfx.select()
    if (p.weapon && p.weapon !== weapon) sfx.equip()
    onPick(p)
  }
  const pickRef = useRef(pick)
  useLayoutEffect(() => {
    pickRef.current = pick
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return
      const ci = CLASS_KEYS.indexOf(e.key)
      const wi = WEAPON_KEYS.indexOf(e.key)
      if (ci >= 0) pickRef.current({ class: CLASS_IDS[ci] })
      else if (wi >= 0) pickRef.current({ weapon: WEAPON_IDS[wi] })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const [peek, setPeek] = useState<{ class?: ClassId; weapon?: WeaponId }>({})
  const [hinted, setHinted] = useState(() => {
    try {
      return localStorage.getItem('warcis.hotkeyHint') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (!cls || !weapon || hinted) return
    setHinted(true) // the "Press 1-6" hint is shown until the first complete build, once
    try {
      localStorage.setItem('warcis.hotkeyHint', '1')
    } catch {
      /* private mode */
    }
  }, [cls, weapon, hinted])

  const c = cls ? CLASS_INFO[cls] : null
  const w = weapon ? WEAPON_INFO[weapon] : null
  const tempoOf = (cid?: ClassId, wid?: WeaponId) => (Math.min(5, (wid ? WEAPON_INFO[wid].rate : 0) + (cid === 'ASSAULTER' ? 1 : 0)) || 0) as Rating | 0
  const tempo = tempoOf(cls, weapon)
  // hovering a card previews the stat change against the current build
  const pc = peek.class ?? cls
  const pw = peek.weapon ?? weapon
  const peeking = !locked && (peek.class !== undefined || peek.weapon !== undefined)
  const d = (now: number, next: number) => (peeking && now && next ? next - now : 0)
  const dHealth = d(c?.health ?? 0, pc ? CLASS_INFO[pc].health : 0)
  const dDamage = d(w?.damage ?? 0, pw ? WEAPON_INFO[pw].damage : 0)
  const dRate = d(tempo, tempoOf(pc, pw))
  const dRange = d(w?.range ?? 0, pw ? WEAPON_INFO[pw].range : 0)

  const hover = (p: { class?: ClassId; weapon?: WeaponId }) => () => {
    if (locked) return
    sfx.hover()
    setPeek(p)
  }
  const leave = () => setPeek({})

  return (
    <div className="contents">
      <HeroStage cls={cls} weapon={weapon} locked={locked}>
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="label flex flex-wrap items-center gap-x-3 !text-ally">
              {locked ? 'Locked in' : 'Your build'}
            </p>
            <h2
              key={cls && weapon ? BUILD[cls][weapon] : 'none'}
              className="animate-rise font-display text-3xl leading-none font-bold tracking-[0.08em] text-ink-100 uppercase"
            >
              {cls && weapon ? BUILD[cls][weapon] : cls ? c!.name : 'Pick a class'}
            </h2>
            <p className="mt-1 flex items-center gap-2 text-sm text-ink-300">
              {c ? c.name : 'No class'} · {w ? w.name : 'no weapon yet'}
              {weapon && <WeaponArt id={weapon} className="h-5 w-14 opacity-90" />}
            </p>
            {!hinted && !locked && <p className="mt-1 text-[11px] text-ink-300">Press 1–3 to pick a class, 4–6 for a weapon</p>}
          </div>
        </div>
        {locked && (
          <div className="pointer-events-none absolute top-20 right-4">
            <span className="animate-rise -rotate-6 rounded-md border-2 border-gold bg-ink-950/40 px-3 py-1 font-display text-xl font-bold tracking-[0.3em] text-gold uppercase">
              Locked in
            </span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 grid grid-cols-1 items-stretch sm:grid-cols-[1fr_auto] gap-4 bg-gradient-to-t from-ink-950/95 via-ink-950/70 to-transparent p-4 pt-6">
          <div className="grid gap-1">
            <StatBar label="Health" value={c?.health ?? 0} from="Class" diff={dHealth} />
            <StatBar label="Damage" value={w?.damage ?? 0} from="Weapon" diff={dDamage} />
            <StatBar label="Fire rate" value={tempo} from="Weapon" diff={dRate} />
            <StatBar label="Range" value={w?.range ?? 0} from="Weapon" diff={dRange} />
          </div>
          {c ? (
            <div className="flex items-center gap-2 py-2 sm:max-w-[260px] sm:py-0 rounded-[10px] border border-neon/25 bg-white/[0.04] px-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-white/25 bg-ink-950 font-display text-xs font-bold text-ink-100">Q</span>
              <span className="text-xs leading-snug text-ink-100/80">
                <b className="font-display tracking-wider text-ink-100 uppercase">{c.qName}</b>
                <br />
                {c.q}
              </span>
            </div>
          ) : (
            <p className="self-end text-xs text-ink-100/80">Pick a class to see its ability.</p>
          )}
        </div>
      </HeroStage>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] lg:col-span-3 lg:row-start-2" role="group" aria-label="Choose your class and weapon">
        <section className="flex flex-col">
          <div className="mb-2 flex items-baseline justify-between">
            <p className="label !text-ink-100">Class</p>
          </div>
          <div className="grid flex-1 grid-cols-3 gap-2">
            {CLASS_IDS.map((id, i) => {
              const on = cls === id
              const info = CLASS_INFO[id]
              return (
                <PickCard
                  key={id}
                  on={on}
                  locked={locked}
                  onPick={() => pick({ class: id })}
                  onHover={hover({ class: id })}
                  onLeave={leave}
                  k={CLASS_KEYS[i]}
                  visual={<ClassAvatar cls={id} size={44} />}
                  title={info.name}
                  subtitle={<span className="font-display font-bold tracking-[0.2em] uppercase">{info.role}</span>}
                >
                  Health <Pips value={info.health} tone={on ? 'bg-gold' : 'bg-ink-300'} />
                  Q <span className="font-display font-bold tracking-wider text-ink-100 uppercase">{info.qName}</span>
                </PickCard>
              )
            })}
          </div>
        </section>

        <div className="hidden w-px self-stretch bg-white/15 sm:block" aria-hidden />

        <section className="flex flex-col">
          <p className="label mb-2 !text-ink-100">Weapon</p>
          <div className="grid flex-1 grid-cols-3 gap-2">
            {WEAPON_IDS.map((id, i) => {
              const on = weapon === id
              const info = WEAPON_INFO[id]
              const tone = on ? 'bg-gold' : 'bg-ink-300'
              return (
                <PickCard
                  key={id}
                  on={on}
                  locked={locked}
                  onPick={() => pick({ weapon: id })}
                  onHover={hover({ weapon: id })}
                  onLeave={leave}
                  k={WEAPON_KEYS[i]}
                  visual={<WeaponArt id={id} className={`h-9 w-full max-w-[110px] transition duration-150 ${on ? '' : 'opacity-80'}`} />}
                  title={info.name}
                  subtitle={info.pitch}
                >
                  Damage <Pips value={info.damage} tone={tone} />
                  Rate <Pips value={info.rate} tone={tone} />
                  Range <Pips value={info.range} tone={tone} />
                </PickCard>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
