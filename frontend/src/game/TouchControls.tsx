import { useRef, type PointerEvent, type RefObject } from 'react'

/* Touch input for phones in landscape: a floating move stick on the left, a floating aim-and-fire stick on
   the right (drag out to shoot) and a skill button. Pure view: Game wires the callbacks to the same intents
   the keyboard and mouse send. Knob movement is written straight to the DOM, so dragging never re-renders. */

export interface TouchApi {
  move(x: number, y: number): void // unit-circle vector, (0,0) = released
  aim(x: number, y: number): void
  skill(): void
}

const R = 50 // knob travel in px

function Stick({ side, label, onChange }: { side: 'l' | 'r'; label: string; onChange: (x: number, y: number) => void }) {
  const zone = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLElement>(null)
  const pid = useRef<number | null>(null)
  const origin = useRef({ x: 0, y: 0 })

  const drag = (e: PointerEvent) => {
    let dx = e.clientX - origin.current.x
    let dy = e.clientY - origin.current.y
    const d = Math.hypot(dx, dy)
    if (d > R) [dx, dy] = [(dx * R) / d, (dy * R) / d]
    knob.current!.style.transform = `translate(${dx}px, ${dy}px)`
    onChange(dx / R, dy / R)
  }
  const release = (e: PointerEvent) => {
    if (e.pointerId !== pid.current) return
    pid.current = null
    base.current!.classList.remove('is-held')
    base.current!.style.left = base.current!.style.top = ''
    knob.current!.style.transform = ''
    onChange(0, 0)
  }

  return (
    <div
      ref={zone}
      className={`g-zone is-${side}`}
      aria-label={label}
      onPointerDown={(e) => {
        if (pid.current !== null) return
        e.preventDefault() // also keeps the browser from firing compatibility mouse events
        pid.current = e.pointerId
        e.currentTarget.setPointerCapture(e.pointerId)
        const z = zone.current!.getBoundingClientRect()
        origin.current = { x: e.clientX, y: e.clientY }
        base.current!.classList.add('is-held')
        base.current!.style.left = `${e.clientX - z.left}px`
        base.current!.style.top = `${e.clientY - z.top}px`
        drag(e)
      }}
      onPointerMove={(e) => e.pointerId === pid.current && drag(e)}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div ref={base} className="g-stick">
        <i ref={knob} />
      </div>
    </div>
  )
}

export function TouchControls({ api, skillRef, skillName }: { api: RefObject<TouchApi | null>; skillRef: RefObject<HTMLButtonElement | null>; skillName: string }) {
  return (
    <div className="g-touch">
      <Stick side="l" label="Move" onChange={(x, y) => api.current?.move(x, y)} />
      <Stick side="r" label="Aim and shoot" onChange={(x, y) => api.current?.aim(x, y)} />
      <button ref={skillRef} className="g-skill" onPointerDown={(e) => (e.preventDefault(), api.current?.skill())} aria-label={`Use skill: ${skillName}`}>
        <span>{skillName.toLowerCase()}</span>
      </button>
    </div>
  )
}
