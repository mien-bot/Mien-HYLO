import { BrowserWindow, app } from 'electron'
import store from '../lib/store'
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
import { getPlannerWeatherPreview } from '../services/weather.service'
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

export function registerProductivityHandlers(): void {
  safeHandle('tasks:getToday', (date?: string) => {
    return getTodayTaskItems(date)
  })

  safeHandle('schedule:getToday', () => {
    const db = getDb()

    const today = new Date().toISOString().split('T')[0]

    return (
      db.prepare('SELECT * FROM daily_schedule WHERE date = ? AND deleted_at IS NULL').get(today) ||
      null
    )
  })

  safeHandle('weather:getPlannerPreview', async (dates?: string[], location?: string) => {
    return await getPlannerWeatherPreview({ dates, location })
  })

  safeHandle('schedule:generate', async (prefs?: SchedulePreferences) => {
    const scheduleJson = await generateDailySchedule(prefs)

    const db = getDb()

    const today = new Date().toISOString().split('T')[0]

    return (
      db.prepare('SELECT * FROM daily_schedule WHERE date = ? AND deleted_at IS NULL').get(today) ||
      null
    )
  })

  safeHandle('schedule:updateToday', (scheduleJson: string) => {
    return updateTodaySchedule(scheduleJson)
  })

  safeHandle('schedule:tweak', async (date: string, instruction: string) => {
    const scheduleJson = await tweakDailySchedule(date, instruction)

    const db = getDb()

    return (
      db.prepare('SELECT * FROM daily_schedule WHERE date = ? AND deleted_at IS NULL').get(date) ||
      null
    )
  })

  safeHandle('schedule:getHistory', (limit = 30) => {
    const db = getDb()

    return db

      .prepare('SELECT * FROM daily_schedule WHERE deleted_at IS NULL ORDER BY date DESC LIMIT ?')

      .all(limit)
  })

  safeHandle(
    'schedule:pushToNotion',

    async (scheduleJson: string, date: string, databaseId?: string) => {
      return await pushScheduleToNotion(scheduleJson, date, databaseId)
    },
  )

  safeHandle('scheduler:getStatus', () => {
    return getSchedulerStatus()
  })

  safeHandle('scheduler:getActivity', (limit: number = 50) => {
    return getSchedulerActivity(limit)
  })

  safeHandle('scheduler:getSuccessRate', (days?: number) => {
    const db = getDb()

    const lookback = days ?? 30

    const rows = db

      .prepare(
        `
  
        SELECT
  
          job_name,
  
          SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
  
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
  
          AVG(duration_ms) AS avg_duration_ms,
  
          MAX(started_at) AS last_run
  
        FROM scheduler_activity_log
  
        WHERE started_at >= datetime('now', '-' || ? || ' days')
  
        GROUP BY job_name
  
        ORDER BY job_name
  
      `,
      )

      .all(lookback) as Array<{
      job_name: string

      ok_count: number

      error_count: number

      avg_duration_ms: number | null

      last_run: string | null
    }>

    return rows.map((r) => {
      const total = r.ok_count + r.error_count

      return {
        jobName: r.job_name,

        successRatePct: total > 0 ? (r.ok_count / total) * 100 : 0,

        okCount: r.ok_count,

        errorCount: r.error_count,

        avgDurationMs: r.avg_duration_ms,

        lastRun: r.last_run,
      }
    })
  })
}
