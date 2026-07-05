import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { TrendBadgeProps } from './types'

function linearTrend(data: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = data.length
  if (n < 2) return { slope: 0, intercept: data[0]?.y ?? 0 }
  const sumX = data.reduce((s, d) => s + d.x, 0)
  const sumY = data.reduce((s, d) => s + d.y, 0)
  const sumXY = data.reduce((s, d) => s + d.x * d.y, 0)
  const sumX2 = data.reduce((s, d) => s + d.x * d.x, 0)
  const denom = n * sumX2 - sumX * sumX
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  return { slope, intercept }
}

export default function TrendBadge({
  data,
  unit = '',
  higherIsBetter = true,
  window = 'wk',
  compact = false,
}: TrendBadgeProps) {
  if (!data || data.length < 3) return null

  const reg = linearTrend(data.map((y, x) => ({ x, y })))
  const multiplier = window === 'wk' ? 7 : 1
  const change = parseFloat((reg.slope * multiplier).toFixed(1))
  const threshold = window === 'wk' ? 0.1 : 0.05

  if (Math.abs(change) < threshold) {
    return (
      <span
        className="inline-flex items-center gap-0.5 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <Minus size={compact ? 10 : 12} />
        {!compact && <span>Stable</span>}
      </span>
    )
  }

  const isGood = higherIsBetter ? change > 0 : change < 0
  const color = isGood ? 'var(--accent-green)' : 'var(--accent-red)'
  const Icon = change > 0 ? TrendingUp : TrendingDown
  const prefix = change > 0 ? '+' : ''

  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-medium" style={{ color }}>
      <Icon size={compact ? 10 : 12} />
      <span>
        {prefix}
        {change}
        {unit}
        {!compact && `/${window}`}
      </span>
    </span>
  )
}
