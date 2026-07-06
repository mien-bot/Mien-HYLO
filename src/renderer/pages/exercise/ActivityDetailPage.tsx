import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Activity,
  Clock,
  Flame,
  Heart,
  Mountain,
  Timer,
  Zap,
  Gauge,
  MapPin,
  Trophy,
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
} from 'lucide-react'
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  Cell,
} from 'recharts'
import Tooltip from '../../components/charts/ChartTooltip'
import { format, parseISO } from 'date-fns'
import NoodleSpinner from '../../components/anim/NoodleSpinner'
import { useToast } from '../../components/Toast'
import { useAnalysisStream } from '../../hooks/useAnalysisStream'

interface ZoneSecond {
  zone: string
  color: string
  minBpm: number
  maxBpm: number
  seconds: number
  pct: number
}

interface SampledPoint {
  t: number
  hr?: number
  paceMinPerMi?: number
  speedMph?: number
  altitudeFt?: number
  cadence?: number
  watts?: number
  gradePct?: number
  distMi?: number
}

interface ActivityDetail {
  key: string
  date: string
  workout: Record<string, any>
  sport: 'run' | 'ride' | 'other'
  hr: {
    maxHr: number
    lthr: number | null
    restingHr: number
    model: 'maxhr' | 'friel'
    zones: Array<{ name: string; minBpm: number; maxBpm: number; color: string }>
    distribution: ZoneSecond[]
    source: 'stream' | 'stored' | 'estimated' | 'none'
  }
  streams: {
    hasData: boolean
    seconds: number[]
    sampled?: SampledPoint[]
  }
  comparison: {
    sportLabel: string
    sampleCount: number
    days: number
    avgDistance: number | null
    avgDuration: number | null
    avgHR: number | null
    avgPaceMinPerMi: number | null
    avgSpeedMph: number | null
    avgElevationGain: number | null
  }
}

const tooltipStyle = {
  background: '#1a1a1a',
  border: '1px solid #2a2a2a',
  borderRadius: '8px',
  fontSize: '12px',
  color: '#e5e5e5',
}

function fmtDuration(minutes: number): string {
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function fmtSecondsDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtPace(minPerMi: number | null | undefined): string {
  if (!minPerMi || minPerMi <= 0 || !isFinite(minPerMi)) return '—'
  const m = Math.floor(minPerMi)
  const s = Math.round((minPerMi - m) * 60)
  return `${m}:${String(s).padStart(2, '0')}/mi`
}

function fmtTimeAxis(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return m >= 60
    ? `${Math.floor(m / 60)}h${m % 60}m`
    : `${m}:${String(s).padStart(2, '0')}`
}

function compareBadge(yours: number, avg: number | null, higherIsBetter: boolean) {
  if (avg == null || !isFinite(yours) || !isFinite(avg) || avg === 0) return null
  const pct = ((yours - avg) / avg) * 100
  if (Math.abs(pct) < 1) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        <Minus size={10} /> avg
      </span>
    )
  }
  const isGood = higherIsBetter ? pct > 0 : pct < 0
  const color = isGood ? 'var(--accent-green)' : 'var(--accent-red)'
  const Icon = pct > 0 ? TrendingUp : TrendingDown
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px]" style={{ color }}>
      <Icon size={10} /> {pct > 0 ? '+' : ''}
      {pct.toFixed(0)}% vs avg
    </span>
  )
}

export default function ActivityDetailPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const params = useParams<{ key: string }>()
  const key = params.key || ''
  const [detail, setDetail] = useState<ActivityDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [reportLoading, setReportLoading] = useState(false)
  const [aiReport, setAiReport] = useState('')
  const [userChartTab, setUserChartTab] = useState<'hr' | 'pace' | 'elevation' | 'power' | 'cadence' | null>(null)
  const { streamingContent, isStreaming, reset: resetAnalysisStream } = useAnalysisStream()

  useEffect(() => {
    if (!key) return
    setLoading(true)
    setUserChartTab(null)
    window.api
      .getWorkoutDetail(key)
      .then((data: ActivityDetail | null) => {
        setDetail(data)
        setLoading(false)
      })
      .catch((err) => {
        showToast(`Activity detail failed: ${err?.message ?? err}`, 'error')
        setLoading(false)
      })
  }, [key, showToast])

  const generateAiReport = async () => {
    if (!key || reportLoading) return
    resetAnalysisStream()
    setAiReport('')
    setReportLoading(true)
    try {
      const report = await window.api.generateWorkoutReport(key)
      setAiReport(report)
    } catch (err: any) {
      showToast(`Workout report failed: ${err?.message ?? err}`, 'error')
    } finally {
      setReportLoading(false)
    }
  }

  // ---- derived ----
  const sampled = detail?.streams.sampled ?? []
  const hasHR = sampled.some((p) => typeof p.hr === 'number')
  const hasPace = sampled.some((p) => typeof p.paceMinPerMi === 'number')
  const hasSpeed = sampled.some((p) => typeof p.speedMph === 'number')
  const hasAlt = sampled.some((p) => typeof p.altitudeFt === 'number')
  const hasPower = sampled.some((p) => typeof p.watts === 'number')
  const hasCadence = sampled.some((p) => typeof p.cadence === 'number')

  // Default tab is computed from what data is available; user click overrides.
  const defaultChartTab: 'hr' | 'pace' | 'elevation' | 'power' | 'cadence' = hasHR
    ? 'hr'
    : hasPace || hasSpeed
      ? 'pace'
      : hasAlt
        ? 'elevation'
        : hasPower
          ? 'power'
          : 'cadence'
  const chartTab = userChartTab ?? defaultChartTab
  const setChartTab = setUserChartTab

  const w = detail?.workout
  const sportLabel =
    detail?.sport === 'run' ? 'Run' : detail?.sport === 'ride' ? 'Ride' : detail?.workout?.name || 'Activity'
  const durationMin = (() => {
    if (!w) return 0
    const raw = Number(w.duration || 0)
    return raw > 200 ? Math.round(raw / 60) : Math.round(raw)
  })()
  const distance = Number(w?.distance || 0)
  const pacePerMi =
    detail?.sport === 'run' && distance > 0 && durationMin > 0 ? durationMin / distance : null
  const speedMph =
    detail && (detail.sport === 'ride' || detail.sport === 'other') && distance > 0 && durationMin > 0
      ? distance / (durationMin / 60)
      : null
  const elevationFt = w?.elevationGain ? Math.round(Number(w.elevationGain) * 3.28084) : 0

  // splits (Strava splits_metric is per km; splits_standard is per mile)
  const splitsMile: Array<{
    index: number
    distMi: number
    durationSec: number
    paceMinPerMi: number
    elevDiffFt: number
    avgHR?: number
  }> = useMemo(() => {
    const arr: any[] = Array.isArray(w?.splitsStandard) ? w.splitsStandard : []
    return arr.map((s, i) => {
      const distMeters = Number(s.distance || 0)
      const distMi = distMeters * 0.000621371
      const sec = Number(s.movingTime || s.elapsedTime || 0)
      const paceMinPerMi = distMi > 0 ? sec / 60 / distMi : 0
      const elevDiffFt = Number(s.elevationDifference || 0) * 3.28084
      return {
        index: s.split ?? i + 1,
        distMi: parseFloat(distMi.toFixed(2)),
        durationSec: sec,
        paceMinPerMi: parseFloat(paceMinPerMi.toFixed(2)),
        elevDiffFt: Math.round(elevDiffFt),
      }
    })
  }, [w])

  const splitsKm: Array<{
    index: number
    distMi: number
    durationSec: number
    paceMinPerMi: number
    elevDiffFt: number
  }> = useMemo(() => {
    const arr: any[] = Array.isArray(w?.splitsMetric) ? w.splitsMetric : []
    return arr.map((s, i) => {
      const distMeters = Number(s.distance || 0)
      const distMi = distMeters * 0.000621371
      const sec = Number(s.movingTime || s.elapsedTime || 0)
      const paceMinPerMi = distMi > 0 ? sec / 60 / distMi : 0
      const elevDiffFt = Number(s.elevationDifference || 0) * 3.28084
      return {
        index: s.split ?? i + 1,
        distMi: parseFloat(distMi.toFixed(2)),
        durationSec: sec,
        paceMinPerMi: parseFloat(paceMinPerMi.toFixed(2)),
        elevDiffFt: Math.round(elevDiffFt),
      }
    })
  }, [w])

  const splits = splitsMile.length > 0 ? splitsMile : splitsKm
  const splitsUnit = splitsMile.length > 0 ? 'mi' : 'km'
  // Color paces by relative speed within the activity
  const splitPaceStats = useMemo(() => {
    if (!splits.length) return null
    const paces = splits.map((s) => s.paceMinPerMi).filter((p) => p > 0)
    if (!paces.length) return null
    return {
      best: Math.min(...paces),
      worst: Math.max(...paces),
      avg: paces.reduce((a, b) => a + b, 0) / paces.length,
    }
  }, [splits])

  const bestEfforts: Array<{ name: string; distanceMeters: number; movingTime: number; prRank?: number | null }> = useMemo(() => {
    const arr: any[] = Array.isArray(w?.bestEfforts) ? w.bestEfforts : []
    return arr.map((e) => ({
      name: e.name || '—',
      distanceMeters: Number(e.distance || 0),
      movingTime: Number(e.movingTime || 0),
      prRank: e.prRank ?? null,
    }))
  }, [w])

  // ---- render ----

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto py-12 flex justify-center">
        <NoodleSpinner size={72} color="var(--accent-orange)" label="Loading activity…" />
      </div>
    )
  }

  if (!detail || !w) {
    return (
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/health/exercise')}
            className="p-1.5 rounded-lg transition-colors hover:opacity-80"
            style={{ background: 'var(--bg-tertiary)' }}
            aria-label="Back"
          >
            <ArrowLeft size={18} style={{ color: 'var(--text-secondary)' }} />
          </button>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            Activity not found
          </h2>
        </div>
        <div className="card">
          <p className="text-sm py-12 text-center" style={{ color: 'var(--text-muted)' }}>
            Couldn't find activity <code className="font-mono">{key}</code>. It may have been
            deleted, or streams have not been synced yet.
          </p>
        </div>
      </div>
    )
  }

  const stravaUrl = w.stravaId ? `https://www.strava.com/activities/${w.stravaId}` : null
  const startDate = w.start || `${detail.date}T00:00:00`
  let startDisplay = ''
  try {
    startDisplay = format(parseISO(startDate), "EEE, MMM d yyyy 'at' h:mma")
  } catch {
    startDisplay = format(parseISO(detail.date), 'EEE, MMM d yyyy')
  }
  const location = [w.location?.city, w.location?.state].filter(Boolean).join(', ')
  const visibleAiReport = reportLoading ? streamingContent || aiReport : aiReport

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => navigate('/health/exercise')}
          className="p-1.5 rounded-lg transition-colors hover:opacity-80"
          style={{ background: 'var(--bg-tertiary)' }}
          aria-label="Back to exercise"
        >
          <ArrowLeft size={18} style={{ color: 'var(--text-secondary)' }} />
        </button>
        <Activity size={20} style={{ color: 'var(--accent-orange)' }} />
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              {sportLabel}
            </h2>
            {w.source?.toLowerCase().includes('strava') && (
              <span
                className="text-[10px] px-2 py-0.5 rounded font-semibold"
                style={{ background: 'var(--accent-orange)', color: 'white' }}
              >
                STRAVA
              </span>
            )}
            {w.prCount > 0 && (
              <span
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-semibold"
                style={{ background: 'var(--accent-amber)', color: 'white' }}
              >
                <Trophy size={10} /> {w.prCount} PR
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {startDisplay}
            {location ? ` · ${location}` : ''}
            {w.deviceName ? ` · ${w.deviceName}` : ''}
          </p>
        </div>
        <button
          onClick={generateAiReport}
          disabled={reportLoading || isStreaming}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed hover:opacity-80"
          style={{ background: 'var(--accent-blue)', color: 'white' }}
        >
          <Sparkles size={13} />
          {reportLoading || isStreaming ? 'Analyzing...' : 'AI Report'}
        </button>
        {stravaUrl && (
          <a
            href={stravaUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors hover:opacity-80"
            style={{ background: '#fc4c02', color: 'white' }}
          >
            View on Strava
          </a>
        )}
      </div>

      {w.description && (
        <div className="card">
          <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
            {w.description}
          </p>
        </div>
      )}

      {(reportLoading || visibleAiReport) && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={14} style={{ color: 'var(--accent-blue)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              AI Exercise Science Report
            </span>
            {(reportLoading || isStreaming) && (
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                generating
              </span>
            )}
          </div>
          {visibleAiReport ? (
            <div
              className="text-sm leading-relaxed whitespace-pre-wrap"
              style={{ color: 'var(--text-secondary)' }}
            >
              {visibleAiReport}
            </div>
          ) : (
            <div className="py-6 flex justify-center">
              <NoodleSpinner size={48} color="var(--accent-blue)" label="Analyzing run..." />
            </div>
          )}
        </div>
      )}

      {/* Hero stat row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <HeroStat
          icon={<Clock size={14} />}
          color="var(--text-secondary)"
          label="Duration"
          value={fmtDuration(durationMin)}
          badge={compareBadge(durationMin, detail.comparison.avgDuration, true)}
        />
        <HeroStat
          icon={<MapPin size={14} />}
          color="var(--accent-blue)"
          label="Distance"
          value={distance > 0 ? `${distance.toFixed(2)} mi` : '—'}
          badge={compareBadge(distance, detail.comparison.avgDistance, true)}
        />
        {detail.sport === 'run' ? (
          <HeroStat
            icon={<Gauge size={14} />}
            color="var(--accent-green)"
            label="Avg Pace"
            value={fmtPace(pacePerMi)}
            badge={
              pacePerMi != null && detail.comparison.avgPaceMinPerMi != null
                ? compareBadge(pacePerMi, detail.comparison.avgPaceMinPerMi, false)
                : null
            }
          />
        ) : (
          <HeroStat
            icon={<Gauge size={14} />}
            color="var(--accent-green)"
            label="Avg Speed"
            value={speedMph != null ? `${speedMph.toFixed(1)} mph` : '—'}
            badge={
              speedMph != null && detail.comparison.avgSpeedMph != null
                ? compareBadge(speedMph, detail.comparison.avgSpeedMph, true)
                : null
            }
          />
        )}
        <HeroStat
          icon={<Heart size={14} />}
          color="var(--accent-red)"
          label="Avg HR"
          value={w.avgHR > 0 ? `${Math.round(w.avgHR)} bpm` : '—'}
          sub={w.maxHR > 0 ? `max ${Math.round(w.maxHR)}` : undefined}
          badge={
            w.avgHR > 0 && detail.comparison.avgHR
              ? compareBadge(Number(w.avgHR), detail.comparison.avgHR, false)
              : null
          }
        />
        <HeroStat
          icon={<Flame size={14} />}
          color="var(--accent-orange)"
          label="Calories"
          value={w.calories > 0 ? `${w.calories}` : '—'}
        />
        <HeroStat
          icon={<Mountain size={14} />}
          color="var(--accent-amber)"
          label="Elev Gain"
          value={elevationFt > 0 ? `${elevationFt} ft` : '—'}
          badge={
            elevationFt > 0 && detail.comparison.avgElevationGain
              ? compareBadge(elevationFt, detail.comparison.avgElevationGain, true)
              : null
          }
        />
      </div>

      {/* Secondary metrics — only shown if data is present */}
      {(w.avgCadence > 0 ||
        w.avgWatts > 0 ||
        w.normalizedPower > 0 ||
        w.sufferScore > 0 ||
        w.perceivedExertion) && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {w.avgCadence > 0 && (
            <HeroStat
              icon={<Zap size={14} />}
              color="var(--accent-purple)"
              label="Avg Cadence"
              value={`${Math.round(w.avgCadence)}${detail.sport === 'run' ? ' spm' : ' rpm'}`}
            />
          )}
          {w.avgWatts > 0 && (
            <HeroStat
              icon={<Zap size={14} />}
              color="var(--accent-amber)"
              label="Avg Power"
              value={`${Math.round(w.avgWatts)} W`}
              sub={w.maxWatts > 0 ? `max ${Math.round(w.maxWatts)}` : undefined}
            />
          )}
          {w.normalizedPower > 0 && w.normalizedPower !== w.avgWatts && (
            <HeroStat
              icon={<Zap size={14} />}
              color="var(--accent-amber)"
              label="NP"
              value={`${Math.round(w.normalizedPower)} W`}
            />
          )}
          {w.sufferScore > 0 && (
            <HeroStat
              icon={<Activity size={14} />}
              color="var(--accent-red)"
              label="Suffer Score"
              value={`${Math.round(w.sufferScore)}`}
            />
          )}
          {typeof w.perceivedExertion === 'number' && (
            <HeroStat
              icon={<Activity size={14} />}
              color="var(--accent-red)"
              label="RPE"
              value={`${w.perceivedExertion}/10`}
            />
          )}
          {w.gear?.name && (
            <HeroStat
              icon={<Activity size={14} />}
              color="var(--text-secondary)"
              label="Gear"
              value={w.gear.name}
            />
          )}
        </div>
      )}

      {/* Stream charts */}
      {detail.streams.hasData && sampled.length > 0 ? (
        <div className="card">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="flex items-center gap-2">
              <Activity size={14} style={{ color: 'var(--accent-orange)' }} />
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Activity Streams
              </span>
            </div>
            <div className="flex items-center gap-1">
              {hasHR && (
                <ChartTab active={chartTab === 'hr'} onClick={() => setChartTab('hr')}>
                  Heart Rate
                </ChartTab>
              )}
              {(hasPace || hasSpeed) && (
                <ChartTab active={chartTab === 'pace'} onClick={() => setChartTab('pace')}>
                  {detail.sport === 'run' ? 'Pace' : 'Speed'}
                </ChartTab>
              )}
              {hasAlt && (
                <ChartTab active={chartTab === 'elevation'} onClick={() => setChartTab('elevation')}>
                  Elevation
                </ChartTab>
              )}
              {hasPower && (
                <ChartTab active={chartTab === 'power'} onClick={() => setChartTab('power')}>
                  Power
                </ChartTab>
              )}
              {hasCadence && (
                <ChartTab active={chartTab === 'cadence'} onClick={() => setChartTab('cadence')}>
                  Cadence
                </ChartTab>
              )}
            </div>
          </div>

          <StreamChart
            data={sampled}
            mode={chartTab}
            sport={detail.sport}
            zones={detail.hr.zones}
          />
        </div>
      ) : (
        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <Activity size={14} style={{ color: 'var(--accent-orange)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Activity Streams
            </span>
          </div>
          <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
            No second-by-second stream data for this activity. Sync streams from the exercise page
            (Sync Strava button) to load detailed charts.
          </p>
        </div>
      )}

      {/* HR Zone distribution */}
      {detail.hr.distribution.some((d) => d.seconds > 0) && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Heart size={14} style={{ color: 'var(--accent-red)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Time in Heart Rate Zones
            </span>
            <span className="text-[10px] uppercase tracking-wide ml-1" style={{ color: 'var(--text-muted)' }}>
              {detail.hr.model === 'friel'
                ? `Friel · LTHR ${detail.hr.lthr ?? '—'}`
                : `%MaxHR · ${detail.hr.maxHr}`}
            </span>
            <span className="text-[10px] ml-auto px-2 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
              source: {detail.hr.source}
            </span>
          </div>
          <div className="space-y-2">
            {detail.hr.distribution.map((d) => (
              <div key={d.zone} className="flex items-center gap-3">
                <div className="w-32 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {d.zone}
                  <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {d.minBpm}–{d.maxBpm === 999 ? '∞' : d.maxBpm} bpm
                  </span>
                </div>
                <div className="flex-1 h-5 rounded relative overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.min(100, d.pct)}%`,
                      background: d.color,
                      opacity: d.seconds > 0 ? 1 : 0.2,
                    }}
                  />
                  <span
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono"
                    style={{ color: d.seconds > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}
                  >
                    {fmtSecondsDuration(d.seconds)} · {d.pct}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Splits */}
      {splits.length > 0 && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Timer size={14} style={{ color: 'var(--accent-blue)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Splits ({splits.length} × 1 {splitsUnit})
            </span>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={splits} barCategoryGap={splits.length > 30 ? '5%' : '15%'}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
              <XAxis dataKey="index" tick={{ fontSize: 10, fill: '#737373' }} axisLine={false} tickLine={false} />
              <YAxis
                domain={splitPaceStats ? [Math.max(0, splitPaceStats.best - 0.5), splitPaceStats.worst + 0.5] : undefined}
                tick={{ fontSize: 10, fill: '#737373' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => fmtPace(v)}
                width={70}
                reversed
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: number) => [fmtPace(value), 'Pace']}
                labelFormatter={(label: string | number) => `Split ${label}`}
              />
              <Bar dataKey="paceMinPerMi" radius={[3, 3, 0, 0]}>
                {splits.map((s, i) => {
                  let color = 'var(--accent-blue)'
                  if (splitPaceStats) {
                    if (s.paceMinPerMi === splitPaceStats.best) color = 'var(--accent-green)'
                    else if (s.paceMinPerMi === splitPaceStats.worst) color = 'var(--accent-red)'
                  }
                  return <Cell key={i} fill={color} />
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="overflow-y-auto max-h-72 mt-2">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left py-1.5">#</th>
                  <th className="text-right py-1.5">Distance</th>
                  <th className="text-right py-1.5">Time</th>
                  <th className="text-right py-1.5">Pace</th>
                  <th className="text-right py-1.5">Elev Δ</th>
                </tr>
              </thead>
              <tbody>
                {splits.map((s, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--separator)' }}>
                    <td className="py-1.5" style={{ color: 'var(--text-primary)' }}>{s.index}</td>
                    <td className="text-right py-1.5 font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {s.distMi.toFixed(2)} mi
                    </td>
                    <td className="text-right py-1.5 font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {fmtSecondsDuration(s.durationSec)}
                    </td>
                    <td className="text-right py-1.5 font-mono" style={{ color: 'var(--accent-green)' }}>
                      {fmtPace(s.paceMinPerMi)}
                    </td>
                    <td className="text-right py-1.5 font-mono" style={{ color: s.elevDiffFt > 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                      {s.elevDiffFt > 0 ? '+' : ''}{s.elevDiffFt} ft
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Best efforts */}
      {bestEfforts.length > 0 && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Trophy size={14} style={{ color: 'var(--accent-amber)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Best Efforts
            </span>
          </div>
          <div className="overflow-y-auto max-h-72">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left py-1.5">Distance</th>
                  <th className="text-right py-1.5">Time</th>
                  <th className="text-right py-1.5">Pace</th>
                  <th className="text-right py-1.5">PR</th>
                </tr>
              </thead>
              <tbody>
                {bestEfforts.map((e, i) => {
                  const distMi = e.distanceMeters * 0.000621371
                  const pace = distMi > 0 ? e.movingTime / 60 / distMi : 0
                  return (
                    <tr key={i} className="border-t" style={{ borderColor: 'var(--separator)' }}>
                      <td className="py-1.5" style={{ color: 'var(--text-primary)' }}>{e.name}</td>
                      <td className="text-right py-1.5 font-mono" style={{ color: 'var(--text-secondary)' }}>
                        {fmtSecondsDuration(e.movingTime)}
                      </td>
                      <td className="text-right py-1.5 font-mono" style={{ color: 'var(--accent-green)' }}>
                        {fmtPace(pace)}
                      </td>
                      <td className="text-right py-1.5 font-mono" style={{ color: e.prRank ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                        {e.prRank ? `#${e.prRank}` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 90-day comparison */}
      {detail.comparison.sampleCount > 0 && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Activity size={14} style={{ color: 'var(--accent-blue)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              vs. Your Last {detail.comparison.days} Days
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              ({detail.comparison.sampleCount} {detail.comparison.sportLabel.toLowerCase()})
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <ComparisonRow
              label="Distance"
              you={distance > 0 ? `${distance.toFixed(2)} mi` : '—'}
              avg={
                detail.comparison.avgDistance != null
                  ? `${detail.comparison.avgDistance.toFixed(2)} mi`
                  : '—'
              }
            />
            <ComparisonRow
              label="Duration"
              you={fmtDuration(durationMin)}
              avg={
                detail.comparison.avgDuration != null
                  ? fmtDuration(detail.comparison.avgDuration)
                  : '—'
              }
            />
            {detail.sport === 'run' ? (
              <ComparisonRow
                label="Pace"
                you={fmtPace(pacePerMi)}
                avg={fmtPace(detail.comparison.avgPaceMinPerMi)}
              />
            ) : (
              <ComparisonRow
                label="Speed"
                you={speedMph != null ? `${speedMph.toFixed(1)} mph` : '—'}
                avg={
                  detail.comparison.avgSpeedMph != null
                    ? `${detail.comparison.avgSpeedMph.toFixed(1)} mph`
                    : '—'
                }
              />
            )}
            <ComparisonRow
              label="Avg HR"
              you={w.avgHR > 0 ? `${Math.round(w.avgHR)} bpm` : '—'}
              avg={detail.comparison.avgHR ? `${detail.comparison.avgHR} bpm` : '—'}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function HeroStat({
  icon,
  color,
  label,
  value,
  sub,
  badge,
}: {
  icon: React.ReactNode
  color: string
  label: string
  value: string
  sub?: string
  badge?: React.ReactNode
}) {
  return (
    <div className="card">
      <div className="flex items-center gap-1.5">
        <span style={{ color }}>{icon}</span>
        <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
      </div>
      <p className="text-xl font-semibold mt-1" style={{ color }}>
        {value}
      </p>
      {sub && (
        <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </p>
      )}
      {badge && <div className="mt-0.5">{badge}</div>}
    </div>
  )
}

function ChartTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
      style={{
        background: active ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
        color: active ? 'white' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  )
}

function ComparisonRow({ label, you, avg }: { label: string; you: string; avg: string }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {you}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          vs avg {avg}
        </span>
      </div>
    </div>
  )
}

function StreamChart({
  data,
  mode,
  sport,
  zones,
}: {
  data: SampledPoint[]
  mode: 'hr' | 'pace' | 'elevation' | 'power' | 'cadence'
  sport: 'run' | 'ride' | 'other'
  zones: Array<{ name: string; minBpm: number; maxBpm: number; color: string }>
}) {
  if (mode === 'hr') {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtTimeAxis}
            type="number"
            domain={['dataMin', 'dataMax']}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            domain={['dataMin - 10', 'dataMax + 10']}
            width={36}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value: number) => [`${value} bpm`, 'Heart Rate']}
            labelFormatter={(t: number) => `at ${fmtTimeAxis(t)}`}
          />
          {zones.map((z) => {
            if (z.maxBpm === Infinity || z.maxBpm > 220) return null
            return (
              <ReferenceLine
                key={z.name}
                y={z.maxBpm}
                stroke={z.color}
                strokeOpacity={0.25}
                strokeDasharray="3 3"
              />
            )
          })}
          <Area type="monotone" dataKey="hr" stroke="#ef4444" fill="#ef4444" fillOpacity={0.2} dot={false} strokeWidth={1.5} />
        </AreaChart>
      </ResponsiveContainer>
    )
  }
  if (mode === 'pace') {
    const isPace = sport === 'run'
    return (
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtTimeAxis}
            type="number"
            domain={['dataMin', 'dataMax']}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            width={56}
            tickFormatter={(v) => (isPace ? fmtPace(v) : `${v} mph`)}
            reversed={isPace}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value: number) => [
              isPace ? fmtPace(value) : `${value} mph`,
              isPace ? 'Pace' : 'Speed',
            ]}
            labelFormatter={(t: number) => `at ${fmtTimeAxis(t)}`}
          />
          <Line
            type="monotone"
            dataKey={isPace ? 'paceMinPerMi' : 'speedMph'}
            stroke="#22c55e"
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    )
  }
  if (mode === 'elevation') {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtTimeAxis}
            type="number"
            domain={['dataMin', 'dataMax']}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            domain={['dataMin - 20', 'dataMax + 20']}
            tickFormatter={(v) => `${v} ft`}
            width={56}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value: number) => [`${value} ft`, 'Elevation']}
            labelFormatter={(t: number) => `at ${fmtTimeAxis(t)}`}
          />
          <Area type="monotone" dataKey="altitudeFt" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.3} dot={false} strokeWidth={1.5} />
        </AreaChart>
      </ResponsiveContainer>
    )
  }
  if (mode === 'power') {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtTimeAxis}
            type="number"
            domain={['dataMin', 'dataMax']}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#737373' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v}W`}
            width={48}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value: number) => [`${value} W`, 'Power']}
            labelFormatter={(t: number) => `at ${fmtTimeAxis(t)}`}
          />
          <Area type="monotone" dataKey="watts" stroke="#a855f7" fill="#a855f7" fillOpacity={0.25} dot={false} strokeWidth={1.5} />
        </AreaChart>
      </ResponsiveContainer>
    )
  }
  // cadence
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--separator)" vertical={false} />
        <XAxis
          dataKey="t"
          tick={{ fontSize: 10, fill: '#737373' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={fmtTimeAxis}
          type="number"
          domain={['dataMin', 'dataMax']}
        />
        <YAxis
          tick={{ fontSize: 10, fill: '#737373' }}
          axisLine={false}
          tickLine={false}
          domain={['dataMin - 5', 'dataMax + 5']}
          width={36}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value: number) => [`${value} ${sport === 'run' ? 'spm' : 'rpm'}`, 'Cadence']}
          labelFormatter={(t: number) => `at ${fmtTimeAxis(t)}`}
        />
        <Line type="monotone" dataKey="cadence" stroke="#3b82f6" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
