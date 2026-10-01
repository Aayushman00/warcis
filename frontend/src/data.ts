export type Status = 'online' | 'away' | 'ingame' | 'offline'

export interface Player {
  id: string
  name: string
  tag: string
  status: Status
  note?: string // e.g. "In Match · Squad" or "Last seen 2h ago"
  requestId?: string // set on incoming friend requests
  inviteId?: string // set on pending party invites
}

export const MAX_PARTY = 4

export type Mode = 'squad'

export const MODES: { id: Mode | 'custom' | 'training'; name: string; blurb: string; locked?: boolean }[] = [
  { id: 'squad', name: 'Squad', blurb: 'Up to 4v4 · Queue with your party, fill in other players or lock your size' },
  { id: 'custom', name: 'Custom Lobby', blurb: 'Private lobbies', locked: true },
  { id: 'training', name: 'Training', blurb: 'Practice range', locked: true },
]

export const STATUS_LABEL: Record<Status, string> = {
  online: 'Online',
  away: 'Away',
  ingame: 'In Match',
  offline: 'Offline',
}

export const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? 'just now' : `${Math.round(s / 60)}m ago`
}
