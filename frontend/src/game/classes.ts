/* Classes and weapons as the player sees them: names, one-line pitches, and the avatar drawing shared by
   the match lobby and the arena. Numbers (HP, cooldowns, damage) are the server's: the arena HUD gets them
   from the `hello` catalog, and the lobby copy stays qualitative so there is no second set of balance values. */

import type { ClassId, WeaponId } from '../api'

export const CLASS_IDS: ClassId[] = ['ASSAULTER', 'GUARDIAN', 'ASSASSIN']
export const WEAPON_IDS: WeaponId[] = ['ASSAULT_RIFLE', 'SHOTGUN', 'SNIPER_RIFLE']

export const CLASS_INFO: Record<ClassId, { name: string; short: string; traits: string; q: string; qName: string }> = {
  ASSAULTER: { name: 'Assaulter', short: 'ASL', traits: 'Low health · fast trigger', q: 'Dash a short distance. You can still be hit while dashing.', qName: 'Dash' },
  GUARDIAN: { name: 'Guardian', short: 'GRD', traits: 'High health', q: 'Deploy a destructible barrier that blocks enemy shots.', qName: 'Barrier' },
  ASSASSIN: { name: 'Assassin', short: 'ASN', traits: 'Steady health', q: 'Turn invisible. Taking damage or firing reveals you.', qName: 'Cloak' },
}

export const WEAPON_INFO: Record<WeaponId, { name: string; pitch: string }> = {
  ASSAULT_RIFLE: { name: 'Assault Rifle', pitch: 'Balanced automatic fire' },
  SHOTGUN: { name: 'Shotgun', pitch: 'Many pellets, deadly up close' },
  SNIPER_RIFLE: { name: 'Sniper Rifle', pitch: 'Slow, powerful, long range' },
}

export type Palette = { base: string; light: string; deep: string; ink: string }

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
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3
      const x = Math.cos(a) * R * 1.12
      const y = Math.sin(a) * R * 1.12
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    }
    ctx.closePath()
  } else {
    // hooded teardrop: round head, tail behind
    ctx.arc(0.05 * R, 0, R * 0.88, 0, Math.PI * 2)
    ctx.moveTo(-0.5 * R, -0.7 * R)
    ctx.lineTo(-1.55 * R, 0)
    ctx.lineTo(-0.5 * R, 0.7 * R)
    ctx.closePath()
  }
}

/** Draws one class avatar at the origin facing +x. Team color stays the body fill so allies and enemies read first. */
export function drawAvatar(ctx: CanvasRenderingContext2D, cls: ClassId, c: Palette, r: number, breathe = 1) {
  const R = r * breathe
  ctx.fillStyle = '#0B1017'
  bodyPath(ctx, cls, R, 1.5)
  ctx.fill()
  const g = ctx.createRadialGradient(-R * 0.35, -R * 0.35, 1, 0, 0, R * 1.2)
  g.addColorStop(0, c.light)
  g.addColorStop(0.55, c.base)
  g.addColorStop(1, c.deep)
  ctx.fillStyle = g
  bodyPath(ctx, cls, R)
  ctx.fill()
  ctx.fillStyle = '#081019'
  if (cls === 'ASSAULTER') {
    // chevron visor + back thrusters
    ctx.beginPath()
    ctx.moveTo(R * 0.7, 0)
    ctx.lineTo(R * 0.1, -R * 0.5)
    ctx.lineTo(R * 0.25, -R * 0.5)
    ctx.lineTo(R * 0.85, 0)
    ctx.lineTo(R * 0.25, R * 0.5)
    ctx.lineTo(R * 0.1, R * 0.5)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = c.ink
    for (const s of [-1, 1]) ctx.fillRect(-R * 0.95, s * R * 0.42 - 1.5, R * 0.4, 3)
  } else if (cls === 'GUARDIAN') {
    // wide visor + a shield plate on the front
    ctx.fillRect(R * 0.2, -R * 0.55, R * 0.4, R * 1.1)
    ctx.strokeStyle = c.ink
    ctx.lineWidth = Math.max(2, R * 0.2)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(0, 0, R * 1.32, -0.75, 0.75)
    ctx.stroke()
  } else {
    // narrow slit
    ctx.beginPath()
    ctx.ellipse(R * 0.45, 0, R * 0.14, R * 0.5, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = c.ink
    ctx.fillRect(R * 0.42, -R * 0.28, 1.6, R * 0.22)
  }
}
