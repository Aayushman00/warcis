/* Classes and weapons as the player sees them: names, pitches, builds, and the avatar and weapon drawings shared
   by the match lobby and the arena. Numbers (HP, cooldowns, damage) are the server's: the arena HUD gets them from
   the `hello` catalog. The lobby's 1-5 ratings below are qualitative copy (how the options compare), not a second
   set of balance values; keep their order in line with sim.py if the balance changes. */

import type { ClassId, WeaponId } from '../api'

export const CLASS_IDS: ClassId[] = ['ASSAULTER', 'GUARDIAN', 'ASSASSIN']
export const WEAPON_IDS: WeaponId[] = ['ASSAULT_RIFLE', 'SHOTGUN', 'SNIPER_RIFLE']

export type Rating = 1 | 2 | 3 | 4 | 5

export const CLASS_INFO: Record<
  ClassId,
  { name: string; short: string; role: string; traits: string; q: string; qName: string; health: Rating; tempo: Rating; tagline: string }
> = {
  ASSAULTER: {
    name: 'Assaulter', short: 'ASL', role: 'Striker', traits: 'Low health · fast trigger', qName: 'Dash',
    q: 'Dash a short distance. You can still be hit while dashing.', health: 2, tempo: 5,
    tagline: 'Hit first, hit fast, be gone before they turn.',
  },
  GUARDIAN: {
    name: 'Guardian', short: 'GRD', role: 'Anchor', traits: 'High health', qName: 'Barrier',
    q: 'Deploy a destructible barrier that blocks enemy shots.', health: 5, tempo: 3,
    tagline: 'Hold the line. Nothing gets through.',
  },
  ASSASSIN: {
    name: 'Assassin', short: 'ASN', role: 'Infiltrator', traits: 'Steady health', qName: 'Cloak',
    q: 'Turn invisible. Taking damage or firing reveals you.', health: 3, tempo: 3,
    tagline: 'They never see the flag leave.',
  },
}

export const WEAPON_INFO: Record<WeaponId, { name: string; pitch: string; damage: Rating; rate: Rating; range: Rating }> = {
  ASSAULT_RIFLE: { name: 'Assault Rifle', pitch: 'Balanced automatic fire', damage: 2, rate: 5, range: 3 },
  SHOTGUN: { name: 'Shotgun', pitch: 'Many pellets, deadly up close', damage: 4, rate: 2, range: 1 },
  SNIPER_RIFLE: { name: 'Sniper Rifle', pitch: 'Slow, powerful, long range', damage: 5, rate: 1, range: 5 },
}

/** Every class + weapon pair has a name: the lobby shows what you are building, not two separate picks. */
export const BUILD: Record<ClassId, Record<WeaponId, string>> = {
  ASSAULTER: { ASSAULT_RIFLE: 'Raider', SHOTGUN: 'Breacher', SNIPER_RIFLE: 'Hunter' },
  GUARDIAN: { ASSAULT_RIFLE: 'Bulwark', SHOTGUN: 'Juggernaut', SNIPER_RIFLE: 'Sentinel' },
  ASSASSIN: { ASSAULT_RIFLE: 'Shadow', SHOTGUN: 'Reaper', SNIPER_RIFLE: 'Phantom' },
}

export type Palette = { base: string; light: string; deep: string; ink: string }

const OUTLINE = '#0B1017'
const TAU = Math.PI * 2

/** Body outline in local space (+x = facing), radius r: a distinct silhouette per class, same footprint as the hitbox. */
function bodyPath(ctx: CanvasRenderingContext2D, cls: ClassId, r: number, grow = 0) {
  const R = r + grow
  ctx.beginPath()
  if (cls === 'ASSAULTER') {
    // arrowhead: lean and forward-leaning
    const pts: [number, number][] = [[1.18, 0], [0.25, -0.95], [-0.95, -0.72], [-0.55, 0], [-0.95, 0.72], [0.25, 0.95]]
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * R, y * R) : ctx.moveTo(x * R, y * R)))
    ctx.closePath()
  } else if (cls === 'GUARDIAN') {
    // heavy hexagon
    hexPath(ctx, R * 1.12)
  } else {
    // hooded teardrop: round head, tail behind
    ctx.arc(0.05 * R, 0, R * 0.88, 0, TAU)
    ctx.moveTo(-0.5 * R, -0.7 * R)
    ctx.lineTo(-1.55 * R, 0)
    ctx.lineTo(-0.5 * R, 0.7 * R)
    ctx.closePath()
  }
}

function hexPath(ctx: CanvasRenderingContext2D, rad: number, x = 0) {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3
    if (i) ctx.lineTo(x + Math.cos(a) * rad, Math.sin(a) * rad)
    else ctx.moveTo(x + Math.cos(a) * rad, Math.sin(a) * rad)
  }
  ctx.closePath()
}

/** A lit shape: soft bloom in the team's light color, so visors and cores read as emissive. */
function glow(ctx: CanvasRenderingContext2D, col: string, blur: number, draw: () => void) {
  ctx.save()
  ctx.shadowColor = col
  ctx.shadowBlur = blur
  draw()
  ctx.restore()
}

/**
 * Draws one class avatar at the origin facing +x. Team color stays the body fill so allies and enemies read first;
 * the class shows in the silhouette and in its lit details. `t` (ms) drives the idle animation: thruster flicker,
 * shield shimmer, the cloak's eye pulse. Respects the caller's globalAlpha (dead / invisible / offline dimming).
 */
export function drawAvatar(ctx: CanvasRenderingContext2D, cls: ClassId, c: Palette, r: number, breathe = 1, t = 0) {
  const R = r * breathe
  const pulse = 0.5 + 0.5 * Math.sin(t / 260)

  // Assaulter thrusters burn behind the body, so they go first.
  if (cls === 'ASSAULTER') {
    for (const s of [-1, 1]) {
      const len = R * (0.42 + 0.16 * Math.sin(t / 37 + s * 1.7) + 0.08 * Math.sin(t / 13 + s))
      const g = ctx.createLinearGradient(-R * 0.75, 0, -R * 0.75 - len, 0)
      g.addColorStop(0, c.ink)
      g.addColorStop(0.35, c.light)
      g.addColorStop(1, c.light + '00')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(-R * 0.72, s * R * 0.3)
      ctx.lineTo(-R * 0.75 - len, s * R * 0.42)
      ctx.lineTo(-R * 0.72, s * R * 0.56)
      ctx.closePath()
      ctx.fill()
    }
  }
  // Assassin cape: a fading wisp off the tail.
  if (cls === 'ASSASSIN') {
    const sway = Math.sin(t / 330) * R * 0.18
    const g = ctx.createLinearGradient(-R * 1.2, 0, -R * 2.3, 0)
    g.addColorStop(0, c.deep)
    g.addColorStop(1, c.deep + '00')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(-R * 1.1, -R * 0.32)
    ctx.quadraticCurveTo(-R * 1.8, -R * 0.2 + sway, -R * 2.3, sway * 1.6)
    ctx.quadraticCurveTo(-R * 1.8, R * 0.2 + sway, -R * 1.1, R * 0.32)
    ctx.closePath()
    ctx.fill()
  }

  // Outline, then the body in the team gradient.
  ctx.fillStyle = OUTLINE
  bodyPath(ctx, cls, R, 1.5)
  ctx.fill()
  const g = ctx.createRadialGradient(-R * 0.35, -R * 0.35, 1, 0, 0, R * 1.25)
  g.addColorStop(0, c.light)
  g.addColorStop(0.5, c.base)
  g.addColorStop(1, c.deep)
  ctx.fillStyle = g
  bodyPath(ctx, cls, R)
  ctx.fill()

  // Armor: a darker inner plate and its seam, so the body reads as a suit rather than a flat token.
  ctx.save()
  bodyPath(ctx, cls, R)
  ctx.clip()
  ctx.fillStyle = c.deep + '66'
  if (cls === 'ASSAULTER') {
    ctx.beginPath()
    ctx.moveTo(-R * 0.55, 0)
    ctx.lineTo(-R * 0.95, -R * 0.72)
    ctx.lineTo(-R * 0.15, -R * 0.55)
    ctx.lineTo(R * 0.05, 0)
    ctx.lineTo(-R * 0.15, R * 0.55)
    ctx.lineTo(-R * 0.95, R * 0.72)
    ctx.closePath()
    ctx.fill()
  } else if (cls === 'GUARDIAN') {
    hexPath(ctx, R * 0.62, -R * 0.12)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.arc(-R * 0.15, 0, R * 0.62, Math.PI * 0.5, Math.PI * 1.5)
    ctx.lineTo(-R * 1.55, 0)
    ctx.closePath()
    ctx.fill()
  }
  // specular sweep across the top-left
  const spec = ctx.createLinearGradient(-R, -R, R * 0.2, R * 0.2)
  spec.addColorStop(0, '#ffffff55')
  spec.addColorStop(0.45, '#ffffff00')
  ctx.fillStyle = spec
  ctx.fillRect(-R * 2, -R * 2, R * 4, R * 4)
  ctx.restore()

  // Rim light: a thin lit edge on the upper side.
  ctx.save()
  const rim = ctx.createLinearGradient(0, -R * 1.2, 0, R * 0.6)
  rim.addColorStop(0, c.ink + 'cc')
  rim.addColorStop(1, c.ink + '00')
  ctx.strokeStyle = rim
  ctx.lineWidth = Math.max(0.8, R * 0.07)
  bodyPath(ctx, cls, R - 0.6)
  ctx.stroke()
  ctx.restore()

  const blur = R * 0.55
  if (cls === 'ASSAULTER') {
    // chevron visor, lit
    ctx.fillStyle = OUTLINE
    ctx.beginPath()
    ctx.moveTo(R * 0.78, 0)
    ctx.lineTo(R * 0.06, -R * 0.56)
    ctx.lineTo(R * 0.28, -R * 0.56)
    ctx.lineTo(R * 0.95, 0)
    ctx.lineTo(R * 0.28, R * 0.56)
    ctx.lineTo(R * 0.06, R * 0.56)
    ctx.closePath()
    ctx.fill()
    glow(ctx, c.light, blur, () => {
      ctx.fillStyle = c.ink
      ctx.beginPath()
      ctx.moveTo(R * 0.74, 0)
      ctx.lineTo(R * 0.18, -R * 0.44)
      ctx.lineTo(R * 0.26, -R * 0.44)
      ctx.lineTo(R * 0.84, 0)
      ctx.lineTo(R * 0.26, R * 0.44)
      ctx.lineTo(R * 0.18, R * 0.44)
      ctx.closePath()
      ctx.fill()
    })
  } else if (cls === 'GUARDIAN') {
    // power core in the chest plate
    glow(ctx, c.light, blur * (0.6 + 0.6 * pulse), () => {
      ctx.fillStyle = c.ink
      ctx.globalAlpha *= 0.65 + 0.35 * pulse
      hexPath(ctx, R * 0.2, -R * 0.12)
      ctx.fill()
    })
    // wide visor
    ctx.fillStyle = OUTLINE
    ctx.beginPath()
    ctx.roundRect(R * 0.22, -R * 0.6, R * 0.42, R * 1.2, R * 0.12)
    ctx.fill()
    glow(ctx, c.light, blur, () => {
      ctx.fillStyle = c.ink
      ctx.fillRect(R * 0.38, -R * 0.44, R * 0.12, R * 0.88)
    })
    // shield arc on the front, shimmering
    ctx.lineCap = 'round'
    ctx.strokeStyle = OUTLINE
    ctx.lineWidth = Math.max(3, R * 0.3)
    ctx.beginPath()
    ctx.arc(0, 0, R * 1.34, -0.78, 0.78)
    ctx.stroke()
    glow(ctx, c.light, blur * (0.5 + pulse), () => {
      const sg = ctx.createLinearGradient(R * 1.2, -R, R * 1.2, R)
      const k = (t / 1400) % 1
      sg.addColorStop(0, c.light)
      sg.addColorStop(Math.max(0, k - 0.12), c.light)
      sg.addColorStop(k, c.ink)
      sg.addColorStop(Math.min(1, k + 0.12), c.light)
      sg.addColorStop(1, c.light)
      ctx.strokeStyle = sg
      ctx.lineWidth = Math.max(2, R * 0.18)
      ctx.beginPath()
      ctx.arc(0, 0, R * 1.34, -0.74, 0.74)
      ctx.stroke()
    })
    ctx.lineCap = 'butt'
  } else {
    // hood rim along the back of the head
    ctx.strokeStyle = c.deep
    ctx.lineWidth = Math.max(1.2, R * 0.14)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(0.05 * R, 0, R * 0.66, Math.PI * 0.62, Math.PI * 1.38)
    ctx.stroke()
    ctx.lineCap = 'butt'
    // narrow slit with a lit eye that breathes
    ctx.fillStyle = OUTLINE
    ctx.beginPath()
    ctx.ellipse(R * 0.45, 0, R * 0.17, R * 0.55, 0, 0, TAU)
    ctx.fill()
    glow(ctx, c.light, blur * (0.7 + 0.8 * pulse), () => {
      ctx.fillStyle = c.ink
      ctx.globalAlpha *= 0.7 + 0.3 * pulse
      ctx.beginPath()
      ctx.ellipse(R * 0.48, -R * 0.12, R * 0.07, R * 0.24, 0, 0, TAU)
      ctx.fill()
    })
  }
}

/** Barrel length and thickness per weapon at player radius R: the arena's muzzle flash sits at the tip. */
export function gunOf(weapon: WeaponId, R: number) {
  return weapon === 'SHOTGUN' ? { len: R + 1, w: 9 } : weapon === 'SNIPER_RIFLE' ? { len: R + 20, w: 4.4 } : { len: R + 6, w: 7 }
}

/** The held weapon, local space facing +x, drawn under the body. `recoil` (px) kicks it back. */
export function drawWeapon(ctx: CanvasRenderingContext2D, weapon: WeaponId, c: Palette, R: number, recoil = 0) {
  const { len, w } = gunOf(weapon, R)
  const x0 = R * 0.2 - recoil
  ctx.fillStyle = OUTLINE
  ctx.beginPath()
  ctx.roundRect(x0, -w / 2, len, w, 2)
  ctx.fill()
  ctx.fillStyle = '#3A4557'
  ctx.fillRect(x0 + 2, -w / 2, len - 4, 2) // top highlight
  ctx.fillStyle = c.base
  if (weapon === 'SNIPER_RIFLE') {
    ctx.fillStyle = OUTLINE
    ctx.beginPath()
    ctx.roundRect(x0 + 5, -w / 2 - 4, 11, 4, 1.5) // scope
    ctx.fill()
    ctx.fillStyle = c.light
    ctx.fillRect(x0 + 14, -w / 2 - 3.2, 1.6, 2.4) // lens glint
    ctx.fillStyle = '#3A4557'
    ctx.fillRect(x0 + len - 3, -w / 2 - 0.6, 3, w + 1.2) // muzzle brake
  } else if (weapon === 'SHOTGUN') {
    ctx.fillStyle = '#3A4557'
    ctx.fillRect(x0 + 4, -1, len - 6, 2) // second bore
    ctx.fillStyle = c.deep
    ctx.fillRect(x0 + 3, -w / 2 + 0.5, 3, w - 1) // pump grip
  } else {
    ctx.fillStyle = OUTLINE
    ctx.fillRect(x0 + 6, w / 2 - 1, 3.5, 4) // magazine
    ctx.fillStyle = c.base
    ctx.fillRect(x0 + len - 7, -0.6, 4, 1.2) // tracer stripe
  }
}
