import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { HistoryItem, PlayerStats } from './api'
import { MAX_PARTY, STATUS_LABEL, statLine, type Mode, type Player } from './data'
import { Avatar, AvatarStatus, DashBorder, Frame, Icon, PageTitle, WorldArt } from './ui'

export type View = 'home' | 'friends' | 'party' | 'profile'
export interface Party {
  leaderId: string
  members: Player[]
  pending: Player[]
}
export interface Ctx {
  me: Player
  friends: Player[]
  requestsIn: Player[]
  requestsOut: Player[]
  party: Party
  mode: Mode
  fill: boolean
  activity: { id: number; text: string; t: number }[]
  stats: Record<string, PlayerStats>
  history: HistoryItem[] // newest first
  isLeader: boolean
  slotsUsed: number
  setView: (v: View) => void
  setMode: (m: Mode) => void
  setFill: (f: boolean) => void
  canInvite: (f: Player) => boolean
  inParty: (id: string) => boolean
  invite: (f: Player) => void
  cancelInvite: (id: string) => void
  kick: (id: string) => void
  leave: () => void
  sendRequest: (name: string) => Promise<string | null>
  acceptRequest: (p: Player) => void
  declineRequest: (p: Player) => void
  matchmake: () => void
  cancelQueue: () => void
}

/* ─────────────── Shared pieces ─────────────── */

function blockReason(c: Ctx) {
  const leader = c.party.members.find((m) => m.id === c.party.leaderId)
  if (!c.isLeader) return `Waiting for ${leader?.name ?? 'leader'} to start the queue`
  if (c.party.pending.length) return 'Waiting on pending invites'
  return null
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`

function MatchmakeButton(c: Ctx & { className?: string }) {
  const reason = blockReason(c)
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (since == null) return
    // Home unmounts once the server reports the queue; this covers the gap, and resets if the request failed.
    const tick = setInterval(() => setNow(Date.now()), 500)
    const giveUp = setTimeout(() => setSince(null), 8000)
    return () => (clearInterval(tick), clearTimeout(giveUp))
  }, [since])
  const go = () => (setSince(Date.now()), setNow(Date.now()), c.matchmake())

  if (since != null)
    return (
      <div className={c.className}>
        <div className="relative flex h-14 items-center justify-center gap-3 rounded-lg border border-gold/60 bg-gold/10 font-display text-lg font-bold tracking-widest text-gold uppercase">
          <span className="absolute inset-0 rounded-lg border border-gold" style={{ animation: 'ring 1.6s ease-out infinite' }} />
          <span className="size-4 animate-spin rounded-full border-2 border-gold border-t-transparent" />
          Searching… <span className="tabular-nums">{clock(Math.max(0, Math.floor((now - since) / 1000)))}</span>
        </div>
        <button onClick={() => (setSince(null), c.cancelQueue())} className="btn-ghost mt-2 w-full py-2 text-xs">
          <Icon name="x" /> Cancel
        </button>
      </div>
    )
  return (
    <div className={c.className}>
      <button onClick={go} disabled={!!reason} className="btn-gold btn-cta w-full px-10">
        <Icon name="bolt" className="size-5" /> Matchmake
      </button>
      {reason && <p className="mt-2 text-xs text-ink-300 select-none">{reason}</p>}
    </div>
  )
}

function FillToggle({ fill, setFill }: Pick<Ctx, 'fill' | 'setFill'>) {
  return (
    <div title="Fill: open party slots are filled with players from other parties. No fill: your party queues as-is and faces a locked-size party." className="inline-grid grid-cols-2 rounded-lg border border-white/10 bg-ink-950/60 p-1" role="radiogroup" aria-label="Fill open slots">
      {([true, false] as const).map((v) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={fill === v}
          onClick={() => setFill(v)}
          className={`rounded-md px-4 py-1.5 font-display text-xs font-semibold tracking-widest uppercase transition ${
            fill === v ? 'bg-ink-700 text-gold' : 'text-ink-300 hover:text-ink-100'
          }`}
        >
          {v ? 'Fill' : 'No fill'}
        </button>
      ))}
    </div>
  )
}

const statusText = (c: Ctx, f: Player) =>
  c.party.members.some((m) => m.id === f.id)
    ? 'In your party'
    : c.party.pending.some((m) => m.id === f.id)
      ? 'Invite pending…'
      : (f.note ?? STATUS_LABEL[f.status])

function FriendRow({ c, f, compact }: { c: Ctx; f: Player; compact?: boolean }) {
  const joined = c.inParty(f.id)
  const record = statLine(c.stats[f.id])
  return (
    <li className={`group flex items-center gap-3 rounded-lg border-l-2 border-transparent px-2 transition hover:border-neon hover:bg-neon/[0.07] ${compact ? 'py-2' : 'min-h-14 py-2'}`}>
      <AvatarStatus name={f.name} status={f.status} size={compact ? 34 : 40} />
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-semibold ${f.status === 'offline' ? 'text-ink-300' : ''}`}>
          {f.name}
          <span className="ml-1 font-normal text-ink-300">#{f.tag}</span>
        </p>
        <p className={`truncate text-xs ${f.status === 'ingame' ? 'text-ingame' : f.status === 'online' ? 'text-online' : f.status === 'away' ? 'text-away' : joined ? 'text-ally' : 'text-ink-300'}`}>
          {statusText(c, f)}
          {record && (
            <span className="text-ink-300" title="Wins–losses and kill/death ratio">
              {' · '}
              {record}
            </span>
          )}
        </p>
      </div>
      {!joined && f.status === 'ingame' && (
        <span className="rounded-full border border-ingame/30 bg-ingame/10 px-2 py-0.5 text-[11px] font-semibold text-ingame">In match</span>
      )}
      {!joined && c.canInvite(f) && (
        <button
          onClick={() => c.invite(f)}
          title="Invite to party"
          className={`btn-ghost hover:!border-gold hover:!bg-gold hover:!text-ink-950 ${compact ? 'size-8 !p-0' : 'py-1.5 text-xs'}`}
        >
          <Icon name="plus" />
          {!compact && 'Invite'}
        </button>
      )}
    </li>
  )
}

/* ─────────────── Party slots ─────────────── */

type Slot = { kind: 'member' | 'pending'; p: Player } | { kind: 'empty' }

const slotsOf = (party: Party): Slot[] => [
  ...party.members.map((p) => ({ kind: 'member' as const, p })),
  ...party.pending.map((p) => ({ kind: 'pending' as const, p })),
  ...Array.from({ length: MAX_PARTY - party.members.length - party.pending.length }, () => ({ kind: 'empty' as const })),
]

function PartyStrip(c: Ctx) {
  return (
    <div className="flex gap-2">
      {slotsOf(c.party).map((s, i) =>
        s.kind === 'empty' ? (
          <button
            key={i}
            onClick={() => c.setView('party')}
            aria-label="Invite to empty slot"
            className="relative grid size-12 place-items-center rounded-[10px] text-ink-300 transition hover:bg-gold hover:text-ink-950"
          >
            <DashBorder r={10} />
            <Icon name="plus" />
          </button>
        ) : (
          <div key={s.p.id} className="relative animate-pop" title={s.p.name}>
            <Avatar name={s.p.name} size={48} dim={s.kind === 'pending'} />
            {s.p.id === c.party.leaderId && (
              <span className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-gold text-ink-950">
                <Icon name="crown" className="size-3" />
              </span>
            )}
          </div>
        ),
      )}
    </div>
  )
}

function InvitePicker({ c, onClose }: { c: Ctx; onClose: () => void }) {
  const list = c.friends.filter(c.canInvite)
  return (
    <div className="panel absolute inset-x-2 top-2 z-10 animate-rise bg-ink-800 p-2 shadow-2xl">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="label">Invite friend</span>
        <button onClick={onClose} aria-label="Close" className="text-ink-300 hover:text-ink-100">
          <Icon name="x" />
        </button>
      </div>
      {list.length ? (
        <ul className="max-h-56 overflow-y-auto">
          {list.map((f) => (
            <li key={f.id}>
              <button onClick={() => (c.invite(f), onClose())} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5">
                <AvatarStatus name={f.name} status={f.status} size={28} />
                <span className="truncate">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-3 text-xs text-ink-300">No friends available to invite.</p>
      )}
    </div>
  )
}

function PartySlotCard({ c, s, first }: { c: Ctx; s: Slot; first: boolean }) {
  const [picking, setPicking] = useState(false)
  const base = 'relative flex min-h-72 flex-col items-center rounded-[10px] p-5 text-center transition'

  if (s.kind === 'empty') {
    return (
      <div className={`${base} text-ink-300 bg-white/[0.015]`}>
        <DashBorder />
        <button onClick={() => setPicking(true)} aria-label="Invite friend" className="group my-auto flex flex-col items-center gap-3 text-ink-300 hover:text-gold">
          <span className="grid size-20 place-items-center rounded-full border border-dashed border-current transition group-hover:scale-105">
            <Icon name="plus" className="size-7" />
          </span>
          {first && <span className="font-display text-sm font-semibold tracking-widest uppercase">Invite friend</span>}
        </button>
        {picking && <InvitePicker c={c} onClose={() => setPicking(false)} />}
      </div>
    )
  }

  const p = s.p.id === c.me.id ? c.me : s.p
  const you = p.id === c.me.id
  const leader = p.id === c.party.leaderId
  const pending = s.kind === 'pending'

  return (
    <div
      className={`${base} animate-pop border bg-gradient-to-b ${
        pending ? 'border-neon/20 from-white/[0.03] to-transparent' : 'border-ally/40 from-ally/[0.08] to-ink-850 hover:-translate-y-0.5 hover:border-ally/80'
      }`}
    >
      <div className="flex min-h-5 w-full items-center justify-end">
        {leader && (
          <span className="flex items-center gap-1 rounded bg-gold/15 px-1.5 py-0.5 font-display text-[10px] font-bold tracking-widest text-gold uppercase">
            <Icon name="crown" className="size-3" /> Leader
          </span>
        )}
      </div>
      <div className="relative mt-5">
        {!pending && <span className="absolute inset-0 rounded-full bg-ally/20 blur-2xl" />}
        <Avatar name={p.name} size={96} dim={pending} />
      </div>
      <p className="mt-4 font-display text-lg font-semibold">
        {p.name}
      </p>
      <p className="text-xs text-ink-300">#{p.tag}</p>
      <p className={`mt-2 flex items-center gap-1.5 text-xs ${pending ? 'text-ink-300' : 'text-online'}`}>
        {pending ? (
          <>
            <span className="size-1.5 animate-pulse rounded-full bg-gold" /> Invite sent…
          </>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-online" /> {p.status === 'away' ? 'Away' : 'Online'}
          </>
        )}
      </p>
      <div className="mt-auto pt-4">
        {pending ? (
          <button onClick={() => c.cancelInvite(p.id)} className="btn-ghost py-1.5 text-xs">
            Cancel invite
          </button>
        ) : you && c.party.members.length > 1 ? (
          <button onClick={c.leave} className="btn-ghost py-1.5 text-xs text-foe">
            <Icon name="logout" /> Leave party
          </button>
        ) : !you && c.isLeader ? (
          <button onClick={() => c.kick(p.id)} className="btn-ghost py-1.5 text-xs">
            <Icon name="x" /> Remove
          </button>
        ) : null}
      </div>
    </div>
  )
}

/* ─────────────── Views ─────────────── */

const since = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

function CountUp({ to }: { to: number }) {
  const [v, setV] = useState(0)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setV(to)
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 800)
      setV(Math.round(to * (1 - (1 - k) ** 3)))
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [to])
  return <>{v}</>
}

function StatTile({ label, value, suffix = '', tone = '' }: { label: string; value: number | null; suffix?: string; tone?: string }) {
  return (
    <div className="panel-quiet px-4 py-3">
      <p className="label">{label}</p>
      <p className={`mt-1 font-display text-3xl font-bold tabular-nums ${tone}`}>
        {value == null ? '–' : <><CountUp to={value} />{suffix}</>}
      </p>
    </div>
  )
}

function StatsStrip({ stats, history }: Pick<Ctx, 'history'> & { stats?: PlayerStats }) {
  const streak = history.findIndex((h) => h.outcome !== 'WIN')
  const wins = streak < 0 ? history.length : streak // ponytail: capped at the 20 matches the hub loads
  const none = !stats?.matches
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Matches" value={stats?.matches ?? null} />
      <StatTile label="Win rate" value={none || stats.win_rate == null ? null : Math.round(stats.win_rate * 100)} suffix="%" />
      <StatTile label="Flag captures" value={stats?.captures ?? null} />
      <StatTile label="Win streak" value={wins} tone={wins > 1 ? 'text-online' : ''} />
    </div>
  )
}

function LastMatch({ m }: { m?: HistoryItem }) {
  if (!m)
    return (
      <div className="panel-quiet flex flex-col justify-center p-5">
        <p className="label">Last match</p>
        <p className="mt-2 font-display text-lg font-semibold">Play your first match</p>
        <p className="text-sm text-ink-300">Hit Matchmake above, your result shows up here.</p>
      </div>
    )
  const win = m.outcome === 'WIN'
  const mine = m.scores?.[m.my_team]
  const theirs = m.scores?.[m.my_team === 'RED' ? 'BLUE' : 'RED']
  return (
    <div className={`panel-quiet p-5 ${win ? '!border-online/25 !bg-online/[0.07]' : m.outcome === 'LOSS' ? '!border-foe/25 !bg-foe/[0.07]' : ''}`}>
      <p className="label">Last match · {since(m.played_at)}</p>
      <p className={`mt-2 font-display text-3xl font-bold ${win ? 'text-online' : m.outcome === 'LOSS' ? 'text-foe' : 'text-ink-300'}`}>
        {win ? 'Win' : m.outcome === 'LOSS' ? 'Loss' : 'Draw'}
        {mine != null && theirs != null && <span className="ml-2 text-ink-100">{mine}–{theirs}</span>}
      </p>
      <p className="mt-1 text-sm text-ink-300">
        {m.me.kills} kills · {m.me.captures} captures · Capture the Flag
      </p>
    </div>
  )
}

export function Home(c: Ctx) {
  return (
    <div className="stagger space-y-6 pb-10">
      <Frame cut={28} glow className="min-h-[26rem] [@media(max-height:520px)]:min-h-0">
        <WorldArt className="absolute inset-0 h-full w-full [mask-image:linear-gradient(to_right,transparent_20%,black_75%)]" />
        <div className="relative grid min-h-[26rem] [@media(max-height:520px)]:min-h-0 items-center gap-8 p-8 pt-12 [@media(max-height:520px)]:py-6 sm:p-10 sm:pt-14 lg:grid-cols-[1fr_24rem]">
          <div className="max-w-xl">
            <h1 className="font-display text-3xl leading-[1.05] font-bold text-white [text-shadow:0_2px_18px_rgb(0_0_0/0.7)] sm:text-5xl">
              Squad up.
              <br />
              Queue together.
            </h1>
            <p className="mt-3 text-ink-100/80">Up to 4v4 capture the flag.</p>
            <div className="mt-6 flex items-center gap-4">
              <PartyStrip {...c} />
              <button onClick={() => c.setView('party')} className="text-xs font-semibold text-neon hover:underline">
                Manage party
              </button>
            </div>
          </div>
          <Frame cut={18} className="self-end shadow-2xl shadow-black/70 lg:mt-24">
            <div className="space-y-4 p-4">
              <div className="flex items-center justify-between">
                <span className="label">Fill open slots</span>
                <FillToggle fill={c.fill} setFill={c.setFill} />
              </div>
              <MatchmakeButton {...c} />
            </div>
          </Frame>
        </div>
      </Frame>
      <StatsStrip stats={c.stats[c.me.id]} history={c.history} />
      <LastMatch m={c.history[0]} />
    </div>
  )
}

export function PartyPage(c: Ctx) {
  const firstEmpty = slotsOf(c.party).findIndex((x) => x.kind === 'empty')
  return (
    <div className="stagger space-y-6 pb-10">
      <PageTitle>Party</PageTitle>

      <Frame cut={28} glow>
        <div className="bg-[radial-gradient(ellipse_at_50%_120%,color-mix(in_srgb,var(--color-neon)_12%,transparent),transparent_60%)] p-4 sm:p-6">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {slotsOf(c.party).map((s, i) => (
              <PartySlotCard key={s.kind === 'empty' ? `e${i}` : s.p.id} c={c} s={s} first={i === firstEmpty} />
            ))}
          </div>
          <div className="pointer-events-none mx-auto mt-6 h-px w-2/3 bg-gradient-to-r from-transparent via-neon/40 to-transparent" />
          <div className="mx-auto mt-6 flex max-w-md flex-col items-center gap-4">
            <div className="flex w-full items-center justify-between">
              <span className="label">Fill open slots</span>
              <FillToggle fill={c.fill} setFill={c.setFill} />
            </div>
            <MatchmakeButton {...c} className="w-full text-center" />
          </div>
        </div>
      </Frame>
    </div>
  )
}

function RecentPlayers(c: Ctx) {
  const seen = new Set([c.me.id, ...c.friends.map((f) => f.id), ...c.requestsOut.map((p) => p.id)])
  const list: { id: string; name: string }[] = []
  for (const h of c.history.slice(0, 5))
    for (const p of h.players)
      if (!seen.has(p.id)) (seen.add(p.id), list.push(p))
  const [sent, setSent] = useState<string[]>([])
  if (!list.length) return null
  return (
    <div className="neon-card shrink-0">
      <p className="label border-b border-white/5 px-4 py-3">Recent players</p>
      <ul className="p-2">
        {list.slice(0, 4).map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
            <Avatar name={p.name} size={34} />
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</p>
            <button
              disabled={sent.includes(p.id)}
              onClick={() => c.sendRequest(p.name).then((err) => !err && setSent((x) => [...x, p.id]))}
              className="btn-ghost !bg-transparent py-1 text-xs"
            >
              {sent.includes(p.id) ? 'Sent' : 'Add friend'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function FriendsSidebar(c: Ctx) {
  const on = c.friends.filter((f) => f.status !== 'offline')
  const off = c.friends.filter((f) => f.status === 'offline')
  return (
    <div className="flex h-full flex-col gap-4">
    <div className="neon-card flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <p className="label">
          Friends <span className="text-online">· {on.length} online</span>
        </p>
      </div>
      <div className="max-h-[28rem] overflow-y-auto p-2">
        <ul>
          {on.map((f) => (
            <FriendRow key={f.id} c={c} f={f} compact />
          ))}
        </ul>
        {off.length > 0 && (
          <details className="group">
            <summary className="label cursor-pointer list-none px-2 pt-4 pb-1 select-none hover:text-ink-100"><span className="inline-block transition group-open:rotate-90">▸</span> Offline · {off.length}</summary>
            <ul>
              {off.map((f) => (
                <FriendRow key={f.id} c={c} f={f} compact />
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
    <RecentPlayers {...c} />
    </div>
  )
}

const Section = ({ title, tone, children, open = true }: { title: string; tone: string; children: ReactNode; open?: boolean }) => (
  <details open={open} className="group">
    <summary className="label flex cursor-pointer list-none items-center gap-2 px-2 pt-5 pb-2 select-none hover:text-ink-100">
      <Icon name="chevron" className="size-3 transition group-open:rotate-90" />
      <span aria-hidden className={`h-3 w-1 rounded-full ${tone}`} />
      {title}
    </summary>
    <ul>{children}</ul>
  </details>
)

const TABS = ['All', 'Online', 'Offline'] as const

export function FriendsPage(c: Ctx) {
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [tab, setTab] = useState<(typeof TABS)[number]>('All')
  const by = (st: Player['status']) => c.friends.filter((f) => f.status === st)
  const [online, away, ingame, offline] = [by('online'), by('away'), by('ingame'), by('offline')]
  const nOn = online.length + away.length + ingame.length
  const reqs = c.requestsIn.length + c.requestsOut.length

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const err = await c.sendRequest(name)
    setMsg(err ? { ok: false, text: err } : { ok: true, text: `Request sent to ${name.trim()}` })
    if (!err) setName('')
  }
  const rows = (list: Player[]) => list.map((f) => <FriendRow key={f.id} c={c} f={f} />)

  return (
    <div className="stagger space-y-6 pb-10">
      <Frame cut={28} glow>
        <div className="flex flex-wrap items-center justify-between gap-4 bg-[radial-gradient(ellipse_at_85%_0%,color-mix(in_srgb,var(--color-neon)_12%,transparent),transparent_60%)] p-5 sm:p-6">
          <div>
            <PageTitle>Friends</PageTitle>
            <p className="mt-2 flex items-center gap-3 text-sm text-ink-300">
              <span className="flex items-center gap-1.5 rounded-full border border-online/40 bg-online/10 px-2.5 py-0.5 text-xs font-semibold text-online">
                <span className="size-1.5 animate-dot rounded-full bg-online" /> {nOn} online
              </span>
              <span className="tabular-nums">{c.friends.length} total</span>
            </p>
          </div>
          <form onSubmit={submit} className="w-full sm:w-96">
            <label className="label" htmlFor="add-friend">Add friend</label>
            <div className="mt-2 flex gap-2">
              <input id="add-friend" className="input h-11" placeholder="Username#1234" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn-gold h-11 shrink-0 px-4" aria-label="Send request">
                <Icon name="send" />
              </button>
            </div>
            <p className="mt-1.5 min-h-4 text-xs" aria-live="polite">
              {msg && <span className={msg.ok ? 'text-online' : 'text-foe'}>{msg.text}</span>}
            </p>
          </form>
        </div>
      </Frame>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section className="neon-card !translate-y-0 p-3 sm:p-4">
          <div className="inline-grid grid-cols-3 rounded-lg border border-neon/20 bg-inset p-1" role="tablist" aria-label="Filter friends">
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-md px-5 py-1.5 font-display text-xs font-semibold tracking-widest uppercase transition ${
                  tab === t ? 'bg-ink-800 text-gold shadow-[0_2px_0_-1px_var(--color-neon)]' : 'text-ink-300 hover:text-ink-100'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {c.friends.length === 0 && (
            <div className="grid place-items-center gap-2 py-12 text-center">
              <Icon name="party" className="size-8 text-neon" />
              <p className="text-sm text-ink-300">No friends yet. Add someone by username to squad up.</p>
            </div>
          )}
          {tab !== 'Offline' && online.length > 0 && <Section title={`Online · ${online.length}`} tone="bg-online">{rows(online)}</Section>}
          {tab !== 'Offline' && away.length > 0 && <Section title={`Away · ${away.length}`} tone="bg-away">{rows(away)}</Section>}
          {tab !== 'Offline' && ingame.length > 0 && <Section title={`In match · ${ingame.length}`} tone="bg-ingame">{rows(ingame)}</Section>}
          {tab !== 'Online' && offline.length > 0 && <Section title={`Offline · ${offline.length}`} tone="bg-ink-300" open={tab === 'Offline'}>{rows(offline)}</Section>}
        </section>

        <section className="neon-card h-fit !translate-y-0 p-4">
          <h2 className="label flex items-center gap-2 !text-ink-100">
            <span aria-hidden className="h-3 w-1 rounded-full bg-gold" /> Requests · {reqs}
          </h2>
          {reqs === 0 && (
            <div className="grid place-items-center gap-2 py-8 text-center">
              <Icon name="bell" className="size-7 text-neon" />
              <p className="text-xs text-ink-300">No pending requests.</p>
            </div>
          )}
          <ul className="mt-3 space-y-2">
            {c.requestsIn.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-lg border border-neon/20 border-l-[3px] border-l-neon bg-inset px-3 py-2">
                <Avatar name={p.name} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="text-xs text-ink-300">Incoming request</p>
                </div>
                <button onClick={() => c.acceptRequest(p)} className="btn-gold size-9 !p-0 !tracking-normal" aria-label={`Accept ${p.name}`}>
                  <Icon name="check" />
                </button>
                <button onClick={() => c.declineRequest(p)} className="btn-ghost size-9 !p-0" aria-label={`Decline ${p.name}`}>
                  <Icon name="x" />
                </button>
              </li>
            ))}
            {c.requestsOut.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-lg border border-white/10 bg-inset px-3 py-2">
                <Avatar name={p.name} size={36} dim />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="flex items-center gap-1.5 text-xs text-ink-300">
                    <span className="size-1.5 animate-pulse rounded-full bg-neon" /> Outgoing · pending
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
