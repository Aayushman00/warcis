// Self-check for the client predictor: node --experimental-strip-types src/game/predict.check.ts
import { Predictor } from './predict.ts'

const assert = {
  ok(c: unknown, msg = 'check failed') {
    if (!c) throw new Error(msg)
  },
  equal: (a: unknown, b: unknown) => assert.ok(a === b, `${a} !== ${b}`),
  deepEqual: (a: unknown, b: unknown) => assert.ok(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`),
}

const map = { w: 1200, h: 700, walls: [[600, 0, 40, 700]] as [number, number, number, number][], bases: [], spawns: [], playerR: 14, shotR: 4 }
const run = (p: Predictor, from: number, to: number) => {
  for (let t = from; t <= to; t += 16) p.step(t)
}

// Moves at server speed the moment a key is held, without waiting for a snapshot.
let p = new Predictor(map)
p.step(0)
p.server(100, 350, true, 0)
p.dir = { x: 1, y: 0 }
run(p, 16, 1008)
assert.ok(Math.abs(p.pos!.x - (100 + 220 * 1.008)) < 1, `walked to ${p.pos!.x}`)

// Walls stop it exactly where the server's circle-vs-rect check would.
run(p, 1024, 4000)
assert.ok(p.pos!.x <= 600 - 14 && p.pos!.x > 600 - 14 - 4, `stopped at ${p.pos!.x}`)

// Frozen (intro / intermission): holding a key does not move.
p = new Predictor(map)
p.server(100, 350, false, 0)
p.dir = { x: 1, y: 0 }
run(p, 0, 500)
assert.equal(p.pos!.x, 100)

// A constant server offset is corrected once in total, never double-counted across snapshots.
p = new Predictor(map)
p.rtt = 100
p.server(100, 100, true, 0)
run(p, 0, 400)
for (let t = 400; t < 1400; t += 33) {
  run(p, t, t + 32)
  p.server(110, 100, true, t + 32) // server says I am 10 px right of where I stood
}
assert.ok(Math.abs(p.pos!.x - 110) < 0.5, `settled at ${p.pos!.x}`)

// Far off (round reset) jumps instead of sliding; dead clears.
p.server(900, 600, true, 2000)
assert.deepEqual(p.pos, { x: 900, y: 600 })
p.server(null, null, true, 2033)
assert.equal(p.pos, null)

console.log('predict ok')
