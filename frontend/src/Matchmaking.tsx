import { useEffect, useRef, useState } from 'react'
import type { Loadout, MatchDTO, MMStatus, QPlayer, QueueDTO, TeamDTO } from './api'
import { MAX_PARTY, type Player } from './data'
import { Game, type Rematch } from './Game'
import { BUILD, CLASS_IDS, CLASS_INFO, WEAPON_IDS, WEAPON_INFO } from './game/classes'
import { sfx } from './game/sfx'
import { Armory, ClassAvatar, HiddenAvatar } from './Loadout'
import { Avatar, Icon } from './ui'

/** A team's players as flat tiles: you first, then your party-mates, then everyone else in the server's order. */
function playersOf(team: TeamDTO, meId: string): QPlayer[] {
  const mates = new Set(team.parties.find((pt) => pt.players.includes(meId))?.players)
  const rank = (p: QPlayer) => (p.id === meId ? 0 : mates.has(p.id) ? 1 : 2)
  return [...team.players].sort((a, b) => rank(a) - rank(b)) // stable: ties keep the server's order
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const modeLabel = (_m: 'SQUAD') => 'Squad'

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

  return (
    <section className="panel relative flex min-h-[calc(100vh-8rem)] flex-col items-center overflow-hidden px-4 py-10 text-center" aria-live="polite">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,rgb(76_201_240/0.10),transparent_60%)]" />
      <p className="label relative">
        {modeName} · 4v4 · EU West · <span className="text-ink-300">{q.players_in_queue.toLocaleString()} in queue</span>
      </p>

      {/* Radar */}
      <div className="relative my-8 grid size-52 place-items-center">
        {[100, 72, 44].map((s) => (
          <span key={s} className="absolute rounded-full border border-ally/15" style={{ width: `${s}%`, height: `${s}%` }} />
        ))}
        <span className="absolute inset-0 animate-pulse-ring rounded-full border border-ally/40" />
        <span className="absolute inset-0 animate-sweep rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,rgb(76_201_240/0.28)_50deg,transparent_60deg)]" />
        <div className="relative">
          <p className="font-display text-4xl font-bold tabular-nums">{clock(elapsed)}</p>
          <p className="text-xs text-ink-400">Est. 0:30</p>
        </div>
      </div>

      <h1 className="relative font-display text-3xl font-bold tracking-wider uppercase">{title}</h1>
      <p className="relative mt-2 text-sm text-ink-300">
        Party <b>{q.size} / {MAX_PARTY}</b> <span className="mx-2 text-ink-600">|</span> Mode <b>{modeName}</b>
        <span className="mx-2 text-ink-600">|</span> <b>{q.fill ? 'Fill' : 'No fill'}</b>
      </p>

      {/* Team formation: live grouping from the server's current queue packing */}
      <div className="relative mt-10 w-full max-w-3xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="label !text-ally">Your team</span>
          <span className="font-display text-sm font-semibold">
            {filled} / {q.fill ? MAX_PARTY : filled}
          </span>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {ours.map((p) => (
            <PlayerTile key={p.id} p={p} mine={p.id === me.id} side="ally" />
          ))}
          {Array.from({ length: openSlots }, (_, i) => (
            <div key={i} className="flex w-28 flex-col items-center gap-2 rounded-xl border border-dashed border-white/12 p-3">
              <span className="grid size-14 place-items-center rounded-[28%] bg-white/[0.03]">
                <span className="size-5 animate-spin rounded-full border-2 border-ink-600 border-t-ally" />
              </span>
              <span className="text-xs text-ink-400">Searching…</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-ink-400">
          {q.fill
            ? 'Your party stays together. Open slots fill with other queued parties and solo players.'
            : 'Fill off: your party size is locked. Waiting for an opponent, any size.'}
        </p>
      </div>

      <button onClick={onCancel} className="btn-ghost relative mt-auto px-8 py-2.5 pt-2.5">
        <Icon name="x" /> Cancel matchmaking
      </button>
    </section>
  )
}

function PlayerTile({
  p,
  mine,
  side,
  readyIds,
  big,
  loadouts,
}: {
  p: QPlayer
  mine?: boolean
  side: 'ally' | 'foe'
  readyIds?: Set<string>
  big?: boolean
  loadouts?: Record<string, Loadout>
}) {
  const tone = side === 'ally' ? (mine ? 'border-gold/50 bg-gold/[0.05]' : 'border-ally/30 bg-ally/[0.04]') : 'border-foe/30 bg-foe/[0.04]'
  return (
    <div className={`animate-rise flex flex-col items-center gap-1.5 rounded-xl border p-3 ${big ? 'w-30' : 'w-28'} ${tone}`}>
      <div className="relative">
        <Avatar name={p.name} size={big ? 72 : 56} />
        {readyIds && (
          <span
            className={`absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full ring-2 ring-ink-850 transition ${
              readyIds.has(p.id) ? 'bg-online text-ink-950' : 'bg-ink-600'
            }`}
          >
            {readyIds.has(p.id) ? <Icon name="check" className="size-3" /> : <span className="size-1.5 animate-pulse rounded-full bg-ink-300" />}
          </span>
        )}
      </div>
      <span className="w-full truncate text-center text-xs font-semibold">{p.name}</span>
      {loadouts && (
        <span className="flex w-full flex-col items-center gap-0.5 text-center text-[10px] text-ink-300">
          {loadouts[p.id] ? (
            <>
              <ClassAvatar key={loadouts[p.id].class + loadouts[p.id].weapon} cls={loadouts[p.id].class} weapon={loadouts[p.id].weapon} side={side} size={44} />
              <span className={`w-full truncate font-display text-[11px] font-bold tracking-[0.14em] uppercase ${side === 'ally' ? 'text-ally' : 'text-foe'}`}>
                {BUILD[loadouts[p.id].class][loadouts[p.id].weapon]}
              </span>
              <span className="w-full truncate text-ink-400" title={`${CLASS_INFO[loadouts[p.id].class].name} · ${WEAPON_INFO[loadouts[p.id].weapon].name}`}>
                {CLASS_INFO[loadouts[p.id].class].short} · {WEAPON_INFO[loadouts[p.id].weapon].name}
              </span>
            </>
          ) : side === 'foe' ? (
            <>
              <HiddenAvatar size={44} />
              <span className="text-ink-400">Hidden</span>
            </>
          ) : (
            <span className="grid h-[44px] place-items-center text-ink-400">
              <span className="animate-pulse">Choosing…</span>
            </span>
          )}
        </span>
      )}
      {readyIds && (
        <span className={`font-display text-[10px] font-bold tracking-widest ${readyIds.has(p.id) ? 'text-online' : 'text-ink-400'}`}>
          {readyIds.has(p.id) ? 'READY ✓' : 'WAITING'}
        </span>
      )}
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

  const team = (side: 'ally' | 'foe', list: QPlayer[]) => (
    <div className={`flex-1 ${side === 'foe' ? 'lg:text-right' : ''}`}>
      <div className={`mb-4 flex items-baseline gap-3 ${side === 'foe' ? 'lg:justify-end' : ''}`}>
        <h2 className={`font-display text-xl font-bold tracking-wider uppercase ${side === 'ally' ? 'text-ally' : 'text-foe'}`}>
          {side === 'ally' ? 'Your team' : 'Opponent team'}
        </h2>
        <span className="text-sm text-ink-400">{list.length} players</span>
      </div>
      <div className={`flex flex-wrap gap-3 ${side === 'foe' ? 'lg:justify-end' : ''}`}>
        {list.map((p) => (
          <PlayerTile key={p.id} p={p} mine={p.id === me.id} side={side} readyIds={readyIds} big loadouts={match.loadouts} />
        ))}
      </div>
    </div>
  )

  if (reveal)
    return (
      <section className="panel relative grid min-h-[calc(100vh-8rem)] place-items-center overflow-hidden px-4 py-10 text-center" aria-live="assertive">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_50%,rgb(245_184_61/0.16),transparent_60%)]" />
        <div className="relative animate-rise">
          <p className="label">{modeLabel(match.mode)} · 4v4 · EU West</p>
          <h1 className="mt-2 font-display text-6xl font-bold tracking-[0.12em] text-gold uppercase [text-shadow:0_0_40px_rgb(245_184_61/0.35)] sm:text-7xl">Match found</h1>
          <div className="mx-auto mt-4 h-px w-64 bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
        </div>
      </section>
    )

  return (
    <section className="panel relative flex min-h-[calc(100vh-8rem)] flex-col justify-center overflow-hidden px-4 py-8 sm:px-8" aria-live="polite">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_50%,rgb(76_201_240/0.10),transparent_50%),radial-gradient(ellipse_at_80%_50%,rgb(240_80_110/0.10),transparent_50%)]" />
      <div className="relative animate-rise text-center">
        <p className="label">{modeLabel(match.mode)} · 4v4 · EU West</p>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-[0.12em] text-gold uppercase [text-shadow:0_0_40px_rgb(245_184_61/0.35)] sm:text-5xl">Match lobby</h1>
        {closesIn !== null && (
          <p className={`mt-2 font-display text-sm font-bold tracking-[0.2em] uppercase ${closesIn <= 10 ? 'text-foe' : 'text-ink-300'}`}>Lobby closes in {lobbyClock(closesIn)}</p>
        )}
      </div>

      <div className="relative mt-8 flex flex-col items-stretch gap-8 lg:flex-row lg:items-start">
        {team('ally', ours)}
        <div className="grid place-items-center lg:pt-10">
          <span className="grid size-14 place-items-center rounded-full border border-white/10 bg-ink-900 font-display text-lg font-bold text-ink-300">VS</span>
        </div>
        {team('foe', theirs)}
      </div>

      <div className="relative mt-8">
        <Armory
          cls={draft.class}
          weapon={draft.weapon}
          locked={locked}
          canReady={!iAmReady && confirmed}
          onPick={choose}
          onReady={() => onReady(match.match_id)}
          restored={!!last && draft.class === last.class && draft.weapon === last.weapon}
        />
      </div>

      <div className="relative mt-8 flex flex-col items-center gap-3">
        {allReady ? (
          <div className="flex flex-col items-center gap-2" aria-live="assertive">
            <p className="font-display text-sm font-bold tracking-[0.25em] text-online uppercase">All players ready</p>
            {left > 0 ? (
              <span key={left} className="animate-rise font-display text-7xl font-bold text-gold tabular-nums [text-shadow:0_0_40px_rgb(245_184_61/0.5)]">
                {left}
              </span>
            ) : (
              <p className="font-display text-2xl font-bold tracking-[0.2em] text-gold uppercase">Match starting</p>
            )}
          </div>
        ) : (
          <>
            <p className="font-display text-2xl font-bold tabular-nums">{ready} / {total} READY</p>
            <p className="text-sm text-ink-300">
              {iAmReady
                ? `Locked in. Waiting for ${total - ready} player${total - ready === 1 ? '' : 's'}…`
                : !draft.class || !draft.weapon
                  ? 'Pick a class and a weapon to ready up.'
                  : confirmed
                    ? 'Loadout saved. Ready up when you are set.'
                    : 'Saving your loadout…'}
            </p>
            <div className="h-1 w-64 overflow-hidden rounded bg-white/5">
              <div className="h-full bg-online transition-all" style={{ width: `${(ready / total) * 100}%` }} />
            </div>
            <div className="mt-2 grid w-full max-w-md grid-cols-2 gap-3">
              <button
                onClick={() => onReady(match.match_id)}
                disabled={iAmReady || !confirmed}
                className={`py-3.5 text-base ${iAmReady ? 'btn-ghost font-display tracking-[0.12em] uppercase !border-online/50 !text-online disabled:opacity-100' : `btn-gold disabled:opacity-40 ${confirmed ? 'animate-glow' : ''}`}`}
              >
                {iAmReady ? <Icon name="check" /> : null} {iAmReady ? 'Locked in' : 'Ready'}
                {!iAmReady && confirmed && <kbd className="ml-1 rounded border border-ink-950/30 px-1 font-display text-[10px]">R</kbd>}
              </button>
              <button
                onClick={() => onLeave(match.match_id)}
                className="btn-ghost py-3.5 font-display text-base tracking-[0.12em] uppercase hover:border-foe/50 hover:bg-foe/10 hover:text-foe"
              >
                <Icon name="x" /> Decline
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
