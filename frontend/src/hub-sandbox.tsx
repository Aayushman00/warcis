/* Dev-only: the pre-matchmaking hub (Home, Friends, Party) on fake data, no backend. `npm run dev` -> /hub.html. Not linked from the app. */
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import type { HistoryItem } from './api'
import { MAX_PARTY, type Mode, type Player } from './data'
import { FriendsPage, FriendsSidebar, Home, PartyPage, type Ctx, type Party, type View } from './Hub'
import { Profile } from './Profile'
import { Logo } from './ui'

const ME: Player = { id: 'me', name: 'You', tag: '0001', status: 'online' }
const friend = (i: number, name: string, status: Player['status'], note?: string): Player => ({ id: `f${i}`, name, tag: String(1000 + i), status, note })
const FRIENDS = [
  friend(1, 'Rook', 'online'),
  friend(2, 'Zephyr', 'online'),
  friend(3, 'Calyx', 'away'),
  friend(4, 'Dusk', 'ingame', 'In Match · Squad'),
  friend(5, 'Morrow', 'offline', 'Last seen 2h ago'),
]
const hist = (i: number, outcome: 'WIN' | 'LOSS', mins: number, rival: string): HistoryItem => ({
  match_id: `m${i}`, mode: 'squad', played_at: new Date(Date.now() - mins * 60_000).toISOString(), outcome, my_team: 'RED',
  me: { kills: 8 - i, deaths: 3, captures: outcome === 'WIN' ? 2 : 0 }, winner: outcome === 'WIN' ? 'RED' : 'BLUE', scores: outcome === 'WIN' ? { RED: 3, BLUE: 2 } : { RED: 1, BLUE: 3 },
  capturer: null, duration_ms: 600_000, ended_at: null,
  players: [{ id: 'f1', name: 'Rook', team: 'RED' }, { id: 'x1', name: rival, team: 'BLUE' }, { id: 'x2', name: 'Vesper', team: 'BLUE' }] as HistoryItem['players'],
})
const HISTORY = [hist(1, 'WIN', 42, 'Nyx'), hist(2, 'WIN', 300, 'Ember'), hist(3, 'LOSS', 1500, 'Nyx')]
const STATS = { matches: 12, wins: 7, losses: 5, kills: 60, deaths: 48, captures: 9, kd: 1.25, win_rate: 0.58 }

const nav: { id: View; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'friends', label: 'Friends' },
  { id: 'party', label: 'Party' },
  { id: 'profile', label: 'Profile' },
]

function Sandbox() {
  const [view, setView] = useState<View>('home')
  const [mode, setMode] = useState<Mode>('squad')
  const [fill, setFill] = useState(true)
  const [party, setParty] = useState<Party>({ leaderId: 'me', members: [ME], pending: [] })
  const [requestsIn, setRequestsIn] = useState<Player[]>([{ ...friend(6, 'Kestrel', 'online'), requestId: 'r1' }])
  const [queued, setQueued] = useState(false)
  const [activity, setActivity] = useState([{ id: 1, text: 'Sandbox started · nothing is sent to the server', t: Date.now() }])
  const log = (text: string) => setActivity((a) => [{ id: Date.now(), text, t: Date.now() }, ...a])
  const debug = new URLSearchParams(location.search).has('debug')

  const inParty = (id: string) => party.members.some((m) => m.id === id) || party.pending.some((m) => m.id === id)
  const slotsUsed = party.members.length + party.pending.length
  const ctx: Ctx = {
    me: ME,
    friends: FRIENDS,
    requestsIn,
    requestsOut: [],
    party,
    mode,
    fill,
    activity,
    stats: { me: STATS },
    history: HISTORY,
    isLeader: party.leaderId === ME.id,
    slotsUsed,
    setView,
    setMode,
    setFill,
    canInvite: (f) => slotsUsed < MAX_PARTY && !inParty(f.id) && (f.status === 'online' || f.status === 'away'),
    inParty,
    // an invite is accepted at once, so the party fills up without a second client
    invite: (f) => (setParty((p) => ({ ...p, members: [...p.members, f] })), log(`${f.name} joined your party`)),
    cancelInvite: (id) => setParty((p) => ({ ...p, pending: p.pending.filter((m) => m.id !== id) })),
    kick: (id) => setParty((p) => ({ ...p, members: p.members.filter((m) => m.id !== id) })),
    leave: () => setParty({ leaderId: ME.id, members: [ME], pending: [] }),
    sendRequest: async (raw) => (raw.trim() ? (log(`Sent friend request to ${raw.trim()}`), null) : 'Enter a username.'),
    acceptRequest: (p) => (setRequestsIn((r) => r.filter((x) => x.id !== p.id)), log(`You and ${p.name} are now friends`)),
    declineRequest: (p) => setRequestsIn((r) => r.filter((x) => x.id !== p.id)),
    cancelQueue: () => setQueued(false),
    matchmake: () => (setQueued(true), log(`Entered queue (${party.members.length}/${MAX_PARTY})${fill ? '' : ', fill off'}`)),
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-ink-900/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 lg:px-6">
          <Logo className="shrink-0 max-sm:[&>span]:hidden" />
          <nav className="ml-2 flex gap-1" aria-label="Main">
            {nav.map((n) => (
              <button key={n.id} onClick={() => setView(n.id)} aria-current={view === n.id ? 'page' : undefined} className={`rounded px-3 py-2 text-sm ${view === n.id ? 'bg-white/[0.06] text-ink-100' : 'text-ink-400 hover:text-ink-100'}`}>
                {n.label}
              </button>
            ))}
          </nav>
          {debug && <span className="ml-auto text-xs text-ink-300">HUB SANDBOX · fake data · {queued ? 'queued (reload to reset)' : 'not queued'}</span>}
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[1440px] flex-1 gap-6 p-4 lg:p-6">
        <main className="min-w-0 flex-1">{view === 'friends' ? <FriendsPage {...ctx} /> : view === 'profile' ? <Profile me={ME} stats={STATS} /> : view === 'party' ? <PartyPage {...ctx} /> : <Home {...ctx} />}</main>
        {view !== 'friends' && (
          <aside className="hidden w-80 shrink-0 xl:block">
            <FriendsSidebar {...ctx} />
          </aside>
        )}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sandbox />
  </StrictMode>,
)
