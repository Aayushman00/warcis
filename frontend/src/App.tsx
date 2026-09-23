import { useEffect, useRef, useState } from 'react'
import { Auth } from './Auth'
import { initialFriends, initialRequests, MAX_PARTY, mkPlayer, type Mode, type Player, type Status } from './data'
import { FriendsPage, FriendsSidebar, Home, PartyPage, type Ctx, type Party, type View } from './Hub'
import { Matchmaking } from './Matchmaking'
import { Avatar, AvatarStatus, Icon, Logo, StatusDot } from './ui'

export default function App() {
  const [me, setMe] = useState<Player | null>(null)
  return me ? <Launcher me={me} setMe={setMe} /> : <Auth onAuth={(name) => setMe(mkPlayer(name))} />
}

function Launcher({ me, setMe }: { me: Player; setMe: (p: Player | null) => void }) {
  const [view, setView] = useState<View>('home')
  const [friends, setFriends] = useState(initialFriends)
  const [requestsIn, setRequestsIn] = useState(initialRequests)
  const [requestsOut, setRequestsOut] = useState<Player[]>([])
  const [party, setParty] = useState<Party>({ leaderId: me.id, members: [me], pending: [] })
  const [mode, setMode] = useState<Mode>('squad')
  const [queue, setQueue] = useState<'idle' | 'searching'>('idle')
  const [activity, setActivity] = useState([{ id: 0, text: 'Signed in to ARCLINE', t: Date.now() }])
  const [partyInvite, setPartyInvite] = useState<{ from: Player; members: Player[] } | null>(null)
  const [menu, setMenu] = useState(false)
  const timers = useRef<number[]>([])
  const partyRef = useRef(party)
  partyRef.current = party

  // ponytail: fire-and-forget timers stand in for server events; cleared on sign-out/unmount.
  const later = (ms: number, fn: () => void) => void timers.current.push(window.setTimeout(fn, ms))
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const log = (text: string) => setActivity((a) => [{ id: Date.now() + Math.random(), text, t: Date.now() }, ...a].slice(0, 6))

  // A friend invites you to their party a few seconds after sign-in, to demo "join party".
  useEffect(() => {
    const t = setTimeout(() => {
      const vesper = friends.find((f) => f.name === 'Vesper')!
      if (partyRef.current.members.some((m) => m.id === vesper.id)) return
      setPartyInvite({ from: vesper, members: [vesper, mkPlayer('Rook')] })
    }, 9000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isLeader = party.leaderId === me.id
  const slotsUsed = party.members.length + party.pending.length
  const inParty = (id: string) => party.members.some((m) => m.id === id) || party.pending.some((m) => m.id === id)

  const canInvite = (f: Player) =>
    queue === 'idle' && slotsUsed < MAX_PARTY && !inParty(f.id) && (f.status === 'online' || f.status === 'away')

  const invite = (f: Player) => {
    if (!canInvite(f)) return
    setParty((p) => ({ ...p, pending: [...p.pending, f] }))
    log(`Invited ${f.name} to your party`)
    later(f.status === 'away' ? 3200 : 1600, () => {
      if (!partyRef.current.pending.some((x) => x.id === f.id)) return // cancelled or party changed meanwhile
      setParty((p) => ({ ...p, pending: p.pending.filter((x) => x.id !== f.id), members: [...p.members, f] }))
      log(`${f.name} joined the party`)
    })
  }

  const ctx: Ctx = {
    me,
    friends,
    requestsIn,
    requestsOut,
    party,
    mode,
    activity,
    isLeader,
    slotsUsed,
    setView,
    setMode,
    canInvite,
    inParty,
    invite,
    cancelInvite: (id) => setParty((p) => ({ ...p, pending: p.pending.filter((x) => x.id !== id) })),
    kick: (id) => {
      const m = party.members.find((x) => x.id === id)
      setParty((p) => ({ ...p, members: p.members.filter((x) => x.id !== id) }))
      if (m) log(`Removed ${m.name} from the party`)
    },
    leave: () => {
      setParty({ leaderId: me.id, members: [me], pending: [] })
      log('Left the party')
    },
    sendRequest: (raw) => {
      const name = raw.trim().replace(/#\d+$/, '')
      const taken = [me, ...friends, ...requestsOut, ...requestsIn].some((p) => p.name.toLowerCase() === name.toLowerCase())
      if (!name) return 'Enter a username.'
      if (taken) return `${name} is already in your list.`
      const p = mkPlayer(name)
      setRequestsOut((r) => [...r, p])
      log(`Sent friend request to ${name}`)
      later(4000, () => {
        setRequestsOut((r) => r.filter((x) => x.id !== p.id))
        setFriends((f) => [p, ...f])
        log(`${name} accepted your friend request`)
      })
      return null
    },
    acceptRequest: (p) => {
      setRequestsIn((r) => r.filter((x) => x.id !== p.id))
      setFriends((f) => [p, ...f])
      log(`You and ${p.name} are now friends`)
    },
    declineRequest: (p) => setRequestsIn((r) => r.filter((x) => x.id !== p.id)),
    matchmake: () => {
      if (!isLeader || party.pending.length) return
      setQueue('searching')
      log(`Entered ${mode === 'squad' ? 'Squad' : 'Random'} queue (${party.members.length}/${MAX_PARTY})`)
    },
  }

  const joinInvite = () => {
    if (!partyInvite) return
    setParty({ leaderId: partyInvite.from.id, members: [...partyInvite.members, me], pending: [] })
    log(`Joined ${partyInvite.from.name}'s party`)
    setPartyInvite(null)
    setView('party')
  }

  const setStatus = (status: Status) => {
    setMe({ ...me, status })
    setMenu(false)
  }

  const online = friends.filter((f) => f.status !== 'offline').length
  const queueing = queue !== 'idle'
  const nav: { id: View; label: string; icon: 'home' | 'users' | 'party'; badge?: string }[] = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'friends', label: 'Friends', icon: 'users', badge: requestsIn.length ? String(requestsIn.length) : undefined },
    { id: 'party', label: 'Party', icon: 'party', badge: `${party.members.length}/${MAX_PARTY}` },
  ]

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-ink-900/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 lg:px-6">
          <Logo className="shrink-0 max-sm:[&>span]:hidden" />
          <nav className="ml-2 flex gap-1" aria-label="Main">
            {nav.map((n) => (
              <button
                key={n.id}
                disabled={queueing}
                onClick={() => setView(n.id)}
                aria-current={view === n.id ? 'page' : undefined}
                className={`relative flex items-center gap-2 rounded-lg px-3 py-2 font-display text-sm font-semibold tracking-wider uppercase transition disabled:opacity-40 ${
                  view === n.id && !queueing ? 'bg-white/[0.06] text-ink-100' : 'text-ink-400 hover:text-ink-100'
                }`}
              >
                <Icon name={n.icon} />
                <span className="max-sm:hidden">{n.label}</span>
                {n.badge && (
                  <span className={`rounded px-1.5 text-[10px] ${n.id === 'friends' ? 'bg-foe text-white' : 'bg-white/10 text-ink-300'}`}>
                    {n.badge}
                  </span>
                )}
                {view === n.id && !queueing && <span className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded bg-gold" />}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <button onClick={() => !queueing && setView('friends')} className="hidden items-center gap-2 text-sm text-ink-300 hover:text-ink-100 md:flex">
              <Icon name="users" />
              <span>
                <b className="text-online">{online}</b> online
              </span>
            </button>
            <div className="relative">
              <button onClick={() => setMenu(!menu)} className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.03] py-1 pr-3 pl-1 hover:bg-white/[0.06]">
                <AvatarStatus name={me.name} status={me.status} size={32} />
                <span className="text-left leading-tight max-sm:hidden">
                  <span className="block text-sm font-semibold">{me.name}</span>
                  <span className="block text-[11px] text-ink-400">
                    {me.status === 'away' ? 'Away' : 'Online'} · #{me.tag}
                  </span>
                </span>
              </button>
              {menu && (
                <div className="panel absolute right-0 mt-2 w-48 animate-rise bg-ink-800 p-1.5 shadow-2xl">
                  {(['online', 'away'] as const).map((s) => (
                    <button key={s} onClick={() => setStatus(s)} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-white/5">
                      <StatusDot status={s} /> {s === 'online' ? 'Online' : 'Away'}
                      {me.status === s && <Icon name="check" className="ml-auto size-4 text-ink-300" />}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-white/5" />
                  <button onClick={() => setMe(null)} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foe hover:bg-white/5">
                    <Icon name="logout" /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1440px] flex-1 gap-6 p-4 lg:p-6">
        <main className="min-w-0 flex-1">
          {queueing ? (
            <Matchmaking party={party} mode={mode} me={me} onCancel={() => (setQueue('idle'), log('Left matchmaking queue'))} onExit={() => (setQueue('idle'), log('Match completed · returned to hub'))} />
          ) : view === 'home' ? (
            <Home {...ctx} />
          ) : view === 'friends' ? (
            <FriendsPage {...ctx} />
          ) : (
            <PartyPage {...ctx} />
          )}
        </main>
        {!queueing && view !== 'friends' && (
          <aside className="hidden w-80 shrink-0 xl:block">
            <FriendsSidebar {...ctx} />
          </aside>
        )}
      </div>

      {partyInvite && !queueing && (
        <div role="status" className="panel fixed right-4 bottom-4 z-40 w-[min(22rem,calc(100vw-2rem))] animate-rise bg-ink-800 p-4 shadow-2xl">
          <p className="label !text-gold">Party invite</p>
          <div className="mt-3 flex items-center gap-3">
            <Avatar name={partyInvite.from.name} size={44} />
            <div className="min-w-0 text-sm">
              <p>
                <b>{partyInvite.from.name}</b> invited you to their party
              </p>
              <p className="text-ink-400">
                {partyInvite.members.length}/{MAX_PARTY} · Squad
                {party.members.length > 1 && ' · you will leave your current party'}
              </p>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={joinInvite} className="btn-gold flex-1">
              Join
            </button>
            <button onClick={() => setPartyInvite(null)} className="btn-ghost flex-1">
              Decline
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
