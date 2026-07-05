import { BrowserWindow, app } from 'electron'
import { CACHE_TTL_MS, DEFAULT_CHART_DAYS } from '@shared/constants'
import * as fs from 'fs'
import * as nodePath from 'path'
import { execSync } from 'child_process'
import { isPasswordSet, setPassword, verifyPassword } from '../lib/auth'
import { applySleepOutlierExclusions, getDb } from '../db/database'
import { refreshAllFinanceData, getLatestPricesLive, getCachedPrices } from '../services/finance'
import { fetchYouTubeVideos, parseChannelsSetting } from '../services/finance/youtube.fetcher'
import { fetchYahooPrices } from '../services/finance/yahoo.fetcher'
import {
  chatWithStreaming,
  getChatHistory,
  clearChatHistory,
  listConversations,
  checkAIConnection,
} from '../services/ai.service'
import { generateBriefing, buildBriefingPrompt } from '../ai/briefing-generator'
import { exportMarkdown } from '../services/markdown-export.service'
import { dialog } from 'electron'
import { buildChatSystemPrompt } from '../ai/prompts'
import {
  getFinanceSkillPrompt,
  buildEarningsReviewPrompt,
  buildValuationPrompt,
  buildMarketResearchPrompt,
  buildTechnicalAnalysisPrompt,
  buildRiskAssessmentPrompt,
  buildSectorComparisonPrompt,
  type FinanceSkill,
} from '../ai/skills/finance'
import {
  generateAnalysis,
  generateAnalysisStreaming,
  type AnalysisOptions,
} from '../services/ai.service'
import { computeIndicators, computePortfolioRisk } from '../services/finance/technical-indicators'
import {
  getPriceTimeSeries,
  getPortfolioVsBenchmark,
  getCorrelationMatrix,
  getSectorExposure,
  getSentimentTimeSeries,
} from '../services/finance/aggregations'
import {
  getMetricRollingAverages,
  getSleepStageHistory,
  getCircadianPhases24h,
  getFitnessHistory,
} from '../services/health/aggregations'
import { getCrossDomainReadiness } from '../services/composite/readiness.service'
import { getEnergyAlignment } from '../services/composite/energy-alignment.service'
import { getCrossDomainCorrelations } from '../services/composite/correlation.service'
import {
  fetchFundamentals,
  refreshAllFundamentals,
  fetchEarningsCalendar,
  getFundamentals,
  getAllFundamentals,
  getUpcomingEarnings,
} from '../services/finance/alphavantage.fetcher'
import { scoreUnscoredArticles } from '../services/finance/news-sentiment.service'
import { archiveStaleNews, getNewsStats, fetchFinanceNews } from '../services/finance/news.fetcher'
import {
  getHealthScoresCached,
  invalidateHealthScoreCache,
} from '../services/finance/health-score.service'
import {
  listAlerts,
  createAlert,
  toggleAlert,
  removeAlert,
  checkAlerts,
  type AlertType,
} from '../services/finance/alerts.service'
import {
  listHealthAlerts,
  createHealthAlert,
  toggleHealthAlert,
  removeHealthAlert,
  checkHealthAlerts,
  type HealthAlertType,
} from '../services/health/health-alerts.service'
import {
  listHoldings,
  addHolding,
  updateHolding,
  removeHolding,
  importRobinhoodExport,
  getPortfolioSummary,
  getPortfolioValueHistory,
  type HoldingRow,
} from '../services/finance/portfolio.service'
import {
  importHealthFile,
  getHealthServerPort,
  recalculateSleepInBed,
  backfillSleepAwake,
} from '../services/health/health-export.service'
import {
  parseSleepSessions,
  calculateSleepDebt,
  predictCircadianRhythm,
  scoreSleepQuality,
  recommendWakeTime,
  recommendBedtime,
  buildSleepAnalysisContext,
  detectChronotype,
  calculateSocialJetLag,
  calculateCaffeineCutoff,
  calculateHrvRecovery,
  calculateSleepRegularityIndex,
  calculateRecoveryReadiness,
  calculateWorkoutSleepCorrelation,
  scoreSleepQualityBatch,
  calculateWindDownRoutine,
  analyzeSleepNeed,
  calculateEnergyCurve,
} from '../services/health/sleep-analysis'
import {
  predictOptimalWakeTime,
  saveWakePrediction,
  recordWakeOutcome,
  validateWakePredictions,
} from '../services/health/wake-prediction'
import {
  getFullFitnessAnalysis,
  calculateTrainingLoad,
  calculateRecovery,
  buildFitnessProfile,
  calculateHRZoneAnalysis,
  calculateHRSS,
  calculateYearProgression,
  calculateBestEfforts,
  calculateStreamZoneAnalysis,
  calculateBestSplits,
  calculateGradeAdjustedPace,
  calculateRunningPower,
  getFilteredFitnessAnalysis,
} from '../services/health/fitness-analysis'
import { syncStravaStreams } from '../services/health/strava.service'
import {
  syncTasks,
  getTodayTaskItems,
  pushBriefingToNotion,
  pushWeekendToNotion,
  pushScheduleToNotion,
  listNotionDatabases,
  pullBriefingsFromNotion,
} from '../services/notion/notion.sync'
import { getDbSchema } from '../services/notion/notion-schema'
import { getSchedulerStatus, getSchedulerActivity } from '../services/scheduler.service'
import {
  generateDailySchedule,
  updateTodaySchedule,
  tweakDailySchedule,
  type SchedulePreferences,
} from '../services/productivity/daily-planner.service'
import {
  generateWeekendPlan,
  getWeekendPlan,
  getAllWeekendPlans,
  getCachedWeekendEvents,
  fetchWeekendEvents,
  searchWeekendEvents,
  webSearchEvents,
  updateWeekendPlan,
  tweakWeekendPlan,
} from '../services/weekend/weekend-planner.service'
import {
  searchRestaurants,
  getSavedRestaurants,
  saveRestaurant,
  addManualRestaurant,
  updateRestaurant,
  removeSavedRestaurant,
  updateRestaurantNotes,
  editRestaurantCore,
  addVisit,
  updateVisit,
  removeVisit,
  getVisits,
  researchRestaurant,
  researchAllRestaurants,
  discoverRestaurants,
  autocompleteRestaurants,
  searchNearbyPlaces,
  getPlaceById,
  describePlace,
} from '../services/weekend/restaurants.service'
import {
  getDistanceFromHome,
  getWeekendAgendaMapImages,
  resolveRouteLocations,
} from '../services/weekend/distance.service'
import {
  syncWithRelay,
  pushSleepAnalysisToRelay,
  pullHistoricalSleepFromRelay,
  pullHealthFromRelay,
  pullStravaStreamsFromRelay,
} from '../services/sync.service'
import { getTunnelUrlState, getWatchedPath } from '../services/tunnel-url.service'
import type { BriefingType } from '../../shared/types/ipc.types'
import { safeHandle } from './safe-handle'
import { getAppSettings } from '../lib/settings'

let riskMetricsCache: {
  ts: number
  data: Record<string, { volatility: number; beta: number | null; maxDrawdown: number }>
} | null = null

export function registerFinanceHandlers(): void {
  safeHandle('finance:getWatchlist', () => {
    const db = getDb()

    return db.prepare('SELECT * FROM watchlist ORDER BY added_at DESC').all()
  })

  safeHandle(
    'finance:addToWatchlist',

    (symbol: string, type: string, name?: string) => {
      const db = getDb()

      db.prepare('INSERT OR IGNORE INTO watchlist (symbol, type, name) VALUES (?, ?, ?)').run(
        symbol.toUpperCase(),

        type,

        name || null,
      )
    },
  )

  safeHandle('finance:removeFromWatchlist', (symbol: string) => {
    const db = getDb()

    db.prepare('DELETE FROM watchlist WHERE symbol = ?').run(symbol.toUpperCase())
  })

  safeHandle('finance:getCachedPrices', () => {
    return getCachedPrices()
  })

  safeHandle('finance:getLatestPrices', async () => {
    return await getLatestPricesLive()
  })

  safeHandle('finance:getPrices', (symbol: string, days: number = DEFAULT_CHART_DAYS) => {
    const db = getDb()

    return db

      .prepare(
        `
  
        SELECT * FROM price_history
  
        WHERE symbol = ?
  
        ORDER BY date DESC
  
        LIMIT ?
  
      `,
      )

      .all(symbol.toUpperCase(), days)
  })

  safeHandle('finance:getNews', () => {
    const db = getDb()

    return db

      .prepare(
        `
  
        SELECT * FROM news_articles
  
        WHERE archived_at IS NULL
  
        ORDER BY
  
          COALESCE(published_at, fetched_at) DESC
  
        LIMIT 50
  
      `,
      )

      .all()
  })

  safeHandle('finance:getSummarizedNews', () => {
    const db = getDb()
    return db
      .prepare(
        `SELECT * FROM news_articles
         WHERE summary IS NOT NULL AND TRIM(summary) <> ''
         ORDER BY COALESCE(saved_at, published_at, fetched_at) DESC
         LIMIT 100`,
      )
      .all()
  })

  safeHandle('finance:toggleNewsSaved', (id: number, saved: boolean) => {
    const db = getDb()

    if (saved) {
      db.prepare(
        `
  
          UPDATE news_articles
  
          SET saved_at = COALESCE(saved_at, datetime('now'))
  
          WHERE id = ?
  
        `,
      ).run(id)
    } else {
      db.prepare('UPDATE news_articles SET saved_at = NULL WHERE id = ?').run(id)
    }

    return db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id)
  })

  safeHandle('finance:refreshNews', async () => {
    // Light-weight news-only refresh, used by the dashboard fetch-on-mount.

    // Sweeps stale articles first, then fetches fresh ones from RSS.

    const db = getDb()

    archiveStaleNews(7)

    const watchlist = db.prepare('SELECT symbol FROM watchlist').all() as Array<{ symbol: string }>

    const inserted = await fetchFinanceNews(watchlist.map((w) => w.symbol))

    return { ok: true, inserted, ...getNewsStats() }
  })

  safeHandle('finance:getNewsStats', () => getNewsStats())

  safeHandle('finance:refresh', async () => {
    const result = await refreshAllFinanceData()

    riskMetricsCache = null

    invalidateHealthScoreCache()

    const hasErrors = Object.keys(result.errors).length > 0

    return { status: hasErrors ? 'partial' : 'ok', ...result }
  })

  safeHandle('finance:refreshYoutube', async () => {
    const settings = getAppSettings()

    const channels = settings?.youtubeChannels
      ? parseChannelsSetting(settings.youtubeChannels)
      : undefined

    try {
      const result = await fetchYouTubeVideos(channels)

      return { status: 'ok', count: result.inserted, ...result }
    } catch (err) {
      const msg = (err as Error)?.message || String(err)

      console.error('[ipc] finance:refreshYoutube failed:', msg)

      return { status: 'error', count: 0, error: msg }
    }
  })

  safeHandle('finance:technicals', (symbol: string) => {
    return computeIndicators(symbol.toUpperCase())
  })

  safeHandle('holdings:list', () => {
    return listHoldings()
  })

  safeHandle(
    'holdings:add',

    (input: {
      symbol: string

      quantity: number

      cost_basis: number

      acquired_at?: string | null

      notes?: string | null
    }) => {
      const id = addHolding(input)

      return { id }
    },
  )

  safeHandle('holdings:update', (id: number, patch: Partial<HoldingRow>) => {
    updateHolding(id, patch)

    return { ok: true }
  })

  safeHandle('holdings:remove', (id: number) => {
    removeHolding(id)

    return { ok: true }
  })

  safeHandle('holdings:importRobinhood', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],

      title: 'Import Robinhood export',

      filters: [
        { name: 'CSV files', extensions: ['csv'] },

        { name: 'All files', extensions: ['*'] },
      ],
    })

    if (result.canceled || result.filePaths.length === 0) return null

    return importRobinhoodExport(result.filePaths[0])
  })

  safeHandle('portfolio:getSummary', async () => {
    return await getPortfolioSummary()
  })

  safeHandle('portfolio:getValueHistory', (days?: number) => {
    return getPortfolioValueHistory(days ?? 90)
  })

  safeHandle('finance:getFundamentals', (symbol?: string) => {
    if (symbol) return getFundamentals(symbol)

    return getAllFundamentals()
  })

  safeHandle('finance:refreshFundamentals', async (symbol?: string) => {
    if (symbol) {
      const row = await fetchFundamentals(symbol, true)

      return { count: row ? 1 : 0 }
    }

    const count = await refreshAllFundamentals()

    return { count }
  })

  safeHandle('finance:getEarningsCalendar', (days?: number) => {
    return getUpcomingEarnings(days ?? 7)
  })

  safeHandle('finance:refreshEarningsCalendar', async () => {
    const count = await fetchEarningsCalendar('3month')

    return { count }
  })

  safeHandle('finance:scoreNewsSentiment', async (max?: number) => {
    const count = await scoreUnscoredArticles(max ?? 200)

    invalidateHealthScoreCache()

    return { count }
  })

  safeHandle('finance:getHealthScores', () => {
    return getHealthScoresCached()
  })

  safeHandle('alerts:list', () => {
    return listAlerts()
  })

  safeHandle(
    'alerts:create',

    (input: {
      symbol: string

      type: AlertType

      threshold: number

      note?: string | null

      one_shot?: boolean
    }) => {
      const id = createAlert(input)

      return { id }
    },
  )

  safeHandle('alerts:toggle', (id: number, active: boolean) => {
    toggleAlert(id, active)

    return { ok: true }
  })

  safeHandle('alerts:remove', (id: number) => {
    removeAlert(id)

    return { ok: true }
  })

  safeHandle('alerts:checkNow', async () => {
    const hits = await checkAlerts()

    return { count: hits.length, hits }
  })

  safeHandle('finance:getRiskMetrics', () => {
    const now = Date.now()

    if (riskMetricsCache && now - riskMetricsCache.ts < CACHE_TTL_MS) return riskMetricsCache.data

    const db = getDb()

    const symbols = (
      db.prepare('SELECT symbol FROM watchlist').all() as Array<{ symbol: string }>
    ).map((r) => r.symbol)

    const risk = computePortfolioRisk([...symbols, 'SPY'])

    const data: Record<string, { volatility: number; beta: number | null; maxDrawdown: number }> =
      {}

    for (const sym of symbols) {
      data[sym] = {
        volatility: risk.volatilities.get(sym) ?? 0,

        beta: risk.betas.get(sym) ?? null,

        maxDrawdown: risk.maxDrawdowns.get(sym) ?? 0,
      }
    }

    riskMetricsCache = { ts: now, data }

    return data
  })

  safeHandle(
    'finance:getPriceTimeSeries',

    (symbol: string, days?: number, withIndicators?: boolean) => {
      return getPriceTimeSeries(symbol.toUpperCase(), days ?? 90, !!withIndicators)
    },
  )

  safeHandle(
    'finance:getPortfolioVsBenchmark',

    (days?: number, benchmarks?: string[]) => {
      return getPortfolioVsBenchmark(
        days ?? 90,

        benchmarks && benchmarks.length > 0 ? benchmarks : ['SPY'],
      )
    },
  )

  safeHandle('finance:getCorrelationMatrix', (symbols?: string[], days?: number) => {
    return getCorrelationMatrix(symbols, days ?? 60)
  })

  safeHandle('finance:getSectorExposure', async () => {
    return await getSectorExposure()
  })

  safeHandle('finance:getSentimentTimeSeries', (symbol?: string, days?: number) => {
    return getSentimentTimeSeries(symbol, days ?? DEFAULT_CHART_DAYS)
  })
}
