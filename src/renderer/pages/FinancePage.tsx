import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  TrendingUp,
  RefreshCw,
  Trash2,
  Sparkles,
  Bot,
  BarChart3,
  FileSearch,
  Globe,
  Activity,
  Shield,
  GitCompare,
  Play,
  Send,
  Check,
  Maximize2,
  X,
} from 'lucide-react'
import WatchlistTable from '../components/finance/WatchlistTable'
import AddSymbolForm from '../components/finance/AddSymbolForm'
import PriceChart from '../components/finance/PriceChart'
import NewsPanel from '../components/finance/NewsPanel'
import SummariesPanel from '../components/finance/SummariesPanel'
import UpcomingEarnings from '../components/finance/UpcomingEarnings'
import AlertsPanel from '../components/finance/AlertsPanel'
import {
  useWatchlist,
  useLatestPrices,
  useNews,
  useFinanceRefresh,
  useRiskMetrics,
  useFundamentals,
  useUpcomingEarnings,
  useHealthScores,
} from '../hooks/useFinanceData'
import { useAnalysisStream } from '../hooks/useAnalysisStream'
import { renderMarkdown } from '../lib/markdown'
import type { Briefing } from '../../shared/types/ipc.types'
import { useToast } from '../components/Toast'
import {
  ChartCard,
  GradientLegend,
  HeatmapChart,
  SECTOR_RAMP,
  SECTOR_EXPOSURE_LEGEND_PROPS,
  CORRELATION_RAMP,
  CORRELATION_LEGEND_PROPS,
  SENTIMENT_LEGEND_PROPS,
  type HeatmapCell,
} from '../components/charts'
import {
  useCorrelationMatrix,
  useSectorExposure,
  useSentimentTimeSeries,
} from '../hooks/useAggregations'

export default function FinancePage() {
  const { showToast } = useToast()
  const { watchlist, add, remove, refresh: refreshWatchlist } = useWatchlist()
  const {
    prices,
    loading: pricesLoading,
    refreshing: pricesRefreshing,
    refresh: refreshPrices,
  } = useLatestPrices()
  const { news, loading: newsLoading, refresh: refreshNews } = useNews()
  const { refreshing, refresh: refreshAll } = useFinanceRefresh()
  const { metrics: riskMetrics, refresh: refreshRiskMetrics } = useRiskMetrics()
  const {
    fundamentals,
    refresh: refreshFundamentals,
    refreshNetwork: refreshFundamentalsNetwork,
    refreshing: refreshingFundamentals,
  } = useFundamentals()
  const { earnings: upcomingEarnings, refresh: refreshEarnings } = useUpcomingEarnings(7)
  const { scores: healthScores, refresh: refreshHealthScores } = useHealthScores()
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [generatingBriefing, setGeneratingBriefing] = useState(false)
  const [skillResult, setSkillResult] = useState<string | null>(null)
  const [runningSkill, setRunningSkill] = useState<string | null>(null)
  const { streamingContent, reset: resetStream } = useAnalysisStream()
  const [refreshingYT, setRefreshingYT] = useState(false)
  const [refreshingNews, setRefreshingNews] = useState(false)
  const [refreshingWatchlistData, setRefreshingWatchlistData] = useState(false)
  const [ytStatus, setYtStatus] = useState<string | null>(null)
  const [newsStatus, setNewsStatus] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [notionStatus, setNotionStatus] = useState<string | null>(null)
  const [correlationExpanded, setCorrelationExpanded] = useState(false)

  useEffect(() => {
    window.api
      .getLatestBriefing('morning_finance')
      .then(setBriefing)
      .catch((err: any) => showToast(err.message || 'Failed to load finance briefing', 'error'))
  }, [])

  // Reset confirm state when symbol changes
  useEffect(() => {
    setConfirmRemove(false)
    if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
  }, [selectedSymbol])

  const handleGenerateBriefing = async () => {
    setGeneratingBriefing(true)
    try {
      await window.api.generateBriefing('morning_finance')
      const latest = await window.api.getLatestBriefing('morning_finance')
      setBriefing(latest)
    } catch (err: any) {
      console.error('Failed to generate briefing:', err)
    }
    setGeneratingBriefing(false)
  }

  useEffect(() => {
    if (watchlist.length > 0) {
      refreshPrices()
    }
  }, [watchlist.length, refreshPrices])

  const refreshWatchlistData = async (includeNews = false) => {
    setRefreshingWatchlistData(true)
    try {
      await refreshAll()
      await refreshFundamentalsNetwork()
      await Promise.all([
        refreshWatchlist(),
        refreshPrices(),
        includeNews ? refreshNews() : Promise.resolve(),
        refreshRiskMetrics(),
        refreshFundamentals(),
        refreshEarnings(),
        refreshHealthScores(),
      ])
    } finally {
      setRefreshingWatchlistData(false)
    }
  }

  const handleRefresh = async () => {
    await refreshWatchlistData(true)
  }

  const handleFundamentalsRefresh = async () => {
    await refreshFundamentalsNetwork()
    await refreshEarnings()
  }

  const handleRemove = useCallback(
    (symbol: string) => {
      if (!confirmRemove) {
        setConfirmRemove(true)
        removeTimerRef.current = setTimeout(() => setConfirmRemove(false), 3000)
        return
      }
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      setConfirmRemove(false)
      remove(symbol).then(() => {
        if (selectedSymbol === symbol) setSelectedSymbol(null)
        refreshPrices()
      })
    },
    [confirmRemove, remove, selectedSymbol, refreshPrices],
  )

  const handleRunSkill = async (skill: string) => {
    setRunningSkill(skill)
    setSkillResult(null)
    resetStream()
    try {
      const result = await window.api.runFinanceSkill(
        skill,
        skill === 'market-research' ? undefined : selectedSymbol || undefined,
      )
      setSkillResult(result)
    } catch (err: any) {
      setSkillResult(`Error: ${err.message}`)
    }
    setRunningSkill(null)
  }

  const [technicals, setTechnicals] = useState<any>(null)

  // PR 6 — visualization aggregations (manual refresh)
  const correlationsQ = useCorrelationMatrix()
  const sectorQ = useSectorExposure()
  const sentimentQ = useSentimentTimeSeries(selectedSymbol || undefined, 30)

  useEffect(() => {
    if (selectedSymbol) {
      window.api
        .getTechnicals(selectedSymbol)
        .then(setTechnicals)
        .catch(() => setTechnicals(null))
    } else {
      setTechnicals(null)
    }
  }, [selectedSymbol])

  // While streaming, render the live partial response; after it lands,
  // render the final saved result.
  const displayedSkillText = skillResult ?? (runningSkill ? streamingContent : null)
  const renderedSkillResult = useMemo(
    () => (displayedSkillText ? renderMarkdown(displayedSkillText) : null),
    [displayedSkillText],
  )

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Finance
        </h2>
        <button
          onClick={handleRefresh}
          disabled={refreshing || refreshingWatchlistData}
          className="flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
        >
          <RefreshCw
            size={14}
            className={refreshing || refreshingWatchlistData ? 'animate-spin' : ''}
          />
          {refreshing || refreshingWatchlistData ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <div className="col-span-3 card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                Watchlist
              </h3>
              <button
                onClick={() => refreshWatchlistData(false)}
                disabled={pricesRefreshing || refreshing || refreshingWatchlistData}
                className="p-1 rounded-md transition-colors hover:bg-white/5"
                title="Refresh prices"
              >
                <RefreshCw
                  size={12}
                  className={
                    pricesRefreshing || refreshing || refreshingWatchlistData ? 'animate-spin' : ''
                  }
                  style={{ color: 'var(--text-muted)' }}
                />
              </button>
            </div>
            {selectedSymbol && (
              <button
                onClick={() => handleRemove(selectedSymbol)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors hover:bg-white/5"
                style={{
                  color: confirmRemove ? 'white' : 'var(--accent-red)',
                  background: confirmRemove ? 'var(--accent-red)' : 'transparent',
                }}
              >
                <Trash2 size={12} />
                {confirmRemove ? 'Confirm?' : `Remove ${selectedSymbol}`}
              </button>
            )}
          </div>
          <WatchlistTable
            prices={prices}
            loading={pricesLoading}
            onSelect={setSelectedSymbol}
            selectedSymbol={selectedSymbol}
            riskMetrics={riskMetrics}
            fundamentals={fundamentals}
            healthScores={healthScores}
          />
          <AddSymbolForm onAdd={add} />
        </div>

        <div className="col-span-2 card">
          <h3 className="text-sm font-medium mb-4" style={{ color: 'var(--text-secondary)' }}>
            Price Chart
          </h3>
          <PriceChart symbol={selectedSymbol} />
          {technicals?.indicators && (
            <div
              className="mt-3 pt-3 border-t grid grid-cols-3 gap-2 text-xs"
              style={{ borderColor: 'var(--separator)' }}
            >
              {technicals.indicators.rsi14 != null && (
                <div className="p-1.5 rounded-md" style={{ background: 'var(--bg-tertiary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>RSI</span>
                  <p
                    className="font-mono font-semibold"
                    style={{
                      color:
                        technicals.indicators.rsi14 > 70
                          ? 'var(--accent-red)'
                          : technicals.indicators.rsi14 < 30
                            ? 'var(--accent-green)'
                            : 'var(--text-primary)',
                    }}
                  >
                    {technicals.indicators.rsi14.toFixed(1)}
                  </p>
                </div>
              )}
              {technicals.indicators.sma20 != null && (
                <div className="p-1.5 rounded-md" style={{ background: 'var(--bg-tertiary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>SMA 20</span>
                  <p className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
                    ${technicals.indicators.sma20.toFixed(2)}
                  </p>
                </div>
              )}
              {technicals.indicators.macdHistogram != null && (
                <div className="p-1.5 rounded-md" style={{ background: 'var(--bg-tertiary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>MACD</span>
                  <p
                    className="font-mono font-semibold"
                    style={{
                      color:
                        technicals.indicators.macdHistogram > 0
                          ? 'var(--accent-green)'
                          : 'var(--accent-red)',
                    }}
                  >
                    {technicals.indicators.macdHistogram > 0 ? '+' : ''}
                    {technicals.indicators.macdHistogram.toFixed(3)}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <UpcomingEarnings
        earnings={upcomingEarnings}
        onRefresh={handleFundamentalsRefresh}
        refreshing={refreshingFundamentals}
      />
      <AlertsPanel selectedSymbol={selectedSymbol} />

      {/* PR 6 visualization row — sector + correlation + sentiment */}
      <div className="grid grid-cols-3 gap-4">
        <ChartCard
          title="Sector Exposure"
          subtitle="By portfolio weight"
          lastUpdated={sectorQ.lastUpdated}
          loading={sectorQ.loading}
          onRefresh={sectorQ.refresh}
        >
          {(sectorQ.data as Array<{ sector: string; weight: number; value: number }>)?.length ? (
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
                cellSize={44}
                showValues
                rotateXLabels
                valueRange={[0, 100]}
                colorRamp={SECTOR_RAMP}
              />
              <GradientLegend {...SECTOR_EXPOSURE_LEGEND_PROPS} />
            </>
          ) : (
            <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              No holdings — sector breakdown will appear once you add positions.
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Correlation Matrix"
          subtitle="Daily returns · 60 days"
          lastUpdated={correlationsQ.lastUpdated}
          loading={correlationsQ.loading}
          onRefresh={correlationsQ.refresh}
          actions={(() => {
            const data = correlationsQ.data as { symbols?: string[]; matrix?: number[][] } | null
            return (data?.symbols?.length || 0) > 0 ? (
              <button
                onClick={() => setCorrelationExpanded(true)}
                className="p-1 rounded hover:bg-white/10 transition-colors"
                title="Expand correlation matrix"
                aria-label="Expand correlation matrix"
              >
                <Maximize2 size={14} style={{ color: 'var(--text-muted)' }} />
              </button>
            ) : null
          })()}
        >
          {(() => {
            const data = correlationsQ.data as { symbols?: string[]; matrix?: number[][] } | null
            const symbols = data?.symbols || []
            const matrix = data?.matrix || []
            if (symbols.length === 0 || matrix.length === 0) {
              return (
                <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                  Need at least 2 watchlist symbols with 10+ days of price data.
                </div>
              )
            }
            return (
              <div
                className="overflow-hidden cursor-pointer"
                onClick={() => setCorrelationExpanded(true)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCorrelationExpanded(true) } }}
                tabIndex={0}
                role="button"
                title="Click to expand"
              >
                <HeatmapChart
                  data={matrix.map((row) =>
                    row.map(
                      (v): HeatmapCell => ({
                        value: v,
                      }),
                    ),
                  )}
                  xLabels={symbols.map((s) => s.slice(0, 4))}
                  yLabels={symbols.map((s) => s.slice(0, 4))}
                  cellSize={symbols.length <= 10 ? 24 : 12}
                  showLabels={symbols.length <= 10}
                  valueRange={[-1, 1]}
                  colorRamp={CORRELATION_RAMP}
                />
                <GradientLegend {...CORRELATION_LEGEND_PROPS} />
              </div>
            )
          })()}
        </ChartCard>

        <ChartCard
          title="News Sentiment"
          subtitle={
            selectedSymbol
              ? `${selectedSymbol} - 30d, latest first`
              : 'All symbols - 30d, latest first'
          }
          lastUpdated={sentimentQ.lastUpdated}
          loading={sentimentQ.loading}
          onRefresh={sentimentQ.refresh}
        >
          {(() => {
            const series =
              (sentimentQ.data as Array<{
                date: string
                positive: number
                negative: number
                neutral: number
                score: number
              }>) || []
            if (series.length === 0) {
              return (
                <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                  News sentiment is built nightly. Run finance:refreshNews to populate.
                </div>
              )
            }
            const latestFirst = [...series].sort((a, b) => b.date.localeCompare(a.date))
            return (
              <>
                <div className="max-h-40 overflow-y-auto pr-1 space-y-1">
                  {latestFirst.map((p) => {
                    const total = p.positive + p.negative + p.neutral
                    const score = Math.max(-1, Math.min(1, p.score))
                    const positiveWidth = score > 0 ? `${score * 50}%` : '0%'
                    const negativeWidth = score < 0 ? `${Math.abs(score) * 50}%` : '0%'
                    const scoreLabel = `${score >= 0 ? '+' : ''}${score.toFixed(2)}`

                    return (
                      <div
                        key={p.date}
                        className="grid grid-cols-[2.25rem_1fr_2.5rem] items-center gap-2 text-[10px]"
                        title={`${p.date}: +${p.positive} / -${p.negative} / ${p.neutral} neutral`}
                      >
                        <span
                          className="font-mono tabular-nums"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {p.date.slice(5)}
                        </span>
                        <div
                          className="relative h-3 rounded-sm overflow-hidden"
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          <div
                            className="absolute right-1/2 top-0 h-full"
                            style={{ width: negativeWidth, background: '#ff453a99' }}
                          />
                          <div
                            className="absolute left-1/2 top-0 h-full"
                            style={{ width: positiveWidth, background: '#30d15899' }}
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
                              score > 0.05
                                ? 'var(--accent-green)'
                                : score < -0.05
                                  ? 'var(--accent-red)'
                                  : 'var(--text-muted)',
                          }}
                        >
                          {scoreLabel}
                        </span>
                        {total > 0 && (
                          <div
                            className="col-start-2 col-span-2 -mt-0.5 truncate"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {total} articles: {p.positive} positive, {p.negative} negative,{' '}
                            {p.neutral} neutral
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <GradientLegend {...SENTIMENT_LEGEND_PROPS} />
              </>
            )
          })()}
        </ChartCard>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3
              className="text-sm font-medium flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
            >
              <Bot size={14} style={{ color: 'var(--accent-green)' }} />
              AI Analysis
            </h3>
            <button
              onClick={handleGenerateBriefing}
              disabled={generatingBriefing || prices.length === 0}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-green)' }}
            >
              <Sparkles size={12} className={generatingBriefing ? 'animate-spin' : ''} />
              {generatingBriefing ? 'Analyzing...' : 'Generate'}
            </button>
          </div>
          {briefing ? (
            <>
              <div
                className="text-sm leading-relaxed max-h-96 overflow-y-auto markdown-content"
                style={{ color: 'var(--text-secondary)' }}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(briefing.content) }}
              />
              <div
                className="flex items-center gap-2 mt-3 pt-3 border-t"
                style={{ borderColor: 'var(--separator)' }}
              >
                <button
                  onClick={async () => {
                    try {
                      await window.api.pushBriefingToNotion(briefing.id)
                      setNotionStatus('Pushed to Notion!')
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
                  Push to Notion
                </button>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {briefing.date} · Saved to Briefing History
                </span>
                {notionStatus && (
                  <span
                    className="text-xs ml-auto"
                    style={{
                      color: notionStatus.startsWith('Failed')
                        ? 'var(--accent-red)'
                        : 'var(--accent-green)',
                    }}
                  >
                    {notionStatus}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {prices.length === 0
                ? 'Add stocks to your watchlist and refresh data first.'
                : 'Click Generate to get an AI analysis of your portfolio.'}
            </p>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              News
            </h3>
            <div className="flex items-center gap-2">
              {newsStatus && (
                <span className="text-xs" style={{ color: 'var(--accent-green)' }}>
                  {newsStatus}
                </span>
              )}
              {ytStatus && (
                <span className="text-xs" style={{ color: 'var(--accent-green)' }}>
                  {ytStatus}
                </span>
              )}
              <button
                onClick={async () => {
                  setRefreshingNews(true)
                  setNewsStatus(null)
                  try {
                    const result = await window.api.refreshNews()
                    setNewsStatus(`${result.inserted ?? 0} new articles`)
                    await refreshNews()
                    setTimeout(() => setNewsStatus(null), 3000)
                  } catch {
                    setNewsStatus('Failed')
                    setTimeout(() => setNewsStatus(null), 3000)
                  }
                  setRefreshingNews(false)
                }}
                disabled={refreshingNews}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
              >
                {refreshingNews ? (
                  <RefreshCw size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                {refreshingNews ? 'Fetching...' : 'News'}
              </button>
              <button
                onClick={async () => {
                  setRefreshingYT(true)
                  setYtStatus(null)
                  try {
                    const result = await window.api.refreshYoutube()
                    const fetched = Number(result.fetched ?? result.count ?? 0)
                    const inserted = Number(result.inserted ?? result.count ?? 0)
                    const failed = Number(result.failed ?? 0)
                    setYtStatus(
                      failed > 0
                        ? `${inserted} new / ${fetched} fetched (${failed} failed)`
                        : `${inserted} new / ${fetched} fetched`,
                    )
                    await refreshNews()
                    setTimeout(() => setYtStatus(null), 3000)
                  } catch (err: any) {
                    setYtStatus('Failed')
                    setTimeout(() => setYtStatus(null), 3000)
                  }
                  setRefreshingYT(false)
                }}
                disabled={refreshingYT}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40"
                style={{ background: 'var(--bg-tertiary)', color: '#ff0000' }}
              >
                {refreshingYT ? (
                  <RefreshCw size={12} className="animate-spin" />
                ) : (
                  <Play size={12} />
                )}
                {refreshingYT ? 'Fetching...' : 'YouTube'}
              </button>
            </div>
          </div>
          <NewsPanel news={news} loading={newsLoading} />
        </div>
      </div>

      {/* AI Summaries — paste a link, read saved summaries */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles size={15} style={{ color: '#a78bfa' }} />
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            AI Summaries
          </h3>
        </div>
        <SummariesPanel />
      </div>

      {/* Finance Skills */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3
            className="text-sm font-medium flex items-center gap-2"
            style={{ color: 'var(--text-primary)' }}
          >
            <TrendingUp size={14} style={{ color: 'var(--accent-blue)' }} />
            Finance Skills
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => handleRunSkill('earnings-review')}
              disabled={!selectedSymbol || runningSkill !== null}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-purple)' }}
              title={
                selectedSymbol ? `Earnings review for ${selectedSymbol}` : 'Select a stock first'
              }
            >
              <FileSearch
                size={12}
                className={runningSkill === 'earnings-review' ? 'animate-spin' : ''}
              />
              Earnings
            </button>
            <button
              onClick={() => handleRunSkill('valuation')}
              disabled={!selectedSymbol || runningSkill !== null}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-orange)' }}
              title={selectedSymbol ? `Valuation for ${selectedSymbol}` : 'Select a stock first'}
            >
              <BarChart3 size={12} className={runningSkill === 'valuation' ? 'animate-spin' : ''} />
              Valuation
            </button>
            <button
              onClick={() => handleRunSkill('technical-analysis')}
              disabled={!selectedSymbol || runningSkill !== null}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-green)' }}
              title={
                selectedSymbol ? `Technical analysis for ${selectedSymbol}` : 'Select a stock first'
              }
            >
              <Activity
                size={12}
                className={runningSkill === 'technical-analysis' ? 'animate-spin' : ''}
              />
              Technicals
            </button>
            <button
              onClick={() => handleRunSkill('market-research')}
              disabled={prices.length === 0 || runningSkill !== null}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
              title="Market research brief for full portfolio"
            >
              <Globe
                size={12}
                className={runningSkill === 'market-research' ? 'animate-spin' : ''}
              />
              Research
            </button>
            <button
              onClick={() => handleRunSkill('risk-assessment')}
              disabled={prices.length === 0 || runningSkill !== null}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-red)' }}
              title="Portfolio risk assessment"
            >
              <Shield
                size={12}
                className={runningSkill === 'risk-assessment' ? 'animate-spin' : ''}
              />
              Risk
            </button>
            <button
              onClick={() => handleRunSkill('sector-comparison')}
              disabled={prices.length === 0 || runningSkill !== null}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-amber)' }}
              title="Compare portfolio vs market benchmarks"
            >
              <GitCompare
                size={12}
                className={runningSkill === 'sector-comparison' ? 'animate-spin' : ''}
              />
              vs Market
            </button>
          </div>
        </div>
        {runningSkill && !streamingContent && (
          <p className="text-sm animate-pulse" style={{ color: 'var(--text-muted)' }}>
            Running {runningSkill} skill
            {selectedSymbol && runningSkill !== 'market-research' ? ` for ${selectedSymbol}` : ''}
            ...
          </p>
        )}
        {renderedSkillResult ? (
          <>
            <div
              className="text-sm leading-relaxed max-h-[32rem] overflow-y-auto markdown-content"
              style={{ color: 'var(--text-secondary)' }}
              dangerouslySetInnerHTML={{ __html: renderedSkillResult }}
            />
            <p
              className="text-[10px] mt-3 pt-2 border-t"
              style={{ borderColor: 'var(--separator)', color: 'var(--text-muted)' }}
            >
              Saved to Briefing History (Productivity page)
            </p>
          </>
        ) : (
          !runningSkill && (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {selectedSymbol
                ? `Select a skill to analyze ${selectedSymbol}. Research, Risk, and vs Market work on the full portfolio.`
                : 'Select a stock for Earnings, Valuation, or Technicals. Research, Risk, and vs Market work on the full portfolio.'}
            </p>
          )
        )}
      </div>
      {/* Correlation Matrix expanded overlay */}
      {correlationExpanded &&
        (() => {
          const data = correlationsQ.data as { symbols?: string[]; matrix?: number[][] } | null
          const symbols = data?.symbols || []
          const matrix = data?.matrix || []
          if (symbols.length === 0) return null
          const fullSize = Math.max(28, Math.min(44, Math.floor(900 / Math.max(1, symbols.length))))
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center"
              style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
              onClick={() => setCorrelationExpanded(false)}
              role="dialog"
              aria-modal="true"
              aria-labelledby="correlation-modal-title"
            >
              <div
                className="card relative overflow-auto"
                style={{ maxWidth: '90vw', maxHeight: '90vh', padding: 24 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 id="correlation-modal-title" className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      Correlation Matrix
                    </h3>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Daily returns · 60 days · {symbols.length} symbols
                    </p>
                  </div>
                  <button
                    onClick={() => setCorrelationExpanded(false)}
                    className="p-1.5 rounded hover:bg-white/10 transition-colors"
                    aria-label="Close"
                  >
                    <X size={16} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
                <HeatmapChart
                  data={matrix.map((row) =>
                    row.map(
                      (v): HeatmapCell => ({
                        value: v,
                        label: v.toFixed(2),
                        tooltip: `r=${v.toFixed(2)}`,
                      }),
                    ),
                  )}
                  xLabels={symbols.map((s) => s.slice(0, 5))}
                  yLabels={symbols.map((s) => s.slice(0, 5))}
                  cellSize={fullSize}
                  showValues
                  valueRange={[-1, 1]}
                  colorRamp={CORRELATION_RAMP}
                />
                <GradientLegend {...CORRELATION_LEGEND_PROPS} />
              </div>
            </div>
          )
        })()}
    </div>
  )
}
