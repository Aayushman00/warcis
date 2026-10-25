import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { token, type ClassId, type DecidedBy, type MatchDTO, type WeaponId } from './api'
import type { Player } from './data'
import './game/hud.css'
import { Renderer, Timeline, type GMap, type Snapshot } from './game/render'
import { isMuted, setMuted, sfx, unlockAudio } from './game/sfx'
import { color, cssVars, other, type Team } from './game/tokens'
import { ClassAvatar } from './Loadout'
import { Scoreboard, type ScoreRow } from './Scoreboard'
import { TouchControls, type TouchApi } from './game/TouchControls'

/* In-match client. The server (services/game-service) is authoritative: this component
   sends intents (held keys, aim point), renders interpolated snapshots on the canvas, and
   turns snapshot changes into HUD feedback. React only re-renders when HUD data changes;
   per-frame numbers (clock, respawn ring) are written straight to the DOM. */

/** Numbers the server sends once in `hello`; the HUD only draws them (cooldown rings), the server enforces them. */
type Catalog = { classes: Record<ClassId, { hp: number; ability: string; cooldownMs: number; durationMs: number }> }
type Msg = Snapshot | { t: 'hello'; you: string; map: GMap; catalog: Catalog } | { t: 'error'; code: string; message: string } | { t: 'pong'; c: number }
type Who = { name: string; team: Team }
type FlagHud = { state: 'AT_BASE' | 'CARRIED' | 'DROPPED'; carrier: Who | null; returnAt: number | null }
type Hud = {
  me: (Who & { hp: number; maxHp: number; cls: ClassId; weapon: WeaponId; alive: boolean; carrying: boolean; killer: Who | null }) | null
  roster: Record<Team, { id: string; alive: boolean; connected: boolean }[]>
  flags: Record<Team, FlagHud>
  ended: boolean
  winner: Team | null // ended with no winner = draw
  decidedBy: DecidedBy | null
  progress: Record<Team, number>
  suddenDeath: boolean // no respawns, next capture wins
  capturer: Who | null // whoever scored the last round
  rows: ScoreRow[] // kills / deaths / captures of everyone, live (final screen)
  scores: Record<Team, number>
  round: number
  matchMs: number
  intermission: { winner: Team; capturer: Who | null } | null // between rounds: sim frozen until resumesAt
  board: Row[] // same players with the server rating (hold-TAB board)
  at?: number // server time this HUD state was taken (not part of the change key)
}
type Row = { id: string; name: string; team: Team; captures: number; kills: number; deaths: number; rating: number; me: boolean }
type Banner = { id: number; title: string; sub: string; team: Team }
type Kill = { id: number; killer: Who | null; victim: Who; mine: boolean }

const KEYS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}
const isTouch = () => new URLSearchParams(location.search).has('touch') || !!window.matchMedia?.('(pointer: coarse)').matches // ?touch forces it on desktop for testing
const RECONNECT_FOR_MS = 60_000
const PING_EVERY_MS = 2000
const FIRE_SEND_MS = 20
const INTRO_IF_YOUNGER_MS = 15_000
const tc = (t: Team) => (t === 'RED' ? 'g-red' : 'g-blue')
const KICKER: Record<DecidedBy, string> = {
  ROUNDS: 'Match over',
  SCORE: 'Time is up',
  SUDDEN_DEATH: 'Sudden death capture',
  OBJECTIVE: 'Decided on objective progress',
  KILLS: 'Objective level, decided on kills',
  DRAW: 'Objective and kills level',
}
const kicker = (by: DecidedBy | null, hasWinner: boolean) => (by ? KICKER[by] : hasWinner ? 'Match over' : 'Time is up, scores are level') // null: stored before sudden death existed
/** The numbers behind a 12:00 tiebreak, so a win on progress or kills is not a mystery. */
function tiebreakLine(f: { decidedBy: DecidedBy | null; progress: Record<Team, number>; rows: { team: Team; kills: number }[] }) {
  if (f.decidedBy !== 'OBJECTIVE' && f.decidedBy !== 'KILLS' && f.decidedBy !== 'DRAW') return null
  const kills = (t: Team) => f.rows.filter((r) => r.team === t).reduce((n, r) => n + r.kills, 0)
  return (
    <span className="g-result-by">
      Flag carried <span className="g-blue">{f.progress.BLUE}%</span> vs <span className="g-red">{f.progress.RED}%</span> of the way home · kills{' '}
      <span className="g-blue">{kills('BLUE')}</span> vs <span className="g-red">{kills('RED')}</span>
    </span>
  )
}
const cap = (t: Team) => t[0] + t.slice(1).toLowerCase()
const ROUNDS_TO_WIN = 3 // mirrors game-service sim.ROUNDS_TO_WIN, display only
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/* Everyone plays as BLUE on the left. Server: team 0 = RED left, team 1 = BLUE right, map
   mirrored left/right (sim.py WALLS). So team 0 only swaps colors; team 1 only mirrors x
   (and mirrors left/right + aim back on the way out). The server never knows. */
type View = { mirror: boolean; swap: boolean }
const viewOf = (myTeam: number): View => ({ mirror: myTeam === 1, swap: myTeam === 0 })
function viewMap(m: GMap, v: View): GMap {
  const t = (x: Team) => (v.swap ? other(x) : x)
  const x = (x: number) => (v.mirror ? m.w - x : x)
  return {
    ...m,
    walls: v.mirror ? m.walls.map(([wx, y, w, h]) => [m.w - wx - w, y, w, h]) : m.walls,
    bases: m.bases.map((b) => ({ ...b, team: t(b.team), x: x(b.x) })),
    spawns: m.spawns.map((s) => ({ ...s, team: t(s.team), x: x(s.x) })),
  }
}
function viewSnap(s: Snapshot, w: number, v: View): Snapshot {
  const t = (x: Team) => (v.swap ? other(x) : x)
  const x = (x: number) => (v.mirror ? w - x : x)
  return {
    ...s,
    winner: s.winner && t(s.winner),
    roundWinner: s.roundWinner && t(s.roundWinner),
    scores: v.swap ? { RED: s.scores.BLUE, BLUE: s.scores.RED } : s.scores,
    progress: v.swap ? { RED: s.progress.BLUE, BLUE: s.progress.RED } : s.progress,
    players: s.players.map((p) => ({ ...p, team: t(p.team), x: p.x === null ? null : x(p.x) })),
    flags: s.flags.map((f) => ({ ...f, team: t(f.team), x: x(f.x) })),
    shots: s.shots.map((o) => ({ ...o, team: t(o.team), x: x(o.x) })),
    barriers: s.barriers.map((b) => ({ ...b, team: t(b.team), x: v.mirror ? w - b.x - b.w : b.x })), // x is the slab's left edge
  }
}

function hudOf(s: Snapshot, meId: string): Hud {
  const byId = new Map(s.players.map((p) => [p.id, p]))
  const who = (id: string | null): Who | null => {
    const p = id ? byId.get(id) : null
    return p ? { name: p.name, team: p.team } : null
  }
  const m = byId.get(meId)
  const roster = { RED: [], BLUE: [] } as Hud['roster']
  for (const p of s.players) roster[p.team].push({ id: p.id, alive: p.alive, connected: p.connected })
  const flag = (t: Team): FlagHud => {
    const f = s.flags.find((x) => x.team === t)!
    return { state: f.state, carrier: who(f.carrierId), returnAt: f.returnAt }
  }
  return {
    me: m ? { name: m.name, team: m.team, hp: m.hp, maxHp: m.maxHp, cls: m.class, weapon: m.weapon, alive: m.alive, carrying: m.carryingFlag, killer: m.alive ? null : who(m.killedBy) } : null,
    roster,
    flags: { RED: flag('RED'), BLUE: flag('BLUE') },
    ended: s.state === 'ENDED',
    winner: s.winner,
    decidedBy: s.decidedBy,
    progress: s.progress,
    suddenDeath: s.suddenDeath,
    capturer: who(s.capturer),
    rows: s.players.map((p) => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, captures: p.captures, cls: p.class })),
    scores: s.scores,
    round: s.round,
    matchMs: s.matchMs,
    intermission: s.resumesAt && s.roundWinner ? { winner: s.roundWinner, capturer: who(s.capturer) } : null,
    board: s.players.map((p) => ({ id: p.id, name: p.name, team: p.team, captures: p.captures, kills: p.kills, deaths: p.deaths, rating: p.rating, me: p.id === meId })),
  }
}

/* ─────────────── icons ─────────────── */

const FlagIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M3 1.5h1.5V15H3z" />
    <path d="M4.5 2h8.5l-2.2 3.2L13 8.5H4.5z" />
  </svg>
)
const Crosshair = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <circle cx="8" cy="8" r="4.5" />
    <path d="M8 1v3M8 12v3M1 8h3M12 8h3" strokeLinecap="round" />
  </svg>
)
const ArrowHome = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M8 1.5 14 7.5h-3.5V14h-5V7.5H2z" />
  </svg>
)
const Alert = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M8 1 15 14H1zM7.2 6v4h1.6V6zm0 5.2v1.6h1.6v-1.6z" />
  </svg>
)
const Speaker = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 8v4h3l4 3.5v-11L6 8z" fill="currentColor" stroke="none" />
    {off ? <path d="M13.5 7.5l5 5m0-5l-5 5" /> : <path d="M13.5 7a4 4 0 0 1 0 6M15.8 4.8a7 7 0 0 1 0 10.4" />}
  </svg>
)

const BoardIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
    <path d="M4 5h12M4 10h12M4 15h12" />
  </svg>
)
const FullscreenIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />
  </svg>
)

/* Blue (always my team in this view) above red. Rank = position by the server's rating
   (2*captures + K/D) across both teams; rows within a team are in rank order. */
function Board({ rows, compact }: { rows: Row[]; compact?: boolean }) {
  const order = [...rows].sort((a, b) => b.rating - a.rating)
  const rank = new Map(order.map((r, i) => [r.id, i + 1]))
  return (
    <div className={`g-board ${compact ? 'is-compact' : ''}`}>
      {(['BLUE', 'RED'] as Team[]).map((t) => (
        <table key={t} className={`g-board-team ${tc(t)}`}>
          <thead>
            <tr>
              <th className="g-b-rank">#</th>
              <th className="g-b-name">{cap(t)}</th>
              <th>Caps</th>
              <th>Kills</th>
              <th>Deaths</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {order
              .filter((r) => r.team === t)
              .map((r) => (
                <tr key={r.id} className={r.me ? 'is-me' : ''}>
                  <td className="g-b-rank">{rank.get(r.id)}</td>
                  <td className="g-b-name">{r.name}</td>
                  <td>{r.captures}</td>
                  <td>{r.kills}</td>
                  <td>{r.deaths}</td>
                  <td className="g-b-score">{r.rating.toFixed(2)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ))}
    </div>
  )
}

/* ─────────────── component ─────────────── */

/** Play again, offered on the end screen: only the party leader can put the party back in the queue. */
export interface Rematch {
  canQueue: boolean
  leaderName: string | null
  onQueue: () => void
}

export function Game({ match, me, onExit, rematch }: { match: MatchDTO; me: Player; onExit: () => void; rematch?: Rematch }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const clockEl = useRef<HTMLSpanElement>(null)
  const respawnEl = useRef<HTMLSpanElement>(null)
  const resumeEl = useRef<HTMLElement>(null)
  const ringEl = useRef<SVGCircleElement>(null)
  const lastHp = useRef<number | null>(null)
  const tl = useRef(new Timeline())
  const rend = useRef<Renderer | null>(null)
  const [map, setMap] = useState<GMap | null>(null)
  const [hud, setHud] = useState<Hud | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [feed, setFeed] = useState<Kill[]>([])
  const [intro, setIntro] = useState<3 | 2 | 1 | 'go' | null>(null)
  const [secured, setSecured] = useState(false)
  const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const [fatal, setFatal] = useState<string | null>(null)
  const [muted, setMutedUi] = useState(isMuted)
  const [ping, setPing] = useState<number | null>(null)
  const [showBoard, setShowBoard] = useState(false)
  const [touch] = useState(isTouch)
  const [abilities, setAbilities] = useState<Record<string, string>>({})
  const [fullscreen, setFullscreen] = useState(false)
  const touchApi = useRef<TouchApi | null>(null)
  const skillEl = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    unlockAudio() // the player just clicked "Enter match", so audio is allowed
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/api/game/ws/${match.match_id}?token=${encodeURIComponent(token.get() ?? '')}`
    let ws: WebSocket
    let stopped = false
    let done = false // fatal error or match over: stop reconnecting
    let lostSince: number | null = null
    let retry: ReturnType<typeof setTimeout>
    let prev: Snapshot | null = null
    let hudKey = ''
    let seq = 0
    let introPlayed = false
    let dims = { w: 1200, h: 700 } // replaced by the server map on hello
    let cursor: { x: number; y: number } | null = null // world coordinates of the mouse, for Q
    const timers: ReturnType<typeof setTimeout>[] = []
    const later = (ms: number, fn: () => void) => void timers.push(setTimeout(fn, ms))
    const held = { up: false, down: false, left: false, right: false }
    const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    const view = viewOf(match.my_team)
    const flip = view.mirror
    const sendInput = () => send({ t: 'input', ...held, ...(flip && { left: held.right, right: held.left }) })
    const fire = (p: { x: number; y: number }) => send({ t: 'fire', x: flip ? dims.w - p.x : p.x, y: p.y })
    /** Q: the class ability, aimed at the cursor like a shot. Whether it can happen at all is the server's call. */
    const cast = () => {
      const me0 = tl.current.latest()?.players.find((p) => p.id === me.id)
      const at = cursor ?? (me0 && me0.x !== null && me0.y !== null ? { x: me0.x + 100, y: me0.y } : null)
      if (at) send({ t: 'ability', x: flip ? dims.w - at.x : at.x, y: at.y })
    }

    const announce = (title: string, sub: string, team: Team, at: number) => rend.current?.at(at, () => setBanner({ id: ++seq, title, sub, team }))

    const playIntro = () => {
      introPlayed = true
      ;([3, 2, 1] as const).forEach((n, i) => later(i * 480, () => (setIntro(n), sfx.countdown(false))))
      later(1440, () => (setIntro('go'), sfx.countdown(true)))
      later(2540, () => (setIntro(null), setBanner({ id: ++seq, title: 'STEAL THE ENEMY FLAG', sub: 'Bring it back to your base', team: 'BLUE' })))
    }

    /** Turn the difference between two authoritative snapshots into feedback, timed to render time. */
    const events = (a: Snapshot, b: Snapshot) => {
      const r = rend.current
      if (!r) return
      const t = b.now
      const byId = new Map(b.players.map((p) => [p.id, p]))
      const mine = byId.get(me.id)
      const before = new Map(a.players.map((p) => [p.id, p]))
      for (const p of b.players) {
        const q = before.get(p.id)
        if (!q) continue
        if (p.hp < q.hp && p.x !== null && p.y !== null) {
          const [px, py] = [p.x, p.y]
          r.at(t, () => (r.hit(p.id, px, py, q.hp - p.hp, p.team, t), sfx.hit(p.id === me.id)))
        }
        if (q.alive && !p.alive && p.x !== null && p.y !== null) {
          const [px, py] = [p.x, p.y]
          const k = p.killedBy ? byId.get(p.killedBy) : null
          const row: Kill = { id: ++seq, killer: k ? { name: k.name, team: k.team } : null, victim: { name: p.name, team: p.team }, mine: p.id === me.id || k?.id === me.id }
          r.at(t, () => {
            r.death(p.id, px, py, p.team, t)
            sfx.death(p.id === me.id)
            setFeed((f) => [...f.slice(-4), row])
            later(5000, () => setFeed((f) => f.filter((x) => x.id !== row.id)))
          })
        }
      }
      const known = new Set(a.shots.map((s) => s.id))
      for (const s of b.shots) {
        if (known.has(s.id)) continue
        const shooter = byId.get(s.owner)
        if (shooter && shooter.x !== null && shooter.y !== null) {
          const [sx, sy] = [shooter.x, shooter.y]
          r.at(t - 33, () => (r.shot(shooter.id, sx, sy, s.x - sx, s.y - sy, t - 33), sfx.shoot(shooter.id === me.id)))
        }
      }
      const whose = (t: Team) => (mine?.team === t ? 'your flag' : `the ${t.toLowerCase()} flag`)
      for (const f of b.flags) {
        const q = a.flags.find((x) => x.team === f.team)!
        if (q.state === f.state) continue
        if (f.state === 'CARRIED') {
          const by = f.carrierId ? byId.get(f.carrierId)?.name : null
          announce('FLAG STOLEN', `${by ?? 'The enemy'} took ${whose(f.team)}`, f.team, t)
          r.at(t, () => (r.flagEvent(f.x, f.y, f.team, t), sfx.pickup()))
        } else if (f.state === 'DROPPED') {
          announce('FLAG DROPPED', mine?.team === f.team ? 'Recover your flag before the enemy grabs it' : `Grab ${whose(f.team)} before it returns`, f.team, t)
          r.at(t, () => (r.flagEvent(f.x, f.y, f.team, t), sfx.flagDrop()))
        } else if (q.state === 'DROPPED') {
          announce('FLAG RETURNED', `${cap(f.team)} flag is back at base`, f.team, t)
          r.at(t, () => (r.flagEvent(f.x, f.y, f.team, t, true), sfx.flagReturn()))
          if (mine?.team === f.team)
            r.at(t, () => {
              setSecured(true)
              later(2600, () => setSecured(false))
            })
        }
      }
      const scored = (['RED', 'BLUE'] as Team[]).find((x) => b.scores[x] > a.scores[x])
      if (scored) {
        const base = b.flags.find((f) => f.team === scored)!
        r.at(t, () => {
          r.flagEvent(base.x, base.y, scored, t, true)
          sfx.pickup()
          later(420, () => sfx.win(mine?.team === scored))
        })
      } else if (a.state === 'PLAYING' && b.state === 'ENDED' && b.winner) {
        const w = b.winner // won on the clock
        r.at(t, () => sfx.win(mine?.team === w))
      }
      if (b.round > a.round) announce(`ROUND ${b.round}`, 'Steal the enemy flag and bring it home', mine?.team ?? 'BLUE', t)
      if (b.suddenDeath && !a.suddenDeath) announce('SUDDEN DEATH', 'No respawns · next capture wins', mine?.team ?? 'BLUE', t)
    }

    const onSnapshot = (s: Snapshot) => {
      tl.current.push(s)
      if (prev) events(prev, s)
      else if (!introPlayed && s.state === 'PLAYING' && s.elapsed < INTRO_IF_YOUNGER_MS) playIntro()
      prev = s
      const h = hudOf(s, me.id)
      const key = JSON.stringify(h)
      if (key !== hudKey) {
        hudKey = key
        setHud({ ...h, at: s.now }) // re-render only when something the HUD shows changed
      }
      if (s.state === 'ENDED') done = true
    }

    const connect = () => {
      ws = new WebSocket(url)
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data) as Msg
        if (m.t === 'hello') {
          lostSince = null
          prev = null
          introPlayed ||= rend.current !== null // a reconnect never replays the intro
          tl.current.reset() // fresh timeline after a reconnect: no sliding from stale positions
          const vm = viewMap(m.map, view)
          dims = vm
          rend.current ??= new Renderer(vm, me.id)
          for (const [id, c] of Object.entries(m.catalog.classes)) rend.current.cooldowns[id] = c.cooldownMs
          setAbilities(Object.fromEntries(Object.entries(m.catalog.classes).map(([id, c]) => [id, c.ability])))
          setMap((old) => old ?? vm)
          setConn('live')
          sendInput()
          send({ t: 'ping', c: performance.now() })
        } else if (m.t === 'pong') {
          setPing(Math.round(performance.now() - m.c))
        } else if (m.t === 'error') {
          done = true
          setFatal(m.message)
        } else onSnapshot(viewSnap(m, dims.w, view))
      }
      ws.onclose = () => {
        if (stopped || done) return
        setPing(null)
        lostSince ??= Date.now()
        if (Date.now() - lostSince > RECONNECT_FOR_MS) {
          setFatal('Lost connection to the match server.')
          return
        }
        setConn('reconnecting')
        retry = setTimeout(connect, 1000)
      }
    }
    connect()

    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      unlockAudio()
      if (e.code === 'Tab') {
        e.preventDefault() // hold = scoreboard; must not move focus
        setShowBoard(down)
        return
      }
      if (down && e.code === 'KeyQ' && !e.repeat) return cast()
      const k = KEYS[e.code]
      if (!k || held[k] === down) return
      e.preventDefault()
      held[k] = down
      sendInput()
    }
    // Touch: the two sticks and the skill button drive the same intents as keys + mouse. Directions are in
    // view space (like the cursor), so `fire` / `sendInput` mirror them for team 1 exactly as for the mouse.
    let aimDir: { x: number; y: number } | null = null
    let moveDir = { x: 1, y: 0 }
    const dirPoint = (d: { x: number; y: number }) => {
      const m = tl.current.latest()?.players.find((p) => p.id === me.id)
      return m && m.x !== null && m.y !== null ? { x: m.x + d.x * 300, y: m.y + d.y * 300 } : null
    }
    touchApi.current = {
      move(x, y) {
        const m = Math.hypot(x, y)
        const next = { up: m > 0.3 && y < -0.38, down: m > 0.3 && y > 0.38, left: m > 0.3 && x < -0.38, right: m > 0.3 && x > 0.38 }
        if (m > 0.3) moveDir = { x: x / m, y: y / m }
        if ((Object.keys(next) as (keyof typeof next)[]).every((k) => held[k] === next[k])) return
        Object.assign(held, next)
        sendInput()
      },
      aim(x, y) {
        const m = Math.hypot(x, y)
        aimDir = m < 0.25 ? null : { x: x / m, y: y / m } // dragged out = shooting
        const p = aimDir && dirPoint(aimDir)
        if (aimDir && p && rend.current) {
          cursor = p
          rend.current.myAim = Math.atan2(aimDir.y, aimDir.x)
        }
      },
      skill() {
        unlockAudio()
        cursor = dirPoint(aimDir ?? moveDir) ?? cursor
        cast()
      },
    }
    const kd = onKey(true)
    const ku = onKey(false)
    const blur = () => {
      setShowBoard(false)
      held.up = held.down = held.left = held.right = false
      sendInput()
    }

    // Fire intent: aim point in world coords while LMB is held; the server enforces the cooldown.
    let aim: { x: number; y: number } | null = null
    let lastFire = 0
    const toWorld = (e: MouseEvent) => {
      const r = canvas.current!.getBoundingClientRect()
      return { x: ((e.clientX - r.left) * dims.w) / r.width, y: ((e.clientY - r.top) * dims.h) / r.height }
    }
    const md = (e: MouseEvent) => {
      unlockAudio()
      if (e.button !== 0 || e.target !== canvas.current) return
      aim = toWorld(e)
      lastFire = Date.now()
      fire(aim)
    }
    const mm = (e: MouseEvent) => {
      if (!canvas.current || !rend.current) return
      const w = toWorld(e)
      cursor = w
      if (aim) aim = w
      const mine = tl.current.latest()?.players.find((p) => p.id === me.id)
      if (mine && mine.x !== null && mine.y !== null) rend.current.myAim = Math.atan2(w.y - mine.y, w.x - mine.x) // cosmetic: my weapon follows the cursor
    }
    const mu = (e: MouseEvent) => e.button === 0 && (aim = null)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)
    window.addEventListener('mousedown', md)
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', mu)
    // While LMB is held, keep sending the aim point. The server's per-weapon cooldown decides which ones
    // count, so a fast weapon is never throttled by the client (a coarse client interval would round it up).
    const autofire = setInterval(() => {
      const target = aimDir ? dirPoint(aimDir) : aim
      if (target && Date.now() - lastFire >= FIRE_SEND_MS) {
        lastFire = Date.now()
        fire(target)
      }
    }, FIRE_SEND_MS)
    const pinger = setInterval(() => send({ t: 'ping', c: performance.now() }), PING_EVERY_MS)

    return () => {
      stopped = true
      clearTimeout(retry)
      timers.forEach(clearTimeout)
      ws.close()
      clearInterval(autofire)
      clearInterval(pinger)
      touchApi.current = null
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('blur', blur)
      window.removeEventListener('mousedown', md)
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', mu)
    }
  }, [match.match_id, match.my_team, me.id])

  // Render loop: canvas plus the per-frame HUD numbers, written straight to the DOM.
  useEffect(() => {
    const c = canvas.current
    if (!map || !c) return
    const dpr = window.devicePixelRatio || 1
    c.width = map.w * dpr
    c.height = map.h * dpr
    const ctx = c.getContext('2d')!
    const RING = 2 * Math.PI * 46
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      rend.current?.draw(ctx, tl.current)
      const s = tl.current.latest()
      if (!s) return
      const t = tl.current.renderTime()
      // Regulation counts down to 10:00; sudden death then counts down the 2 minutes to the tiebreak.
      const elapsed = s.state === 'ENDED' ? s.elapsed : s.elapsed - (s.now - t)
      const remaining = (s.suddenDeath ? s.hardStopMs : s.matchMs) - elapsed
      if (clockEl.current) {
        clockEl.current.textContent = clock(remaining)
        clockEl.current.parentElement?.classList.toggle('is-low', s.state === 'PLAYING' && remaining > 0 && remaining <= 10_000)
      }
      if (s.resumesAt && resumeEl.current) resumeEl.current.textContent = String(Math.max(1, Math.ceil((s.resumesAt - t) / 1000)))
      const mine = s.players.find((p) => p.id === me.id)
      if (skillEl.current) {
        const total = rend.current?.cooldowns[mine?.class ?? ''] ?? 0
        const left = Math.max(0, (mine?.abilityReadyAt ?? 0) - t)
        const ready = !total || left === 0
        skillEl.current.style.setProperty('--cd', String(ready ? 1 : 1 - Math.min(1, left / total)))
        skillEl.current.classList.toggle('is-ready', ready)
        skillEl.current.disabled = !mine?.alive
      }
      if (mine?.respawnAt) {
        const left = Math.max(0, mine.respawnAt - t)
        if (respawnEl.current) respawnEl.current.textContent = (left / 1000).toFixed(1)
        if (ringEl.current) ringEl.current.style.strokeDashoffset = String(RING * (1 - left / 3000))
      }
    }
    frame()
    return () => cancelAnimationFrame(raf)
  }, [map, me.id])

  useEffect(() => {
    if (!banner) return
    const t = setTimeout(() => setBanner((b) => (b?.id === banner.id ? null : b)), 1800)
    return () => clearTimeout(t)
  }, [banner])

  const mine = hud?.me ?? null
  const myTeam = mine?.team ?? null
  // The final result: the live snapshot while the room is open, else the stored one (a reconnect
  // after the room unloaded gets an error from the server, but the match document has the result).
  const final = (() => {
    if (hud?.ended) return { winner: hud.winner, decidedBy: hud.decidedBy, progress: hud.progress, capturer: hud.capturer, rows: hud.rows, scores: hud.scores }
    const r = match.result
    if (!r) return null
    const v = viewOf(match.my_team)
    const vt = (t: Team): Team => (v.swap ? other(t) : t)
    const rows = r.players.map((p) => ({ id: p.id, name: p.name, team: vt(p.team), kills: p.kills, deaths: p.deaths, captures: p.captures, cls: p.class }))
    const cap = rows.find((p) => p.id === r.capturer)
    const sc = r.scores ?? { RED: r.winner === 'RED' ? 1 : 0, BLUE: r.winner === 'BLUE' ? 1 : 0 } // results stored before rounds existed
    const pr = r.progress ?? { RED: 0, BLUE: 0 }
    return {
      winner: r.winner === 'TIE' ? null : vt(r.winner),
      decidedBy: r.decided_by ?? null,
      progress: v.swap ? { RED: pr.BLUE, BLUE: pr.RED } : pr,
      capturer: cap ? { name: cap.name, team: cap.team } : null,
      rows,
      scores: v.swap ? { RED: sc.BLUE, BLUE: sc.RED } : sc,
    }
  })()
  const score = final?.scores ?? hud?.scores ?? { RED: 0, BLUE: 0 }
  const now = hud?.at ?? 0

  const objective = (() => {
    if (!hud || !mine || hud.ended || hud.intermission || !mine.alive) return null
    const own = hud.flags[mine.team]
    const theirs = hud.flags[other(mine.team)]
    if (mine.carrying)
      return own.state === 'AT_BASE'
        ? { text: 'Return to your base', team: mine.team, icon: <ArrowHome /> }
        : { text: 'Hold the flag until yours is back home', team: other(mine.team), icon: <Alert /> }
    if (own.state === 'CARRIED') return { text: `Stop ${own.carrier?.name ?? 'the carrier'}, they have your flag`, team: other(mine.team), icon: <Alert /> }
    if (own.state === 'DROPPED') return { text: 'Recover your flag', team: mine.team, icon: <Alert /> }
    if (theirs.state === 'CARRIED') return { text: `Escort ${theirs.carrier?.name ?? 'your carrier'} home`, team: mine.team, icon: <FlagIcon /> }
    if (secured) return { text: 'Flag secured', team: null, icon: <FlagIcon /> }
    return null
  })()

  const wing = (t: Team) => {
    const right = t === 'RED'
    const f = hud?.flags[t]
    const alive = hud?.roster[t].filter((p) => p.alive).length ?? 0
    return (
      <div className={`g-wing ${tc(t)} ${right ? 'is-right' : ''}`}>
        <div className="g-wing-id">
          <span className="g-team-name">
            {t}
          </span>
          <span className="g-pips" title="Players alive" aria-label={`${alive} of ${hud?.roster[t].length ?? 0} ${t.toLowerCase()} players alive`}>
            {(hud?.roster[t] ?? []).map((p) => (
              <i key={p.id} className={`g-pip ${p.alive ? '' : 'is-down'} ${p.connected ? '' : 'is-offline'}`} />
            ))}
          </span>
          <span className="g-alive" aria-hidden>
            {alive}/{hud?.roster[t].length ?? 0} alive
          </span>
          {f && f.state !== 'AT_BASE' && (
            <span className={`g-flagtab ${f.state === 'CARRIED' ? 'is-taken' : f.state === 'DROPPED' ? 'is-dropped' : ''}`}>
              <FlagIcon />
              {f.state === 'CARRIED' && (
                <>
                  {!hud?.ended && <span className="g-live-dot" />}
                  {hud?.ended ? 'Captured by' : 'Carried by'} <b>{f.carrier?.name ?? '…'}</b>
                </>
              )}
              {f.state === 'DROPPED' && (
                <>
                  Dropped
                  {f.returnAt && (
                    <span className="g-return">
                      <i key={f.returnAt} style={{ animationDuration: `${Math.max(0, f.returnAt - now)}ms`, ['--from' as string]: Math.max(0, Math.min(1, (f.returnAt - now) / 10_000)) } as CSSProperties} />
                    </span>
                  )}
                </>
              )}
            </span>
          )}
        </div>
        <span key={score[t]} className={`g-score ${score[t] ? 'is-bumped' : ''}`}>
          {score[t]}
        </span>
      </div>
    )
  }

  const won = final?.winner ? final.winner === (myTeam ?? 'BLUE') : null // everyone is shown as BLUE (see viewOf)
  const carrying = !!mine?.carrying && !hud?.ended
  const hpHit = mine && lastHp.current !== null && mine.hp < lastHp.current // flash the bar when health drops
  const hpColor = !mine ? color.hpHigh : mine.hp > mine.maxHp / 2 ? color.hpHigh : mine.hp > mine.maxHp / 4 ? color.hpMid : color.hpLow

  useEffect(() => {
    lastHp.current = mine?.hp ?? null
  })

  return (
    <div className={`g-root ${touch ? 'is-touch' : ''}`} style={cssVars() as CSSProperties}>
      {ping !== null && !hud?.ended && (
        <span className="g-ping" title="Round-trip time to the match server" style={{ color: ping < 80 ? color.hpHigh : ping < 150 ? color.hpMid : color.hpLow }}>
          {ping < 1 ? '<1' : ping} ms
        </span>
      )}
      <header className="g-plate" aria-label="Match score">
        {wing('BLUE')}
        <div className="g-clock">
          <span ref={clockEl}>10:00</span>
          {hud && !hud.ended && <small className={`g-round-tag ${hud.suddenDeath ? 'is-sudden' : ''}`}>{hud.suddenDeath ? 'SUDDEN DEATH' : `ROUND ${hud.round} · FIRST TO ${ROUNDS_TO_WIN}`}</small>}
        </div>
        {wing('RED')}
      </header>

      <main className="g-stage">
        <div className={`g-map ${mine && !mine.alive && !hud?.ended ? 'is-dead' : ''} ${hud?.ended || fatal ? 'is-over' : ''}`}>
          <canvas ref={canvas} onContextMenu={(e) => e.preventDefault()} aria-label="Capture the flag arena" />

          <div className="g-layer">
            <div className="g-feed" aria-live="polite">
              {feed.map((k) => (
                <div key={k.id} className={`g-feed-row ${k.mine ? 'is-me' : ''}`}>
                  {k.killer && <span className={tc(k.killer.team)}>{k.killer.name}</span>}
                  <Crosshair />
                  <span className={tc(k.victim.team)}>{k.victim.name}</span>
                </div>
              ))}
            </div>

            {banner && !hud?.ended && (
              <div key={banner.id} className={`g-banner ${tc(banner.team)}`} role="status">
                <span className="g-banner-title">{banner.title}</span>
                <span className="g-banner-sub">{banner.sub}</span>
              </div>
            )}

            {conn === 'reconnecting' && !fatal && !hud?.ended && <div className="g-pill">Reconnecting to the match…</div>}
            {conn === 'connecting' && !fatal && <div className="g-pill" style={{ color: color.dim }}>Joining match…</div>}

            {intro !== null && !hud?.ended && (
              <div className="g-layer g-intro">
                {intro === 'go' ? (
                  <div className="g-go">
                    <span className="g-go-title">CAPTURE THE FLAG</span>
                  </div>
                ) : (
                  <span key={intro} className="g-count">
                    {intro}
                  </span>
                )}
              </div>
            )}

            {hud?.intermission && !hud.ended && (
              <div className={`g-layer g-round ${tc(hud.intermission.winner)}`} role="status">
                <div className="g-round-card">
                  <span className="g-round-title">{cap(hud.intermission.winner)} SCORES</span>
                  {hud.intermission.capturer && <span className="g-round-sub">{hud.intermission.capturer.name} captured the flag</span>}
                  <span className="g-round-sub">
                    Round {hud.round + 1} in <b ref={resumeEl}>4</b>
                  </span>
                </div>
              </div>
            )}

            {showBoard && !hud?.ended && hud && (
              <div className="g-layer g-boardlayer">
                <Board rows={hud.board} compact={touch} />
              </div>
            )}

            {mine && !mine.alive && !hud?.ended && !hud?.intermission && (
              <div className={`g-layer g-death ${mine.killer ? tc(mine.killer.team) : ''}`}>
                <div className="g-death-card">
                  <span className="g-death-title">ELIMINATED</span>
                  {mine.killer && (
                    <span className="g-death-by">
                      by <b>{mine.killer.name}</b>
                    </span>
                  )}
                  {hud?.suddenDeath ? (
                    <span className="g-death-note">No respawns in sudden death. You are out until the match ends.</span>
                  ) : (
                    <>
                      <div className="g-ring">
                        <svg viewBox="0 0 104 104">
                          <circle cx="52" cy="52" r="46" fill="none" stroke={color.rule} strokeWidth="4" />
                          <circle ref={ringEl} cx="52" cy="52" r="46" fill="none" stroke={color.ink} strokeWidth="4" strokeLinecap="round" strokeDasharray={2 * Math.PI * 46} strokeDashoffset={2 * Math.PI * 46} />
                        </svg>
                        <span ref={respawnEl}>3.0</span>
                      </div>
                      <span className="g-death-note">Respawning</span>
                    </>
                  )}
                </div>
              </div>
            )}

            {(hud?.ended || fatal) && (
              <div className={`g-layer g-result ${final?.winner ? tc(final.winner) : ''}`}>
                <div className={`g-result-band ${final ? 'has-board' : ''}`} role="dialog" aria-label="Match result">
                  {final ? (
                    <>
                      <span className="g-result-kicker">{kicker(final.decidedBy, !!final.winner)}</span>
                      <span className={`g-result-title ${won ? '' : 'is-defeat'}`}>{!final.winner ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT'}</span>
                      <span className="g-result-score" aria-label={`Blue ${score.BLUE}, Red ${score.RED}`}>
                        <em className="g-blue">BLUE</em>
                        <span className="g-blue">{score.BLUE}</span>
                        <i />
                        <span className="g-red">{score.RED}</span>
                        <em className="g-red">RED</em>
                      </span>
                      {tiebreakLine(final) ?? (final.winner && final.capturer && <span className="g-result-by">Last capture by {final.capturer.name}</span>)}
                      <div className="g-result-board">
                        <Scoreboard rows={final.rows} meId={me.id} myTeam={myTeam ?? 'BLUE'} />
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="g-result-title is-defeat" style={{ fontSize: 'clamp(40px, 5vw, 64px)' }}>
                        MATCH UNAVAILABLE
                      </span>
                      <span className="g-result-kicker">{fatal}</span>
                    </>
                  )}
                  <div className="g-result-actions">
                    {final && rematch?.canQueue && (
                      <button onClick={rematch.onQueue} className={`g-btn ${myTeam ? tc(myTeam) : ''}`} autoFocus>
                        PLAY AGAIN
                      </button>
                    )}
                    <button onClick={onExit} className={`g-btn ${final && rematch?.canQueue ? 'is-ghost' : ''} ${myTeam ? tc(myTeam) : ''}`} autoFocus={!(final && rematch?.canQueue)}>
                      RETURN TO HUB
                    </button>
                  </div>
                  {final && rematch && !rematch.canQueue && (
                    <span className="g-result-by">{rematch.leaderName ? `${rematch.leaderName} can queue the party again` : 'Only the party leader can queue again'}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className={`g-bar ${carrying && mine ? `is-carrying ${tc(other(mine.team))}` : ''}`}>
        <div className={`g-me ${myTeam ? tc(myTeam) : ''}`}>
          {mine && <ClassAvatar cls={mine.cls} size={touch ? 30 : 44} />}
          <div style={{ minWidth: 0 }}>
            <div className="g-me-name">{mine?.name ?? me.name}</div>
            {!mine?.alive && <div className={`g-me-state ${mine ? 'is-down' : ''}`}>{mine ? 'Eliminated' : 'Spectating'}</div>}
          </div>
          {mine && (
            <div className="g-hp" role="meter" aria-label="Health" aria-valuemin={0} aria-valuemax={mine.maxHp} aria-valuenow={mine.hp}>
              <span className="g-hp-track" style={{ ['--hp' as string]: hpColor } as CSSProperties}>
                <i style={{ width: `${Math.max(0, Math.min(100, (mine.hp / mine.maxHp) * 100))}%` }} />
                {hpHit && <b key={mine.hp} className="g-hp-flash" />}
              </span>
              <span className="g-hp-num">{mine.hp}</span>
            </div>
          )}
        </div>

        {objective ? (
          <div key={objective.text} className={`g-objective ${objective.team ? `is-team ${tc(objective.team)}` : 'is-calm'}`}>
            {objective.icon}
            {objective.text}
          </div>
        ) : (
          <span />
        )}

        <div className="g-right">
          {carrying && mine && (
            <span className="g-carry" role="status">
              <FlagIcon /> CARRYING FLAG
            </span>
          )}
          {touch && (
            <>
              <button className="g-icon-btn" onClick={() => setShowBoard((b) => !b)} aria-label="Scoreboard" aria-pressed={showBoard}>
                <BoardIcon />
              </button>
              {'requestFullscreen' in document.documentElement && (
                <button className="g-icon-btn" onClick={() => toggleFullscreen().then(() => setFullscreen(!!document.fullscreenElement))} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
                  <FullscreenIcon />
                </button>
              )}
            </>
          )}
          <button className="g-icon-btn" onClick={() => (setMuted(!muted), setMutedUi(!muted))} aria-label={muted ? 'Unmute sound' : 'Mute sound'} aria-pressed={muted} title={muted ? 'Unmute' : 'Mute'}>
            <Speaker off={muted} />
          </button>
        </div>
      </footer>

      {touch && !hud?.ended && !fatal && <TouchControls api={touchApi} skillRef={skillEl} skillName={abilities[mine?.cls ?? ''] ?? 'Skill'} />}
    </div>
  )
}

/** Full screen + landscape lock where the browser allows it (Android Chrome); a no-op elsewhere. */
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) return void (await document.exitFullscreen())
    await document.documentElement.requestFullscreen()
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')
  } catch {
    /* denied or unsupported: playing windowed is fine */
  }
}
