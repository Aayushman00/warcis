import { useEffect, useState } from 'react'
import { api, type HistoryItem, type HistoryPage, type PlayerStats } from './api'
import type { Player } from './data'
import { Scoreboard } from './Scoreboard'
import { Avatar, Icon } from './ui'

const PAGE = 10
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`)

function Tile({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] p-3 sm:p-4">
      <p className="label">{label}</p>
      <p className={`mt-1 font-display text-3xl font-bold tabular-nums ${tone ?? ''}`}>{value}</p>
      {sub && <p className="text-xs text-ink-400">{sub}</p>}
    </div>
  )
}

function Row({ m, meId, open, toggle }: { m: HistoryItem; meId: string; open: boolean; toggle: () => void }) {
  const win = m.outcome === 'WIN'
  return (
    <li className="border-t border-white/[0.06] first:border-t-0">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[5.5rem_1fr_auto] items-center gap-3 px-3 py-3 text-left hover:bg-white/[0.03] sm:grid-cols-[6rem_1fr_9rem_auto] sm:px-4"
      >
        <span className={`font-display text-sm font-bold tracking-[0.15em] ${win ? 'text-online' : 'text-foe'}`}>{win ? 'VICTORY' : 'DEFEAT'}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">
            Squad · {m.players.length / 2}v{m.players.length / 2}
          </span>
          <span className="block truncate text-xs text-ink-400">
            {when(m.played_at)} · {mmss(m.duration_ms)}
          </span>
        </span>
        <span className="text-right text-sm tabular-nums max-sm:hidden" title="Kills / deaths / captures">
          <b>{m.me.kills}</b> K · <b>{m.me.deaths}</b> D · <b>{m.me.captures}</b> Cap
        </span>
        <Icon name="chevron" className={`size-4 text-ink-400 transition ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="animate-rise px-3 pt-1 pb-4 sm:px-4">
          <p className="mb-3 text-xs text-ink-400 sm:hidden">
            {m.me.kills} K · {m.me.deaths} D · {m.me.captures} Cap
          </p>
          <Scoreboard rows={m.players} meId={meId} myTeam={m.my_team} />
        </div>
      )}
    </li>
  )
}

export function Profile({ me, stats }: { me: Player; stats?: PlayerStats }) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [more, setMore] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const fetchPage = (before?: string | null) => api<HistoryPage>(`/matchmaking/history?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`)
  const show = (page: HistoryPage, append: boolean) => {
    setItems((old) => (append ? [...old, ...page.items.filter((i) => !old.some((o) => o.match_id === i.match_id))] : page.items))
    setNext(page.next_before)
    setState('ok')
  }
  const reload = () => {
    setState('loading')
    fetchPage().then((p) => show(p, false), () => setState('error'))
  }

  useEffect(() => {
    // Initial fetch on mount (state starts as 'loading'); the Refresh button covers a match that ends while this page is open.
    let live = true
    api<HistoryPage>(`/matchmaking/history?limit=${PAGE}`).then(
      (p) => live && show(p, false),
      () => live && setState('error'),
    )
    return () => {
      live = false
    }
  }, [])

  const s = stats
  return (
    <div className="space-y-6">
      <section className="panel p-4 sm:p-6">
        <div className="flex items-center gap-4">
          <Avatar name={me.name} size={72} />
          <div className="min-w-0">
            <p className="label">Profile</p>
            <h1 className="truncate font-display text-3xl font-bold">
              {me.name}
              <span className="ml-2 text-base font-normal text-ink-400">#{me.tag}</span>
            </h1>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Matches" value={s?.matches ?? '–'} />
          <Tile label="Wins" value={s?.wins ?? '–'} tone="text-online" />
          <Tile label="Losses" value={s?.losses ?? '–'} tone="text-foe" />
          <Tile label="Win rate" value={s ? pct(s.win_rate) : '–'} />
          <Tile label="Captures" value={s?.captures ?? '–'} tone="text-gold" />
          <Tile label="K/D" value={s ? s.kd.toFixed(2) : '–'} sub={s ? `${s.kills} kills · ${s.deaths} deaths` : undefined} />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="label">Match history</h2>
          <button onClick={reload} disabled={state === 'loading'} className="btn-ghost py-1 text-xs" aria-label="Refresh match history">
            <Icon name="refresh" /> Refresh
          </button>
        </div>
        <div className="panel overflow-hidden">
          {state === 'error' ? (
            <p className="p-5 text-sm text-foe">Could not load your match history.</p>
          ) : state === 'loading' && !items.length ? (
            <p className="p-5 text-sm text-ink-400">Loading…</p>
          ) : !items.length ? (
            <p className="p-5 text-sm text-ink-400">No finished matches yet. Capture the flag to put one on the board.</p>
          ) : (
            <ul>
              {items.map((m) => (
                <Row key={m.match_id} m={m} meId={me.id} open={open === m.match_id} toggle={() => setOpen(open === m.match_id ? null : m.match_id)} />
              ))}
            </ul>
          )}
        </div>
        {next && (
          <button
            disabled={more}
            onClick={() => {
              setMore(true)
              fetchPage(next)
                .then((p) => show(p, true))
                .catch(() => {})
                .finally(() => setMore(false))
            }}
            className="btn-ghost mx-auto mt-4 px-6"
          >
            {more ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>
    </div>
  )
}
