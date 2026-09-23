import type { ReactNode } from 'react'
import type { Status } from './data'

const hash = (s: string) => {
  let h = 7
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

const SKIN = ['#f3cfae', '#dca67f', '#b07652', '#6f4a35']

/** Deterministic stylized 2D bust, generated from the player name. */
export function Avatar({ name, size = 40, dim = false }: { name: string; size?: number; dim?: boolean }) {
  const h = hash(name)
  const hue = h % 360
  const variant = (h >> 4) % 4
  const skin = SKIN[(h >> 7) % 4]
  const dark = `hsl(${hue} 35% 14%)`
  const accent = `hsl(${hue} 90% 66%)`
  const hair = `hsl(${(hue + 200) % 360} 30% 18%)`
  const gid = `av${h}`
  const eyes = (
    <g fill={dark}>
      <rect x="26" y="27" width="3" height="3.5" rx="1" />
      <rect x="35" y="27" width="3" height="3.5" rx="1" />
    </g>
  )
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`shrink-0 rounded-[28%] ${dim ? 'opacity-40 grayscale' : ''}`}
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 55% 40%)`} />
          <stop offset="1" stopColor={`hsl(${(hue + 40) % 360} 55% 14%)`} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" fill={`url(#${gid})`} />
      <circle cx="50" cy="12" r="18" fill="white" opacity="0.06" />
      <path d="M6 64c3-13 13-19 26-19s23 6 26 19z" fill={`hsl(${(hue + 180) % 360} 30% 24%)`} />
      <path d="M22 50l10 7 10-7" stroke={accent} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <rect x="27.5" y="37" width="9" height="9" rx="2" fill={skin} />
      <circle cx="32" cy="28" r="12" fill={skin} />
      {variant === 0 && (
        <>
          <path d="M19 29a13 13 0 0126 0v1.5H19z" fill={dark} />
          <rect x="20.5" y="25.5" width="23" height="6.5" rx="3.2" fill={accent} />
          <rect x="23" y="27" width="7" height="1.6" rx="0.8" fill="white" opacity="0.7" />
        </>
      )}
      {variant === 1 && (
        <>
          <path d="M19 27c0-9 6-14 13-14s14 5 13 14l-4-5-3 4-4-6-4 6-3-4-4 5z" fill={hair} />
          {eyes}
        </>
      )}
      {variant === 2 && (
        <>
          <path d="M16 36c0-13 7-21 16-21s16 8 16 21l-4 3c0-11-5-16-12-16s-12 5-12 16z" fill={`hsl(${hue} 40% 26%)`} />
          {eyes}
        </>
      )}
      {variant === 3 && (
        <>
          <path d="M20 25c1-8 6-11 12-11s11 3 12 11z" fill={hair} />
          <rect x="19.5" y="21" width="25" height="3.5" rx="1.5" fill={accent} />
          {eyes}
        </>
      )}
    </svg>
  )
}

const DOT: Record<Status, string> = {
  online: 'bg-online',
  away: 'bg-away',
  ingame: 'bg-ingame',
  offline: 'bg-ink-600',
}

export const StatusDot = ({ status, className = '' }: { status: Status; className?: string }) => (
  <span className={`inline-block size-2.5 rounded-full ring-2 ring-ink-850 ${DOT[status]} ${className}`} />
)

/** Avatar with a status dot pinned to the corner. */
export const AvatarStatus = ({ name, status, size = 40 }: { name: string; status: Status; size?: number }) => (
  <span className="relative inline-flex">
    <Avatar name={name} size={size} dim={status === 'offline'} />
    <StatusDot status={status} className="absolute -right-0.5 -bottom-0.5" />
  </span>
)

const ICONS = {
  users: 'M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM22 19v-1a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8',
  home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z',
  party: 'M12 3l2.4 5 5.6.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.6-.8z',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  logout: 'M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 16l-4-4 4-4M6 12h10',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  bell: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 21h4',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
} as const

export type IconName = keyof typeof ICONS

export const Icon = ({ name, className = 'size-4 shrink-0' }: { name: IconName; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={ICONS[name]} />
  </svg>
)

export const Logo = ({ className = '' }: { className?: string }) => (
  <div className={`flex items-center gap-2.5 ${className}`}>
    <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
      <defs>
        <linearGradient id="lg-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd27a" />
          <stop offset="1" stopColor="#f59e3d" />
        </linearGradient>
      </defs>
      <path d="M16 2l12 7v14l-12 7-12-7V9z" fill="#151924" stroke="url(#lg-logo)" strokeWidth="1.6" />
      <path d="M10 22l6-13 6 13M12.6 17h6.8" stroke="url(#lg-logo)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <span className="font-display text-lg font-bold tracking-[0.28em] text-ink-100">ARCLINE</span>
  </div>
)

export const Kbd = ({ children }: { children: ReactNode }) => (
  <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-display text-[10px] tracking-widest text-ink-300">{children}</span>
)

/** Stylized 2D arena landscape: dusk sky, ridgelines, a floating arena platform. */
export function WorldArt({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 800 400" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <defs>
        <linearGradient id="w-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d1222" />
          <stop offset="0.55" stopColor="#1b1d3a" />
          <stop offset="1" stopColor="#3a2536" />
        </linearGradient>
        <radialGradient id="w-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffd27a" />
          <stop offset="0.45" stopColor="#f59e3d" stopOpacity="0.55" />
          <stop offset="1" stopColor="#f59e3d" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="w-plat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b3350" />
          <stop offset="1" stopColor="#12162a" />
        </linearGradient>
        <linearGradient id="w-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.5" stopColor="#0b0d13" stopOpacity="0" />
          <stop offset="1" stopColor="#0b0d13" />
        </linearGradient>
      </defs>
      <rect width="800" height="400" fill="url(#w-sky)" />
      {[[80, 50], [160, 90], [300, 40], [420, 70], [700, 60], [620, 30], [520, 110], [250, 120], [740, 130]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 3 ? 1 : 1.6} fill="white" opacity={0.5} />
      ))}
      <circle cx="560" cy="210" r="150" fill="url(#w-sun)" />
      <circle cx="560" cy="210" r="46" fill="#ffd9a0" opacity="0.9" />
      <path d="M0 270L90 200l60 40 90-90 80 80 60-40 110 90 90-60 100 70 120-80v180H0z" fill="#232443" />
      <path d="M0 300l120-60 70 40 110-70 90 70 80-30 120 60 90-40 120 50v80H0z" fill="#1a1a33" />
      {/* floating arena */}
      <g transform="translate(470 160)">
        <path d="M-40 60l20 50 20-28 20 40 20-38 20 30 20-54z" fill="#171a30" />
        <ellipse cx="60" cy="58" rx="120" ry="22" fill="url(#w-plat)" />
        <ellipse cx="60" cy="52" rx="120" ry="20" fill="#303a5c" />
        <ellipse cx="60" cy="52" rx="86" ry="12" fill="none" stroke="#4cc9f0" strokeOpacity="0.5" strokeWidth="1.5" />
        {[-30, 10, 110, 150].map((x) => (
          <g key={x}>
            <rect x={x - 5} y="0" width="10" height="50" fill="#262d49" />
            <rect x={x - 7} y="-4" width="14" height="6" fill="#39446b" />
            <rect x={x - 1.5} y="8" width="3" height="10" fill="#f5b83d" opacity="0.8" />
          </g>
        ))}
        <path d="M60 -30v80" stroke="#f5b83d" strokeOpacity="0.35" strokeWidth="2" strokeDasharray="4 6" />
      </g>
      <path d="M0 340l140-40 120 30 160-50 140 40 120-20 120 30v70H0z" fill="#11121f" />
      <rect width="800" height="400" fill="url(#w-fade)" />
    </svg>
  )
}
