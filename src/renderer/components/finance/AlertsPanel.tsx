import { useEffect, useState } from 'react'
import { Bell, Plus, Trash2, BellOff } from 'lucide-react'
import { format, parseISO } from 'date-fns'

interface AlertRow {
  id: number
  symbol: string
  type: string
  threshold: number
  note: string | null
  active: number
  one_shot: number
  last_fired_at: string | null
  last_value: number | null
  created_at: string
}

const TYPE_LABEL: Record<string, string> = {
  price_above: 'Price ≥',
  price_below: 'Price ≤',
  rsi_above: 'RSI ≥',
  rsi_below: 'RSI ≤',
  ma_cross_above: '20/50 SMA ↑',
  ma_cross_below: '20/50 SMA ↓',
}

export default function AlertsPanel({ selectedSymbol }: { selectedSymbol: string | null }) {
  const [alerts, setAlerts] = useState<AlertRow[]>([])
  const [adding, setAdding] = useState(false)

  const refresh = async () => {
    try {
      const rows = await window.api.listAlerts()
      setAlerts(rows)
    } catch (err) {
      console.error('Failed to fetch alerts:', err)
    }
  }

  useEffect(() => {
    refresh()
    const cleanup = window.api.onAlertsFired(() => refresh())
    return cleanup
  }, [])

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3
          className="text-sm font-medium flex items-center gap-2"
          style={{ color: 'var(--text-primary)' }}
        >
          <Bell size={14} style={{ color: 'var(--accent-amber)' }} />
          Alerts
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              await window.api.checkAlertsNow()
              refresh()
            }}
            className="text-xs px-2 py-1 rounded-md transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
            title="Run an alert check now"
          >
            Check now
          </button>
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
          >
            <Plus size={11} />
            New alert
          </button>
        </div>
      </div>

      {alerts.length === 0 ? (
        <p className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>
          No alerts yet. Create one to get a desktop notification when a price or technical
          condition is met.
        </p>
      ) : (
        <div className="space-y-1.5">
          {alerts.map((a) => {
            const fired = a.last_fired_at != null
            return (
              <div
                key={a.id}
                className="flex items-center justify-between text-sm py-1.5 px-2 rounded-md"
                style={{
                  background: 'var(--bg-tertiary)',
                  opacity: a.active ? 1 : 0.5,
                }}
              >
                <div className="flex items-center gap-3 flex-1">
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {a.symbol}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {TYPE_LABEL[a.type] || a.type} {a.threshold}
                  </span>
                  {a.note && (
                    <span className="text-xs italic" style={{ color: 'var(--text-muted)' }}>
                      {a.note}
                    </span>
                  )}
                  {fired && (
                    <span className="text-xs" style={{ color: 'var(--accent-amber)' }}>
                      fired {format(parseISO(a.last_fired_at!), 'MMM d HH:mm')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={async () => {
                      await window.api.toggleAlert(a.id, !a.active)
                      refresh()
                    }}
                    className="text-xs p-1 rounded hover:bg-white/5"
                    style={{ color: a.active ? 'var(--accent-green)' : 'var(--text-muted)' }}
                    title={a.active ? 'Deactivate' : 'Reactivate'}
                  >
                    {a.active ? <Bell size={12} /> : <BellOff size={12} />}
                  </button>
                  <button
                    onClick={async () => {
                      await window.api.removeAlert(a.id)
                      refresh()
                    }}
                    className="text-xs p-1 rounded hover:bg-white/5"
                    style={{ color: 'var(--accent-red)' }}
                    aria-label="Delete alert"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {adding && (
        <AddAlertDialog
          defaultSymbol={selectedSymbol || ''}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function AddAlertDialog({
  defaultSymbol,
  onClose,
  onSaved,
}: {
  defaultSymbol: string
  onClose: () => void
  onSaved: () => void
}) {
  const [symbol, setSymbol] = useState(defaultSymbol)
  const [type, setType] = useState('price_above')
  const [threshold, setThreshold] = useState('')
  const [note, setNote] = useState('')
  const [recurring, setRecurring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setError(null)
    if (!symbol.trim()) {
      setError('Symbol required')
      return
    }
    const t = parseFloat(threshold)
    if (!Number.isFinite(t)) {
      setError('Threshold must be a number')
      return
    }

    try {
      await window.api.createAlert({
        symbol: symbol.trim().toUpperCase(),
        type,
        threshold: t,
        note: note.trim() || null,
        one_shot: !recurring,
      })
      onSaved()
    } catch (err: any) {
      setError(err?.message || 'Failed')
    }
  }

  const isCross = type.startsWith('ma_cross')

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-alert-title"
    >
      <div className="card max-w-sm w-full m-4" onClick={(e) => e.stopPropagation()}>
        <h3 id="new-alert-title" className="text-base font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
          New Alert
        </h3>
        <div className="space-y-3">
          <label className="block">
            <span
              className="text-xs uppercase tracking-wide block mb-1"
              style={{ color: 'var(--text-muted)' }}
            >
              Symbol
            </span>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="AAPL"
              autoFocus
              className="w-full text-sm px-3 py-1.5 rounded-md border outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                borderColor: 'var(--separator)',
                color: 'var(--text-primary)',
              }}
            />
          </label>
          <label className="block">
            <span
              className="text-xs uppercase tracking-wide block mb-1"
              style={{ color: 'var(--text-muted)' }}
            >
              Condition
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full text-sm px-3 py-1.5 rounded-md border outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                borderColor: 'var(--separator)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="price_above">Price crosses above</option>
              <option value="price_below">Price drops below</option>
              <option value="rsi_above">RSI rises above</option>
              <option value="rsi_below">RSI falls below</option>
              <option value="ma_cross_above">20-day SMA crosses above 50-day (golden)</option>
              <option value="ma_cross_below">20-day SMA crosses below 50-day (death)</option>
            </select>
          </label>
          {!isCross && (
            <label className="block">
              <span
                className="text-xs uppercase tracking-wide block mb-1"
                style={{ color: 'var(--text-muted)' }}
              >
                Threshold
              </span>
              <input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder={type.startsWith('rsi') ? '70' : '200'}
                className="w-full text-sm px-3 py-1.5 rounded-md border outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  borderColor: 'var(--separator)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>
          )}
          {isCross && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Crossover alerts fire on the next moving-average crossing — no threshold needed.
            </p>
          )}
          <label className="block">
            <span
              className="text-xs uppercase tracking-wide block mb-1"
              style={{ color: 'var(--text-muted)' }}
            >
              Note (optional)
            </span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Take profit"
              className="w-full text-sm px-3 py-1.5 rounded-md border outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                borderColor: 'var(--separator)',
                color: 'var(--text-primary)',
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
            />
            Recurring (keep firing every check while condition holds)
          </label>
        </div>
        {error && (
          <p className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-lg"
            style={{ color: 'var(--text-muted)' }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="text-sm px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--accent-blue)', color: 'white' }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
