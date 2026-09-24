import { useEffect, useRef, useState } from 'react'
import type { MatchDTO, MMStatus, QPlayer, QueueDTO, TeamDTO } from './api'
import { MAX_PARTY, type Player } from './data'
import { Avatar, Icon } from './ui'

type Group = { label: string; players: QPlayer[]; mine?: boolean }

/**
 * Turn a server team ({players, parties}) into labelled party groups.
 * Your own party first ("Party A · You"), other multi-player parties get B, C, … and solos "Solo".
 */
function groupsOf(team: TeamDTO, meId: string, letters: { next: number }): Group[] {
  const byId = new Map(team.players.map((p) => [p.id, p]))
  const groups = team.parties.map((pt) => {
    const players = pt.players.map((id) => byId.get(id)!).filter(Boolean)
    const mine = pt.players.includes(meId)
    return { players, mine, label: '' }
  })
  groups.sort((a, b) => Number(b.mine) - Number(a.mine))
  for (const g of groups) {
    g.label = g.mine ? (g.players.length > 1 ? 'Party A · You' : 'You') : g.players.length > 1 ? `Party ${String.fromCharCode(66 + letters.next++)}` : 'Solo'
  }
  return groups
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const modeLabel = (m: 'SQUAD' | 'RANDOM') => (m === 'SQUAD' ? 'Squad' : 'Random')

export function Matchmaking({
  status,
  me,
  onCancel,
  onReady,
  onEnter,
  onExit,
}: {
  status: Exclude<MMStatus, { state: 'idle' }>
  me: Player
  onCancel: () => void
  onReady: (matchId: string) => void
  onEnter: (matchId: string) => void
  onExit: (matchId: string) => void
}) {
  if (status.state === 'entered') return <Entered onExit={() => onExit(status.match.match_id)} />
  if (status.state === 'found') return <Found match={status.match} me={me} onReady={onReady} onEnter={onEnter} />
  return <Searching q={status.queue} me={me} onCancel={onCancel} />
}

function Searching({ q, me, onCancel }: { q: QueueDTO; me: Player; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - Date.parse(q.joined_at)) / 1000))
  const ours = groupsOf(q.team, me.id, { next: 0 })
  const filled = q.team.players.length
  const modeName = modeLabel(q.mode)
  const title = filled < MAX_PARTY ? 'Searching for match' : 'Searching for opponents'

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
      </p>

      {/* Team formation: live grouping from the server's current queue packing */}
      <div className="relative mt-10 w-full max-w-3xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="label !text-ally">Your team</span>
          <span className="font-display text-sm font-semibold">
            {filled} / {MAX_PARTY}
          </span>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {ours.map((g) => (
            <GroupBox key={g.players[0].id} g={g} side="ally" />
          ))}
          {Array.from({ length: MAX_PARTY - filled }, (_, i) => (
            <div key={i} className="flex w-28 flex-col items-center gap-2 rounded-xl border border-dashed border-white/12 p-3">
              <span className="grid size-14 place-items-center rounded-[28%] bg-white/[0.03]">
                <span className="size-5 animate-spin rounded-full border-2 border-ink-600 border-t-ally" />
              </span>
              <span className="text-xs text-ink-400">Searching…</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-ink-400">
          {q.mode === 'SQUAD'
            ? 'Your party stays together. Open slots fill with other queued parties and solo players.'
            : 'Random queue: solo players are grouped into teams of four.'}
        </p>
      </div>

      <button onClick={onCancel} className="btn-ghost relative mt-auto px-8 py-2.5 pt-2.5">
        <Icon name="x" /> Cancel matchmaking
      </button>
    </section>
  )
}

function GroupBox({ g, side, readyIds, big }: { g: Group; side: 'ally' | 'foe'; readyIds?: Set<string>; big?: boolean }) {
  const tone = side === 'ally' ? (g.mine ? 'border-gold/50 bg-gold/[0.05]' : 'border-ally/30 bg-ally/[0.04]') : 'border-foe/30 bg-foe/[0.04]'
  const chip = side === 'ally' ? (g.mine ? 'text-gold' : 'text-ally') : 'text-foe'
  return (
    <div className={`animate-rise rounded-xl border p-3 ${tone}`}>
      <p className={`mb-2 text-left font-display text-[10px] font-bold tracking-[0.2em] uppercase ${chip}`}>
        {g.label} {g.players.length > 1 && <span className="text-ink-400">· {g.players.length}</span>}
      </p>
      <div className="flex gap-2">
        {g.players.map((p) => (
          <div key={p.id} className={`flex flex-col items-center gap-1.5 ${big ? 'w-24' : 'w-22'}`}>
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
          </div>
        ))}
      </div>
    </div>
  )
}

function Found({ match, me, onReady, onEnter }: { match: MatchDTO; me: Player; onReady: (id: string) => void; onEnter: (id: string) => void }) {
  // Seeing MATCH FOUND counts as accepting: send our ready once per match.
  const sent = useRef<string | null>(null)
  useEffect(() => {
    if (sent.current === match.match_id || match.ready.includes(me.id)) return
    sent.current = match.match_id
    onReady(match.match_id)
  }, [match.match_id, match.ready, me.id, onReady])

  const letters = { next: 0 }
  const ours = groupsOf(match.teams[match.my_team], me.id, letters)
  const theirs = groupsOf(match.teams[1 - match.my_team], me.id, letters)
  const readyIds = new Set(match.ready)
  const total = match.teams.reduce((n, t) => n + t.players.length, 0)
  const ready = readyIds.size
  const allReady = ready >= total

  const team = (side: 'ally' | 'foe', groups: Group[]) => (
    <div className={`flex-1 ${side === 'foe' ? 'lg:text-right' : ''}`}>
      <div className={`mb-4 flex items-baseline gap-3 ${side === 'foe' ? 'lg:justify-end' : ''}`}>
        <h2 className={`font-display text-xl font-bold tracking-wider uppercase ${side === 'ally' ? 'text-ally' : 'text-foe'}`}>
          {side === 'ally' ? 'Your team' : 'Opponent team'}
        </h2>
        <span className="text-sm text-ink-400">
          {groups.reduce((n, g) => n + g.players.length, 0)} / {MAX_PARTY} players
        </span>
      </div>
      <div className={`flex flex-wrap gap-3 ${side === 'foe' ? 'lg:justify-end' : ''}`}>
        {groups.map((g) => (
          <GroupBox key={g.players[0].id} g={g} side={side} readyIds={readyIds} big />
        ))}
      </div>
    </div>
  )

  return (
    <section className="panel relative flex min-h-[calc(100vh-8rem)] flex-col justify-center overflow-hidden px-4 py-10 sm:px-8" aria-live="assertive">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_50%,rgb(76_201_240/0.10),transparent_50%),radial-gradient(ellipse_at_80%_50%,rgb(240_80_110/0.10),transparent_50%)]" />
      <div className="relative animate-rise text-center">
        <p className="label">{modeLabel(match.mode)} · 4v4 · EU West</p>
        <h1 className="mt-2 font-display text-5xl font-bold tracking-[0.12em] text-gold uppercase [text-shadow:0_0_40px_rgb(245_184_61/0.35)] sm:text-6xl">
          Match found
        </h1>
        <div className="mx-auto mt-4 h-px w-64 bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
      </div>

      <div className="relative mt-10 flex flex-col items-stretch gap-8 lg:flex-row lg:items-center">
        {team('ally', ours)}
        <div className="grid place-items-center">
          <span className="grid size-16 place-items-center rounded-full border border-white/10 bg-ink-900 font-display text-xl font-bold text-ink-300">VS</span>
        </div>
        {team('foe', theirs)}
      </div>

      <div className="relative mt-12 flex flex-col items-center gap-3">
        <p className="text-sm text-ink-300">
          {allReady ? 'All players ready' : 'Waiting for players…'} <b className="ml-1 tabular-nums">{Math.min(ready, total)} / {total}</b>
        </p>
        <div className="h-1 w-64 overflow-hidden rounded bg-white/5">
          <div className="h-full bg-online transition-all" style={{ width: `${(ready / total) * 100}%` }} />
        </div>
        <button onClick={() => onEnter(match.match_id)} disabled={!allReady} className="btn-gold mt-2 px-12 py-4 text-base">
          Enter match
        </button>
      </div>
    </section>
  )
}

function Entered({ onExit }: { onExit: () => void }) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLoaded(true), 1800)
    return () => clearTimeout(t)
  }, [])
  return (
    <section className="panel flex min-h-[calc(100vh-8rem)] flex-col items-center justify-center gap-4 p-8 text-center">
      {loaded ? (
        <>
          <p className="label !text-gold">End of demo</p>
          <h1 className="font-display text-3xl font-bold">Match server connected</h1>
          <p className="max-w-md text-sm text-ink-400">Account → friends → party → queue → match. The in-match experience is outside this prototype.</p>
          <button onClick={onExit} className="btn-ghost mt-2">
            Return to hub
          </button>
        </>
      ) : (
        <>
          <span className="size-8 animate-spin rounded-full border-2 border-ink-600 border-t-gold" />
          <p className="font-display tracking-widest text-ink-300 uppercase">Connecting to match server…</p>
        </>
      )}
    </section>
  )
}
