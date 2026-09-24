import type { Player } from './data'

/** Every backend error has the shape {"error": {"code", "message"}} (see services/common/errors.py). */
export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// sessionStorage: survives refresh, but each tab is its own session so a multi-user demo works in one browser.
const KEY = 'arcline.token'
export const token = {
  get: () => {
    try {
      return sessionStorage.getItem(KEY)
    } catch {
      return null
    }
  },
  set: (t: string) => {
    try {
      sessionStorage.setItem(KEY, t)
    } catch {
      /* private mode: session lasts until reload */
    }
  },
  clear: () => {
    try {
      sessionStorage.removeItem(KEY)
    } catch {
      /* ignore */
    }
  },
}

let onUnauthorized = () => {}
export const setUnauthorizedHandler = (fn: () => void) => void (onUnauthorized = fn)

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const t = token.get()
  let r: Response
  try {
    r = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach ARCLINE servers.')
  }
  const data = r.status === 204 ? null : await r.json().catch(() => null)
  if (!r.ok) {
    const e = data?.error ?? {}
    if (r.status === 401 && t) onUnauthorized()
    throw new ApiError(r.status, e.code ?? 'ERROR', e.message ?? 'Request failed.')
  }
  return data as T
}

/* ─────────────── server DTOs ─────────────── */

export interface Session {
  token: string
  user: Player
}

export interface PartyDTO {
  id: string
  leader_id: string
  version: number
  max_size: number
  members: Player[]
  pending: { invite_id: string; user: Player }[]
}

export interface SocialState {
  friends: Player[]
  requests: { incoming: { id: string; user: Player }[]; outgoing: { id: string; user: Player }[] }
  party: PartyDTO | null
  invitations: { id: string; from: Player; party: { id: string; size: number; leader_id: string } }[]
}

export type QPlayer = { id: string; name: string; tag: string }
export interface TeamDTO {
  players: QPlayer[]
  parties: { party_id: string; players: string[] }[]
}
export interface MatchDTO {
  match_id: string
  mode: 'SQUAD' | 'RANDOM'
  status: string
  created_at: string
  teams: TeamDTO[]
  my_team: number
  ready: string[]
  entered: string[]
}
export type QueueDTO = {
  mode: 'SQUAD' | 'RANDOM'
  party_id: string
  leader_id: string
  size: number
  joined_at: string
  players_in_queue: number
  team: TeamDTO
}
export type MMStatus =
  | { state: 'idle'; notice?: string | null }
  | { state: 'searching'; queue: QueueDTO }
  | { state: 'found'; match: MatchDTO }
  | { state: 'entered'; match: MatchDTO }
