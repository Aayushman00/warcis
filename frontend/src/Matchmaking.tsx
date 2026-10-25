import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Loadout, MatchDTO, MMStatus, QPlayer, QueueDTO, TeamDTO } from './api'
import { MAX_PARTY, type Player } from './data'
import { Game, type Rematch } from './Game'
import { BUILD, CLASS_IDS, CLASS_INFO, WEAPON_IDS, WEAPON_INFO } from './game/classes'
import { sfx } from './game/sfx'
import { Armory, ClassAvatar } from './Loadout'
import { Avatar, DashBorder, Frame, Icon } from './ui'

/** A team's players as flat tiles: you first, then your party-mates, then everyone else in the server's order. */
function playersOf(team: TeamDTO, meId: string): QPlayer[] {
  const mates = new Set(team.parties.find((pt) => pt.players.includes(meId))?.players)
  const rank = (p: QPlayer) => (p.id === meId ? 0 : mates.has(p.id) ? 1 : 2)
  return [...team.players].sort((a, b) => rank(a) - rank(b)) // stable: ties keep the server's order
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const modeLabel = (_m: 'SQUAD') => 'Squad'
const EST_SECS = 30 // shown as the queue estimate; past it the screen says so

export function Matchmaking({
  status,
  me,
  onCancel,
  onReady,
  onLoadout,
  onExit,
  rematch,
}: {
  status: Exclude<MMStatus, { state: 'idle' }>
  me: Player
  onCancel: () => void
  onReady: (matchId: string) => void
  onLoadout: (matchId: string, loadout: Loadout) => void
  onExit: (matchId: string) => void
  rematch: Rematch
}) {
  if (status.state === 'entered') return <Game match={status.match} me={me} onExit={() => onExit(status.match.match_id)} rematch={rematch} />
  if (status.state === 'found' || status.state === 'countdown')
    return <Lobby key={status.match.match_id} match={status.match} me={me} onReady={onReady} onLoadout={onLoadout} onLeave={onExit} />
  return <Searching q={status.queue} me={me} onCancel={onCancel} />
}

function Searching({ q, me, onCancel }: { q: QueueDTO; me: Player; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - Date.parse(q.joined_at)) / 1000))
  const ours = playersOf(q.team, me.id)
  const filled = q.team.players.length
  const modeName = modeLabel(q.mode)
  const openSlots = q.fill ? MAX_PARTY - filled : 0
  const title = openSlots > 0 ? 'Searching for match' : 'Searching for opponents'

  const slow = elapsed > EST_SECS

  return (
    <Frame cut={28} glow>
    <section className="relative flex min-h-[calc(100vh-8rem)] flex-col items-center justify-center gap-8 px-4 py-10 text-center">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,color-mix(in_srgb,var(--color-neon)_14%,transparent),transparent_60%)]" />
      {/* corner brackets */}
      {['top-3 left-3 border-t-2 border-l-2', 'bottom-3 left-3 border-b-2 border-l-2', 'bottom-3 right-3 border-b-2 border-r-2'].map((c) => (
        <span key={c} aria-hidden className={`pointer-events-none absolute size-5 border-neon/70 ${c}`} />
      ))}
      <p className="label relative !text-ink-100">
        {modeName} · 4v4 · EU West · <span className="text-ink-300 tabular-nums">{q.players_in_queue.toLocaleString()} in queue</span>
      </p>

      {/* Radar */}
      <div className="relative grid size-56 place-items-center" aria-hidden>
        {[100, 72, 44].map((s) => (
          <span key={s} className="absolute rounded-full border border-neon/40" style={{ width: `${s}%`, height: `${s}%` }} />
        ))}
        <span className="absolute inset-0 rounded-full shadow-[0_0_40px_-6px_color-mix(in_srgb,var(--color-neon)_45%,transparent)]" />
        <span className="absolute inset-[-6px] rounded-full opacity-60 [background:repeating-conic-gradient(var(--color-neon)_0_1deg,transparent_1deg_6deg)] [mask-image:radial-gradient(circle,transparent_calc(100%-8px),black_calc(100%-7px))]" />
        <span className="absolute inset-x-0 top-1/2 h-px bg-neon/20" />
        <span className="absolute inset-y-0 left-1/2 w-px bg-neon/20" />
        <span className="absolute inset-0 animate-pulse-ring rounded-full border border-neon/60" />
        <span className="absolute inset-0 animate-sweep rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,color-mix(in_srgb,var(--color-neon)_35%,transparent)_50deg,transparent_60deg)]" />
        <div className="relative">
          <p className={`font-display text-4xl font-bold tabular-nums [text-shadow:0_0_20px_color-mix(in_srgb,var(--color-neon)_45%,transparent)] ${slow ? 'text-away' : ''}`}>{clock(elapsed)}</p>
          <p className="text-xs text-ink-300">Est. {clock(EST_SECS)}</p>
        </div>
      </div>

      {/* status text only: the ticking timer above stays out of the live region */}
      <div className="relative" aria-live="polite">
        <h1 className="font-display text-3xl font-bold tracking-[0.12em] uppercase [text-shadow:0_0_24px_color-mix(in_srgb,var(--color-neon)_30%,transparent)]">{slow ? 'Taking longer than usual…' : title}</h1>
        <p className="mt-2 flex items-center justify-center gap-3 text-sm text-ink-300">
          <span>
            Party <b className="text-ink-100 tabular-nums">{q.size} / {MAX_PARTY}</b>
          </span>
          <span aria-hidden className="h-3 w-px bg-white/20" />
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${q.fill ? 'border-online/40 bg-online/10 text-online' : 'border-white/15 text-ink-300'}`}>
            Fill: {q.fill ? 'On' : 'Off'}
          </span>
        </p>
        {slow && (
          <p className="mx-auto mt-3 max-w-md text-sm text-ink-300">
            {q.fill ? 'Try again in a minute, or pick a different region.' : 'Fill is off, so only same-size parties match. Cancel and queue with Fill on to find a game faster.'}
          </p>
        )}
      </div>

      {/* Team formation: live grouping from the server's current queue packing */}
      <div className="relative w-fit max-w-full">
        <div className="mb-3 flex items-center justify-between">
          <span className="label !text-ally">Your team</span>
          <span className="font-display text-sm font-semibold tabular-nums">
            {filled} / {q.fill ? MAX_PARTY : filled}
          </span>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {ours.map((p) => (
            <PlayerTile key={p.id} p={p} mine={p.id === me.id} side="ally" stacked />
          ))}
          {Array.from({ length: openSlots }, (_, i) => (
            <div key={i} className="relative flex w-28 animate-breathe flex-col items-center gap-2 rounded-[10px] p-3 text-neon">
              <DashBorder />
              <span className="grid size-14 place-items-center rounded-xl bg-white/[0.03]">
                <span className="size-5 animate-spin rounded-full border-2 border-ink-600 border-t-neon" />
              </span>
              <span className="text-xs text-ink-300">Searching…</span>
            </div>
          ))}
        </div>
      </div>

      <button onClick={onCancel} className="relative inline-flex items-center gap-2 rounded px-3 py-2 text-sm font-semibold text-ink-300 transition hover:text-foe">
        <Icon name="x" /> Cancel matchmaking
      </button>
    </section>
    </Frame>
  )
}

function PlayerTile({
  p,
  mine,
  side,
  readyIds,
  loadouts,
  stacked,
}: {
  p: QPlayer
  mine?: boolean
  side: 'ally' | 'foe'
  readyIds?: Set<string>
  loadouts?: Record<string, Loadout>
  stacked?: boolean // searching screen: avatar with the name underneath
}) {
  const isReady = !!readyIds?.has(p.id)
  const loadout = loadouts?.[p.id]
  const state = isReady ? 'ready' : !loadout && side === 'ally' ? 'choosing' : 'waiting' // enemy picks are hidden, so they only ever read ready or waiting
  const tone = isReady
    ? 'border-online/50 bg-online/[0.10]'
    : side === 'foe'
      ? 'border-foe/30 bg-foe/[0.05]'
      : mine
        ? 'border-ally/60 bg-ally/[0.12]'
        : 'border-ally/25 bg-ally/[0.05]'
  const accent = side === 'ally' ? 'text-ally' : 'text-foe'
  if (stacked)
    return (
      <div className={`animate-rise flex w-28 flex-col items-center gap-2 rounded-[10px] border p-3 ${tone}`}>
        <Avatar name={p.name} size={56} />
        <span className="w-full truncate text-center text-xs font-semibold">{p.name}</span>
        <span className="flex items-center gap-1 text-[11px] font-semibold text-online">
          <Icon name="check" className="size-3" /> In queue
        </span>
      </div>
    )
  return (
    <div className={`animate-rise flex min-h-0 min-w-0 items-center gap-3 rounded-[10px] border px-3 py-1 transition-colors duration-150 ${tone}`}>
      <Avatar name={p.name} size={40} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 text-sm leading-none font-semibold">
          {readyIds &&
            (state === 'ready' ? (
              <span role="img" aria-label="Ready" title="Ready" className="grid size-4 shrink-0 place-items-center rounded-full bg-online text-ink-950">
                <Icon name="check" className="size-3" />
              </span>
            ) : state === 'choosing' ? (
              <span role="img" aria-label="Choosing a loadout" title="Choosing a loadout" className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-away border-t-transparent" />
            ) : (
              <span role="img" aria-label="Waiting to ready up" title="Waiting to ready up" className="size-3.5 shrink-0 rounded-full border-2 border-ink-400" />
            ))}
          <span className="truncate">{p.name}</span>
        </span>
        {loadouts &&
          (loadout ? (
            <span
              className={`truncate font-display text-[11px] leading-none font-bold tracking-[0.14em] uppercase ${accent}`}
              title={`${CLASS_INFO[loadout.class].name} · ${WEAPON_INFO[loadout.weapon].name}`}
            >
              {BUILD[loadout.class][loadout.weapon]}
            </span>
          ) : (
            side === 'ally' && <span className="text-[11px] leading-none text-ink-100">Choosing…</span>
          ))}
      </div>
      {loadouts &&
        (loadout ? (
          <ClassAvatar key={loadout.class + loadout.weapon} cls={loadout.class} weapon={loadout.weapon} side={side} size={40} />
        ) : null)}
    </div>
  )
}

const BUILD_KEY = 'warcis.lastBuild'
function lastBuild(): Loadout | null {
  try {
    const v = JSON.parse(localStorage.getItem(BUILD_KEY) ?? 'null')
    return v && CLASS_IDS.includes(v.class) && WEAPON_IDS.includes(v.weapon) ? { class: v.class, weapon: v.weapon } : null
  } catch {
    return null // private mode or a corrupt value: just start empty
  }
}
function rememberBuild(l: Loadout) {
  try {
    localStorage.setItem(BUILD_KEY, JSON.stringify(l))
  } catch {
    /* private mode */
  }
}

const revealed = new Set<string>() // "Match found" is a short client-side reveal, shown once per match (the server has no such step)

const lobbyClock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

// Ready and Decline share one fixed size: shrink-0 keeps them equal (and unchanging) when the footer is tight or the label changes.
const FOOTER_BTN = 'shrink-0 whitespace-nowrap px-0 transition duration-150'

/** Press-and-hold timer: `holding` is true while held, and `onConfirm` fires once the hold lasts `ms`. Releasing early cancels. */
function useHold(ms: number, onConfirm: () => void) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const confirm = useRef(onConfirm)
  useLayoutEffect(() => {
    confirm.current = onConfirm
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  const stop = () => {
    clearTimeout(timer.current)
    setHolding(false)
  }
  const start = () => {
    clearTimeout(timer.current)
    setHolding(true)
    timer.current = setTimeout(() => {
      setHolding(false)
      confirm.current()
    }, ms)
  }
  return { holding, start, stop, ms }
}

/** A button that acts only after being held (pointer, or Enter/Space), so a stray click can't trigger it. */
function HoldButton({
  hold,
  label,
  className,
  fillClass,
  disabled,
  children,
}: {
  hold: ReturnType<typeof useHold>
  label: string
  className: string
  fillClass: string
  disabled?: boolean
  children: ReactNode
}) {
  const { holding, start, stop, ms } = hold
  const isHoldKey = (e: React.KeyboardEvent) => e.key === 'Enter' || e.key === ' '
  return (
    <button
      type="button"
      aria-label={label}
      title="Press and hold"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onBlur={stop}
      onKeyDown={(e) => {
        if (isHoldKey(e) && !e.repeat) {
          e.preventDefault()
          start()
        }
      }}
      onKeyUp={(e) => isHoldKey(e) && stop()}
      onContextMenu={(e) => e.preventDefault()}
      className={`btn relative touch-none overflow-hidden select-none ${className}`}
    >
      <span
        aria-hidden
        className={`absolute inset-0 origin-left ${fillClass}`}
        style={{ transform: `scaleX(${holding ? 1 : 0})`, transition: `transform ${holding ? ms : 150}ms ${holding ? 'linear' : 'ease-out'}` }}
      />
      <span className="relative flex items-center justify-center gap-2">{children}</span>
    </button>
  )
}

function Lobby({
  match,
  me,
  onReady,
  onLoadout,
  onLeave,
}: {
  match: MatchDTO
  me: Player
  onReady: (id: string) => void
  onLoadout: (id: string, l: Loadout) => void
  onLeave: (id: string) => void
}) {
  // The server owns everything here: the loadouts, the ready flags, the lobby deadline and the countdown.
  const [now, setNow] = useState(() => Date.now())
  const counting = match.status === 'COUNTDOWN' && !!match.countdown_ends_at
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), counting ? 100 : 500)
    return () => clearInterval(t)
  }, [counting])
  const [reveal, setReveal] = useState(() => match.status === 'FOUND' && !revealed.has(match.match_id))
  useEffect(() => {
    revealed.add(match.match_id)
    if (!reveal) return
    const t = setTimeout(() => setReveal(false), 2200)
    return () => clearTimeout(t)
  }, [match.match_id, reveal])

  const saved = match.loadouts[me.id] as Loadout | undefined // what the server holds for me (survives a refresh)
  const iAmReady = match.ready.includes(me.id)
  const locked = iAmReady || match.status !== 'FOUND'
  // No pick on the server yet: start from the build this player used last time (still sent and confirmed like any pick).
  const [last] = useState(() => (saved || locked ? null : lastBuild()))
  const [draft, setDraft] = useState<Partial<Loadout>>(() => ({ class: saved?.class ?? last?.class, weapon: saved?.weapon ?? last?.weapon }))
  const confirmed = !!saved && saved.class === draft.class && saved.weapon === draft.weapon
  const choose = (pick: Partial<Loadout>) => {
    if (locked) return
    const next = { ...draft, ...pick }
    setDraft(next)
    if (next.class && next.weapon) {
      onLoadout(match.match_id, { class: next.class, weapon: next.weapon })
      rememberBuild({ class: next.class, weapon: next.weapon })
    }
  }
  useEffect(() => {
    if (last) onLoadout(match.match_id, last)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const wasReady = useRef(iAmReady)
  useEffect(() => {
    if (iAmReady && !wasReady.current) sfx.lockIn()
    wasReady.current = iAmReady
  }, [iAmReady])

  const left = counting ? Math.max(0, Math.ceil((Date.parse(match.countdown_ends_at!) - now) / 1000)) : 0
  const closesIn = match.lobby_ends_at && match.status === 'FOUND' ? Math.max(0, Math.ceil((Date.parse(match.lobby_ends_at) - now) / 1000)) : null

  const ours = playersOf(match.teams[match.my_team], me.id)
  const theirs = playersOf(match.teams[1 - match.my_team], me.id)
  const readyIds = new Set(match.ready)
  const total = match.teams.reduce((n, t) => n + t.players.length, 0)
  const ready = readyIds.size
  const allReady = ready >= total
  const canReady = !iAmReady && confirmed
  const readyHold = useHold(600, () => onReady(match.match_id))
  const declineHold = useHold(800, () => onLeave(match.match_id))
  const rRef = useRef({ canReady, readyHold, declineHold, iAmReady })
  useLayoutEffect(() => {
    rRef.current = { canReady, readyHold, declineHold, iAmReady }
  })
  useEffect(() => {
    const isR = (e: KeyboardEvent) => e.key === 'r' || e.key === 'R'
    const isD = (e: KeyboardEvent) => e.key === 'd' || e.key === 'D'
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.tagName === 'INPUT') return
      if (isR(e) && rRef.current.canReady) rRef.current.readyHold.start()
      else if (isD(e) && !rRef.current.iAmReady) rRef.current.declineHold.start()
    }
    const up = (e: KeyboardEvent) => {
      if (isR(e)) rRef.current.readyHold.stop()
      else if (isD(e)) rRef.current.declineHold.stop()
    }
    const cancel = () => {
      rRef.current.readyHold.stop()
      rRef.current.declineHold.stop()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  const team = (side: 'ally' | 'foe', list: QPlayer[]) => (
    <div
      className={`flex min-h-0 flex-col gap-3 rounded-[10px] border border-neon/25 bg-gradient-to-b from-white/[0.04] to-white/[0.01] p-3 lg:row-start-1 ${side === 'ally' ? 'lg:col-start-1' : 'lg:col-start-3'}`}
    >
      <h2 className={`font-display text-base font-bold tracking-wider uppercase ${side === 'ally' ? 'text-ally' : 'text-foe'}`}>
        {side === 'ally' ? 'Your team' : 'Opponents'}
      </h2>
      <div className="grid min-h-0 flex-1 auto-rows-fr gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {list.map((p) => (
          <PlayerTile key={p.id} p={p} mine={p.id === me.id} side={side} readyIds={readyIds} loadouts={match.loadouts} />
        ))}
      </div>
    </div>
  )

  if (reveal)
    return (
      <Frame cut={28} glow>
      <section className="relative grid min-h-[calc(100vh-8rem)] place-items-center px-4 py-10 text-center" aria-live="assertive">
      {['top-3 left-3 border-t-2 border-l-2', 'bottom-3 left-3 border-b-2 border-l-2', 'bottom-3 right-3 border-b-2 border-r-2'].map((c) => (
        <span key={c} aria-hidden className={`pointer-events-none absolute size-5 border-neon/70 ${c}`} />
      ))}

        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_50%,color-mix(in_srgb,var(--color-gold)_16%,transparent),transparent_60%)]" />
        <div className="relative animate-rise">
          <p className="label">{modeLabel(match.mode)} · 4v4 · EU West</p>
          <h1 className="mt-2 font-display text-6xl font-bold tracking-[0.12em] text-gold uppercase [text-shadow:0_0_40px_color-mix(in_srgb,var(--color-gold)_35%,transparent)] sm:text-7xl">Match found</h1>
          <div className="mx-auto mt-4 h-px w-64 bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
        </div>
      </section>
      </Frame>
    )

  const urgent = closesIn !== null && closesIn <= 10
  return (
    <Frame cut={28} glow className="lg:h-[calc(100dvh-7.25rem)] lg:min-h-[560px]">
    <section className="relative flex h-full flex-col gap-3 p-4" aria-live="polite">
      {['top-3 left-3 border-t-2 border-l-2', 'bottom-3 left-3 border-b-2 border-l-2', 'bottom-3 right-3 border-b-2 border-r-2'].map((c) => (
        <span key={c} aria-hidden className={`pointer-events-none absolute size-5 border-neon/70 ${c}`} />
      ))}

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_15%_50%,color-mix(in_srgb,var(--color-ally)_8%,transparent),transparent_50%),radial-gradient(ellipse_at_85%_50%,color-mix(in_srgb,var(--color-foe)_8%,transparent),transparent_50%)]" />

      <div className="relative grid items-center justify-items-center gap-3 sm:grid-cols-[1fr_auto_1fr] sm:justify-items-stretch sm:gap-4">
        <h1 className="max-sm:sr-only flex items-center gap-3 font-display text-xl font-bold tracking-[0.12em] text-ink-100 uppercase [text-shadow:0_0_24px_color-mix(in_srgb,var(--color-neon)_30%,transparent)]">
          <span aria-hidden className="h-5 w-1 rounded-full bg-gold" />
          Match lobby
        </h1>
        <div
          role="status"
          className={`relative flex items-center gap-3 overflow-hidden rounded-full border px-4 py-2 whitespace-nowrap sm:justify-self-center font-display font-bold tabular-nums transition-colors duration-150 ${
            urgent ? 'border-foe/60 bg-foe/10' : 'border-neon/40 bg-neon/10'
          }`}
        >
          {closesIn !== null && (
            <>
              <span className="sr-only">Lobby closes in</span>
              <span className={`text-lg tracking-widest ${urgent ? 'animate-pulse text-foe' : 'text-ink-100'}`}>{lobbyClock(closesIn)}</span>
              <span className="h-4 w-px bg-white/20" aria-hidden />
            </>
          )}
          <span className="text-sm tracking-[0.12em] text-ink-100 uppercase">
            {ready} / {total} ready
          </span>
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-white/10" aria-hidden>
            <span className="block h-full bg-gold transition-[width] duration-150" style={{ width: `${(ready / total) * 100}%` }} />
          </span>
        </div>
        <p className="label hidden justify-self-end sm:block">{modeLabel(match.mode)} · 4v4 · EU West</p>
      </div>

      {closesIn !== null && (
        <p className={`relative text-center text-xs ${urgent ? 'font-semibold text-foe' : 'text-ink-300'}`}>
          The lobby is cancelled at 0:00 if not everyone is ready.
        </p>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col gap-3 lg:grid lg:grid-cols-[264px_minmax(0,1fr)_264px] lg:grid-rows-[minmax(0,1fr)_auto]">
        {team('ally', ours)}
        <Armory
          cls={draft.class}
          weapon={draft.weapon}
          locked={locked}
          onPick={choose}
        />
        {team('foe', theirs)}
      </div>

      <div className="relative flex flex-wrap items-center justify-between gap-3" aria-live="assertive">
        {allReady ? (
          <>
            <p className="font-display text-sm font-bold tracking-[0.25em] text-online uppercase">All players ready</p>
            {left > 0 ? (
              <span key={left} className="animate-rise font-display text-4xl font-bold text-gold tabular-nums">{left}</span>
            ) : (
              <p className="font-display text-xl font-bold tracking-[0.2em] text-gold uppercase">Match starting</p>
            )}
          </>
        ) : (
          <>
            <div className="flex w-full flex-col items-center gap-2">
            <div className="flex w-full flex-col-reverse items-center justify-center gap-3 sm:flex-row sm:gap-12">
              {!iAmReady && (
                <HoldButton
                  hold={declineHold}
                  label="Hold to decline the match and leave the lobby"
                  fillClass="bg-foe/30"
                  className={`${FOOTER_BTN} h-11 w-full max-w-60 sm:w-60 rounded-lg border border-foe/60 bg-transparent font-display text-xs font-bold tracking-[0.1em] text-foe uppercase hover:bg-foe/10`}
                >
                  <Icon name="x" /> Hold to decline
                  <kbd className="ml-1 rounded border border-foe/50 px-1 font-display text-[10px]">D</kbd>
                </HoldButton>
              )}
              <HoldButton
                hold={readyHold}
                label="Hold to ready up"
                disabled={!canReady}
                fillClass={iAmReady ? 'bg-online/25' : 'bg-ink-950/40'}
                className={`${FOOTER_BTN} h-14 w-full max-w-64 sm:w-64 font-display text-lg tracking-[0.1em] uppercase ${
                  iAmReady
                    ? 'btn-ghost !border-online/50 !text-online disabled:opacity-100'
                    : 'btn-gold shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-gold-soft)_50%,transparent),0_0_28px_color-mix(in_srgb,var(--color-gold)_50%,transparent)] enabled:hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-gold-soft)_70%,transparent),0_0_36px_color-mix(in_srgb,var(--color-gold)_70%,transparent)] disabled:shadow-none disabled:opacity-40'
                }`}
              >
                {iAmReady ? <Icon name="check" /> : null} {iAmReady ? 'Locked in' : 'Hold to ready'}
                {!iAmReady && <kbd className="ml-1 rounded border border-ink-950/30 px-1 font-display text-[10px]">R</kbd>}
              </HoldButton>
            </div>
            {!iAmReady && !confirmed && (
              <p className="text-sm text-ink-300">{!draft.class || !draft.weapon ? 'Pick a class and a weapon to ready up.' : 'Saving your loadout…'}</p>
            )}
            </div>
          </>
        )}
      </div>
    </section>
    </Frame>
  )
}
