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
import { getAppSettings } from '../lib/settings'

const UPDATE_ROOT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'electron-builder.json5',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'CLAUDE.md',
  'DATA-SYNC.md',
  'SETUP.md',
  'README.md',
  'VERSION',
  '.gitignore',
  'setup.ps1',
])
const UPDATE_FILE_PATTERN = /\.(ts|tsx|js|jsx|json|css|json5|md|svg|ico|png|jpg|vbs|ps1|nsh|html)$/
const UPDATE_DIRS = ['src', 'relay', 'resources', 'build', 'scripts', 'docs']

function normalizeUpdatePath(rel: string): string {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

function isAllowedUpdateFile(rel: string): boolean {
  const clean = normalizeUpdatePath(rel)
  return (
    UPDATE_ROOT_FILES.has(clean) ||
    (UPDATE_FILE_PATTERN.test(clean) && UPDATE_DIRS.some((dir) => clean.startsWith(`${dir}/`)))
  )
}

function getSourceUpdateRoot(): string {
  if (app.isPackaged) {
    throw new Error(
      'In-app source updates only work when Mien is running from a source checkout. Packaged installs need a rebuilt installer.',
    )
  }
  return process.cwd()
}

function getLocalCommit(projectRoot: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot }).toString().trim()
  } catch {
    return null
  }
}

function getRelayUpdateBasis(projectRoot: string): string | null {
  return (
    (store.get('appUpdate.appliedRelayCommit') as string | undefined) || getLocalCommit(projectRoot)
  )
}

function getRelayUpdateConfig(): { relayUrl: string; headers: Record<string, string> } | null {
  const settings = getAppSettings()
  const relayUrl = settings?.relayUrl?.replace(/\/$/, '')
  if (!relayUrl) return null
  const headers: Record<string, string> = {}
  if (settings?.relayToken) headers.Authorization = `Bearer ${settings.relayToken}`
  return { relayUrl, headers }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok) {
      const detail = data?.error?.message || data?.error || text || `HTTP ${res.status}`
      throw new Error(`HTTP ${res.status}: ${detail}`)
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

function writeUpdateFile(projectRoot: string, rel: string, content: string): void {
  const clean = normalizeUpdatePath(rel)
  if (!isAllowedUpdateFile(clean)) throw new Error(`Blocked update file: ${rel}`)
  const target = nodePath.resolve(projectRoot, clean)
  const root = nodePath.resolve(projectRoot)
  if (!target.startsWith(root + nodePath.sep)) throw new Error(`Blocked path traversal: ${rel}`)
  fs.mkdirSync(nodePath.dirname(target), { recursive: true })
  if (content.startsWith('__base64__')) {
    fs.writeFileSync(target, Buffer.from(content.slice(10), 'base64'))
  } else {
    fs.writeFileSync(target, content, 'utf8')
  }
}

function removeUpdateFile(projectRoot: string, rel: string): void {
  const clean = normalizeUpdatePath(rel)
  if (!isAllowedUpdateFile(clean)) return
  const target = nodePath.resolve(projectRoot, clean)
  const root = nodePath.resolve(projectRoot)
  if (!target.startsWith(root + nodePath.sep)) return
  if (fs.existsSync(target)) fs.rmSync(target, { force: true })
}

export function registerSettingsHandlers(): void {
  safeHandle(
    'app:capturePage',

    async (rect?: { x: number; y: number; width: number; height: number }) => {
      const cleanRect =
        rect &&
        Number.isFinite(rect.x) &&
        Number.isFinite(rect.y) &&
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height)
          ? {
              x: Math.max(0, Math.floor(rect.x)),

              y: Math.max(0, Math.floor(rect.y)),

              width: Math.max(1, Math.floor(rect.width)),

              height: Math.max(1, Math.floor(rect.height)),
            }
          : undefined

      const sender = BrowserWindow.getFocusedWindow()?.webContents
      if (!sender) throw new Error('No focused window available for capture')
      const image = await sender.capturePage(cleanRect)

      return image.toDataURL()
    },
  )

  safeHandle('settings:get', (key: string) => {
    return store.get(key)
  })

  safeHandle('settings:set', (key: string, value: unknown) => {
    store.set(key, value)
  })

  safeHandle('saved:getOverview', () => {
    const db = getDb()

    const parseJson = (value: string | null | undefined): any => {
      if (!value) return null

      try {
        return JSON.parse(value)
      } catch {
        return null
      }
    }

    const dateOnly = (value: string | null | undefined): string | null => {
      if (!value) return null

      const match = String(value).match(/^\d{4}-\d{2}-\d{2}/)

      return match ? match[0] : null
    }

    const safeAll = <T>(sql: string): T[] => {
      try {
        return db.prepare(sql).all() as T[]
      } catch {
        return []
      }
    }

    const places = safeAll<any>(`
  
        SELECT id, place_id, name, address, venue_type, cuisine_category, cuisine,
  
               notes, description, saved_at, visited, visit_date, personal_rating
  
        FROM saved_restaurants
  
        ORDER BY COALESCE(saved_at, visit_date) DESC
  
      `).map((row) => ({
      id: `place:${row.place_id}`,

      category: row.venue_type || 'place',

      title: row.name,

      subtitle: row.address || row.cuisine_category || row.cuisine || null,

      note: row.notes || row.description || null,

      date: dateOnly(row.visit_date) || dateOnly(row.saved_at),

      savedAt: row.saved_at,

      source: 'Saved places',

      meta: [
        row.visited ? 'Visited' : null,

        row.personal_rating ? `${row.personal_rating}/5` : null,

        row.cuisine_category || row.cuisine || null,
      ]

        .filter(Boolean)

        .join(' � '),
    }))

    const visits = safeAll<any>(`
  
        SELECT v.id, v.place_id, v.visit_date, v.rating, v.notes, v.created_at,
  
               r.name, r.address, r.venue_type
  
        FROM restaurant_visits v
  
        LEFT JOIN saved_restaurants r ON r.place_id = v.place_id
  
        WHERE v.deleted_at IS NULL
  
        ORDER BY v.visit_date DESC, v.created_at DESC
  
      `).map((row) => ({
      id: `visit:${row.id}`,

      category: 'visit',

      title: row.name ? `Visit: ${row.name}` : 'Saved visit',

      subtitle: row.address || null,

      note: row.notes || null,

      date: dateOnly(row.visit_date) || dateOnly(row.created_at),

      savedAt: row.created_at,

      source: 'Visits',

      meta: row.rating ? `${row.rating}/5` : row.venue_type || '',
    }))

    const news = safeAll<any>(`
  
        SELECT id, title, url, source, published_at, related_symbols, summary, saved_at
  
        FROM news_articles
  
        WHERE saved_at IS NOT NULL
  
        ORDER BY saved_at DESC
  
        LIMIT 200
  
      `).map((row) => ({
      id: `news:${row.id}`,

      category: 'finance',

      title: row.title,

      subtitle: [row.source, row.related_symbols].filter(Boolean).join(' � ') || row.url,

      note: row.summary || null,

      date: dateOnly(row.published_at) || dateOnly(row.saved_at),

      savedAt: row.saved_at,

      source: 'Saved finance news',

      meta: 'Article',

      url: row.url,
    }))

    const holdings = safeAll<any>(`
  
        SELECT id, symbol, quantity, cost_basis, acquired_at, notes, created_at
  
        FROM holdings
  
        WHERE notes IS NOT NULL AND TRIM(notes) <> ''
  
        ORDER BY COALESCE(acquired_at, created_at) DESC
  
      `).map((row) => ({
      id: `holding:${row.id}`,

      category: 'portfolio',

      title: `${row.symbol} holding note`,

      subtitle: 'Portfolio note',

      note: row.notes,

      date: dateOnly(row.acquired_at) || dateOnly(row.created_at),

      savedAt: row.created_at,

      source: 'Portfolio notes',

      meta: 'Holding',
    }))

    const weekendPlans = safeAll<any>(`
  
        SELECT id, weekend_date, plan_json, ai_rationale, created_at
  
        FROM weekend_plans
  
        WHERE deleted_at IS NULL
  
        ORDER BY weekend_date DESC
  
        LIMIT 100
  
      `).map((row) => {
      const plan = parseJson(row.plan_json)

      const activities =
        (Array.isArray(plan?.saturday) ? plan.saturday.length : 0) +
        (Array.isArray(plan?.sunday) ? plan.sunday.length : 0)

      return {
        id: `weekend:${row.id}`,

        category: 'weekend',

        title: `Weekend plan: ${row.weekend_date}`,

        subtitle: `${activities} planned activities`,

        note: row.ai_rationale || null,

        date: dateOnly(row.weekend_date) || dateOnly(row.created_at),

        savedAt: row.created_at,

        source: 'Weekend plans',

        meta: 'Plan',
      }
    })

    const schedules = safeAll<any>(`
  
        SELECT id, date, schedule_json, ai_rationale, created_at
  
        FROM daily_schedule
  
        WHERE deleted_at IS NULL
  
        ORDER BY date DESC
  
        LIMIT 120
  
      `).map((row) => {
      const schedule = parseJson(row.schedule_json)

      const blocks = Array.isArray(schedule?.blocks)
        ? schedule.blocks.length
        : Array.isArray(schedule)
          ? schedule.length
          : 0

      return {
        id: `schedule:${row.id}`,

        category: 'schedule',

        title: `Daily schedule: ${row.date}`,

        subtitle: blocks ? `${blocks} calendar blocks` : 'Generated schedule',

        note: row.ai_rationale || null,

        date: dateOnly(row.date) || dateOnly(row.created_at),

        savedAt: row.created_at,

        source: 'Schedules',

        meta: 'Calendar',
      }
    })

    const briefings = safeAll<any>(`
  
        SELECT id, type, date, content, created_at
  
        FROM briefings
  
        ORDER BY date DESC, created_at DESC
  
        LIMIT 120
  
      `).map((row) => ({
      id: `briefing:${row.id}`,

      category: 'briefing',

      title: `${String(row.type || 'Briefing')} briefing`,

      subtitle: row.date,

      note: String(row.content || '').slice(0, 320),

      date: dateOnly(row.date) || dateOnly(row.created_at),

      savedAt: row.created_at,

      source: 'Briefings',

      meta: 'AI note',
    }))

    const alerts = safeAll<any>(`
  
        SELECT id, symbol, type, threshold, note, active, created_at
  
        FROM alerts
  
        WHERE note IS NOT NULL AND TRIM(note) <> ''
  
        ORDER BY created_at DESC
  
      `).map((row) => ({
      id: `alert:${row.id}`,

      category: 'finance',

      title: `${row.symbol} alert note`,

      subtitle: `${row.type} ${row.threshold}`,

      note: row.note,

      date: dateOnly(row.created_at),

      savedAt: row.created_at,

      source: 'Finance alerts',

      meta: row.active ? 'Active' : 'Inactive',
    }))

    const healthAlerts = safeAll<any>(`
  
        SELECT id, type, threshold, note, active, created_at
  
        FROM health_alerts
  
        WHERE note IS NOT NULL AND TRIM(note) <> ''
  
        ORDER BY created_at DESC
  
      `).map((row) => ({
      id: `health-alert:${row.id}`,

      category: 'health',

      title: `${row.type} health alert note`,

      subtitle: `Threshold ${row.threshold}`,

      note: row.note,

      date: dateOnly(row.created_at),

      savedAt: row.created_at,

      source: 'Health alerts',

      meta: row.active ? 'Active' : 'Inactive',
    }))

    const items = [
      ...places,

      ...visits,

      ...news,

      ...holdings,

      ...weekendPlans,

      ...schedules,

      ...briefings,

      ...alerts,

      ...healthAlerts,
    ]

      .filter((item) => item.title)

      .sort((a, b) =>
        String(b.date || b.savedAt || '').localeCompare(String(a.date || a.savedAt || '')),
      )

    return { items }
  })

  safeHandle('auth:isSet', () => isPasswordSet())

  safeHandle('auth:setPassword', (password: string) => {
    setPassword(password)

    return true
  })

  safeHandle('auth:verify', (password: string) => verifyPassword(password))

  safeHandle('data:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],

      title: 'Select an export folder',
    })

    if (result.canceled || result.filePaths.length === 0) return null

    return result.filePaths[0]
  })

  safeHandle('data:exportMarkdown', async (folderPath: string) => {
    return await exportMarkdown(folderPath)
  })

  safeHandle('relay:syncAll', async () => {
    return await syncWithRelay()
  })

  safeHandle('relay:pushSleepAnalysis', async () => {
    return await pushSleepAnalysisToRelay()
  })

  safeHandle('relay:pullHistoricalSleep', async (days?: number) => {
    return await pullHistoricalSleepFromRelay(days ?? 3650)
  })

  safeHandle('relay:getTunnelUrl', () => ({
    ...getTunnelUrlState(),

    watchedPath: getWatchedPath(),
  }))

  safeHandle('relay:getStats', () => {
    const db = getDb()

    const lastSync = db

      .prepare(
        `
  
        SELECT last_synced_at, direction, status
  
        FROM notion_sync_log
  
        ORDER BY last_synced_at DESC LIMIT 1
  
      `,
      )

      .get() as { last_synced_at: string | null; direction: string; status: string } | undefined

    const totals = db

      .prepare(
        `
  
        SELECT
  
          SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
  
          SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS err_count
  
        FROM notion_sync_log
  
        WHERE last_synced_at >= datetime('now', '-7 days')
  
      `,
      )

      .get() as { ok_count: number | null; err_count: number | null } | undefined

    return {
      lastSyncedAt: lastSync?.last_synced_at || null,

      lastDirection: lastSync?.direction || null,

      lastStatus: lastSync?.status || null,

      okCount7d: totals?.ok_count ?? 0,

      errorCount7d: totals?.err_count ?? 0,
    }
  })

  safeHandle('relay:testConnection', async () => {
    const settings = getAppSettings()

    const relayUrl = settings?.relayUrl?.replace(/\/$/, '')

    const relayToken = settings?.relayToken

    if (!relayUrl) return { ok: false, error: 'No relay URL configured' }

    const headers: Record<string, string> = relayToken
      ? { Authorization: `Bearer ${relayToken}` }
      : {}

    try {
      const res = await fetch(`${relayUrl}/health`, { headers, signal: AbortSignal.timeout(8000) })

      const body = await res.json().catch(() => ({}))

      if (res.status === 401 || res.status === 403)
        return {
          ok: false,

          error: `Auth failed (${res.status}) � check relay token matches relay.key`,
        }

      if (!res.ok) return { ok: false, error: `Relay returned HTTP ${res.status}` }

      return { ok: true, status: body.status, version: body.version, provider: body.provider }
    } catch (e: any) {
      if (e.name === 'TimeoutError')
        return { ok: false, error: 'Timed out � relay unreachable (check URL / tunnel)' }

      return { ok: false, error: e.message || 'Connection failed' }
    }
  })

  safeHandle('app:getVersion', () => app.getVersion())

  safeHandle('app:checkUpdate', async () => {
    try {
      const projectRoot = app.isPackaged ? nodePath.join(app.getAppPath(), '..') : process.cwd()

      const localCommit = getLocalCommit(projectRoot)

      const updateBasis = getRelayUpdateBasis(projectRoot)

      const relay = getRelayUpdateConfig()

      if (relay) {
        const params = new URLSearchParams()

        if (updateBasis) params.set('since', updateBasis)

        const result = await fetchJsonWithTimeout(
          `${relay.relayUrl}/update/info?${params.toString()}`,

          {
            headers: relay.headers,
          },

          15_000,
        )

        return {
          ...result,

          localCommit,

          appliedRelayCommit: updateBasis !== localCommit ? updateBasis : null,

          source: 'relay',

          upToDate: !!updateBasis && result.commitHash === updateBasis,

          canApply: !app.isPackaged,
        }
      }

      if (app.isPackaged) return { error: 'Packaged installs need a rebuilt installer to update.' }

      if (!localCommit)
        return {
          error:
            'No relay configured and no git repository. Configure a relay URL in Settings or clone the repo with git.',
        }

      // Fetch latest from remote without changing working tree

      execSync('git fetch origin master', { cwd: projectRoot, timeout: 15000 })

      const remoteCommit = execSync('git rev-parse origin/master', { cwd: projectRoot })
        .toString()

        .trim()

      const upToDate = localCommit === remoteCommit

      const commitHash = remoteCommit

      let commitMessage = ''

      let commitDate = ''

      let fileCount = 0

      if (!upToDate) {
        try {
          commitMessage = execSync('git log -1 --pretty=%s origin/master', { cwd: projectRoot })
            .toString()

            .trim()

          commitDate = execSync('git log -1 --pretty=%ci origin/master', { cwd: projectRoot })
            .toString()

            .trim()

          const diffStat = execSync(`git diff --name-only ${localCommit}..origin/master`, {
            cwd: projectRoot,
          })
            .toString()

            .trim()

          fileCount = diffStat ? diffStat.split('\n').length : 0
        } catch {}
      }

      return {
        commitHash,

        commitMessage,

        commitDate,

        localCommit,

        upToDate,

        fileCount,

        source: 'git',

        canApply: true,
      }
    } catch (e: any) {
      return { error: e.message || 'Could not check for updates' }
    }
  })

  safeHandle('app:applyUpdate', async () => {
    try {
      const projectRoot = getSourceUpdateRoot()

      const localCommit = getLocalCommit(projectRoot)

      const updateBasis = getRelayUpdateBasis(projectRoot)

      const relay = getRelayUpdateConfig()

      const confirm = dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Apply source update?',
        message: relay
          ? 'Mien will apply source files from the configured relay and restart.'
          : 'Mien will pull the latest source from git and restart.',
        detail:
          'Only continue if you trust the configured update source. Dependency scripts will be disabled during install.',
        buttons: ['Cancel', 'Apply Update'],
        defaultId: 0,
        cancelId: 0,
      })

      if (confirm !== 1) return { ok: false, cancelled: true }

      // Check for local changes that would block git pull (skip if no .git)

      let gitStatus = ''

      const hasGit = localCommit !== null

      if (hasGit) {
        try {
          gitStatus = execSync('git status --porcelain', { cwd: projectRoot }).toString().trim()
        } catch {}

        if (gitStatus) {
          try {
            execSync('git stash', { cwd: projectRoot })
          } catch {}
        }
      }

      const pkgBefore = (() => {
        try {
          return fs.readFileSync(nodePath.join(projectRoot, 'package.json'), 'utf8')
        } catch {
          return ''
        }
      })()

      const lockBefore = (() => {
        try {
          return fs.readFileSync(nodePath.join(projectRoot, 'package-lock.json'), 'utf8')
        } catch {
          return ''
        }
      })()

      let upToDate = false

      let written = 0

      let removed = 0

      let updateSource = 'git'

      if (relay) {
        updateSource = 'relay'

        const params = new URLSearchParams()

        if (updateBasis) params.set('since', updateBasis)

        const result = await fetchJsonWithTimeout(
          `${relay.relayUrl}/update/files?${params.toString()}`,

          {
            headers: relay.headers,
          },

          60_000,
        )

        const files = result.files || {}

        const deleted = Array.isArray(result.deleted) ? result.deleted : []

        for (const [rel, content] of Object.entries(files)) {
          writeUpdateFile(projectRoot, rel, String(content))

          written++
        }

        for (const rel of deleted) {
          removeUpdateFile(projectRoot, rel)

          removed++
        }

        upToDate = written === 0 && removed === 0

        if (result.commitHash) store.set('appUpdate.appliedRelayCommit', result.commitHash)
      } else {
        if (!hasGit)
          return {
            error:
              'No relay configured and no git repository. Configure a relay URL in Settings or clone the repo with git.',
          }

        // Pull latest from origin

        const pullOutput = execSync('git pull origin master', { cwd: projectRoot, timeout: 30000 })
          .toString()

          .trim()

        upToDate = /already up.to.date/i.test(pullOutput)
      }

      if (hasGit && gitStatus) {
        // Restore local changes on top

        try {
          execSync('git stash pop', { cwd: projectRoot })
        } catch {}
      }

      if (upToDate) {
        dialog.showMessageBoxSync({
          type: 'info',

          title: 'No updates',

          message: 'Already up to date.',

          buttons: ['OK'],
        })

        return { ok: true, written, removed, source: updateSource }
      }

      // Clear build cache so next launch recompiles from new source

      const outDir = nodePath.join(projectRoot, 'out')

      if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true, force: true })
      }

      const pkgAfter = (() => {
        try {
          return fs.readFileSync(nodePath.join(projectRoot, 'package.json'), 'utf8')
        } catch {
          return ''
        }
      })()

      const lockAfter = (() => {
        try {
          return fs.readFileSync(nodePath.join(projectRoot, 'package-lock.json'), 'utf8')
        } catch {
          return ''
        }
      })()

      const pkgChanged = pkgBefore !== pkgAfter || lockBefore !== lockAfter

      if (pkgChanged) {
        // Auto-run dependency install if package.json changed. Disable
        // lifecycle scripts so a source update cannot execute arbitrary
        // package scripts before the next trusted app launch.

        try {
          execSync('npm install --ignore-scripts', { cwd: projectRoot, timeout: 120000 })
        } catch {}
      }

      const newCommit = (() => {
        try {
          return execSync('git rev-parse --short HEAD', { cwd: projectRoot }).toString().trim()
        } catch {
          return ''
        }
      })()

      const commitMsg = (() => {
        try {
          return execSync('git log -1 --pretty=%s', { cwd: projectRoot }).toString().trim()
        } catch {
          return ''
        }
      })()

      dialog.showMessageBoxSync({
        type: 'info',

        title: 'Update applied',

        message: `Updated to ${newCommit}${commitMsg ? ` � ${commitMsg}` : ''}.\n\nThe app will now restart.`,

        buttons: ['OK'],
      })

      app.relaunch()

      app.quit()

      return { ok: true, written, removed, source: updateSource }
    } catch (e: any) {
      return { error: e.message || 'Update failed' }
    }
  })
}
