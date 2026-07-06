import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Heart } from 'lucide-react'
import { useTableSort, SortHeader } from '../components/tables/SortableTable'
import {
  LineChart,
  Line,
  Area,
  ComposedChart,
  XAxis,
  YAxis,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from 'recharts'
import Tooltip from '../components/charts/ChartTooltip'
import { format, parseISO, subDays, eachDayOfInterval } from 'date-fns'
import { useHealthMetrics, parseMetricValue } from '../hooks/useHealthData'
import NoodleSpinner from '../components/anim/NoodleSpinner'

const RANGE_OPTIONS = [
  { label: '7D', days: 7 },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
  { label: 'All', days: 9999 },
]

function formatDateTick(value: string | number, range: number): string {
  try {
    const d = parseISO(String(value))
    if (range <= 14) return format(d, 'EEE M/d')
    if (d.getMonth() === 0 && d.getDate() <= 14) return format(d, "M/d ''yy")
    return format(d, 'M/d')
  } catch {
    return String(value)
  }
}

function formatTooltipDate(value: string | number): string {
  try {
    return format(parseISO(String(value)), 'M/d/yyyy')
  } catch {
    return String(value)
  }
}

function getYearDividers(chartData: Array<{ fullDate: string }>) {
  const boundaries: { fullDate: string; year: string; index: number }[] = []
  let prevYear = ''
  for (let i = 0; i < chartData.length; i++) {
    const fullDate = chartData[i]?.fullDate
    if (!fullDate) continue
    const year = fullDate.slice(0, 4)
    if (year !== prevYear) {
      boundaries.push({ fullDate, year, index: i })
      prevYear = year
    }
  }
  return boundaries.length > 1 ? boundaries.filter((b) => b.index > 0) : []
}

function hrZone(bpm: number): { label: string; color: string } {
  if (bpm < 60) return { label: 'Low', color: 'var(--accent-blue)' }
  if (bpm <= 100) return { label: 'Normal', color: 'var(--accent-green)' }
  return { label: 'Elevated', color: 'var(--accent-red)' }
}

export default function HeartRateDetailPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)

  const { metrics: hrMetrics, loading: hrLoading } = useHealthMetrics(
    'heart_rate',
    range === 9999 ? 3000 : range,
  )
  const { metrics: rhrMetrics, loading: rhrLoading } = useHealthMetrics(
    'resting_heart_rate',
    range === 9999 ? 3000 : range,
  )

  const data = useMemo(() => {
    const rhrByDate = new Map(
      rhrMetrics.map((m) => {
        const val = parseMetricValue(m)
        return [m.date, Math.round((val.qty as number) || (val.Avg as number) || (val.value as number) || 0)]
      }),
    )

    return [...hrMetrics]
      .reverse()
      .map((m) => {
        const val = parseMetricValue(m)
        const bpm = Math.round(
          (val.qty as number) || (val.Avg as number) || (val.value as number) || 0,
        )
        const min = Math.round((val.min as number) || 0)
        const max = Math.round((val.max as number) || 0)
        const rhr = rhrByDate.get(m.date) || undefined

        return {
          date: format(parseISO(m.date), range <= 14 ? 'EEE M/d' : 'M/d'),
          fullDate: m.date,
          bpm,
          min: min || undefined,
          max: max || undefined,
          rhr,
        }
      })
      .filter((d) => d.bpm > 0)
  }, [hrMetrics, rhrMetrics, range])

  const avgBpm = data.length > 0 ? Math.round(data.reduce((s, d) => s + d.bpm, 0) / data.length) : 0
  const maxBpm = data.length > 0 ? Math.max(...data.map((d) => d.bpm)) : 0
  const minBpm = data.length > 0 ? Math.min(...data.map((d) => d.bpm)) : 0
  const latestBpm = data.length > 0 ? data[data.length - 1].bpm : 0
  const maxBpmDate = data.find((d) => d.bpm === maxBpm)?.fullDate
  const minBpmDate = data.find((d) => d.bpm === minBpm)?.fullDate
  const formatSummaryDate = (date?: string) => (date ? format(parseISO(date), 'MMM d, yyyy') : '')

  // Resting HR stats
  const rhrData = data.filter((d) => d.rhr && d.rhr > 0)
  const avgRhr = rhrData.length > 0 ? Math.round(rhrData.reduce((s, d) => s + d.rhr!, 0) / rhrData.length) : 0
  const latestRhr = rhrData.length > 0 ? rhrData[rhrData.length - 1].rhr! : 0

  // Build full date range with gaps
  const allDays = useMemo(() => {
    if (range > 90) return data
    const today = new Date()
    const interval = eachDayOfInterval({
      start: subDays(today, range),
      end: subDays(today, 1),
    })
    const dataByDate = new Map(data.map((d) => [d.fullDate, d]))
    return interval.map((date) => {
      const dateStr = format(date, 'yyyy-MM-dd')
      return (
        dataByDate.get(dateStr) || {
          date: format(date, range <= 14 ? 'EEE M/d' : 'M/d'),
          fullDate: dateStr,
          bpm: undefined,
        }
      )
    })
  }, [data, range])

  const yearDividers = useMemo(() => getYearDividers(allDays), [allDays])

  const sortAccessors = useMemo(
    () => ({
      date: (d: any) => d.fullDate,
      bpm: (d: any) => d.bpm ?? -1,
      min: (d: any) => d.min ?? -1,
      max: (d: any) => d.max ?? -1,
      rhr: (d: any) => d.rhr ?? -1,
      baseline: (d: any) => (d.bpm ?? 0) - avgBpm,
    }),
    [avgBpm],
  )

  const {
    sorted: sortedData,
    sortKey,
    sortDir,
    toggle: toggleSort,
  } = useTableSort([...data].reverse(), sortAccessors)

  const loading = hrLoading || rhrLoading

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/health')}
          className="p-1.5 rounded-lg transition-colors hover:opacity-80"
          style={{ background: 'var(--bg-tertiary)' }}
          aria-label="Back to health"
        >
          <ArrowLeft size={18} style={{ color: 'var(--text-secondary)' }} />
        </button>
        <Heart size={20} style={{ color: 'var(--accent-red)' }} />
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Heart Rate History
        </h2>
      </div>

      {/* Range selector */}
      <div className="flex items-center gap-2">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.days}
            onClick={() => setRange(opt.days)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: range === opt.days ? '#ef4444' : 'var(--bg-tertiary)',
              color: range === opt.days ? 'white' : 'var(--text-secondary)',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4">
        <div className="card">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Latest
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-red)' }}>
            {latestBpm}
            <span className="text-sm font-normal ml-1">bpm</span>
          </p>
          {latestBpm > 0 && (
            <p className="text-xs mt-0.5" style={{ color: hrZone(latestBpm).color }}>
              {hrZone(latestBpm).label}
            </p>
          )}
        </div>
        <div className="card">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Average
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
            {avgBpm}
            <span className="text-sm font-normal ml-1">bpm</span>
          </p>
        </div>
        <div className="card">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Highest
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-red)' }}>
            {maxBpm}
            <span className="text-sm font-normal ml-1">bpm</span>
          </p>
          {maxBpmDate && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {formatSummaryDate(maxBpmDate)}
            </p>
          )}
        </div>
        <div className="card">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Lowest
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-blue)' }}>
            {minBpm}
            <span className="text-sm font-normal ml-1">bpm</span>
          </p>
          {minBpmDate && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {formatSummaryDate(minBpmDate)}
            </p>
          )}
        </div>
      </div>

      {/* Resting HR card */}
      {avgRhr > 0 && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Heart size={14} style={{ color: 'var(--accent-red)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Resting Heart Rate
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-lg text-center" style={{ background: 'var(--bg-tertiary)' }}>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Latest</span>
              <p className="text-xl font-bold mt-0.5" style={{ color: 'var(--accent-red)' }}>
                {latestRhr}<span className="text-xs font-normal ml-0.5">bpm</span>
              </p>
            </div>
            <div className="p-3 rounded-lg text-center" style={{ background: 'var(--bg-tertiary)' }}>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Average</span>
              <p className="text-xl font-bold mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {avgRhr}<span className="text-xs font-normal ml-0.5">bpm</span>
              </p>
            </div>
            <div className="p-3 rounded-lg text-center" style={{ background: 'var(--bg-tertiary)' }}>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Rating</span>
              <p className="text-xl font-bold mt-0.5" style={{ color: hrZone(avgRhr).color }}>
                {avgRhr < 60 ? 'Athlete' : avgRhr <= 70 ? 'Good' : avgRhr <= 80 ? 'Average' : 'High'}
              </p>
            </div>
          </div>
          <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
            Normal resting HR: 60-100 bpm. Athletes often have 40-60 bpm.
          </p>
        </div>
      )}

      {/* Main chart */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Daily Heart Rate
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {data.length} readings
          </span>
        </div>
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64">
            <NoodleSpinner size={72} color="var(--accent-red)" label="Loading heart rate data..." />
          </div>
        ) : data.length === 0 ? (
          <p className="text-sm py-16 text-center" style={{ color: 'var(--text-muted)' }}>
            No heart rate data for this range.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={allDays} margin={{ top: 8, right: 28, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
              <XAxis
                dataKey="fullDate"
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                padding={{ left: 8, right: 28 }}
                interval={data.length > 30 ? Math.floor(data.length / 15) : 0}
                tickFormatter={(value) => formatDateTick(value, range)}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                width={35}
                domain={['dataMin - 5', 'dataMax + 5']}
                tickFormatter={(v) => `${Math.round(v)}`}
              />
              <Tooltip
                contentStyle={{
                  background: '#1a1a1a',
                  border: '1px solid #2a2a2a',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: '#e5e5e5',
                }}
                labelFormatter={formatTooltipDate}
                formatter={(value: number | undefined, name: string) => {
                  if (value === undefined) return ['—', 'HR']
                  const labels: Record<string, string> = {
                    bpm: 'Avg HR',
                    min: 'Min',
                    max: 'Max',
                    rhr: 'Resting',
                  }
                  return [`${Math.round(value)} bpm`, labels[name] || name]
                }}
              />
              {yearDividers.map((divider) => (
                <ReferenceLine
                  key={`${divider.year}-${divider.fullDate}`}
                  x={divider.fullDate}
                  stroke="var(--text-secondary)"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  strokeOpacity={0.9}
                  label={{
                    value: divider.year,
                    position: 'top',
                    fontSize: 12,
                    fill: 'var(--text-secondary)',
                    fontWeight: 700,
                  }}
                />
              ))}
              <ReferenceLine
                y={avgBpm}
                stroke="#ef4444"
                strokeDasharray="5 5"
                strokeWidth={1}
                label={{
                  value: `avg ${avgBpm}`,
                  position: 'right',
                  fontSize: 10,
                  fill: '#ef4444',
                }}
              />
              {/* Min-Max range area */}
              {data.some((d) => d.min && d.max) && (
                <Area
                  type="monotone"
                  dataKey="max"
                  stroke="none"
                  fill="#ef4444"
                  fillOpacity={0.08}
                  connectNulls={false}
                />
              )}
              <Line
                type="monotone"
                dataKey="bpm"
                stroke="#ef4444"
                strokeWidth={2}
                dot={data.length <= 30}
                connectNulls={false}
              />
              {rhrData.length > 0 && (
                <Line
                  type="monotone"
                  dataKey="rhr"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                  connectNulls={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {rhrData.length > 0 && !loading && data.length > 0 && (
          <div className="flex items-center gap-4 mt-2 ml-10">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-0.5" style={{ background: '#ef4444' }} />
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Avg HR</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-0.5" style={{ background: '#3b82f6', borderTop: '1px dashed #3b82f6' }} />
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Resting HR</span>
            </div>
          </div>
        )}
      </div>

      {/* Daily log */}
      <div className="card">
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Daily Log
        </span>
        <div className="mt-3 overflow-auto max-h-[600px]">
          <table className="w-full text-xs" style={{ minWidth: '500px' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <SortHeader label="Date" sortKey="date" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} align="left" />
                <SortHeader label="Avg HR" sortKey="bpm" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Min" sortKey="min" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Max" sortKey="max" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Resting" sortKey="rhr" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                <SortHeader label="vs Avg" sortKey="baseline" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {sortedData.map((d: any, i: number) => {
                const diff = d.bpm - avgBpm
                const zone = hrZone(d.bpm)
                return (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--separator)' }}>
                    <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                      {format(parseISO(d.fullDate), 'EEE, MMM d')}
                    </td>
                    <td className="text-right py-2 font-mono font-medium" style={{ color: zone.color }}>
                      {d.bpm} bpm
                    </td>
                    <td className="text-right py-2 font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {d.min ? d.min : '—'}
                    </td>
                    <td className="text-right py-2 font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {d.max ? d.max : '—'}
                    </td>
                    <td className="text-right py-2 font-mono" style={{ color: d.rhr ? '#3b82f6' : 'var(--text-muted)' }}>
                      {d.rhr ? d.rhr : '—'}
                    </td>
                    <td
                      className="text-right py-2 font-mono"
                      style={{ color: diff >= 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}
                    >
                      {diff >= 0 ? '+' : ''}
                      {diff}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
