import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from 'recharts'
import Tooltip from '../charts/ChartTooltip'
import { format, parseISO } from 'date-fns'
import type { HealthMetric } from '../../../shared/types/ipc.types'
import { parseMetricValue } from '../../hooks/useHealthData'
import NoodleSpinner from '../anim/NoodleSpinner'

interface Props {
  metrics: HealthMetric[]
  loading: boolean
}

export default function SleepChart({ metrics, loading }: Props) {
  if (loading) {
    return <LoadingPlaceholder />
  }

  if (metrics.length === 0) {
    return <EmptyState message="No sleep data yet. Connect Health Auto Export or import a file." />
  }

  const data = [...metrics]
    .reverse()
    .map((m) => {
      const val = parseMetricValue(m)
      // Health Auto Export can report sleep in various formats
      const asleep =
        (val.totalAsleep as number) || (val.asleep as number) || (val.qty as number) || 0
      const inBed = (val.inBed as number) || (val.totalInBed as number) || asleep
      const hours = asleep / 60 // Convert minutes to hours

      return {
        date: format(parseISO(m.date), 'EEE'),
        fullDate: m.date,
        hours: parseFloat(hours.toFixed(1)),
        inBed: parseFloat((inBed / 60).toFixed(1)),
        sleepStart: (val.sleepStart as string) || null,
        sleepEnd: (val.sleepEnd as string) || null,
      }
    })
    .filter((d) => d.hours >= 1) // Skip unrecorded nights

  const avgHours = data.length > 0 ? data.reduce((sum, d) => sum + d.hours, 0) / data.length : 0

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          7-day average
        </span>
        <span className="text-sm font-mono font-medium" style={{ color: 'var(--accent-purple)' }}>
          {avgHours.toFixed(1)}h
        </span>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barCategoryGap="20%">
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[0, 12]}
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            width={25}
            tickFormatter={(v) => `${v}h`}
          />
          <Tooltip
            contentStyle={{
              background: '#1a1a1a',
              border: '1px solid #2a2a2a',
              borderRadius: '8px',
              fontSize: '12px',
              color: '#e5e5e5',
            }}
            formatter={(value: number, name: string) => [
              `${value}h`,
              name === 'hours' ? 'Asleep' : 'In Bed',
            ]}
          />
          <Bar dataKey="hours" fill="#a855f7" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function LoadingPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-40">
      <NoodleSpinner size={64} color="var(--accent-purple)" />
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
      {message}
    </p>
  )
}
