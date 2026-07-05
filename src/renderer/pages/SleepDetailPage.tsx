import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Moon,
  TrendingUp,
  TrendingDown,
  Minus,
  Filter,
  Calendar,
  RefreshCw,
  Dumbbell,
  Heart,
  Zap,
  Lightbulb,
  Smartphone,
  ShowerHead,
  Coffee,
  Wind,
  BookOpen,
  Bed,
  Clock,
} from 'lucide-react'
import { useTableSort, SortHeader } from '../components/tables/SortableTable'
import {
  BarChart,
  Bar,
  Cell,
  LineChart,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from 'recharts'
import { format, parseISO, subDays, eachDayOfInterval, differenceInDays } from 'date-fns'
import { useHealthMetrics, parseMetricValue } from '../hooks/useHealthData'
import NoodleSpinner from '../components/anim/NoodleSpinner'

function parseSleepTs(ts: string): number {
  if (!ts) return NaN
  let d = new Date(ts).getTime()
  if (!isNaN(d)) return d
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/)
  if (m) d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`).getTime()
  return d
}

const RANGE_OPTIONS = [
  { label: '7D', days: 7 },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
  { label: 'All', days: 9999 },
]

function linearTrend(data: { x: number; y: number }[]): {
  slope: number
  intercept: number
  points: number[]
} {
  const clean = data.filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y))
  const n = clean.length
  if (n < 2) return { slope: 0, intercept: clean[0]?.y || 0, points: data.map((d) => d.y || 0) }
  const sumX = clean.reduce((s, d) => s + d.x, 0)
  const sumY = clean.reduce((s, d) => s + d.y, 0)
  const sumXY = clean.reduce((s, d) => s + d.x * d.y, 0)
  const sumX2 = clean.reduce((s, d) => s + d.x * d.x, 0)
  const denom = n * sumX2 - sumX * sumX
  if (denom === 0) {
    const avg = sumY / n
    return { slope: 0, intercept: avg, points: data.map(() => parseFloat(avg.toFixed(2))) }
  }
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  return {
    slope,
    intercept,
    points: data.map((d) => parseFloat((slope * d.x + intercept).toFixed(2))),
  }
}

function formatClockHour(h: number): string {
  const normalized = ((h % 24) + 24) % 24
  const hour12 = Math.floor(normalized) % 12 || 12
  const ampm = normalized < 12 ? 'AM' : 'PM'
  return `${hour12} ${ampm}`
}

// Normal CDF approximation (Abramowitz & Stegun). Returns percentile 0-100.
function percentileRank(you: number, mean: number, sd: number): number {
  if (sd <= 0) return 50
  const z = (you - mean) / sd
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const phi = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly
  return Math.round((z >= 0 ? phi : 1 - phi) * 100)
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return 'th'
  const mod10 = n % 10
  if (mod10 === 1) return 'st'
  if (mod10 === 2) return 'nd'
  if (mod10 === 3) return 'rd'
  return 'th'
}

function sleepDurationColor(hours: number): string {
  if (hours <= 4) return '#7f1d1d'
  if (hours < 5) return '#dc2626'
  if (hours < 6) return '#f59e0b'
  if (hours < 7) return '#64748b'
  if (hours < 8) return '#3b82f6'
  if (hours < 9) return '#1d4ed8'
  return '#7c3aed'
}

function toHoursFromMidnight(timestamp: string): number | null {
  try {
    const dt = new Date(timestamp)
    if (isNaN(dt.getTime())) return null
    const hours = dt.getHours() + dt.getMinutes() / 60
    // Wrap evening hours (6 PM+) to negative so bedtimes plot correctly
    // but keep afternoon wake times (12 PM–5:59 PM) positive
    return hours >= 18 ? hours - 24 : hours
  } catch {
    return null
  }
}

function hasPlausibleSleepTiming(start: string | null, end: string | null, asleepHours: number): boolean {
  if (!start || !end) return false
  const ms = parseSleepTs(end) - parseSleepTs(start)
  if (!Number.isFinite(ms) || ms <= 0) return false
  const spanMinutes = Math.round(ms / 60000)
  const asleepMinutes = asleepHours * 60
  return spanMinutes >= asleepMinutes - 30 && spanMinutes <= asleepMinutes + 180
}

const tooltipStyle = {
  background: '#1a1a1a',
  border: '1px solid #2a2a2a',
  borderRadius: '8px',
  fontSize: '12px',
  color: '#e5e5e5',
}

function StageBreakdownTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null
  let displayLabel = label
  try {
    displayLabel = format(parseISO(String(label)), 'M/d/yyyy')
  } catch {}
  const stages = [
    { key: 'core', label: 'Core', color: '#818cf8' },
    { key: 'deep', label: 'Deep', color: '#6366f1' },
    { key: 'rem', label: 'REM', color: '#a78bfa' },
  ].filter((stage) => row[stage.key] > 0)

  return (
    <div className="rounded-lg px-3 py-2 text-xs" style={tooltipStyle}>
      <div className="mb-2 font-medium" style={{ color: 'var(--text-primary)' }}>
        {displayLabel}
      </div>
      <div className="mb-2 font-semibold" style={{ color: 'var(--accent-green)' }}>
        Total sleep: {row.hours}h
      </div>
      <div className="space-y-1">
        {stages.map((stage) => (
          <div key={stage.key} className="flex items-center justify-between gap-5">
            <span className="flex items-center gap-1.5" style={{ color: stage.color }}>
              <span className="w-2 h-2 rounded-sm" style={{ background: stage.color }} />
              {stage.label}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{row[stage.key]}h</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SleepDetailPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState(30)
  const [hideNoData, setHideNoData] = useState(false)
  const [minHoursFilter, setMinHoursFilter] = useState(0)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [useCustomRange, setUseCustomRange] = useState(false)
  const [recoveryData, setRecoveryData] = useState<any>(null)
  const [correlationData, setCorrelationData] = useState<any>(null)
  const [qualityHistory, setQualityHistory] = useState<any[]>([])
  const [regularity, setRegularity] = useState<any>(null)
  const [windDownRoutine, setWindDownRoutine] = useState<any>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [sleepNeed, setSleepNeed] = useState(8)
  const [sleepNeedProfile, setSleepNeedProfile] = useState<any>(null)
  const [sleepAnalysis, setSleepAnalysis] = useState<any>(null)
  const [showSleepNeedDetail, setShowSleepNeedDetail] = useState(false)

  const effectiveDays = useMemo(() => {
    if (useCustomRange && customFrom) {
      const from = parseISO(customFrom)
      const days = differenceInDays(new Date(), from) + 1
      return Math.max(days, 1)
    }
    return range === 9999 ? 3650 : range
  }, [range, useCustomRange, customFrom])

  const { metrics, loading, refresh } = useHealthMetrics('sleep', effectiveDays)

  // Load extra analysis data
  const loadAnalysisData = useCallback(async () => {
    try {
      const [recovery, corr, quality, reg, routine, sleepAnalysis, needProfile] = await Promise.all(
        [
          window.api.getRecoveryReadiness(),
          window.api.getSleepCorrelations(),
          window.api.getSleepQualityHistory(effectiveDays),
          window.api.getSleepRegularity(),
          window.api.getWindDownRoutine(),
          window.api.getSleepAnalysis(effectiveDays),
          window.api.getSleepNeedProfile(effectiveDays),
        ],
      )
      setRecoveryData(recovery)
      setCorrelationData(corr)
      setQualityHistory(quality || [])
      setRegularity(reg)
      setWindDownRoutine(routine)
      setSleepAnalysis(sleepAnalysis)
      setSleepNeedProfile(needProfile)
      if (sleepAnalysis?.debt?.sleepNeedEstimate) {
        setSleepNeed(parseFloat(sleepAnalysis.debt.sleepNeedEstimate.toFixed(1)))
      }
    } catch (err) {
      console.error('Failed to load analysis data:', err)
    }
  }, [effectiveDays])

  useEffect(() => {
    loadAnalysisData()
  }, [loadAnalysisData])

  // Auto-refresh on sleep data arrival
  useEffect(() => {
    const unsub = window.api.onSleepDataArrived(() => {
      refresh()
      loadAnalysisData()
    })
    return unsub
  }, [refresh, loadAnalysisData])

  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    setSyncStatus(null)
    try {
      const result = await window.api.relayPullHistoricalSleep(effectiveDays)
      await refresh()
      await loadAnalysisData()
      await window.api.relayPushSleepAnalysis()

      if (result?.success === false) {
        setSyncStatus(`Sync failed: ${result.error || 'check relay settings'}`)
      } else {
        const pulled = Number(result?.pulled || 0)
        setSyncStatus(pulled > 0 ? `Synced ${pulled} sleep record${pulled === 1 ? '' : 's'}` : 'Sleep data is current')
      }
    } catch (err: any) {
      setSyncStatus(`Sync failed: ${err.message || 'unknown error'}`)
      await refresh()
      await loadAnalysisData()
    } finally {
      setRefreshing(false)
      setTimeout(() => setSyncStatus(null), 4000)
    }
  }

  const data = useMemo(() => {
    let processed = [...metrics]
      .reverse()
      .map((m) => {
        const val = parseMetricValue(m)
        const asleep =
          (val.totalAsleep as number) || (val.asleep as number) || (val.qty as number) || 0
        const awake = (val.awake as number) || (val.awakeTime as number) || 0
        const sleepStartTs = (val.sleepStart as string) || null
        const sleepEndTs = (val.sleepEnd as string) || null
        let rawInBed = (val.inBed as number) || (val.totalInBed as number) || 0
        if (rawInBed === 0 && sleepStartTs && sleepEndTs) {
          const ms = parseSleepTs(sleepEndTs) - parseSleepTs(sleepStartTs)
          if (ms > 0) rawInBed = Math.round(ms / 60000)
        }
        const inBed = rawInBed || asleep + awake || asleep
        const deep = (val.deep as number) || 0
        const rem = (val.rem as number) || 0
        const core = (val.core as number) || 0
        const hours = asleep / 60
        const efficiency = inBed > 0 ? (asleep / inBed) * 100 : 0

        return {
          date: format(parseISO(m.date), range <= 14 && !useCustomRange ? 'EEE M/d' : 'M/d'),
          fullDate: m.date,
          hours: parseFloat(hours.toFixed(1)),
          inBed: parseFloat((inBed / 60).toFixed(1)),
          deep: parseFloat((deep / 60).toFixed(1)),
          rem: parseFloat((rem / 60).toFixed(1)),
          core: parseFloat((core / 60).toFixed(1)),
          awake: Math.round(awake),
          efficiency: parseFloat(efficiency.toFixed(0)),
          sleepStart: sleepStartTs,
          sleepEnd: sleepEndTs,
        }
      })
      .filter((d) => d.hours >= 1)

    if (useCustomRange) {
      if (customFrom) processed = processed.filter((d) => d.fullDate >= customFrom)
      if (customTo) processed = processed.filter((d) => d.fullDate <= customTo)
    }
    return processed
  }, [metrics, range, useCustomRange, customFrom, customTo])

  const dataWithTrend = useMemo(() => {
    const regression = linearTrend(data.map((d, i) => ({ x: i, y: d.hours })))
    const avg = data.length > 0 ? data.reduce((s, d) => s + d.hours, 0) / data.length : 0
    return data.map((d, i) => ({
      ...d,
      trend: regression.points[i],
      avg: parseFloat(avg.toFixed(1)),
      suggested: 8,
      year: d.fullDate.slice(0, 4),
    }))
  }, [data])

  // Find year boundaries for dividers
  const yearBoundaries = useMemo(() => {
    const boundaries: { index: number; year: string }[] = []
    let prevYear = ''
    for (let i = 0; i < dataWithTrend.length; i++) {
      const year = dataWithTrend[i].year
      if (year !== prevYear) {
        boundaries.push({ index: i, year })
        prevYear = year
      }
    }
    return boundaries
  }, [dataWithTrend])

  // Month boundaries as a fallback when the data spans <2 years.
  // Each boundary's label is "MMM" (e.g. "Mar"), or "MMM 'YY" at the year flip.
  const monthBoundaries = useMemo(() => {
    const boundaries: { index: number; label: string }[] = []
    let prevMonth = ''
    let prevYear = ''
    for (let i = 0; i < dataWithTrend.length; i++) {
      const month = dataWithTrend[i].fullDate.slice(0, 7)
      const year = dataWithTrend[i].year
      if (month !== prevMonth) {
        try {
          const d = parseISO(dataWithTrend[i].fullDate)
          const monthLabel = format(d, 'MMM')
          const label =
            year !== prevYear && prevYear !== '' ? `${monthLabel} '${year.slice(-2)}` : monthLabel
          boundaries.push({ index: i, label })
        } catch {}
        prevMonth = month
        prevYear = year
      }
    }
    return boundaries
  }, [dataWithTrend])

  const formatDateTick = useCallback(
    (value: string | number) => {
      try {
        const d = parseISO(String(value))
        if (range <= 14 && !useCustomRange) return format(d, 'EEE M/d')
        const year = d.getFullYear()
        const month = d.getMonth()
        // Show year on January ticks or when it's the first visible tick of a new year
        if (month === 0 && d.getDate() <= 14) return format(d, "M/d ''yy")
        return format(d, 'M/d')
      } catch {
        return String(value)
      }
    },
    [range, useCustomRange],
  )

  const formatTooltipDate = useCallback((value: string | number) => {
    try {
      return format(parseISO(String(value)), 'M/d/yyyy')
    } catch {
      return String(value)
    }
  }, [])

  const renderYearDividers = useCallback((chartData: Array<{ fullDate: string }>) => {
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
    if (boundaries.length <= 1) return null
    return boundaries
      .filter((b) => b.index > 0)
      .map((b) => (
        <ReferenceLine
          key={`${b.year}-${b.fullDate}`}
          x={b.fullDate}
          stroke="var(--text-secondary)"
          strokeDasharray="4 4"
          strokeWidth={1.5}
          strokeOpacity={0.9}
          label={{
            value: b.year,
            position: 'top',
            fontSize: 12,
            fill: 'var(--text-secondary)',
            fontWeight: 700,
          }}
        />
      ))
  }, [])

  const trend = useMemo(() => {
    if (data.length < 3) return null
    const reg = linearTrend(data.map((d, i) => ({ x: i, y: d.hours })))
    const direction = reg.slope > 0.02 ? 'up' : reg.slope < -0.02 ? 'down' : 'flat'
    const changePerWeek = parseFloat((reg.slope * 7).toFixed(1))
    return { direction, changePerWeek, slope: reg.slope }
  }, [data])

  const avgHours = data.length > 0 ? data.reduce((sum, d) => sum + d.hours, 0) / data.length : 0
  const maxHours = data.length > 0 ? Math.max(...data.map((d) => d.hours)) : 0
  const minHours = data.length > 0 ? Math.min(...data.map((d) => d.hours)) : 0
  const avgEfficiency =
    data.length > 0
      ? Math.round(
          data.filter((d) => d.efficiency > 0).reduce((s, d) => s + d.efficiency, 0) /
            data.filter((d) => d.efficiency > 0).length,
        ) || 0
      : 0
  const hasStages = data.some((d) => d.deep > 0 || d.rem > 0)

  // Sleep/wake time data
  const sleepTimeData = useMemo(() => {
    return data
      .filter((d) => d.sleepStart || d.sleepEnd)
      .map((d) => {
        if (!hasPlausibleSleepTiming(d.sleepStart, d.sleepEnd, d.hours)) return null
        const bedtime = d.sleepStart ? toHoursFromMidnight(d.sleepStart) : null
        const wakeTime = d.sleepEnd ? toHoursFromMidnight(d.sleepEnd) : null
        return {
          date: d.date,
          fullDate: d.fullDate,
          bedtime: bedtime !== null ? parseFloat(bedtime.toFixed(1)) : undefined,
          wakeTime: wakeTime !== null ? parseFloat(wakeTime.toFixed(1)) : undefined,
        }
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .filter((d) => d.bedtime !== undefined || d.wakeTime !== undefined)
  }, [data])

  const avgBedtime = useMemo(() => {
    const valid = sleepTimeData.filter((d) => d.bedtime !== undefined)
    return valid.length > 0
      ? parseFloat((valid.reduce((s, d) => s + d.bedtime!, 0) / valid.length).toFixed(1))
      : null
  }, [sleepTimeData])

  const avgWakeTime = useMemo(() => {
    const valid = sleepTimeData.filter((d) => d.wakeTime !== undefined)
    return valid.length > 0
      ? parseFloat((valid.reduce((s, d) => s + d.wakeTime!, 0) / valid.length).toFixed(1))
      : null
  }, [sleepTimeData])

  // Efficiency chart data
  const efficiencyData = useMemo(() => {
    return data
      .filter((d) => d.efficiency > 0)
      .map((d) => ({
        date: d.date,
        fullDate: d.fullDate,
        efficiency: d.efficiency,
      }))
  }, [data])

  const stageChartData = useMemo(() => {
    return data.filter((d) => d.deep > 0 || d.rem > 0)
  }, [data])

  // Quality history chart data (from IPC)
  const qualityChartData = useMemo(() => {
    return [...qualityHistory].reverse().map((q) => ({
      date: format(parseISO(q.date), range <= 14 ? 'EEE M/d' : 'M/d'),
      fullDate: q.date,
      overall: q.overall,
      deep: q.deep,
      rem: q.rem,
      efficiency: q.efficiency,
    }))
  }, [qualityHistory, range])

  // Stage analysis
  const stageAnalysis = useMemo(() => {
    const withStages = data.filter((d) => d.deep > 0 || d.rem > 0)
    if (withStages.length < 3) return null

    const avgDeep = withStages.reduce((s, d) => s + d.deep, 0) / withStages.length
    const avgRem = withStages.reduce((s, d) => s + d.rem, 0) / withStages.length
    const avgCore = withStages.reduce((s, d) => s + d.core, 0) / withStages.length
    const avgTotal = withStages.reduce((s, d) => s + d.hours, 0) / withStages.length
    const deepPct = avgTotal > 0 ? (avgDeep / avgTotal) * 100 : 0
    const remPct = avgTotal > 0 ? (avgRem / avgTotal) * 100 : 0

    const recent = withStages.slice(-Math.min(7, Math.floor(withStages.length / 2)))
    const older = withStages.slice(0, Math.floor(withStages.length / 2))

    const observations: string[] = []
    if (deepPct < 13)
      observations.push(
        `Deep sleep averages ${deepPct.toFixed(0)}% (target: 15-23%). Try cooler room temperature (65-68°F), earlier bedtime, and avoiding alcohol before bed.`,
      )
    else if (deepPct >= 15 && deepPct <= 23)
      observations.push(
        `Deep sleep at ${deepPct.toFixed(0)}% is in the ideal 15-23% range. Great sleep architecture.`,
      )
    if (remPct < 20)
      observations.push(
        `REM sleep averages ${remPct.toFixed(0)}% (target: 20-25%). REM concentrates in later cycles — sleeping longer and consistent wake times help.`,
      )
    else if (remPct >= 20)
      observations.push(
        `REM sleep at ${remPct.toFixed(0)}% meets the 20-25% target. This supports memory consolidation and emotional processing.`,
      )

    if (older.length >= 3) {
      const recentDeepPct =
        (recent.reduce((s, d) => s + d.deep, 0) / recent.reduce((s, d) => s + d.hours, 0)) * 100
      const olderDeepPct =
        (older.reduce((s, d) => s + d.deep, 0) / older.reduce((s, d) => s + d.hours, 0)) * 100
      const recentRemPct =
        (recent.reduce((s, d) => s + d.rem, 0) / recent.reduce((s, d) => s + d.hours, 0)) * 100
      const olderRemPct =
        (older.reduce((s, d) => s + d.rem, 0) / older.reduce((s, d) => s + d.hours, 0)) * 100
      const deepChange = recentDeepPct - olderDeepPct
      const remChange = recentRemPct - olderRemPct
      if (Math.abs(deepChange) > 2)
        observations.push(
          `Deep sleep has ${deepChange > 0 ? 'improved' : 'declined'} by ${Math.abs(deepChange).toFixed(0)}% recently (${olderDeepPct.toFixed(0)}% → ${recentDeepPct.toFixed(0)}%).`,
        )
      if (Math.abs(remChange) > 2)
        observations.push(
          `REM sleep has ${remChange > 0 ? 'improved' : 'declined'} by ${Math.abs(remChange).toFixed(0)}% recently (${olderRemPct.toFixed(0)}% → ${recentRemPct.toFixed(0)}%).`,
        )
    }
    if (trend) {
      if (trend.direction === 'up')
        observations.push(
          `Sleep duration is trending up by ~${Math.abs(trend.changePerWeek)}h per week. Keep it up.`,
        )
      else if (trend.direction === 'down')
        observations.push(
          `Sleep duration is trending down by ~${Math.abs(trend.changePerWeek)}h per week. Consider prioritizing earlier bedtimes.`,
        )
    }
    return { avgDeep, avgRem, avgCore, deepPct, remPct, observations }
  }, [data, trend])

  // Filtered nightly log
  const allNights = useMemo(() => {
    if ((range > 90 && !useCustomRange) || useCustomRange) {
      const filtered = hideNoData ? data : data
      return (minHoursFilter > 0 ? filtered.filter((d) => d.hours >= minHoursFilter) : filtered)
        .slice()
        .reverse()
    }
    const today = new Date()
    const interval = eachDayOfInterval({ start: subDays(today, range - 1), end: today })
    const dataByDate = new Map(data.map((d) => [d.fullDate, d]))
    const full = interval
      .map((date) => {
        const dateStr = format(date, 'yyyy-MM-dd')
        return (
          dataByDate.get(dateStr) || {
            date: format(date, range <= 14 ? 'EEE M/d' : 'M/d'),
            fullDate: dateStr,
            hours: 0,
            inBed: 0,
            deep: 0,
            rem: 0,
            core: 0,
            efficiency: 0,
            sleepStart: null,
            sleepEnd: null,
            noData: true,
          }
        )
      })
      .reverse()
    let result = full
    if (hideNoData) result = result.filter((d: any) => !d.noData)
    if (minHoursFilter > 0)
      result = result.filter((d: any) => d.noData || d.hours >= minHoursFilter)
    return result
  }, [data, range, hideNoData, minHoursFilter, useCustomRange])

  const nightlySortAccessors = useMemo(() => ({
    date: (d: any) => d.fullDate,
    hours: (d: any) => d.noData ? -1 : d.hours,
    efficiency: (d: any) => d.noData ? -1 : d.efficiency,
    deep: (d: any) => d.noData ? -1 : d.deep,
    rem: (d: any) => d.noData ? -1 : d.rem,
    core: (d: any) => d.noData ? -1 : d.core,
    awake: (d: any) => d.noData ? -1 : (d.awake ?? -1),
  }), [])

  const { sorted: sortedNights, sortKey: nightSortKey, sortDir: nightSortDir, toggle: toggleNightSort } = useTableSort(allNights, nightlySortAccessors)

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/health')}
          className="p-1.5 rounded-lg transition-colors hover:opacity-80"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          <ArrowLeft size={18} style={{ color: 'var(--text-secondary)' }} />
        </button>
        <Moon size={20} style={{ color: 'var(--accent-purple)' }} />
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Sleep Analysis
        </h2>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-1.5 rounded-lg transition-colors hover:opacity-80 ml-auto"
          style={{ background: 'var(--bg-tertiary)', opacity: refreshing ? 0.65 : 1 }}
          title="Sync latest sleep data"
          aria-label="Sync latest sleep data"
        >
          <RefreshCw
            size={16}
            className={refreshing ? 'animate-spin' : ''}
            style={{ color: 'var(--text-secondary)' }}
          />
        </button>
        {syncStatus && (
          <span
            className="max-w-[260px] truncate text-xs"
            style={{
              color: syncStatus.startsWith('Sync failed')
                ? 'var(--accent-red)'
                : 'var(--text-muted)',
            }}
          >
            {syncStatus}
          </span>
        )}
      </div>

      {/* Range selector + custom date range */}
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.days}
            onClick={() => {
              setRange(opt.days)
              setUseCustomRange(false)
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              background:
                range === opt.days && !useCustomRange
                  ? 'var(--accent-purple)'
                  : 'var(--bg-tertiary)',
              color: range === opt.days && !useCustomRange ? 'white' : 'var(--text-secondary)',
            }}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => setUseCustomRange(!useCustomRange)}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
          style={{
            background: useCustomRange ? 'var(--accent-purple)' : 'var(--bg-tertiary)',
            color: useCustomRange ? 'white' : 'var(--text-secondary)',
          }}
        >
          <Calendar size={12} /> Custom
        </button>
        {useCustomRange && (
          <div className="flex items-center gap-2 ml-1">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2 py-1 rounded-md text-xs outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--separator)',
              }}
            />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              to
            </span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-2 py-1 rounded-md text-xs outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--separator)',
              }}
            />
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Average
          </span>
          <p className="text-xl font-semibold mt-1" style={{ color: 'var(--accent-purple)' }}>
            {avgHours.toFixed(1)}
            <span className="text-xs font-normal ml-0.5">h</span>
          </p>
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Best
          </span>
          <p className="text-xl font-semibold mt-1" style={{ color: 'var(--accent-green)' }}>
            {maxHours.toFixed(1)}
            <span className="text-xs font-normal ml-0.5">h</span>
          </p>
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Worst
          </span>
          <p className="text-xl font-semibold mt-1" style={{ color: 'var(--accent-red)' }}>
            {minHours.toFixed(1)}
            <span className="text-xs font-normal ml-0.5">h</span>
          </p>
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Efficiency
          </span>
          <p
            className="text-xl font-semibold mt-1"
            style={{
              color:
                avgEfficiency >= 85
                  ? 'var(--accent-green)'
                  : avgEfficiency >= 75
                    ? 'var(--accent-amber)'
                    : 'var(--accent-red)',
            }}
          >
            {avgEfficiency}
            <span className="text-xs font-normal ml-0.5">%</span>
          </p>
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Nights
          </span>
          <p className="text-xl font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
            {data.length}
          </p>
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Trend
          </span>
          <div className="flex items-center gap-1 mt-1">
            {trend ? (
              <>
                {trend.direction === 'up' && (
                  <TrendingUp size={16} style={{ color: 'var(--accent-green)' }} />
                )}
                {trend.direction === 'down' && (
                  <TrendingDown size={16} style={{ color: 'var(--accent-red)' }} />
                )}
                {trend.direction === 'flat' && (
                  <Minus size={16} style={{ color: 'var(--text-muted)' }} />
                )}
                <span
                  className="text-sm font-semibold"
                  style={{
                    color:
                      trend.direction === 'up'
                        ? 'var(--accent-green)'
                        : trend.direction === 'down'
                          ? 'var(--accent-red)'
                          : 'var(--text-muted)',
                  }}
                >
                  {trend.changePerWeek >= 0 ? '+' : ''}
                  {trend.changePerWeek}h/wk
                </span>
              </>
            ) : (
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                —
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Analysis overview */}
      {sleepAnalysis && (
        <div className="card">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <div className="flex items-center gap-2">
                <Lightbulb size={16} style={{ color: 'var(--accent-amber)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Deep Sleep Analysis
                </span>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Personalized from the selected range: architecture, debt, chronotype, regularity,
                and schedule timing.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => scrollToSection('sleep-trends')}
                className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                Trends
              </button>
              <button
                onClick={() => scrollToSection('sleep-stages')}
                className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                Stages
              </button>
              <button
                onClick={() => scrollToSection('nightly-log')}
                className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                Nightly Log
              </button>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center gap-1.5 mb-2">
                <Moon size={13} style={{ color: 'var(--accent-purple)' }} />
                <span
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Latest Night
                </span>
              </div>
              <p className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {(sleepAnalysis.lastNight.totalAsleep / 60).toFixed(1)}h
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                {sleepAnalysis.lastNight.date}
              </p>
            </div>
            <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center gap-1.5 mb-2">
                <Bed size={13} style={{ color: '#6366f1' }} />
                <span
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Stage Quality
                </span>
              </div>
              <p className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {sleepAnalysis.quality.overall}
                <span className="text-sm font-normal">/100</span>
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Deep {sleepAnalysis.quality.deepSleepScore} | REM {sleepAnalysis.quality.remScore} |
                Core {sleepAnalysis.quality.coreSleepScore ?? 0} | WASO{' '}
                {sleepAnalysis.quality.wasoScore ?? 0}
              </p>
            </div>
            <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center gap-1.5 mb-2">
                <Clock size={13} style={{ color: 'var(--accent-green)' }} />
                <span
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Chronotype
                </span>
              </div>
              <p
                className="text-base font-semibold truncate"
                style={{ color: 'var(--accent-purple)' }}
              >
                {sleepAnalysis.chronotype?.label || 'Not enough data'}
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Focus {sleepAnalysis.chronotype?.peakFocus || '--'}
              </p>
            </div>
            <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center gap-1.5 mb-2">
                <Zap size={13} style={{ color: 'var(--accent-amber)' }} />
                <span
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Optimal Window
                </span>
              </div>
              <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {sleepAnalysis.circadian?.optimalBedtime} -{' '}
                {sleepAnalysis.circadian?.optimalWakeTime}
              </p>
              <p className="text-[11px] mt-1 capitalize" style={{ color: 'var(--text-muted)' }}>
                Debt: {sleepAnalysis.debt?.debtCategory || 'unknown'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Recovery & Regularity cards */}
      {(recoveryData || regularity) && (
        <div className="grid grid-cols-2 gap-4">
          {recoveryData && (
            <div className="card">
              <div className="flex items-center gap-2 mb-2">
                <Zap
                  size={14}
                  style={{
                    color:
                      recoveryData.status === 'ready'
                        ? 'var(--accent-green)'
                        : recoveryData.status === 'moderate'
                          ? 'var(--accent-amber)'
                          : 'var(--accent-red)',
                  }}
                />
                <span
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Recovery Readiness
                </span>
                <span
                  className="ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{
                    background:
                      recoveryData.status === 'ready'
                        ? 'rgba(34,197,94,0.15)'
                        : recoveryData.status === 'moderate'
                          ? 'rgba(245,158,11,0.15)'
                          : 'rgba(239,68,68,0.15)',
                    color:
                      recoveryData.status === 'ready'
                        ? 'var(--accent-green)'
                        : recoveryData.status === 'moderate'
                          ? 'var(--accent-amber)'
                          : 'var(--accent-red)',
                  }}
                >
                  {recoveryData.status}
                </span>
              </div>
              <p className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {recoveryData.score}
                <span className="text-sm font-normal">/100</span>
              </p>
              <div className="flex gap-3 mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span>Sleep: {recoveryData.components.sleepScore}</span>
                <span>HRV: {recoveryData.components.hrvScore}</span>
                <span>Load: {recoveryData.components.exerciseLoad}</span>
              </div>
              <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
                {recoveryData.recommendation}
              </p>
            </div>
          )}
          {regularity && (
            <div className="card">
              <div className="flex items-center gap-2 mb-2">
                <Moon size={14} style={{ color: 'var(--accent-purple)' }} />
                <span
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Sleep Regularity
                </span>
                <span
                  className="ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{
                    background:
                      regularity.interpretation === 'excellent'
                        ? 'rgba(34,197,94,0.15)'
                        : regularity.interpretation === 'good'
                          ? 'rgba(59,130,246,0.15)'
                          : 'rgba(245,158,11,0.15)',
                    color:
                      regularity.interpretation === 'excellent'
                        ? 'var(--accent-green)'
                        : regularity.interpretation === 'good'
                          ? 'var(--accent-blue)'
                          : 'var(--accent-amber)',
                  }}
                >
                  {regularity.interpretation}
                </span>
              </div>
              <p className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {regularity.sri}
                <span className="text-sm font-normal">/100</span>
              </p>
              <div className="flex gap-3 mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span>Bedtime variance: ±{regularity.avgBedtimeVariance}h</span>
                <span>Wake variance: ±{regularity.avgWakeVariance}h</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main chart with trend line */}
      <div id="sleep-trends" className="card">
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Sleep Duration
          </span>
          <div className="flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#7c3aed' }} /> 9h+
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#1d4ed8' }} /> 8–9h
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#3b82f6' }} /> 7–8h
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#64748b' }} /> 6–7h
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#f59e0b' }} /> 5–6h
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#dc2626' }} /> 4–5h
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#7f1d1d' }} /> ≤4h
            </span>
            <span className="flex items-center gap-1">
              <span
                className="w-3 h-0.5 border-t border-dashed"
                style={{ borderColor: '#f97316' }}
              />{' '}
              Trend
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5" style={{ background: '#3b82f6', opacity: 0.5 }} /> Avg{' '}
              {avgHours.toFixed(1)}h
            </span>
            <span className="flex items-center gap-1">
              <span
                className="w-3 h-0.5 border-t border-dashed"
                style={{ borderColor: '#22c55e' }}
              />{' '}
              Goal
            </span>
          </div>
        </div>
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64">
            <NoodleSpinner size={72} color="var(--accent-purple)" label="Loading sleep data…" />
          </div>
        ) : data.length === 0 ? (
          <p className="text-sm py-16 text-center" style={{ color: 'var(--text-muted)' }}>
            No sleep data for this range.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={dataWithTrend} barCategoryGap={data.length > 30 ? '10%' : '20%'}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
              <XAxis
                dataKey="fullDate"
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                interval={data.length > 30 ? Math.floor(data.length / 15) : 0}
                tickFormatter={formatDateTick}
              />
              <YAxis
                domain={[0, 12]}
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                width={30}
                tickFormatter={(v) => `${v}h`}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={formatTooltipDate}
                formatter={(value: number, name: string) => {
                  const labels: Record<string, string> = {
                    hours: 'Total Asleep',
                    trend: 'Trend',
                    avg: 'Average',
                    suggested: 'Suggested',
                  }
                  return [`${value}h`, labels[name] || name]
                }}
              />
              {/* Year dividers — fall back to month dividers when only one year of data and >= 60 points */}
              {yearBoundaries.length > 1
                ? renderYearDividers(dataWithTrend)
                : dataWithTrend.length >= 60 &&
                  monthBoundaries.map((b) => (
                    <ReferenceLine
                      key={b.label + b.index}
                      x={dataWithTrend[b.index]?.fullDate}
                      stroke="var(--text-muted)"
                      strokeDasharray="2 4"
                      strokeWidth={1}
                      strokeOpacity={0.35}
                      label={{
                        value: b.label,
                        position: 'top',
                        fontSize: 10,
                        fill: 'var(--text-muted)',
                      }}
                    />
                  ))}
              {/* Suggested line based on personal sleep need */}
              <ReferenceLine
                y={sleepNeed}
                stroke="#22c55e"
                strokeDasharray="6 3"
                strokeWidth={2}
                strokeOpacity={0.85}
                label={{
                  value: `${sleepNeed}h suggested`,
                  position: 'right',
                  fontSize: 10,
                  fill: '#22c55e',
                  fillOpacity: 0.9,
                }}
              />
              {/* Average line */}
              <ReferenceLine
                y={parseFloat(avgHours.toFixed(1))}
                stroke="#3b82f6"
                strokeWidth={1.5}
                strokeOpacity={0.7}
              />
              <Bar dataKey="hours" radius={[3, 3, 0, 0]}>
                {dataWithTrend.map((d, i) => (
                  <Cell key={i} fill={sleepDurationColor(d.hours)} />
                ))}
              </Bar>
              <Line
                type="linear"
                dataKey="trend"
                stroke="#f97316"
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Sleep Need Profile */}
      {sleepNeedProfile && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Bed size={16} style={{ color: 'var(--accent-green)' }} />
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Your Sleep Need
              </span>
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium"
                style={{
                  background:
                    sleepNeedProfile.confidence === 'high'
                      ? 'rgba(34,197,94,0.15)'
                      : sleepNeedProfile.confidence === 'medium'
                        ? 'rgba(59,130,246,0.15)'
                        : 'rgba(245,158,11,0.15)',
                  color:
                    sleepNeedProfile.confidence === 'high'
                      ? 'var(--accent-green)'
                      : sleepNeedProfile.confidence === 'medium'
                        ? 'var(--accent-blue)'
                        : 'var(--accent-amber)',
                }}
              >
                {sleepNeedProfile.confidence} confidence
              </span>
            </div>
            <button
              onClick={() => setShowSleepNeedDetail(!showSleepNeedDetail)}
              className="text-xs px-2.5 py-1 rounded-lg transition-colors"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
            >
              {showSleepNeedDetail ? 'Show Less' : 'Learn More'}
            </button>
          </div>

          {/* Summary row */}
          <div className="grid grid-cols-4 gap-3 mb-3">
            <div
              className="p-3 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span
                className="text-[10px] uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Estimated Need
              </span>
              <p className="text-2xl font-bold mt-1" style={{ color: 'var(--accent-green)' }}>
                {sleepNeedProfile.estimatedNeed}
                <span className="text-sm font-normal">h</span>
              </p>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {sleepNeedProfile.classification}
              </span>
            </div>
            <div
              className="p-3 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span
                className="text-[10px] uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Chronotype
              </span>
              <p
                className="text-lg font-semibold mt-1 capitalize"
                style={{ color: 'var(--accent-purple)' }}
              >
                {sleepNeedProfile.chronotype}
              </p>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {sleepNeedProfile.userAge ? `Age ${sleepNeedProfile.userAge} · ` : ''}
                {sleepNeedProfile.dataPoints} nights
              </span>
            </div>
            <div
              className="p-3 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span
                className="text-[10px] uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Weekday Avg
              </span>
              <p
                className="text-lg font-semibold mt-1"
                style={{
                  color:
                    sleepNeedProfile.weekdayAvg >= sleepNeedProfile.estimatedNeed
                      ? 'var(--accent-green)'
                      : 'var(--accent-amber)',
                }}
              >
                {sleepNeedProfile.weekdayAvg}
                <span className="text-sm font-normal">h</span>
              </p>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {sleepNeedProfile.weekdayAvg >= sleepNeedProfile.estimatedNeed
                  ? 'Meeting need'
                  : `${(sleepNeedProfile.estimatedNeed - sleepNeedProfile.weekdayAvg).toFixed(1)}h short`}
              </span>
            </div>
            <div
              className="p-3 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span
                className="text-[10px] uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Weekend Avg
              </span>
              <p
                className="text-lg font-semibold mt-1"
                style={{
                  color:
                    sleepNeedProfile.weekendAvg >= sleepNeedProfile.estimatedNeed
                      ? 'var(--accent-green)'
                      : 'var(--accent-amber)',
                }}
              >
                {sleepNeedProfile.weekendAvg}
                <span className="text-sm font-normal">h</span>
              </p>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {sleepNeedProfile.weekendAvg >= sleepNeedProfile.estimatedNeed
                  ? 'Meeting need'
                  : `${(sleepNeedProfile.estimatedNeed - sleepNeedProfile.weekendAvg).toFixed(1)}h short`}
              </span>
            </div>
          </div>

          {/* Sleep debt impact */}
          <p className="text-xs mb-3 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {sleepNeedProfile.sleepDebtImpact}
          </p>

          {/* Best vs Worst nights comparison */}
          {showSleepNeedDetail && (
            <div
              className="space-y-4 mt-4 pt-4"
              style={{ borderTop: '1px solid var(--separator)' }}
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg" style={{ background: 'rgba(34,197,94,0.08)' }}>
                  <span
                    className="text-[10px] uppercase tracking-wide font-medium"
                    style={{ color: 'var(--accent-green)' }}
                  >
                    Best Nights (top 30%)
                  </span>
                  <p
                    className="text-lg font-semibold mt-1"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {sleepNeedProfile.bestNights.avgHours}h avg
                  </p>
                  <div
                    className="flex gap-3 mt-1 text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span>Deep: {sleepNeedProfile.bestNights.avgDeepPct}%</span>
                    <span>REM: {sleepNeedProfile.bestNights.avgRemPct}%</span>
                    <span>{sleepNeedProfile.bestNights.count} nights</span>
                  </div>
                </div>
                <div className="p-3 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)' }}>
                  <span
                    className="text-[10px] uppercase tracking-wide font-medium"
                    style={{ color: 'var(--accent-red)' }}
                  >
                    Worst Nights (bottom 30%)
                  </span>
                  <p
                    className="text-lg font-semibold mt-1"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {sleepNeedProfile.worstNights.avgHours}h avg
                  </p>
                  <div
                    className="flex gap-3 mt-1 text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span>Deep: {sleepNeedProfile.worstNights.avgDeepPct}%</span>
                    <span>REM: {sleepNeedProfile.worstNights.avgRemPct}%</span>
                    <span>{sleepNeedProfile.worstNights.count} nights</span>
                  </div>
                </div>
              </div>

              {/* Insights */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Lightbulb size={14} style={{ color: 'var(--accent-amber)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                    Analysis
                  </span>
                </div>
                <div className="space-y-2">
                  {sleepNeedProfile.insights.map((insight: string, i: number) => (
                    <p
                      key={i}
                      className="text-xs leading-relaxed pl-5"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {insight}
                    </p>
                  ))}
                </div>
              </div>

              {/* Scientific references */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <BookOpen size={14} style={{ color: 'var(--accent-blue)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                    Research
                  </span>
                </div>
                <div className="space-y-2">
                  {sleepNeedProfile.references.map((ref: any, i: number) => (
                    <div
                      key={i}
                      className="p-2.5 rounded-lg"
                      style={{ background: 'var(--bg-tertiary)' }}
                    >
                      <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        {ref.title}
                      </p>
                      <p
                        className="text-[11px] mt-1 leading-relaxed"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {ref.finding}
                      </p>
                      <p className="text-[10px] mt-1 italic" style={{ color: 'var(--text-muted)' }}>
                        {ref.source}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* How You Compare — age-benchmarked comparison card */}
      {sleepNeedProfile?.comparison && (
        <div className="card">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Heart size={14} style={{ color: 'var(--accent-cyan)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                How You Compare
              </span>
            </div>
            <span
              className="text-[10px] px-2 py-0.5 rounded-full font-medium"
              style={{ background: 'rgba(6,182,212,0.12)', color: 'var(--accent-cyan)' }}
            >
              {sleepNeedProfile.comparison.population.ageGroup
                ? `Ages ${sleepNeedProfile.comparison.population.ageGroup}`
                : 'US Adults'}
            </span>
          </div>
          <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
            {sleepNeedProfile.userAge
              ? `Age-adjusted norms for ${sleepNeedProfile.comparison.population.ageGroup} · Ohayon 2004 · Lunsford-Avery 2018`
              : 'Set your age in Settings for age-adjusted norms'}
          </p>
          <div
            className="overflow-hidden rounded-lg"
            style={{ border: '1px solid var(--separator)' }}
          >
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: 'var(--bg-tertiary)' }}>
                  <th
                    className="text-left py-2 px-3 font-medium"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Metric
                  </th>
                  <th
                    className="text-center py-2 px-3 font-medium"
                    style={{ color: 'var(--accent-purple)' }}
                  >
                    You
                  </th>
                  <th
                    className="text-center py-2 px-3 font-medium"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Avg
                  </th>
                  <th
                    className="text-center py-2 px-3 font-medium"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Diff
                  </th>
                  <th
                    className="text-center py-2 px-3 font-medium"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Rank
                  </th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    {
                      label: 'Duration',
                      unit: 'h',
                      decimals: 1,
                      neutral: true,
                      you: sleepNeedProfile.comparison.you.avgDuration,
                      pop: sleepNeedProfile.comparison.population.avgDuration,
                      sd: sleepNeedProfile.comparison.populationSDs.duration,
                    },
                    {
                      label: 'Deep Sleep',
                      unit: '%',
                      decimals: 0,
                      neutral: false,
                      you: sleepNeedProfile.comparison.you.avgDeepPct,
                      pop: sleepNeedProfile.comparison.population.avgDeepPct,
                      sd: sleepNeedProfile.comparison.populationSDs.deepPct,
                    },
                    {
                      label: 'REM Sleep',
                      unit: '%',
                      decimals: 0,
                      neutral: false,
                      you: sleepNeedProfile.comparison.you.avgRemPct,
                      pop: sleepNeedProfile.comparison.population.avgRemPct,
                      sd: sleepNeedProfile.comparison.populationSDs.remPct,
                    },
                    {
                      label: 'Efficiency',
                      unit: '%',
                      decimals: 0,
                      neutral: false,
                      you: sleepNeedProfile.comparison.you.avgEfficiency,
                      pop: sleepNeedProfile.comparison.population.avgEfficiency,
                      sd: sleepNeedProfile.comparison.populationSDs.efficiency,
                    },
                    {
                      label: 'Consistency',
                      unit: '/100',
                      decimals: 0,
                      neutral: false,
                      you: sleepNeedProfile.comparison.you.avgConsistency,
                      pop: sleepNeedProfile.comparison.population.avgConsistency,
                      sd: sleepNeedProfile.comparison.populationSDs.consistency,
                    },
                  ] as Array<{
                    label: string
                    unit: string
                    decimals: number
                    neutral: boolean
                    you: number
                    pop: number
                    sd: number
                  }>
                ).map((row) => {
                  if (!row.you) return null
                  const diff = row.you - row.pop
                  const pct = percentileRank(row.you, row.pop, row.sd)

                  const rankLabel = `${pct}${ordinalSuffix(pct)} pctl`

                  // Color: neutral metrics get muted color always; others get green/red only at extremes
                  let rankColor: string
                  if (row.neutral) {
                    rankColor = 'var(--text-secondary)'
                  } else if (pct >= 75) {
                    rankColor = 'var(--accent-green)'
                  } else if (pct <= 25) {
                    rankColor = 'var(--accent-red)'
                  } else {
                    rankColor = 'var(--text-secondary)'
                  }

                  // Diff color: neutral metrics always muted; others colored only at big differences
                  let diffColor: string
                  if (row.neutral) {
                    diffColor = 'var(--text-muted)'
                  } else if (Math.abs(diff) < 0.5) {
                    diffColor = 'var(--text-muted)'
                  } else {
                    diffColor = diff >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'
                  }

                  return (
                    <tr
                      key={row.label}
                      className="border-t"
                      style={{ borderColor: 'var(--separator)' }}
                    >
                      <td className="py-2 px-3" style={{ color: 'var(--text-secondary)' }}>
                        {row.label}
                      </td>
                      <td
                        className="py-2 px-3 text-center font-mono font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {row.you.toFixed(row.decimals)}
                        {row.unit}
                      </td>
                      <td
                        className="py-2 px-3 text-center font-mono"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {row.pop.toFixed(row.decimals)}
                        {row.unit}
                      </td>
                      <td
                        className="py-2 px-3 text-center font-mono font-medium"
                        style={{ color: diffColor }}
                      >
                        {diff > 0 ? '+' : ''}
                        {diff.toFixed(row.decimals)}
                        {row.unit}
                      </td>
                      <td
                        className="py-2 px-3 text-center text-[10px] font-medium"
                        style={{ color: rankColor }}
                      >
                        {rankLabel}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {/* Mini bar showing overall sleep quality vs peers (excludes duration — personal need varies) */}
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--separator)' }}>
            {(() => {
              const c = sleepNeedProfile.comparison
              const sds = c.populationSDs
              const metrics = [
                {
                  label: 'Deep',
                  pct: c.you.avgDeepPct
                    ? percentileRank(c.you.avgDeepPct, c.population.avgDeepPct, sds.deepPct)
                    : null,
                },
                {
                  label: 'REM',
                  pct: c.you.avgRemPct
                    ? percentileRank(c.you.avgRemPct, c.population.avgRemPct, sds.remPct)
                    : null,
                },
                {
                  label: 'Efficiency',
                  pct: c.you.avgEfficiency
                    ? percentileRank(
                        c.you.avgEfficiency,
                        c.population.avgEfficiency,
                        sds.efficiency,
                      )
                    : null,
                },
                {
                  label: 'Consistency',
                  pct: percentileRank(
                    c.you.avgConsistency,
                    c.population.avgConsistency,
                    sds.consistency,
                  ),
                },
              ].filter((m) => m.pct !== null) as { label: string; pct: number }[]
              const overallPct = Math.round(metrics.reduce((s, m) => s + m.pct, 0) / metrics.length)
              return (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Sleep quality vs peers (excl. duration)
                    </span>
                    <span
                      className="text-xs font-semibold"
                      style={{
                        color:
                          overallPct >= 70
                            ? 'var(--accent-green)'
                            : overallPct >= 40
                              ? 'var(--text-secondary)'
                              : 'var(--accent-red)',
                      }}
                    >
                      {overallPct}
                      {ordinalSuffix(overallPct)} percentile
                    </span>
                  </div>
                  <div
                    className="h-2 rounded-full overflow-hidden"
                    style={{ background: 'var(--bg-tertiary)' }}
                  >
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${overallPct}%`,
                        background:
                          overallPct >= 70
                            ? 'var(--accent-green)'
                            : overallPct >= 40
                              ? 'var(--accent-amber)'
                              : 'var(--accent-red)',
                      }}
                    />
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* Sleep Efficiency Chart */}
      {efficiencyData.length > 3 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Sleep Efficiency
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Time asleep / time in bed
            </span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={efficiencyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
              <XAxis
                dataKey="fullDate"
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatDateTick}
                interval={efficiencyData.length > 30 ? Math.floor(efficiencyData.length / 15) : 0}
              />
              <YAxis
                domain={[50, 100]}
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                width={35}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={formatTooltipDate}
                formatter={(value: number) => [`${value}%`, 'Efficiency']}
              />
              {renderYearDividers(efficiencyData)}
              <ReferenceLine
                y={85}
                stroke="var(--accent-green)"
                strokeDasharray="5 5"
                strokeWidth={1}
                label={{ value: '85% target', position: 'right', fontSize: 10, fill: '#22c55e' }}
              />
              <Line
                type="monotone"
                dataKey="efficiency"
                stroke="#06b6d4"
                strokeWidth={2}
                dot={efficiencyData.length <= 30 ? { fill: '#06b6d4', r: 2 } : false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Sleep Quality Score History */}
      {qualityChartData.length > 3 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Quality Score History
            </span>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: '#a855f7' }} /> Overall
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: '#6366f1' }} /> Deep
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: '#a78bfa' }} /> REM
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={qualityChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
              <XAxis
                dataKey="fullDate"
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatDateTick}
                interval={
                  qualityChartData.length > 30 ? Math.floor(qualityChartData.length / 15) : 0
                }
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={formatTooltipDate}
                formatter={(value: number, name: string) => {
                  const labels: Record<string, string> = {
                    overall: 'Overall',
                    deep: 'Deep',
                    rem: 'REM',
                    efficiency: 'Efficiency',
                  }
                  return [`${value}`, labels[name] || name]
                }}
              />
              {renderYearDividers(qualityChartData)}
              <Line
                type="monotone"
                dataKey="overall"
                stroke="#a855f7"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="deep"
                stroke="#6366f1"
                strokeWidth={1.5}
                dot={false}
                strokeDasharray="4 2"
              />
              <Line
                type="monotone"
                dataKey="rem"
                stroke="#a78bfa"
                strokeWidth={1.5}
                dot={false}
                strokeDasharray="4 2"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Sleep/Wake Time Chart */}
      {sleepTimeData.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Bedtime & Wake Time
            </span>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: '#f59e0b' }} /> Wake
                {avgWakeTime !== null && (
                  <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
                    avg {formatClockHour(avgWakeTime)}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: '#8b5cf6' }} /> Bedtime
                {avgBedtime !== null && (
                  <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
                    avg {formatClockHour(avgBedtime)}
                  </span>
                )}
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={sleepTimeData} margin={{ top: 8, right: 18, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
              <XAxis
                dataKey="fullDate"
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatDateTick}
                interval={sleepTimeData.length > 30 ? Math.floor(sleepTimeData.length / 15) : 0}
                padding={{ left: 12, right: 12 }}
              />
              <YAxis
                domain={[-6, 15]}
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                width={45}
                tickFormatter={formatClockHour}
                ticks={[-5, -4, -3, -2, -1, 0, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13]}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                allowEscapeViewBox={{ x: true, y: true }}
                labelFormatter={formatTooltipDate}
                formatter={(value: number | undefined, name: string) => {
                  if (value === undefined) return ['—', name]
                  return [formatClockHour(value), name === 'bedtime' ? 'Bedtime' : 'Wake Time']
                }}
              />
              {renderYearDividers(sleepTimeData)}
              {avgBedtime !== null && (
                <ReferenceLine
                  y={avgBedtime}
                  stroke="#8b5cf6"
                  strokeDasharray="5 5"
                  strokeWidth={1}
                  strokeOpacity={0.5}
                />
              )}
              {avgWakeTime !== null && (
                <ReferenceLine
                  y={avgWakeTime}
                  stroke="#f59e0b"
                  strokeDasharray="5 5"
                  strokeWidth={1}
                  strokeOpacity={0.5}
                />
              )}
              <Line
                type="monotone"
                dataKey="wakeTime"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={{ fill: '#f59e0b', r: sleepTimeData.length <= 30 ? 3 : 0 }}
                connectNulls={false}
              />
              <Line
                type="monotone"
                dataKey="bedtime"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={{ fill: '#8b5cf6', r: sleepTimeData.length <= 30 ? 3 : 0 }}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Workout Impact on Sleep */}
      {correlationData && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Dumbbell size={16} style={{ color: 'var(--accent-green)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Workout Impact on Sleep
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div
              className="p-2.5 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Workout Days
              </span>
              <p className="text-lg font-semibold" style={{ color: 'var(--accent-green)' }}>
                {correlationData.avgQualityWithWorkout}
                <span className="text-xs font-normal ml-0.5">/100</span>
              </p>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {correlationData.sampleSize.workoutDays} days
              </span>
            </div>
            <div
              className="p-2.5 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Rest Days
              </span>
              <p className="text-lg font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {correlationData.avgQualityWithout}
                <span className="text-xs font-normal ml-0.5">/100</span>
              </p>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {correlationData.sampleSize.restDays} days
              </span>
            </div>
            <div
              className="p-2.5 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Best Window
              </span>
              <p
                className="text-lg font-semibold capitalize"
                style={{ color: 'var(--accent-blue)' }}
              >
                {correlationData.bestWorkoutWindow}
              </p>
            </div>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {correlationData.timingInsight}
          </p>
        </div>
      )}

      {/* Wind-Down Routine */}
      {windDownRoutine && windDownRoutine.steps && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Moon size={16} style={{ color: 'var(--accent-purple)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Tonight's Wind-Down Routine
            </span>
            <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
              Bedtime: {windDownRoutine.optimalBedtime} | Melatonin:{' '}
              {windDownRoutine.melatoninWindow}
            </span>
          </div>
          <div className="grid grid-cols-7 gap-2">
            {windDownRoutine.steps.map((step: any, i: number) => {
              const iconMap: Record<string, React.ReactNode> = {
                dim: <Lightbulb size={16} />,
                phone: <Smartphone size={16} />,
                shower: <ShowerHead size={16} />,
                snack: <Coffee size={16} />,
                stretch: <Wind size={16} />,
                read: <BookOpen size={16} />,
                bed: <Bed size={16} />,
              }
              const isLast = i === windDownRoutine.steps.length - 1
              return (
                <div
                  key={i}
                  className="p-2.5 rounded-lg text-center"
                  style={{ background: isLast ? 'rgba(139,92,246,0.1)' : 'var(--bg-tertiary)' }}
                >
                  <div
                    className="mb-1.5"
                    style={{ color: isLast ? 'var(--accent-purple)' : 'var(--text-muted)' }}
                  >
                    {iconMap[step.icon] || <Clock size={16} />}
                  </div>
                  <p
                    className="text-xs font-mono font-medium"
                    style={{ color: isLast ? 'var(--accent-purple)' : 'var(--text-primary)' }}
                  >
                    {step.time}
                  </p>
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {step.activity}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Stage analysis */}
      {stageAnalysis && stageAnalysis.observations.length > 0 && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Moon size={16} style={{ color: 'var(--accent-purple)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Sleep Stage Analysis
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div
              className="p-2.5 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Avg Deep
              </span>
              <p className="text-lg font-semibold" style={{ color: '#6366f1' }}>
                {stageAnalysis.avgDeep.toFixed(1)}h
                <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-muted)' }}>
                  ({stageAnalysis.deepPct.toFixed(0)}%)
                </span>
              </p>
            </div>
            <div
              className="p-2.5 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Avg REM
              </span>
              <p className="text-lg font-semibold" style={{ color: '#a78bfa' }}>
                {stageAnalysis.avgRem.toFixed(1)}h
                <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-muted)' }}>
                  ({stageAnalysis.remPct.toFixed(0)}%)
                </span>
              </p>
            </div>
            <div
              className="p-2.5 rounded-lg text-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Avg Core
              </span>
              <p className="text-lg font-semibold" style={{ color: '#818cf8' }}>
                {stageAnalysis.avgCore.toFixed(1)}h
              </p>
            </div>
          </div>
          <div className="space-y-2">
            {stageAnalysis.observations.map((obs, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span
                  className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--accent-purple)' }}
                />
                <span style={{ color: 'var(--text-secondary)' }}>{obs}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sleep stages chart */}
      {hasStages && (
        <div id="sleep-stages" className="card">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Sleep Stages Breakdown
            </span>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm" style={{ background: '#6366f1' }} /> Deep
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm" style={{ background: '#818cf8' }} /> Core
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm" style={{ background: '#a78bfa' }} /> REM
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={stageChartData} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
              <XAxis
                dataKey="fullDate"
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                interval={stageChartData.length > 30 ? Math.floor(stageChartData.length / 15) : 0}
                tickFormatter={formatDateTick}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                width={30}
                tickFormatter={(v) => `${v}h`}
              />
              <Tooltip content={<StageBreakdownTooltip />} />
              {renderYearDividers(stageChartData)}
              <Bar dataKey="deep" stackId="stages" fill="#6366f1" radius={[0, 0, 0, 0]} />
              <Bar dataKey="core" stackId="stages" fill="#818cf8" radius={[0, 0, 0, 0]} />
              <Bar dataKey="rem" stackId="stages" fill="#a78bfa" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Nightly log table */}
      <div id="nightly-log" className="card">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Nightly Log
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setHideNoData(!hideNoData)}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md transition-colors"
              style={{
                background: hideNoData ? 'var(--accent-purple)' : 'var(--bg-tertiary)',
                color: hideNoData ? 'white' : 'var(--text-muted)',
              }}
            >
              <Filter size={10} /> Hide empty
            </button>
            <div
              className="flex items-center gap-1.5 text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              <span>Min:</span>
              <select
                value={minHoursFilter}
                onChange={(e) => setMinHoursFilter(Number(e.target.value))}
                className="px-1.5 py-0.5 rounded text-xs outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--separator)',
                }}
              >
                <option value={0}>All</option>
                <option value={3}>3h+</option>
                <option value={5}>5h+</option>
                <option value={6}>6h+</option>
                <option value={7}>7h+</option>
              </select>
            </div>
          </div>
        </div>
        <div className="overflow-y-auto max-h-[600px]">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <SortHeader label="Date" sortKey="date" currentKey={nightSortKey} currentDir={nightSortDir} onSort={toggleNightSort} align="left" />
                <SortHeader label="Asleep" sortKey="hours" currentKey={nightSortKey} currentDir={nightSortDir} onSort={toggleNightSort} />
                <SortHeader label="Eff%" sortKey="efficiency" currentKey={nightSortKey} currentDir={nightSortDir} onSort={toggleNightSort} />
                {hasStages && (
                  <>
                    <SortHeader label="Deep" sortKey="deep" currentKey={nightSortKey} currentDir={nightSortDir} onSort={toggleNightSort} />
                    <SortHeader label="REM" sortKey="rem" currentKey={nightSortKey} currentDir={nightSortDir} onSort={toggleNightSort} />
                    <SortHeader label="Core" sortKey="core" currentKey={nightSortKey} currentDir={nightSortDir} onSort={toggleNightSort} />
                    <SortHeader label="Awake" sortKey="awake" currentKey={nightSortKey} currentDir={nightSortDir} onSort={toggleNightSort} />
                  </>
                )}
                <th className="text-right py-2 font-medium">Bedtime</th>
                <th className="text-right py-2 font-medium">Wake</th>
              </tr>
            </thead>
            <tbody>
              {sortedNights.map((d: any, i: number) => (
                <tr
                  key={i}
                  className="border-t"
                  style={{ borderColor: 'var(--separator)', opacity: d.noData ? 0.5 : 1 }}
                >
                  <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                    {format(parseISO(d.fullDate), 'EEE, MMM d')}
                  </td>
                  {d.noData ? (
                    <td
                      colSpan={hasStages ? 8 : 4}
                      className="text-right py-2 text-xs italic"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      No data
                    </td>
                  ) : (
                    <>
                      <td
                        className="text-right py-2 font-mono"
                        style={{
                          color:
                            d.hours >= 7
                              ? 'var(--accent-blue)'
                              : d.hours >= 6
                                ? 'var(--accent-orange)'
                                : 'var(--accent-red)',
                        }}
                      >
                        {d.hours}h
                      </td>
                      <td
                        className="text-right py-2 font-mono"
                        style={{
                          color:
                            d.efficiency >= 85
                              ? 'var(--accent-green)'
                              : d.efficiency >= 75
                                ? 'var(--accent-amber)'
                                : d.efficiency > 0
                                  ? 'var(--accent-red)'
                                  : 'var(--text-muted)',
                        }}
                      >
                        {d.efficiency > 0 ? `${d.efficiency}%` : '—'}
                      </td>
                      {hasStages && (
                        <>
                          <td
                            className="text-right py-2 font-mono"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {d.deep > 0 ? `${d.deep}h` : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {d.rem > 0 ? `${d.rem}h` : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {d.core > 0 ? `${d.core}h` : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{
                              color: d.awake > 30 ? 'var(--accent-red)' : 'var(--text-muted)',
                            }}
                          >
                            {d.awake > 0 ? `${d.awake}m` : '—'}
                          </td>
                        </>
                      )}
                      <td
                        className="text-right py-2 font-mono"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {d.sleepStart
                          ? (() => {
                              try {
                                const dt = new Date(d.sleepStart)
                                return isNaN(dt.getTime())
                                  ? d.sleepStart.substring(0, 5)
                                  : dt.toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })
                              } catch {
                                return '—'
                              }
                            })()
                          : '—'}
                      </td>
                      <td
                        className="text-right py-2 font-mono"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {d.sleepEnd
                          ? (() => {
                              try {
                                const dt = new Date(d.sleepEnd)
                                return isNaN(dt.getTime())
                                  ? d.sleepEnd.substring(0, 5)
                                  : dt.toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })
                              } catch {
                                return '—'
                              }
                            })()
                          : '—'}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
