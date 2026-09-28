import { useEffect, useRef, useState } from 'react'
import { token, type MatchDTO } from './api'
import type { Player } from './data'

/* Server messages (services/game-service). The server is authoritative; this file only
   sends intents (held keys, aim point) and draws whatever state it is told. */
type Team = 'RED' | 'BLUE'
type GPlayer = { id: string; name: string; team: Team; x: number; y: number; hp: number; alive: boolean; respawnAt: number | null; carryingFlag: boolean; connected: boolean }
type GFlag = { team: Team; x: number; y: number; state: 'AT_BASE' | 'CARRIED' | 'DROPPED'; carrierId: string | null }
type Snapshot = {
  t: 'state'
  now: number
  elapsed: number
  state: 'PLAYING' | 'ENDED'
  winner: Team | null
  players: GPlayer[]
  flags: GFlag[]
  shots: { id: number; team: Team; x: number; y: number }[]
}
type GMap = { w: number; h: number; walls: [number, number, number, number][]; bases: { team: Team; x: number; y: number; r: number }[]; playerR: number; shotR: number }
type Msg = Snapshot | { t: 'hello'; you: string; map: GMap } | { t: 'error'; code: string; message: string }

const COLOR: Record<Team, string> = { RED: '#ef4444', BLUE: '#3b82f6' }
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
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function Game({ match, me, onExit }: { match: MatchDTO; me: Player; onExit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const snap = useRef<Snapshot | null>(null)
  const [map, setMap] = useState<GMap | null>(null)
  const [hud, setHud] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/game/ws/${match.match_id}?token=${encodeURIComponent(token.get() ?? '')}`)
    const send = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    let gotHello = false

    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as Msg
      if (m.t === 'hello') {
        gotHello = true
        setMap(m.map)
      } else if (m.t === 'error') setError(m.message)
      else {
        snap.current = m
        setHud(m)
      }
    }
    ws.onclose = () => {
      if (!gotHello) setError((prev) => prev ?? 'Could not connect to the match server.')
      else if (snap.current?.state !== 'ENDED') setError('Disconnected from the match server.')
    }

    // Movement intent: send the held-key set whenever it changes.
    const held = { up: false, down: false, left: false, right: false }
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
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
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)

    // Fire intent: aim point in world coords while LMB is held; the server enforces the cooldown.
    let aim: { x: number; y: number } | null = null
    let lastFire = 0
    const toWorld = (e: MouseEvent) => {
      const c = canvas.current!
      const r = c.getBoundingClientRect()
      return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }
    }
    const md = (e: MouseEvent) => {
      if (e.button !== 0 || e.target !== canvas.current) return
      aim = toWorld(e)
      lastFire = Date.now()
      send({ t: 'fire', ...aim })
    }
    const mm = (e: MouseEvent) => aim && canvas.current && (aim = toWorld(e))
    const mu = (e: MouseEvent) => e.button === 0 && (aim = null)
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
      ws.close()
      clearInterval(autofire)
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('blur', blur)
      window.removeEventListener('mousedown', md)
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', mu)
    }
  }, [match.match_id])

  // Draw the latest server snapshot every frame.
  useEffect(() => {
    if (!map) return
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const ctx = canvas.current?.getContext('2d')
      const s = snap.current
      if (!ctx) return
      ctx.fillStyle = '#10131b'
      ctx.fillRect(0, 0, map.w, map.h)
      for (const b of map.bases) {
        ctx.fillStyle = COLOR[b.team] + '22'
        ctx.strokeStyle = COLOR[b.team] + '88'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      ctx.fillStyle = '#2a3142'
      for (const [x, y, w, h] of map.walls) ctx.fillRect(x, y, w, h)
      if (!s) return

      for (const f of s.flags) {
        if (f.state !== 'CARRIED') drawFlag(ctx, f.x, f.y, f.team, f.state === 'DROPPED')
      }
      ctx.textAlign = 'center'
      ctx.font = '12px Inter, sans-serif'
      for (const p of s.players) {
        if (!p.alive) continue
        ctx.globalAlpha = p.connected ? 1 : 0.35 // never connected (bot) or dropped: placeholder, no input
        ctx.fillStyle = COLOR[p.team]
        ctx.beginPath()
        ctx.arc(p.x, p.y, map.playerR, 0, Math.PI * 2)
        ctx.fill()
        if (p.id === me.id) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 3
          ctx.stroke()
        }
        ctx.fillStyle = '#000a'
        ctx.fillRect(p.x - 16, p.y - map.playerR - 10, 32, 4)
        ctx.fillStyle = '#3ddc84'
        ctx.fillRect(p.x - 16, p.y - map.playerR - 10, (32 * p.hp) / 100, 4)
        ctx.fillStyle = '#e6e9f2'
        ctx.fillText(p.connected ? p.name : `${p.name} (offline)`, p.x, p.y + map.playerR + 14)
        ctx.globalAlpha = 1
        if (p.carryingFlag) drawFlag(ctx, p.x + 10, p.y - 8, p.team === 'RED' ? 'BLUE' : 'RED', false)
      }
      for (const b of s.shots) {
        ctx.fillStyle = COLOR[b.team]
        ctx.beginPath()
        ctx.arc(b.x, b.y, map.shotR, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [map, me.id])

  const mine = hud?.players.find((p) => p.id === me.id)
  const alive = (t: Team) => hud?.players.filter((p) => p.team === t && p.alive).length ?? 0
  const respawnIn = mine && !mine.alive && mine.respawnAt != null && hud ? Math.max(0, Math.ceil((mine.respawnAt - hud.now) / 1000)) : null
  const enemy: Team = mine?.team === 'RED' ? 'BLUE' : 'RED'

  return (
    <section className="panel relative flex min-h-[calc(100vh-8rem)] flex-col items-center gap-3 p-4 select-none">
      <p className="label">CTF MVP · {match.teams[0].players.length}v{match.teams[1].players.length}</p>
      <div className="flex w-full max-w-md items-center justify-between font-display text-lg font-bold tracking-wider">
        <span style={{ color: COLOR.RED }}>RED: {alive('RED')}</span>
        <span className="text-ink-300 tabular-nums">TIME: {hud ? clock(hud.elapsed) : '--'}</span>
        <span style={{ color: COLOR.BLUE }}>BLUE: {alive('BLUE')}</span>
      </div>

      <div className="relative w-full" style={{ maxWidth: 'calc((100vh - 14rem) * 12 / 7)' }}>
        <canvas
          ref={canvas}
          width={map?.w ?? 1200}
          height={map?.h ?? 700}
          onContextMenu={(e) => e.preventDefault()}
          className="block w-full cursor-crosshair rounded-xl border border-white/10"
        />
        {!hud && !error && (
          <div className="absolute inset-0 grid place-items-center font-display tracking-widest text-ink-300 uppercase">Connecting to match server…</div>
        )}
        {mine && !mine.alive && hud?.state === 'PLAYING' && (
          <div className="absolute inset-0 grid place-items-center bg-black/40 font-display text-3xl font-bold tracking-widest">RESPAWNING… {respawnIn}</div>
        )}
        {(hud?.state === 'ENDED' || error) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-xl bg-black/70 text-center">
            {hud?.winner ? (
              <h1 className="font-display text-5xl font-bold tracking-[0.12em]" style={{ color: COLOR[hud.winner] }}>
                {hud.winner} TEAM WINS
              </h1>
            ) : (
              <p className="max-w-md text-ink-300">{error}</p>
            )}
            <button onClick={onExit} className="btn-gold px-8 py-3">
              Return to hub
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-6 font-display text-lg font-bold tracking-wider">
        {mine && <span>HP: {mine.hp}</span>}
        {mine?.carryingFlag && <span style={{ color: COLOR[enemy] }}>🚩 {enemy} FLAG</span>}
      </div>
      <p className="text-xs text-ink-400">WASD to move · Left click to shoot · Grab the enemy flag and bring it home while your flag is at base</p>
    </section>
  )
}

function drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, team: Team, dropped: boolean) {
  ctx.strokeStyle = '#e6e9f2'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y + 12)
  ctx.lineTo(x, y - 14)
  ctx.stroke()
  ctx.fillStyle = COLOR[team]
  ctx.globalAlpha = dropped ? 0.6 : 1
  ctx.beginPath()
  ctx.moveTo(x, y - 14)
  ctx.lineTo(x + 16, y - 8)
  ctx.lineTo(x, y - 2)
  ctx.fill()
  ctx.globalAlpha = 1
}
