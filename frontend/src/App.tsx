import { useCallback, useEffect, useRef, useState } from 'react'
import { api, setUnauthorizedHandler, token, type MMStatus, type PartyDTO, type SocialState } from './api'
import { Auth } from './Auth'
import { MAX_PARTY, type Mode, type Player, type Status } from './data'
import { FriendsPage, FriendsSidebar, Home, PartyPage, type Ctx, type Party, type View } from './Hub'
import { Matchmaking } from './Matchmaking'
import { Avatar, AvatarStatus, Icon, Logo, StatusDot } from './ui'

const POLL_MS = 1500 // ponytail: HTTP polling for social + queue state; move to SSE/WebSocket when load matters
const HEARTBEAT_MS = 10_000

export default function App() {
  const [me, setMe] = useState<Player | null>(null)
  const [booting, setBooting] = useState(() => !!token.get())

  // Restore the session from the stored JWT so a refresh lands back in the hub.
  useEffect(() => {
    setUnauthorizedHandler(() => (token.clear(), setMe(null)))
    if (!token.get()) return
    api<Player>('/users/me')
      .then(setMe)
      .catch(() => token.clear())
      .finally(() => setBooting(false))
  }, [])

  if (booting)
    return (
      <div className="grid h-full place-items-center">
        <Logo className="animate-pulse" />
      </div>
    )
  return me ? (
    <Launcher me={me} setMe={setMe} />
  ) : (
    <Auth
      onAuth={(s) => {
        token.set(s.token)
        setMe(s.user)
      }}
    />
  )
}

const soloParty = (me: Player): Party => ({ leaderId: me.id, members: [me], pending: [] })
const toParty = (p: PartyDTO | null, me: Player): Party =>
  p ? { leaderId: p.leader_id, members: p.members, pending: p.pending.map((x) => ({ ...x.user, inviteId: x.invite_id })) } : soloParty(me)

function Launcher({ me, setMe }: { me: Player; setMe: (p: Player | null) => void }) {
  const [view, setView] = useState<View>('home')
  const [social, setSocial] = useState<SocialState | null>(null)
  const [mm, setMm] = useState<MMStatus>({ state: 'idle' })
  const [mode, setMode] = useState<Mode>('squad')
  const [activity, setActivity] = useState(() => [{ id: 0, text: 'Signed in to WARCIS', t: Date.now() }])
  const [toast, setToast] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const prev = useRef<SocialState | null>(null)
  const lastNotice = useRef<string | null>(null)

  const log = (text: string) => setActivity((a) => [{ id: Date.now() + Math.random(), text, t: Date.now() }, ...a].slice(0, 6))
  const fail = (e: unknown) => setToast((e as Error).message)

  const refresh = useCallback(async () => {
    const [s, m] = await Promise.all([api<SocialState>('/social/state'), api<MMStatus>('/matchmaking/status')])
    setSocial(s)
    setMm(m)
    const notice = m.state === 'idle' ? (m.notice ?? null) : null
    if (notice && notice !== lastNotice.current) setToast(notice)
    lastNotice.current = notice
  }, [])

  useEffect(() => {
    const tick = () => void refresh().catch(() => {})
    const beat = () => void api<Player>('/users/me/heartbeat', { method: 'POST' }).then(setMe).catch(() => {})
    tick()
    beat()
    const a = setInterval(tick, POLL_MS)
    const b = setInterval(beat, HEARTBEAT_MS)
    return () => (clearInterval(a), clearInterval(b))
  }, [refresh, setMe])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  // Turn server-side changes seen by polling into activity entries.
  useEffect(() => {
    const before = prev.current
    prev.current = social
    if (!before || !social) return
    const was = new Set(before.party?.members.map((m) => m.id) ?? [])
    const is = new Set(social.party?.members.map((m) => m.id) ?? [])
    if (before.party?.id === social.party?.id) {
      social.party?.members.filter((m) => !was.has(m.id) && m.id !== me.id).forEach((m) => log(`${m.name} joined the party`))
      before.party?.members.filter((m) => !is.has(m.id) && m.id !== me.id).forEach((m) => log(`${m.name} left the party`))
    }
    const knew = new Set(before.friends.map((f) => f.id))
    social.friends.filter((f) => !knew.has(f.id)).forEach((f) => log(`You and ${f.name} are now friends`))
  }, [social, me.id])

  /** Run a mutation, then re-sync from the server. Errors surface in the toast. */
  const act = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn()
      if (success) log(success)
    } catch (e) {
      fail(e)
    }
    await refresh().catch(() => {})
  }

  const friends = social?.friends ?? []
  const requestsIn = (social?.requests.incoming ?? []).map((r) => ({ ...r.user, requestId: r.id }))
  const requestsOut = (social?.requests.outgoing ?? []).map((r) => r.user)
  const party = toParty(social?.party ?? null, me)
  const partyInvite = social?.invitations[0] ?? null
  const queueing = mm.state !== 'idle'

  const isLeader = party.leaderId === me.id
  const slotsUsed = party.members.length + party.pending.length
  const inParty = (id: string) => party.members.some((m) => m.id === id) || party.pending.some((m) => m.id === id)
  const canInvite = (f: Player) => !queueing && slotsUsed < MAX_PARTY && !inParty(f.id) && (f.status === 'online' || f.status === 'away')

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
    invite: (f) => act(() => api('/social/party/invitations', { method: 'POST', body: { user_id: f.id } }), `Invited ${f.name} to your party`),
    cancelInvite: (userId) => {
      const inv = party.pending.find((p) => p.id === userId)
      if (inv?.inviteId) act(() => api(`/social/party/invitations/${inv.inviteId}`, { method: 'DELETE' }))
    },
    kick: (id) => {
      const m = party.members.find((x) => x.id === id)
      act(() => api(`/social/party/members/${id}`, { method: 'DELETE' }), m && `Removed ${m.name} from the party`)
    },
    leave: () => act(() => api('/social/party/leave', { method: 'POST' }), 'Left the party'),
    sendRequest: async (raw) => {
      if (!raw.trim()) return 'Enter a username.'
      try {
        const r = await api<{ status: string; user: Player }>('/social/friend-requests', { method: 'POST', body: { username: raw.trim() } })
        log(r.status === 'accepted' ? `You and ${r.user.name} are now friends` : `Sent friend request to ${r.user.name}`)
        await refresh()
        return null
      } catch (e) {
        return (e as Error).message
      }
    },
    acceptRequest: (p) => act(() => api(`/social/friend-requests/${p.requestId}/accept`, { method: 'POST' })),
    declineRequest: (p) => act(() => api(`/social/friend-requests/${p.requestId}/reject`, { method: 'POST' })),
    matchmake: () =>
      act(
        () => api('/matchmaking/queue', { method: 'POST', body: { mode } }),
        `Entered ${mode === 'squad' ? 'Squad' : 'Random'} queue (${party.members.length}/${MAX_PARTY})`,
      ),
  }

  const joinInvite = async () => {
    if (!partyInvite) return
    await act(() => api(`/social/invitations/${partyInvite.id}/accept`, { method: 'POST' }), `Joined ${partyInvite.from.name}'s party`)
    setView('party')
  }

  const setStatus = async (status: Status) => {
    setMenu(false)
    try {
      setMe(await api<Player>('/users/me', { method: 'PATCH', body: { status } }))
    } catch (e) {
      fail(e)
    }
  }

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    token.clear()
    setMe(null)
  }

  const online = friends.filter((f) => f.status !== 'offline').length
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
                  <button onClick={signOut} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foe hover:bg-white/5">
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
          {mm.state !== 'idle' ? (
            <Matchmaking
              status={mm}
              me={me}
              onCancel={() => act(() => api('/matchmaking/queue', { method: 'DELETE' }), 'Left matchmaking queue')}
              onReady={(id) => act(() => api(`/matchmaking/matches/${id}/ready`, { method: 'POST' }))}
              onEnter={(id) => act(() => api(`/matchmaking/matches/${id}/enter`, { method: 'POST' }))}
              onExit={(id) => act(() => api(`/matchmaking/matches/${id}/leave`, { method: 'POST' }), 'Match completed · returned to hub')}
            />
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
                {partyInvite.party.size}/{MAX_PARTY} · Squad
                {party.members.length > 1 && ' · you will leave your current party'}
              </p>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={joinInvite} className="btn-gold flex-1">
              Join
            </button>
            <button onClick={() => act(() => api(`/social/invitations/${partyInvite.id}/decline`, { method: 'POST' }))} className="btn-ghost flex-1">
              Decline
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div role="alert" className="panel fixed bottom-4 left-4 z-50 flex max-w-[min(24rem,calc(100vw-2rem))] animate-rise items-center gap-3 border-foe/40 bg-ink-800 px-4 py-3 text-sm shadow-2xl">
          <span className="size-2 shrink-0 rounded-full bg-foe" />
          <span>{toast}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="ml-auto text-ink-400 hover:text-ink-100">
            <Icon name="x" />
          </button>
        </div>
      )}
    </div>
  )
}
