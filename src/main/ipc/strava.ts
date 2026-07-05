import { BrowserWindow, app } from 'electron'
import { DEFAULT_TRAINING_DAYS } from '@shared/constants'
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

function getRelayConfig() {
  const settings = getAppSettings()
  const relayUrl = settings?.relayUrl?.replace(/\/$/, '')
  const relayToken = settings?.relayToken
  if (!relayUrl) throw new Error('No relay URL configured � set it in Settings ? Connections')
  return { relayUrl, relayToken }
}

function relayHeaders(token?: string): Record<string, string> {
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' }
}

async function pullStravaRelayResults(days: number) {
  const workouts = await pullHealthFromRelay({ days, type: 'workout' })
  const streams = await pullStravaStreamsFromRelay(days)
  return {
    pulledWorkouts: workouts.pulled,
    pulledStreams: streams.pulled,
  }
}

export function registerStravaHandlers(): void {
  safeHandle('strava:connect', async () => {
    try {
      const { relayUrl, relayToken } = getRelayConfig()

      const settings = getAppSettings()

      const clientId = settings?.stravaClientId

      const clientSecret = settings?.stravaClientSecret

      const res = await fetch(`${relayUrl}/strava/connect`, {
        method: 'POST',
        headers: relayHeaders(relayToken),
        body: JSON.stringify({
          client_id: clientId || undefined,
          client_secret: clientSecret || undefined,
        }),
      })

      const data = await res.json()

      if (data.error) return { success: false, error: data.error }

      // Open the auth URL in the user's browser

      if (data.authUrl) {
        const { shell } = await import('electron')

        shell.openExternal(data.authUrl)

        // Poll relay for status (Strava callback goes to relay, not localhost)

        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000))

          const statusRes = await fetch(`${relayUrl}/strava/status`, {
            headers: relayHeaders(relayToken),
          })

          const status = await statusRes.json()

          if (status.connected) {
            return { success: true, athlete: status.athlete }
          }
        }

        return { success: false, error: 'OAuth timed out � check your browser' }
      }

      return { success: false, error: 'No auth URL returned from relay' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  safeHandle('strava:disconnect', async () => {
    try {
      const { relayUrl, relayToken } = getRelayConfig()

      await fetch(`${relayUrl}/strava/disconnect`, {
        method: 'POST',

        headers: relayHeaders(relayToken),
      })

      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  safeHandle('strava:status', async () => {
    try {
      const { relayUrl, relayToken } = getRelayConfig()

      const res = await fetch(`${relayUrl}/strava/status`, {
        headers: relayHeaders(relayToken),
      })

      return await res.json()
    } catch {
      return { connected: false }
    }
  })

  safeHandle('strava:sync', async (days: number = DEFAULT_TRAINING_DAYS) => {
    try {
      const { relayUrl, relayToken } = getRelayConfig()

      const params = new URLSearchParams({ days: String(days) })

      const res = await fetch(`${relayUrl}/strava/sync?${params.toString()}`, {
        method: 'POST',

        headers: relayHeaders(relayToken),
      })

      const data = await res.json()

      if (data.error) return data

      const pulled = await pullStravaRelayResults(days)

      return { ...data, ...pulled }
    } catch (err: any) {
      return { error: err.message }
    }
  })

  safeHandle('strava:syncAll', async () => {
    try {
      const { relayUrl, relayToken } = getRelayConfig()

      const days = 3650

      const params = new URLSearchParams({ days: String(days) })

      const res = await fetch(`${relayUrl}/strava/sync?${params.toString()}`, {
        method: 'POST',

        headers: relayHeaders(relayToken),
      })

      const data = await res.json()

      if (data.error) return data

      const pulled = await pullStravaRelayResults(days)

      return { ...data, ...pulled }
    } catch (err: any) {
      return { error: err.message }
    }
  })

  safeHandle('strava:syncStreams', async (days: number = DEFAULT_TRAINING_DAYS, limit: number = 30) => {
    try {
      const { relayUrl, relayToken } = getRelayConfig()

      const params = new URLSearchParams({
        days: String(days),

        stream_limit: String(limit),

        detail_limit: String(limit),
      })

      const relaySync = await fetch(`${relayUrl}/strava/sync?${params.toString()}`, {
        method: 'POST',

        headers: relayHeaders(relayToken),
      })

      const relayResult = await relaySync.json()

      if (relayResult.error) return { error: relayResult.error }

      const pulled = await pullStravaRelayResults(days)

      return {
        fetched: pulled.pulledStreams,

        skipped: 0,

        fromRelay: true,

        relayFetched: relayResult.enriched,

        activityDetailsFetched: relayResult.activityDetailsFetched,

        pulledWorkouts: pulled.pulledWorkouts,
      }
    } catch (err: any) {
      return { error: err.message }
    }
  })
}
