// Self-check for the client predictor: node --experimental-strip-types src/game/predict.check.ts
import { Predictor, spawnTracers, stepTracer } from './predict.ts'

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

// My shots: drawn at once from where I am, same fan as the server, stopped by walls / blockers / their range.
const rifle = { speed: 700, pellets: 1, spread: 0, ttlMs: 1100 }
const [s] = spawnTracers({ x: 100, y: 100 }, { x: 200, y: 100 }, 'ASSAULT_RIFLE', rifle, 0)
assert.ok(stepTracer(s, 100, map, [], []) && Math.abs(s.x - 170) < 1e-9 && s.y === 100, `moved ${s.x}`)
assert.ok(!stepTracer(s, 1000, map, [], []) && s.x < 600 - 4 + 1e-9 && s.x > 590, `wall at x=600 stops it, got ${s.x}`)
const fan = spawnTracers({ x: 100, y: 100 }, { x: 200, y: 100 }, 'SHOTGUN', { speed: 650, pellets: 7, spread: 0.36, ttlMs: 420 }, 0)
assert.equal(fan.length, 7)
assert.ok(Math.abs(Math.atan2(fan[0].vy, fan[0].vx) + 0.18) < 1e-9 && Math.abs(Math.atan2(fan[6].vy, fan[6].vx) - 0.18) < 1e-9, 'fan spans the spread')
assert.equal(spawnTracers({ x: 1, y: 1 }, { x: 1, y: 1 }, 'SHOTGUN', rifle, 0).length, 0) // aim on myself: no shot, like the server
const [e] = spawnTracers({ x: 100, y: 300 }, { x: 200, y: 300 }, 'SNIPER_RIFLE', { speed: 1600, pellets: 1, spread: 0, ttlMs: 900 }, 0)
assert.ok(!stepTracer(e, 200, map, [], [{ x: 250, y: 300, r: 14 }]) && e.x <= 250 - 14 - 4 + 1e-9 && e.x > 225, `an enemy stops it, got ${e.x}`)
const [b] = spawnTracers({ x: 100, y: 500 }, { x: 200, y: 500 }, 'SNIPER_RIFLE', { speed: 1600, pellets: 1, spread: 0, ttlMs: 900 }, 0)
assert.ok(!stepTracer(b, 200, map, [[300, 450, 12, 90]], []), 'a 12 px barrier stops even a sniper round in one long frame')
const [r] = spawnTracers({ x: 100, y: 650 }, { x: 101, y: 650 }, 'ASSAULT_RIFLE', { ...rifle, speed: 100 }, 0)
assert.ok(stepTracer(r, 1099, map, [], []) && !stepTracer(r, 1101, map, [], []), 'range runs out at ttlMs')

console.log('predict ok')
