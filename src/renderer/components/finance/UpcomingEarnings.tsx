import { CalendarClock, RefreshCw } from 'lucide-react'
import { format, parseISO, differenceInCalendarDays } from 'date-fns'
import type { EarningsCalendarRow } from '../../hooks/useFinanceData'

interface Props {
  earnings: EarningsCalendarRow[]
  onRefresh?: () => void
  refreshing?: boolean
}

export default function UpcomingEarnings({ earnings, onRefresh, refreshing }: Props) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3
          className="text-sm font-medium flex items-center gap-2"
          style={{ color: 'var(--text-primary)' }}
        >
          <CalendarClock size={14} style={{ color: 'var(--accent-amber)' }} />
          Upcoming Earnings (7d)
        </h3>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors disabled:opacity-40"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
            title="Refresh fundamentals + earnings (uses Alpha Vantage quota)"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            Fetch
          </button>
        )}
      </div>
      {earnings.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No watchlist symbols report earnings in the next 7 days.
        </p>
      ) : (
        <div className="space-y-1.5">
          {earnings.map((e) => {
            const reportDate = parseISO(e.report_date)
            const daysAway = differenceInCalendarDays(reportDate, new Date())
            const label = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway}d`
            return (
              <div
                key={`${e.symbol}-${e.report_date}`}
                className="flex items-center justify-between text-sm py-1.5 px-2 rounded-md"
                style={{ background: 'var(--bg-tertiary)' }}
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {e.symbol}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {format(reportDate, 'EEE MMM d')} · {label}
                  </span>
                </div>
                {e.eps_estimate != null && (
                  <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                    est. ${e.eps_estimate.toFixed(2)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
