import { LineChart, Line, XAxis, YAxis, ResponsiveContainer } from 'recharts'
import Tooltip from '../charts/ChartTooltip'
import { format, parseISO } from 'date-fns'
import type { HealthMetric } from '../../../shared/types/ipc.types'
import { parseMetricValue } from '../../hooks/useHealthData'
import NoodleSpinner from '../anim/NoodleSpinner'

interface Props {
  metrics: HealthMetric[]
  loading: boolean
}

export default function HeartRateChart({ metrics, loading }: Props) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-40">
        <NoodleSpinner size={64} color="var(--accent-red)" />
      </div>
    )
  }

  if (metrics.length === 0) {
    return (
      <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
        No heart rate data yet.
      </p>
    )
  }

  const data = [...metrics]
    .reverse()
    .map((m) => {
      const val = parseMetricValue(m)
      const bpm = (val.qty as number) || (val.Avg as number) || (val.value as number) || 0

      return {
        date: format(parseISO(m.date), 'EEE'),
        bpm: Math.round(bpm),
      }
    })
    .filter((d) => d.bpm > 0) // Skip days with no data (watch not worn)

  const latestBpm = data[data.length - 1]?.bpm || 0
  const avgBpm =
    data.length > 0 ? Math.round(data.reduce((sum, d) => sum + d.bpm, 0) / data.length) : 0

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Avg: {avgBpm} bpm
        </span>
        <span className="text-sm font-mono font-medium" style={{ color: 'var(--accent-red)' }}>
          {latestBpm} bpm
        </span>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            width={35}
            domain={['dataMin - 5', 'dataMax + 5']}
          />
          <Tooltip
            contentStyle={{
              background: '#1a1a1a',
              border: '1px solid #2a2a2a',
              borderRadius: '8px',
              fontSize: '12px',
              color: '#e5e5e5',
            }}
            formatter={(value: number) => [`${value} bpm`, 'Heart Rate']}
          />
          <Line
            type="monotone"
            dataKey="bpm"
            stroke="#ef4444"
            strokeWidth={2}
            dot={{ fill: '#ef4444', r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
