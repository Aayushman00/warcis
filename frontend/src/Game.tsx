import { useEffect, useRef, useState } from 'react'
import { token, type MatchDTO } from './api'
import type { Player } from './data'
import { COLOR, Renderer, Timeline, type GMap, type Snapshot, type Team } from './game/render'
import { isMuted, setMuted, sfx, unlockAudio } from './game/sfx'

/* In-match client. The server (services/game-service) is authoritative: this component
   sends intents (held keys, aim point), renders interpolated snapshots, and turns
   snapshot changes into feedback (banners, effects, sounds). */

type Msg = Snapshot | { t: 'hello'; you: string; map: GMap } | { t: 'error'; code: string; message: string }
type Hud = {
  myTeam: Team | null
  myHp: number
  myAlive: boolean
  carrying: Team | null
  roster: Record<Team, { id: string; alive: boolean; connected: boolean }[]>
  flags: Record<Team, 'AT_BASE' | 'CARRIED' | 'DROPPED'>
  ended: boolean
  winner: Team | null
}
type Note = { id: number; text: string; team: Team }

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
const other = (t: Team): Team => (t === 'RED' ? 'BLUE' : 'RED')
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const Dot = ({ team, size = 10 }: { team: Team; size?: number }) => (
  <span className="inline-block shrink-0 rounded-full align-middle" style={{ width: size, height: size, background: COLOR[team], boxShadow: `0 0 10px ${COLOR[team]}` }} />
)
const FLAG_LABEL = { AT_BASE: 'Flag home', CARRIED: 'Flag taken', DROPPED: 'Flag dropped' } as const

function hudOf(s: Snapshot, me: string): Hud {
  const mine = s.players.find((p) => p.id === me)
  const roster = { RED: [], BLUE: [] } as Hud['roster']
  for (const p of s.players) roster[p.team].push({ id: p.id, alive: p.alive, connected: p.connected })
  return {
    myTeam: mine?.team ?? null,
    myHp: mine?.hp ?? 0,
    myAlive: mine?.alive ?? true,
    carrying: mine?.carryingFlag ? other(mine.team) : null,
    roster,
    flags: { RED: s.flags.find((f) => f.team === 'RED')!.state, BLUE: s.flags.find((f) => f.team === 'BLUE')!.state },
    ended: s.state === 'ENDED',
    winner: s.winner,
  }
}

export function Game({ match, me, onExit }: { match: MatchDTO; me: Player; onExit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const timerEl = useRef<HTMLSpanElement>(null)
  const respawnEl = useRef<HTMLSpanElement>(null)
  const tl = useRef(new Timeline())
  const rend = useRef<Renderer | null>(null)
  const [map, setMap] = useState<GMap | null>(null)
  const [hud, setHud] = useState<Hud | null>(null)
  const [banner, setBanner] = useState<Note | null>(null)
  const [feed, setFeed] = useState<Note[]>([])
  const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const [fatal, setFatal] = useState<string | null>(null)
  const [capturer, setCapturer] = useState<string | null>(null)
  const [muted, setMutedUi] = useState(isMuted)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/api/game/ws/${match.match_id}?token=${encodeURIComponent(token.get() ?? '')}`
    let ws: WebSocket
    let stopped = false
    let done = false // fatal error or match over: stop reconnecting
    let lostSince: number | null = null
    let retry: ReturnType<typeof setTimeout>
    let prev: Snapshot | null = null
    let hudKey = ''
    let noteId = 0
    let dims = { w: 1200, h: 700 } // replaced by the server map on hello
    const held = { up: false, down: false, left: false, right: false }
    const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))

    const note = (text: string, team: Team, at: number) =>
      rend.current?.at(at, () => setBanner({ id: ++noteId, text, team }))
    const log = (text: string, team: Team, at: number) =>
      rend.current?.at(at, () => {
        const n = { id: ++noteId, text, team }
        setFeed((f) => [...f.slice(-3), n])
        setTimeout(() => setFeed((f) => f.filter((x) => x.id !== n.id)), 4000)
      })

    /** Turn the difference between two authoritative snapshots into feedback, timed to render time. */
    const events = (a: Snapshot, b: Snapshot) => {
      const r = rend.current
      if (!r) return
      const t = b.now
      const before = new Map(a.players.map((p) => [p.id, p]))
      for (const p of b.players) {
        const q = before.get(p.id)
        if (!q) continue
        if (p.hp < q.hp) r.at(t, () => (r.hit(p.id, p.x, p.y, q.hp - p.hp, p.team, t), sfx.hit(p.id === me.id)))
        if (q.alive && !p.alive) {
          r.at(t, () => (r.death(p.id, p.x, p.y, p.team, t), sfx.death(p.id === me.id)))
          log(`${p.name} eliminated`, p.team, t)
        }
      }
      const known = new Set(a.shots.map((s) => s.id))
      for (const s of b.shots) {
        if (known.has(s.id)) continue
        let who = null
        let best = 45
        for (const p of b.players) {
          const d = Math.hypot(p.x - s.x, p.y - s.y)
          if (p.alive && p.team === s.team && d < best) {
            who = p
            best = d
          }
        }
        if (who) {
          const shooter = who
          r.at(t - 33, () => (r.shot(shooter.id, shooter.x, shooter.y, s.x - shooter.x, s.y - shooter.y, t - 33), sfx.shoot(shooter.id === me.id)))
        }
      }
      for (const f of b.flags) {
        const q = a.flags.find((x) => x.team === f.team)!
        if (q.state === f.state) continue
        if (f.state === 'CARRIED') {
          note(`${f.team} FLAG STOLEN`, f.team, t)
          r.at(t, () => (r.flagEvent(f.x, f.y, f.team, t), sfx.pickup()))
        } else if (f.state === 'DROPPED') {
          note(`${f.team} FLAG DROPPED`, f.team, t)
          r.at(t, () => r.flagEvent(f.x, f.y, f.team, t))
        } else if (q.state === 'DROPPED') {
          note(`${f.team} FLAG RETURNED`, f.team, t)
          r.at(t, () => (r.flagEvent(f.x, f.y, f.team, t, true), sfx.flagReturn()))
        }
      }
      if (a.state === 'PLAYING' && b.state === 'ENDED' && b.winner) {
        const w = b.winner
        const mine = b.players.find((p) => p.id === me.id)
        const cap = b.players.find((p) => p.team === w && p.carryingFlag) ?? a.players.find((p) => p.team === w && p.carryingFlag)
        if (cap) setCapturer(cap.name)
        note('FLAG CAPTURED', w, t)
        const base = b.flags.find((f) => f.team === w)!
        r.at(t, () => (r.flagEvent(base.x, base.y, w, t, true), sfx.win(mine?.team === w)))
      }
    }

    const onSnapshot = (s: Snapshot) => {
      tl.current.push(s)
      if (prev) events(prev, s)
      prev = s
      const h = hudOf(s, me.id)
      const key = JSON.stringify(h)
      if (key !== hudKey) {
        hudKey = key
        setHud(h) // re-render only when something the HUD shows changed
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
          tl.current.reset() // fresh timeline after a reconnect: no sliding from stale positions
          dims = m.map
          rend.current ??= new Renderer(m.map, me.id)
          setMap((old) => old ?? m.map)
          setConn('live')
          send({ t: 'input', ...held })
        } else if (m.t === 'error') {
          done = true
          setFatal(m.message)
        } else onSnapshot(m)
      }
      ws.onclose = () => {
        if (stopped || done) return
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
      send({ t: 'input', ...held })
    }
    const kd = onKey(true)
    const ku = onKey(false)
    const blur = () => {
      held.up = held.down = held.left = held.right = false
      send({ t: 'input', ...held })
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
      send({ t: 'fire', ...aim })
    }
    const mm = (e: MouseEvent) => {
      if (!canvas.current || !rend.current) return
      const w = toWorld(e)
      if (aim) aim = w
      const mine = tl.current.latest()?.players.find((p) => p.id === me.id)
      if (mine) rend.current.myAim = Math.atan2(w.y - mine.y, w.x - mine.x) // cosmetic: my gun follows the cursor
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
        send({ t: 'fire', ...aim })
      }
    }, 50)

    return () => {
      stopped = true
      clearTimeout(retry)
      ws.close()
      clearInterval(autofire)
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('blur', blur)
      window.removeEventListener('mousedown', md)
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', mu)
    }
  }, [match.match_id, me.id])

  // Render loop: canvas + the two per-frame HUD numbers, written straight to the DOM.
  useEffect(() => {
    const c = canvas.current
    if (!map || !c) return
    const dpr = window.devicePixelRatio || 1
    c.width = map.w * dpr
    c.height = map.h * dpr
    const ctx = c.getContext('2d')!
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      rend.current?.draw(ctx, tl.current)
      const s = tl.current.latest()
      if (!s) return
      const t = tl.current.renderTime()
      if (timerEl.current) timerEl.current.textContent = clock(s.state === 'ENDED' ? s.elapsed : s.elapsed - (s.now - t))
      const mine = s.players.find((p) => p.id === me.id)
      if (respawnEl.current && mine?.respawnAt) respawnEl.current.textContent = Math.max(0, (mine.respawnAt - t) / 1000).toFixed(1)
    }
    frame()
    return () => cancelAnimationFrame(raf)
  }, [map, me.id])

  useEffect(() => {
    if (!banner) return
    const t = setTimeout(() => setBanner((b) => (b?.id === banner.id ? null : b)), 1800)
    return () => clearTimeout(t)
  }, [banner])

  const mode = `${match.teams[0].players.length}v${match.teams[1].players.length}`
  const won = hud?.winner && hud.winner === hud.myTeam

  const teamPanel = (team: Team) => {
    const flag = hud?.flags[team] ?? 'AT_BASE'
    const right = team === 'BLUE'
    return (
      <div className={`flex min-w-0 flex-1 items-center gap-3 ${right ? 'flex-row-reverse text-right' : ''}`}>
        <span className="size-3 shrink-0 rounded-full shadow-[0_0_12px_currentColor]" style={{ color: COLOR[team], background: COLOR[team] }} />
        <div className="min-w-0">
          <p className="font-display text-lg leading-none font-bold tracking-[0.18em]" style={{ color: COLOR[team] }}>
            {team}
          </p>
          <div className={`mt-1.5 flex gap-1 ${right ? 'justify-end' : ''}`} aria-label={`${team} players alive`}>
            {(hud?.roster[team] ?? []).map((p) => (
              <span
                key={p.id}
                className={`size-2.5 rounded-full border transition ${p.connected ? '' : 'opacity-40'}`}
                style={{ borderColor: COLOR[team], background: p.alive ? COLOR[team] : 'transparent' }}
              />
            ))}
          </div>
        </div>
        <span
          className={`rounded-md border px-2 py-1 font-display text-[10px] font-bold tracking-widest uppercase ${flag === 'AT_BASE' ? 'border-white/10 text-ink-300' : 'animate-pulse'}`}
          style={flag === 'AT_BASE' ? undefined : { borderColor: COLOR[team], color: COLOR[team] }}
        >
          {FLAG_LABEL[flag]}
        </span>
      </div>
    )
  }

  return (
    <section className="panel relative flex min-h-[calc(100vh-8rem)] flex-col items-center gap-3 p-3 select-none sm:p-4">
      {/* Top bar: teams · clock · teams */}
      <div className="flex w-full items-center gap-4 rounded-xl border border-white/[0.07] bg-ink-900/80 px-4 py-2.5" style={{ maxWidth: 'calc((100vh - 13rem) * 12 / 7)' }}>
        {teamPanel('RED')}
        <div className="shrink-0 text-center">
          <p className="label !text-[9px]">Capture the flag · {mode}</p>
          <span ref={timerEl} className="font-display text-2xl font-bold tracking-widest text-ink-100 tabular-nums">
            00:00
          </span>
        </div>
        {teamPanel('BLUE')}
      </div>

      <div className="relative w-full" style={{ maxWidth: 'calc((100vh - 13rem) * 12 / 7)' }}>
        <canvas
          ref={canvas}
          onContextMenu={(e) => e.preventDefault()}
          className="block aspect-[12/7] w-full cursor-crosshair rounded-xl border border-white/10 bg-ink-950 shadow-2xl"
        />

        {/* event banner */}
        {banner && (
          <div key={banner.id} className="pointer-events-none absolute inset-x-0 top-6 flex justify-center">
            <span
              className="animate-pop rounded-lg border bg-ink-950/80 px-5 py-2 font-display text-lg font-bold tracking-[0.2em] backdrop-blur"
              style={{ color: COLOR[banner.team], borderColor: COLOR[banner.team] + '66' }}
            >
              <Dot team={banner.team} /> <span className="ml-1.5">{banner.text}</span>
            </span>
          </div>
        )}

        {/* kill feed */}
        <div className="pointer-events-none absolute top-3 right-3 flex flex-col items-end gap-1">
          {feed.map((n) => (
            <span key={n.id} className="animate-rise rounded bg-ink-950/75 px-2 py-1 text-xs font-semibold">
              <span style={{ color: COLOR[n.team] }}>✕</span> {n.text}
            </span>
          ))}
        </div>

        {/* bottom-left: my status */}
        {hud?.myTeam && !hud.ended && (
          <div className="pointer-events-none absolute bottom-3 left-3 flex items-end gap-3">
            <div className="rounded-lg bg-ink-950/75 px-3 py-2 backdrop-blur">
              <p className="label !text-[9px]">Health</p>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-2 w-32 overflow-hidden rounded bg-white/10">
                  <div
                    className="h-full rounded transition-all duration-200"
                    style={{ width: `${hud.myHp}%`, background: hud.myHp > 50 ? '#3ddc84' : hud.myHp > 25 ? '#f5b83d' : '#f0506e' }}
                  />
                </div>
                <span className="font-display text-sm font-bold tabular-nums">{hud.myHp}</span>
              </div>
            </div>
            {hud.carrying && (
              <span
                className="animate-pulse rounded-lg border bg-ink-950/75 px-3 py-2 font-display text-sm font-bold tracking-widest"
                style={{ color: COLOR[hud.carrying], borderColor: COLOR[hud.carrying] }}
              >
                🚩 {hud.carrying} FLAG{hud.flags[hud.myTeam] !== 'AT_BASE' && <span className="ml-2 text-[10px] text-ink-300">· your flag must be home</span>}
              </span>
            )}
          </div>
        )}

        <button
          onClick={() => (setMuted(!muted), setMutedUi(!muted))}
          className="absolute right-3 bottom-3 rounded-md bg-ink-950/70 px-2 py-1 text-xs text-ink-300 hover:text-ink-100"
          aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        >
          {muted ? '🔇' : '🔊'}
        </button>

        {!hud && !fatal && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3">
              <span className="size-8 animate-spin rounded-full border-2 border-ink-600 border-t-gold" />
              <p className="font-display tracking-widest text-ink-300 uppercase">Connecting to match server…</p>
            </div>
          </div>
        )}
        {conn === 'reconnecting' && !fatal && hud && !hud.ended && (
          <div className="absolute inset-x-0 top-16 flex justify-center">
            <span className="animate-pulse rounded-lg bg-ink-950/85 px-4 py-2 font-display text-sm tracking-widest text-gold uppercase">Reconnecting…</span>
          </div>
        )}

        {hud && !hud.myAlive && !hud.ended && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-[radial-gradient(ellipse_at_center,transparent_30%,rgb(0_0_0/0.65))]">
            <div className="animate-pop text-center">
              <p className="font-display text-3xl font-bold tracking-[0.25em] text-foe">YOU ARE DOWN</p>
              <span ref={respawnEl} className="mt-2 block font-display text-6xl font-bold text-ink-100 tabular-nums">
                3.0
              </span>
              <p className="mt-1 font-display text-sm tracking-[0.3em] text-ink-300">RESPAWNING…</p>
            </div>
          </div>
        )}

        {(hud?.ended || fatal) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 rounded-xl bg-ink-950/75 text-center backdrop-blur-sm">
            {hud?.winner ? (
              <div className="animate-pop">
                {hud.myTeam && <p className="font-display text-sm tracking-[0.4em] text-ink-300">{won ? 'VICTORY' : 'DEFEAT'}</p>}
                <h1 className="mt-2 font-display text-5xl font-bold tracking-[0.14em] sm:text-6xl" style={{ color: COLOR[hud.winner], textShadow: `0 0 40px ${COLOR[hud.winner]}88` }}>
                  <Dot team={hud.winner} size={28} /> <span className="ml-2">{hud.winner} TEAM</span>
                </h1>
                <p className="font-display text-4xl font-bold tracking-[0.3em] text-ink-100">WINS</p>
                <p className="mt-4 font-display text-sm tracking-[0.25em] text-ink-300">FLAG CAPTURED{capturer ? ` · ${capturer}` : ''}</p>
              </div>
            ) : (
              <p className="max-w-md font-display text-xl tracking-wider text-ink-100">{fatal}</p>
            )}
            <button onClick={onExit} className="btn-gold px-10 py-3 tracking-widest">
              RETURN TO HUB
            </button>
          </div>
        )}
      </div>

      <p className="text-xs text-ink-400">
        <b className="text-ink-300">WASD</b> move · <b className="text-ink-300">Left click</b> shoot · Grab the enemy flag and bring it home while your own flag is at base
      </p>
    </section>
  )
}
