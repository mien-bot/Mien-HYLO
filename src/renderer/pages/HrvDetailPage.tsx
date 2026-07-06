import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Activity } from 'lucide-react'
import { useTableSort, SortHeader } from '../components/tables/SortableTable'
import {
  LineChart,
  Line,
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

// HRV (RMSSD) population norms by age — Nunan et al. 2010 meta-analysis; Shaffer & Ginsberg 2017
function getHrvNorms(age: number | null) {
  if (!age) return { ageGroup: 'Adults', avg: 55, sd: 18 }
  if (age < 20) return { ageGroup: '14-19', avg: 72, sd: 22 }
  if (age < 30) return { ageGroup: '20-29', avg: 65, sd: 20 }
  if (age < 40) return { ageGroup: '30-39', avg: 55, sd: 18 }
  if (age < 50) return { ageGroup: '40-49', avg: 45, sd: 16 }
  if (age < 60) return { ageGroup: '50-59', avg: 35, sd: 14 }
  return { ageGroup: '60+', avg: 27, sd: 11 }
}

function pctRank(you: number, mean: number, sd: number): number {
  if (sd <= 0) return 50
  const z = (you - mean) / sd
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const phi = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly
  return Math.round((z >= 0 ? phi : 1 - phi) * 100)
}

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

export default function HrvDetailPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const [userAge, setUserAge] = useState<number | null>(null)

  useEffect(() => {
    window.api.getSettings('appSettings').then((val: any) => {
      const age = val?.userAge ? parseInt(val.userAge) : null
      if (age && age > 0 && age < 120) setUserAge(age)
    })
  }, [])
  const { metrics, loading } = useHealthMetrics('hrv', range === 9999 ? 3000 : range)

  const data = useMemo(() => {
    return [...metrics]
      .reverse()
      .map((m) => {
        const val = parseMetricValue(m)
        const hrv =
          Math.round(
            ((val.qty as number) || (val.avg as number) || (val.value as number) || 0) * 10,
          ) / 10
        const min = Math.round(((val.min as number) || 0) * 10) / 10
        const max = Math.round(((val.max as number) || 0) * 10) / 10

        return {
          date: format(parseISO(m.date), range <= 14 ? 'EEE M/d' : 'M/d'),
          fullDate: m.date,
          hrv,
          min: min || undefined,
          max: max || undefined,
        }
      })
      .filter((d) => d.hrv > 0)
  }, [metrics, range])

  const avgHrv =
    data.length > 0
      ? Math.round((data.reduce((sum, d) => sum + d.hrv, 0) / data.length) * 10) / 10
      : 0
  const maxHrv = data.length > 0 ? Math.round(Math.max(...data.map((d) => d.hrv)) * 10) / 10 : 0
  const minHrv = data.length > 0 ? Math.round(Math.min(...data.map((d) => d.hrv)) * 10) / 10 : 0
  const latestHrv = data.length > 0 ? data[data.length - 1].hrv : 0
  const maxHrvDate = data.find((d) => d.hrv === maxHrv)?.fullDate
  const minHrvDate = data.find((d) => d.hrv === minHrv)?.fullDate
  const formatSummaryDate = (date?: string) => (date ? format(parseISO(date), 'MMM d, yyyy') : '')

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
          hrv: undefined,
        }
      )
    })
  }, [data, range])

  const yearDividers = useMemo(() => getYearDividers(allDays), [allDays])

  const hrvSortAccessors = useMemo(() => ({
    date: (d: any) => d.fullDate,
    hrv: (d: any) => d.hrv ?? -1,
    min: (d: any) => d.min ?? -1,
    max: (d: any) => d.max ?? -1,
    baseline: (d: any) => (d.hrv ?? 0) - avgHrv,
  }), [avgHrv])

  const { sorted: sortedHrv, sortKey: hrvSortKey, sortDir: hrvSortDir, toggle: toggleHrvSort } = useTableSort([...data].reverse(), hrvSortAccessors)

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
        <Activity size={20} style={{ color: 'var(--accent-blue)' }} />
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          HRV History
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
              background: range === opt.days ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
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
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Latest
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-blue)' }}>
            {latestHrv}
            <span className="text-sm font-normal ml-1">ms</span>
          </p>
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Average
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
            {avgHrv}
            <span className="text-sm font-normal ml-1">ms</span>
          </p>
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Highest
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-green)' }}>
            {maxHrv}
            <span className="text-sm font-normal ml-1">ms</span>
          </p>
          {maxHrvDate && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {formatSummaryDate(maxHrvDate)}
            </p>
          )}
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Lowest
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-red)' }}>
            {minHrv}
            <span className="text-sm font-normal ml-1">ms</span>
          </p>
          {minHrvDate && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {formatSummaryDate(minHrvDate)}
            </p>
          )}
        </div>
      </div>

      {/* Age comparison */}
      {avgHrv > 0 &&
        (() => {
          const norms = getHrvNorms(userAge)
          const pct = pctRank(avgHrv, norms.avg, norms.sd)
          const diff = avgHrv - norms.avg
          const rankLabel = pct >= 50 ? `Top ${100 - pct}%` : `Bottom ${pct}%`
          const color =
            pct >= 60
              ? 'var(--accent-green)'
              : pct >= 35
                ? 'var(--accent-amber)'
                : 'var(--accent-red)'
          return (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Activity size={14} style={{ color: 'var(--accent-blue)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    How You Compare
                  </span>
                </div>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: 'rgba(59,130,246,0.12)', color: 'var(--accent-blue)' }}
                >
                  Ages {norms.ageGroup}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-3 mb-3">
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Your Avg
                  </span>
                  <p className="text-xl font-bold mt-0.5" style={{ color: 'var(--accent-blue)' }}>
                    {avgHrv}
                    <span className="text-xs font-normal ml-0.5">ms</span>
                  </p>
                </div>
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Peer Avg
                  </span>
                  <p
                    className="text-xl font-bold mt-0.5"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {norms.avg}
                    <span className="text-xs font-normal ml-0.5">ms</span>
                  </p>
                </div>
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Difference
                  </span>
                  <p
                    className="text-xl font-bold mt-0.5"
                    style={{ color: diff >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
                  >
                    {diff >= 0 ? '+' : ''}
                    {Math.round(diff)}
                    <span className="text-xs font-normal ml-0.5">ms</span>
                  </p>
                </div>
                <div
                  className="p-3 rounded-lg text-center"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Rank
                  </span>
                  <p className="text-xl font-bold mt-0.5" style={{ color }}>
                    {rankLabel}
                  </p>
                </div>
              </div>
              <div
                className="h-2 rounded-full overflow-hidden mb-1"
                style={{ background: 'var(--bg-tertiary)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, background: color }}
                />
              </div>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {pct}th percentile for ages {norms.ageGroup} · Nunan et al. 2010 · Shaffer &
                Ginsberg 2017
                {!userAge ? ' · Set your age in Settings for age-adjusted norms' : ''}
              </p>
            </div>
          )
        })()}

      {/* Main chart */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Heart Rate Variability
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {data.length} readings
          </span>
        </div>
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64">
            <NoodleSpinner size={72} color="var(--accent-blue)" label="Loading HRV data…" />
          </div>
        ) : data.length === 0 ? (
          <p className="text-sm py-16 text-center" style={{ color: 'var(--text-muted)' }}>
            No HRV data for this range.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={allDays} margin={{ top: 8, right: 28, left: 0, bottom: 8 }}>
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
                  if (value === undefined) return ['—', 'HRV']
                  const labels: Record<string, string> = { hrv: 'HRV', min: 'Min', max: 'Max' }
                  return [`${Math.round(value * 10) / 10}ms`, labels[name] || name]
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
                y={avgHrv}
                stroke="var(--accent-blue)"
                strokeDasharray="5 5"
                strokeWidth={1}
                label={{
                  value: `avg ${avgHrv}ms`,
                  position: 'right',
                  fontSize: 10,
                  fill: '#3b82f6',
                }}
              />
              <Line
                type="monotone"
                dataKey="hrv"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={data.length <= 30}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Daily log */}
      <div className="card">
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Daily Log
        </span>
        <div className="mt-3 overflow-auto max-h-[600px]">
          <table className="w-full text-xs" style={{ minWidth: '400px' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <SortHeader label="Date" sortKey="date" currentKey={hrvSortKey} currentDir={hrvSortDir} onSort={toggleHrvSort} align="left" />
                <SortHeader label="HRV (avg)" sortKey="hrv" currentKey={hrvSortKey} currentDir={hrvSortDir} onSort={toggleHrvSort} />
                <SortHeader label="Min" sortKey="min" currentKey={hrvSortKey} currentDir={hrvSortDir} onSort={toggleHrvSort} />
                <SortHeader label="Max" sortKey="max" currentKey={hrvSortKey} currentDir={hrvSortDir} onSort={toggleHrvSort} />
                <SortHeader label="vs Baseline" sortKey="baseline" currentKey={hrvSortKey} currentDir={hrvSortDir} onSort={toggleHrvSort} />
              </tr>
            </thead>
            <tbody>
              {sortedHrv.map((d, i) => {
                const diff = d.hrv - avgHrv
                return (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--separator)' }}>
                    <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                      {format(parseISO(d.fullDate), 'EEE, MMM d')}
                    </td>
                    <td
                      className="text-right py-2 font-mono font-medium"
                      style={{ color: 'var(--accent-blue)' }}
                    >
                      {d.hrv}ms
                    </td>
                    <td
                      className="text-right py-2 font-mono"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {d.min ? `${d.min}` : '—'}
                    </td>
                    <td
                      className="text-right py-2 font-mono"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {d.max ? `${d.max}` : '—'}
                    </td>
                    <td
                      className="text-right py-2 font-mono"
                      style={{ color: diff >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
                    >
                      {diff >= 0 ? '+' : ''}
                      {Math.round(diff * 10) / 10}
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
