import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Briefcase,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Trash2,
  TrendingUp,
  TrendingDown,
  Upload,
} from 'lucide-react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import Tooltip from '../components/charts/ChartTooltip'
import { format, parseISO } from 'date-fns'

interface HoldingRow {
  id: number
  symbol: string
  quantity: number
  cost_basis: number
  acquired_at: string | null
  notes: string | null
  created_at: string
}

interface HoldingWithLive extends HoldingRow {
  current_price: number | null
  market_value: number | null
  unrealized_pl: number | null
  unrealized_pl_percent: number | null
  weight_percent: number | null
}

interface PortfolioSummary {
  totalValue: number
  totalCost: number
  unrealizedPL: number
  unrealizedPLPercent: number
  dayChange: number
  dayChangePercent: number
  holdings: HoldingWithLive[]
}

const RANGE_OPTIONS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1Y', days: 365 },
  { label: 'All', days: 1825 },
] as const

export default function PortfolioPage() {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [valueHistory, setValueHistory] = useState<Array<{ date: string; value: number }>>([])
  const [days, setDays] = useState(90)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<HoldingRow | null>(null)
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const [showPortfolioValues, setShowPortfolioValues] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await window.api.getPortfolioSummary()
      setSummary(s)
      const hist = await window.api.getPortfolioValueHistory(days)
      setValueHistory(hist)
    } catch (err) {
      console.error('Portfolio load failed:', err)
    }
  }, [days])

  useEffect(() => {
    refresh()
  }, [refresh])

  const importRobinhood = async () => {
    setImportStatus(null)
    try {
      const result = await window.api.importRobinhoodHoldings()
      if (!result) return
      const symbols = [...(result.importedSymbols || []), ...(result.existingSymbols || [])]
      setImportStatus(
        symbols.length > 0
          ? `${result.message} Symbols noted: ${symbols.slice(0, 12).join(', ')}${symbols.length > 12 ? `, +${symbols.length - 12} more` : ''}.`
          : result.message,
      )
      await refresh()
    } catch (err: any) {
      setImportStatus(err?.message || 'Robinhood import failed')
    }
  }

  const chartData = useMemo(
    () => valueHistory.map((h) => ({ ...h, label: format(parseISO(h.date), 'MMM d') })),
    [valueHistory],
  )

  const isProfitable = summary && summary.unrealizedPL >= 0
  const isDayUp = summary && summary.dayChange >= 0

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h2
          className="text-2xl font-semibold flex items-center gap-2"
          style={{ color: 'var(--text-primary)' }}
        >
          <Briefcase size={22} style={{ color: 'var(--accent-blue)' }} />
          Portfolio
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={importRobinhood}
            className="flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            title="Import symbols only from a Robinhood CSV export"
          >
            <Upload size={14} />
            Import Robinhood
          </button>
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
          >
            <Plus size={14} />
            Add Position
          </button>
        </div>
      </div>

      <div className="card">
        <div className="flex items-start gap-3">
          <Upload size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--accent-blue)' }} />
          <div>
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Private Robinhood import
            </h3>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Import a Robinhood CSV to note which symbols you hold. Mien adds them to your
              watchlist only and skips balances, quantities, market value, and cost basis.
            </p>
            {importStatus && (
              <p
                className="text-xs mt-2"
                style={{
                  color:
                    importStatus.toLowerCase().includes('failed') ||
                    importStatus.toLowerCase().includes('could not')
                      ? 'var(--accent-red)'
                      : 'var(--accent-green)',
                }}
              >
                {importStatus}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Summary card */}
      <div className="card">
        {!summary || summary.holdings.length === 0 ? (
          <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
            No detailed positions yet. Import Robinhood for a symbols-only overview or add a
            position manually to track value.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowPortfolioValues((current) => !current)}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-white/[0.05]"
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
                aria-label={showPortfolioValues ? 'Hide portfolio values' : 'Show portfolio values'}
              >
                {showPortfolioValues ? <EyeOff size={13} /> : <Eye size={13} />}
                {showPortfolioValues ? 'Hide values' : 'Show values'}
              </button>
            </div>
            <div className="grid grid-cols-4 gap-4">
              <Stat
                label="Total Value"
                value={
                  showPortfolioValues
                    ? `$${summary.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : '$••••••'
                }
              />
              <Stat
                label="Day Change"
                value={
                  showPortfolioValues
                    ? `${isDayUp ? '+' : ''}$${summary.dayChange.toFixed(2)} (${isDayUp ? '+' : ''}${summary.dayChangePercent.toFixed(2)}%)`
                    : '$••••••'
                }
                color={
                  showPortfolioValues
                    ? isDayUp
                      ? 'var(--accent-green)'
                      : 'var(--accent-red)'
                    : undefined
                }
                icon={
                  showPortfolioValues ? (
                    isDayUp ? (
                      <TrendingUp size={12} />
                    ) : (
                      <TrendingDown size={12} />
                    )
                  ) : undefined
                }
              />
              <Stat
                label="Total Return"
                value={
                  showPortfolioValues
                    ? `${isProfitable ? '+' : ''}$${summary.unrealizedPL.toFixed(2)} (${isProfitable ? '+' : ''}${summary.unrealizedPLPercent.toFixed(2)}%)`
                    : '$••••••'
                }
                color={
                  showPortfolioValues
                    ? isProfitable
                      ? 'var(--accent-green)'
                      : 'var(--accent-red)'
                    : undefined
                }
              />
              <Stat
                label="Cost Basis"
                value={
                  showPortfolioValues
                    ? `$${summary.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : '$••••••'
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* Value chart */}
      {summary && summary.holdings.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              Account Value
            </h3>
            <div className="flex gap-1">
              {RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  onClick={() => setDays(opt.days)}
                  className="px-2 py-0.5 rounded text-[11px] font-medium transition-colors"
                  style={{
                    background: days === opt.days ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                    color: days === opt.days ? 'white' : 'var(--text-muted)',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {chartData.length === 0 ? (
            <p className="text-sm py-12 text-center" style={{ color: 'var(--text-muted)' }}>
              No price history yet. Refresh finance data on the Finance page.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData}>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#737373' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#737373' }}
                  axisLine={false}
                  tickLine={false}
                  width={70}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
                />
                <Tooltip
                  contentStyle={{
                    background: '#1a1a1a',
                    border: '1px solid #2a2a2a',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: '#e5e5e5',
                  }}
                  formatter={(value: number) => [
                    `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                    'Value',
                  ]}
                />
                <ReferenceLine
                  y={summary.totalCost}
                  stroke="#737373"
                  strokeDasharray="3 3"
                  label={{ value: 'Cost', fill: '#737373', fontSize: 10, position: 'right' }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={isProfitable ? '#22c55e' : '#ef4444'}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* Holdings table */}
      {summary && summary.holdings.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
            Holdings
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr
                style={{ color: 'var(--text-muted)' }}
                className="text-xs uppercase tracking-wide"
              >
                <th className="text-left py-2 font-medium">Symbol</th>
                <th className="text-right py-2 font-medium">Qty</th>
                <th className="text-right py-2 font-medium">Avg Cost</th>
                <th className="text-right py-2 font-medium">Current</th>
                <th className="text-right py-2 font-medium">Value</th>
                <th className="text-right py-2 font-medium">P/L</th>
                <th className="text-right py-2 font-medium">Weight</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.holdings.map((h) => {
                const isUp = (h.unrealized_pl ?? 0) >= 0
                return (
                  <tr key={h.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="py-3 font-medium">{h.symbol}</td>
                    <td
                      className="py-3 text-right font-mono"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {h.quantity}
                    </td>
                    <td
                      className="py-3 text-right font-mono"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      ${h.cost_basis.toFixed(2)}
                    </td>
                    <td className="py-3 text-right font-mono">
                      {h.current_price != null ? `$${h.current_price.toFixed(2)}` : '--'}
                    </td>
                    <td className="py-3 text-right font-mono">
                      {h.market_value != null ? `$${h.market_value.toFixed(2)}` : '--'}
                    </td>
                    <td
                      className="py-3 text-right font-mono"
                      style={{ color: isUp ? 'var(--accent-green)' : 'var(--accent-red)' }}
                    >
                      {h.unrealized_pl != null
                        ? `${isUp ? '+' : ''}$${h.unrealized_pl.toFixed(2)} (${isUp ? '+' : ''}${(h.unrealized_pl_percent ?? 0).toFixed(2)}%)`
                        : '--'}
                    </td>
                    <td
                      className="py-3 text-right font-mono"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {h.weight_percent != null ? `${h.weight_percent.toFixed(1)}%` : '--'}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setEditing(h)}
                          className="text-xs p-1 rounded hover:bg-white/5"
                          style={{ color: 'var(--text-muted)' }}
                          title="Edit position"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Remove ${h.symbol} position? This cannot be undone.`))
                              return
                            await window.api.removeHolding(h.id)
                            refresh()
                          }}
                          className="text-xs p-1 rounded hover:bg-white/5"
                          style={{ color: 'var(--accent-red)' }}
                          title="Remove position"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddHoldingDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            refresh()
          }}
        />
      )}
      {editing && (
        <AddHoldingDialog
          initialHolding={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  color,
  icon,
}: {
  label: string
  value: string
  color?: string
  icon?: React.ReactNode
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p
        className="text-lg font-semibold font-mono mt-1 flex items-center gap-1.5"
        style={{ color: color || 'var(--text-primary)' }}
      >
        {icon}
        {value}
      </p>
    </div>
  )
}

function AddHoldingDialog({
  onClose,
  onSaved,
  initialHolding,
}: {
  onClose: () => void
  onSaved: () => void
  initialHolding?: HoldingRow | null
}) {
  const isEdit = !!initialHolding
  const [symbol, setSymbol] = useState(initialHolding?.symbol ?? '')
  const [quantity, setQuantity] = useState(initialHolding ? String(initialHolding.quantity) : '')
  const [costBasis, setCostBasis] = useState(
    initialHolding ? String(initialHolding.cost_basis) : '',
  )
  const [acquiredAt, setAcquiredAt] = useState(initialHolding?.acquired_at ?? '')
  const [notes, setNotes] = useState(initialHolding?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setError(null)
    const q = parseFloat(quantity)
    const cb = parseFloat(costBasis)
    if (!symbol.trim()) {
      setError('Symbol is required')
      return
    }
    if (!Number.isFinite(q) || q <= 0) {
      setError('Quantity must be a positive number')
      return
    }
    if (!Number.isFinite(cb) || cb <= 0) {
      setError('Cost basis must be a positive number')
      return
    }

    setSaving(true)
    try {
      if (isEdit && initialHolding) {
        await window.api.updateHolding(initialHolding.id, {
          symbol: symbol.trim().toUpperCase(),
          quantity: q,
          cost_basis: cb,
          acquired_at: acquiredAt || null,
          notes: notes.trim() || null,
        })
      } else {
        await window.api.addHolding({
          symbol: symbol.trim().toUpperCase(),
          quantity: q,
          cost_basis: cb,
          acquired_at: acquiredAt || null,
          notes: notes.trim() || null,
        })
      }
      onSaved()
    } catch (err: any) {
      setError(err?.message || 'Failed to save')
    }
    setSaving(false)
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="holding-modal-title"
    >
      <div className="card max-w-sm w-full m-4" onClick={(e) => e.stopPropagation()}>
        <h3 id="holding-modal-title" className="text-base font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
          {isEdit ? 'Edit Position' : 'Add Position'}
        </h3>
        <div className="space-y-3">
          <Field label="Symbol" value={symbol} onChange={setSymbol} placeholder="AAPL" autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Quantity"
              value={quantity}
              onChange={setQuantity}
              placeholder="10"
              type="number"
            />
            <Field
              label="Avg Cost ($)"
              value={costBasis}
              onChange={setCostBasis}
              placeholder="150.00"
              type="number"
            />
          </div>
          <Field
            label="Acquired (optional)"
            value={acquiredAt}
            onChange={setAcquiredAt}
            type="date"
          />
          <Field
            label="Notes (optional)"
            value={notes}
            onChange={setNotes}
            placeholder="Long-term hold"
          />
        </div>
        {error && (
          <p className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
            style={{ background: 'var(--accent-blue)', color: 'white' }}
          >
            {saving ? 'Saving...' : isEdit ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  autoFocus?: boolean
}) {
  return (
    <label className="block">
      <span
        className="text-xs uppercase tracking-wide block mb-1"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full text-sm px-3 py-1.5 rounded-md border outline-none transition-colors"
        style={{
          background: 'var(--bg-tertiary)',
          borderColor: 'var(--separator)',
          color: 'var(--text-primary)',
        }}
      />
    </label>
  )
}
