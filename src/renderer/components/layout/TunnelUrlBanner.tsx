import { useEffect, useState } from 'react'
import { Link2, Copy, Check, X } from 'lucide-react'

interface TunnelState {
  url: string | null
  source: 'file' | 'http' | null
  updatedAt: number | null
  watchedPath?: string | null
}

const DISMISS_KEY = 'mien:tunnelBannerDismissedUrl'

export default function TunnelUrlBanner() {
  const [state, setState] = useState<TunnelState>({ url: null, source: null, updatedAt: null })
  const [copied, setCopied] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY))
    window.api.getTunnelUrl().then(setState)
    const off = window.api.onTunnelUrl((data) => {
      setState(data as TunnelState)
      // Any new URL re-shows the banner even if a previous one was dismissed.
      setDismissed((prev) => (prev === data.url ? prev : null))
    })
    return off
  }, [])

  if (!state.url) return null
  if (dismissed === state.url) return null

  const handleCopy = async () => {
    if (!state.url) return
    await navigator.clipboard.writeText(state.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleDismiss = () => {
    if (!state.url) return
    localStorage.setItem(DISMISS_KEY, state.url)
    setDismissed(state.url)
  }

  const updatedLabel = state.updatedAt
    ? new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 border-b text-sm"
      style={{
        background: 'var(--bg-tertiary)',
        borderColor: 'var(--border-subtle)',
        color: 'var(--text-primary)',
      }}
    >
      <Link2 size={14} style={{ color: 'var(--accent-blue)' }} />
      <span style={{ color: 'var(--text-muted)' }}>Relay tunnel:</span>
      <code
        className="px-2 py-0.5 rounded text-xs flex-1 truncate"
        style={{ background: 'var(--bg-secondary)', color: 'var(--accent-blue)' }}
      >
        {state.url}
      </code>
      {updatedLabel && (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          updated {updatedLabel} ({state.source})
        </span>
      )}
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors"
        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
        title="Copy URL to clipboard"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        onClick={handleDismiss}
        className="rounded transition-colors p-1"
        style={{ color: 'var(--text-muted)' }}
        title="Dismiss until next change"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}
