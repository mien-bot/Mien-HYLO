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
import {
  DEFAULT_CHART_DAYS,
  DEFAULT_ROLLING_WINDOWS,
  DEFAULT_TRAINING_DAYS,
} from '@shared/constants'
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
import { getWorkoutDetail } from '../services/health/workout-detail.service'
import { generateWorkoutAiReport } from '../services/health/workout-ai-report.service'
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

export function registerHealthHandlers(): void {
  safeHandle('healthAlerts:list', () => listHealthAlerts())

  safeHandle(
    'healthAlerts:create',

    (input: {
      type: HealthAlertType

      threshold: number

      note?: string | null

      one_shot?: boolean
    }) => {
      const id = createHealthAlert(input)

      return { id }
    },
  )

  safeHandle('healthAlerts:toggle', (id: number, active: boolean) => {
    toggleHealthAlert(id, active)

    return { ok: true }
  })

  safeHandle('healthAlerts:remove', (id: number) => {
    removeHealthAlert(id)

    return { ok: true }
  })

  safeHandle('healthAlerts:checkNow', async () => {
    const hits = await checkHealthAlerts()

    return { count: hits.length, hits }
  })

  safeHandle('health:getMetrics', (type: string, days: number = 7) => {
    const db = getDb()

    if (type === 'sleep') applySleepOutlierExclusions(db)

    return db

      .prepare(
        `
  
        SELECT * FROM health_metrics
  
        WHERE metric_type = ?
  
          AND (? != 'sleep' OR excluded = 0)
  
          AND date >= date('now', '-' || ? || ' days')
  
        ORDER BY date DESC
  
      `,
      )

      .all(type, type, days)
  })

  safeHandle('health:getLatestSleep', () => {
    const db = getDb()

    return (
      db

        .prepare(
          `
  
        SELECT * FROM health_metrics
  
        WHERE metric_type = 'sleep' AND excluded = 0
  
        ORDER BY date DESC
  
        LIMIT 1
  
      `,
        )

        .get() || null
    )
  })

  safeHandle('health:getLatestHeartRate', () => {
    const db = getDb()

    return (
      db

        .prepare(
          `
  
        SELECT * FROM health_metrics
  
        WHERE metric_type = 'heart_rate'
  
        ORDER BY date DESC
  
        LIMIT 1
  
      `,
        )

        .get() || null
    )
  })

  safeHandle('health:import', (filePath: string) => {
    return importHealthFile(filePath)
  })

  safeHandle('health:getServerPort', () => {
    return getHealthServerPort()
  })

  safeHandle('health:recalculateSleepInBed', () => {
    return recalculateSleepInBed()
  })

  safeHandle('health:backfillSleepAwake', () => {
    return backfillSleepAwake()
  })

  safeHandle('health:getSummary', () => {
    const db = getDb()

    const types = [
      'sleep',

      'heart_rate',

      'hrv',

      'steps',

      'active_energy',

      'workout',

      'vo2_max',

      'resting_heart_rate',

      'exercise_time',
    ]

    const summary: Record<string, number> = {}

    for (const t of types) {
      const row = db

        .prepare('SELECT COUNT(*) as count FROM health_metrics WHERE metric_type = ?')

        .get(t) as Record<string, unknown>

      summary[t] = row?.count || 0
    }

    return summary
  })

  safeHandle('health:getSleepAnalysis', (days: number = 90) => {
    try {
      const sessions = parseSleepSessions(days)

      if (sessions.length === 0) return null

      const debt = calculateSleepDebt(sessions)

      const circadian = predictCircadianRhythm(sessions)

      const lastNight = sessions[0]

      const quality = scoreSleepQuality(lastNight, sessions)

      const chronotype = detectChronotype(sessions)

      const socialJetLag = calculateSocialJetLag(sessions)

      const caffeineCutoff = calculateCaffeineCutoff(sessions)

      const hrvRecovery = calculateHrvRecovery()

      const energyCurve = calculateEnergyCurve(sessions)

      return {
        sessions,

        debt,

        circadian,

        quality,

        lastNight,

        chronotype,

        socialJetLag,

        caffeineCutoff,

        hrvRecovery,

        energyCurve,
      }
    } catch (err) {
      console.error('Sleep analysis error:', err)

      return null
    }
  })

  safeHandle('health:getWakeRecommendation', (bedtime: string, latency?: number) => {
    return recommendWakeTime(bedtime, latency)
  })

  safeHandle(
    'health:getBedtimeRecommendation',

    (wakeTime: string, latency?: number) => {
      return recommendBedtime(wakeTime, latency)
    },
  )

  safeHandle('health:getSleepContext', () => {
    try {
      return buildSleepAnalysisContext()
    } catch {
      return 'No sleep data available.'
    }
  })

  safeHandle('health:getRecoveryReadiness', () => {
    try {
      return calculateRecoveryReadiness()
    } catch (err) {
      console.error('Recovery readiness error:', err)

      return null
    }
  })

  safeHandle('health:getSleepCorrelations', () => {
    try {
      return calculateWorkoutSleepCorrelation()
    } catch (err) {
      console.error('Sleep correlations error:', err)

      return null
    }
  })

  safeHandle('health:getSleepQualityHistory', (days: number = DEFAULT_CHART_DAYS) => {
    try {
      return scoreSleepQualityBatch(days)
    } catch (err) {
      console.error('Sleep quality history error:', err)

      return []
    }
  })

  safeHandle('health:getSleepRegularity', () => {
    try {
      return calculateSleepRegularityIndex()
    } catch (err) {
      console.error('Sleep regularity error:', err)

      return null
    }
  })

  safeHandle('health:getWindDownRoutine', () => {
    try {
      return calculateWindDownRoutine()
    } catch (err) {
      console.error('Wind-down routine error:', err)

      return null
    }
  })

  safeHandle('health:getSleepNeedProfile', (days: number = 90) => {
    try {
      return analyzeSleepNeed(days)
    } catch (err) {
      console.error('Sleep need profile error:', err)

      return null
    }
  })

  safeHandle(
    'health:predictWakeTime',

    (input?: {
      recentSleepDays?: number

      isWorkday?: boolean

      plannedBedtime?: string

      sleepLatencyMinutes?: number
    }) => {
      try {
        return predictOptimalWakeTime(input)
      } catch (err) {
        console.error('[wake-prediction] predictWakeTime error:', err)

        return null
      }
    },
  )

  safeHandle('health:saveWakePrediction', (prediction: any, dateStr?: string) => {
    try {
      saveWakePrediction(prediction, dateStr)

      return true
    } catch (err) {
      console.error('[wake-prediction] saveWakePrediction error:', err)

      return false
    }
  })

  safeHandle(
    'health:recordWakeOutcome',

    (params: {
      date: string

      actualWakeTime: string

      grogginessRating?: number

      energyRating?: number

      minutesToAlertAfterWake?: number

      snoozed?: boolean
    }) => {
      try {
        recordWakeOutcome(params)

        return true
      } catch (err) {
        console.error('[wake-prediction] recordWakeOutcome error:', err)

        return false
      }
    },
  )

  safeHandle('health:validateWakePredictions', (days?: number) => {
    try {
      return validateWakePredictions(days)
    } catch (err) {
      console.error('[wake-prediction] validateWakePredictions error:', err)

      return null
    }
  })

  safeHandle('health:getFitnessAnalysis', (days: number = DEFAULT_TRAINING_DAYS) => {
    try {
      return getFullFitnessAnalysis(days)
    } catch (err) {
      console.error('Fitness analysis error:', err)

      return null
    }
  })

  safeHandle('health:getTrainingLoad', (days: number = DEFAULT_TRAINING_DAYS) => {
    try {
      return calculateTrainingLoad(days)
    } catch (err) {
      console.error('Training load error:', err)

      return null
    }
  })

  safeHandle('health:getRecoveryAnalysis', (days: number = DEFAULT_CHART_DAYS) => {
    try {
      return calculateRecovery(days)
    } catch (err) {
      console.error('Recovery analysis error:', err)

      return null
    }
  })

  safeHandle('health:getFitnessProfile', (days: number = DEFAULT_TRAINING_DAYS) => {
    try {
      return buildFitnessProfile(days)
    } catch (err) {
      console.error('Fitness profile error:', err)

      return null
    }
  })

  safeHandle('health:getHRZoneAnalysis', (days: number = DEFAULT_TRAINING_DAYS) => {
    try {
      return calculateHRZoneAnalysis(days)
    } catch (err) {
      console.error('HR zone analysis error:', err)

      return null
    }
  })

  safeHandle('health:getHRSS', (days: number = DEFAULT_TRAINING_DAYS) => {
    try {
      return calculateHRSS(days)
    } catch (err) {
      console.error('HRSS error:', err)

      return null
    }
  })

  safeHandle('health:getYearProgression', (days: number = 730) => {
    try {
      return calculateYearProgression(days)
    } catch (err) {
      console.error('Year progression error:', err)

      return null
    }
  })

  safeHandle('health:getBestEfforts', (days: number = 365) => {
    try {
      return calculateBestEfforts(days)
    } catch (err) {
      console.error('Best efforts error:', err)

      return null
    }
  })

  safeHandle('health:getStreamZones', (days: number = DEFAULT_TRAINING_DAYS) => {
    try {
      return calculateStreamZoneAnalysis(days)
    } catch (err) {
      console.error('Stream zone analysis error:', err)

      return null
    }
  })

  safeHandle('health:getBestSplits', (days: number = 365) => {
    try {
      return calculateBestSplits(days)
    } catch (err) {
      console.error('Best splits error:', err)

      return null
    }
  })

  safeHandle('health:getGradeAdjustedPace', (days: number = 365) => {
    try {
      return calculateGradeAdjustedPace(days)
    } catch (err) {
      console.error('GAP error:', err)

      return null
    }
  })

  safeHandle('health:getRunningPower', (days: number = 365) => {
    try {
      return calculateRunningPower(days)
    } catch (err) {
      console.error('Running power error:', err)

      return null
    }
  })

  safeHandle('health:getWorkoutDetail', (key: string) => {
    try {
      return getWorkoutDetail(key)
    } catch (err) {
      console.error('Workout detail error:', err)
      return null
    }
  })

  safeHandle('health:generateWorkoutReport', async (key: string) => {
    return await generateWorkoutAiReport(key)
  })

  safeHandle(
    'health:getFilteredFitness',

    (days: number = DEFAULT_TRAINING_DAYS, patterns: string[] = []) => {
      try {
        return getFilteredFitnessAnalysis(days, patterns)
      } catch (err) {
        console.error('Filtered fitness error:', err)

        return null
      }
    },
  )

  safeHandle(
    'health:getMetricRollingAverages',

    (metricType: string, windows?: number[], days?: number) => {
      return getMetricRollingAverages(
        metricType,

        windows && windows.length > 0 ? windows : [...DEFAULT_ROLLING_WINDOWS],

        days ?? DEFAULT_TRAINING_DAYS,
      )
    },
  )

  safeHandle('health:getSleepStageHistory', (days?: number) => {
    return getSleepStageHistory(days ?? DEFAULT_CHART_DAYS)
  })

  safeHandle('health:getCircadianPhases24h', () => {
    return getCircadianPhases24h()
  })

  safeHandle('health:getFitnessHistory', (days?: number) => {
    return getFitnessHistory(days ?? DEFAULT_TRAINING_DAYS)
  })

  safeHandle('composite:getReadiness', () => {
    return getCrossDomainReadiness()
  })

  safeHandle('composite:getEnergyAlignment', (date?: string) => {
    return getEnergyAlignment(date)
  })

  safeHandle('composite:getCorrelations', (days?: number) => {
    return getCrossDomainCorrelations(days ?? 60)
  })
}
