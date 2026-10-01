import { useState, type FormEvent } from 'react'
import { ago, MAX_PARTY, MODES, STATUS_LABEL, type Mode, type Player } from './data'
import { Avatar, AvatarStatus, Icon, WorldArt } from './ui'

export type View = 'home' | 'friends' | 'party'
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
}

/* ─────────────── Shared pieces ─────────────── */

function blockReason(c: Ctx) {
  const leader = c.party.members.find((m) => m.id === c.party.leaderId)
  if (!c.isLeader) return `Waiting for ${leader?.name ?? 'leader'} to start the queue`
  if (c.party.pending.length) return 'Waiting on pending invites'
  return null
}

function MatchmakeButton(c: Ctx & { className?: string }) {
  const reason = blockReason(c)
  return (
    <div className={c.className}>
      <button onClick={c.matchmake} disabled={!!reason} className="btn-gold w-full px-10 py-4 text-base">
        <Icon name="bolt" className="size-5" /> Matchmake
      </button>
      <p className="mt-2 min-h-4 text-xs text-ink-400">
        {reason ??
          (c.fill
            ? `Party of ${c.party.members.length} enters queue, open slots fill from other parties`
            : `Party of ${c.party.members.length} enters queue as-is, matched against another locked-size party`)}
      </p>
    </div>
  )
}

function FillToggle({ fill, setFill }: Pick<Ctx, 'fill' | 'setFill'>) {
  return (
    <div className="inline-grid grid-cols-2 rounded-lg border border-white/10 bg-ink-950/60 p-1" role="radiogroup" aria-label="Fill open slots">
      {([true, false] as const).map((v) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={fill === v}
          onClick={() => setFill(v)}
          className={`rounded-md px-4 py-1.5 font-display text-xs font-semibold tracking-widest uppercase transition ${
            fill === v ? 'bg-ink-700 text-gold' : 'text-ink-400 hover:text-ink-100'
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
  return (
    <li className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.03]">
      <AvatarStatus name={f.name} status={f.status} size={compact ? 34 : 40} />
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-semibold ${f.status === 'offline' ? 'text-ink-400' : ''}`}>
          {f.name}
          <span className="ml-1 font-normal text-ink-400">#{f.tag}</span>
        </p>
        <p className={`truncate text-xs ${f.status === 'ingame' ? 'text-ingame' : joined ? 'text-ally' : 'text-ink-400'}`}>{statusText(c, f)}</p>
      </div>
      {f.status !== 'offline' && !joined && (
        <button
          onClick={() => c.invite(f)}
          disabled={!c.canInvite(f)}
          title={f.status === 'ingame' ? 'Currently in a match' : c.slotsUsed >= MAX_PARTY ? 'Party is full' : 'Invite to party'}
          className={compact ? 'btn-ghost size-8 !p-0' : 'btn-ghost py-1.5 text-xs'}
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
            className="grid size-12 place-items-center rounded-xl border border-dashed border-white/15 text-ink-400 transition hover:border-gold/60 hover:text-gold"
          >
            <Icon name="plus" />
          </button>
        ) : (
          <div key={s.p.id} className="relative" title={s.p.name}>
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
        <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-100">
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
        <p className="px-2 py-3 text-xs text-ink-400">No friends available to invite.</p>
      )}
    </div>
  )
}

function PartySlotCard({ c, s, index }: { c: Ctx; s: Slot; index: number }) {
  const [picking, setPicking] = useState(false)
  const base = 'relative flex min-h-72 flex-col items-center rounded-2xl p-5 text-center transition'

  if (s.kind === 'empty') {
    return (
      <div className={`${base} border border-dashed border-white/12 bg-white/[0.015]`}>
        <span className="label self-start">Slot {index + 1}</span>
        <button onClick={() => setPicking(true)} className="group my-auto flex flex-col items-center gap-3 text-ink-400 hover:text-gold">
          <span className="grid size-20 place-items-center rounded-full border border-dashed border-current transition group-hover:scale-105">
            <Icon name="plus" className="size-7" />
          </span>
          <span className="font-display text-sm font-semibold tracking-widest uppercase">Invite friend</span>
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
      className={`${base} animate-rise border bg-gradient-to-b ${
        pending ? 'border-white/10 from-white/[0.03] to-transparent' : 'border-ally/25 from-ally/[0.08] to-ink-850'
      }`}
    >
      <div className="flex w-full items-center justify-between">
        <span className="label">Slot {index + 1}</span>
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
        {you && <span className="ml-1.5 rounded bg-white/10 px-1.5 py-0.5 align-middle text-[10px] tracking-widest text-ink-300">YOU</span>}
      </p>
      <p className="text-xs text-ink-400">#{p.tag}</p>
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

export function Home(c: Ctx) {
  const leader = c.party.members.find((m) => m.id === c.party.leaderId)
  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl border border-white/[0.07]">
        <WorldArt className="absolute inset-0 h-full w-full" />
        <div className="absolute inset-0 bg-gradient-to-r from-ink-900/95 via-ink-900/60 to-transparent" />
        <div className="relative grid gap-8 p-6 sm:p-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="max-w-lg">
            <p className="label !text-gold">Ready to deploy</p>
            <h1 className="mt-3 font-display text-4xl leading-[1.05] font-bold sm:text-5xl">
              Squad up.
              <br />
              Queue together.
            </h1>
            <p className="mt-3 text-ink-300">Your party enters matchmaking as one unit. Open slots fill with players from the queue.</p>

            <div className="mt-8">
              <div className="mb-3 flex items-baseline gap-3">
                <span className="label">Party</span>
                <span className="font-display text-sm font-semibold">
                  {c.party.members.length} / {MAX_PARTY}
                </span>
                <span className="text-xs text-ink-400">Leader · {leader?.name}</span>
              </div>
              <PartyStrip {...c} />
            </div>
          </div>
          <div className="w-full space-y-4 rounded-2xl border border-white/[0.08] bg-ink-900/80 p-4 backdrop-blur-sm lg:w-80">
            <div className="flex items-center justify-between">
              <span className="label">Fill open slots</span>
              <FillToggle fill={c.fill} setFill={c.setFill} />
            </div>
            <MatchmakeButton {...c} />
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section>
          <h2 className="label mb-3">Game modes</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {MODES.map((m) => {
              const active = m.id === c.mode
              return (
                <button
                  key={m.id}
                  disabled={m.locked}
                  onClick={() => c.setMode(m.id as Mode)}
                  className={`panel flex items-start gap-3 p-4 text-left transition enabled:hover:border-white/15 disabled:opacity-50 ${active ? '!border-gold/50 !bg-gold/[0.06]' : ''}`}
                >
                  <span className={`grid size-10 shrink-0 place-items-center rounded-lg ${active ? 'bg-gold text-ink-950' : 'bg-white/5 text-ink-300'}`}>
                    <Icon name={m.locked ? 'lock' : m.id === 'squad' ? 'users' : 'bolt'} className="size-5" />
                  </span>
                  <span>
                    <span className="block font-display font-semibold tracking-wide uppercase">{m.name}</span>
                    <span className="block text-xs text-ink-400">{m.locked ? 'Coming soon' : m.blurb}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
        <section>
          <h2 className="label mb-3">Recent activity</h2>
          <ul className="panel divide-y divide-white/5">
            {c.activity.slice(0, 4).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="truncate text-ink-300">{a.text}</span>
                <span className="shrink-0 text-xs text-ink-400">{ago(a.t)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

export function PartyPage(c: Ctx) {
  const leader = c.party.members.find((m) => m.id === c.party.leaderId)
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Party lobby</p>
          <h1 className="mt-1 flex items-baseline gap-3 font-display text-3xl font-bold">
            PARTY <span className="text-gold">{c.party.members.length}</span>
            <span className="text-ink-400">/ {MAX_PARTY}</span>
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            Leader <b className="text-ink-100">{leader?.name}</b> controls matchmaking.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <FillToggle fill={c.fill} setFill={c.setFill} />
        </div>
      </div>

      <section className="relative rounded-3xl border border-white/[0.06] bg-[radial-gradient(ellipse_at_50%_120%,rgb(76_201_240/0.12),transparent_60%)] p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {slotsOf(c.party).map((s, i) => (
            <PartySlotCard key={s.kind === 'empty' ? `e${i}` : s.p.id} c={c} s={s} index={i} />
          ))}
        </div>
        <div className="pointer-events-none mx-auto mt-4 h-px w-2/3 bg-gradient-to-r from-transparent via-ally/40 to-transparent" />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="panel p-5">
          <h2 className="label">How squad queue works</h2>
          <ol className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            {[
              ['Form party', '1 to 4 players. Friends join your lobby.'],
              ['Queue together', 'The leader starts matchmaking for everyone.'],
              ['Team assembled', 'Open slots fill from the queue. Full premades stay intact.'],
            ].map(([t, d], i) => (
              <li key={t} className="rounded-xl bg-white/[0.02] p-3">
                <span className="font-display text-xs font-bold text-gold">0{i + 1}</span>
                <p className="mt-1 font-semibold">{t}</p>
                <p className="text-xs text-ink-400">{d}</p>
              </li>
            ))}
          </ol>
        </section>
        <MatchmakeButton {...c} className="self-end" />
      </div>
    </div>
  )
}

export function FriendsSidebar(c: Ctx) {
  const on = c.friends.filter((f) => f.status !== 'offline')
  const off = c.friends.filter((f) => f.status === 'offline')
  return (
    <div className="panel sticky top-22 flex max-h-[calc(100vh-7rem)] flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <p className="label">
          Friends <span className="text-online">· {on.length} online</span>
        </p>
        <button onClick={() => c.setView('friends')} className="btn-ghost size-8 !p-0" aria-label="Add friend">
          <Icon name="plus" />
        </button>
      </div>
      <div className="overflow-y-auto p-2">
        <ul>
          {on.map((f) => (
            <FriendRow key={f.id} c={c} f={f} compact />
          ))}
        </ul>
        <p className="label px-2 pt-4 pb-1">Offline · {off.length}</p>
        <ul>
          {off.map((f) => (
            <FriendRow key={f.id} c={c} f={f} compact />
          ))}
        </ul>
      </div>
    </div>
  )
}

export function FriendsPage(c: Ctx) {
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const on = c.friends.filter((f) => f.status !== 'offline')
  const off = c.friends.filter((f) => f.status === 'offline')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const err = await c.sendRequest(name)
    setMsg(err ? { ok: false, text: err } : { ok: true, text: `Request sent to ${name.trim()}` })
    if (!err) setName('')
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section className="panel p-2 sm:p-4">
        <div className="flex items-baseline justify-between px-2 pb-2">
          <h1 className="font-display text-2xl font-bold">Friends</h1>
          <span className="text-sm text-ink-400">
            <b className="text-online">{on.length}</b> online · {c.friends.length} total
          </span>
        </div>
        <p className="label px-2 pt-3 pb-1">Online · {on.length}</p>
        <ul>
          {on.map((f) => (
            <FriendRow key={f.id} c={c} f={f} />
          ))}
        </ul>
        <p className="label px-2 pt-5 pb-1">Offline · {off.length}</p>
        <ul>
          {off.map((f) => (
            <FriendRow key={f.id} c={c} f={f} />
          ))}
        </ul>
      </section>

      <div className="space-y-6">
        <form onSubmit={submit} className="panel p-4">
          <h2 className="label">Add friend</h2>
          <div className="mt-3 flex gap-2">
            <input className="input" placeholder="Username#1234" value={name} onChange={(e) => setName(e.target.value)} aria-label="Friend username" />
            <button className="btn-gold shrink-0 px-3" aria-label="Send request">
              <Icon name="send" />
            </button>
          </div>
          {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-online' : 'text-foe'}`}>{msg.text}</p>}
        </form>

        <section className="panel p-4">
          <h2 className="label">Requests · {c.requestsIn.length + c.requestsOut.length}</h2>
          {c.requestsIn.length + c.requestsOut.length === 0 && <p className="mt-3 text-xs text-ink-400">No pending requests.</p>}
          <ul className="mt-2">
            {c.requestsIn.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2">
                <Avatar name={p.name} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="text-xs text-ink-400">Incoming request</p>
                </div>
                <button onClick={() => c.acceptRequest(p)} className="btn-ghost size-8 !p-0 text-online" aria-label={`Accept ${p.name}`}>
                  <Icon name="check" />
                </button>
                <button onClick={() => c.declineRequest(p)} className="btn-ghost size-8 !p-0 text-foe" aria-label={`Decline ${p.name}`}>
                  <Icon name="x" />
                </button>
              </li>
            ))}
            {c.requestsOut.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2">
                <Avatar name={p.name} size={36} dim />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="flex items-center gap-1.5 text-xs text-ink-400">
                    <span className="size-1.5 animate-pulse rounded-full bg-gold" /> Outgoing · pending
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
