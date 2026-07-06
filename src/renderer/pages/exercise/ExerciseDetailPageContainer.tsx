import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Flame,
  Footprints,
  Timer,
  Dumbbell,
  Heart,
  Activity,
  Moon,
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
  Shield,
  BedDouble,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  Trophy,
  Target,
  Mountain,
} from 'lucide-react'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
  Area,
  AreaChart,
  ScatterChart,
  Scatter,
  ZAxis,
  Legend,
  PieChart,
  Pie,
  Cell,
  Brush,
} from 'recharts'
import Tooltip from '../../components/charts/ChartTooltip'
import { format, parseISO, getYear } from 'date-fns'
import { useHealthMetrics, parseMetricValue } from '../../hooks/useHealthData'
import NoodleSpinner from '../../components/anim/NoodleSpinner'
import { useToast } from '../../components/Toast'
import { useTableSort, useTableFilter, SortHeader, TableSearchBar } from '../../components/tables/SortableTable'

const RANGE_OPTIONS = [
  { label: '7D', days: 7 },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
  { label: 'All', days: 9999 },
]

const TAB_OPTIONS = [
  { label: 'Overview', key: 'overview' },
  { label: 'Training Science', key: 'training' },
  { label: 'HR Zones', key: 'zones' },
  { label: 'Pace & Power', key: 'streams' },
  { label: 'Year Progress', key: 'year' },
  { label: 'Heart & Recovery', key: 'heart' },
  { label: 'Sleep vs Fitness', key: 'sleep' },
  { label: 'Activity Log', key: 'log' },
] as const

type Tab = (typeof TAB_OPTIONS)[number]['key']

// Types for fitness analysis from backend
interface FitnessAnalysis {
  trainingLoad: {
    ctl: number
    atl: number
    tsb: number
    trainingStatus: string
    trainingStatusLabel: string
    history: Array<{ date: string; trimp: number; ctl: number; atl: number; tsb: number }>
    dailyLoads: Array<{ date: string; trimp: number; epoc: number }>
  }
  recovery: {
    recoveryScore: number
    recoveryStatus: string
    estimatedRecoveryHours: number
    readinessToTrain: boolean
    factors: Array<{ name: string; score: number; weight: number; observation: string }>
    sleepRecommendation: {
      baseNeed: number
      trainingAdjustment: number
      totalRecommended: number
      reasoning: string
    }
  }
  profile: {
    vo2Max: number | null
    vo2Trend: string | null
    vo2Category: string
    restingHr: number | null
    rhrTrend: string | null
    rhrCategory: string
    hrvBaseline: number | null
    hrvCurrent: number | null
    hrvTrend: string | null
    weeklyExerciseMinutes: number
    weeklyActiveCalories: number
    exerciseConsistencyPct: number
    fitnessScore: number
    fitnessLevel: string
  }
  insights: string[]
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error')
}

function linearTrend(data: { x: number; y: number }[]): {
  slope: number
  intercept: number
  points: number[]
} {
  const n = data.length
  if (n < 2) return { slope: 0, intercept: data[0]?.y || 0, points: data.map((d) => d.y) }
  const sumX = data.reduce((s, d) => s + d.x, 0)
  const sumY = data.reduce((s, d) => s + d.y, 0)
  const sumXY = data.reduce((s, d) => s + d.x * d.y, 0)
  const sumX2 = data.reduce((s, d) => s + d.x * d.x, 0)
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  const intercept = (sumY - slope * sumX) / n
  return {
    slope,
    intercept,
    points: data.map((d) => parseFloat((slope * d.x + intercept).toFixed(2))),
  }
}

function TrendBadge({
  data,
  unit,
  higherIsBetter = true,
}: {
  data: number[]
  unit: string
  higherIsBetter?: boolean
}) {
  if (data.length < 3) return null
  const reg = linearTrend(data.map((y, x) => ({ x, y })))
  const changePerWeek = parseFloat((reg.slope * 7).toFixed(1))
  if (Math.abs(changePerWeek) < 0.1)
    return (
      <span className="flex items-center gap-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
        <Minus size={12} /> Stable
      </span>
    )
  const isGood = higherIsBetter ? changePerWeek > 0 : changePerWeek < 0
  const color = isGood ? 'var(--accent-green)' : 'var(--accent-red)'
  const Icon = changePerWeek > 0 ? TrendingUp : TrendingDown
  const displayChange =
    Math.abs(changePerWeek) >= 100
      ? Math.round(changePerWeek).toLocaleString()
      : changePerWeek.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return (
    <span className="flex items-center gap-0.5 text-xs" style={{ color }}>
      <Icon size={12} /> {changePerWeek > 0 ? '+' : ''}
      {displayChange}
      {unit}/wk
    </span>
  )
}

const tooltipStyle = {
  background: '#1a1a1a',
  border: '1px solid #2a2a2a',
  borderRadius: '8px',
  fontSize: '12px',
  color: '#e5e5e5',
}
const CTL_TAU = 42
const ATL_TAU = 7
const BANISTER_ZOOM_OPTIONS = [
  { label: 'All', days: 99999 },
  { label: 'First 2Y', days: 730 },
  { label: 'First 1Y', days: 365 },
  { label: 'First 6M', days: 183 },
  { label: 'Preset', days: 0 },
] as const

/** Format date labels — includes year for ranges > 90 days or at year boundaries */
function formatDateLabel(dateStr: string, range: number): string {
  const d = parseISO(dateStr)
  if (range <= 14) return format(d, 'EEE M/d')
  if (d.getMonth() === 0 && d.getDate() <= 14) return format(d, "M/d ''yy")
  if (range > 365) return format(d, "M/d ''yy")
  return format(d, 'M/d')
}

/** Find year boundaries in formatted chart data for vertical separator lines */
function getYearBoundaryLines(chartData: Array<{ date: string; fullDate: string }>, range: number) {
  if (range <= 180 || chartData.length < 2) return []
  const lines: Array<{ formattedDate: string; year: number }> = []
  for (let i = 1; i < chartData.length; i++) {
    const prevYear = getYear(parseISO(chartData[i - 1].fullDate))
    const currYear = getYear(parseISO(chartData[i].fullDate))
    if (currYear > prevYear) {
      lines.push({ formattedDate: chartData[i].date, year: currYear })
    }
  }
  return lines
}

// Population norms by age — ACSM 2013 (VO2), AHA (RHR), Tudor-Locke 2011 (steps)
function getExerciseNorms(age: number | null) {
  if (!age)
    return {
      ageGroup: 'Adults',
      vo2: { avg: 43, sd: 8 },
      rhr: { avg: 71, sd: 10 },
      steps: { avg: 8000, sd: 2500 },
    }
  if (age < 20)
    return {
      ageGroup: '14-19',
      vo2: { avg: 50, sd: 9 },
      rhr: { avg: 73, sd: 11 },
      steps: { avg: 9000, sd: 2500 },
    }
  if (age < 30)
    return {
      ageGroup: '20-29',
      vo2: { avg: 46, sd: 8 },
      rhr: { avg: 70, sd: 10 },
      steps: { avg: 8500, sd: 2500 },
    }
  if (age < 40)
    return {
      ageGroup: '30-39',
      vo2: { avg: 43, sd: 7 },
      rhr: { avg: 71, sd: 10 },
      steps: { avg: 8000, sd: 2500 },
    }
  if (age < 50)
    return {
      ageGroup: '40-49',
      vo2: { avg: 40, sd: 7 },
      rhr: { avg: 72, sd: 10 },
      steps: { avg: 7500, sd: 2500 },
    }
  if (age < 60)
    return {
      ageGroup: '50-59',
      vo2: { avg: 36, sd: 7 },
      rhr: { avg: 73, sd: 10 },
      steps: { avg: 7000, sd: 2500 },
    }
  return {
    ageGroup: '60+',
    vo2: { avg: 30, sd: 6 },
    rhr: { avg: 74, sd: 11 },
    steps: { avg: 6000, sd: 2000 },
  }
}

function exPctRank(you: number, mean: number, sd: number): number {
  if (sd <= 0) return 50
  const z = (you - mean) / sd
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const phi = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly
  return Math.round((z >= 0 ? phi : 1 - phi) * 100)
}

export default function ExerciseDetailPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [range, setRange] = useState(30)
  const [tab, setTab] = useState<Tab>('overview')
  const [fitnessAnalysis, setFitnessAnalysis] = useState<FitnessAnalysis | null>(null)
  const [banisterAnalysis, setBanisterAnalysis] = useState<FitnessAnalysis | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [userAge, setUserAge] = useState<number | null>(null)
  const [stravaSyncing, setStravaSyncing] = useState(false)
  const [stravaStatus, setStravaStatus] = useState<{ connected: boolean; athlete?: string }>({
    connected: false,
  })
  const [syncMsg, setSyncMsg] = useState('')
  const [hrZoneData, setHrZoneData] = useState<any>(null)
  const [hrssData, setHrssData] = useState<any>(null)
  const [yearProgressData, setYearProgressData] = useState<any>(null)
  const [bestEfforts, setBestEfforts] = useState<any>(null)
  const [streamZones, setStreamZones] = useState<any>(null)
  const [bestSplits, setBestSplits] = useState<any>(null)
  const [gapData, setGapData] = useState<any>(null)
  const [runPowerData, setRunPowerData] = useState<any>(null)
  const [analysisRefreshKey, setAnalysisRefreshKey] = useState(0)
  const [streamsSyncing, setStreamsSyncing] = useState(false)
  const [streamsSyncMsg, setStreamsSyncMsg] = useState('')
  const [banisterZoomDays, setBanisterZoomDays] = useState(99999)

  useEffect(() => {
    window.api
      .stravaStatus()
      .then((s: any) => setStravaStatus(s))
      .catch((err) => showToast(`Strava status failed to load: ${getErrorMessage(err)}`, 'error'))
  }, [showToast])

  const handleStravaSync = async () => {
    setStravaSyncing(true)
    setSyncMsg('')
    try {
      const result = await window.api.stravaSync(range === 9999 ? 3650 : range)
      if (result.error) {
        setSyncMsg(result.error)
      } else {
        const detail =
          typeof result.enriched === 'number'
            ? `; streams: ${result.enriched}${result.reusedDetailed ? ` new, ${result.reusedDetailed} kept` : ''}; activity details: ${result.activityDetailsFetched ?? 0}`
            : ''
        setSyncMsg(`Synced ${result.total} workouts across ${result.synced} days${detail}`)
        await refreshWorkouts()
        setAnalysisRefreshKey((k) => k + 1)
      }
    } catch (err: any) {
      setSyncMsg(err.message || 'Sync failed')
      showToast(`Strava sync failed: ${getErrorMessage(err)}`, 'error')
    }
    setStravaSyncing(false)
    setTimeout(() => setSyncMsg(''), 5000)
  }

  useEffect(() => {
    window.api
      .getSettings('appSettings')
      .then((val: any) => {
        const age = val?.userAge ? parseInt(val.userAge) : null
        if (age && age > 0 && age < 120) setUserAge(age)
      })
      .catch((err) =>
        showToast(`Exercise settings failed to load: ${getErrorMessage(err)}`, 'error'),
      )
  }, [showToast])

  // Load fitness analysis and new metrics when range changes
  useEffect(() => {
    const fetchDays = range === 9999 ? 3000 : range
    const loadAnalysis = async () => {
      setAnalysisLoading(true)
      try {
        const data = await window.api.getFitnessAnalysis(fetchDays)
        setFitnessAnalysis(data)
      } catch (err) {
        console.error('Failed to load fitness analysis:', err)
        showToast(`Fitness analysis failed to load: ${getErrorMessage(err)}`, 'error')
      }
      setAnalysisLoading(false)
    }
    loadAnalysis()

    // Load HR zones, HRSS, year progress, best efforts in parallel
    window.api
      .getHRZoneAnalysis(fetchDays)
      .then(setHrZoneData)
      .catch((err) => showToast(`HR zones failed to load: ${getErrorMessage(err)}`, 'error'))
    window.api
      .getHRSS(fetchDays)
      .then(setHrssData)
      .catch((err) => showToast(`HRSS failed to load: ${getErrorMessage(err)}`, 'error'))
    window.api
      .getYearProgression(Math.max(fetchDays, 730))
      .then(setYearProgressData)
      .catch((err) =>
        showToast(`Year progression failed to load: ${getErrorMessage(err)}`, 'error'),
      )
    window.api
      .getBestEfforts(fetchDays)
      .then(setBestEfforts)
      .catch((err) => showToast(`Best efforts failed to load: ${getErrorMessage(err)}`, 'error'))
    // Stream-based analysis
    window.api
      .getStreamZones(fetchDays)
      .then(setStreamZones)
      .catch((err) => showToast(`Stream zones failed to load: ${getErrorMessage(err)}`, 'error'))
    window.api
      .getBestSplits(fetchDays)
      .then(setBestSplits)
      .catch((err) => showToast(`Best splits failed to load: ${getErrorMessage(err)}`, 'error'))
    window.api
      .getGradeAdjustedPace(fetchDays)
      .then(setGapData)
      .catch((err) =>
        showToast(`Grade-adjusted pace failed to load: ${getErrorMessage(err)}`, 'error'),
      )
    window.api
      .getRunningPower(fetchDays)
      .then(setRunPowerData)
      .catch((err) => showToast(`Running power failed to load: ${getErrorMessage(err)}`, 'error'))
  }, [range, analysisRefreshKey, showToast])

  useEffect(() => {
    window.api
      .getFitnessAnalysis(3650)
      .then(setBanisterAnalysis)
      .catch((err) => {
        setBanisterAnalysis(null)
        showToast(`Long-range fitness analysis failed to load: ${getErrorMessage(err)}`, 'error')
      })
  }, [analysisRefreshKey, showToast])
  const fetchDays = range === 9999 ? 3000 : range

  const { metrics: stepsMetrics, loading: stepsLoading } = useHealthMetrics('steps', fetchDays)
  const { metrics: energyMetrics, loading: energyLoading } = useHealthMetrics(
    'active_energy',
    fetchDays,
  )
  const { metrics: exerciseMetrics, loading: exerciseLoading } = useHealthMetrics(
    'exercise_time',
    fetchDays,
  )
  const {
    metrics: workoutMetrics,
    loading: workoutsLoading,
    refresh: refreshWorkouts,
  } = useHealthMetrics('workout', fetchDays)
  const { metrics: hrMetrics, loading: hrLoading } = useHealthMetrics('heart_rate', fetchDays)
  const { metrics: restingHrMetrics } = useHealthMetrics('resting_heart_rate', fetchDays)
  const { metrics: hrvMetrics } = useHealthMetrics('hrv', fetchDays)
  const { metrics: vo2Metrics } = useHealthMetrics('vo2_max', fetchDays)
  const { metrics: sleepMetrics } = useHealthMetrics('sleep', fetchDays)

  const loading = stepsLoading || energyLoading || exerciseLoading || workoutsLoading || hrLoading

  // Build combined daily data
  const data = useMemo(() => {
    const byDate = new Map<
      string,
      {
        steps: number
        calories: number
        exerciseMin: number
        hrAvg: number
        hrMax: number
        hrMin: number
        restingHr: number
        hrv: number
        vo2: number
        sleepHours: number
        deepPct: number
      }
    >()

    const getEntry = (date: string) =>
      byDate.get(date) || {
        steps: 0,
        calories: 0,
        exerciseMin: 0,
        hrAvg: 0,
        hrMax: 0,
        hrMin: 0,
        restingHr: 0,
        hrv: 0,
        vo2: 0,
        sleepHours: 0,
        deepPct: 0,
      }

    for (const m of stepsMetrics) {
      const val = parseMetricValue(m)
      const steps = (val.qty as number) || 0
      if (steps < 10) continue
      const e = getEntry(m.date)
      e.steps = Math.round(steps)
      byDate.set(m.date, e)
    }
    for (const m of energyMetrics) {
      const val = parseMetricValue(m)
      const cal = (val.qty as number) || 0
      if (cal < 1) continue
      const e = getEntry(m.date)
      e.calories = Math.round(cal)
      byDate.set(m.date, e)
    }
    for (const m of exerciseMetrics) {
      const val = parseMetricValue(m)
      const mins = (val.qty as number) || 0
      if (mins < 1) continue
      const e = getEntry(m.date)
      e.exerciseMin = Math.round(mins)
      byDate.set(m.date, e)
    }
    for (const m of hrMetrics) {
      const val = parseMetricValue(m)
      const e = getEntry(m.date)
      e.hrAvg = Math.round((val.Avg as number) || (val.qty as number) || 0)
      e.hrMax = Math.round((val.Max as number) || 0)
      e.hrMin = Math.round((val.Min as number) || 0)
      if (e.hrAvg > 0) byDate.set(m.date, e)
    }
    for (const m of restingHrMetrics) {
      const val = parseMetricValue(m)
      const rhr = (val.qty as number) || 0
      if (rhr > 0) {
        const e = getEntry(m.date)
        e.restingHr = Math.round(rhr)
        byDate.set(m.date, e)
      }
    }
    for (const m of hrvMetrics) {
      const val = parseMetricValue(m)
      const h = (val.qty as number) || (val.Avg as number) || 0
      if (h > 0) {
        const e = getEntry(m.date)
        e.hrv = Math.round(h)
        byDate.set(m.date, e)
      }
    }
    for (const m of vo2Metrics) {
      const val = parseMetricValue(m)
      const v = (val.qty as number) || 0
      if (v > 0) {
        const e = getEntry(m.date)
        e.vo2 = parseFloat(v.toFixed(1))
        byDate.set(m.date, e)
      }
    }
    for (const m of sleepMetrics) {
      const val = parseMetricValue(m)
      const asleep =
        (val.totalAsleep as number) || (val.asleep as number) || (val.qty as number) || 0
      const deep = (val.deep as number) || 0
      if (asleep >= 60) {
        const e = getEntry(m.date)
        e.sleepHours = parseFloat((asleep / 60).toFixed(1))
        e.deepPct = asleep > 0 ? parseFloat(((deep / asleep) * 100).toFixed(0)) : 0
        byDate.set(m.date, e)
      }
    }

    return Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dateStr, vals]) => ({
        date: formatDateLabel(dateStr, range),
        fullDate: dateStr,
        ...vals,
      }))
  }, [
    stepsMetrics,
    energyMetrics,
    exerciseMetrics,
    hrMetrics,
    restingHrMetrics,
    hrvMetrics,
    vo2Metrics,
    sleepMetrics,
    range,
  ])

  // Year boundaries for reference lines on long-range charts
  const yearBoundaries = useMemo(() => getYearBoundaryLines(data, range), [data, range])

  // VO2 max data (sparse, separate)
  const vo2Data = useMemo(() => {
    return [...vo2Metrics]
      .reverse()
      .map((m) => {
        const val = parseMetricValue(m)
        return {
          date: formatDateLabel(m.date, range),
          fullDate: m.date,
          vo2: (val.qty as number) || 0,
        }
      })
      .filter((d) => d.vo2 > 0)
  }, [vo2Metrics, range])

  // Add trend lines
  const stepsData = data.filter((d) => d.steps > 0)
  const calData = data.filter((d) => d.calories > 0)
  const exData = data.filter((d) => d.exerciseMin > 0)
  const hrData = data.filter((d) => d.hrAvg > 0)
  const rhrData = data.filter((d) => d.restingHr > 0)
  const hrvData = data.filter((d) => d.hrv > 0)
  const sleepData = data.filter((d) => d.sleepHours > 0)

  // Steps with trend
  const stepsWithTrend = useMemo(() => {
    if (stepsData.length < 2) return stepsData
    const reg = linearTrend(stepsData.map((d, i) => ({ x: i, y: d.steps })))
    return stepsData.map((d, i) => ({ ...d, stepsTrend: reg.points[i] }))
  }, [stepsData])

  // Exercise with trend
  const exWithTrend = useMemo(() => {
    if (exData.length < 2) return exData
    const reg = linearTrend(exData.map((d, i) => ({ x: i, y: d.exerciseMin })))
    return exData.map((d, i) => ({ ...d, exTrend: reg.points[i] }))
  }, [exData])

  // HR with trend
  const hrWithTrend = useMemo(() => {
    if (rhrData.length < 2) return rhrData
    const reg = linearTrend(rhrData.map((d, i) => ({ x: i, y: d.restingHr })))
    return rhrData.map((d, i) => ({ ...d, rhrTrend: reg.points[i] }))
  }, [rhrData])

  // Stats
  const avgSteps =
    stepsData.length > 0
      ? Math.round(stepsData.reduce((s, d) => s + d.steps, 0) / stepsData.length)
      : 0
  const avgCal =
    calData.length > 0
      ? Math.round(calData.reduce((s, d) => s + d.calories, 0) / calData.length)
      : 0
  const avgExercise =
    exData.length > 0
      ? Math.round(exData.reduce((s, d) => s + d.exerciseMin, 0) / exData.length)
      : 0
  const latestVo2 = vo2Data.length > 0 ? vo2Data[vo2Data.length - 1].vo2 : 0
  const avgRHR =
    rhrData.length > 0
      ? Math.round(rhrData.reduce((s, d) => s + d.restingHr, 0) / rhrData.length)
      : 0
  const avgHRV =
    hrvData.length > 0 ? Math.round(hrvData.reduce((s, d) => s + d.hrv, 0) / hrvData.length) : 0

  // Fitness score (composite: VO2 + RHR + exercise consistency)
  const fitnessScore = useMemo(() => {
    let score = 0
    let components = 0
    // VO2 max component (30-50 range → 0-100)
    if (latestVo2 > 0) {
      score += Math.min(100, Math.max(0, (latestVo2 - 20) * (100 / 40)))
      components++
    }
    // Resting HR component (lower is better: 40=100, 80=0)
    if (avgRHR > 0) {
      score += Math.min(100, Math.max(0, (80 - avgRHR) * (100 / 40)))
      components++
    }
    // Exercise consistency (% of days with 20+ min exercise)
    if (data.length > 0) {
      const exerciseDays = data.filter((d) => d.exerciseMin >= 20).length
      score += Math.min(100, (exerciseDays / data.length) * 100)
      components++
    }
    // HRV (higher is better: 20=0, 80=100)
    if (avgHRV > 0) {
      score += Math.min(100, Math.max(0, (avgHRV - 20) * (100 / 60)))
      components++
    }
    return components > 0 ? Math.round(score / components) : 0
  }, [latestVo2, avgRHR, avgHRV, data])

  // Sleep vs Exercise correlation data
  const sleepExerciseCorr = useMemo(() => {
    return data
      .filter((d) => d.sleepHours > 0 && (d.exerciseMin > 0 || d.steps > 1000))
      .map((d) => ({
        date: d.date,
        fullDate: d.fullDate,
        sleepHours: d.sleepHours,
        exerciseMin: d.exerciseMin,
        steps: d.steps,
        hrv: d.hrv,
        restingHr: d.restingHr,
      }))
  }, [data])

  // Parse workouts into flat list
  const workouts = useMemo(() => {
    const list: Array<{
      key: string
      date: string
      name: string
      duration: number
      calories: number
      distance: number
      avgHR: number
      maxHR: number
      start: string
      source: string
      elevationGain?: number
      sufferScore?: number
    }> = []
    for (const m of workoutMetrics) {
      const val = parseMetricValue(m)
      const dayWorkouts = (val.workouts as Array<{
        stravaId?: string | number
        name?: string
        duration?: number
        calories?: number
        distance?: number
        avgHR?: number
        maxHR?: number
        start?: string
        source?: string
        elevationGain?: number
        sufferScore?: number
      }>) || []
      dayWorkouts.forEach((w, idx) => {
        const stravaId = (w as any).stravaId
        const key = stravaId ? `strava-${stravaId}` : `hae-${m.date}-${idx}`
        list.push({
          key,
          date: m.date,
          name: w.name || 'Unknown',
          duration: w.duration || 0,
          calories: w.calories || 0,
          distance: w.distance || 0,
          avgHR: w.avgHR || 0,
          maxHR: w.maxHR || 0,
          start: w.start || '',
          source: w.source || m.source || '',
          elevationGain: w.elevationGain || 0,
          sufferScore: w.sufferScore || 0,
        })
      })
    }
    return list.sort((a, b) => b.date.localeCompare(a.date) || b.start.localeCompare(a.start))
  }, [workoutMetrics])

  const xAxisInterval = (len: number) => (len > 30 ? Math.floor(len / 15) : 0)

  // Workout table filter & sort
  const workoutSearchFn = useCallback((w: typeof workouts[0], q: string) =>
    w.name.toLowerCase().includes(q) || w.date.includes(q) || w.source.toLowerCase().includes(q), [])
  const { filtered: filteredWorkouts, search: workoutSearch, setSearch: setWorkoutSearch } = useTableFilter(workouts, workoutSearchFn)
  const workoutSortAccessors = useMemo(() => ({
    date: (w: typeof workouts[0]) => w.date,
    name: (w: typeof workouts[0]) => w.name,
    duration: (w: typeof workouts[0]) => w.duration,
    calories: (w: typeof workouts[0]) => w.calories,
    distance: (w: typeof workouts[0]) => w.distance,
    avgHR: (w: typeof workouts[0]) => w.avgHR || null,
  }), [])
  const { sorted: sortedWorkouts, sortKey: wSortKey, sortDir: wSortDir, toggle: toggleWSort } = useTableSort(filteredWorkouts, workoutSortAccessors)

  // Zone/GAP/Power table sort state (data comes from async-loaded objects)
  const [zoneSort, setZoneSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [gapSort, setGapSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [powerSort, setPowerSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)

  const makeToggle = (
    state: { key: string; dir: 'asc' | 'desc' } | null,
    setter: (v: { key: string; dir: 'asc' | 'desc' }) => void,
  ) => (key: string) => {
    if (state?.key === key) setter({ key, dir: state.dir === 'asc' ? 'desc' : 'asc' })
    else setter({ key, dir: key === 'date' || key === 'name' ? 'asc' : 'desc' })
  }
  const toggleZSort = makeToggle(zoneSort, setZoneSort)
  const toggleGSort = makeToggle(gapSort, setGapSort)
  const togglePSort = makeToggle(powerSort, setPowerSort)

  const sortList = (list: any[], state: { key: string; dir: 'asc' | 'desc' } | null, accessors: Record<string, (item: any) => any>) => {
    if (!state || !accessors[state.key]) return list
    const acc = accessors[state.key]
    return [...list].sort((a, b) => {
      const av = acc(a), bv = acc(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'string') return state.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return state.dir === 'asc' ? av - bv : bv - av
    })
  }

  // Activity log sort & filter
  const activityLogData = useMemo(() => data.slice().reverse(), [data])
  const logSearchFn = useCallback((d: typeof activityLogData[0], q: string) =>
    d.fullDate.includes(q), [])
  const { filtered: filteredLog, search: logSearch, setSearch: setLogSearch } = useTableFilter(activityLogData, logSearchFn)
  const logSortAccessors = useMemo(() => ({
    date: (d: any) => d.fullDate,
    steps: (d: any) => d.steps || null,
    calories: (d: any) => d.calories || null,
    exercise: (d: any) => d.exerciseMin || null,
    hr: (d: any) => d.hrAvg || null,
    rhr: (d: any) => d.restingHr || null,
    hrv: (d: any) => d.hrv || null,
    sleep: (d: any) => d.sleepHours || null,
  }), [])
  const { sorted: sortedLog, sortKey: logSortKey, sortDir: logSortDir, toggle: toggleLogSort } = useTableSort(filteredLog, logSortAccessors)

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
        <Dumbbell size={20} style={{ color: 'var(--accent-orange)' }} />
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Fitness & Activity
        </h2>
        <div className="flex-1" />
        {stravaStatus.connected && (
          <button
            onClick={handleStravaSync}
            disabled={stravaSyncing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
            style={{ background: '#fc4c02', color: 'white', opacity: stravaSyncing ? 0.6 : 1 }}
          >
            <RefreshCw size={13} className={stravaSyncing ? 'animate-spin' : ''} />
            {stravaSyncing ? 'Syncing...' : 'Sync Strava'}
          </button>
        )}
        {syncMsg && (
          <span
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            {syncMsg}
          </span>
        )}
      </div>

      {/* Range + Tab selector */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setRange(opt.days)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{
                background: range === opt.days ? 'var(--accent-orange)' : 'var(--bg-tertiary)',
                color: range === opt.days ? 'white' : 'var(--text-secondary)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {TAB_OPTIONS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{
                background: tab === t.key ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                color: tab === t.key ? 'white' : 'var(--text-secondary)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-6 gap-3">
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Fitness Score
          </span>
          <p
            className="text-2xl font-semibold mt-1"
            style={{
              color:
                fitnessScore >= 70
                  ? 'var(--accent-green)'
                  : fitnessScore >= 40
                    ? 'var(--accent-amber)'
                    : 'var(--accent-red)',
            }}
          >
            {fitnessScore}
            <span className="text-sm font-normal ml-0.5">/100</span>
          </p>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}
            >
              Avg Steps
            </span>
            <TrendBadge data={stepsData.map((d) => d.steps)} unit=" steps" />
          </div>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-blue)' }}>
            {avgSteps.toLocaleString()}
          </p>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}
            >
              Avg Calories
            </span>
            <TrendBadge data={calData.map((d) => d.calories)} unit="" />
          </div>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-orange)' }}>
            {avgCal.toLocaleString()}
            <span className="text-sm font-normal ml-1">cal</span>
          </p>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}
            >
              Avg Exercise
            </span>
            <TrendBadge data={exData.map((d) => d.exerciseMin)} unit="m" />
          </div>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-red)' }}>
            {avgExercise}
            <span className="text-sm font-normal ml-1">min</span>
          </p>
        </div>
        <div className="card">
          <span
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            VO2 Max
          </span>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-green)' }}>
            {latestVo2 > 0 ? latestVo2 : '—'}
          </p>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}
            >
              Resting HR
            </span>
            <TrendBadge data={rhrData.map((d) => d.restingHr)} unit="" higherIsBetter={false} />
          </div>
          <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--accent-purple)' }}>
            {avgRHR > 0 ? avgRHR : '—'}
            <span className="text-sm font-normal ml-1">bpm</span>
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center h-64">
          <NoodleSpinner size={72} color="var(--accent-orange)" label="Loading fitness data…" />
        </div>
      ) : data.length === 0 ? (
        <div className="card">
          <p className="text-sm py-16 text-center" style={{ color: 'var(--text-muted)' }}>
            No fitness data for this range.
          </p>
        </div>
      ) : (
        <>
          {/* ========== OVERVIEW TAB ========== */}
          {tab === 'overview' && (
            <>
              {/* Steps chart with trend */}
              <div className="card">
                <div className="flex items-center gap-2 mb-4">
                  <Footprints size={14} style={{ color: 'var(--accent-blue)' }} />
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    Daily Steps
                  </span>
                  <TrendBadge data={stepsData.map((d) => d.steps)} unit=" steps" />
                </div>
                <ResponsiveContainer width="100%" height={250}>
                  <ComposedChart
                    data={stepsWithTrend}
                    barCategoryGap={
                      stepsData.length > 60 ? '5%' : stepsData.length > 30 ? '10%' : '20%'
                    }
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--separator)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: '#737373' }}
                      axisLine={false}
                      tickLine={false}
                      interval={xAxisInterval(stepsData.length)}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#737373' }}
                      axisLine={false}
                      tickLine={false}
                      width={45}
                      tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value: number, name: string) => [
                        name === 'stepsTrend'
                          ? `${Math.round(value).toLocaleString()} (trend)`
                          : value.toLocaleString(),
                        name === 'stepsTrend' ? 'Trend' : 'Steps',
                      ]}
                    />
                    <ReferenceLine
                      y={avgSteps}
                      stroke="var(--accent-blue)"
                      strokeDasharray="5 5"
                      strokeWidth={1}
                      label={{
                        value: `avg ${avgSteps.toLocaleString()}`,
                        position: 'right',
                        fontSize: 10,
                        fill: '#3b82f6',
                      }}
                    />
                    <ReferenceLine
                      y={10000}
                      stroke="var(--accent-green)"
                      strokeDasharray="3 3"
                      strokeWidth={1}
                      strokeOpacity={0.4}
                      label={{
                        value: '10k goal',
                        position: 'right',
                        fontSize: 10,
                        fill: '#22c55e',
                        fillOpacity: 0.5,
                      }}
                    />
                    {yearBoundaries.map((yb) => (
                      <ReferenceLine
                        key={yb.year}
                        x={yb.formattedDate}
                        stroke="var(--text-secondary)"
                        strokeDasharray="4 4"
                        strokeWidth={1.5}
                        strokeOpacity={0.9}
                        label={{
                          value: `${yb.year}`,
                          position: 'top',
                          fontSize: 12,
                          fill: 'var(--text-secondary)',
                          fontWeight: 700,
                        }}
                      />
                    ))}
                    <Bar dataKey="steps" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                    <Line
                      type="linear"
                      dataKey="stepsTrend"
                      stroke="#f97316"
                      strokeWidth={2}
                      strokeDasharray="6 3"
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Calories chart */}
              <div className="card">
                <div className="flex items-center gap-2 mb-4">
                  <Flame size={14} style={{ color: 'var(--accent-orange)' }} />
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    Active Calories
                  </span>
                  <TrendBadge data={calData.map((d) => d.calories)} unit=" cal" />
                </div>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart
                    data={calData}
                    barCategoryGap={
                      calData.length > 60 ? '5%' : calData.length > 30 ? '10%' : '20%'
                    }
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--separator)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: '#737373' }}
                      axisLine={false}
                      tickLine={false}
                      interval={xAxisInterval(calData.length)}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#737373' }}
                      axisLine={false}
                      tickLine={false}
                      width={45}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value: number) => [
                        `${value.toLocaleString()} cal`,
                        'Active Energy',
                      ]}
                    />
                    <ReferenceLine
                      y={avgCal}
                      stroke="var(--accent-orange)"
                      strokeDasharray="5 5"
                      strokeWidth={1}
                      label={{
                        value: `avg ${avgCal}`,
                        position: 'right',
                        fontSize: 10,
                        fill: '#f97316',
                      }}
                    />
                    {yearBoundaries.map((yb) => (
                      <ReferenceLine
                        key={yb.year}
                        x={yb.formattedDate}
                        stroke="var(--text-secondary)"
                        strokeDasharray="4 4"
                        strokeWidth={1.5}
                        strokeOpacity={0.9}
                        label={{
                          value: `${yb.year}`,
                          position: 'top',
                          fontSize: 12,
                          fill: 'var(--text-secondary)',
                          fontWeight: 700,
                        }}
                      />
                    ))}
                    <Bar dataKey="calories" fill="#f97316" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Exercise time chart with trend */}
              {exData.length > 0 && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-4">
                    <Timer size={14} style={{ color: 'var(--accent-red)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Exercise Minutes
                    </span>
                    <TrendBadge data={exData.map((d) => d.exerciseMin)} unit=" min" />
                  </div>
                  <ResponsiveContainer width="100%" height={250}>
                    <ComposedChart
                      data={exWithTrend}
                      barCategoryGap={
                        exData.length > 60 ? '5%' : exData.length > 30 ? '10%' : '20%'
                      }
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--separator)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        interval={xAxisInterval(exData.length)}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        width={35}
                        tickFormatter={(v) => `${v}m`}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value: number, name: string) => [
                          name === 'exTrend' ? `${Math.round(value)}m (trend)` : `${value} min`,
                          name === 'exTrend' ? 'Trend' : 'Exercise',
                        ]}
                      />
                      <ReferenceLine
                        y={avgExercise}
                        stroke="var(--accent-red)"
                        strokeDasharray="5 5"
                        strokeWidth={1}
                        label={{
                          value: `avg ${avgExercise}m`,
                          position: 'right',
                          fontSize: 10,
                          fill: '#ef4444',
                        }}
                      />
                      <ReferenceLine
                        y={30}
                        stroke="var(--accent-green)"
                        strokeDasharray="3 3"
                        strokeWidth={1}
                        strokeOpacity={0.4}
                        label={{
                          value: '30m goal',
                          position: 'right',
                          fontSize: 10,
                          fill: '#22c55e',
                          fillOpacity: 0.5,
                        }}
                      />
                      {yearBoundaries.map((yb) => (
                        <ReferenceLine
                          key={yb.year}
                          x={yb.formattedDate}
                          stroke="var(--text-secondary)"
                          strokeDasharray="4 4"
                          strokeWidth={1.5}
                          strokeOpacity={0.9}
                          label={{
                            value: `${yb.year}`,
                            position: 'top',
                            fontSize: 12,
                            fill: 'var(--text-secondary)',
                            fontWeight: 700,
                          }}
                        />
                      ))}
                      <Bar dataKey="exerciseMin" fill="#ef4444" radius={[3, 3, 0, 0]} />
                      <Line
                        type="linear"
                        dataKey="exTrend"
                        stroke="#f97316"
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* VO2 Max trend */}
              {vo2Data.length > 1 && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-4">
                    <Zap size={14} style={{ color: 'var(--accent-green)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      VO2 Max Trend
                    </span>
                    <TrendBadge data={vo2Data.map((d) => d.vo2)} unit="" />
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={vo2Data}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--separator)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        domain={['dataMin - 2', 'dataMax + 2']}
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        width={35}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value: number) => [`${value} mL/kg/min`, 'VO2 Max']}
                      />
                      <Line
                        type="monotone"
                        dataKey="vo2"
                        stroke="#22c55e"
                        strokeWidth={2.5}
                        dot={{ fill: '#22c55e', r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                  <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    VO2 max measures cardiorespiratory fitness. Higher is better. Average for males
                    20-39: 35-45 mL/kg/min.
                  </div>
                </div>
              )}

              {/* Workouts log */}
              {workouts.length > 0 && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-3">
                    <Dumbbell size={14} style={{ color: 'var(--accent-green)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Workouts ({workouts.length})
                    </span>
                  </div>
                  <TableSearchBar value={workoutSearch} onChange={setWorkoutSearch} placeholder="Filter workouts…" count={filteredWorkouts.length} total={workouts.length} />
                  <div className="overflow-y-auto max-h-96">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ color: 'var(--text-muted)' }}>
                          <SortHeader label="Date" sortKey="date" currentKey={wSortKey} currentDir={wSortDir} onSort={toggleWSort} align="left" />
                          <SortHeader label="Workout" sortKey="name" currentKey={wSortKey} currentDir={wSortDir} onSort={toggleWSort} align="left" />
                          <SortHeader label="Duration" sortKey="duration" currentKey={wSortKey} currentDir={wSortDir} onSort={toggleWSort} />
                          <SortHeader label="Calories" sortKey="calories" currentKey={wSortKey} currentDir={wSortDir} onSort={toggleWSort} />
                          <SortHeader label="Distance" sortKey="distance" currentKey={wSortKey} currentDir={wSortDir} onSort={toggleWSort} />
                          <SortHeader label="Avg HR" sortKey="avgHR" currentKey={wSortKey} currentDir={wSortDir} onSort={toggleWSort} />
                        </tr>
                      </thead>
                      <tbody>
                        {sortedWorkouts.map((w, i) => {
                          const open = () => navigate(`/health/exercise/activity/${w.key}`)
                          return (
                            <tr
                              key={w.key || i}
                              className="border-t cursor-pointer transition-colors hover:bg-white/5"
                              style={{ borderColor: 'var(--separator)' }}
                              onClick={open}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  open()
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              aria-label={`Open ${w.name} on ${w.date}`}
                            >
                              <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                                {format(parseISO(w.date), 'EEE, MMM d')}
                              </td>
                              <td
                                className="py-2 font-medium"
                                style={{ color: 'var(--accent-green)' }}
                              >
                                {w.name}
                                {w.source?.toLowerCase() === 'strava' && (
                                  <span
                                    className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded font-semibold"
                                    style={{ background: 'var(--accent-orange)', color: 'white' }}
                                  >
                                    STRAVA
                                  </span>
                                )}
                              </td>
                              <td
                                className="text-right py-2 font-mono"
                                style={{ color: 'var(--text-secondary)' }}
                              >
                                {w.duration >= 60
                                  ? `${Math.floor(w.duration / 60)}h ${w.duration % 60}m`
                                  : `${w.duration}m`}
                              </td>
                              <td
                                className="text-right py-2 font-mono"
                                style={{ color: 'var(--accent-orange)' }}
                              >
                                {w.calories > 0 ? `${w.calories}` : '—'}
                              </td>
                              <td
                                className="text-right py-2 font-mono"
                                style={{ color: 'var(--text-secondary)' }}
                              >
                                {w.distance > 0 ? `${w.distance.toFixed(2)} mi` : '—'}
                              </td>
                              <td
                                className="text-right py-2 font-mono"
                                style={{ color: 'var(--accent-red)' }}
                              >
                                {w.avgHR > 0 ? `${Math.round(w.avgHR)}` : '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ========== TRAINING SCIENCE TAB ========== */}
          {tab === 'training' && (
            <>
              {analysisLoading ? (
                <div className="flex flex-col items-center justify-center h-64">
                  <NoodleSpinner
                    size={72}
                    color="var(--accent-blue)"
                    label="Computing fitness model…"
                  />
                </div>
              ) : !fitnessAnalysis ? (
                <div className="card">
                  <p className="text-sm py-16 text-center" style={{ color: 'var(--text-muted)' }}>
                    Not enough data for training analysis.
                  </p>
                </div>
              ) : (
                <>
                  {/* Training Status Banner */}
                  <div
                    className="card"
                    style={{
                      borderLeft: `3px solid ${
                        fitnessAnalysis.trainingLoad.trainingStatus === 'productive'
                          ? 'var(--accent-green)'
                          : fitnessAnalysis.trainingLoad.trainingStatus === 'peaking'
                            ? 'var(--accent-blue)'
                            : fitnessAnalysis.trainingLoad.trainingStatus === 'overreaching'
                              ? 'var(--accent-red)'
                              : fitnessAnalysis.trainingLoad.trainingStatus === 'detraining'
                                ? 'var(--accent-amber)'
                                : 'var(--text-muted)'
                      }`,
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Shield size={16} style={{ color: 'var(--accent-blue)' }} />
                          <span
                            className="text-sm font-medium"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            Training Status
                          </span>
                        </div>
                        <p
                          className="text-lg font-semibold"
                          style={{
                            color:
                              fitnessAnalysis.trainingLoad.trainingStatus === 'productive'
                                ? 'var(--accent-green)'
                                : fitnessAnalysis.trainingLoad.trainingStatus === 'peaking'
                                  ? 'var(--accent-blue)'
                                  : fitnessAnalysis.trainingLoad.trainingStatus === 'overreaching'
                                    ? 'var(--accent-red)'
                                    : 'var(--accent-amber)',
                          }}
                        >
                          {fitnessAnalysis.trainingLoad.trainingStatus.charAt(0).toUpperCase() +
                            fitnessAnalysis.trainingLoad.trainingStatus.slice(1)}
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                          {fitnessAnalysis.trainingLoad.trainingStatusLabel}
                        </p>
                      </div>
                      <div className="grid grid-cols-3 gap-4 text-center">
                        <div>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            Fitness (CTL)
                          </span>
                          <p className="text-xl font-bold" style={{ color: 'var(--accent-blue)' }}>
                            {fitnessAnalysis.trainingLoad.ctl}
                          </p>
                        </div>
                        <div>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            Fatigue (ATL)
                          </span>
                          <p className="text-xl font-bold" style={{ color: 'var(--accent-red)' }}>
                            {fitnessAnalysis.trainingLoad.atl}
                          </p>
                        </div>
                        <div>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            Form (TSB)
                          </span>
                          <p
                            className="text-xl font-bold"
                            style={{
                              color:
                                fitnessAnalysis.trainingLoad.tsb > 5
                                  ? 'var(--accent-green)'
                                  : fitnessAnalysis.trainingLoad.tsb < -10
                                    ? 'var(--accent-red)'
                                    : 'var(--accent-amber)',
                            }}
                          >
                            {fitnessAnalysis.trainingLoad.tsb > 0 ? '+' : ''}
                            {fitnessAnalysis.trainingLoad.tsb}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Banister Fitness-Fatigue Chart */}
                  {fitnessAnalysis.trainingLoad.history.length > 3 &&
                    (() => {
                      const banisterHistory = banisterAnalysis?.trainingLoad.history.length
                        ? banisterAnalysis.trainingLoad.history
                        : fitnessAnalysis.trainingLoad.history
                      const banisterLabelRange = banisterHistory.length > 365 ? 9999 : range
                      const allBanisterData = banisterHistory.map((h) => ({
                        ...h,
                        fullDate: h.date,
                        date: formatDateLabel(h.date, banisterLabelRange),
                      }))
                      const banisterChartData =
                        banisterZoomDays >= 99999
                          ? allBanisterData
                          : banisterZoomDays === 0
                            ? allBanisterData.slice(-Math.min(allBanisterData.length, range))
                            : allBanisterData.slice(
                                0,
                                Math.min(allBanisterData.length, banisterZoomDays),
                              )

                      return (
                        <div className="card">
                          <div className="flex flex-wrap items-center gap-2 mb-4">
                            <Activity size={14} style={{ color: 'var(--accent-blue)' }} />
                            <span
                              className="text-sm font-medium"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              Fitness vs Fatigue (Banister Model)
                            </span>
                            <div
                              className="ml-auto flex items-center gap-1 rounded-lg p-1"
                              style={{ background: 'var(--bg-tertiary)' }}
                            >
                              {BANISTER_ZOOM_OPTIONS.map((option) => (
                                <button
                                  key={option.label}
                                  onClick={() => setBanisterZoomDays(option.days)}
                                  className="text-[10px] px-2 py-1 rounded-md transition-colors"
                                  style={{
                                    background:
                                      banisterZoomDays === option.days
                                        ? 'var(--accent-blue)'
                                        : 'transparent',
                                    color:
                                      banisterZoomDays === option.days
                                        ? 'white'
                                        : 'var(--text-muted)',
                                  }}
                                >
                                  {option.days === 0
                                    ? `Preset (${RANGE_OPTIONS.find((r) => r.days === range)?.label || range + 'D'})`
                                    : option.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <ResponsiveContainer width="100%" height={330}>
                            <ComposedChart key={banisterZoomDays} data={banisterChartData}>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="var(--separator)"
                                vertical={false}
                              />
                              <XAxis
                                dataKey="date"
                                tick={{ fontSize: 10, fill: '#737373' }}
                                axisLine={false}
                                tickLine={false}
                                interval={Math.max(0, Math.floor(banisterChartData.length / 15))}
                              />
                              <YAxis
                                tick={{ fontSize: 10, fill: '#737373' }}
                                axisLine={false}
                                tickLine={false}
                                width={35}
                              />
                              <Tooltip
                                contentStyle={tooltipStyle}
                                formatter={(value: number, name: string) => {
                                  const labels: Record<string, string> = {
                                    ctl: 'Fitness (CTL)',
                                    atl: 'Fatigue (ATL)',
                                    tsb: 'Form (TSB)',
                                    trimp: 'Training Load',
                                  }
                                  return [value.toFixed(1), labels[name] || name]
                                }}
                              />
                              <ReferenceLine y={0} stroke="var(--separator)" strokeWidth={1} />
                              {getYearBoundaryLines(
                                banisterChartData.map((h) => ({
                                  date: h.date,
                                  fullDate: h.fullDate,
                                })),
                                banisterLabelRange,
                              ).map((yb) => (
                                <ReferenceLine
                                  key={yb.year}
                                  x={yb.formattedDate}
                                  stroke="var(--text-secondary)"
                                  strokeDasharray="4 4"
                                  strokeWidth={1.5}
                                  strokeOpacity={0.9}
                                  label={{
                                    value: `${yb.year}`,
                                    position: 'top',
                                    fontSize: 12,
                                    fill: 'var(--text-secondary)',
                                    fontWeight: 700,
                                  }}
                                />
                              ))}
                              <Area type="monotone" dataKey="tsb" fill="#22c55e15" stroke="none" />
                              <Line
                                type="monotone"
                                dataKey="ctl"
                                stroke="#3b82f6"
                                strokeWidth={2.5}
                                dot={false}
                              />
                              <Line
                                type="monotone"
                                dataKey="atl"
                                stroke="#ef4444"
                                strokeWidth={2}
                                dot={false}
                                strokeDasharray="4 3"
                              />
                              <Line
                                type="monotone"
                                dataKey="tsb"
                                stroke="#22c55e"
                                strokeWidth={1.5}
                                dot={false}
                              />
                              <Bar dataKey="trimp" fill="#f9731620" radius={[2, 2, 0, 0]} />
                              <Brush
                                dataKey="date"
                                height={22}
                                travellerWidth={8}
                                stroke="var(--accent-blue)"
                                fill="var(--bg-tertiary)"
                                tickFormatter={() => ''}
                              />
                            </ComposedChart>
                          </ResponsiveContainer>
                          <p
                            className="mt-1 text-[10px] text-center"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            Use the presets or drag the blue handles to zoom this chart.
                          </p>
                          <div
                            className="flex items-center justify-center gap-4 mt-2 text-[10px]"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <span className="flex items-center gap-1">
                              <span className="w-3 h-0.5" style={{ background: '#3b82f6' }} />{' '}
                              Fitness (CTL, {CTL_TAU}d)
                            </span>
                            <span className="flex items-center gap-1">
                              <span
                                className="w-3 h-0.5 border-t border-dashed"
                                style={{ borderColor: '#ef4444' }}
                              />{' '}
                              Fatigue (ATL, {ATL_TAU}d)
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="w-3 h-0.5" style={{ background: '#22c55e' }} /> Form
                              (TSB)
                            </span>
                            <span className="flex items-center gap-1">
                              <span
                                className="w-2 h-2 rounded-sm"
                                style={{ background: '#f9731620' }}
                              />{' '}
                              Daily Load
                            </span>
                          </div>
                          <div
                            className="mt-3 p-3 rounded-lg text-xs"
                            style={{
                              background: 'var(--bg-tertiary)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            <strong style={{ color: 'var(--text-primary)' }}>
                              Banister Impulse-Response Model:
                            </strong>{' '}
                            Fitness (CTL) builds slowly over ~42 days. Fatigue (ATL) spikes quickly
                            but dissipates in ~7 days. Form (TSB = CTL - ATL) predicts readiness:
                            positive = fresh & fit, negative = fatigued. Used by Strava,
                            TrainingPeaks, Garmin, and Elevate.
                          </div>
                        </div>
                      )
                    })()}

                  {/* Recovery Dashboard */}
                  <div className="card">
                    <div className="flex items-center gap-2 mb-4">
                      <Shield
                        size={14}
                        style={{
                          color:
                            fitnessAnalysis.recovery.recoveryScore >= 65
                              ? 'var(--accent-green)'
                              : 'var(--accent-red)',
                        }}
                      />
                      <span
                        className="text-sm font-medium"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Recovery Readiness
                      </span>
                      <span
                        className="ml-auto flex items-center gap-1.5 text-sm font-semibold"
                        style={{
                          color: fitnessAnalysis.recovery.readinessToTrain
                            ? 'var(--accent-green)'
                            : 'var(--accent-red)',
                        }}
                      >
                        {fitnessAnalysis.recovery.readinessToTrain ? (
                          <>
                            <CheckCircle size={14} /> Ready to Train
                          </>
                        ) : (
                          <>
                            <XCircle size={14} /> Rest Recommended
                          </>
                        )}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Recovery Score
                        </span>
                        <p
                          className="text-3xl font-bold"
                          style={{
                            color:
                              fitnessAnalysis.recovery.recoveryScore >= 70
                                ? 'var(--accent-green)'
                                : fitnessAnalysis.recovery.recoveryScore >= 45
                                  ? 'var(--accent-amber)'
                                  : 'var(--accent-red)',
                          }}
                        >
                          {fitnessAnalysis.recovery.recoveryScore}
                        </p>
                        <span
                          className="text-[10px] capitalize"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {fitnessAnalysis.recovery.recoveryStatus}
                        </span>
                      </div>
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Est. Recovery
                        </span>
                        <p className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
                          {fitnessAnalysis.recovery.estimatedRecoveryHours}
                          <span className="text-sm font-normal ml-0.5">h</span>
                        </p>
                      </div>
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Fitness Level
                        </span>
                        <p
                          className="text-lg font-bold mt-1"
                          style={{ color: 'var(--accent-blue)' }}
                        >
                          {fitnessAnalysis.profile.fitnessLevel}
                        </p>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Score: {fitnessAnalysis.profile.fitnessScore}/100
                        </span>
                      </div>
                    </div>

                    {/* Recovery factors */}
                    {fitnessAnalysis.recovery.factors.length > 0 && (
                      <div className="space-y-2">
                        {fitnessAnalysis.recovery.factors.map((f, i) => (
                          <div key={i} className="flex items-center gap-3">
                            <div
                              className="w-24 text-xs font-medium shrink-0"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {f.name}
                            </div>
                            <div
                              className="flex-1 h-2 rounded-full overflow-hidden"
                              style={{ background: 'var(--bg-tertiary)' }}
                            >
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${f.score}%`,
                                  background:
                                    f.score >= 70
                                      ? 'var(--accent-green)'
                                      : f.score >= 45
                                        ? 'var(--accent-amber)'
                                        : 'var(--accent-red)',
                                }}
                              />
                            </div>
                            <span
                              className="w-8 text-xs font-mono text-right"
                              style={{
                                color:
                                  f.score >= 70
                                    ? 'var(--accent-green)'
                                    : f.score >= 45
                                      ? 'var(--accent-amber)'
                                      : 'var(--accent-red)',
                              }}
                            >
                              {f.score}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Factor observations */}
                    {fitnessAnalysis.recovery.factors.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {fitnessAnalysis.recovery.factors.map((f, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <span
                              className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full"
                              style={{
                                background:
                                  f.score >= 70
                                    ? 'var(--accent-green)'
                                    : f.score >= 45
                                      ? 'var(--accent-amber)'
                                      : 'var(--accent-red)',
                              }}
                            />
                            <span style={{ color: 'var(--text-secondary)' }}>{f.observation}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Sleep Recommendation */}
                  <div className="card">
                    <div className="flex items-center gap-2 mb-3">
                      <BedDouble size={14} style={{ color: 'var(--accent-purple)' }} />
                      <span
                        className="text-sm font-medium"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Training-Adjusted Sleep Need
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Base Need
                        </span>
                        <p
                          className="text-xl font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {fitnessAnalysis.recovery.sleepRecommendation.baseNeed}h
                        </p>
                      </div>
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Training Extra
                        </span>
                        <p
                          className="text-xl font-semibold"
                          style={{ color: 'var(--accent-orange)' }}
                        >
                          +
                          {(
                            fitnessAnalysis.recovery.sleepRecommendation.trainingAdjustment * 60
                          ).toFixed(0)}
                          <span className="text-sm font-normal ml-0.5">min</span>
                        </p>
                      </div>
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Recommended
                        </span>
                        <p
                          className="text-xl font-semibold"
                          style={{ color: 'var(--accent-purple)' }}
                        >
                          {fitnessAnalysis.recovery.sleepRecommendation.totalRecommended}h
                        </p>
                      </div>
                    </div>
                    <p
                      className="text-xs leading-relaxed"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {fitnessAnalysis.recovery.sleepRecommendation.reasoning}
                    </p>
                    <div
                      className="mt-2 p-2.5 rounded-lg text-xs"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                    >
                      Based on: Fullagar et al. (2015) sleep recovery research — athletes training
                      at high loads need 8-10h sleep. Each ~50 TRIMP units of weekly training adds
                      ~15 min to sleep requirements.
                    </div>
                  </div>

                  {/* Daily Training Load (TRIMP) Chart */}
                  {fitnessAnalysis.trainingLoad.dailyLoads.length > 3 && (
                    <div className="card">
                      <div className="flex items-center gap-2 mb-4">
                        <Zap size={14} style={{ color: 'var(--accent-orange)' }} />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Daily Training Load (TRIMP)
                        </span>
                      </div>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart
                          data={fitnessAnalysis.trainingLoad.dailyLoads.map((d) => ({
                            ...d,
                            fullDate: d.date,
                            date: formatDateLabel(d.date, range),
                          }))}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--separator)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 10, fill: '#737373' }}
                            axisLine={false}
                            tickLine={false}
                            interval={Math.max(
                              0,
                              Math.floor(fitnessAnalysis.trainingLoad.dailyLoads.length / 15),
                            )}
                          />
                          <YAxis
                            tick={{ fontSize: 10, fill: '#737373' }}
                            axisLine={false}
                            tickLine={false}
                            width={35}
                          />
                          <Tooltip
                            contentStyle={tooltipStyle}
                            formatter={(value: number, name: string) => [
                              value.toFixed(1),
                              name === 'trimp' ? 'TRIMP' : 'EPOC',
                            ]}
                          />
                          {getYearBoundaryLines(
                            fitnessAnalysis.trainingLoad.dailyLoads.map((d) => ({
                              date: formatDateLabel(d.date, range),
                              fullDate: d.date,
                            })),
                            range,
                          ).map((yb) => (
                            <ReferenceLine
                              key={yb.year}
                              x={yb.formattedDate}
                              stroke="var(--text-secondary)"
                              strokeDasharray="4 4"
                              strokeWidth={1.5}
                              strokeOpacity={0.9}
                              label={{
                                value: `${yb.year}`,
                                position: 'top',
                                fontSize: 12,
                                fill: 'var(--text-secondary)',
                                fontWeight: 700,
                              }}
                            />
                          ))}
                          <Bar dataKey="trimp" fill="#f97316" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                      <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        TRIMP (Training Impulse): Combines exercise duration and heart rate
                        intensity using Banister's exponential weighting. Higher TRIMP = greater
                        physiological stress. Formula: duration x %HRR x 0.64 x e^(1.92 x %HRR).
                      </div>
                    </div>
                  )}

                  {/* Science-backed Insights */}
                  {fitnessAnalysis.insights.length > 0 && (
                    <div className="card">
                      <div className="flex items-center gap-2 mb-3">
                        <AlertTriangle size={14} style={{ color: 'var(--accent-amber)' }} />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Fitness Intelligence
                        </span>
                      </div>
                      <div className="space-y-2">
                        {fitnessAnalysis.insights.map((insight, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm">
                            <span
                              className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full"
                              style={{ background: 'var(--accent-amber)' }}
                            />
                            <span style={{ color: 'var(--text-secondary)' }}>{insight}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Methodology Card */}
                  <div className="card">
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Methodology
                    </span>
                    <div
                      className="mt-2 space-y-1.5 text-xs"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <p>
                        <strong>Banister Fitness-Fatigue Model (1975):</strong> Every workout
                        produces both a fitness stimulus (slow-building, long-lasting) and fatigue
                        (fast-building, fast-dissipating). Performance = Fitness - Fatigue.
                      </p>
                      <p>
                        <strong>TRIMP (Banister 1991):</strong> Training Impulse = duration x HR
                        reserve x exponential weighting. Higher heart rate zones receive
                        exponentially greater load scores.
                      </p>
                      <p>
                        <strong>CTL/ATL/TSB (TrainingPeaks):</strong> Chronic Training Load (42-day
                        EMA) represents accumulated fitness. Acute Training Load (7-day EMA)
                        represents recent fatigue. Training Stress Balance = CTL - ATL.
                      </p>
                      <p>
                        <strong>ACWR (Gabbett 2016):</strong> Acute:Chronic Workload Ratio. Sweet
                        spot: 0.8-1.3. Above 1.5 = injury risk zone.
                      </p>
                      <p>
                        <strong>Recovery Scoring:</strong> Weighted composite of HRV z-score (30%),
                        resting HR deviation (20%), sleep quality (25%), and training load balance
                        (25%).
                      </p>
                      <p>
                        <strong>Sleep Adjustment:</strong> Based on Fullagar et al. — heavy training
                        increases sleep need by up to 2h. Athletes need 8-10h during high-load
                        periods.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ========== HR ZONES TAB ========== */}
          {tab === 'zones' && (
            <>
              {!hrZoneData || hrZoneData.workoutsAnalyzed === 0 ? (
                <div className="card">
                  <p className="text-sm py-16 text-center" style={{ color: 'var(--text-muted)' }}>
                    No workouts with heart rate data available for zone analysis.
                  </p>
                </div>
              ) : (
                <>
                  {/* Stats row */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="card">
                      <span
                        className="text-[10px] uppercase tracking-wide"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Workouts Analyzed
                      </span>
                      <p
                        className="text-2xl font-semibold mt-1"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {hrZoneData.workoutsAnalyzed}
                      </p>
                    </div>
                    <div className="card">
                      <span
                        className="text-[10px] uppercase tracking-wide"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Total Time in Zones
                      </span>
                      <p
                        className="text-2xl font-semibold mt-1"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {hrZoneData.totalMinutes >= 60
                          ? `${Math.floor(hrZoneData.totalMinutes / 60)}h ${Math.round(hrZoneData.totalMinutes % 60)}m`
                          : `${Math.round(hrZoneData.totalMinutes)}m`}
                      </p>
                    </div>
                    {hrssData && (
                      <>
                        <div className="card">
                          <span
                            className="text-[10px] uppercase tracking-wide"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            Weekly HRSS
                          </span>
                          <p
                            className="text-2xl font-semibold mt-1"
                            style={{ color: 'var(--accent-orange)' }}
                          >
                            {hrssData.weeklyAvg}
                          </p>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            avg/day
                          </span>
                        </div>
                        <div className="card">
                          <span
                            className="text-[10px] uppercase tracking-wide"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            Total HRSS
                          </span>
                          <p
                            className="text-2xl font-semibold mt-1"
                            style={{ color: 'var(--accent-blue)' }}
                          >
                            {hrssData.total}
                          </p>
                        </div>
                      </>
                    )}
                  </div>

                  {/* HR Zone Distribution Pie + Bar */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="card">
                      <div className="flex items-center gap-2 mb-3">
                        <Target size={14} style={{ color: 'var(--accent-blue)' }} />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Zone Distribution
                        </span>
                      </div>
                      <ResponsiveContainer width="100%" height={250}>
                        <PieChart>
                          <Pie
                            data={hrZoneData.aggregate.filter((z: any) => z.minutes > 0)}
                            dataKey="minutes"
                            nameKey="zone"
                            cx="50%"
                            cy="50%"
                            innerRadius={50}
                            outerRadius={90}
                            paddingAngle={2}
                          >
                            {hrZoneData.aggregate
                              .filter((z: any) => z.minutes > 0)
                              .map((z: any, i: number) => (
                                <Cell key={i} fill={z.color} />
                              ))}
                          </Pie>
                          <Tooltip
                            content={({ payload }: any) => {
                              if (!payload?.[0]) return null
                              const d = payload[0].payload
                              return (
                                <div style={tooltipStyle} className="p-2">
                                  <p className="font-medium">{d.zone}</p>
                                  <p>
                                    {d.minutes >= 60
                                      ? `${Math.floor(d.minutes / 60)}h ${Math.round(d.minutes % 60)}m`
                                      : `${Math.round(d.minutes)}m`}{' '}
                                    ({d.pct}%)
                                  </p>
                                </div>
                              )
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      {/* Legend */}
                      <div className="flex flex-wrap gap-3 mt-2 justify-center">
                        {hrZoneData.aggregate.map((z: any) => (
                          <div key={z.zone} className="flex items-center gap-1.5 text-xs">
                            <div
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ background: z.color }}
                            />
                            <span style={{ color: 'var(--text-secondary)' }}>{z.zone}</span>
                            <span className="font-mono" style={{ color: 'var(--text-muted)' }}>
                              {z.pct}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="card">
                      <div className="flex items-center gap-2 mb-3">
                        <Activity size={14} style={{ color: 'var(--accent-green)' }} />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Time in Zone
                        </span>
                      </div>
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart data={hrZoneData.aggregate} layout="vertical">
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--separator)"
                            horizontal={false}
                          />
                          <XAxis
                            type="number"
                            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                            tickFormatter={(v: number) =>
                              v >= 60 ? `${Math.floor(v / 60)}h` : `${v}m`
                            }
                          />
                          <YAxis
                            type="category"
                            dataKey="zone"
                            tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                            width={100}
                          />
                          <Tooltip
                            content={({ payload }: any) => {
                              if (!payload?.[0]) return null
                              const d = payload[0].payload
                              return (
                                <div style={tooltipStyle} className="p-2">
                                  <p className="font-medium">{d.zone}</p>
                                  <p>
                                    {d.minutes >= 60
                                      ? `${Math.floor(d.minutes / 60)}h ${Math.round(d.minutes % 60)}m`
                                      : `${Math.round(d.minutes)}m`}
                                  </p>
                                </div>
                              )
                            }}
                          />
                          <Bar dataKey="minutes" radius={[0, 4, 4, 0]}>
                            {hrZoneData.aggregate.map((z: any, i: number) => (
                              <Cell key={i} fill={z.color} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* HRSS Daily Chart */}
                  {hrssData && hrssData.dailyHRSS.length > 0 && (
                    <div className="card">
                      <div className="flex items-center gap-2 mb-3">
                        <Zap size={14} style={{ color: 'var(--accent-orange)' }} />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Heart Rate Stress Score (HRSS)
                        </span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                        >
                          100 = 1hr at lactate threshold
                        </span>
                      </div>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart
                          data={hrssData.dailyHRSS.map((d: any) => ({
                            ...d,
                            date: formatDateLabel(d.date, range),
                          }))}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" />
                          <XAxis
                            dataKey="date"
                            tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                            interval={xAxisInterval(hrssData.dailyHRSS.length)}
                          />
                          <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
                          <Tooltip
                            contentStyle={tooltipStyle}
                            formatter={(v: number) => [`${v}`, 'HRSS']}
                          />
                          <Bar dataKey="hrss" fill="var(--accent-orange)" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                      <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        HRSS normalizes training load so different activities are comparable. 100
                        HRSS = the stress of 1 hour at your lactate threshold heart rate.
                      </div>
                    </div>
                  )}

                  {/* Per-workout zone breakdown table */}
                  {hrZoneData.perWorkout.length > 0 && (
                    <div className="card">
                      <div className="flex items-center gap-2 mb-3">
                        <Dumbbell size={14} style={{ color: 'var(--accent-green)' }} />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Per-Workout Zone Breakdown
                        </span>
                      </div>
                      <div className="overflow-y-auto max-h-96">
                        <table className="w-full text-xs">
                          <thead>
                            <tr style={{ color: 'var(--text-muted)' }}>
                              <SortHeader label="Date" sortKey="date" currentKey={zoneSort?.key ?? null} currentDir={zoneSort?.dir ?? 'desc'} onSort={toggleZSort} align="left" />
                              <SortHeader label="Workout" sortKey="name" currentKey={zoneSort?.key ?? null} currentDir={zoneSort?.dir ?? 'desc'} onSort={toggleZSort} align="left" />
                              <SortHeader label="Duration" sortKey="duration" currentKey={zoneSort?.key ?? null} currentDir={zoneSort?.dir ?? 'desc'} onSort={toggleZSort} />
                              <SortHeader label="HRSS" sortKey="hrss" currentKey={zoneSort?.key ?? null} currentDir={zoneSort?.dir ?? 'desc'} onSort={toggleZSort} />
                              <th className="py-2 font-medium" style={{ width: '40%' }}>
                                Zone Distribution
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortList(hrZoneData.perWorkout.slice(0, 50), zoneSort, { date: (w: any) => w.date, name: (w: any) => w.name, duration: (w: any) => w.duration, hrss: (w: any) => w.hrss || null }).map((w: any, i: number) => (
                              <tr
                                key={i}
                                className="border-t"
                                style={{ borderColor: 'var(--separator)' }}
                              >
                                <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                                  {format(parseISO(w.date), 'M/d')}
                                </td>
                                <td
                                  className="py-2 font-medium"
                                  style={{ color: 'var(--accent-green)' }}
                                >
                                  {w.name}
                                </td>
                                <td
                                  className="text-right py-2 font-mono"
                                  style={{ color: 'var(--text-secondary)' }}
                                >
                                  {w.duration >= 60
                                    ? `${Math.floor(w.duration / 60)}h ${w.duration % 60}m`
                                    : `${w.duration}m`}
                                </td>
                                <td
                                  className="text-right py-2 font-mono"
                                  style={{ color: 'var(--accent-orange)' }}
                                >
                                  {w.hrss > 0 ? w.hrss : '—'}
                                </td>
                                <td className="py-2">
                                  <div className="flex items-center gap-2">
                                    <div className="flex h-4 flex-1 rounded overflow-hidden">
                                      {w.distribution
                                        .filter((d: any) => d.minutes > 0)
                                        .map((d: any, j: number) => (
                                          <div
                                            key={j}
                                            style={{
                                              width: `${d.pct}%`,
                                              background: d.color,
                                              minWidth: d.pct > 0 ? '2px' : '0',
                                            }}
                                            title={`${d.zone}: ${Math.round(d.minutes)}m (${d.pct}%)`}
                                          />
                                        ))}
                                    </div>
                                    <span
                                      className="w-14 text-[10px] text-right capitalize"
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      {w.zoneSource || 'estimated'}
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Best Efforts / Personal Records */}
                  {bestEfforts && bestEfforts.records.length > 0 && (
                    <div className="card">
                      <div className="flex items-center gap-2 mb-3">
                        <Trophy size={14} style={{ color: 'var(--accent-amber)' }} />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Personal Records
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        {bestEfforts.records.map((r: any) => (
                          <div
                            key={r.category}
                            className="rounded-lg p-3"
                            style={{
                              background: 'var(--bg-tertiary)',
                              border: '1px solid var(--separator)',
                            }}
                          >
                            <span
                              className="text-[10px] uppercase tracking-wide"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {r.category}
                            </span>
                            <p
                              className="text-lg font-semibold mt-1"
                              style={{ color: 'var(--accent-amber)' }}
                            >
                              {r.category === 'Fastest Pace'
                                ? `${Math.floor(r.best.value)}:${String(Math.round((r.best.value % 1) * 60)).padStart(2, '0')}`
                                : r.best.value >= 60 && r.best.unit === 'min'
                                  ? `${Math.floor(r.best.value / 60)}h ${r.best.value % 60}m`
                                  : r.best.value.toLocaleString()}
                              <span
                                className="text-xs font-normal ml-1"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                {r.best.unit}
                              </span>
                            </p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                              {r.best.workoutName} · {format(parseISO(r.best.date), 'MMM d, yyyy')}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ========== PACE & POWER TAB (stream-based) ========== */}
          {tab === 'streams' && (
            <>
              {/* Sync Streams button */}
              <div className="card flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    Activity Streams
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Detailed second-by-second data from Strava. Required for pace zones, cadence
                    zones, power zones, grade analysis, best splits, and grade-adjusted pace.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {streamsSyncMsg && (
                    <span
                      className="text-xs"
                      style={{
                        color: streamsSyncMsg.includes('Error')
                          ? 'var(--accent-red)'
                          : 'var(--accent-green)',
                      }}
                    >
                      {streamsSyncMsg}
                    </span>
                  )}
                  <button
                    onClick={async () => {
                      setStreamsSyncing(true)
                      setStreamsSyncMsg('')
                      try {
                        const r = await window.api.stravaSyncStreams(
                          range === 9999 ? 3650 : range,
                          50,
                        )
                        if (r.error) setStreamsSyncMsg(`Error: ${r.error}`)
                        else
                          setStreamsSyncMsg(
                            `Fetched ${r.fetched} streams; activity details ${r.activityDetailsFetched ?? 0}`,
                          )
                        await refreshWorkouts()
                        setAnalysisRefreshKey((k) => k + 1)
                        // Reload stream data
                        const fd = range === 9999 ? 3000 : range
                        window.api
                          .getStreamZones(fd)
                          .then(setStreamZones)
                          .catch((err) =>
                            showToast(
                              `Stream zones failed to reload: ${getErrorMessage(err)}`,
                              'error',
                            ),
                          )
                        window.api
                          .getBestSplits(fd)
                          .then(setBestSplits)
                          .catch((err) =>
                            showToast(
                              `Best splits failed to reload: ${getErrorMessage(err)}`,
                              'error',
                            ),
                          )
                        window.api
                          .getGradeAdjustedPace(fd)
                          .then(setGapData)
                          .catch((err) =>
                            showToast(
                              `Grade-adjusted pace failed to reload: ${getErrorMessage(err)}`,
                              'error',
                            ),
                          )
                        window.api
                          .getRunningPower(fd)
                          .then(setRunPowerData)
                          .catch((err) =>
                            showToast(
                              `Running power failed to reload: ${getErrorMessage(err)}`,
                              'error',
                            ),
                          )
                      } catch (err: any) {
                        setStreamsSyncMsg(`Error: ${err.message}`)
                        showToast(`Stream sync failed: ${getErrorMessage(err)}`, 'error')
                      }
                      setStreamsSyncing(false)
                      setTimeout(() => setStreamsSyncMsg(''), 5000)
                    }}
                    disabled={streamsSyncing || !stravaStatus.connected}
                    className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                    style={{ background: 'var(--accent-blue)', color: 'white' }}
                  >
                    <RefreshCw size={12} className={streamsSyncing ? 'animate-spin' : ''} />
                    {streamsSyncing ? 'Syncing...' : 'Sync Streams'}
                  </button>
                </div>
              </div>

              {/* Best Splits */}
              {bestSplits &&
                (bestSplits.hrSplits.length > 0 ||
                  bestSplits.paceSplits.length > 0 ||
                  bestSplits.powerSplits.length > 0) && (
                  <div className="card">
                    <div className="flex items-center gap-2 mb-3">
                      <Trophy size={14} style={{ color: 'var(--accent-amber)' }} />
                      <span
                        className="text-sm font-medium"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Best Splits
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      {/* HR splits */}
                      {bestSplits.hrSplits.length > 0 && (
                        <div>
                          <p
                            className="text-xs font-medium mb-2"
                            style={{ color: 'var(--accent-red)' }}
                          >
                            Best Avg HR
                          </p>
                          <div className="space-y-1">
                            {bestSplits.hrSplits.map((s: any) => (
                              <div key={s.rangeLabel} className="flex justify-between text-xs">
                                <span style={{ color: 'var(--text-muted)' }}>{s.rangeLabel}</span>
                                <span
                                  className="font-mono"
                                  style={{ color: 'var(--text-primary)' }}
                                >
                                  {s.value} bpm
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* Pace splits */}
                      {bestSplits.paceSplits.length > 0 && (
                        <div>
                          <p
                            className="text-xs font-medium mb-2"
                            style={{ color: 'var(--accent-green)' }}
                          >
                            Best Pace
                          </p>
                          <div className="space-y-1">
                            {bestSplits.paceSplits.map((s: any) => (
                              <div key={s.rangeLabel} className="flex justify-between text-xs">
                                <span style={{ color: 'var(--text-muted)' }}>{s.rangeLabel}</span>
                                <span
                                  className="font-mono"
                                  style={{ color: 'var(--text-primary)' }}
                                >
                                  {Math.floor(s.value)}:
                                  {String(Math.round((s.value % 1) * 60)).padStart(2, '0')}/mi
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* Power splits */}
                      {bestSplits.powerSplits.length > 0 && (
                        <div>
                          <p
                            className="text-xs font-medium mb-2"
                            style={{ color: 'var(--accent-orange)' }}
                          >
                            Best Power
                          </p>
                          <div className="space-y-1">
                            {bestSplits.powerSplits.map((s: any) => (
                              <div key={s.rangeLabel} className="flex justify-between text-xs">
                                <span style={{ color: 'var(--text-muted)' }}>{s.rangeLabel}</span>
                                <span
                                  className="font-mono"
                                  style={{ color: 'var(--text-primary)' }}
                                >
                                  {s.value} W
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              {/* Pace Zones */}
              {streamZones?.paceZones && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-3">
                    <Footprints size={14} style={{ color: 'var(--accent-green)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Pace Zones
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={streamZones.paceZones.aggregate} layout="vertical">
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="var(--separator)"
                          horizontal={false}
                        />
                        <XAxis
                          type="number"
                          tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                          tickFormatter={(v: number) =>
                            v >= 3600 ? `${Math.floor(v / 3600)}h` : `${Math.floor(v / 60)}m`
                          }
                        />
                        <YAxis
                          type="category"
                          dataKey="zone"
                          tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                          width={120}
                        />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(v: number) => [`${Math.floor(v / 60)}m ${v % 60}s`, 'Time']}
                        />
                        <Bar dataKey="seconds" radius={[0, 4, 4, 0]}>
                          {streamZones.paceZones.aggregate.map((z: any, i: number) => (
                            <Cell key={i} fill={z.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    <div className="space-y-2">
                      {streamZones.paceZones.aggregate.map((z: any) => (
                        <div key={z.zone} className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <div
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ background: z.color }}
                            />
                            <span style={{ color: 'var(--text-secondary)' }}>{z.zone}</span>
                          </div>
                          <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                            {z.pct}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Cadence Zones */}
              {streamZones?.cadenceZones && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-3">
                    <Activity size={14} style={{ color: 'var(--accent-blue)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Cadence Zones
                    </span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                    >
                      SPM
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={streamZones.cadenceZones.aggregate} layout="vertical">
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--separator)"
                        horizontal={false}
                      />
                      <XAxis
                        type="number"
                        tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                        tickFormatter={(v: number) => `${Math.floor(v / 60)}m`}
                      />
                      <YAxis
                        type="category"
                        dataKey="zone"
                        tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                        width={130}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: number) => [
                          `${Math.floor(v / 60)}m ${v % 60}s (${streamZones.cadenceZones.aggregate.find((z: any) => z.seconds === v)?.pct || 0}%)`,
                          'Time',
                        ]}
                      />
                      <Bar dataKey="seconds" radius={[0, 4, 4, 0]}>
                        {streamZones.cadenceZones.aggregate.map((z: any, i: number) => (
                          <Cell key={i} fill={z.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Power Zones */}
              {streamZones?.powerZones && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-3">
                    <Zap size={14} style={{ color: 'var(--accent-orange)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Power Zones
                    </span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                    >
                      % of FTP
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie
                          data={streamZones.powerZones.aggregate.filter((z: any) => z.seconds > 0)}
                          dataKey="seconds"
                          nameKey="zone"
                          cx="50%"
                          cy="50%"
                          innerRadius={40}
                          outerRadius={80}
                          paddingAngle={2}
                        >
                          {streamZones.powerZones.aggregate
                            .filter((z: any) => z.seconds > 0)
                            .map((z: any, i: number) => (
                              <Cell key={i} fill={z.color} />
                            ))}
                        </Pie>
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(v: number) => [`${Math.floor(v / 60)}m ${v % 60}s`, 'Time']}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="space-y-2 flex flex-col justify-center">
                      {streamZones.powerZones.aggregate.map((z: any) => (
                        <div key={z.zone} className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <div
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ background: z.color }}
                            />
                            <span style={{ color: 'var(--text-secondary)' }}>{z.zone}</span>
                          </div>
                          <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                            {z.pct}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Grade Zones */}
              {streamZones?.gradeZones && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-3">
                    <Mountain size={14} style={{ color: 'var(--accent-purple)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Grade / Elevation Zones
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={streamZones.gradeZones.aggregate} layout="vertical">
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--separator)"
                        horizontal={false}
                      />
                      <XAxis
                        type="number"
                        tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                        tickFormatter={(v: number) => `${Math.floor(v / 60)}m`}
                      />
                      <YAxis
                        type="category"
                        dataKey="zone"
                        tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                        width={140}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: number) => [`${Math.floor(v / 60)}m ${v % 60}s`, 'Time']}
                      />
                      <Bar dataKey="seconds" radius={[0, 4, 4, 0]}>
                        {streamZones.gradeZones.aggregate.map((z: any, i: number) => (
                          <Cell key={i} fill={z.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Grade-Adjusted Pace */}
              {gapData && gapData.perActivity.length > 0 && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-3">
                    <Mountain size={14} style={{ color: 'var(--accent-green)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Grade-Adjusted Pace (GAP)
                    </span>
                  </div>
                  <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                    GAP adjusts your pace for elevation changes, making hilly and flat runs
                    comparable. Based on the Strava/Elevate polynomial model.
                  </p>
                  <div className="overflow-y-auto max-h-72">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ color: 'var(--text-muted)' }}>
                          <SortHeader label="Date" sortKey="date" currentKey={gapSort?.key ?? null} currentDir={gapSort?.dir ?? 'desc'} onSort={toggleGSort} align="left" />
                          <SortHeader label="Activity" sortKey="name" currentKey={gapSort?.key ?? null} currentDir={gapSort?.dir ?? 'desc'} onSort={toggleGSort} align="left" />
                          <SortHeader label="Actual Pace" sortKey="pace" currentKey={gapSort?.key ?? null} currentDir={gapSort?.dir ?? 'desc'} onSort={toggleGSort} />
                          <SortHeader label="GAP" sortKey="gap" currentKey={gapSort?.key ?? null} currentDir={gapSort?.dir ?? 'desc'} onSort={toggleGSort} />
                          <SortHeader label="Delta" sortKey="delta" currentKey={gapSort?.key ?? null} currentDir={gapSort?.dir ?? 'desc'} onSort={toggleGSort} />
                          <SortHeader label="Elevation" sortKey="elevation" currentKey={gapSort?.key ?? null} currentDir={gapSort?.dir ?? 'desc'} onSort={toggleGSort} />
                        </tr>
                      </thead>
                      <tbody>
                        {sortList(gapData.perActivity, gapSort, { date: (a: any) => a.date, name: (a: any) => a.name, pace: (a: any) => a.avgPace, gap: (a: any) => a.avgGAP, delta: (a: any) => a.gapDelta, elevation: (a: any) => a.elevationGain || null }).map((a: any) => (
                          <tr
                            key={a.activityId}
                            className="border-t"
                            style={{ borderColor: 'var(--separator)' }}
                          >
                            <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                              {format(parseISO(a.date), 'M/d')}
                            </td>
                            <td
                              className="py-2 font-medium"
                              style={{ color: 'var(--accent-green)' }}
                            >
                              {a.name}
                            </td>
                            <td
                              className="text-right py-2 font-mono"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {Math.floor(a.avgPace)}:
                              {String(Math.round((a.avgPace % 1) * 60)).padStart(2, '0')}/mi
                            </td>
                            <td
                              className="text-right py-2 font-mono font-medium"
                              style={{ color: 'var(--accent-blue)' }}
                            >
                              {Math.floor(a.avgGAP)}:
                              {String(Math.round((a.avgGAP % 1) * 60)).padStart(2, '0')}/mi
                            </td>
                            <td
                              className="text-right py-2 font-mono"
                              style={{
                                color: a.gapDelta > 0 ? 'var(--accent-red)' : 'var(--accent-green)',
                              }}
                            >
                              {a.gapDelta > 0 ? '+' : ''}
                              {a.gapDelta}s
                            </td>
                            <td
                              className="text-right py-2 font-mono"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {a.elevationGain > 0 ? `${a.elevationGain}m` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Estimated Running Power */}
              {runPowerData && runPowerData.perActivity.length > 0 && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-3">
                    <Zap size={14} style={{ color: 'var(--accent-orange)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Estimated Running Power
                    </span>
                  </div>
                  <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                    Power = 1.04 x weight x grade-adjusted speed. Useful for pacing on hilly
                    terrain.
                  </p>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart
                      data={runPowerData.perActivity.map((a: any) => ({
                        ...a,
                        date: format(parseISO(a.date), 'M/d'),
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" />
                      <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
                      <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar
                        dataKey="avgPower"
                        name="Avg Power (W)"
                        fill="var(--accent-orange)"
                        radius={[3, 3, 0, 0]}
                      />
                      <Bar
                        dataKey="normalizedPower"
                        name="Normalized Power (W)"
                        fill="var(--accent-purple)"
                        radius={[3, 3, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="overflow-y-auto max-h-48 mt-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ color: 'var(--text-muted)' }}>
                          <SortHeader label="Date" sortKey="date" currentKey={powerSort?.key ?? null} currentDir={powerSort?.dir ?? 'desc'} onSort={togglePSort} align="left" />
                          <SortHeader label="Activity" sortKey="name" currentKey={powerSort?.key ?? null} currentDir={powerSort?.dir ?? 'desc'} onSort={togglePSort} align="left" />
                          <SortHeader label="Avg W" sortKey="avgPower" currentKey={powerSort?.key ?? null} currentDir={powerSort?.dir ?? 'desc'} onSort={togglePSort} />
                          <SortHeader label="NP" sortKey="np" currentKey={powerSort?.key ?? null} currentDir={powerSort?.dir ?? 'desc'} onSort={togglePSort} />
                          <SortHeader label="Max W" sortKey="maxPower" currentKey={powerSort?.key ?? null} currentDir={powerSort?.dir ?? 'desc'} onSort={togglePSort} />
                        </tr>
                      </thead>
                      <tbody>
                        {sortList(runPowerData.perActivity, powerSort, { date: (a: any) => a.date, name: (a: any) => a.name, avgPower: (a: any) => a.avgPower, np: (a: any) => a.normalizedPower, maxPower: (a: any) => a.maxPower }).map((a: any) => (
                          <tr
                            key={a.activityId}
                            className="border-t"
                            style={{ borderColor: 'var(--separator)' }}
                          >
                            <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                              {format(parseISO(a.date), 'M/d')}
                            </td>
                            <td
                              className="py-2 font-medium"
                              style={{ color: 'var(--accent-green)' }}
                            >
                              {a.name}
                            </td>
                            <td
                              className="text-right py-2 font-mono"
                              style={{ color: 'var(--accent-orange)' }}
                            >
                              {a.avgPower}
                            </td>
                            <td
                              className="text-right py-2 font-mono"
                              style={{ color: 'var(--accent-purple)' }}
                            >
                              {a.normalizedPower}
                            </td>
                            <td
                              className="text-right py-2 font-mono"
                              style={{ color: 'var(--accent-red)' }}
                            >
                              {a.maxPower}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* No stream data message */}
              {!streamZones?.paceZones &&
                !streamZones?.cadenceZones &&
                !streamZones?.powerZones &&
                !streamZones?.gradeZones &&
                !bestSplits?.hrSplits?.length &&
                !gapData?.perActivity?.length &&
                !runPowerData?.perActivity?.length && (
                  <div className="card">
                    <p className="text-sm py-12 text-center" style={{ color: 'var(--text-muted)' }}>
                      No activity streams available. Click "Sync Streams" above to fetch detailed
                      second-by-second data from Strava.
                    </p>
                  </div>
                )}
            </>
          )}

          {/* ========== YEAR PROGRESS TAB ========== */}
          {tab === 'year' && (
            <>
              {!yearProgressData || yearProgressData.years.length === 0 ? (
                <div className="card">
                  <p className="text-sm py-16 text-center" style={{ color: 'var(--text-muted)' }}>
                    No workout data available for year progression. Sync your Strava activities
                    first.
                  </p>
                </div>
              ) : (
                (() => {
                  const YEAR_COLORS = [
                    '#0ea5e9',
                    '#22c55e',
                    '#f97316',
                    '#a855f7',
                    '#ef4444',
                    '#14b8a6',
                    '#eab308',
                    '#ec4899',
                    '#6366f1',
                    '#84cc16',
                    '#f59e0b',
                    '#06b6d4',
                  ]
                  const metrics = [
                    {
                      key: 'cumulativeCount',
                      label: 'Activities',
                      unit: '',
                      icon: <Dumbbell size={14} />,
                    },
                    {
                      key: 'cumulativeDistance',
                      label: 'Distance',
                      unit: 'mi',
                      icon: <Footprints size={14} />,
                    },
                    {
                      key: 'cumulativeTime',
                      label: 'Time',
                      unit: 'min',
                      icon: <Timer size={14} />,
                    },
                    {
                      key: 'cumulativeElevation',
                      label: 'Elevation',
                      unit: 'ft',
                      icon: <Mountain size={14} />,
                    },
                    {
                      key: 'cumulativeCalories',
                      label: 'Calories',
                      unit: 'cal',
                      icon: <Flame size={14} />,
                    },
                  ]
                  return (
                    <>
                      {/* Year summary cards */}
                      <div className="grid grid-cols-5 gap-3">
                        {yearProgressData.years.map((y: any, yi: number) => {
                          const lastPoint = y.data[y.data.length - 1]
                          return (
                            <div
                              key={y.year}
                              className="card"
                              style={{
                                borderTop: `3px solid ${YEAR_COLORS[yi % YEAR_COLORS.length]}`,
                              }}
                            >
                              <span
                                className="text-lg font-bold"
                                style={{ color: YEAR_COLORS[yi % YEAR_COLORS.length] }}
                              >
                                {y.year}
                              </span>
                              <div className="mt-2 space-y-1 text-xs">
                                <div className="flex justify-between">
                                  <span style={{ color: 'var(--text-muted)' }}>Activities</span>
                                  <span style={{ color: 'var(--text-primary)' }}>
                                    {lastPoint?.cumulativeCount || 0}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span style={{ color: 'var(--text-muted)' }}>Distance</span>
                                  <span style={{ color: 'var(--text-primary)' }}>
                                    {(lastPoint?.cumulativeDistance || 0).toFixed(1)} mi
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span style={{ color: 'var(--text-muted)' }}>Time</span>
                                  <span style={{ color: 'var(--text-primary)' }}>
                                    {lastPoint?.cumulativeTime >= 60
                                      ? `${Math.floor(lastPoint.cumulativeTime / 60)}h`
                                      : `${lastPoint?.cumulativeTime || 0}m`}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span style={{ color: 'var(--text-muted)' }}>Elevation</span>
                                  <span style={{ color: 'var(--text-primary)' }}>
                                    {(lastPoint?.cumulativeElevation || 0).toLocaleString()} ft
                                  </span>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      {/* Cumulative charts for each metric */}
                      {metrics.map((metric) => {
                        // Check if any year has non-zero data for this metric
                        const hasData = yearProgressData.years.some((y: any) =>
                          y.data.some((d: any) => d[metric.key] > 0),
                        )
                        if (!hasData) return null

                        return (
                          <div key={metric.key} className="card">
                            <div className="flex items-center gap-2 mb-3">
                              <span style={{ color: 'var(--accent-blue)' }}>{metric.icon}</span>
                              <span
                                className="text-sm font-medium"
                                style={{ color: 'var(--text-primary)' }}
                              >
                                Cumulative {metric.label}
                              </span>
                            </div>
                            <ResponsiveContainer width="100%" height={250}>
                              <LineChart>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" />
                                <XAxis
                                  dataKey="dayOfYear"
                                  type="number"
                                  domain={[1, 366]}
                                  tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                                  tickFormatter={(d: number) => {
                                    const months = [
                                      'Jan',
                                      'Feb',
                                      'Mar',
                                      'Apr',
                                      'May',
                                      'Jun',
                                      'Jul',
                                      'Aug',
                                      'Sep',
                                      'Oct',
                                      'Nov',
                                      'Dec',
                                    ]
                                    const m = Math.floor((d - 1) / 30.44)
                                    return months[Math.min(m, 11)]
                                  }}
                                  ticks={[1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]}
                                />
                                <YAxis
                                  tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                                  tickFormatter={(v: number) => {
                                    if (metric.key === 'cumulativeTime' && v >= 60)
                                      return `${Math.floor(v / 60)}h`
                                    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
                                    return String(v)
                                  }}
                                />
                                <Tooltip
                                  contentStyle={tooltipStyle}
                                  labelFormatter={(d: number) => `Day ${d}`}
                                  formatter={(v: number, name: string) => {
                                    if (metric.key === 'cumulativeTime' && v >= 60)
                                      return [`${Math.floor(v / 60)}h ${v % 60}m`, name]
                                    return [`${v.toLocaleString()} ${metric.unit}`, name]
                                  }}
                                />
                                <Legend />
                                {yearProgressData.years.map((y: any, yi: number) => (
                                  <Line
                                    key={y.year}
                                    data={y.data}
                                    dataKey={metric.key}
                                    name={String(y.year)}
                                    stroke={YEAR_COLORS[yi % YEAR_COLORS.length]}
                                    dot={false}
                                    strokeWidth={2}
                                    connectNulls
                                  />
                                ))}
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        )
                      })}
                    </>
                  )
                })()
              )}
            </>
          )}

          {/* ========== HEART & RECOVERY TAB ========== */}
          {tab === 'heart' && (
            <>
              {/* Heart rate range chart (min/avg/max) */}
              {hrData.length > 0 && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-4">
                    <Heart size={14} style={{ color: 'var(--accent-red)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Daily Heart Rate (Min / Avg / Max)
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={hrData}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--separator)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        interval={xAxisInterval(hrData.length)}
                      />
                      <YAxis
                        domain={['dataMin - 5', 'dataMax + 5']}
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        width={35}
                        tickFormatter={(v) => `${v}`}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value: number, name: string) => {
                          const labels: Record<string, string> = {
                            hrMin: 'Min HR',
                            hrAvg: 'Avg HR',
                            hrMax: 'Max HR',
                          }
                          return [`${value} bpm`, labels[name] || name]
                        }}
                      />
                      {yearBoundaries.map((yb) => (
                        <ReferenceLine
                          key={yb.year}
                          x={yb.formattedDate}
                          stroke="var(--text-secondary)"
                          strokeDasharray="4 4"
                          strokeWidth={1.5}
                          strokeOpacity={0.9}
                          label={{
                            value: `${yb.year}`,
                            position: 'top',
                            fontSize: 12,
                            fill: 'var(--text-secondary)',
                            fontWeight: 700,
                          }}
                        />
                      ))}
                      <Area type="monotone" dataKey="hrMax" fill="#ef444430" stroke="none" />
                      <Area type="monotone" dataKey="hrMin" fill="#1a1a1a" stroke="none" />
                      <Line
                        type="monotone"
                        dataKey="hrMax"
                        stroke="#ef4444"
                        strokeWidth={1}
                        dot={false}
                        strokeOpacity={0.5}
                      />
                      <Line
                        type="monotone"
                        dataKey="hrAvg"
                        stroke="#f97316"
                        strokeWidth={2}
                        dot={{ fill: '#f97316', r: hrData.length <= 14 ? 3 : 0 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="hrMin"
                        stroke="#3b82f6"
                        strokeWidth={1}
                        dot={false}
                        strokeOpacity={0.5}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                  <div
                    className="flex items-center justify-center gap-4 mt-2 text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-0.5" style={{ background: '#ef4444' }} /> Max
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-0.5" style={{ background: '#f97316' }} /> Average
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-0.5" style={{ background: '#3b82f6' }} /> Min
                    </span>
                  </div>
                </div>
              )}

              {/* Resting Heart Rate trend */}
              {rhrData.length > 0 && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-4">
                    <Heart size={14} style={{ color: 'var(--accent-purple)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Resting Heart Rate Trend
                    </span>
                    <TrendBadge
                      data={rhrData.map((d) => d.restingHr)}
                      unit=" bpm"
                      higherIsBetter={false}
                    />
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart data={hrWithTrend}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--separator)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        interval={xAxisInterval(rhrData.length)}
                      />
                      <YAxis
                        domain={['dataMin - 3', 'dataMax + 3']}
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        width={35}
                        tickFormatter={(v) => `${v}`}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value: number, name: string) => [
                          `${Math.round(value)} bpm`,
                          name === 'rhrTrend' ? 'Trend' : 'Resting HR',
                        ]}
                      />
                      {yearBoundaries.map((yb) => (
                        <ReferenceLine
                          key={yb.year}
                          x={yb.formattedDate}
                          stroke="var(--text-secondary)"
                          strokeDasharray="4 4"
                          strokeWidth={1.5}
                          strokeOpacity={0.9}
                          label={{
                            value: `${yb.year}`,
                            position: 'top',
                            fontSize: 12,
                            fill: 'var(--text-secondary)',
                            fontWeight: 700,
                          }}
                        />
                      ))}
                      <Line
                        type="monotone"
                        dataKey="restingHr"
                        stroke="#a855f7"
                        strokeWidth={2}
                        dot={{ fill: '#a855f7', r: rhrData.length <= 30 ? 3 : 0 }}
                      />
                      <Line
                        type="linear"
                        dataKey="rhrTrend"
                        stroke="#f97316"
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                  <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Lower resting HR indicates better cardiovascular fitness. Elite athletes: 40-50
                    bpm. Average adults: 60-80 bpm.
                  </div>
                </div>
              )}

              {/* HRV trend */}
              {hrvData.length > 0 && (
                <div className="card">
                  <div className="flex items-center gap-2 mb-4">
                    <Activity size={14} style={{ color: 'var(--accent-blue)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      HRV (Heart Rate Variability)
                    </span>
                    <TrendBadge data={hrvData.map((d) => d.hrv)} unit=" ms" />
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={hrvData}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--separator)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        interval={xAxisInterval(hrvData.length)}
                      />
                      <YAxis
                        domain={['dataMin - 5', 'dataMax + 5']}
                        tick={{ fontSize: 10, fill: '#737373' }}
                        axisLine={false}
                        tickLine={false}
                        width={35}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value: number) => [`${value} ms`, 'HRV']}
                      />
                      <ReferenceLine
                        y={avgHRV}
                        stroke="var(--accent-blue)"
                        strokeDasharray="5 5"
                        strokeWidth={1}
                        label={{
                          value: `avg ${avgHRV}ms`,
                          position: 'right',
                          fontSize: 10,
                          fill: '#3b82f6',
                        }}
                      />
                      {yearBoundaries.map((yb) => (
                        <ReferenceLine
                          key={yb.year}
                          x={yb.formattedDate}
                          stroke="var(--text-secondary)"
                          strokeDasharray="4 4"
                          strokeWidth={1.5}
                          strokeOpacity={0.9}
                          label={{
                            value: `${yb.year}`,
                            position: 'top',
                            fontSize: 12,
                            fill: 'var(--text-secondary)',
                            fontWeight: 700,
                          }}
                        />
                      ))}
                      <Line
                        type="monotone"
                        dataKey="hrv"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={{ fill: '#3b82f6', r: hrvData.length <= 30 ? 3 : 0 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                  <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Higher HRV indicates better recovery and autonomic nervous system health. Track
                    alongside exercise to find your optimal training load.
                  </div>
                </div>
              )}

              {/* VO2 Max + Resting HR combined */}
              {vo2Data.length > 0 &&
                rhrData.length > 0 &&
                (() => {
                  const norms = getExerciseNorms(userAge)
                  const vo2Pct = exPctRank(latestVo2, norms.vo2.avg, norms.vo2.sd)
                  // RHR: lower is better, so invert percentile
                  const rhrPct = 100 - exPctRank(avgRHR, norms.rhr.avg, norms.rhr.sd)
                  const vo2Color =
                    vo2Pct >= 60
                      ? 'var(--accent-green)'
                      : vo2Pct >= 35
                        ? 'var(--accent-amber)'
                        : 'var(--accent-red)'
                  const rhrColor =
                    rhrPct >= 60
                      ? 'var(--accent-green)'
                      : rhrPct >= 35
                        ? 'var(--accent-amber)'
                        : 'var(--accent-red)'
                  return (
                    <div className="card">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                          <Zap size={14} style={{ color: 'var(--accent-green)' }} />
                          <span
                            className="text-sm font-medium"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            Cardio Fitness Overview
                          </span>
                        </div>
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                          style={{
                            background: 'rgba(34,197,94,0.12)',
                            color: 'var(--accent-green)',
                          }}
                        >
                          Ages {norms.ageGroup}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div
                          className="p-4 rounded-lg"
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Latest VO2 Max
                          </span>
                          <p
                            className="text-3xl font-bold mt-1"
                            style={{ color: 'var(--accent-green)' }}
                          >
                            {latestVo2}
                            <span
                              className="text-sm font-normal ml-1"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              mL/kg/min
                            </span>
                          </p>
                          <div
                            className="mt-2 h-2 rounded-full overflow-hidden"
                            style={{ background: 'var(--separator)' }}
                          >
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${vo2Pct}%`,
                                background: vo2Color,
                              }}
                            />
                          </div>
                          <div
                            className="flex justify-between mt-1 text-[10px]"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <span>Peer avg: {norms.vo2.avg}</span>
                            <span style={{ color: vo2Color }}>
                              {vo2Pct >= 50 ? `Top ${100 - vo2Pct}%` : `Bottom ${vo2Pct}%`}
                            </span>
                          </div>
                        </div>
                        <div
                          className="p-4 rounded-lg"
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Avg Resting Heart Rate
                          </span>
                          <p
                            className="text-3xl font-bold mt-1"
                            style={{ color: 'var(--accent-purple)' }}
                          >
                            {avgRHR}
                            <span
                              className="text-sm font-normal ml-1"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              bpm
                            </span>
                          </p>
                          <div
                            className="mt-2 h-2 rounded-full overflow-hidden"
                            style={{ background: 'var(--separator)' }}
                          >
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${rhrPct}%`,
                                background: rhrColor,
                              }}
                            />
                          </div>
                          <div
                            className="flex justify-between mt-1 text-[10px]"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <span>Peer avg: {norms.rhr.avg} bpm</span>
                            <span style={{ color: rhrColor }}>
                              {rhrPct >= 50 ? `Top ${100 - rhrPct}%` : `Bottom ${rhrPct}%`}
                            </span>
                          </div>
                        </div>
                      </div>
                      <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                        ACSM 2013 (VO2 Max) · AHA (Resting HR)
                        {!userAge ? ' · Set your age in Settings for age-adjusted norms' : ''}
                      </p>
                    </div>
                  )
                })()}
            </>
          )}

          {/* ========== SLEEP VS FITNESS TAB ========== */}
          {tab === 'sleep' && (
            <>
              {/* Sleep duration vs Exercise minutes overlay */}
              {sleepExerciseCorr.length > 3 && (
                <>
                  <div className="card">
                    <div className="flex items-center gap-2 mb-4">
                      <Moon size={14} style={{ color: 'var(--accent-purple)' }} />
                      <span
                        className="text-sm font-medium"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Sleep vs Exercise Over Time
                      </span>
                    </div>
                    <ResponsiveContainer width="100%" height={300}>
                      <ComposedChart data={sleepExerciseCorr}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="var(--separator)"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 10, fill: '#737373' }}
                          axisLine={false}
                          tickLine={false}
                          interval={xAxisInterval(sleepExerciseCorr.length)}
                        />
                        <YAxis
                          yAxisId="sleep"
                          orientation="left"
                          domain={[0, 12]}
                          tick={{ fontSize: 10, fill: '#a855f7' }}
                          axisLine={false}
                          tickLine={false}
                          width={35}
                          tickFormatter={(v) => `${v}h`}
                        />
                        <YAxis
                          yAxisId="exercise"
                          orientation="right"
                          tick={{ fontSize: 10, fill: '#ef4444' }}
                          axisLine={false}
                          tickLine={false}
                          width={35}
                          tickFormatter={(v) => `${v}m`}
                        />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(value: number, name: string) => {
                            if (name === 'sleepHours') return [`${value}h`, 'Sleep']
                            if (name === 'exerciseMin') return [`${value}m`, 'Exercise']
                            return [value, name]
                          }}
                        />
                        {yearBoundaries.map((yb) => (
                          <ReferenceLine
                            key={yb.year}
                            x={yb.formattedDate}
                            stroke="var(--text-secondary)"
                            strokeDasharray="4 4"
                            strokeWidth={1.5}
                            strokeOpacity={0.9}
                            label={{
                              value: `${yb.year}`,
                              position: 'top',
                              fontSize: 12,
                              fill: 'var(--text-secondary)',
                              fontWeight: 700,
                            }}
                          />
                        ))}
                        <Bar
                          yAxisId="exercise"
                          dataKey="exerciseMin"
                          fill="#ef444450"
                          radius={[3, 3, 0, 0]}
                        />
                        <Line
                          yAxisId="sleep"
                          type="monotone"
                          dataKey="sleepHours"
                          stroke="#a855f7"
                          strokeWidth={2}
                          dot={{ fill: '#a855f7', r: sleepExerciseCorr.length <= 30 ? 3 : 0 }}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                    <div
                      className="flex items-center justify-center gap-4 mt-2 text-[10px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <span className="flex items-center gap-1">
                        <span className="w-3 h-0.5" style={{ background: '#a855f7' }} /> Sleep
                        (hours)
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-sm" style={{ background: '#ef444450' }} />{' '}
                        Exercise (min)
                      </span>
                    </div>
                  </div>

                  {/* Sleep vs Steps scatter */}
                  <div className="card">
                    <div className="flex items-center gap-2 mb-4">
                      <Footprints size={14} style={{ color: 'var(--accent-blue)' }} />
                      <span
                        className="text-sm font-medium"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Sleep Duration vs Steps (Correlation)
                      </span>
                    </div>
                    <ResponsiveContainer width="100%" height={260}>
                      <ScatterChart>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" />
                        <XAxis
                          dataKey="sleepHours"
                          name="Sleep"
                          tick={{ fontSize: 10, fill: '#737373' }}
                          axisLine={false}
                          tickLine={false}
                          type="number"
                          label={{
                            value: 'Sleep (hours)',
                            position: 'insideBottom',
                            offset: -5,
                            fontSize: 10,
                            fill: '#737373',
                          }}
                        />
                        <YAxis
                          dataKey="steps"
                          name="Steps"
                          tick={{ fontSize: 10, fill: '#737373' }}
                          axisLine={false}
                          tickLine={false}
                          width={50}
                          tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
                          label={{
                            value: 'Steps',
                            angle: -90,
                            position: 'insideLeft',
                            fontSize: 10,
                            fill: '#737373',
                          }}
                        />
                        <ZAxis range={[40, 40]} />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          cursor={{ strokeDasharray: '3 3' }}
                          formatter={(value: number, name: string) => {
                            if (name === 'Sleep') return [`${value}h`, 'Sleep']
                            if (name === 'Steps') return [value.toLocaleString(), 'Steps']
                            return [value, name]
                          }}
                        />
                        <Scatter
                          data={sleepExerciseCorr.filter((d) => d.steps > 0)}
                          fill="#3b82f6"
                          fillOpacity={0.6}
                        />
                      </ScatterChart>
                    </ResponsiveContainer>
                    <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      Each dot is one day. Look for patterns: do you move more after better sleep?
                    </div>
                  </div>

                  {/* HRV vs Exercise */}
                  {sleepExerciseCorr.some((d) => d.hrv > 0) && (
                    <div className="card">
                      <div className="flex items-center gap-2 mb-4">
                        <Activity size={14} style={{ color: 'var(--accent-blue)' }} />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          HRV & Resting HR vs Exercise
                        </span>
                      </div>
                      <ResponsiveContainer width="100%" height={280}>
                        <ComposedChart
                          data={sleepExerciseCorr.filter((d) => d.hrv > 0 || d.restingHr > 0)}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--separator)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 10, fill: '#737373' }}
                            axisLine={false}
                            tickLine={false}
                            interval={xAxisInterval(sleepExerciseCorr.length)}
                          />
                          <YAxis
                            yAxisId="hrv"
                            orientation="left"
                            tick={{ fontSize: 10, fill: '#3b82f6' }}
                            axisLine={false}
                            tickLine={false}
                            width={35}
                          />
                          <YAxis
                            yAxisId="exercise"
                            orientation="right"
                            tick={{ fontSize: 10, fill: '#ef4444' }}
                            axisLine={false}
                            tickLine={false}
                            width={35}
                            tickFormatter={(v) => `${v}m`}
                          />
                          <Tooltip
                            contentStyle={tooltipStyle}
                            formatter={(value: number, name: string) => {
                              const labels: Record<string, string> = {
                                hrv: 'HRV (ms)',
                                restingHr: 'Resting HR',
                                exerciseMin: 'Exercise (min)',
                              }
                              return [
                                name === 'exerciseMin' ? `${value}m` : `${value}`,
                                labels[name] || name,
                              ]
                            }}
                          />
                          {yearBoundaries.map((yb) => (
                            <ReferenceLine
                              key={yb.year}
                              x={yb.formattedDate}
                              stroke="var(--text-secondary)"
                              strokeDasharray="4 4"
                              strokeWidth={1.5}
                              strokeOpacity={0.9}
                              label={{
                                value: `${yb.year}`,
                                position: 'top',
                                fontSize: 12,
                                fill: 'var(--text-secondary)',
                                fontWeight: 700,
                              }}
                            />
                          ))}
                          <Bar
                            yAxisId="exercise"
                            dataKey="exerciseMin"
                            fill="#ef444430"
                            radius={[3, 3, 0, 0]}
                          />
                          <Line
                            yAxisId="hrv"
                            type="monotone"
                            dataKey="hrv"
                            stroke="#3b82f6"
                            strokeWidth={2}
                            dot={{ fill: '#3b82f6', r: 2 }}
                          />
                          <Line
                            yAxisId="hrv"
                            type="monotone"
                            dataKey="restingHr"
                            stroke="#a855f7"
                            strokeWidth={1.5}
                            dot={false}
                            strokeDasharray="4 3"
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                      <div
                        className="flex items-center justify-center gap-4 mt-2 text-[10px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <span className="flex items-center gap-1">
                          <span className="w-3 h-0.5" style={{ background: '#3b82f6' }} /> HRV
                        </span>
                        <span className="flex items-center gap-1">
                          <span
                            className="w-3 h-0.5 border-t border-dashed"
                            style={{ borderColor: '#a855f7' }}
                          />{' '}
                          Resting HR
                        </span>
                        <span className="flex items-center gap-1">
                          <span
                            className="w-2 h-2 rounded-sm"
                            style={{ background: '#ef444430' }}
                          />{' '}
                          Exercise
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Insights */}
                  <div className="card">
                    <div className="flex items-center gap-2 mb-3">
                      <Zap size={14} style={{ color: 'var(--accent-amber)' }} />
                      <span
                        className="text-sm font-medium"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Sleep-Fitness Insights
                      </span>
                    </div>
                    <SleepFitnessInsights
                      data={sleepExerciseCorr}
                      sleepData={sleepData}
                      exData={exData}
                      stepsData={stepsData}
                      rhrData={rhrData}
                    />
                  </div>
                </>
              )}

              {sleepExerciseCorr.length <= 3 && (
                <div className="card">
                  <p className="text-sm py-16 text-center" style={{ color: 'var(--text-muted)' }}>
                    Need at least 4 days with both sleep and exercise data for correlation analysis.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ========== ACTIVITY LOG TAB ========== */}
          {tab === 'log' && (
            <div className="card">
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Daily Activity Log
              </span>
              <div className="mt-3">
                <TableSearchBar value={logSearch} onChange={setLogSearch} placeholder="Filter by date…" count={filteredLog.length} total={activityLogData.length} />
              </div>
              <div className="overflow-y-auto max-h-[600px]">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: 'var(--text-muted)' }}>
                      <SortHeader label="Date" sortKey="date" currentKey={logSortKey} currentDir={logSortDir} onSort={toggleLogSort} align="left" />
                      <SortHeader label="Steps" sortKey="steps" currentKey={logSortKey} currentDir={logSortDir} onSort={toggleLogSort} />
                      <SortHeader label="Calories" sortKey="calories" currentKey={logSortKey} currentDir={logSortDir} onSort={toggleLogSort} />
                      <SortHeader label="Exercise" sortKey="exercise" currentKey={logSortKey} currentDir={logSortDir} onSort={toggleLogSort} />
                      <SortHeader label="Avg HR" sortKey="hr" currentKey={logSortKey} currentDir={logSortDir} onSort={toggleLogSort} />
                      <SortHeader label="Resting HR" sortKey="rhr" currentKey={logSortKey} currentDir={logSortDir} onSort={toggleLogSort} />
                      <SortHeader label="HRV" sortKey="hrv" currentKey={logSortKey} currentDir={logSortDir} onSort={toggleLogSort} />
                      <SortHeader label="Sleep" sortKey="sleep" currentKey={logSortKey} currentDir={logSortDir} onSort={toggleLogSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLog.map((d, i) => (
                        <tr
                          key={i}
                          className="border-t"
                          style={{ borderColor: 'var(--separator)' }}
                        >
                          <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                            {format(parseISO(d.fullDate), 'EEE, MMM d')}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{
                              color:
                                d.steps >= 10000
                                  ? 'var(--accent-green)'
                                  : d.steps >= 5000
                                    ? 'var(--accent-blue)'
                                    : 'var(--text-secondary)',
                            }}
                          >
                            {d.steps > 0 ? d.steps.toLocaleString() : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{ color: 'var(--accent-orange)' }}
                          >
                            {d.calories > 0 ? d.calories.toLocaleString() : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{
                              color:
                                d.exerciseMin >= 30
                                  ? 'var(--accent-green)'
                                  : 'var(--text-secondary)',
                            }}
                          >
                            {d.exerciseMin > 0 ? `${d.exerciseMin}m` : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {d.hrAvg > 0 ? `${d.hrAvg}` : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{ color: 'var(--accent-purple)' }}
                          >
                            {d.restingHr > 0 ? `${d.restingHr}` : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{ color: 'var(--accent-blue)' }}
                          >
                            {d.hrv > 0 ? `${d.hrv}` : '—'}
                          </td>
                          <td
                            className="text-right py-2 font-mono"
                            style={{
                              color:
                                d.sleepHours >= 7
                                  ? 'var(--accent-green)'
                                  : d.sleepHours >= 5
                                    ? 'var(--accent-amber)'
                                    : d.sleepHours > 0
                                      ? 'var(--accent-red)'
                                      : 'var(--text-secondary)',
                            }}
                          >
                            {d.sleepHours > 0 ? `${d.sleepHours}h` : '—'}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SleepFitnessInsights({
  data,
  sleepData,
  exData,
  stepsData,
  rhrData,
}: {
  data: Array<{
    sleepHours: number
    exerciseMin: number
    steps: number
    hrv: number
    restingHr: number
  }>
  sleepData: Array<{ sleepHours: number }>
  exData: Array<{ exerciseMin: number }>
  stepsData: Array<{ steps: number }>
  rhrData: Array<{ restingHr: number }>
}) {
  const insights = useMemo(() => {
    const obs: string[] = []

    // Sleep vs next-day activity correlation
    if (data.length >= 7) {
      const goodSleepDays = data.filter((d) => d.sleepHours >= 7)
      const poorSleepDays = data.filter((d) => d.sleepHours < 6 && d.sleepHours > 0)

      if (goodSleepDays.length >= 3 && poorSleepDays.length >= 2) {
        const avgStepsGoodSleep = Math.round(
          goodSleepDays.reduce((s, d) => s + d.steps, 0) / goodSleepDays.length,
        )
        const avgStepsPoorSleep = Math.round(
          poorSleepDays.reduce((s, d) => s + d.steps, 0) / poorSleepDays.length,
        )
        const diff = avgStepsGoodSleep - avgStepsPoorSleep

        if (Math.abs(diff) > 500) {
          obs.push(
            `On days with 7+ hours of sleep, you average ${avgStepsGoodSleep.toLocaleString()} steps vs ${avgStepsPoorSleep.toLocaleString()} steps on <6h sleep nights (${diff > 0 ? '+' : ''}${diff.toLocaleString()} steps).`,
          )
        }

        const avgExGoodSleep = Math.round(
          goodSleepDays.reduce((s, d) => s + d.exerciseMin, 0) / goodSleepDays.length,
        )
        const avgExPoorSleep = Math.round(
          poorSleepDays.reduce((s, d) => s + d.exerciseMin, 0) / poorSleepDays.length,
        )
        if (avgExGoodSleep > avgExPoorSleep + 5) {
          obs.push(
            `Better sleep correlates with more exercise: ${avgExGoodSleep}m avg on good sleep days vs ${avgExPoorSleep}m on poor sleep days.`,
          )
        }
      }
    }

    // HRV and exercise
    const hrvDays = data.filter((d) => d.hrv > 0 && d.exerciseMin > 0)
    if (hrvDays.length >= 5) {
      const highExDays = hrvDays.filter((d) => d.exerciseMin >= 30)
      const lowExDays = hrvDays.filter((d) => d.exerciseMin < 15)
      if (highExDays.length >= 2 && lowExDays.length >= 2) {
        const avgHrvHighEx = Math.round(
          highExDays.reduce((s, d) => s + d.hrv, 0) / highExDays.length,
        )
        const avgHrvLowEx = Math.round(lowExDays.reduce((s, d) => s + d.hrv, 0) / lowExDays.length)
        obs.push(
          `HRV averages ${avgHrvHighEx}ms on active days (30+ min exercise) vs ${avgHrvLowEx}ms on rest days.`,
        )
      }
    }

    // Resting HR trend insight
    if (rhrData.length >= 7) {
      const recent = rhrData.slice(-7)
      const avgRecent = Math.round(recent.reduce((s, d) => s + d.restingHr, 0) / recent.length)
      if (avgRecent <= 55) {
        obs.push(
          `Your resting heart rate of ${avgRecent} bpm is in the athletic range. Your cardiovascular system is well-conditioned.`,
        )
      } else if (avgRecent <= 65) {
        obs.push(
          `Resting heart rate of ${avgRecent} bpm is in the good range. Regular cardio exercise can lower this further.`,
        )
      } else {
        obs.push(
          `Resting heart rate of ${avgRecent} bpm is in the average range. Consistent cardio exercise (150+ min/week) can improve this over time.`,
        )
      }
    }

    // Exercise consistency
    if (exData.length > 0 && data.length > 7) {
      const activeDays = data.filter((d) => d.exerciseMin >= 20).length
      const pct = Math.round((activeDays / data.length) * 100)
      if (pct >= 70) {
        obs.push(
          `Excellent exercise consistency: you're active (20+ min) on ${pct}% of tracked days.`,
        )
      } else if (pct >= 40) {
        obs.push(
          `Moderate exercise consistency: active on ${pct}% of days. WHO recommends 150-300 min of moderate exercise per week.`,
        )
      } else {
        obs.push(
          `Low exercise consistency: active on only ${pct}% of days. Try to build up to at least 30 min of activity on most days.`,
        )
      }
    }

    // Average sleep
    if (sleepData.length > 0) {
      const avgSleep = sleepData.reduce((s, d) => s + d.sleepHours, 0) / sleepData.length
      if (avgSleep < 6) {
        obs.push(
          `Average sleep of ${avgSleep.toFixed(1)}h is below recommended 7-9h. Sleep deprivation impairs recovery and exercise performance.`,
        )
      } else if (avgSleep >= 7 && avgSleep <= 9) {
        obs.push(
          `Average sleep of ${avgSleep.toFixed(1)}h is in the recommended 7-9h range — supporting optimal recovery.`,
        )
      }
    }

    return obs
  }, [data, sleepData, exData, stepsData, rhrData])

  if (insights.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Not enough data for insights yet.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {insights.map((obs, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <span
            className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--accent-amber)' }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>{obs}</span>
        </div>
      ))}
    </div>
  )
}
