/* Dev-only: the match lobby on fake data, no backend. `npm run dev` -> /lobby.html. Not linked from the app. */
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import type { Loadout, MatchDTO, MMStatus, QPlayer } from './api'
import type { Player } from './data'
import { CLASS_IDS, WEAPON_IDS } from './game/classes'
import { Matchmaking } from './Matchmaking'

const ME: Player = { id: 'me', name: 'You', tag: '0001', status: 'online' }
const names = ['You', 'Rook', 'Zephyr', 'Calyx', 'Dusk', 'Morrow', 'Kestrel', 'Nimbus']
const players: QPlayer[] = names.map((name, i) => ({ id: i ? `p${i}` : 'me', name, tag: String(1000 + i) }))
const mates = players.slice(1, 4)
const foes = players.slice(4)
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]
const inSecs = (s: number) => new Date(Date.now() + s * 1000).toISOString()

// Teams: you + Rook as one party, the rest solo; the enemy has a duo. Edit freely.
const teams = [
  { players: players.slice(0, 4), parties: [{ party_id: 'a', players: ['me', 'p1'] }, { party_id: 'b', players: ['p2'] }, { party_id: 'c', players: ['p3'] }] },
  { players: foes, parties: [{ party_id: 'd', players: ['p4', 'p5'] }, { party_id: 'e', players: ['p6'] }, { party_id: 'f', players: ['p7'] }] },
]

const fresh = (): MatchDTO => ({
  match_id: `sandbox-${Date.now()}`, // new id replays the "match found" reveal
  mode: 'SQUAD',
  status: 'FOUND',
  created_at: new Date().toISOString(),
  teams,
  my_team: 0,
  ready: [],
  entered: [],
  loadouts: {},
  lobby_ends_at: inSecs(60),
  countdown_ends_at: null,
  result: null,
})

function Sandbox() {
  const [phase, setPhase] = useState<'searching' | 'lobby'>('lobby')
  const [match, setMatch] = useState(fresh)
  const patch = (p: Partial<MatchDTO>) => setMatch((m) => ({ ...m, ...p }))

  const status: Exclude<MMStatus, { state: 'idle' }> =
    phase === 'searching'
      ? {
          state: 'searching',
          queue: { mode: 'SQUAD', fill: true, party_id: 'a', leader_id: 'me', size: 2, joined_at: inSecs(-12), players_in_queue: 5, team: { ...teams[0], players: players.slice(0, 2), parties: [teams[0].parties[0]] } },
        }
      : { state: match.status === 'COUNTDOWN' ? 'countdown' : 'found', match }

  // The bots' ready + loadouts, for your allies and the enemy (what the server would fill in).
  const botsReady = () =>
    setMatch((m) => ({
      ...m,
      ready: [...new Set([...m.ready, ...[...mates, ...foes].map((p) => p.id)])],
      loadouts: { ...m.loadouts, ...Object.fromEntries(mates.map((p) => [p.id, { class: pick(CLASS_IDS), weapon: pick(WEAPON_IDS) } as Loadout])) },
    }))
  const startCountdown = () => patch({ status: 'COUNTDOWN', countdown_ends_at: inSecs(5), lobby_ends_at: null })

  const btn = 'rounded border border-ink-600 px-3 py-1 text-sm text-ink-100 hover:bg-ink-700'
  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-900 px-4 py-2">
        <b className="font-display tracking-wider text-gold">LOBBY SANDBOX</b>
        <button className={btn} onClick={() => setPhase('searching')}>Searching</button>
        <button className={btn} onClick={() => setPhase('lobby')}>Lobby</button>
        <button className={btn} onClick={botsReady}>Bots ready</button>
        <button className={btn} onClick={startCountdown}>Countdown (5s)</button>
        <button className={btn} onClick={() => { setMatch(fresh()); setPhase('lobby') }}>Reset</button>
        <span className="text-xs text-ink-400">fake data · nothing is sent to the server</span>
      </div>
      <Matchmaking
        status={status}
        me={ME}
        rematch={{ canQueue: true, leaderName: null, onQueue: () => {} }}
        onCancel={() => setPhase('lobby')}
        onReady={() => patch({ ready: [...new Set([...match.ready, ME.id])] })}
        onLoadout={(_, l) => setMatch((m) => ({ ...m, loadouts: { ...m.loadouts, [ME.id]: l } }))}
        onExit={() => setMatch(fresh())}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sandbox />
  </StrictMode>,
)
