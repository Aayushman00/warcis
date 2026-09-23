export type Status = 'online' | 'away' | 'ingame' | 'offline'

export interface Player {
  id: string
  name: string
  tag: string
  status: Status
  note?: string // e.g. "In Match · Squad" or "Last seen 2h ago"
}

export const MAX_PARTY = 4

export type Mode = 'squad' | 'random'

export const MODES: { id: Mode | 'custom' | 'training'; name: string; blurb: string; locked?: boolean }[] = [
  { id: 'squad', name: 'Squad', blurb: '4v4 · Party stays together, open slots fill from queue' },
  { id: 'random', name: 'Random', blurb: '4v4 · Solo queue, teams assembled at random' },
  { id: 'custom', name: 'Custom Lobby', blurb: 'Private lobbies', locked: true },
  { id: 'training', name: 'Training', blurb: 'Practice range', locked: true },
]

export const STATUS_LABEL: Record<Status, string> = {
  online: 'Online',
  away: 'Away',
  ingame: 'In Match',
  offline: 'Offline',
}

let seq = 0
export const mkPlayer = (name: string, status: Status = 'online', note?: string): Player => ({
  id: `p${++seq}`,
  name,
  tag: String(1000 + ((name.length * 7919 + name.charCodeAt(0) * 131) % 9000)),
  status,
  note,
})

export const initialFriends = (): Player[] => [
  mkPlayer('Vesper', 'online'),
  mkPlayer('kaiRo', 'online'),
  mkPlayer('mira.exe', 'away'),
  mkPlayer('Thorne', 'ingame', 'In Match · Squad · 12:40'),
  mkPlayer('LumenFox', 'online'),
  mkPlayer('b1tRunner', 'ingame', 'In Match · Random · 03:12'),
  mkPlayer('Oskar', 'offline', 'Last seen 2h ago'),
  mkPlayer('Sable', 'offline', 'Last seen yesterday'),
  mkPlayer('Halloran', 'offline', 'Last seen 5d ago'),
]

export const initialRequests = (): Player[] => [mkPlayer('Quillon', 'online'), mkPlayer('ashveil', 'away')]

const POOL = [
  'Nocturne', 'Rook', 'zephyr_', 'Calyx', 'Ironwren', 'Pax', 'Dusk', 'Morrow', 'Kestrel', 'Nimbus',
  'Tallis', 'Orrin', 'Vex', 'saltmoth', 'Juno', 'Brask', 'Ember', 'Lio', 'Wick', 'Solenne', 'Grit', 'Ferro',
]

/** Split n players into random party sizes, e.g. 3 → [2,1]. */
export function randomPartition(n: number): number[] {
  const out: number[] = []
  while (n > 0) {
    const s = 1 + Math.floor(Math.random() * n)
    out.push(s)
    n -= s
  }
  return out
}

/** Draw `count` strangers from the queue pool, excluding names already used. */
export function strangers(count: number, used: Set<string>): Player[] {
  const free = POOL.filter((n) => !used.has(n)).sort(() => Math.random() - 0.5)
  return free.slice(0, count).map((n) => {
    used.add(n)
    return mkPlayer(n)
  })
}

export const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? 'just now' : `${Math.round(s / 60)}m ago`
}
