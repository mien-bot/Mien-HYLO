import { useState } from 'react'
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer } from 'recharts'
import Tooltip from '../charts/ChartTooltip'
import { usePriceHistory } from '../../hooks/useFinanceData'
import { format, parseISO } from 'date-fns'

const RANGE_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1Y', days: 365 },
] as const

interface Props {
  symbol: string | null
  days?: number
}

export default function PriceChart({ symbol, days: defaultDays = 30 }: Props) {
  const [days, setDays] = useState(defaultDays)
  const history = usePriceHistory(symbol, days)

  if (!symbol) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Select a symbol to view price chart
        </p>
      </div>
    )
  }

  if (history.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No price history for {symbol}. Click Refresh to fetch data.
        </p>
      </div>
    )
  }

  const data = [...history]
    .reverse()
    .filter((h) => h.close != null)
    .map((h) => ({
      date: h.date,
      price: h.close!,
      label: format(parseISO(h.date), 'MMM d'),
    }))

  const prices = data.map((d) => d.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const isUp = data.length >= 2 && data[data.length - 1].price >= data[0].price
  const lineColor = isUp ? '#30d158' : '#ff453a'
  const gradId = `price-fill-${isUp ? 'up' : 'down'}`

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-display text-sm font-bold">
          {symbol} — {RANGE_OPTIONS.find((r) => r.days === days)?.label || `${days}d`}
        </h4>
        <div className="flex items-center gap-2">
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
          <span
            className="text-xs font-mono"
            style={{ color: isUp ? 'var(--accent-green)' : 'var(--accent-red)' }}
          >
            ${data[data.length - 1]?.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.35} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[min * 0.99, max * 1.01]}
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            width={60}
            tickFormatter={(v) => `$${v.toLocaleString()}`}
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
              'Price',
            ]}
          />
          <Area
            type="monotone"
            dataKey="price"
            stroke={lineColor}
            strokeWidth={2.5}
            strokeLinecap="round"
            fill={`url(#${gradId})`}
            dot={false}
            isAnimationActive
            animationDuration={700}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
