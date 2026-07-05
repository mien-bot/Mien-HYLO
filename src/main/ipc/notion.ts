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

export function registerNotionHandlers(): void {
  safeHandle('notion:syncTasks', async () => {
    return await syncTasks()
  })

  safeHandle('notion:pushBriefing', async (briefingId: number) => {
    const pageId = await pushBriefingToNotion(briefingId)

    return { status: 'ok', pageId }
  })

  safeHandle('notion:pullBriefings', async (daysBack: number = 14) => {
    try {
      const result = await pullBriefingsFromNotion(daysBack)

      return { status: 'ok', ...result }
    } catch (err) {
      return { status: 'error', error: (err as Error)?.message || String(err) }
    }
  })

  safeHandle('notion:listDatabases', async () => {
    return await listNotionDatabases()
  })

  safeHandle('notion:getDbProperties', async (dbId: string) => {
    if (!dbId) return []

    const schema = await getDbSchema(dbId)

    return Object.values(schema).map((p) => ({ id: p.id, name: p.name, type: p.type }))
  })
}
