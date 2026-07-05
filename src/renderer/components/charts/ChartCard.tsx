import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ChartCardProps } from './types'
import { formatLastUpdated } from '../../hooks/useManualQuery'

export default function ChartCard({
  title,
  subtitle,
  lastUpdated,
  onRefresh,
  loading = false,
  range,
  onRangeChange,
  rangeOptions,
  actions,
  density = 'comfortable',
  className,
  children,
}: ChartCardProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!lastUpdated) return
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [lastUpdated])

  const padding = density === 'compact' ? 'p-3' : density === 'spacious' ? 'p-5' : 'p-4'
  const titleSize = density === 'compact' ? 'text-xs' : density === 'spacious' ? 'text-base' : 'text-sm'
  const updatedLabel = lastUpdated ? formatLastUpdated(lastUpdated) : null
  void now

  return (
    <div
      className={`border ${padding} ${className || ''}`}
      style={{
        backgroundColor: 'var(--bg-card)',
        backgroundImage:
          'linear-gradient(180deg, var(--card-grad-from) 0%, var(--card-grad-to) 100%)',
        borderColor: 'var(--border)',
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--elevation-1), inset 0 1px 0 var(--surface-highlight)',
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h3
            className={`font-display ${titleSize} font-bold tracking-tight truncate`}
            style={{ color: 'var(--text-primary)' }}
          >
            {title}
          </h3>
          {subtitle && (
            <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
              {subtitle}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {rangeOptions && onRangeChange && (
            <div
              className="flex rounded-md overflow-hidden"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {rangeOptions.map((opt) => {
                const active = range === opt.days
                return (
                  <button
                    key={opt.days}
                    onClick={() => onRangeChange(opt.days)}
                    className="px-2 py-0.5 text-[10px] font-medium transition-colors"
                    style={{
                      background: active ? 'var(--accent-blue)' : 'transparent',
                      color: active ? '#fff' : 'var(--text-secondary)',
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          )}

          {actions}

          {onRefresh && (
            <button
              onClick={() => void onRefresh()}
              disabled={loading}
              title={updatedLabel ? `Updated ${updatedLabel}` : 'Refresh'}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-opacity disabled:opacity-50 hover:opacity-80"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
              {updatedLabel && <span className="text-[10px]">{updatedLabel}</span>}
            </button>
          )}
        </div>
      </div>

      <div>{children}</div>
    </div>
  )
}
