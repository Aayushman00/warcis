import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { token, type MatchDTO } from './api'
import type { Player } from './data'
import './game/hud.css'
import { Renderer, Timeline, type GMap, type Snapshot } from './game/render'
import { isMuted, setMuted, sfx, unlockAudio } from './game/sfx'
import { color, cssVars, other, type Team } from './game/tokens'

/* In-match client. The server (services/game-service) is authoritative: this component
   sends intents (held keys, aim point), renders interpolated snapshots on the canvas, and
   turns snapshot changes into HUD feedback. React only re-renders when HUD data changes;
   per-frame numbers (clock, respawn ring) are written straight to the DOM. */

type Msg = Snapshot | { t: 'hello'; you: string; map: GMap } | { t: 'error'; code: string; message: string } | { t: 'pong'; c: number }
type Who = { name: string; team: Team }
type FlagHud = { state: 'AT_BASE' | 'CARRIED' | 'DROPPED'; carrier: Who | null; returnAt: number | null }
type Hud = {
  me: (Who & { hp: number; alive: boolean; carrying: boolean; killer: Who | null }) | null
  roster: Record<Team, { id: string; alive: boolean; connected: boolean }[]>
  flags: Record<Team, FlagHud>
  ended: boolean
  winner: Team | null
  capturer: Who | null // the winner still holds the flag in the final snapshot
  at?: number // server time this HUD state was taken (not part of the change key)
}
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
const RECONNECT_FOR_MS = 60_000
const PING_EVERY_MS = 2000
const INTRO_IF_YOUNGER_MS = 15_000
const tc = (t: Team) => (t === 'RED' ? 'g-red' : 'g-blue')
const cap = (t: Team) => t[0] + t.slice(1).toLowerCase()
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
    players: s.players.map((p) => ({ ...p, team: t(p.team), x: x(p.x) })),
    flags: s.flags.map((f) => ({ ...f, team: t(f.team), x: x(f.x) })),
    shots: s.shots.map((o) => ({ ...o, team: t(o.team), x: x(o.x) })),
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
    me: m ? { name: m.name, team: m.team, hp: m.hp, alive: m.alive, carrying: m.carryingFlag, killer: m.alive ? null : who(m.killedBy) } : null,
    roster,
    flags: { RED: flag('RED'), BLUE: flag('BLUE') },
    ended: s.state === 'ENDED',
    winner: s.winner,
    capturer: s.winner ? who(s.players.find((p) => p.team === s.winner && p.carryingFlag)?.id ?? null) : null,
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
const Emblem = ({ letter }: { letter: string }) => (
  <svg className="g-emblem" viewBox="0 0 34 38" aria-hidden>
    <path d="M17 1 32 7v11c0 9-6.5 15.5-15 19C8.5 33.5 2 27 2 18V7z" fill="currentColor" opacity="0.18" />
    <path d="M17 1 32 7v11c0 9-6.5 15.5-15 19C8.5 33.5 2 27 2 18V7z" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <text x="17" y="24" textAnchor="middle" fill="currentColor" style={{ font: `700 15px var(--g-font-display)` }}>
      {letter}
    </text>
  </svg>
)

/* ─────────────── component ─────────────── */

export function Game({ match, me, onExit }: { match: MatchDTO; me: Player; onExit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const clockEl = useRef<HTMLSpanElement>(null)
  const respawnEl = useRef<HTMLSpanElement>(null)
  const ringEl = useRef<SVGCircleElement>(null)
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
    const timers: ReturnType<typeof setTimeout>[] = []
    const later = (ms: number, fn: () => void) => void timers.push(setTimeout(fn, ms))
    const held = { up: false, down: false, left: false, right: false }
    const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    const view = viewOf(match.my_team)
    const flip = view.mirror
    const sendInput = () => send({ t: 'input', ...held, ...(flip && { left: held.right, right: held.left }) })
    const fire = (p: { x: number; y: number }) => send({ t: 'fire', x: flip ? dims.w - p.x : p.x, y: p.y })

    const announce = (title: string, sub: string, team: Team, at: number) => rend.current?.at(at, () => setBanner({ id: ++seq, title, sub, team }))

    const playIntro = () => {
      introPlayed = true
      ;([3, 2, 1] as const).forEach((n, i) => later(i * 480, () => (setIntro(n), sfx.countdown(false))))
      later(1440, () => (setIntro('go'), sfx.countdown(true)))
      later(2540, () => setIntro(null))
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
        if (p.hp < q.hp) r.at(t, () => (r.hit(p.id, p.x, p.y, q.hp - p.hp, p.team, t), sfx.hit(p.id === me.id)))
        if (q.alive && !p.alive) {
          const k = p.killedBy ? byId.get(p.killedBy) : null
          const row: Kill = { id: ++seq, killer: k ? { name: k.name, team: k.team } : null, victim: { name: p.name, team: p.team }, mine: p.id === me.id || k?.id === me.id }
          r.at(t, () => {
            r.death(p.id, p.x, p.y, p.team, t)
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
        if (shooter) r.at(t - 33, () => (r.shot(shooter.id, shooter.x, shooter.y, s.x - shooter.x, s.y - shooter.y, t - 33), sfx.shoot(shooter.id === me.id)))
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
      if (a.state === 'PLAYING' && b.state === 'ENDED' && b.winner) {
        const w = b.winner
        const base = b.flags.find((f) => f.team === w)!
        r.at(t, () => {
          r.flagEvent(base.x, base.y, w, t, true)
          sfx.pickup()
          later(420, () => sfx.win(mine?.team === w))
        })
      }
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
      const k = KEYS[e.code]
      if (!k || held[k] === down) return
      e.preventDefault()
      held[k] = down
      sendInput()
    }
    const kd = onKey(true)
    const ku = onKey(false)
    const blur = () => {
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
      if (aim) aim = w
      const mine = tl.current.latest()?.players.find((p) => p.id === me.id)
      if (mine) rend.current.myAim = Math.atan2(w.y - mine.y, w.x - mine.x) // cosmetic: my weapon follows the cursor
    }
    const mu = (e: MouseEvent) => e.button === 0 && (aim = null)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)
    window.addEventListener('mousedown', md)
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', mu)
    const autofire = setInterval(() => {
      if (aim && Date.now() - lastFire >= 100) {
        lastFire = Date.now()
        fire(aim)
      }
    }, 50)
    const pinger = setInterval(() => send({ t: 'ping', c: performance.now() }), PING_EVERY_MS)

    return () => {
      stopped = true
      clearTimeout(retry)
      timers.forEach(clearTimeout)
      ws.close()
      clearInterval(autofire)
      clearInterval(pinger)
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
      if (clockEl.current) clockEl.current.textContent = clock(s.state === 'ENDED' ? s.elapsed : s.elapsed - (s.now - t))
      const mine = s.players.find((p) => p.id === me.id)
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
  const score = { RED: hud?.winner === 'RED' ? 1 : 0, BLUE: hud?.winner === 'BLUE' ? 1 : 0 }
  const now = hud?.at ?? 0

  const objective = (() => {
    if (!hud || !mine || hud.ended || !mine.alive) return null
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
    return { text: 'Steal the enemy flag', team: null, icon: <FlagIcon /> }
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
            <small>{alive} alive</small>
          </span>
          <span className="g-pips" aria-label={`${alive} of ${hud?.roster[t].length ?? 0} ${t.toLowerCase()} players alive`}>
            {(hud?.roster[t] ?? []).map((p) => (
              <i key={p.id} className={`g-pip ${p.alive ? '' : 'is-down'} ${p.connected ? '' : 'is-offline'}`} />
            ))}
          </span>
          {f && (
            <span className={`g-flagtab ${f.state === 'CARRIED' ? 'is-taken' : f.state === 'DROPPED' ? 'is-dropped' : ''}`}>
              <FlagIcon />
              {f.state === 'AT_BASE' && 'Flag home'}
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

  const won = hud?.winner && myTeam ? hud.winner === myTeam : null
  const carrying = !!mine?.carrying && !hud?.ended
  const hpColor = !mine ? color.hpHigh : mine.hp > 50 ? color.hpHigh : mine.hp > 25 ? color.hpMid : color.hpLow

  return (
    <div className="g-root" style={cssVars() as CSSProperties}>
      <header className="g-plate" aria-label="Match score">
        {wing('BLUE')}
        <div className="g-clock">
          <span ref={clockEl}>00:00</span>
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
                    <span className="g-go-sub">Steal the enemy flag and bring it to your base</span>
                  </div>
                ) : (
                  <span key={intro} className="g-count">
                    {intro}
                  </span>
                )}
              </div>
            )}

            {mine && !mine.alive && !hud?.ended && (
              <div className={`g-layer g-death ${mine.killer ? tc(mine.killer.team) : ''}`}>
                <div className="g-death-card">
                  <span className="g-death-title">ELIMINATED</span>
                  {mine.killer && (
                    <span className="g-death-by">
                      by <b>{mine.killer.name}</b>
                    </span>
                  )}
                  <div className="g-ring">
                    <svg viewBox="0 0 104 104">
                      <circle cx="52" cy="52" r="46" fill="none" stroke={color.rule} strokeWidth="4" />
                      <circle ref={ringEl} cx="52" cy="52" r="46" fill="none" stroke={color.ink} strokeWidth="4" strokeLinecap="round" strokeDasharray={2 * Math.PI * 46} strokeDashoffset={2 * Math.PI * 46} />
                    </svg>
                    <span ref={respawnEl}>3.0</span>
                  </div>
                  <span className="g-death-note">Respawning</span>
                </div>
              </div>
            )}

            {(hud?.ended || fatal) && (
              <div className={`g-layer g-result ${hud?.winner ? tc(hud.winner) : ''}`}>
                <div className="g-result-band" role="dialog" aria-label="Match result">
                  {hud?.winner ? (
                    <>
                      <span className="g-result-kicker">
                        {won === null ? 'Flag captured' : won ? `${cap(hud.winner)} captured the ${other(hud.winner).toLowerCase()} flag` : `${cap(hud.winner)} captured your flag`}
                      </span>
                      <span className={`g-result-title ${won === false ? 'is-defeat' : ''}`}>{won === null ? `${hud.winner} WINS` : won ? 'VICTORY' : 'DEFEAT'}</span>
                      <span className="g-result-score" aria-label={`Blue ${score.BLUE}, Red ${score.RED}`}>
                        <em className="g-blue">BLUE</em>
                        <span className="g-blue">{score.BLUE}</span>
                        <i />
                        <span className="g-red">{score.RED}</span>
                        <em className="g-red">RED</em>
                      </span>
                      {hud.capturer && <span className="g-result-by">Capture by {hud.capturer.name}</span>}
                    </>
                  ) : (
                    <>
                      <span className="g-result-title is-defeat" style={{ fontSize: 'clamp(40px, 5vw, 64px)' }}>
                        MATCH UNAVAILABLE
                      </span>
                      <span className="g-result-kicker">{fatal}</span>
                    </>
                  )}
                  <button onClick={onExit} className={`g-btn ${myTeam ? tc(myTeam) : ''}`} autoFocus>
                    RETURN TO HUB
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className={`g-bar ${carrying && mine ? `is-carrying ${tc(other(mine.team))}` : ''}`}>
        <div className={`g-me ${myTeam ? tc(myTeam) : ''}`}>
          {mine && <Emblem letter={mine.name[0]?.toUpperCase() ?? '?'} />}
          <div style={{ minWidth: 0 }}>
            <div className="g-me-name">{mine?.name ?? me.name}</div>
            <div className={`g-me-state ${mine && !mine.alive ? 'is-down' : ''}`}>{mine ? (mine.alive ? `${cap(mine.team)} team` : 'Eliminated') : 'Spectating'}</div>
          </div>
          {mine && (
            <div className="g-hp" aria-label={`Health ${mine.hp}`}>
              <span className="g-hp-seg" style={{ ['--hp' as string]: hpColor } as CSSProperties}>
                {[0, 1, 2, 3].map((i) => (
                  <i key={i} className={mine.hp >= (i + 1) * 25 ? '' : 'is-empty'} />
                ))}
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
            <span className={`g-carry ${tc(other(mine.team))}`}>
              <FlagIcon />
              {other(mine.team)} FLAG
            </span>
          )}
          {ping !== null && !hud?.ended && (
            <span className="g-ping" title="Round-trip time to the match server" style={{ color: ping < 80 ? color.hpHigh : ping < 150 ? color.hpMid : color.hpLow }}>
              {ping} ms
            </span>
          )}
          <button className="g-icon-btn" onClick={() => (setMuted(!muted), setMutedUi(!muted))} aria-label={muted ? 'Unmute sound' : 'Mute sound'} aria-pressed={muted} title={muted ? 'Unmute' : 'Mute'}>
            <Speaker off={muted} />
          </button>
        </div>
      </footer>
    </div>
  )
}
