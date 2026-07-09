import { useState, type ComponentPropsWithRef } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface SecretInputProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  /** What the secret is called in the toggle's accessible label, e.g. "Claude API key". */
  secretLabel?: string
  /** Icon size for the reveal toggle; match it to the input's text size. */
  toggleSize?: number
}

/**
 * Masked input with a show/hide toggle, used for passwords, tokens, and API
 * keys. Caller styles the input via className/style as usual (leave right
 * padding for the toggle, e.g. pr-8/pr-10); the toggle button is positioned
 * inside the input on the right.
 */
export default function SecretInput({
  secretLabel = 'value',
  toggleSize = 14,
  ...inputProps
}: SecretInputProps) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="relative">
      <input type={revealed ? 'text' : 'password'} {...inputProps} />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-opacity hover:opacity-70"
        style={{ color: 'var(--text-muted)' }}
        aria-label={revealed ? `Hide ${secretLabel}` : `Show ${secretLabel}`}
        title={revealed ? 'Hide' : 'Show'}
      >
        {revealed ? <EyeOff size={toggleSize} /> : <Eye size={toggleSize} />}
      </button>
    </div>
  )
}
