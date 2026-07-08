import { useEffect, useRef, useState, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Lock, ArrowRight, Eye, EyeOff } from 'lucide-react'

interface Props {
  mode: 'setup' | 'unlock'
  onUnlocked: () => void
}

export default function LockScreen({ mode, onUnlocked }: Props) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [capsLockOn, setCapsLockOn] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const checkCapsLock = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    setCapsLockOn(e.getModifierState('CapsLock'))
  }

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
  const inputType = revealed ? 'text' : 'password'

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
          <div className="relative">
            <input
              ref={inputRef}
              type={inputType}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={checkCapsLock}
              onKeyUp={checkCapsLock}
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              className="w-full px-3 py-2 pr-10 rounded text-sm outline-none"
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--separator)',
                color: 'var(--text-primary)',
              }}
            />
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              tabIndex={-1}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded transition-opacity hover:opacity-70"
              style={{ color: 'var(--text-muted)' }}
              aria-label={revealed ? 'Hide password' : 'Show password'}
              title={revealed ? 'Hide password' : 'Show password'}
            >
              {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          {isSetup && (
            <>
              <label className="block text-[10px] pt-1" style={{ color: 'var(--text-muted)' }}>
                Confirm password
              </label>
              <input
                type={inputType}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={checkCapsLock}
                onKeyUp={checkCapsLock}
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

        {capsLockOn && (
          <div className="text-xs" style={{ color: 'var(--accent-orange, #f59e0b)' }} role="status">
            Caps Lock is on.
          </div>
        )}

        {error && (
          <div className="text-xs" style={{ color: 'var(--accent-red, #ef4444)' }} role="alert">
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
