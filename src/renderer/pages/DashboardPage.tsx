import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  TrendingUp,
  TrendingDown,
  Moon,
  Sparkles,
  Clock,
  CheckCircle2,
  Activity,
  Wifi,
  WifiOff,
  X,
  Settings as SettingsIcon,
  Briefcase,
  Heart,
  Dumbbell,
  Calendar,
  Bell,
  MapPin,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  Eye,
  EyeOff,
  Send,
} from 'lucide-react'
import type { LatestPrice, Briefing, DailySchedule } from '../../shared/types/ipc.types'
import { formatDistanceToNow } from 'date-fns'
import { renderMarkdown } from '../lib/markdown'
import {
  RadialGauge,
  CalendarHeatmap,
  HeatmapChart,
  GradientLegend,
  ChartCard,
  SECTOR_RAMP,
  SECTOR_EXPOSURE_LEGEND_PROPS,
  SparklineRow,
  type CalendarPoint,
  type HeatmapCell,
} from '../components/charts'
import {
  useCrossDomainReadiness,
  useSleepStageHistory,
  useSectorExposure,
  useMetricRollingAverages,
} from '../hooks/useAggregations'
import { useApiCall } from '../hooks/useApiCall'
import { useToast } from '../components/Toast'
import GreetingHeader from '../components/GreetingHeader'
import { useCountUp } from '../hooks/useCountUp'

function formatTooltipDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00')
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

interface SchedulerJob {
  name: string
  cron: string
  lastRun: number | null
}

interface HoldingWithLive {
  id: number
  symbol: string
  quantity: number
  cost_basis: number
  current_price: number | null
  market_value: number | null
  unrealized_pl: number | null
  unrealized_pl_percent: number | null
  weight_percent: number | null
}

interface PortfolioSummary {
  totalValue: number
  totalCost: number
  unrealizedPL: number
  unrealizedPLPercent: number
  dayChange: number
  dayChangePercent: number
  holdings: HoldingWithLive[]
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

interface WatchlistRow {
  symbol: string
  type: 'stock' | 'crypto' | 'etf'
  name: string | null
}

interface RecoveryReadiness {
  score: number
  status: 'ready' | 'moderate' | 'rest'
  components: { sleepScore: number; hrvScore: number; exerciseLoad: number }
  recommendation: string
}

interface TrainingLoad {
  ctl: number
  atl: number
  tsb: number
  trainingStatus: string
  trainingStatusLabel: string
}

interface SleepRegularity {
  sri: number
  interpretation: 'excellent' | 'good' | 'fair' | 'poor'
}

interface AlertRow {
  id: number
  symbol: string
  type: string
  threshold: number
  active: number
  last_fired_at: string | null
}

interface ScheduleBlock {
  time: string
  activity: string
  rationale?: string
}

interface WeekendActivity {
  time: string
  activity: string
  location: string
}

interface WeekendPlanStored {
  weekend_date: string
  plan_json: string
}

interface AppSettings {
  relayUrl?: string
  relayToken?: string
  claudeApiKey?: string
  onboardingDismissed?: boolean
}

interface SleepAnalysisData {
  quality?: { overall?: number }
  debt?: { currentDebt?: number; debtCategory?: string }
}

interface DashboardApi {
  checkAIConnection: () => Promise<{ ok: boolean; mode: string; error?: string }>
  getSchedulerStatus: () => Promise<SchedulerJob[]>
  getSleepAnalysis: () => Promise<SleepAnalysisData | null>
  getRecoveryReadiness: () => Promise<RecoveryReadiness | null>
  getTrainingLoad: (days: number) => Promise<TrainingLoad | null>
  getSleepRegularity: () => Promise<SleepRegularity | null>
  getWeekendPlan: () => Promise<WeekendPlanStored | null>
  listAlerts: () => Promise<AlertRow[]>
  refreshNews?: () => Promise<unknown>
  onBriefingNew: (callback: () => void) => () => void
  onFinanceUpdated: (callback: () => void) => () => void
}

interface DayMover {
  symbol: string
  dayPL: number
  dayPct: number
}

interface PortfolioStats {
  byType: Record<'stock' | 'crypto' | 'etf' | 'other', number>
  topHoldings: HoldingWithLive[]
  topGainer: DayMover | undefined
  topLoser: DayMover | undefined
}

interface WatchlistStats {
  byType: Record<'stock' | 'crypto' | 'etf', number>
  topGainer: LatestPrice | undefined
  topLoser: LatestPrice | undefined
  avgChange: number
  upCount: number
  downCount: number
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error')
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const dashboardApi = window.api as typeof window.api & DashboardApi
  const [prices, setPrices] = useState<LatestPrice[]>([])
  const [watchlist, setWatchlist] = useState<WatchlistRow[]>([])
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null)
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [schedulerJobs, setSchedulerJobs] = useState<SchedulerJob[]>([])
  const [generating, setGenerating] = useState(false)
  const [notionStatus, setNotionStatus] = useState<string | null>(null)
  const [sleepScore, setSleepScore] = useState<number | null>(null)
  const [sleepDebt, setSleepDebt] = useState<{ debt: number; category: string } | null>(null)
  const [recovery, setRecovery] = useState<RecoveryReadiness | null>(null)
  const [trainingLoad, setTrainingLoad] = useState<TrainingLoad | null>(null)
  const [regularity, setRegularity] = useState<SleepRegularity | null>(null)
  const [todaySchedule, setTodaySchedule] = useState<DailySchedule | null>(null)
  const [weekendPlan, setWeekendPlan] = useState<WeekendPlanStored | null>(null)
  const [alerts, setAlerts] = useState<AlertRow[]>([])
  const [aiStatus, setAiStatus] = useState<{ ok: boolean; mode: string; error?: string } | null>(
    null,
  )
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [sleepConsistencyRange, setSleepConsistencyRange] = useState<SleepConsistencyRange>('90d')
  const sleepConsistencyConfig =
    SLEEP_CONSISTENCY_RANGES.find((r) => r.id === sleepConsistencyRange) ||
    SLEEP_CONSISTENCY_RANGES[0]

  // Cross-domain composite + visualization data — manual-refresh model.
  const readinessQ = useCrossDomainReadiness()
  const stageHistoryQ = useSleepStageHistory(sleepConsistencyConfig.days)
  const sectorQ = useSectorExposure()
  const sleepRollingQ = useMetricRollingAverages('sleep', [7], 30)
  const hrvRollingQ = useMetricRollingAverages('hrv', [7], 30)

  const reportLoadError = useCallback(
    (label: string, err: unknown) => {
      showToast(`${label}: ${getErrorMessage(err)}`, 'error')
    },
    [showToast],
  )

  const loadDashboardData = useCallback(async () => {
    const run = async <T,>(label: string, task: () => Promise<T>, onData: (data: T) => void) => {
      try {
        onData(await task())
      } catch (err) {
        reportLoadError(label, err)
      }
    }

    await Promise.all([
      run('AI status failed to load', () => dashboardApi.checkAIConnection(), setAiStatus),
      run(
        'Settings failed to load',
        () => window.api.getSettings('appSettings'),
        (raw) => {
          const s = (raw as AppSettings | null) || {}
          const hasRelay = !!(s.relayUrl && s.relayToken)
          const hasApiKey = !!s.claudeApiKey
          if (!hasRelay && !hasApiKey && !s.onboardingDismissed) {
            setShowOnboarding(true)
          }
        },
      ),
      run('Prices failed to load', () => window.api.getLatestPrices(), setPrices),
      run(
        'Watchlist failed to load',
        () => window.api.getWatchlist(),
        (rows) => setWatchlist((rows as WatchlistRow[]) || []),
      ),
      run('Portfolio failed to load', () => window.api.getPortfolioSummary(), setPortfolio),
      run('Latest briefing failed to load', () => window.api.getLatestBriefing(), setBriefing),
      run(
        'Scheduler status failed to load',
        () => dashboardApi.getSchedulerStatus(),
        setSchedulerJobs,
      ),
      run(
        'Sleep analysis failed to load',
        () => dashboardApi.getSleepAnalysis(),
        (data) => {
          if (data?.quality?.overall != null) setSleepScore(data.quality.overall)
          if (data?.debt?.currentDebt != null) {
            setSleepDebt({
              debt: data.debt.currentDebt,
              category: data.debt.debtCategory || 'unknown',
            })
          }
        },
      ),
      run(
        'Recovery readiness failed to load',
        () => dashboardApi.getRecoveryReadiness(),
        setRecovery,
      ),
      run('Training load failed to load', () => dashboardApi.getTrainingLoad(60), setTrainingLoad),
      run(
        'Sleep regularity failed to load',
        () => dashboardApi.getSleepRegularity(),
        setRegularity,
      ),
      run('Today schedule failed to load', () => window.api.getTodaySchedule(), setTodaySchedule),
      run('Weekend plan failed to load', () => dashboardApi.getWeekendPlan(), setWeekendPlan),
      run(
        'Alerts failed to load',
        () => dashboardApi.listAlerts(),
        (rows) => setAlerts(rows || []),
      ),
    ])
  }, [dashboardApi, reportLoadError])

  useApiCall(loadDashboardData, { deps: [loadDashboardData] })

  useEffect(() => {
    // News freshness: ping the RSS fetcher when the dashboard opens, but
    // throttle so flipping tabs doesn't hammer the relay/Google News.
    const LAST_KEY = 'dashboard:lastNewsRefresh'
    const THROTTLE_MS = 10 * 60 * 1000
    const last = Number(localStorage.getItem(LAST_KEY) || 0)
    if (Date.now() - last > THROTTLE_MS) {
      localStorage.setItem(LAST_KEY, String(Date.now()))
      dashboardApi
        .refreshNews?.()
        .catch((err: unknown) => reportLoadError('News refresh failed', err))
    }

    const cleanupBriefing = dashboardApi.onBriefingNew(() => {
      window.api
        .getLatestBriefing()
        .then(setBriefing)
        .catch((err) => reportLoadError('Latest briefing failed to load', err))
    })
    const cleanupFinance = dashboardApi.onFinanceUpdated(() => {
      window.api
        .getLatestPrices()
        .then(setPrices)
        .catch((err) => reportLoadError('Prices failed to refresh', err))
      window.api
        .getPortfolioSummary()
        .then(setPortfolio)
        .catch((err) => reportLoadError('Portfolio failed to refresh', err))
    })

    return () => {
      cleanupBriefing()
      cleanupFinance()
    }
  }, [dashboardApi, reportLoadError])

  const dismissOnboarding = async () => {
    setShowOnboarding(false)
    try {
      const current = ((await window.api.getSettings('appSettings')) as AppSettings | null) || {}
      await window.api.setSettings('appSettings', { ...current, onboardingDismissed: true })
    } catch {}
  }

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      await window.api.generateBriefing('morning_finance')
      const latest = await window.api.getLatestBriefing()
      setBriefing(latest)
    } catch (err) {
      console.error('Failed to generate briefing:', err)
    }
    setGenerating(false)
  }

  // Map watchlist symbol → type for asset-class breakdown of holdings
  const typeBySymbol = useMemo(() => {
    const m = new Map<string, 'stock' | 'crypto' | 'etf'>()
    for (const w of watchlist) m.set(w.symbol, w.type)
    return m
  }, [watchlist])

  const hasHoldings = !!portfolio && portfolio.holdings.length > 0

  // Portfolio analytics derived from real holdings
  const portfolioStats = useMemo<PortfolioStats | null>(() => {
    if (!hasHoldings || !portfolio) return null

    const byType: PortfolioStats['byType'] = { stock: 0, crypto: 0, etf: 0, other: 0 }
    for (const h of portfolio.holdings) {
      const t = typeBySymbol.get(h.symbol) || 'other'
      byType[t] = (byType[t] ?? 0) + (h.market_value ?? 0)
    }

    const sortedByValue = [...portfolio.holdings]
      .filter((h) => h.market_value != null)
      .sort((a, b) => (b.market_value ?? 0) - (a.market_value ?? 0))

    const sortedByDay = [...portfolio.holdings]
      .filter((h) => h.market_value != null && h.current_price != null)
      .map((h) => {
        const live = prices.find((p) => p.symbol === h.symbol)
        return {
          symbol: h.symbol,
          dayPL: live ? live.change * h.quantity : 0,
          dayPct: live ? live.changePercent : 0,
        }
      })
      .sort((a, b) => b.dayPL - a.dayPL)

    return {
      byType,
      topHoldings: sortedByValue.slice(0, 4),
      topGainer: sortedByDay[0],
      topLoser: sortedByDay[sortedByDay.length - 1],
    }
  }, [hasHoldings, portfolio, prices, typeBySymbol])

  // Watchlist (no holdings) view: composition + day movers
  const watchlistStats = useMemo<WatchlistStats | null>(() => {
    if (hasHoldings || prices.length === 0) return null

    const byType: WatchlistStats['byType'] = { stock: 0, crypto: 0, etf: 0 }
    for (const p of prices) {
      const t = typeBySymbol.get(p.symbol)
      if (t) byType[t] = (byType[t] ?? 0) + 1
    }

    const sorted = [...prices].sort((a, b) => b.changePercent - a.changePercent)
    const avgChange = prices.reduce((s, p) => s + p.changePercent, 0) / prices.length
    const upCount = prices.filter((p) => p.change > 0).length

    return {
      byType,
      topGainer: sorted[0],
      topLoser: sorted[sorted.length - 1],
      avgChange,
      upCount,
      downCount: prices.length - upCount,
    }
  }, [hasHoldings, prices, typeBySymbol])

  const activeAlerts = alerts.filter((a) => a.active === 1)
  const recentlyFired = alerts.filter((a) => a.last_fired_at).slice(0, 3)

  const scheduleBlocks: ScheduleBlock[] = useMemo(() => {
    if (!todaySchedule?.schedule_json) return []
    try {
      return JSON.parse(todaySchedule.schedule_json)
    } catch {
      return []
    }
  }, [todaySchedule])

  const upcomingBlocks = useMemo(() => {
    if (scheduleBlocks.length === 0) return []
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    return scheduleBlocks
      .map((b) => {
        const start = b.time?.split('-')[0]?.trim() || '00:00'
        const [h, m] = start.split(':').map(Number)
        return { ...b, startMin: (h || 0) * 60 + (m || 0) }
      })
      .filter((b) => b.startMin >= nowMin - 30)
      .slice(0, 4)
  }, [scheduleBlocks])

  const weekendPreview = useMemo(() => {
    if (!weekendPlan?.plan_json) return null
    try {
      const parsed = JSON.parse(weekendPlan.plan_json) as {
        saturday?: WeekendActivity[]
        sunday?: WeekendActivity[]
      }
      return {
        date: weekendPlan.weekend_date,
        satCount: parsed.saturday?.length ?? 0,
        sunCount: parsed.sunday?.length ?? 0,
        first: parsed.saturday?.[0] ?? parsed.sunday?.[0] ?? null,
      }
    } catch {
      return null
    }
  }, [weekendPlan])

  const readinessData = readinessQ.data as CrossDomainData | null
  const sleepTrend = (sleepRollingQ.data as TrendPoint[] | null) || []
  const hrvTrend = (hrvRollingQ.data as TrendPoint[] | null) || []

  const greetingSubtitle = useMemo(() => {
    const bits: string[] = []
    if (recovery) bits.push(`Recovery ${recovery.score} · ${recovery.status}`)
    if (sleepScore != null) bits.push(`Sleep ${sleepScore}/100`)
    if (hasHoldings && portfolio)
      bits.push(
        `Portfolio ${portfolio.dayChangePercent >= 0 ? '+' : ''}${portfolio.dayChangePercent.toFixed(2)}% today`,
      )
    return bits.slice(0, 3).join('  ·  ') || "Here's your day at a glance."
  }, [recovery, sleepScore, hasHoldings, portfolio])

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <GreetingHeader subtitle={greetingSubtitle} />
        {aiStatus && (
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            {aiStatus.ok ? (
              <>
                <Wifi size={12} style={{ color: 'var(--accent-green)' }} />
                <span style={{ color: 'var(--accent-green)' }}>
                  AI {aiStatus.mode === 'relay' ? '(Relay)' : '(Direct)'}
                </span>
              </>
            ) : (
              <>
                <WifiOff size={12} style={{ color: 'var(--accent-red)' }} />
                <span style={{ color: 'var(--accent-red)' }}>
                  AI Offline{aiStatus.error ? ` — ${aiStatus.error}` : ''}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {showOnboarding && (
        <div
          className="rounded-lg p-4 flex items-start gap-3"
          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--accent-blue)' }}
        >
          <Sparkles
            size={20}
            style={{ color: 'var(--accent-blue)', flexShrink: 0, marginTop: 2 }}
          />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Welcome to Mien
            </h3>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              Set your relay URL + token, or paste a Claude API key, in Settings to enable AI
              features. See <code style={{ color: 'var(--accent-blue)' }}>SETUP.md</code> in the
              project folder for the full walkthrough.
            </p>
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => navigate('/settings')}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors"
                style={{ background: 'var(--accent-blue)', color: 'white' }}
              >
                <SettingsIcon size={12} />
                Open Settings
              </button>
              <button
                onClick={dismissOnboarding}
                className="text-xs px-3 py-1.5 rounded transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                Dismiss
              </button>
            </div>
          </div>
          <button
            onClick={dismissOnboarding}
            className="p-1 rounded transition-colors hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Dismiss onboarding"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Cross-Domain Readiness — hero composite (PR 4 of visualization overhaul) */}
      <CrossDomainHero
        data={readinessData}
        lastUpdated={readinessQ.lastUpdated}
        loading={readinessQ.loading}
        onRefresh={readinessQ.refresh}
        sleepTrend={sleepTrend}
        hrvTrend={hrvTrend}
      />

      {/* KPI Strip */}
      <div className="grid grid-cols-4 gap-4 rise-in" style={{ '--rise-delay': '60ms' } as React.CSSProperties}>
        <PortfolioKpi
          portfolio={portfolio}
          hasHoldings={hasHoldings}
          watchlistCount={prices.length}
          onClick={() => navigate(hasHoldings ? '/portfolio' : '/finance')}
        />
        <RecoveryKpi recovery={recovery} onClick={() => navigate('/health')} />
        <SleepKpi
          sleepScore={sleepScore}
          sleepDebt={sleepDebt}
          regularity={regularity}
          onClick={() => navigate('/health/sleep')}
        />
        <TrainingKpi trainingLoad={trainingLoad} onClick={() => navigate('/health/exercise')} />
      </div>

      {/* Investments panel — full width */}
      <InvestmentsPanel
        portfolio={portfolio}
        hasHoldings={hasHoldings}
        portfolioStats={portfolioStats}
        watchlistStats={watchlistStats}
        prices={prices}
        onNavigate={navigate}
      />

      {/* Today + Weekend + Alerts */}
      <div className="grid grid-cols-3 gap-4 rise-in" style={{ '--rise-delay': '120ms' } as React.CSSProperties}>
        <TodayCard
          schedule={todaySchedule}
          upcoming={upcomingBlocks}
          onNavigate={() => navigate('/productivity')}
        />
        <WeekendCard preview={weekendPreview} onNavigate={() => navigate('/weekend')} />
        <AlertsCard
          activeAlerts={activeAlerts}
          recentlyFired={recentlyFired}
          onNavigate={() => navigate('/finance')}
        />
      </div>

      {/* Visualization row — sleep consistency + sector exposure */}
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
          {(stageHistoryQ.data as Array<{ date: string; asleepHours: number }>)?.length ? (
            <div className="overflow-x-auto overflow-y-hidden pb-1">
              <CalendarHeatmap
                data={(
                  (stageHistoryQ.data as Array<{ date: string; asleepHours: number }>) || []
                ).map(
                  (d): CalendarPoint => ({
                    date: d.date,
                    value: d.asleepHours,
                    tooltip: `${formatTooltipDate(d.date)}: ${d.asleepHours.toFixed(1)}h asleep`,
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
              No sleep data yet — import Apple Health on the{' '}
              <Link to="/health" className="underline" style={{ color: 'var(--accent-blue)' }}>
                Health page
              </Link>
              .
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Sector Exposure"
          subtitle="Portfolio weight by sector"
          lastUpdated={sectorQ.lastUpdated}
          loading={sectorQ.loading}
          onRefresh={sectorQ.refresh}
        >
          {(sectorQ.data as Array<{ sector: string; weight: number }>)?.length ? (
            <>
              <HeatmapChart
                data={[
                  ((sectorQ.data as Array<{ sector: string; weight: number }>) || []).map(
                    (s): HeatmapCell => ({
                      value: s.weight,
                      label: `${s.weight.toFixed(0)}%`,
                      tooltip: `${s.sector}: ${s.weight.toFixed(1)}%`,
                    }),
                  ),
                ]}
                xLabels={((sectorQ.data as Array<{ sector: string; weight: number }>) || []).map(
                  (s) => s.sector.slice(0, 14),
                )}
                yLabels={['Weight']}
                cellSize={48}
                showValues
                rotateXLabels
                valueRange={[0, 100]}
                colorRamp={SECTOR_RAMP}
              />
              <GradientLegend {...SECTOR_EXPOSURE_LEGEND_PROPS} />
            </>
          ) : (
            <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              No holdings — add some in Portfolio.
            </div>
          )}
        </ChartCard>
      </div>

      {/* Briefing + Scheduler */}
      <div className="grid grid-cols-3 gap-4 max-h-[520px]">
        <div className="col-span-2 card flex flex-col overflow-hidden">
          <div className="flex items-center justify-between mb-4 shrink-0">
            <div className="flex items-center gap-2">
              <Sparkles size={16} style={{ color: 'var(--accent-purple)' }} />
              <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Latest Briefing
              </h3>
              {briefing && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {briefing.date} · {formatBriefingType(briefing.type)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {briefing && (
                <>
                  <button
                    onClick={async () => {
                      try {
                        await window.api.pushBriefingToNotion(briefing.id)
                        setNotionStatus('Sent!')
                        setTimeout(() => setNotionStatus(null), 3000)
                      } catch (err: any) {
                        setNotionStatus(`Failed: ${err.message}`)
                        setTimeout(() => setNotionStatus(null), 5000)
                      }
                    }}
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-colors"
                    style={{ color: 'var(--accent-blue)', background: 'var(--bg-tertiary)' }}
                  >
                    <Send size={10} />
                    Notion
                  </button>
                  {notionStatus && (
                    <span
                      className="text-[10px]"
                      style={{
                        color: notionStatus.startsWith('Failed')
                          ? 'var(--accent-red)'
                          : 'var(--accent-green)',
                      }}
                    >
                      {notionStatus}
                    </span>
                  )}
                </>
              )}
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="flex items-center gap-1.5 text-xs px-3.5 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                style={{ background: 'var(--accent-purple)', color: 'white' }}
              >
                <Sparkles size={12} className={generating ? 'animate-spin' : ''} />
                {generating ? 'Generating...' : 'Generate'}
              </button>
            </div>
          </div>
          {briefing ? (
            <div
              className="text-sm leading-relaxed overflow-y-auto flex-1 min-h-0"
              style={{ color: 'var(--text-secondary)' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(briefing.content) }}
            />
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No briefings yet. Configure AI in{' '}
              <Link to="/settings" className="underline" style={{ color: 'var(--accent-blue)' }}>
                Settings
              </Link>{' '}
              and generate your first briefing.
            </p>
          )}
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle2 size={16} style={{ color: 'var(--accent-amber)' }} />
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Scheduled Jobs
            </h3>
          </div>
          <div className="space-y-3">
            {schedulerJobs.map((job) => (
              <div key={job.name} className="flex items-start gap-2.5">
                <CheckCircle2
                  size={14}
                  className="mt-0.5 shrink-0"
                  style={{ color: 'var(--accent-green)', opacity: 0.8 }}
                />
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    {formatJobName(job.name)}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {job.lastRun
                      ? `Last: ${formatDistanceToNow(job.lastRun, { addSuffix: true })}`
                      : 'Not yet run'}
                  </p>
                </div>
              </div>
            ))}
            {schedulerJobs.length === 0 && (
              <div className="space-y-2">
                <div className="skeleton h-4 w-3/4" />
                <div className="skeleton h-4 w-1/2" />
                <div className="skeleton h-4 w-2/3" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- KPI cards ----------

function PortfolioKpi({
  portfolio,
  hasHoldings,
  watchlistCount,
  onClick,
}: {
  portfolio: PortfolioSummary | null
  hasHoldings: boolean
  watchlistCount: number
  onClick: () => void
}) {
  const [showValue, setShowValue] = useState(false)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onClick()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className="card card--interactive text-left"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Briefcase size={16} style={{ color: 'var(--accent-blue)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            Portfolio
          </span>
        </div>
        <ArrowUpRight size={12} style={{ color: 'var(--text-muted)' }} />
      </div>
      {hasHoldings && portfolio ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-2xl font-semibold tabular-nums">
              {showValue
                ? `$${portfolio.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : '$••••••'}
            </p>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setShowValue((current) => !current)
              }}
              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-white/[0.05]"
              style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
              aria-label={showValue ? 'Hide portfolio value' : 'Show portfolio value'}
            >
              {showValue ? <EyeOff size={12} /> : <Eye size={12} />}
              {showValue ? 'Hide' : 'Show'}
            </button>
          </div>
          {showValue ? (
            <>
              <div className="flex items-center gap-1.5 mt-1 text-sm">
                <span
                  className="flex items-center gap-0.5 tabular-nums"
                  style={{
                    color: portfolio.dayChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                  }}
                >
                  {portfolio.dayChange >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                  {portfolio.dayChange >= 0 ? '+' : ''}${Math.abs(portfolio.dayChange).toFixed(2)}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  ({portfolio.dayChangePercent >= 0 ? '+' : ''}
                  {portfolio.dayChangePercent.toFixed(2)}% today)
                </span>
              </div>
              <p className="text-xs mt-0.5 tabular-nums" style={{ color: 'var(--text-muted)' }}>
                All-time: {portfolio.unrealizedPL >= 0 ? '+' : ''}$
                {portfolio.unrealizedPL.toFixed(0)} ({portfolio.unrealizedPLPercent >= 0 ? '+' : ''}
                {portfolio.unrealizedPLPercent.toFixed(1)}%)
              </p>
            </>
          ) : (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Value hidden
            </p>
          )}
        </>
      ) : watchlistCount > 0 ? (
        <>
          <p className="text-2xl font-semibold tabular-nums">
            {watchlistCount}{' '}
            <span className="text-sm font-normal" style={{ color: 'var(--text-muted)' }}>
              watched
            </span>
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Add positions to track value
          </p>
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold" style={{ color: 'var(--text-muted)' }}>
            --
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Add stocks in Finance
          </p>
        </>
      )}
    </div>
  )
}

function RecoveryKpi({
  recovery,
  onClick,
}: {
  recovery: RecoveryReadiness | null
  onClick: () => void
}) {
  const color = recovery
    ? recovery.status === 'ready'
      ? 'var(--accent-green)'
      : recovery.status === 'moderate'
        ? 'var(--accent-amber)'
        : 'var(--accent-red)'
    : 'var(--text-muted)'
  const scoreCount = useCountUp(recovery?.score ?? 0)

  return (
    <button onClick={onClick} className="card card--interactive text-left">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Heart size={16} style={{ color: 'var(--accent-red)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            Recovery
          </span>
        </div>
        <ArrowUpRight size={12} style={{ color: 'var(--text-muted)' }} />
      </div>
      {recovery ? (
        <>
          <p className="font-display text-2xl font-extrabold tabular-nums">
            {scoreCount}
            <span className="text-sm font-normal ml-0.5" style={{ color: 'var(--text-muted)' }}>
              /100
            </span>
          </p>
          <p className="text-xs mt-1 capitalize" style={{ color }}>
            {recovery.status === 'ready'
              ? 'Ready to push'
              : recovery.status === 'moderate'
                ? 'Moderate'
                : 'Rest day'}
          </p>
          <div className="flex gap-2 mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span>Sleep {recovery.components.sleepScore}</span>
            <span>HRV {recovery.components.hrvScore}</span>
            <span>Load {recovery.components.exerciseLoad}</span>
          </div>
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold" style={{ color: 'var(--text-muted)' }}>
            --
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Need sleep + HRV data
          </p>
        </>
      )}
    </button>
  )
}

function SleepKpi({
  sleepScore,
  sleepDebt,
  regularity,
  onClick,
}: {
  sleepScore: number | null
  sleepDebt: { debt: number; category: string } | null
  regularity: SleepRegularity | null
  onClick: () => void
}) {
  const sleepCount = useCountUp(sleepScore ?? 0)
  return (
    <button onClick={onClick} className="card card--interactive text-left">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Moon size={16} style={{ color: 'var(--accent-purple)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            Sleep
          </span>
        </div>
        <ArrowUpRight size={12} style={{ color: 'var(--text-muted)' }} />
      </div>
      {sleepScore != null ? (
        <>
          <p className="font-display text-2xl font-extrabold tabular-nums">
            {sleepCount}
            <span className="text-sm font-normal ml-0.5" style={{ color: 'var(--text-muted)' }}>
              /100
            </span>
          </p>
          {sleepDebt && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Debt:{' '}
              <span
                style={{
                  color:
                    sleepDebt.debt > 4
                      ? 'var(--accent-red)'
                      : sleepDebt.debt > 2
                        ? 'var(--accent-amber)'
                        : 'var(--accent-green)',
                }}
              >
                {sleepDebt.debt.toFixed(1)}h
              </span>{' '}
              · {sleepDebt.category}
            </p>
          )}
          {regularity && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Regularity: {regularity.sri}/100 ({regularity.interpretation})
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold" style={{ color: 'var(--text-muted)' }}>
            --
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Connect Health Auto Export
          </p>
        </>
      )}
    </button>
  )
}

function TrainingKpi({
  trainingLoad,
  onClick,
}: {
  trainingLoad: TrainingLoad | null
  onClick: () => void
}) {
  return (
    <button onClick={onClick} className="card card--interactive text-left">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Dumbbell size={16} style={{ color: 'var(--accent-cyan)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            Training
          </span>
        </div>
        <ArrowUpRight size={12} style={{ color: 'var(--text-muted)' }} />
      </div>
      {trainingLoad ? (
        <>
          <p
            className="text-2xl font-semibold tabular-nums"
            title="Chronic Training Load — 42-day rolling fitness from all workouts"
          >
            {trainingLoad.ctl.toFixed(1)}
            <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-muted)' }}>
              fitness
            </span>
          </p>
          <p className="text-xs mt-1 capitalize" style={{ color: 'var(--text-secondary)' }}>
            {trainingLoad.trainingStatus}
          </p>
          <p
            className="text-[10px] mt-0.5 tabular-nums"
            style={{ color: 'var(--text-muted)' }}
            title="Form = Fitness minus Fatigue. Positive = fresh, negative = tired."
          >
            Form: {trainingLoad.tsb >= 0 ? '+' : ''}
            {trainingLoad.tsb.toFixed(1)} · Fatigue: {trainingLoad.atl.toFixed(1)}
          </p>
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold" style={{ color: 'var(--text-muted)' }}>
            --
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Log workouts to see load
          </p>
        </>
      )}
    </button>
  )
}

// ---------- Investments panel ----------

function InvestmentsPanel({
  portfolio,
  hasHoldings,
  portfolioStats,
  watchlistStats,
  prices,
  onNavigate,
}: {
  portfolio: PortfolioSummary | null
  hasHoldings: boolean
  portfolioStats: PortfolioStats | null
  watchlistStats: WatchlistStats | null
  prices: LatestPrice[]
  onNavigate: (path: string) => void
}) {
  const [showValue, setShowValue] = useState(false)

  if (hasHoldings && portfolio && portfolioStats) {
    const totalForPct = Object.values(portfolioStats.byType).reduce((sum, value) => sum + value, 0)
    const allocations = [
      { type: 'Stocks', value: portfolioStats.byType.stock, color: 'var(--accent-blue)' },
      { type: 'ETFs', value: portfolioStats.byType.etf, color: 'var(--accent-cyan)' },
      { type: 'Crypto', value: portfolioStats.byType.crypto, color: 'var(--accent-amber)' },
      { type: 'Other', value: portfolioStats.byType.other, color: 'var(--text-muted)' },
    ].filter((a) => a.value > 0)

    return (
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Briefcase size={16} style={{ color: 'var(--accent-blue)' }} />
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Investments
            </h3>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {portfolio.holdings.length} positions
            </span>
          </div>
          <button
            onClick={() => onNavigate('/portfolio')}
            className="text-xs flex items-center gap-1 hover:underline"
            style={{ color: 'var(--accent-blue)' }}
          >
            Full portfolio <ArrowUpRight size={11} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-5">
          {/* Allocation breakdown */}
          <div>
            <p
              className="text-xs uppercase tracking-wide mb-3"
              style={{ color: 'var(--text-muted)' }}
            >
              Allocation
            </p>
            {/* Horizontal stacked bar */}
            <div
              className="flex h-2 rounded-full overflow-hidden mb-3"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {allocations.map((a) => (
                <div
                  key={a.type}
                  style={{ width: `${(a.value / totalForPct) * 100}%`, background: a.color }}
                  title={`${a.type}: $${a.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                />
              ))}
            </div>
            <div className="space-y-1.5">
              {allocations.map((a) => (
                <div key={a.type} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm" style={{ background: a.color }} />
                    <span style={{ color: 'var(--text-secondary)' }}>{a.type}</span>
                  </div>
                  <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {((a.value / totalForPct) * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Top holdings by weight */}
          <div>
            <p
              className="text-xs uppercase tracking-wide mb-3"
              style={{ color: 'var(--text-muted)' }}
            >
              Top positions
            </p>
            <div className="space-y-2">
              {portfolioStats.topHoldings.map((h) => {
                const weight = h.weight_percent ?? 0
                const isUp = (h.unrealized_pl ?? 0) >= 0
                return (
                  <div key={h.id}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        {h.symbol}
                      </span>
                      <span
                        className="tabular-nums font-mono"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {weight.toFixed(1)}%
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div
                        className="flex-1 h-1 rounded-full overflow-hidden"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, weight)}%`,
                            background: 'var(--accent-blue)',
                          }}
                        />
                      </div>
                      <span
                        className="text-[10px] tabular-nums w-16 text-right"
                        style={{ color: isUp ? 'var(--accent-green)' : 'var(--accent-red)' }}
                      >
                        {isUp ? '+' : ''}
                        {(h.unrealized_pl_percent ?? 0).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Day movers */}
          <div>
            <p
              className="text-xs uppercase tracking-wide mb-3"
              style={{ color: 'var(--text-muted)' }}
            >
              Today's movers
            </p>
            {portfolioStats.topGainer && (
              <div className="mb-3">
                <div className="flex items-center justify-between text-xs">
                  <span
                    className="flex items-center gap-1.5"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <ArrowUpRight size={11} style={{ color: 'var(--accent-green)' }} />
                    {portfolioStats.topGainer.symbol}
                  </span>
                  <span className="tabular-nums font-mono" style={{ color: 'var(--accent-green)' }}>
                    +${portfolioStats.topGainer.dayPL.toFixed(2)}
                  </span>
                </div>
                <p
                  className="text-[10px] mt-0.5 tabular-nums"
                  style={{ color: 'var(--text-muted)' }}
                >
                  +{portfolioStats.topGainer.dayPct.toFixed(2)}% today
                </p>
              </div>
            )}
            {portfolioStats.topLoser &&
              portfolioStats.topLoser.symbol !== portfolioStats.topGainer?.symbol && (
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span
                      className="flex items-center gap-1.5"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      <ArrowDownRight size={11} style={{ color: 'var(--accent-red)' }} />
                      {portfolioStats.topLoser.symbol}
                    </span>
                    <span className="tabular-nums font-mono" style={{ color: 'var(--accent-red)' }}>
                      ${portfolioStats.topLoser.dayPL.toFixed(2)}
                    </span>
                  </div>
                  <p
                    className="text-[10px] mt-0.5 tabular-nums"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {portfolioStats.topLoser.dayPct.toFixed(2)}% today
                  </p>
                </div>
              )}
            {portfolio.totalCost > 0 && (
              <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--separator)' }}>
                <div className="flex items-center justify-between text-xs">
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowValue(!showValue) }}
                    className="flex items-center gap-1 transition-colors hover:opacity-80"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {showValue ? <EyeOff size={11} /> : <Eye size={11} />}
                    Cost basis
                  </button>
                  <span
                    className="tabular-nums font-mono"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {showValue ? `$${portfolio.totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '$••••••'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Watchlist-only view — no holdings entered
  if (watchlistStats && prices.length > 0) {
    const breakdown = [
      { type: 'Stocks', count: watchlistStats.byType.stock, color: 'var(--accent-blue)' },
      { type: 'ETFs', count: watchlistStats.byType.etf, color: 'var(--accent-cyan)' },
      { type: 'Crypto', count: watchlistStats.byType.crypto, color: 'var(--accent-amber)' },
    ].filter((b) => b.count > 0)

    return (
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity size={16} style={{ color: 'var(--accent-blue)' }} />
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Watchlist
            </h3>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {prices.length} symbols
            </span>
          </div>
          <button
            onClick={() => onNavigate('/portfolio')}
            className="text-xs flex items-center gap-1 hover:underline"
            style={{ color: 'var(--accent-blue)' }}
          >
            Add positions <ArrowUpRight size={11} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-5">
          <div>
            <p
              className="text-xs uppercase tracking-wide mb-3"
              style={{ color: 'var(--text-muted)' }}
            >
              Day breadth
            </p>
            <p className="text-2xl font-semibold tabular-nums">
              <span style={{ color: 'var(--accent-green)' }}>{watchlistStats.upCount}</span>
              <span className="mx-1.5" style={{ color: 'var(--text-muted)' }}>
                /
              </span>
              <span style={{ color: 'var(--accent-red)' }}>{watchlistStats.downCount}</span>
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Avg:{' '}
              <span
                style={{
                  color:
                    watchlistStats.avgChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                }}
              >
                {watchlistStats.avgChange >= 0 ? '+' : ''}
                {watchlistStats.avgChange.toFixed(2)}%
              </span>
            </p>
            <div className="mt-3 space-y-1">
              {breakdown.map((b) => (
                <div key={b.type} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm" style={{ background: b.color }} />
                    <span style={{ color: 'var(--text-secondary)' }}>{b.type}</span>
                  </div>
                  <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {b.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="col-span-2">
            <p
              className="text-xs uppercase tracking-wide mb-3"
              style={{ color: 'var(--text-muted)' }}
            >
              Day movers
            </p>
            <div className="space-y-2">
              {watchlistStats.topGainer && (
                <Mover price={watchlistStats.topGainer} accent="green" />
              )}
              {watchlistStats.topLoser &&
                watchlistStats.topLoser.symbol !== watchlistStats.topGainer?.symbol && (
                  <Mover price={watchlistStats.topLoser} accent="red" />
                )}
            </div>

            <div className="flex flex-wrap gap-2 mt-4">
              {prices.slice(0, 8).map((p) => (
                <div
                  key={p.symbol}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-xs"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {p.symbol}
                  </span>
                  <span
                    className="tabular-nums font-mono"
                    style={{
                      color: p.changePercent >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                    }}
                  >
                    {p.changePercent >= 0 ? '+' : ''}
                    {p.changePercent.toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        <Briefcase size={16} style={{ color: 'var(--accent-blue)' }} />
        <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Investments
        </h3>
      </div>
      <p className="text-sm py-6 text-center" style={{ color: 'var(--text-muted)' }}>
        No watchlist or positions yet. Add symbols on the{' '}
        <Link to="/finance" className="underline" style={{ color: 'var(--accent-blue)' }}>
          Finance page
        </Link>{' '}
        or positions on{' '}
        <Link to="/portfolio" className="underline" style={{ color: 'var(--accent-blue)' }}>
          Portfolio
        </Link>
        .
      </p>
    </div>
  )
}

function Mover({ price, accent }: { price: LatestPrice; accent: 'green' | 'red' }) {
  const color = accent === 'green' ? 'var(--accent-green)' : 'var(--accent-red)'
  return (
    <div
      className="flex items-center justify-between p-2 rounded"
      style={{ background: 'var(--bg-tertiary)' }}
    >
      <div className="flex items-center gap-2">
        {accent === 'green' ? (
          <TrendingUp size={12} style={{ color }} />
        ) : (
          <TrendingDown size={12} style={{ color }} />
        )}
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {price.symbol}
          </p>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            ${price.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>
      <span className="text-sm tabular-nums font-mono" style={{ color }}>
        {price.changePercent >= 0 ? '+' : ''}
        {price.changePercent.toFixed(2)}%
      </span>
    </div>
  )
}

// ---------- Today / Weekend / Alerts ----------

function TodayCard({
  schedule,
  upcoming,
  onNavigate,
}: {
  schedule: DailySchedule | null
  upcoming: Array<ScheduleBlock & { startMin: number }>
  onNavigate: () => void
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock size={16} style={{ color: 'var(--accent-amber)' }} />
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Today
          </h3>
        </div>
        <button
          onClick={onNavigate}
          className="text-xs flex items-center gap-1 hover:underline"
          style={{ color: 'var(--accent-blue)' }}
        >
          Open <ArrowUpRight size={11} />
        </button>
      </div>
      {schedule && upcoming.length > 0 ? (
        <div className="space-y-2.5">
          {upcoming.map((block, i) => (
            <div key={i} className="flex gap-2.5">
              <span
                className="text-[11px] font-mono w-24 shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                {block.time}
              </span>
              <p className="text-xs flex-1" style={{ color: 'var(--text-primary)' }}>
                {block.activity}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
          No schedule yet. Generate one in{' '}
          <Link to="/productivity" className="underline" style={{ color: 'var(--accent-blue)' }}>
            Productivity
          </Link>
          .
        </p>
      )}
    </div>
  )
}

function WeekendCard({
  preview,
  onNavigate,
}: {
  preview: {
    date: string
    satCount: number
    sunCount: number
    first: WeekendActivity | null
  } | null
  onNavigate: () => void
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Calendar size={16} style={{ color: 'var(--accent-purple)' }} />
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Weekend
          </h3>
        </div>
        <button
          onClick={onNavigate}
          className="text-xs flex items-center gap-1 hover:underline"
          style={{ color: 'var(--accent-blue)' }}
        >
          Open <ArrowUpRight size={11} />
        </button>
      </div>
      {preview ? (
        <>
          <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
            {preview.date}
          </p>
          <div className="flex gap-4 mb-3">
            <div>
              <p className="text-lg font-semibold tabular-nums">{preview.satCount}</p>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Sat activities
              </p>
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums">{preview.sunCount}</p>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Sun activities
              </p>
            </div>
          </div>
          {preview.first && (
            <div className="pt-3" style={{ borderTop: '1px solid var(--separator)' }}>
              <p
                className="text-[10px] uppercase tracking-wide mb-1"
                style={{ color: 'var(--text-muted)' }}
              >
                First up
              </p>
              <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                {preview.first.activity}
              </p>
              <div className="flex items-center gap-1 mt-0.5">
                <MapPin size={9} style={{ color: 'var(--text-muted)' }} />
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {preview.first.time} · {preview.first.location}
                </p>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
          No weekend plan yet. Generate one in{' '}
          <Link to="/weekend" className="underline" style={{ color: 'var(--accent-blue)' }}>
            Weekend
          </Link>
          .
        </p>
      )}
    </div>
  )
}

function AlertsCard({
  activeAlerts,
  recentlyFired,
  onNavigate,
}: {
  activeAlerts: AlertRow[]
  recentlyFired: AlertRow[]
  onNavigate: () => void
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bell size={16} style={{ color: 'var(--accent-orange)' }} />
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Alerts
          </h3>
        </div>
        <button
          onClick={onNavigate}
          className="text-xs flex items-center gap-1 hover:underline"
          style={{ color: 'var(--accent-blue)' }}
        >
          Manage <ArrowUpRight size={11} />
        </button>
      </div>
      <div className="flex gap-4 mb-3">
        <div>
          <p
            className="text-lg font-semibold tabular-nums"
            style={{ color: 'var(--accent-green)' }}
          >
            {activeAlerts.length}
          </p>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Active
          </p>
        </div>
        <div>
          <p
            className="text-lg font-semibold tabular-nums"
            style={{ color: 'var(--accent-orange)' }}
          >
            {recentlyFired.length}
          </p>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Recently fired
          </p>
        </div>
      </div>
      {recentlyFired.length > 0 ? (
        <div className="space-y-1.5 pt-3" style={{ borderTop: '1px solid var(--separator)' }}>
          {recentlyFired.map((a) => (
            <div key={a.id} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <Zap size={10} style={{ color: 'var(--accent-orange)' }} />
                <span style={{ color: 'var(--text-primary)' }}>{a.symbol}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {formatAlertType(a.type)} {a.threshold}
                </span>
              </span>
              {a.last_fired_at && (
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {formatDistanceToNow(new Date(a.last_fired_at), { addSuffix: true })}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : activeAlerts.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No alerts set. Create one in Finance.
        </p>
      ) : (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Watching {activeAlerts.length} threshold{activeAlerts.length === 1 ? '' : 's'} — nothing
          fired recently.
        </p>
      )}
    </div>
  )
}

function formatAlertType(t: string): string {
  switch (t) {
    case 'price_above':
      return '>'
    case 'price_below':
      return '<'
    case 'rsi_above':
      return 'RSI >'
    case 'rsi_below':
      return 'RSI <'
    case 'ma_cross_above':
      return 'MA↑'
    case 'ma_cross_below':
      return 'MA↓'
    default:
      return t
  }
}

function formatBriefingType(t: string): string {
  switch (t) {
    case 'morning_finance':
      return 'Morning Finance'
    case 'market_research':
      return 'Market Research'
    case 'health_weekly':
      return 'Health Weekly'
    case 'morning_sleep':
      return 'Morning Sleep'
    default:
      return t
  }
}

function formatJobName(name: string): string {
  const names: Record<string, string> = {
    'morning-briefing': 'Morning Briefing',
    'market-refresh': 'Market Data Refresh',
    'evening-health': 'Evening Health Sync',
    'relay-sync': 'Relay Sync',
    'morning-sleep-fallback': 'Morning Sleep Briefing',
    'wind-down-reminder': 'Wind-Down Reminder',
    'weekly-analysis': 'Weekly Deep Analysis',
  }
  return names[name] || name
}

// ---------- Cross-Domain Readiness Hero (PR 4) ----------

interface CrossDomainData {
  version: string
  score: number
  status: 'ready' | 'moderate' | 'rest'
  components: {
    sleep: number
    hrv: number
    trainingLoad: number
    marketStress: number
    calendarLoad: number
  }
  recommendation: string
}

interface TrendPoint {
  value: number | null
  rolling7?: number | null
}

function CrossDomainHero({
  data,
  lastUpdated,
  loading,
  onRefresh,
  sleepTrend,
  hrvTrend,
}: {
  data: CrossDomainData | null
  lastUpdated: number | null
  loading: boolean
  onRefresh: () => void
  sleepTrend: TrendPoint[]
  hrvTrend: TrendPoint[]
}) {
  const score = data?.score ?? 0
  const status = data?.status ?? 'rest'
  const recommendation =
    data?.recommendation ?? 'Connect health and finance data to populate cross-domain readiness.'
  const statusColor =
    status === 'ready'
      ? 'var(--accent-green)'
      : status === 'moderate'
        ? 'var(--accent-amber)'
        : 'var(--accent-red)'
  const sleepValues = sleepTrend.map((p) => p.value ?? 0).filter((v) => v > 0)
  const hrvValues = hrvTrend.map((p) => p.value ?? 0).filter((v) => v > 0)

  return (
    <ChartCard
      title="Cross-Domain Readiness"
      subtitle="Sleep + HRV + training + market stress + calendar load"
      lastUpdated={lastUpdated}
      loading={loading}
      onRefresh={onRefresh}
    >
      <div className="grid grid-cols-5 gap-4 items-center">
        <div className="col-span-2 flex flex-col items-center">
          <RadialGauge
            value={score}
            min={0}
            max={100}
            label={status.toUpperCase()}
            unit="/100"
            size={180}
            thresholds={[
              { at: 0, color: 'var(--accent-red)' },
              { at: 45, color: 'var(--accent-amber)' },
              { at: 70, color: 'var(--accent-green)' },
            ]}
          />
          <p className="text-sm mt-3 text-center px-2 max-w-xs" style={{ color: statusColor }}>
            {recommendation}
          </p>
        </div>

        <div className="col-span-3 grid grid-cols-2 gap-3">
          <ComponentRow
            label="Sleep"
            tooltip="Sleep quality score (debt, efficiency, consistency)"
            value={data?.components.sleep ?? 0}
            color="var(--accent-purple)"
            trend={sleepValues}
          />
          <ComponentRow
            label="HRV"
            tooltip="Heart rate variability vs your baseline"
            value={data?.components.hrv ?? 0}
            color="var(--accent-cyan)"
            trend={hrvValues}
          />
          <ComponentRow
            label="Training"
            tooltip="Exercise recovery balance (rest vs load)"
            value={data?.components.trainingLoad ?? 0}
            color="var(--accent-blue)"
          />
          <ComponentRow
            label="Market"
            tooltip="Portfolio stress (drawdown + volatility)"
            value={data?.components.marketStress ?? 0}
            color="var(--accent-amber)"
          />
          <ComponentRow
            label="Calendar"
            tooltip="Schedule load (fewer work hours = higher)"
            value={data?.components.calendarLoad ?? 0}
            color="var(--accent-orange)"
          />
        </div>
      </div>
    </ChartCard>
  )
}

function ComponentRow({
  label,
  tooltip,
  value,
  color,
  trend,
}: {
  label: string
  tooltip?: string
  value: number
  color: string
  trend?: number[]
}) {
  return (
    <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-tertiary)' }} title={tooltip}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span className="text-base font-semibold tabular-nums" style={{ color }}>
          {Math.round(value)}
          <span className="text-[9px] font-normal opacity-60">/100</span>
        </span>
      </div>
      {trend && trend.length >= 3 ? (
        <SparklineRow data={trend} height={18} strokeColor={color} fillBelow />
      ) : (
        <div className="h-[18px]" />
      )}
    </div>
  )
}
