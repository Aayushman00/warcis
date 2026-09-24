import { useState, type FormEvent } from 'react'
import { api, type Session } from './api'
import { Logo, WorldArt } from './ui'

export function Auth({ onAuth }: { onAuth: (s: Session) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [id, setId] = useState('')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Client-side checks mirror the server's for fast feedback; the server re-validates everything.
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const name = id.trim()
    if (!name) return setError(mode === 'in' ? 'Enter your username or email.' : 'Choose a username.')
    if (mode === 'up' && !/^[A-Za-z0-9_.-]{3,16}$/.test(name)) return setError('Username: 3–16 letters, numbers, _ . -')
    if (mode === 'up' && !/^\S+@\S+\.\S+$/.test(email)) return setError('Enter a valid email.')
    if (pw.length < 6) return setError('Password must be at least 6 characters.')
    setError('')
    setBusy(true)
    try {
      const s =
        mode === 'in'
          ? await api<Session>('/auth/login', { method: 'POST', body: { login: name, password: pw } })
          : await api<Session>('/auth/register', { method: 'POST', body: { username: name, email: email.trim(), password: pw } })
      onAuth(s)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-[1.15fr_1fr]">
      <div className="relative hidden overflow-hidden lg:block">
        <WorldArt className="absolute inset-0 h-full w-full" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/40 to-transparent" />
        <div className="relative flex h-full flex-col justify-between p-10">
          <Logo />
          <div className="max-w-md">
            <p className="label !text-gold">Competitive multiplayer</p>
            <h1 className="mt-3 font-display text-5xl leading-[1.05] font-bold">
              Form your squad.
              <br />
              Queue as one.
            </h1>
            <p className="mt-4 text-ink-300">
              Friends, parties of up to four, and matchmaking that keeps your team together.
            </p>
          </div>
          <p className="text-xs text-ink-400">Build 0.1.0 · Launcher preview</p>
        </div>
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="panel w-full max-w-sm animate-rise p-7" noValidate>
          <Logo className="mb-6 lg:hidden" />
          <div className="mb-6 grid grid-cols-2 rounded-lg bg-ink-950/60 p-1 text-sm font-semibold">
            {(['in', 'up'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => (setMode(m), setError(''))}
                className={`rounded-md py-2 transition ${mode === m ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-100'}`}
              >
                {m === 'in' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          <div className="space-y-3.5">
            <label className="block">
              <span className="label">{mode === 'in' ? 'Username or email' : 'Username'}</span>
              <input className="input mt-1.5" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" autoFocus />
            </label>
            {mode === 'up' && (
              <label className="block">
                <span className="label">Email</span>
                <input className="input mt-1.5" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              </label>
            )}
            <label className="block">
              <span className="label">Password</span>
              <input
                className="input mt-1.5"
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
              />
            </label>
          </div>

          {error && <p role="alert" className="mt-3 text-sm text-foe">{error}</p>}

          <button className="btn-gold mt-6 w-full py-3" disabled={busy}>
            {busy ? 'Connecting…' : mode === 'in' ? 'Sign In' : 'Create Account'}
          </button>

          <p className="mt-5 text-center text-xs text-ink-400">
            {mode === 'in' ? 'New to ARCLINE? ' : 'Already have an account? '}
            <button type="button" onClick={() => (setMode(mode === 'in' ? 'up' : 'in'), setError(''))} className="font-semibold text-ally hover:underline">
              {mode === 'in' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
