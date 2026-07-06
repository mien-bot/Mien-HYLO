import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Heart,
  Moon,
  Activity,
  Footprints,
  Upload,
  Sparkles,
  Bot,
  Wifi,
  Clock,
  Battery,
  BedDouble,
  Sun,
  Sunset,
  Coffee,
  AlertTriangle,
  ChevronRight,
  RefreshCw,
  Zap,
  Shield,
  Smartphone,
  ShowerHead,
  BookOpen,
  Wind,
  Lightbulb,
  Bed,
} from 'lucide-react'
import SleepChart from '../components/health/SleepChart'
import HeartRateChart from '../components/health/HeartRateChart'
import MetricCard from '../components/health/MetricCard'
import HealthAlertsPanel from '../components/health/HealthAlertsPanel'
import WakePredictionCard from '../components/health/WakePredictionCard'
import { useHealthMetrics, useHealthSummary } from '../hooks/useHealthData'
import {
  ChartCard,
  CalendarHeatmap,
  GradientLegend,
  CORRELATION_LEGEND_PROPS,
  type CalendarPoint,
} from '../components/charts'
import { useSleepStageHistory, useCrossDomainCorrelations } from '../hooks/useAggregations'
import type { Briefing } from '../../shared/types/ipc.types'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { useToast } from '../components/Toast'
import NoodleIllustration from '../components/anim/NoodleIllustration'

function formatTooltipDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00')
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

interface SleepAnalysisData {
  debt: {
    currentDebt: number
    debtCategory: 'low' | 'moderate' | 'high' | 'severe'
    sleepNeedEstimate: number
    last14Nights: Array<{ date: string; slept: number; need: number; delta: number }>
  }
  circadian: {
    melatoninWindowStart: string
    melatoninWindowEnd: string
    optimalBedtime: string
    optimalWakeTime: string
    energyPhases: Array<{
      name: string
      start: string
      end: string
      level: string
      description: string
    }>
  }
  quality: {
    overall: number
    deepSleepScore: number
    remScore: number
    coreSleepScore: number
    wasoScore: number
    efficiencyScore: number
    consistencyScore: number
    cycleCompletion: number
    recommendations: string[]
  }
  lastNight: {
    date: string
    totalInBed: number
    totalAsleep: number
    deepSleep: number
    remSleep: number
    coreSleep: number
    awakeTime: number
    sleepStart: string
    sleepEnd: string
  }
  chronotype?: {
    chronotype: string
    label: string
    description: string
    peakFocus: string
    peakExercise: string
    idealWake: string
    idealSleep: string
  }
  socialJetLag?: {
    jetLagHours: number
    severity: string
    recommendation: string
  }
  caffeineCutoff?: {
    lastCaffeineTime: string
    reason: string
  }
  hrvRecovery?: {
    score: number
    status: string
    latestHrv: number
    baseline: number
    zScore: number
    recommendation: string
  }
  energyCurve?: Array<{
    hour: number
    timeLabel: string
    processS: number
    processC: number
    combined: number
  }>
}

interface WakePredictionResult {
  rangeStart: string
  rangeEnd: string
  optimalPoint: string
  confidence: 'low' | 'medium' | 'high'
  confidenceScore: number
  explanation: {
    summary: string
    sleepDebt: string
    circadianAlignment: string
    consistency: string
    inertiaRisk: string
  }
  signals: {
    sleepNeedHours: number
    sleepDebtHours: number
    inertiaRisk: 'low' | 'medium' | 'high'
    bindingFloor: 'sleep_need' | 'circadian' | 'consistency'
    cycleAlignedWakes: string[]
  }
  dataQuality: 'phone_only' | 'wearable_actigraphy' | 'full_biomarker'
}

type SleepConsistencyRange = '90d' | '6m' | '1y' | '3y' | 'all'

const SLEEP_CONSISTENCY_RANGES: Array<{
  id: SleepConsistencyRange
  label: string
  subtitle: string
  days: number
  cellSize: number
}> = [
  { id: '90d', label: '90D', subtitle: 'Last 90 nights', days: 90, cellSize: 13 },
  { id: '6m', label: '6M', subtitle: 'Last 6 months', days: 183, cellSize: 12 },
  { id: '1y', label: '1Y', subtitle: 'Last year', days: 365, cellSize: 11 },
  { id: '3y', label: '3Y', subtitle: 'Last 3 years', days: 1095, cellSize: 9 },
  { id: 'all', label: 'All', subtitle: 'All time', days: 0, cellSize: 8 },
]

function formatTimeInput(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
}

function parseTimeToMinutes(time: string): number | null {
  if (!time) return null
  const raw = time.trim()
  const ampmMatch = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (ampmMatch) {
    let hour = Number(ampmMatch[1])
    const minute = Number(ampmMatch[2])
    const meridiem = ampmMatch[3].toUpperCase()
    if (meridiem === 'PM' && hour !== 12) hour += 12
    if (meridiem === 'AM' && hour === 12) hour = 0
    return (hour * 60 + minute) % 1440
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  return (Number(match[1]) * 60 + Number(match[2])) % 1440
}

function minutesToTimeInput(minutes: number): string {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440
  const h = Math.floor(normalized / 60)
  const m = normalized % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

function formatTimeDisplay(minutes: number): string {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440
  const h24 = Math.floor(normalized / 60)
  const minute = normalized % 60
  const h12 = h24 % 12 || 12
  return `${h12}:${minute.toString().padStart(2, '0')} ${h24 >= 12 ? 'PM' : 'AM'}`
}

function flexibleTimeToInput(time: string | undefined): string {
  const minutes = parseTimeToMinutes(time || '')
  return minutes == null ? '' : minutesToTimeInput(minutes)
}

function buildSleepCyclePlan(time: string, mode: 'wake' | 'bed', latencyMin: number) {
  const base = parseTimeToMinutes(time)
  if (base == null) return []
  return [4, 5, 6].map((cycles) => {
    const sleepMinutes = cycles * 90
    const targetMinutes =
      mode === 'wake' ? base + latencyMin + sleepMinutes : base - sleepMinutes - latencyMin
    return {
      cycles,
      hours: sleepMinutes / 60,
      time: formatTimeDisplay(targetMinutes),
      isRecommended: cycles === 5,
    }
  })
}

function ScoreRing({
  score,
  label,
  color,
  size = 64,
}: {
  score: number
  label: string
  color: string
  size?: number
}) {
  const radius = (size - 8) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--separator)"
          strokeWidth="3"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <span className="text-lg font-semibold -mt-11" style={{ color: 'var(--text-primary)' }}>
        {score}
      </span>
      <span className="text-[10px] mt-4" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
    </div>
  )
}

function DebtGauge({ debt, category }: { debt: number; category: string }) {
  const colors: Record<string, string> = {
    low: 'var(--accent-green)',
    moderate: 'var(--accent-amber)',
    high: '#ff9f0a',
    severe: 'var(--accent-red)',
  }
  const color = colors[category] || 'var(--text-muted)'
  const maxDebt = 20
  const pct = Math.min(debt / maxDebt, 1) * 100

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Sleep Debt
        </span>
        <span className="text-xs font-medium capitalize" style={{ color }}>
          {category}
        </span>
      </div>
      <div
        className="w-full h-2 rounded-full overflow-hidden"
        style={{ background: 'var(--bg-tertiary)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          {debt.toFixed(1)}
          <span className="text-sm font-normal ml-1" style={{ color: 'var(--text-muted)' }}>
            hrs
          </span>
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          of {maxDebt}h max
        </span>
      </div>
    </div>
  )
}

function EnergyTimeline({ phases }: { phases: SleepAnalysisData['circadian']['energyPhases'] }) {
  const levelColors: Record<string, string> = {
    low: 'var(--text-muted)',
    rising: 'var(--accent-blue)',
    peak: 'var(--accent-green)',
    dipping: 'var(--accent-amber)',
    winding_down: 'var(--accent-purple)',
  }
  const levelIcons: Record<string, React.ReactNode> = {
    low: <Coffee size={12} />,
    rising: <Sun size={12} />,
    peak: <Sun size={12} />,
    dipping: <Sunset size={12} />,
    winding_down: <Moon size={12} />,
  }

  return (
    <div className="space-y-1.5">
      {phases.map((phase, i) => (
        <div
          key={i}
          className="flex items-start gap-3 p-2.5 rounded-lg"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          <div
            className="flex items-center gap-1.5 shrink-0 mt-0.5"
            style={{ color: levelColors[phase.level] }}
          >
            {levelIcons[phase.level]}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {phase.name}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {phase.start}–{phase.end}
              </span>
            </div>
            <p
              className="text-xs mt-0.5 leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              {phase.description}
            </p>
          </div>
          <div className="shrink-0 mt-0.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: levelColors[phase.level] }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function energyBarColor(value: number, max: number): string {
  const ratio = value / max
  if (ratio > 0.66) return 'var(--accent-green)'
  if (ratio > 0.33) return 'var(--accent-amber)'
  return 'var(--accent-red)'
}

function EnergyCurveChart({ data }: { data: NonNullable<SleepAnalysisData['energyCurve']> }) {
  const maxVal = Math.max(...data.map((d) => d.combined), 0.01)
  const chartHeight = 100

  // Show label every 4 hours
  const labelIndices = data.map((_, i) => i).filter((i) => i % 4 === 0)

  return (
    <div>
      <div className="flex items-end gap-px" style={{ height: chartHeight }}>
        {data.map((point, i) => {
          const barHeight = (point.combined / maxVal) * chartHeight
          return (
            <div
              key={i}
              className="flex-1 flex flex-col justify-end items-center"
              title={`${point.timeLabel}: ${(point.combined * 100).toFixed(0)}%`}
            >
              <div
                className="w-full rounded-sm transition-all duration-300"
                style={{
                  height: barHeight,
                  minHeight: 2,
                  background: energyBarColor(point.combined, maxVal),
                }}
              />
            </div>
          )
        })}
      </div>
      <div className="flex mt-1.5">
        {data.map((point, i) => (
          <div key={i} className="flex-1 text-center">
            {labelIndices.includes(i) && (
              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                {point.timeLabel}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-4 mt-2">
        {[
          { color: 'var(--accent-green)', label: 'High' },
          { color: 'var(--accent-amber)', label: 'Medium' },
          { color: 'var(--accent-red)', label: 'Low' },
        ].map(({ color, label }) => (
          <span
            key={label}
            className="flex items-center gap-1.5 text-[10px]"
            style={{ color: 'var(--text-muted)' }}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

// HRV (RMSSD) norms — Nunan et al. 2010; Shaffer & Ginsberg 2017
function healthPageHrvNorms(age: number | null) {
  if (!age) return { ageGroup: 'Adults', avg: 55, sd: 18 }
  if (age < 20) return { ageGroup: '14-19', avg: 72, sd: 22 }
  if (age < 30) return { ageGroup: '20-29', avg: 65, sd: 20 }
  if (age < 40) return { ageGroup: '30-39', avg: 55, sd: 18 }
  if (age < 50) return { ageGroup: '40-49', avg: 45, sd: 16 }
  if (age < 60) return { ageGroup: '50-59', avg: 35, sd: 14 }
  return { ageGroup: '60+', avg: 27, sd: 11 }
}

function hpPctRank(you: number, mean: number, sd: number): number {
  if (sd <= 0) return 50
  const z = (you - mean) / sd
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const phi = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly
  return Math.round((z >= 0 ? phi : 1 - phi) * 100)
}

export default function HealthPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const {
    metrics: sleepMetrics,
    loading: sleepLoading,
    refresh: refreshSleep,
  } = useHealthMetrics('sleep', 7)
  const {
    metrics: hrMetrics,
    loading: hrLoading,
    refresh: refreshHR,
  } = useHealthMetrics('heart_rate', 7)
  const { metrics: hrvMetrics, loading: hrvLoading } = useHealthMetrics('hrv', 7)
  const { metrics: stepsMetrics, loading: stepsLoading } = useHealthMetrics('steps', 7)
  const { summary, refresh: refreshSummary } = useHealthSummary()
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [generatingBriefing, setGeneratingBriefing] = useState(false)
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const [sleepAnalysis, setSleepAnalysis] = useState<SleepAnalysisData | null>(null)
  const [sleepAnalysisLoading, setSleepAnalysisLoading] = useState(true)
  const [wakeCalcBedtime, setWakeCalcBedtime] = useState('')
  const [wakeResult, setWakeResult] = useState<{
    optimalWakeTime: string
    alternativeWakeTimes: string[]
    reasoning: string
  } | null>(null)
  const [personalizedWakeResult, setPersonalizedWakeResult] = useState<WakePredictionResult | null>(
    null,
  )
  const [personalizedNowWake, setPersonalizedNowWake] = useState<WakePredictionResult | null>(null)
  const [wakeCalcLoading, setWakeCalcLoading] = useState(false)
  const [bedCalcWakeTime, setBedCalcWakeTime] = useState('')
  const [bedResult, setBedResult] = useState<{
    optimalWakeTime: string
    alternativeWakeTimes: string[]
    reasoning: string
  } | null>(null)
  const [calcMode, setCalcMode] = useState<'wake' | 'bed'>('wake')
  const [sleepLatency, setSleepLatency] = useState(15)
  const [recoveryData, setRecoveryData] = useState<any>(null)
  const [regularity, setRegularity] = useState<any>(null)
  const [morningSleepBriefing, setMorningSleepBriefing] = useState<Briefing | null>(null)
  const [refreshingSleepReport, setRefreshingSleepReport] = useState(false)
  const [windDownRoutine, setWindDownRoutine] = useState<any>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [sleepConsistencyRange, setSleepConsistencyRange] = useState<SleepConsistencyRange>('90d')
  const sleepConsistencyConfig =
    SLEEP_CONSISTENCY_RANGES.find((r) => r.id === sleepConsistencyRange) ||
    SLEEP_CONSISTENCY_RANGES[0]

  // Visualization aggregations — manual-refresh model (PR 5)
  const stageHistoryQ = useSleepStageHistory(sleepConsistencyConfig.days)
  const correlationsQ = useCrossDomainCorrelations(60)

  const loadExtraAnalysis = useCallback(async () => {
    try {
      const [recovery, reg, mornBriefing, routine] = await Promise.all([
        window.api.getRecoveryReadiness(),
        window.api.getSleepRegularity(),
        window.api.getLatestBriefing('morning_sleep'),
        window.api.getWindDownRoutine(),
      ])
      setRecoveryData(recovery)
      setRegularity(reg)
      setMorningSleepBriefing(mornBriefing)
      setWindDownRoutine(routine)
    } catch {}
  }, [])

  const [userAge, setUserAge] = useState<number | null>(null)

  useEffect(() => {
    window.api.getSettings('appSettings').then((val: any) => {
      const age = val?.userAge ? parseInt(val.userAge) : null
      if (age && age > 0 && age < 120) setUserAge(age)
    })
    window.api
      .getLatestBriefing('health_weekly')
      .then(setBriefing)
      .catch((err: any) => showToast(err.message || 'Failed to load health briefing', 'error'))
    loadSleepAnalysis()
    loadExtraAnalysis()
  }, [loadExtraAnalysis])

  // Auto-refresh when new sleep data arrives
  useEffect(() => {
    const unsub = window.api.onSleepDataArrived(() => {
      refreshSleep()
      refreshHR()
      loadSleepAnalysis()
      loadExtraAnalysis()
    })
    return unsub
  }, [refreshSleep, refreshHR, loadExtraAnalysis])

  const loadSleepAnalysis = async () => {
    if (!sleepAnalysis) setSleepAnalysisLoading(true)
    try {
      const data = await window.api.getSleepAnalysis()
      setSleepAnalysis(data)
      if (data?.circadian?.optimalBedtime) {
        setWakeCalcBedtime(data.circadian.optimalBedtime)
      }
    } catch (err) {
      console.error('Failed to load sleep analysis:', err)
    }
    setSleepAnalysisLoading(false)
  }

  const handleImport = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.csv'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      setImportStatus('Importing...')
      try {
        const filePath = window.api.getPathForFile(file)
        if (filePath) {
          const count = await window.api.importHealthFile(filePath)
          setImportStatus(`Imported ${count} metrics`)
          refreshSleep()
          refreshHR()
          refreshSummary()
          loadSleepAnalysis()
        } else {
          setImportStatus('File path not available')
        }
      } catch (err: any) {
        setImportStatus(`Error: ${err.message}`)
      }
      setTimeout(() => setImportStatus(null), 3000)
    }
    input.click()
  }

  const handleGenerateInsights = async () => {
    setGeneratingBriefing(true)
    try {
      await window.api.generateBriefing('health_weekly')
      const latest = await window.api.getLatestBriefing('health_weekly')
      setBriefing(latest)
    } catch (err) {
      console.error('Failed to generate health insights:', err)
    }
    setGeneratingBriefing(false)
  }

  const handleRefreshSleepReport = async () => {
    setRefreshingSleepReport(true)
    try {
      await window.api.generateBriefing('morning_sleep')
      const latest = await window.api.getLatestBriefing('morning_sleep')
      setMorningSleepBriefing(latest)
    } catch (err: any) {
      showToast(err?.message || 'Failed to refresh sleep report', 'error')
    }
    setRefreshingSleepReport(false)
  }

  const handleWakeCalc = async () => {
    if (!wakeCalcBedtime) return
    setWakeCalcLoading(true)
    setPersonalizedWakeResult(null)
    try {
      const personalized = (await window.api.predictWakeTime({
        plannedBedtime: wakeCalcBedtime,
        sleepLatencyMinutes: sleepLatency,
      })) as WakePredictionResult | null
      if (personalized) {
        setPersonalizedWakeResult(personalized)
        setWakeResult({
          optimalWakeTime: personalized.optimalPoint,
          alternativeWakeTimes: [personalized.rangeStart, personalized.rangeEnd],
          reasoning: personalized.explanation.summary,
        })
      } else {
        const result = await window.api.getWakeRecommendation(wakeCalcBedtime, sleepLatency)
        setWakeResult(result)
      }
    } catch (err) {
      console.error('Wake recommendation error:', err)
      try {
        const result = await window.api.getWakeRecommendation(wakeCalcBedtime, sleepLatency)
        setWakeResult(result)
      } catch {}
    } finally {
      setWakeCalcLoading(false)
    }
  }

  const handleBedCalc = async () => {
    if (!bedCalcWakeTime) return
    try {
      const result = await window.api.getBedtimeRecommendation(bedCalcWakeTime, sleepLatency)
      setBedResult(result)
    } catch (err) {
      console.error('Bedtime recommendation error:', err)
    }
  }

  const calcPlan = useMemo(
    () =>
      buildSleepCyclePlan(
        calcMode === 'wake' ? wakeCalcBedtime : bedCalcWakeTime,
        calcMode,
        sleepLatency,
      ),
    [calcMode, wakeCalcBedtime, bedCalcWakeTime, sleepLatency],
  )
  const nowPlan = useMemo(
    () => buildSleepCyclePlan(formatTimeInput(new Date()), 'wake', sleepLatency),
    [sleepLatency],
  )
  const recommendedNow = nowPlan.find((p) => p.isRecommended)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = (await window.api.predictWakeTime({
          plannedBedtime: formatTimeInput(new Date()),
          sleepLatencyMinutes: sleepLatency,
        })) as WakePredictionResult | null
        if (!cancelled) setPersonalizedNowWake(result)
      } catch {
        if (!cancelled) setPersonalizedNowWake(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sleepLatency])

  const totalMetrics = Object.values(summary).reduce((a, b) => a + b, 0)
  const sa = sleepAnalysis

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Health & Sleep
        </h2>
        <div className="flex items-center gap-2">
          {importStatus && (
            <span className="text-xs px-2 py-1 rounded" style={{ color: 'var(--accent-green)' }}>
              {importStatus}
            </span>
          )}
          <button
            onClick={async () => {
              setRefreshing(true)
              await Promise.all([
                refreshSleep(),
                refreshHR(),
                loadSleepAnalysis(),
                loadExtraAnalysis(),
              ])
              setRefreshing(false)
            }}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            title="Refresh all data"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleImport}
            className="flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-purple)' }}
          >
            <Upload size={14} />
            Import
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div
        className="flex items-center gap-4 px-4 py-2.5 rounded-lg text-xs"
        style={{ background: 'var(--bg-card)' }}
      >
        <div className="flex items-center gap-1.5" style={{ color: 'var(--accent-green)' }}>
          <Wifi size={12} />
          <span>Health server active</span>
        </div>
        <span style={{ color: 'var(--separator)' }}>|</span>
        <span style={{ color: 'var(--text-secondary)' }}>{totalMetrics} data points</span>
        {sa && (
          <>
            <span style={{ color: 'var(--separator)' }}>|</span>
            <span style={{ color: 'var(--accent-purple)' }}>
              Sleep need: {sa.debt.sleepNeedEstimate}h/night
            </span>
          </>
        )}
      </div>

      {/* New PR 5 visualization row — consistency heatmap + cross-domain correlations */}
      <div className="grid grid-cols-3 gap-4">
        <ChartCard
          title="Sleep Consistency"
          subtitle={`${sleepConsistencyConfig.subtitle} - hours asleep`}
          lastUpdated={stageHistoryQ.lastUpdated}
          loading={stageHistoryQ.loading}
          onRefresh={stageHistoryQ.refresh}
          className="col-span-2"
        >
          <div className="flex flex-wrap gap-1.5 mb-3">
            {SLEEP_CONSISTENCY_RANGES.map((range) => (
              <button
                key={range.id}
                onClick={() => setSleepConsistencyRange(range.id)}
                className="text-[10px] px-2 py-1 rounded-md font-semibold transition-colors"
                style={{
                  background:
                    sleepConsistencyRange === range.id
                      ? 'var(--accent-blue)'
                      : 'var(--bg-tertiary)',
                  color: sleepConsistencyRange === range.id ? 'white' : 'var(--text-muted)',
                }}
              >
                {range.label}
              </button>
            ))}
          </div>
          {(
            stageHistoryQ.data as Array<{
              date: string
              asleepHours: number
              deepPct: number
              remPct: number
            }> | null
          )?.length ? (
            <div className="overflow-x-auto overflow-y-hidden pb-1">
              <CalendarHeatmap
                data={(
                  (stageHistoryQ.data as Array<{ date: string; asleepHours: number }>) || []
                ).map(
                  (d): CalendarPoint => ({
                    date: d.date,
                    value: d.asleepHours,
                    tooltip: `${formatTooltipDate(d.date)}: ${d.asleepHours.toFixed(1)}h`,
                  }),
                )}
                cellSize={sleepConsistencyConfig.cellSize}
                colorRamp={[
                  '#7f1d1d',
                  '#dc2626',
                  '#f59e0b',
                  '#64748b',
                  '#3b82f6',
                  '#1d4ed8',
                  '#7c3aed',
                ]}
                valueRange={[4, 9]}
                valueScale="sleep-hours"
                startWeekOn={1}
                collapseEmptyWeeks={sleepConsistencyRange === 'all'}
                showLegend
                legendLessLabel="≤4h"
                legendMoreLabel="9h+"
                legendValueLabel="5 / 6 / 7 / 8h"
                legendSwatchLabels={[
                  '≤4h (poor)',
                  '4–5h',
                  '5–6h (below target)',
                  '6–7h (adequate)',
                  '7–8h (good)',
                  '8–9h (ideal)',
                  '9h+ (plenty)',
                ]}
              />
            </div>
          ) : (
            <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              Need at least a week of sleep imports to populate.
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Cross-Domain Ties"
          subtitle="Pearson r · last 60 days"
          lastUpdated={correlationsQ.lastUpdated}
          loading={correlationsQ.loading}
          onRefresh={correlationsQ.refresh}
        >
          {(() => {
            const data = correlationsQ.data as {
              pairs?: Array<{ a: string; b: string; r: number; n: number; sig: boolean }>
            } | null
            const pairs = (data?.pairs || []).filter((p) => p.sig)
            const allPairs = data?.pairs || []
            if (allPairs.length === 0) {
              return (
                <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                  Building correlations across sleep + portfolio + training. Needs 30+ days of
                  overlap.
                </div>
              )
            }
            if (pairs.length === 0) {
              return (
                <div className="text-xs py-4 px-2" style={{ color: 'var(--text-muted)' }}>
                  Not enough data yet — none of the {allPairs.length} cross-domain pairs has 30+
                  days of overlap.
                </div>
              )
            }
            return (
              <>
                <div className="max-h-44 overflow-y-auto pr-1 space-y-2">
                  {pairs.map((p) => {
                    const r = Math.max(-1, Math.min(1, p.r))
                    const inverseWidth = r < 0 ? `${Math.abs(r) * 50}%` : '0%'
                    const correlatedWidth = r > 0 ? `${r * 50}%` : '0%'
                    const valueLabel = `${r >= 0 ? '+' : ''}${r.toFixed(2)}`

                    return (
                      <div
                        key={`${p.a}-${p.b}`}
                        className="grid grid-cols-[minmax(5.5rem,7rem)_1fr_2.5rem] items-center gap-2 text-[10px]"
                        title={`${p.a} x ${p.b}: r=${p.r.toFixed(2)} (n=${p.n})`}
                      >
                        <span className="truncate" style={{ color: 'var(--text-muted)' }}>
                          {shortLabel(p.a)} x {shortLabel(p.b)}
                        </span>
                        <div
                          className="relative h-4 rounded-sm overflow-hidden"
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          <div
                            className="absolute right-1/2 top-0 h-full"
                            style={{ width: inverseWidth, background: '#ff453a99' }}
                          />
                          <div
                            className="absolute left-1/2 top-0 h-full"
                            style={{ width: correlatedWidth, background: '#30d15899' }}
                          />
                          <div
                            className="absolute top-0 bottom-0 left-1/2 w-px"
                            style={{ background: 'var(--border)' }}
                          />
                        </div>
                        <span
                          className="font-mono tabular-nums text-right"
                          style={{
                            color:
                              r > 0.05
                                ? 'var(--accent-green)'
                                : r < -0.05
                                  ? 'var(--accent-red)'
                                  : 'var(--text-muted)',
                          }}
                        >
                          {valueLabel}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <GradientLegend {...CORRELATION_LEGEND_PROPS} />
              </>
            )
          })()}
        </ChartCard>
      </div>

      {/* Sleep Analysis */}
      {sa && (
        <>
          <div className="grid grid-cols-3 gap-4">
            {/* Quality Score */}
            <div className="card">
              <div className="flex items-center gap-2 mb-4">
                <Moon size={16} style={{ color: 'var(--accent-purple)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Sleep Quality {sa.lastNight.date ? `(${sa.lastNight.date})` : ''}
                </span>
              </div>
              <div className="flex items-center justify-around">
                <ScoreRing
                  score={sa.quality.overall}
                  label="Overall"
                  color="var(--accent-purple)"
                  size={72}
                />
                <div className="space-y-2">
                  <ScoreRing
                    score={sa.quality.deepSleepScore}
                    label="Deep"
                    color="#6366f1"
                    size={52}
                  />
                  <ScoreRing score={sa.quality.remScore} label="REM" color="#8b5cf6" size={52} />
                </div>
                <div className="space-y-2">
                  <ScoreRing
                    score={sa.quality.coreSleepScore ?? 0}
                    label="Core"
                    color="#818cf8"
                    size={52}
                  />
                  <ScoreRing
                    score={sa.quality.wasoScore ?? 0}
                    label="WASO"
                    color="#7dd3fc"
                    size={52}
                  />
                </div>
                <div className="space-y-2">
                  <ScoreRing
                    score={sa.quality.efficiencyScore}
                    label="Effic."
                    color="#a78bfa"
                    size={52}
                  />
                  <ScoreRing
                    score={sa.quality.consistencyScore}
                    label="Consist."
                    color="#c4b5fd"
                    size={52}
                  />
                </div>
              </div>
              <div className="mt-3 text-center">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  ~{sa.quality.cycleCompletion} sleep cycles completed
                </span>
              </div>
            </div>

            {/* Sleep Debt */}
            <div className="card">
              <div className="flex items-center gap-2 mb-4">
                <Battery size={16} style={{ color: 'var(--accent-amber)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Sleep Debt (14-Night)
                </span>
              </div>
              <DebtGauge debt={sa.debt.currentDebt} category={sa.debt.debtCategory} />
              <div className="mt-3 space-y-1">
                {sa.debt.last14Nights.slice(0, 4).map((n, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>{n.date}</span>
                    <span
                      style={{ color: n.delta >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
                    >
                      {n.slept}h ({n.delta >= 0 ? '+' : ''}
                      {n.delta}h)
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Sleep Stages */}
            <div
              className="card cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => navigate('/health/sleep')}
            >
              <div className="flex items-center gap-2 mb-4">
                <BedDouble size={16} style={{ color: 'var(--accent-blue)' }} />
                <span
                  className="text-sm font-medium flex-1"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Sleep Stages
                </span>
                <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
              </div>
              {sa.lastNight.totalAsleep > 0 ? (
                <div>
                  <div className="flex h-5 rounded-full overflow-hidden mb-3">
                    {sa.lastNight.deepSleep > 0 && (
                      <div
                        style={{
                          width: `${(sa.lastNight.deepSleep / sa.lastNight.totalAsleep) * 100}%`,
                          background: '#6366f1',
                        }}
                        title={`Deep: ${sa.lastNight.deepSleep} min`}
                      />
                    )}
                    {sa.lastNight.coreSleep > 0 && (
                      <div
                        style={{
                          width: `${(sa.lastNight.coreSleep / sa.lastNight.totalAsleep) * 100}%`,
                          background: '#818cf8',
                        }}
                        title={`Core: ${sa.lastNight.coreSleep} min`}
                      />
                    )}
                    {sa.lastNight.remSleep > 0 && (
                      <div
                        style={{
                          width: `${(sa.lastNight.remSleep / sa.lastNight.totalAsleep) * 100}%`,
                          background: '#a78bfa',
                        }}
                        title={`REM: ${sa.lastNight.remSleep} min`}
                      />
                    )}
                    {sa.lastNight.awakeTime > 0 && (
                      <div
                        style={{
                          width: `${(sa.lastNight.awakeTime / (sa.lastNight.totalInBed || sa.lastNight.totalAsleep + sa.lastNight.awakeTime)) * 100}%`,
                          background: 'var(--bg-tertiary)',
                        }}
                        title={`Awake: ${sa.lastNight.awakeTime} min`}
                      />
                    )}
                  </div>
                  <div className="space-y-2 text-xs">
                    {[
                      { color: '#6366f1', label: 'Deep', mins: sa.lastNight.deepSleep },
                      { color: '#818cf8', label: 'Core', mins: sa.lastNight.coreSleep },
                      { color: '#a78bfa', label: 'REM', mins: sa.lastNight.remSleep },
                      { color: 'var(--bg-tertiary)', label: 'Awake', mins: sa.lastNight.awakeTime },
                    ].map(({ color, label, mins }) => (
                      <div key={label} className="flex justify-between items-center">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
                          <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                        </span>
                        <span style={{ color: 'var(--text-primary)' }}>
                          {mins} min{' '}
                          {label !== 'Awake' &&
                            `(${((mins / sa.lastNight.totalAsleep) * 100).toFixed(0)}%)`}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div
                    className="mt-3 pt-2 border-t text-xs"
                    style={{ borderColor: 'var(--separator)' }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>
                      Total: {(sa.lastNight.totalAsleep / 60).toFixed(1)}h
                      {sa.lastNight.sleepStart &&
                        (() => {
                          const fmt = (s: string) => {
                            try {
                              const dt = new Date(s)
                              return isNaN(dt.getTime())
                                ? s.substring(0, 5)
                                : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            } catch {
                              return s.substring(0, 5)
                            }
                          }
                          return ` | ${fmt(sa.lastNight.sleepStart)} – ${fmt(sa.lastNight.sleepEnd)}`
                        })()}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  No stage data for last night
                </p>
              )}
            </div>
          </div>

          {/* Energy Curve Chart */}
          {sa.energyCurve && sa.energyCurve.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={16} style={{ color: 'var(--accent-amber)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Energy Prediction
                </span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                  Two-Process Model
                </span>
              </div>
              <EnergyCurveChart data={sa.energyCurve} />
            </div>
          )}

          {/* Optimal Schedule */}
          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <Clock size={16} style={{ color: 'var(--accent-cyan, var(--accent-blue))' }} />
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Today's Optimal Schedule
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <Sun size={12} style={{ color: 'var(--accent-amber)' }} />
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Wake Up
                  </span>
                </div>
                <p className="text-lg font-semibold" style={{ color: 'var(--accent-green)' }}>
                  {sa.circadian.optimalWakeTime}
                </p>
              </div>
              {sa.caffeineCutoff && (
                <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Coffee size={12} style={{ color: 'var(--accent-amber)' }} />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Last Caffeine
                    </span>
                  </div>
                  <p className="text-lg font-semibold" style={{ color: 'var(--accent-amber)' }}>
                    {sa.caffeineCutoff.lastCaffeineTime}
                  </p>
                </div>
              )}
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <Moon size={12} style={{ color: 'var(--accent-purple)' }} />
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Melatonin Window
                  </span>
                </div>
                <p className="text-lg font-semibold" style={{ color: 'var(--accent-purple)' }}>
                  {sa.circadian.melatoninWindowStart}
                </p>
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <BedDouble size={12} style={{ color: 'var(--accent-blue)' }} />
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Bedtime
                  </span>
                </div>
                <p className="text-lg font-semibold" style={{ color: 'var(--accent-purple)' }}>
                  {sa.circadian.optimalBedtime}
                </p>
              </div>
              {sa.chronotype?.peakFocus && (
                <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Sparkles size={12} style={{ color: 'var(--accent-green)' }} />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Peak Focus
                    </span>
                  </div>
                  <p className="text-lg font-semibold" style={{ color: 'var(--accent-green)' }}>
                    {sa.chronotype.peakFocus}
                  </p>
                </div>
              )}
              {sa.chronotype?.peakExercise && (
                <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Activity size={12} style={{ color: 'var(--accent-red)' }} />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Best Exercise
                    </span>
                  </div>
                  <p className="text-lg font-semibold" style={{ color: 'var(--accent-red)' }}>
                    {sa.chronotype.peakExercise}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Personalized Wake Prediction */}
          <WakePredictionCard />

          {/* Circadian Phases + Wake Calculator */}
          <div className="grid grid-cols-2 gap-4">
            <div className="card">
              <div className="flex items-center gap-2 mb-1">
                <Sun size={16} style={{ color: 'var(--accent-amber)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Daily Energy Phases
                </span>
              </div>
              <div
                className="flex items-center gap-4 mb-3 text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                <span>
                  Melatonin window: {sa.circadian.melatoninWindowStart}–
                  {sa.circadian.melatoninWindowEnd}
                </span>
              </div>
              <EnergyTimeline phases={sa.circadian.energyPhases} />
            </div>

            <div className="card">
              <div className="flex items-center gap-2 mb-3">
                <Clock size={16} style={{ color: 'var(--accent-green)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Sleep Calculator
                </span>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-2">
                  <button
                    onClick={() => setCalcMode('wake')}
                    className="text-xs px-2.5 py-1 rounded-md transition-colors"
                    style={{
                      background:
                        calcMode === 'wake' ? 'var(--accent-green)' : 'var(--bg-tertiary)',
                      color: calcMode === 'wake' ? 'white' : 'var(--text-muted)',
                    }}
                  >
                    Wake Calculator
                  </button>
                  <button
                    onClick={() => setCalcMode('bed')}
                    className="text-xs px-2.5 py-1 rounded-md transition-colors"
                    style={{
                      background:
                        calcMode === 'bed' ? 'var(--accent-purple)' : 'var(--bg-tertiary)',
                      color: calcMode === 'bed' ? 'white' : 'var(--text-muted)',
                    }}
                  >
                    Bedtime Calculator
                  </button>
                </div>

                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Time to fall asleep
                  </span>
                  {[5, 15, 30, 45].map((min) => (
                    <button
                      key={min}
                      type="button"
                      onClick={() => {
                        setSleepLatency(min)
                        setPersonalizedWakeResult(null)
                        setWakeResult(null)
                      }}
                      className="text-xs px-2 py-1 rounded-md transition-colors"
                      style={{
                        background: sleepLatency === min ? 'var(--bg-tertiary)' : 'transparent',
                        color: sleepLatency === min ? 'var(--accent-blue)' : 'var(--text-muted)',
                        border: '1px solid var(--separator)',
                      }}
                    >
                      {min}m
                    </button>
                  ))}
                </div>

                {calcMode === 'wake' ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        Bed at
                      </label>
                      <input
                        type="time"
                        value={wakeCalcBedtime}
                        onChange={(e) => {
                          setWakeCalcBedtime(e.target.value)
                          setPersonalizedWakeResult(null)
                          setWakeResult(null)
                        }}
                        className="px-2 py-1 rounded-md text-sm outline-none"
                        style={{
                          background: 'var(--bg-tertiary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--separator)',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setWakeCalcBedtime(formatTimeInput(new Date()))
                          setPersonalizedWakeResult(null)
                          setWakeResult(null)
                        }}
                        className="text-xs px-2.5 py-1.5 rounded-lg transition-colors"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
                      >
                        Now
                      </button>
                      {sa.circadian?.optimalBedtime && (
                        <button
                          type="button"
                          onClick={() => {
                            setWakeCalcBedtime(flexibleTimeToInput(sa.circadian.optimalBedtime))
                            setPersonalizedWakeResult(null)
                            setWakeResult(null)
                          }}
                          className="text-xs px-2.5 py-1.5 rounded-lg transition-colors"
                          style={{
                            background: 'var(--bg-tertiary)',
                            color: 'var(--accent-purple)',
                          }}
                        >
                          Optimal bed
                        </button>
                      )}
                      <button
                        onClick={handleWakeCalc}
                        disabled={wakeCalcLoading}
                        className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-green)' }}
                      >
                        {wakeCalcLoading ? 'Estimating...' : 'AI Estimate'}
                      </button>
                    </div>
                    {wakeResult && (
                      <div
                        className="mt-2 p-2.5 rounded-lg text-xs"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span style={{ color: 'var(--text-muted)' }}>
                            {personalizedWakeResult ? 'Personalized:' : 'Optimal:'}
                          </span>
                          <span className="font-semibold" style={{ color: 'var(--accent-green)' }}>
                            {wakeResult.optimalWakeTime}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>Alt:</span>
                          {wakeResult.alternativeWakeTimes.map((t, i) => (
                            <span key={i} style={{ color: 'var(--text-secondary)' }}>
                              {t}
                            </span>
                          ))}
                        </div>
                        {personalizedWakeResult && (
                          <div className="flex flex-wrap gap-1.5 mb-1 text-[10px]">
                            <span
                              className="px-1.5 py-0.5 rounded"
                              style={{
                                background: 'rgba(34,197,94,0.12)',
                                color: 'var(--accent-green)',
                              }}
                            >
                              {personalizedWakeResult.confidence} confidence
                            </span>
                            <span
                              className="px-1.5 py-0.5 rounded"
                              style={{
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-muted)',
                              }}
                            >
                              {personalizedWakeResult.signals.bindingFloor.replace('_', ' ')}{' '}
                              limited
                            </span>
                            <span
                              className="px-1.5 py-0.5 rounded"
                              style={{
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-muted)',
                              }}
                            >
                              inertia {personalizedWakeResult.signals.inertiaRisk}
                            </span>
                          </div>
                        )}
                        <p className="leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {wakeResult.reasoning}
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        Wake at
                      </label>
                      <input
                        type="time"
                        value={bedCalcWakeTime}
                        onChange={(e) => setBedCalcWakeTime(e.target.value)}
                        className="px-2 py-1 rounded-md text-sm outline-none"
                        style={{
                          background: 'var(--bg-tertiary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--separator)',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setBedCalcWakeTime(formatTimeInput(new Date()))}
                        className="text-xs px-2.5 py-1.5 rounded-lg transition-colors"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
                      >
                        Now
                      </button>
                      {sa.circadian?.optimalWakeTime && (
                        <button
                          type="button"
                          onClick={() =>
                            setBedCalcWakeTime(flexibleTimeToInput(sa.circadian.optimalWakeTime))
                          }
                          className="text-xs px-2.5 py-1.5 rounded-lg transition-colors"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-green)' }}
                        >
                          Optimal wake
                        </button>
                      )}
                      <button
                        onClick={handleBedCalc}
                        className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-purple)' }}
                      >
                        Calculate
                      </button>
                    </div>
                    {bedResult && (
                      <div
                        className="mt-2 p-2.5 rounded-lg text-xs"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span style={{ color: 'var(--text-muted)' }}>Optimal bedtime:</span>
                          <span className="font-semibold" style={{ color: 'var(--accent-purple)' }}>
                            {bedResult.optimalWakeTime}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>Alt:</span>
                          {bedResult.alternativeWakeTimes.map((t, i) => (
                            <span key={i} style={{ color: 'var(--text-secondary)' }}>
                              {t}
                            </span>
                          ))}
                        </div>
                        <p className="leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {bedResult.reasoning}
                        </p>
                      </div>
                    )}
                  </>
                )}

                {calcPlan.length > 0 && (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {calcPlan.map((plan) => (
                      <button
                        key={plan.cycles}
                        type="button"
                        onClick={() => {
                          setPersonalizedWakeResult(null)
                          if (calcMode === 'wake')
                            setWakeResult({
                              optimalWakeTime: plan.time,
                              alternativeWakeTimes: calcPlan
                                .filter((p) => p.cycles !== plan.cycles)
                                .map((p) => p.time),
                              reasoning: `${plan.cycles} sleep cycles gives about ${plan.hours.toFixed(1)} hours asleep after ${sleepLatency} minutes to fall asleep.`,
                            })
                          else
                            setBedResult({
                              optimalWakeTime: plan.time,
                              alternativeWakeTimes: calcPlan
                                .filter((p) => p.cycles !== plan.cycles)
                                .map((p) => p.time),
                              reasoning: `${plan.cycles} sleep cycles gives about ${plan.hours.toFixed(1)} hours asleep with ${sleepLatency} minutes to fall asleep.`,
                            })
                        }}
                        className="rounded-lg px-2 py-2 text-left transition-colors"
                        style={{
                          background: plan.isRecommended
                            ? 'rgba(34,197,94,0.12)'
                            : 'var(--bg-tertiary)',
                          border: `1px solid ${plan.isRecommended ? 'var(--accent-green)' : 'var(--separator)'}`,
                        }}
                      >
                        <div
                          className="text-[10px]"
                          style={{
                            color: plan.isRecommended ? 'var(--accent-green)' : 'var(--text-muted)',
                          }}
                        >
                          {plan.cycles} cycles · {plan.hours.toFixed(1)}h
                        </div>
                        <div
                          className="text-sm font-semibold mt-0.5"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {plan.time}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {recommendedNow && (
                  <div
                    className="mt-3 flex items-center justify-between rounded-lg px-3 py-2 text-xs"
                    style={{ background: 'var(--bg-tertiary)' }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>If you go to bed now</span>
                    <span className="font-semibold" style={{ color: 'var(--accent-green)' }}>
                      wake around {personalizedNowWake?.optimalPoint || recommendedNow.time}
                    </span>
                  </div>
                )}
                {personalizedNowWake && (
                  <p
                    className="mt-1 text-[10px] leading-relaxed"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Personalized by sleep debt, body-clock timing, regularity, and inertia risk.
                    Cycle fallback: {recommendedNow?.time}.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Sleep Intelligence */}
          <div className="grid grid-cols-2 gap-4">
            {/* Chronotype */}
            {sa.chronotype && (
              <div className="card">
                <div className="flex items-center gap-2 mb-3">
                  <Sun size={16} style={{ color: 'var(--accent-purple)' }} />
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    Chronotype
                  </span>
                </div>
                <p className="text-lg font-semibold mb-1" style={{ color: 'var(--accent-purple)' }}>
                  {sa.chronotype.label}
                </p>
                <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                  {sa.chronotype.description}
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Peak Focus</span>
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {sa.chronotype.peakFocus}
                    </p>
                  </div>
                  <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Best Exercise</span>
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {sa.chronotype.peakExercise}
                    </p>
                  </div>
                  <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Ideal Wake</span>
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {sa.chronotype.idealWake}
                    </p>
                  </div>
                  <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Ideal Sleep</span>
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {sa.chronotype.idealSleep}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Social Jet Lag + Caffeine */}
            <div className="card">
              {sa.socialJetLag && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Sunset size={16} style={{ color: 'var(--accent-amber)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Social Jet Lag
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full`}
                      style={{
                        background:
                          sa.socialJetLag.severity === 'none'
                            ? 'var(--accent-green)'
                            : sa.socialJetLag.severity === 'mild'
                              ? 'var(--accent-amber)'
                              : 'var(--accent-red)',
                        color: 'white',
                        opacity: 0.9,
                      }}
                    >
                      {sa.socialJetLag.jetLagHours}h — {sa.socialJetLag.severity}
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {sa.socialJetLag.recommendation}
                  </p>
                </div>
              )}
              {sa.caffeineCutoff && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Coffee size={16} style={{ color: 'var(--accent-amber)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Caffeine Cutoff
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <p className="text-xl font-semibold" style={{ color: 'var(--accent-amber)' }}>
                      {sa.caffeineCutoff.lastCaffeineTime}
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      {sa.caffeineCutoff.reason}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* HRV Recovery */}
          {sa.hrvRecovery && (
            <div
              className="card cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => navigate('/health/hrv')}
            >
              <div className="flex items-center gap-2 mb-3">
                <Heart
                  size={16}
                  style={{
                    color:
                      sa.hrvRecovery.score >= 70
                        ? 'var(--accent-green)'
                        : sa.hrvRecovery.score >= 50
                          ? 'var(--accent-amber)'
                          : 'var(--accent-red)',
                  }}
                />
                <span
                  className="text-sm font-medium flex-1"
                  style={{ color: 'var(--text-primary)' }}
                >
                  HRV Recovery
                </span>
                <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{
                    background:
                      sa.hrvRecovery.score >= 70
                        ? 'var(--accent-green)'
                        : sa.hrvRecovery.score >= 50
                          ? 'var(--accent-amber)'
                          : 'var(--accent-red)',
                    color: 'white',
                    opacity: 0.9,
                  }}
                >
                  {sa.hrvRecovery.score}/100 — {sa.hrvRecovery.status}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div
                  className="p-2.5 rounded-lg text-center"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Latest HRV
                  </span>
                  <p
                    className="text-lg font-semibold tabular-nums"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {Math.round(sa.hrvRecovery.latestHrv)}ms
                  </p>
                </div>
                <div
                  className="p-2.5 rounded-lg text-center"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Baseline
                  </span>
                  <p
                    className="text-lg font-semibold tabular-nums"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {Math.round(sa.hrvRecovery.baseline)}ms
                  </p>
                </div>
                <div
                  className="p-2.5 rounded-lg text-center"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Z-Score
                  </span>
                  <p
                    className="text-lg font-semibold tabular-nums"
                    style={{
                      color:
                        sa.hrvRecovery.zScore >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                    }}
                  >
                    {sa.hrvRecovery.zScore >= 0 ? '+' : ''}
                    {sa.hrvRecovery.zScore.toFixed(1)}
                  </p>
                </div>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {sa.hrvRecovery.recommendation}
              </p>
              {(() => {
                const norms = healthPageHrvNorms(userAge)
                const pct = hpPctRank(sa.hrvRecovery.latestHrv, norms.avg, norms.sd)
                const diff = Math.round(sa.hrvRecovery.latestHrv - norms.avg)
                const color =
                  pct >= 60
                    ? 'var(--accent-green)'
                    : pct >= 35
                      ? 'var(--accent-amber)'
                      : 'var(--accent-red)'
                return (
                  <div
                    className="mt-2 pt-2 flex items-center gap-2"
                    style={{ borderTop: '1px solid var(--separator)' }}
                  >
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Ages {norms.ageGroup} avg: {norms.avg}ms
                    </span>
                    <span
                      className="text-[10px] font-medium"
                      style={{ color: diff >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
                    >
                      {diff >= 0 ? '+' : ''}
                      {diff}ms
                    </span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                      style={{ background: color + '22', color }}
                    >
                      {pct >= 50 ? `Top ${100 - pct}%` : `Bottom ${pct}%`}
                    </span>
                  </div>
                )
              })()}
            </div>
          )}

          {/* Recovery Readiness & Regularity */}
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
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Recovery Readiness
                    </span>
                    <span
                      className="ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium capitalize"
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
                  <div
                    className="flex gap-3 mt-2 text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
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
                    <Shield size={14} style={{ color: 'var(--accent-purple)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Sleep Regularity
                    </span>
                    <span
                      className="ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium capitalize"
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
                  <div
                    className="flex gap-3 mt-2 text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span>Bedtime: ±{regularity.avgBedtimeVariance}h</span>
                    <span>Wake: ±{regularity.avgWakeVariance}h</span>
                  </div>
                </div>
              )}
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
                  Bedtime target: {windDownRoutine.optimalBedtime}
                </span>
              </div>
              <div className="space-y-1">
                {windDownRoutine.steps.map((step: any, i: number) => {
                  const iconMap: Record<string, React.ReactNode> = {
                    dim: <Lightbulb size={14} />,
                    phone: <Smartphone size={14} />,
                    shower: <ShowerHead size={14} />,
                    snack: <Coffee size={14} />,
                    stretch: <Wind size={14} />,
                    read: <BookOpen size={14} />,
                    bed: <Bed size={14} />,
                  }
                  const isLast = i === windDownRoutine.steps.length - 1
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-3 p-2 rounded-lg"
                      style={{
                        background: isLast ? 'rgba(139,92,246,0.08)' : 'var(--bg-tertiary)',
                      }}
                    >
                      <div className="flex items-center gap-2 shrink-0 mt-0.5 w-14 text-right">
                        <span
                          className="text-xs font-mono font-medium w-full"
                          style={{ color: isLast ? 'var(--accent-purple)' : 'var(--text-primary)' }}
                        >
                          {step.time}
                        </span>
                      </div>
                      <div
                        className="shrink-0 mt-0.5"
                        style={{ color: isLast ? 'var(--accent-purple)' : 'var(--text-muted)' }}
                      >
                        {iconMap[step.icon] || <Clock size={14} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span
                          className="text-sm font-medium"
                          style={{ color: isLast ? 'var(--accent-purple)' : 'var(--text-primary)' }}
                        >
                          {step.activity}
                        </span>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {step.description}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Morning Sleep Briefing */}
          {morningSleepBriefing && (
            <div className="card">
              <div className="flex items-center gap-2 mb-3">
                <Sun size={16} style={{ color: 'var(--accent-amber)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Morning Sleep Report
                </span>
                <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
                  {new Date(morningSleepBriefing.created_at).toLocaleDateString()}
                </span>
                <button
                  onClick={handleRefreshSleepReport}
                  disabled={refreshingSleepReport}
                  className="p-1 rounded-md transition-colors disabled:opacity-50"
                  style={{ color: 'var(--text-muted)' }}
                  title="Regenerate sleep report from latest data"
                  aria-label="Refresh sleep report"
                >
                  <RefreshCw size={14} className={refreshingSleepReport ? 'animate-spin' : ''} />
                </button>
              </div>
              <div
                className="text-sm leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto"
                style={{ color: 'var(--text-secondary)' }}
              >
                {morningSleepBriefing.content}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {sa.quality.recommendations.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle size={16} style={{ color: 'var(--accent-amber)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Recommendations
                </span>
              </div>
              <div className="space-y-2">
                {sa.quality.recommendations.map((rec, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <span
                      className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full"
                      style={{ background: 'var(--accent-purple)' }}
                    />
                    <span style={{ color: 'var(--text-secondary)' }}>{rec}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Loading */}
      {sleepAnalysisLoading && !sa && (
        <div className="card flex flex-col items-center justify-center py-16 gap-3">
          <NoodleSpinner size={72} color="var(--accent-purple)" label="Analyzing sleep data…" />
        </div>
      )}

      {/* Empty state */}
      {!sleepAnalysisLoading && !sa && (
        <div className="card py-8">
          <NoodleIllustration
            size={88}
            label="No sleep data yet"
            sublabel="Import from Health Auto Export or connect your Apple Watch."
          />
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-2 gap-4">
        <div
          className="card cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => navigate('/health/sleep')}
        >
          <div className="flex items-center gap-2 mb-4">
            <Moon size={16} style={{ color: 'var(--accent-purple)' }} />
            <span className="text-sm font-medium flex-1" style={{ color: 'var(--text-primary)' }}>
              Sleep Duration — 7 Days
            </span>
            <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
          </div>
          <SleepChart metrics={sleepMetrics} loading={sleepLoading} />
        </div>

        <div
          className="card cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => navigate('/health/heart')}
        >
          <div className="flex items-center gap-2 mb-4">
            <Heart size={16} style={{ color: 'var(--accent-red)' }} />
            <span className="text-sm font-medium flex-1" style={{ color: 'var(--text-primary)' }}>
              Heart Rate — 7 Days
            </span>
            <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
          </div>
          <HeartRateChart metrics={hrMetrics} loading={hrLoading} />
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-3 gap-4">
        <div
          className="card cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => navigate('/health/hrv')}
        >
          <div className="flex items-center justify-between">
            <MetricCard
              title="HRV"
              icon={<Activity size={16} />}
              color="var(--accent-blue)"
              metrics={hrvMetrics}
              loading={hrvLoading}
              unit="ms"
              formatter={(v) => Math.round(v).toString()}
            />
            <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
        <div
          className="card cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => navigate('/health/exercise')}
        >
          <div className="flex items-center justify-between">
            <MetricCard
              title="Steps"
              icon={<Footprints size={16} />}
              color="var(--accent-green)"
              metrics={stepsMetrics}
              loading={stepsLoading}
              unit="steps"
              formatter={(v) => Math.round(v).toLocaleString()}
            />
            <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
        <div className="card">
          <MetricCard
            title="Sleep Score"
            icon={<Moon size={16} />}
            color="var(--accent-purple)"
            metrics={sleepMetrics}
            loading={sleepLoading}
            unit={sa ? '/100' : 'hours'}
            valueExtractor={(val) => {
              if (sa) return sa.quality.overall
              const mins =
                (val.totalAsleep as number) || (val.asleep as number) || (val.qty as number) || null
              return mins ? mins / 60 : null
            }}
            formatter={(v) => (sa ? v.toFixed(0) : v.toFixed(1))}
          />
        </div>
      </div>

      {/* Health alerts */}
      <HealthAlertsPanel />

      {/* AI Insights */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3
            className="text-sm font-medium flex items-center gap-2"
            style={{ color: 'var(--text-primary)' }}
          >
            <Bot size={14} style={{ color: 'var(--accent-purple)' }} />
            AI Health Insights
          </h3>
          <button
            onClick={handleGenerateInsights}
            disabled={generatingBriefing}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-purple)' }}
          >
            <Sparkles size={12} className={generatingBriefing ? 'animate-spin' : ''} />
            {generatingBriefing ? 'Analyzing...' : 'Generate'}
          </button>
        </div>
        {briefing ? (
          <div
            className="text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto"
            style={{ color: 'var(--text-secondary)' }}
          >
            {briefing.content}
          </div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {sa
              ? 'Click Generate for AI analysis of your sleep and health data.'
              : 'Import health data first, then click Generate for AI insights.'}
          </p>
        )}
      </div>
    </div>
  )
}

// ---------- Helpers added in PR 5 ----------

function shortLabel(s: string): string {
  return s
    .replace('Sleep hours', 'Slp')
    .replace('Deep sleep %', 'Deep%')
    .replace('HRV next-day', 'HRV+1')
    .replace('Portfolio return', '$Ret')
    .replace('TSB (form)', 'TSB')
    .replace('HRV', 'HRV')
    .trim()
}
