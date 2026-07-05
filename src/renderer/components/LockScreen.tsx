import { useEffect, useRef, useState, FormEvent } from 'react'
import { Lock, ArrowRight } from 'lucide-react'

interface Props {
  mode: 'setup' | 'unlock'
  onUnlocked: () => void
}

export default function LockScreen({ mode, onUnlocked }: Props) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)

    if (mode === 'setup') {
      if (password.length < 4) {
        setError('Password must be at least 4 characters.')
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match.')
        return
      }
      setBusy(true)
      try {
        await window.api.authSetPassword(password)
        onUnlocked()
      } catch (err) {
        setError((err as Error)?.message || 'Could not set password.')
        setBusy(false)
      }
      return
    }

    setBusy(true)
    try {
      const ok = await window.api.authVerify(password)
      if (ok) {
        onUnlocked()
      } else {
        setError('Incorrect password.')
        setPassword('')
        setBusy(false)
        inputRef.current?.focus()
      }
    } catch (err) {
      setError((err as Error)?.message || 'Verification failed.')
      setBusy(false)
    }
  }

  const isSetup = mode === 'setup'

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{ background: 'var(--bg-primary)' }}
      role="dialog"
      aria-modal="true"
      aria-label="App lock"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl p-6 space-y-4"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--separator)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <Lock size={16} style={{ color: 'var(--accent-blue)' }} />
          </div>
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {isSetup ? 'Set a password' : 'Welcome back'}
            </h2>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {isSetup
                ? 'Pick a password to lock Mien on this device.'
                : 'Enter your password to unlock Mien.'}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Password
          </label>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            className="w-full px-3 py-2 rounded text-sm outline-none"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--separator)',
              color: 'var(--text-primary)',
            }}
          />

          {isSetup && (
            <>
              <label className="block text-[10px] pt-1" style={{ color: 'var(--text-muted)' }}>
                Confirm password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                className="w-full px-3 py-2 rounded text-sm outline-none"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--separator)',
                  color: 'var(--text-primary)',
                }}
              />
            </>
          )}
        </div>

        {error && (
          <div className="text-xs" style={{ color: 'var(--accent-red, #ef4444)' }}>
            {error}
          </div>
        )}

        {isSetup && (
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Stored as a salted scrypt hash on this device. There is no recovery — losing it means
            wiping the local config to reset.
          </p>
        )}

        <button
          type="submit"
          disabled={busy || password.length === 0 || (isSetup && confirm.length === 0)}
          className="w-full flex items-center justify-center gap-1.5 text-sm px-4 py-2 rounded-lg transition-opacity disabled:opacity-50"
          style={{ background: 'var(--accent-blue)', color: 'white' }}
        >
          {busy ? 'Working…' : isSetup ? 'Set password' : 'Unlock'}
          {!busy && <ArrowRight size={14} />}
        </button>
      </form>
    </div>
  )
}
