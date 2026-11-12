import type { PlayerStats } from './api'
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

export type Mode = 'ctf' | 'tdm' | 'koth' | 'stale'

export const MODES: { id: Mode; name: string; short: string; blurb: string }[] = [
  { id: 'ctf', name: 'Capture the Flag', short: 'CTF', blurb: 'Steal the enemy flag and carry it home. First to 3 captures.' },
  { id: 'tdm', name: 'Team Deathmatch', short: 'TDM', blurb: 'No flags, just fights. First team to 40 kills.' },
  { id: 'koth', name: 'King of the Hill', short: 'KOTH', blurb: 'Hold the zone alone to score. It moves every 30 s. First to 100.' },
  { id: 'stale', name: 'Stale View', short: 'STALE', blurb: 'You see enemies as they were moments ago. Getting hurt freezes your view. Grab Sync, Spike theirs.' },
]
/** Display name for a server mode (CTF | TDM | KOTH | STALE; SQUAD = matches from before modes, all CTF). */
export const modeLabel = (m: string) => (MODES.find((x) => x.id === m.toLowerCase()) ?? MODES[0]).name

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

/** "3W–1L · 1.25 K/D", or null for a player who has not finished a match. */
export const statLine = (s?: PlayerStats) => (s && s.matches > 0 ? `${s.wins}W–${s.losses}L · ${s.kd.toFixed(2)} K/D` : null)
