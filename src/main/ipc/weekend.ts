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
  generateWeekendPlanForDay,
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
  discoverTrendingPlaces,
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

export function registerWeekendHandlers(): void {
  safeHandle('weekend:getEvents', async () => {
    return await fetchWeekendEvents()
  })

  safeHandle(
    'weekend:searchEvents',

    async (opts?: {
      keyword?: string

      date?: string

      category?: string

      page?: number
    }) => {
      return await searchWeekendEvents(opts)
    },
  )

  safeHandle('weekend:webSearchEvents', async (query: string, date?: string) => {
    return await webSearchEvents(query, date)
  })

  safeHandle('weekend:getPlan', (weekendDate?: string) => {
    return getWeekendPlan(weekendDate)
  })

  safeHandle('weekend:listPlans', (limit?: number) => {
    return getAllWeekendPlans(limit ?? 20)
  })

  safeHandle('weekend:listCachedEvents', (limit?: number) => {
    return getCachedWeekendEvents(limit ?? 100)
  })

  safeHandle('weekend:generate', async (paramsOrPrefs?: string | object) => {
    const planJson = await generateWeekendPlan(paramsOrPrefs as Record<string, unknown>)

    return getWeekendPlan()
  })

  safeHandle('weekend:generateDay', async (day: string, paramsOrPrefs?: string | object) => {
    await generateWeekendPlanForDay(day, paramsOrPrefs as Record<string, unknown>)

    return getWeekendPlan()
  })

  safeHandle('weekend:updatePlan', (weekendDate: string, planJson: string) => {
    return updateWeekendPlan(weekendDate, planJson)
  })

  safeHandle('weekend:tweakPlan', async (weekendDate: string, instruction: string, day?: string) => {
    await tweakWeekendPlan(weekendDate, instruction, day)

    return getWeekendPlan(weekendDate)
  })

  safeHandle(
    'weekend:pushToNotion',

    async (planJson: string, weekendDate: string, databaseId?: string) => {
      return await pushWeekendToNotion(planJson, weekendDate, databaseId)
    },
  )

  safeHandle(
    'restaurants:autocomplete',

    async (input: string, mode?: 'food' | 'places') => {
      return await autocompleteRestaurants(input, mode)
    },
  )

  safeHandle('restaurants:search', async (query?: string) => {
    return await searchRestaurants(query)
  })

  safeHandle('restaurants:getPlace', async (placeId: string) => {
    return await getPlaceById(placeId)
  })

  safeHandle(
    'restaurants:searchNearby',

    async (options: { lat: number; lng: number; radiusMiles?: number; types?: string[] }) => {
      return await searchNearbyPlaces(options)
    },
  )

  safeHandle('restaurants:getSaved', (filter?: any) => {
    return getSavedRestaurants(filter)
  })

  safeHandle('restaurants:save', (restaurant: any, notes?: string) => {
    saveRestaurant(restaurant, notes)

    return { status: 'ok' }
  })

  safeHandle('restaurants:addManual', (input: any) => {
    addManualRestaurant(input)

    return { status: 'ok' }
  })

  safeHandle('restaurants:update', (placeId: string, updates: any) => {
    updateRestaurant(placeId, updates)

    return { status: 'ok' }
  })

  safeHandle('restaurants:remove', (placeId: string) => {
    removeSavedRestaurant(placeId)

    return { status: 'ok' }
  })

  safeHandle('restaurants:updateNotes', (placeId: string, notes: string) => {
    updateRestaurantNotes(placeId, notes)

    return { status: 'ok' }
  })

  safeHandle(
    'restaurants:describe',

    async (name: string, address: string, primaryType?: string | null) => {
      return await describePlace(name, address, primaryType)
    },
  )

  safeHandle('restaurants:research', async (placeId: string) => {
    return await researchRestaurant(placeId)
  })

  safeHandle('restaurants:researchAll', async (opts?: { force?: boolean }) => {
    return await researchAllRestaurants(opts || {}, (progress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('restaurants:research-progress', progress)
      }
    })
  })

  safeHandle(
    'restaurants:discover',

    async (query: string, mode?: 'food' | 'places') => {
      return await discoverRestaurants(query, mode)
    },
  )

  safeHandle('restaurants:discoverTrending', async (mode?: 'food' | 'places') => {
    return await discoverTrendingPlaces(mode)
  })

  safeHandle('restaurants:edit', (placeId: string, updates: any) => {
    editRestaurantCore(placeId, updates)

    return { status: 'ok' }
  })

  safeHandle(
    'restaurants:addVisit',

    (placeId: string, rating: number | null, visitDate?: string, notes?: string) => {
      return addVisit(placeId, rating, visitDate, notes)
    },
  )

  safeHandle('restaurants:updateVisit', (visitId: number, updates: any) => {
    updateVisit(visitId, updates)

    return { status: 'ok' }
  })

  safeHandle('restaurants:removeVisit', (visitId: number) => {
    removeVisit(visitId)

    return { status: 'ok' }
  })

  safeHandle('restaurants:getVisits', (placeId: string) => {
    return getVisits(placeId)
  })

  safeHandle('distance:fromHome', async (destination: string) => {
    return await getDistanceFromHome(destination)
  })

  safeHandle(
    'weekend:getAgendaMapImages',

    async (routes: { saturday?: string[]; sunday?: string[] }) => {
      return await getWeekendAgendaMapImages(routes || {})
    },
  )

  safeHandle('weekend:resolveRouteLocations', async (route: string[]) => {
    return await resolveRouteLocations(route || [])
  })
}
