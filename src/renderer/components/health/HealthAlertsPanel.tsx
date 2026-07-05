import { useEffect, useState } from 'react'
import { Bell, BellOff, Plus, Trash2 } from 'lucide-react'

interface HealthAlertRow {
  id: number
  type: string
  threshold: number
  note: string | null
  active: number
  one_shot: number
  last_fired_at: string | null
  last_value: number | null
  created_at: string
}

const TYPE_OPTIONS = [
  { value: 'hrv_below', label: 'HRV below (ms)', placeholder: '40' },
  { value: 'recovery_below', label: 'Recovery readiness below', placeholder: '40' },
  { value: 'sleep_debt_above', label: 'Sleep debt above (hours)', placeholder: '8' },
  { value: 'training_load_above', label: 'Training load ratio above', placeholder: '1.3' },
] as const

type HealthAlertType = (typeof TYPE_OPTIONS)[number]['value']

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((t) => [t.value, t.label]),
)

export default function HealthAlertsPanel() {
  const [alerts, setAlerts] = useState<HealthAlertRow[]>([])
  const [adding, setAdding] = useState(false)
  const [newType, setNewType] = useState<HealthAlertType>('hrv_below')
  const [newThreshold, setNewThreshold] = useState('')
  const [newNote, setNewNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const rows = await window.api.listHealthAlerts()
      setAlerts(rows || [])
    } catch (err) {
      console.error('Failed to load health alerts:', err)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const create = async () => {
    setError(null)
    const n = parseFloat(newThreshold)
    if (!Number.isFinite(n)) {
      setError('Threshold must be a number')
      return
    }
    try {
      await window.api.createHealthAlert({
        type: newType,
        threshold: n,
        note: newNote.trim() || null,
        one_shot: false,
      })
      setNewThreshold('')
      setNewNote('')
      setAdding(false)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    }
  }

  const placeholder = TYPE_OPTIONS.find((t) => t.value === newType)?.placeholder || '0'

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3
          className="text-sm font-medium flex items-center gap-2"
          style={{ color: 'var(--text-primary)' }}
        >
          <Bell size={14} style={{ color: 'var(--accent-amber)' }} />
          Health Alerts
        </h3>
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded transition-colors"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
        >
          <Plus size={12} /> Add
        </button>
      </div>

      {adding && (
        <div className="mb-3 p-3 rounded-lg space-y-2" style={{ background: 'var(--bg-tertiary)' }}>
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as HealthAlertType)}
            className="w-full text-xs px-2 py-1.5 rounded outline-none"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--separator)',
              color: 'var(--text-primary)',
            }}
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              step="0.01"
              value={newThreshold}
              onChange={(e) => setNewThreshold(e.target.value)}
              placeholder={placeholder}
              className="text-xs px-2 py-1.5 rounded outline-none"
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--separator)',
                color: 'var(--text-primary)',
              }}
            />
            <input
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Note (optional)"
              className="text-xs px-2 py-1.5 rounded outline-none"
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--separator)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          {error && (
            <p className="text-xs" style={{ color: 'var(--accent-red)' }}>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setAdding(false)
                setError(null)
              }}
              className="text-xs px-2.5 py-1 rounded"
              style={{ color: 'var(--text-muted)' }}
            >
              Cancel
            </button>
            <button
              onClick={create}
              className="text-xs px-2.5 py-1 rounded"
              style={{ background: 'var(--accent-blue)', color: 'white' }}
            >
              Create
            </button>
          </div>
        </div>
      )}

      {alerts.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No health alerts. Add one above to get a notification when HRV, recovery, sleep debt, or
          training load cross a threshold.
        </p>
      ) : (
        <div className="space-y-1.5">
          {alerts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between text-xs px-2.5 py-2 rounded"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span style={{ color: a.active ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {TYPE_LABEL[a.type] || a.type} {a.threshold}
                  </span>
                  {a.last_fired_at && (
                    <span style={{ color: 'var(--accent-amber)' }}>
                      fired{' '}
                      {new Date(a.last_fired_at + 'Z').toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
                </div>
                {a.note && (
                  <div className="mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                    {a.note}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={async () => {
                    await window.api.toggleHealthAlert(a.id, !a.active)
                    refresh()
                  }}
                  className="p-1 rounded hover:bg-white/5"
                  style={{ color: a.active ? 'var(--accent-blue)' : 'var(--text-muted)' }}
                  title={a.active ? 'Disable' : 'Enable'}
                >
                  {a.active ? <Bell size={12} /> : <BellOff size={12} />}
                </button>
                <button
                  onClick={async () => {
                    await window.api.removeHealthAlert(a.id)
                    refresh()
                  }}
                  className="p-1 rounded hover:bg-white/5"
                  style={{ color: 'var(--accent-red)' }}
                  title="Remove"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
