/* In-match design tokens: the one source of color, type, spacing and motion for both the
   canvas renderer and the HUD (exposed to CSS as --g-* custom properties by cssVars()). */

export type Team = 'RED' | 'BLUE'

export const color = {
  void: '#06090F', // page behind the map
  deck: '#0C121B', // HUD surfaces
  deck2: '#121A26',
  rule: 'rgba(148, 176, 214, 0.14)', // thin borders / dividers
  ruleStrong: 'rgba(148, 176, 214, 0.28)',
  ink: '#E9EEF6', // primary text
  dim: '#8C9AB0', // secondary text
  faint: '#56637A',
  signal: '#FFB547', // offline / reconnecting only
  hpHigh: '#5BE59B',
  hpMid: '#FFC857',
  hpLow: '#FF5D6C',
  // map
  ground: '#0A0F17',
  groundAlt: '#0C121C',
  wallTop: '#2A3446',
  wallTopLit: '#35415A',
  wallSide: '#161C28',
  wallEdge: '#56637E',
} as const

export const team = {
  RED: { base: '#FF4F5E', light: '#FF97A0', deep: '#7A1522', ink: '#FFE3E6' },
  BLUE: { base: '#2FC6FF', light: '#98E3FF', deep: '#0B4A6B', ink: '#E0F7FF' },
} as const satisfies Record<Team, { base: string; light: string; deep: string; ink: string }>

export const font = {
  display: '"Saira Condensed", "Arial Narrow", sans-serif', // states, clock, scores, countdown
  text: 'Inter, ui-sans-serif, system-ui, sans-serif', // HUD text, names
} as const

export const space = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px' } as const
export const radius = { chip: '4px', panel: '8px' } as const
export const shadow = { panel: '0 14px 36px -16px rgba(0, 0, 0, 0.75)' } as const
export const motion = { fast: '140ms', base: '220ms', slow: '420ms', event: '1800ms', ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)' } as const

export const other = (t: Team): Team => (t === 'RED' ? 'BLUE' : 'RED')
/** hex + alpha (0..1) -> #rrggbbaa, for canvas gradients. */
export const alpha = (hex: string, a: number) => hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')

export function cssVars(): Record<string, string> {
  const v: Record<string, string> = {}
  for (const [k, x] of Object.entries(color)) v[`--g-${k}`] = x
  for (const t of ['RED', 'BLUE'] as const) for (const [k, x] of Object.entries(team[t])) v[`--g-${t.toLowerCase()}-${k}`] = x
  v['--g-font-display'] = font.display
  v['--g-font-text'] = font.text
  for (const [k, x] of Object.entries(space)) v[`--g-s${k}`] = x
  for (const [k, x] of Object.entries(radius)) v[`--g-r-${k}`] = x
  v['--g-shadow-panel'] = shadow.panel
  for (const [k, x] of Object.entries(motion)) v[`--g-t-${k}`] = x
  return v
}
