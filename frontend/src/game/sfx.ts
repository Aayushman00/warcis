/* Tiny WebAudio synth for game sounds: no asset files, nothing to load. The context is
   created on the first user gesture (browsers block audio before that). */

let ctx: AudioContext | null = null
let muted = (() => {
  try {
    return localStorage.getItem('warcis.muted') === '1'
  } catch {
    return false
  }
})()

export const isMuted = () => muted
export function setMuted(m: boolean) {
  muted = m
  try {
    localStorage.setItem('warcis.muted', m ? '1' : '0')
  } catch {
    /* private mode */
  }
}

export function unlockAudio() {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
}

function tone(freq: number, dur: number, { type = 'square' as OscillatorType, vol = 0.08, to = freq, delay = 0 } = {}) {
  if (!ctx || muted) return
  const t0 = ctx.currentTime + delay
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t0)
  o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur)
  g.gain.setValueAtTime(vol, t0)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(g).connect(ctx.destination)
  o.start(t0)
  o.stop(t0 + dur + 0.02)
}

function noise(dur: number, vol: number) {
  if (!ctx || muted) return
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length)
  const src = ctx.createBufferSource()
  const g = ctx.createGain()
  g.gain.value = vol
  src.buffer = buf
  src.connect(g).connect(ctx.destination)
  src.start()
}

let lastShot = 0
export const sfx = {
  shoot(mine: boolean) {
    const now = performance.now()
    if (!mine && now - lastShot < 60) return // don't stack a wall of sound in 4v4
    lastShot = now
    tone(mine ? 880 : 660, 0.07, { vol: mine ? 0.05 : 0.018, to: 220 })
  },
  hit(mine: boolean) {
    noise(0.06, mine ? 0.25 : 0.08)
    if (mine) tone(160, 0.12, { type: 'sawtooth', vol: 0.06, to: 80 })
  },
  death(mine: boolean) {
    tone(mine ? 420 : 300, mine ? 0.5 : 0.25, { type: 'triangle', vol: mine ? 0.14 : 0.05, to: 60 })
  },
  pickup() {
    ;[523, 659, 784].forEach((f, i) => tone(f, 0.09, { type: 'triangle', vol: 0.08, delay: i * 0.07 }))
  },
  flagDrop() {
    tone(392, 0.12, { type: 'triangle', vol: 0.07, to: 262 })
  },
  countdown(go: boolean) {
    tone(go ? 988 : 587, go ? 0.3 : 0.1, { type: 'square', vol: go ? 0.06 : 0.045 })
  },
  flagReturn() {
    tone(784, 0.1, { type: 'sine', vol: 0.09 })
    tone(523, 0.16, { type: 'sine', vol: 0.09, delay: 0.1 })
  },
  win(won: boolean) {
    const notes = won ? [523, 659, 784, 1047] : [440, 392, 330, 262]
    notes.forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.12, delay: i * 0.14 }))
  },
}
