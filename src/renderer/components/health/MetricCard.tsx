import type { HealthMetric } from '../../../shared/types/ipc.types'
import { parseMetricValue } from '../../hooks/useHealthData'
import NoodleSpinner from '../anim/NoodleSpinner'

interface Props {
  title: string
  icon: React.ReactNode
  color: string
  metrics: HealthMetric[]
  loading: boolean
  unit: string
  valueExtractor?: (val: Record<string, unknown>) => number | null
  formatter?: (value: number) => string
}

export default function MetricCard({
  title,
  icon,
  color,
  metrics,
  loading,
  unit,
  valueExtractor,
  formatter,
}: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-20">
        <NoodleSpinner size={32} color={color} />
      </div>
    )
  }

  const extract = valueExtractor || ((val) => (val.qty as number) ?? (val.value as number) ?? null)

  const values = metrics
    .map((m) => {
      const val = parseMetricValue(m)
      return extract(val)
    })
    .filter((v): v is number => v !== null && v > 0)

  const latest = values[0]
  const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
  const format = formatter || ((v: number) => Math.round(v).toLocaleString())

  return (
    <div>
      <div className="flex items-center gap-2 mb-3" style={{ color }}>
        {icon}
        <span className="text-sm font-medium uppercase tracking-wide">{title}</span>
      </div>
      {latest != null ? (
        <div>
          <p className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {format(latest)}
            <span className="text-sm font-normal ml-1" style={{ color: 'var(--text-muted)' }}>
              {unit}
            </span>
          </p>
          {avg != null && values.length > 1 && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              7-day avg: {format(avg)} {unit}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No data yet
        </p>
      )}
    </div>
  )
}
