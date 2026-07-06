import { BrowserWindow, app } from 'electron'
import store from '../lib/store'
import * as fs from 'fs'
import * as nodePath from 'path'
import { execSync } from 'child_process'
import { isPasswordSet, setPassword, verifyPassword } from '../lib/auth'
import { applySleepOutlierExclusions, getDb } from '../db/database'
import { refreshAllFinanceData, getLatestPricesLive, getCachedPrices } from '../services/finance'
import { fetchYouTubeVideos, parseChannelsSetting } from '../services/finance/youtube.fetcher'
import {
  getVideoContext,
  getYouTubeMetadata,
  type VideoContextMode,
} from '../services/finance/video-transcript.service'
import { fetchYahooPrices } from '../services/finance/yahoo.fetcher'
import {
  chatWithStreaming,
  regenerateLastResponse,
  cancelChat,
  deleteMessagesFrom,
  getChatHistory,
  clearChatHistory,
  listConversations,
  listArchivedConversations,
  renameConversation,
  setConversationPinned,
  setConversationArchived,
  deleteConversation,
  searchMessages,
  exportConversation,
  getConversationAttachments,
  type ChatAttachmentInput,
  listMemories,
  addMemory,
  updateMemory,
  deleteMemory,
  clearMemories,
  buildMemoryBlock,
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

async function enrichArticleContext(article: {
  id?: number
  url: string
  source?: string | null
  content_context?: string | null
  mode?: VideoContextMode
}): Promise<string | null> {
  const isYouTube =
    article.source?.startsWith('YouTube:') || /youtube\.com|youtu\.be/i.test(article.url)
  if (!isYouTube) return article.content_context || null

  const result = await getVideoContext(article.url, article.content_context, article.mode || 'quick')
  const context = result.context
  if (context && context !== article.content_context) {
    const db = getDb()
    if (article.id) {
      db.prepare(
        `UPDATE news_articles
         SET content_context = ?,
             transcript_status = ?,
             transcript_source = ?,
             transcript_fetched_at = ?
         WHERE id = ?`,
      ).run(context, result.status, result.source, result.fetchedAt, article.id)
    } else {
      db.prepare(
        `UPDATE news_articles
         SET content_context = ?,
             transcript_status = ?,
             transcript_source = ?,
             transcript_fetched_at = ?
         WHERE url = ?`,
      ).run(context, result.status, result.source, result.fetchedAt, article.url)
    }
  }
  return context
}

interface ArticleSummaryInput {
  id?: number
  title: string
  url: string
  source?: string | null
  related_symbols?: string | null
  summary?: string | null
  content_context?: string | null
}

// Shared summarizer used by ai:summarizeNewsArticle, ai:deepSummarizeNewsArticle,
// and ai:addLinkSummary. Enriches context (transcript for YouTube), generates the
// summary, and persists it to news_articles.
async function summarizeArticle(
  article: ArticleSummaryInput,
  mode: 'standard' | 'deep',
): Promise<string> {
  const isYouTube =
    article.source?.startsWith('YouTube:') || /youtube\.com|youtu\.be/i.test(article.url)
  const sourceContext = await enrichArticleContext({
    ...article,
    mode: mode === 'deep' ? 'deep' : 'quick',
  })

  let summary: string
  if (mode === 'deep') {
    const systemPrompt = `You are a rigorous financial media analyst for a personal investing dashboard.

Create a deep, transcript-style plain-text summary that explains what the ${isYouTube ? 'video is actually talking about' : 'article says'}, not just what the headline implies.

Target length: 900-1400 words.

Required sections:
- TL;DR: 2-4 sentences.
- What it covers: 12-18 concrete bullets with claims, arguments, named companies/assets, dates, price levels, catalysts, and evidence.
- Thesis and assumptions: the core argument and what must be true for it to hold.
- Why it matters: portfolio or market relevance.
- Watch next: follow-up indicators, risks, or unanswered questions.

Rules:
- Use the stored source context when provided, then use web search to fill in current/source-page details.
- For YouTube, ignore sponsorships, coupon codes, affiliate links, and membership pitches unless directly relevant to the investment thesis.
- If a full transcript is unavailable, state that briefly and still reconstruct the supported discussion from the title, video description, page context, and search snippets.
- Do not invent quotes, exact timestamps, or claims that are not supported.`

    const userPrompt = `Deep summarize this ${isYouTube ? 'finance video' : 'finance news article'} for later review.

Title: ${article.title}
Source: ${article.source || 'Unknown'}
URL: ${article.url}
Related symbols: ${article.related_symbols || 'none'}

Available source context:
${sourceContext || article.summary || '(none stored; use web search/page context if available)'}`

    summary = await generateAnalysis(
      systemPrompt,
      userPrompt,
      { webSearch: true, thinking: true, maxTokens: 7000 },
      'news-deep-summary',
    )
  } else {
    const systemPrompt = `You are a rigorous financial news analyst. Create a quick, useful summary for a personal investing dashboard.

Output plain text with TL;DR, key details, why it matters, and watch-next sections.

Include:
• 8-12 bullets of the concrete claims, data points, named companies/assets, price levels, dates, and catalysts. Ignore sponsorships, coupon codes, affiliate links, and membership pitches unless they are directly relevant to the investment thesis.
• A short "Why it matters" bullet explaining portfolio or market relevance.
• A short "Watch next" bullet listing follow-up indicators, risks, or unanswered questions.

Avoid vague filler. If the source is a video, use the cached transcript/context when available; if exact transcript data is unavailable, say so briefly and summarize only what can be supported.

Keep the full response under 250 words.`

    const userPrompt = `Summarize this ${isYouTube ? 'finance video' : 'finance news article'} for later review:

Title: ${article.title}
Source: ${article.source || 'Unknown'}
URL: ${article.url}
Related symbols: ${article.related_symbols || 'none'}

Available source context:
${sourceContext || article.summary || '(none - summarize based on the title and source)'}`

    const hasContext = Boolean(sourceContext || article.summary)
    summary = await generateAnalysis(
      systemPrompt,
      userPrompt,
      { webSearch: !hasContext, maxTokens: 3000 },
      'news-summary',
    )
  }

  const db = getDb()
  if (article.id) {
    db.prepare('UPDATE news_articles SET summary = ? WHERE id = ?').run(summary, article.id)
  } else {
    db.prepare('UPDATE news_articles SET summary = ? WHERE url = ?').run(summary, article.url)
  }
  return summary
}

const LINK_FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// Best-effort metadata for a non-YouTube link: title from og:title/<title>,
// source from the hostname, and published date from article:published_time if present.
async function fetchArticleMetadata(
  url: string,
): Promise<{ title: string | null; source: string; published: string | null }> {
  let host = 'web'
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {}
  try {
    const res = await fetch(url, {
      headers: LINK_FETCH_HEADERS,
      signal: AbortSignal.timeout(12_000),
    })
    const html = await res.text()
    const ogTitle = html.match(
      /<meta[^>]+(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["']/i,
    )?.[1]
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    const rawTitle = ogTitle || titleTag || null
    const published =
      html.match(
        /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
      )?.[1] || null
    return {
      title: rawTitle ? decodeHtmlEntities(rawTitle.replace(/\s+/g, ' ')).trim() : null,
      source: host,
      published,
    }
  } catch {
    return { title: null, source: host, published: null }
  }
}

function isoFromYyyymmdd(yyyymmdd: string | null): string | null {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00.000Z`
}

// Build the context snapshot (portfolio + health + remembered facts) that wraps
// every chat turn. Shared by ai:chat and ai:regenerate.
//
// Prices come from the CACHE (getCachedPrices), not a live fetch: a live fetch
// here did 20+ sequential Yahoo requests per turn, and once Yahoo rate-limited
// (429 + Retry-After backoff) the awaited fetch blocked the whole turn for
// minutes, so the chat appeared to hang. The agent calls get_watchlist_prices
// on demand when it actually needs current prices.
interface ChatContextPrompts {
  systemPrompt: string
  volatileContext?: string
}

async function buildChatContextPrompt(): Promise<ChatContextPrompts> {
  const db = getDb()

  let watchlistSummary: string | undefined
  let healthSummary: string | undefined

  try {
    const prices = getCachedPrices()
    if (prices.length > 0) {
      watchlistSummary = prices
        .map(
          (p) =>
            `${p.symbol}: $${p.price.toFixed(2)} (${p.change >= 0 ? '+' : ''}${p.changePercent.toFixed(2)}%)`,
        )
        .join('\n')
    }
  } catch {}

  try {
    healthSummary = buildSleepAnalysisContext()
  } catch {
    try {
      const sleep = db
        .prepare(
          "SELECT date, value_json FROM health_metrics WHERE metric_type = 'sleep' AND excluded = 0 ORDER BY date DESC LIMIT 1",
        )
        .get() as Record<string, unknown>
      if (sleep) {
        healthSummary = `Last sleep: ${sleep.date} — ${sleep.value_json}`
      }
    } catch {}
  }

  let memorySummary: string | undefined
  try {
    memorySummary = buildMemoryBlock() || undefined
  } catch {}

  const volatileSections: string[] = []
  if (watchlistSummary) {
    volatileSections.push(`**Current Portfolio Snapshot:**\n${watchlistSummary}`)
  }
  if (healthSummary) {
    volatileSections.push(`**Recent Health Snapshot:**\n${healthSummary}`)
  }

  return {
    systemPrompt: buildChatSystemPrompt({ memorySummary }),
    volatileContext: volatileSections.length
      ? `<system-reminder>\nThe following snapshot may be stale. Use tools for current values when accuracy matters.\n\n${volatileSections.join('\n\n')}\n</system-reminder>`
      : undefined,
  }
}

export function registerAiHandlers(): void {
  safeHandle(
    'ai:chat',
    async (
      message: string,
      conversationId?: string,
      model?: string,
      attachments?: ChatAttachmentInput[],
    ) => {
      const { systemPrompt, volatileContext } = await buildChatContextPrompt()
      return await chatWithStreaming(
        message,
        systemPrompt,
        conversationId || 'default',
        model,
        attachments,
        volatileContext,
      )
    },
  )

  safeHandle('ai:regenerate', async (conversationId?: string, model?: string) => {
    const { systemPrompt, volatileContext } = await buildChatContextPrompt()
    return await regenerateLastResponse(systemPrompt, conversationId || 'default', model, volatileContext)
  })

  safeHandle('ai:cancelChat', async (conversationId?: string) => {
    return cancelChat(conversationId || 'default')
  })

  safeHandle(
    'ai:summarizeNewsArticle',

    async (article: {
      id?: number

      title: string

      url: string

      source?: string | null

      related_symbols?: string | null

      summary?: string | null

      content_context?: string | null
    }) => {
      return summarizeArticle(article, 'standard')
    },
  )

  safeHandle('ai:summarizeVideo', async (title: string, url: string) => {
    const sourceContext = (await getVideoContext(url, null, 'quick')).context
    const systemPrompt = `You are a rigorous financial video summarizer. Create a detailed, descriptive summary for a personal investing dashboard.
  
  
  
  Output plain text with a TL;DR, detailed key details, why it matters, and watch-next sections.
  
  Include:
  
  • 8-12 bullets of the concrete claims, data points, named companies/assets, price levels, dates, and catalysts. Ignore sponsorships, coupon codes, affiliate links, and membership pitches unless they are directly relevant to the investment thesis.
  
  • A short "Why it matters" bullet explaining portfolio or market relevance.
  
  • A short "Watch next" bullet listing follow-up indicators, risks, or unanswered questions.
  
  
  
  Avoid vague filler. Use cached transcript/context when available. If exact transcript data is unavailable, say so briefly and summarize only what can be supported from the title, page context, and web search snippets.`

    const userPrompt = `Summarize this finance video for later review:
  
  Title: ${title}
  
  URL: ${url}

  Available source context:
  ${sourceContext || '(none - use web search/page context if available)'}`

    const summary = await generateAnalysis(
      systemPrompt,

      userPrompt,

      { webSearch: !sourceContext, maxTokens: 3000 },

      'video-summary',
    )

    const db = getDb()

    db.prepare('UPDATE news_articles SET summary = ? WHERE url = ?').run(summary, url)

    return summary
  })

  safeHandle(
    'ai:deepSummarizeNewsArticle',

    async (article: {
      id?: number

      title: string

      url: string

      source?: string | null

      related_symbols?: string | null

      summary?: string | null

      content_context?: string | null
    }) => {
      return summarizeArticle(article, 'deep')
    },
  )

  // Paste-a-link → summarize & save. Accepts any http(s) URL: YouTube videos get
  // yt-dlp metadata + transcript; other links get page-title + web-assisted summary.
  // The row is upserted into news_articles and auto-saved so it persists and shows
  // up in the Finance → Summaries panel.
  safeHandle('ai:addLinkSummary', async (rawUrl: string, mode: 'standard' | 'deep' = 'standard') => {
    const url = (rawUrl || '').trim()
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new Error('Please paste a valid http(s) link.')
    }
    const isYouTube = /youtube\.com|youtu\.be/i.test(url)

    let title = ''
    let source: string
    let canonicalUrl = url
    let published: string | null = null
    const relatedSymbols: string | null = null

    if (isYouTube) {
      const meta = await getYouTubeMetadata(url)
      if (meta?.videoId) {
        canonicalUrl = `https://www.youtube.com/watch?v=${meta.videoId}`
      }
      title = meta?.title || 'YouTube video'
      source = meta?.channel ? `YouTube: ${meta.channel}` : 'YouTube'
      published = isoFromYyyymmdd(meta?.uploadDate ?? null)
    } else {
      const meta = await fetchArticleMetadata(url)
      title = meta.title || url
      source = meta.source
      published = meta.published
    }

    const db = getDb()
    const existing = db.prepare('SELECT * FROM news_articles WHERE url = ?').get(canonicalUrl) as
      | { id: number; title: string | null; source: string | null }
      | undefined

    let id: number
    if (existing) {
      id = existing.id
      // Resurface it: clear archive, mark saved, and backfill any missing title/source.
      db.prepare(
        `UPDATE news_articles
           SET archived_at = NULL,
               saved_at = COALESCE(saved_at, datetime('now')),
               title = CASE WHEN COALESCE(TRIM(title), '') = '' THEN ? ELSE title END,
               source = COALESCE(source, ?)
         WHERE id = ?`,
      ).run(title, source, id)
    } else {
      const info = db
        .prepare(
          `INSERT INTO news_articles
             (title, url, source, published_at, related_symbols, saved_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .run(title, canonicalUrl, source, published, relatedSymbols)
      id = Number(info.lastInsertRowid)
    }

    const row = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id) as ArticleSummaryInput
    await summarizeArticle({ ...row, id }, mode)

    return db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id)
  })

  safeHandle('ai:deepSummarizeVideo', async (title: string, url: string) => {
    const sourceContext = (await getVideoContext(url, null, 'deep')).context
    const summary = await generateAnalysis(
      `You are a rigorous financial video analyst. Create a deep, transcript-style summary of what the video is actually talking about. Use cached transcript/context when available. If a full transcript is unavailable, say so briefly and summarize only supported details from web search, page context, title, and description. Include TL;DR, what it covers, thesis and assumptions, why it matters, and watch next.`,
      `Deep summarize this finance video for later review.

Title: ${title}
URL: ${url}

Available source context:
${sourceContext || '(none - use web search/page context if available)'}`,
      { webSearch: true, thinking: true, maxTokens: 7000 },
      'video-deep-summary',
    )

    const db = getDb()
    db.prepare('UPDATE news_articles SET summary = ? WHERE url = ?').run(summary, url)
    return summary
  })

  safeHandle('ai:generateBriefing', async (type: string) => {
    return await generateBriefing(type as BriefingType)
  })

  safeHandle('ai:financeSkill', async (skill: FinanceSkill, symbol?: string) => {
    const db = getDb()

    const systemPrompt = getFinanceSkillPrompt(skill)

    // Helper to save skill result as a briefing

    const saveSkillResult = (content: string) => {
      const today = new Date().toISOString().split('T')[0]

      const briefingType = `skill_${skill}`

      const label = symbol ? `${skill} — ${symbol}` : skill

      db.prepare(
        `INSERT INTO briefings (type, date, content, raw_prompt, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(type, date) DO UPDATE SET
           content = excluded.content,
           raw_prompt = excluded.raw_prompt,
           created_at = excluded.created_at`,
      ).run(briefingType, today, content, label)

      return content
    }

    // Analysis options: web search for live data, thinking for deep analysis

    const analysisOpts: AnalysisOptions = {
      webSearch: true,

      thinking: skill === 'valuation' || skill === 'earnings-review' || skill === 'risk-assessment',

      codeExecution: skill === 'valuation',
    }

    // Portfolio-level skills (no symbol required)

    if (skill === 'risk-assessment') {
      const watchlist = db.prepare('SELECT * FROM watchlist').all() as Array<
        Record<string, unknown>
      >

      const prices = await getLatestPricesLive()

      const priceMap = new Map(prices.map((p) => [p.symbol, p]))

      const symbols = watchlist.map((w: any) => w.symbol)

      const risk = computePortfolioRisk(symbols)

      const equalWeight = watchlist.length > 0 ? 100 / watchlist.length : 0

      const holdings = watchlist.map((w: any) => {
        const live = priceMap.get(w.symbol)

        const price = live?.price || 0

        return {
          symbol: w.symbol,

          type: w.type,

          price,

          weight: equalWeight,

          volatility: risk.volatilities.get(w.symbol) || 0,

          maxDrawdown: risk.maxDrawdowns.get(w.symbol) || 0,

          beta: risk.betas.get(w.symbol) ?? null,

          sharpeApprox: null,
        }
      })

      const weights = holdings.map((h) => h.weight / 100)

      const hhi = weights.reduce((sum, w) => sum + w * w, 0)

      const avgCorr =
        risk.correlations.length > 0
          ? risk.correlations.reduce((sum, c) => sum + c.correlation, 0) / risk.correlations.length
          : 0

      const assetMix = {
        stocks: holdings.filter((h) => h.type === 'stock').reduce((s, h) => s + h.weight, 0),

        crypto: holdings.filter((h) => h.type === 'crypto').reduce((s, h) => s + h.weight, 0),

        etfs: holdings.filter((h) => h.type === 'etf').reduce((s, h) => s + h.weight, 0),
      }

      const totalValue = holdings.reduce((sum, h) => sum + h.price, 0)

      const userPrompt = buildRiskAssessmentPrompt({
        totalValue,

        holdings,

        portfolioMetrics: {
          totalVolatility: holdings.reduce((sum, h) => sum + (h.volatility * h.weight) / 100, 0),

          avgCorrelation: avgCorr,

          herfindahlIndex: hhi,

          assetMix,

          maxDrawdown: Math.max(...holdings.map((h) => h.maxDrawdown), 0),
        },

        correlationPairs: risk.correlations,
      })

      return saveSkillResult(
        await generateAnalysisStreaming(
          systemPrompt,

          userPrompt,

          analysisOpts,

          symbol ? `skill:${skill}:${symbol}` : `skill:${skill}`,
        ),
      )
    }

    if (skill === 'sector-comparison') {
      const watchlist = db.prepare('SELECT * FROM watchlist').all() as Array<
        Record<string, unknown>
      >

      const prices = await getLatestPricesLive()

      const priceMap = new Map(prices.map((p) => [p.symbol, p]))

      // Get 20-day returns for each holding

      const holdings = watchlist.map((w: any) => {
        const live = priceMap.get(w.symbol)

        const history = db

          .prepare(
            `
  
            SELECT close FROM price_history WHERE symbol = ? AND close IS NOT NULL ORDER BY date ASC
  
          `,
          )

          .all(w.symbol) as Array<{ close: number }>

        let returnPeriod = 0

        if (history.length >= 2) {
          const first = history[Math.max(0, history.length - 21)]?.close || history[0].close

          const last = history[history.length - 1].close

          returnPeriod = ((last - first) / first) * 100
        }

        const equalWeight = watchlist.length > 0 ? 100 / watchlist.length : 0

        return {
          symbol: w.symbol,

          type: w.type,

          price: live?.price || 0,

          weight: equalWeight,

          returnPeriod,
        }
      })

      const totalReturn = holdings.reduce((sum, h) => sum + (h.returnPeriod * h.weight) / 100, 0)

      // Ensure SPY and QQQ have price data

      const benchmarkSymbols = ['SPY', 'QQQ']

      const missingBenchmarks = benchmarkSymbols.filter((sym) => {
        const rows = db

          .prepare(
            'SELECT COUNT(*) as count FROM price_history WHERE symbol = ? AND close IS NOT NULL',
          )

          .get(sym) as { count: number } | undefined

        return !rows || rows.count < 2
      })

      if (missingBenchmarks.length > 0) {
        await fetchYahooPrices(missingBenchmarks)
      }

      // Get benchmark returns (SPY, QQQ)

      const benchmarks: Array<{
        symbol: string

        name: string

        price: number

        returnPeriod: number
      }> = []

      for (const [sym, name] of [
        ['SPY', 'S&P 500'],

        ['QQQ', 'Nasdaq 100'],
      ] as const) {
        const bHistory = db

          .prepare(
            `
  
            SELECT close FROM price_history WHERE symbol = ? AND close IS NOT NULL ORDER BY date ASC
  
          `,
          )

          .all(sym) as Array<{ close: number }>

        if (bHistory.length >= 2) {
          const first = bHistory[Math.max(0, bHistory.length - 21)]?.close || bHistory[0].close

          const last = bHistory[bHistory.length - 1].close

          benchmarks.push({
            symbol: sym,

            name,

            price: last,

            returnPeriod: ((last - first) / first) * 100,
          })
        }
      }

      // Relative strength

      const spyReturn = benchmarks.find((b) => b.symbol === 'SPY')?.returnPeriod || 0

      const relativeStrength = holdings.map((h) => ({
        symbol: h.symbol,

        rsVsMarket: spyReturn !== 0 ? (1 + h.returnPeriod / 100) / (1 + spyReturn / 100) : 1,
      }))

      const userPrompt = buildSectorComparisonPrompt({
        portfolio: { holdings, totalReturn },

        benchmarks,

        relativeStrength,
      })

      return saveSkillResult(
        await generateAnalysisStreaming(
          systemPrompt,

          userPrompt,

          analysisOpts,

          symbol ? `skill:${skill}:${symbol}` : `skill:${skill}`,
        ),
      )
    }

    if (skill === 'market-research') {
      const watchlist = db.prepare('SELECT * FROM watchlist').all() as Array<{
        symbol: string
        type: string
      }>

      const prices = await getLatestPricesLive()

      const priceMap = new Map(prices.map((p) => [p.symbol, p]))

      const enrichedWatchlist = watchlist.map((w) => {
        const live = priceMap.get(w.symbol)

        return {
          symbol: w.symbol,

          type: w.type,

          price: live?.price,

          change: live?.change,

          changePercent: live?.changePercent,
        }
      })

      const priceHistory = db

        .prepare(
          `
  
          SELECT symbol, date, close FROM price_history
  
          WHERE date >= date('now', '-7 days')

          ORDER BY date ASC

        `,
        )

        .all() as Array<{ symbol: string; date: string; close: number }>

      const news = db

        .prepare(
          `

          SELECT title, source, related_symbols FROM news_articles

          WHERE archived_at IS NULL

          ORDER BY published_at DESC LIMIT 15

        `,
        )

        .all() as Array<{ title: string; source?: string; related_symbols?: string }>

      const userPrompt = buildMarketResearchPrompt({
        watchlist: enrichedWatchlist,

        priceHistory,

        news,
      })

      return saveSkillResult(
        await generateAnalysisStreaming(
          systemPrompt,

          userPrompt,

          analysisOpts,

          symbol ? `skill:${skill}:${symbol}` : `skill:${skill}`,
        ),
      )
    }

    // Symbol-specific skills (earnings-review, valuation)

    if (!symbol) throw new Error('Symbol required for this skill')

    const upperSymbol = symbol.toUpperCase()

    const watchlistItem = db

      .prepare('SELECT * FROM watchlist WHERE symbol = ?')

      .get(upperSymbol) as { symbol: string; type: string; name?: string } | undefined

    const priceHistory = db

      .prepare(
        `

        SELECT date, close FROM price_history

        WHERE symbol = ? ORDER BY date DESC LIMIT 14

      `,
      )

      .all(upperSymbol) as Array<{ date: string; close: number }>

    const news = db

      .prepare(
        `

        SELECT title, source, published_at FROM news_articles

        WHERE related_symbols LIKE ?

          AND archived_at IS NULL

        ORDER BY published_at DESC LIMIT 10

      `,
      )

      .all(`%${upperSymbol}%`) as Array<{ title: string; source?: string; published_at?: string }>

    const prices = await getLatestPricesLive()

    const livePrice = prices.find((p) => p.symbol === upperSymbol)

    if (skill === 'technical-analysis') {
      const { indicators, supportResistance, priceHistory: ohlcv } = computeIndicators(upperSymbol)

      const userPrompt = buildTechnicalAnalysisPrompt({
        symbol: upperSymbol,

        assetType: watchlistItem?.type || 'stock',

        currentPrice: livePrice?.price || ohlcv[ohlcv.length - 1]?.close || 0,

        indicators,

        supportResistance,

        priceHistory: ohlcv,
      })

      return saveSkillResult(
        await generateAnalysisStreaming(
          systemPrompt,

          userPrompt,

          analysisOpts,

          symbol ? `skill:${skill}:${symbol}` : `skill:${skill}`,
        ),
      )
    }

    if (skill === 'earnings-review') {
      const fundamentals = getFundamentals(upperSymbol)

      const nextEarning = db

        .prepare(
          `
  
          SELECT report_date, eps_estimate FROM earnings_calendar
  
          WHERE symbol = ? AND report_date >= date('now')
  
          ORDER BY report_date ASC LIMIT 1
  
        `,
        )

        .get(upperSymbol) as { report_date: string; eps_estimate: number | null } | undefined

      const userPrompt = buildEarningsReviewPrompt({
        symbol: upperSymbol,

        companyName: watchlistItem?.name,

        currentPrice: livePrice?.price,

        recentPrices: priceHistory.reverse(),

        news,

        watchlistType: watchlistItem?.type,

        fundamentals: fundamentals
          ? {
              pe: fundamentals.pe,

              eps: fundamentals.eps,

              revenue: fundamentals.revenue,

              market_cap: fundamentals.market_cap,

              dividend_yield: fundamentals.dividend_yield,

              sector: fundamentals.sector,
            }
          : undefined,

        nextEarningsDate: nextEarning?.report_date,

        epsEstimate: nextEarning?.eps_estimate,
      })

      return saveSkillResult(
        await generateAnalysisStreaming(
          systemPrompt,

          userPrompt,

          analysisOpts,

          symbol ? `skill:${skill}:${symbol}` : `skill:${skill}`,
        ),
      )
    }

    if (skill === 'valuation') {
      const userPrompt = buildValuationPrompt({
        symbol: upperSymbol,

        assetType: watchlistItem?.type || 'stock',

        currentPrice: livePrice?.price,

        priceHistory: priceHistory.reverse(),

        changePercent: livePrice?.changePercent,

        news,
      })

      return saveSkillResult(
        await generateAnalysisStreaming(
          systemPrompt,

          userPrompt,

          analysisOpts,

          symbol ? `skill:${skill}:${symbol}` : `skill:${skill}`,
        ),
      )
    }

    throw new Error(`Unknown finance skill: ${skill}`)
  })

  safeHandle('ai:getHistory', (conversationId: string = 'default') => {
    return getChatHistory(conversationId)
  })

  safeHandle('ai:clearHistory', (conversationId: string = 'default') => {
    clearChatHistory(conversationId)

    return { status: 'ok' }
  })

  safeHandle('ai:listConversations', () => {
    return listConversations()
  })

  safeHandle('ai:renameConversation', (conversationId: string, title: string) => {
    renameConversation(conversationId, title)
    return { ok: true }
  })

  safeHandle('ai:pinConversation', (conversationId: string, pinned: boolean) => {
    setConversationPinned(conversationId, pinned)
    return { ok: true }
  })

  safeHandle('ai:deleteConversation', (conversationId: string) => {
    deleteConversation(conversationId)
    return { ok: true }
  })

  safeHandle('ai:trimMessagesFrom', (conversationId: string, messageId: number) => {
    deleteMessagesFrom(conversationId, messageId)
    return { ok: true }
  })

  safeHandle('ai:listArchivedConversations', () => {
    return listArchivedConversations()
  })

  safeHandle('ai:archiveConversation', (conversationId: string, archived: boolean) => {
    setConversationArchived(conversationId, archived)
    return { ok: true }
  })

  safeHandle('ai:searchMessages', (query: string) => {
    return searchMessages(query)
  })

  safeHandle('ai:getConversationAttachments', (conversationId: string = 'default') => {
    return getConversationAttachments(conversationId)
  })

  safeHandle('ai:exportConversation', async (conversationId: string) => {
    const { title, markdown } = exportConversation(conversationId)
    const safeName = title.replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'chat'
    const result = await dialog.showSaveDialog({
      title: 'Export conversation',
      defaultPath: `${safeName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    fs.writeFileSync(result.filePath, markdown, 'utf-8')
    return { ok: true, path: result.filePath }
  })

  // Durable memory CRUD
  safeHandle('ai:getMemories', () => {
    return listMemories()
  })

  safeHandle('ai:addMemory', (content: string, category?: string) => {
    return addMemory(content, category || 'general')
  })

  safeHandle('ai:updateMemory', (id: number, content: string, category?: string) => {
    updateMemory(id, content, category)
    return { ok: true }
  })

  safeHandle('ai:deleteMemory', (id: number) => {
    deleteMemory(id)
    return { ok: true }
  })

  safeHandle('ai:clearMemories', () => {
    clearMemories()
    return { ok: true }
  })

  safeHandle(
    'chat:saveMessage',

    (role: string, content: string, conversationId: string = 'default') => {
      if (role !== 'user' && role !== 'assistant' && role !== 'system') {
        throw new Error(`Invalid role: ${role}`)
      }

      getDb()
        .prepare('INSERT INTO chat_messages (role, content, conversation_id) VALUES (?, ?, ?)')

        .run(role, content, conversationId)

      return { ok: true }
    },
  )

  safeHandle('ai:getActivityLog', (limit?: number) => {
    return getDb()
      .prepare(
        `SELECT id, timestamp, kind, label, model, tokens_in, tokens_out,
  
                cache_read_tokens, cache_create_tokens, duration_ms, status, error_msg
  
         FROM ai_activity_log ORDER BY timestamp DESC LIMIT ?`,
      )

      .all(limit ?? 100)
  })

  safeHandle('ai:getActivityStats', (days?: number) => {
    const d = days ?? 30

    const row = getDb()
      .prepare(
        `SELECT
  
           COUNT(*) AS calls,
  
           SUM(tokens_in) AS tokens_in,
  
           SUM(tokens_out) AS tokens_out,
  
           SUM(cache_read_tokens) AS cache_read,
  
           SUM(cache_create_tokens) AS cache_create,
  
           AVG(duration_ms) AS avg_ms,
  
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
  
         FROM ai_activity_log
  
         WHERE timestamp >= datetime('now', '-' || ? || ' days')`,
      )

      .get(d) as Record<string, unknown>

    return {
      days: d,

      calls: Number(row?.calls || 0),

      tokensIn: Number(row?.tokens_in || 0),

      tokensOut: Number(row?.tokens_out || 0),

      cacheRead: Number(row?.cache_read || 0),

      cacheCreate: Number(row?.cache_create || 0),

      avgMs: Number(row?.avg_ms || 0),

      errors: Number(row?.errors || 0),
    }
  })

  safeHandle('ai:clearActivityLog', () => {
    getDb().prepare('DELETE FROM ai_activity_log').run()

    return { ok: true }
  })

  safeHandle('ai:previewBriefing', async (type: string) => {
    const { system, user } = await buildBriefingPrompt(type as BriefingType)

    const total = system.length + user.length

    return {
      system,

      user,

      chars: total,

      estTokens: Math.ceil(total / 4),
    }
  })

  safeHandle('briefings:getLatest', (type?: string) => {
    const db = getDb()

    if (type) {
      return (
        db

          .prepare('SELECT * FROM briefings WHERE type = ? ORDER BY created_at DESC LIMIT 1')

          .get(type) || null
      )
    }

    return db.prepare('SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1').get() || null
  })

  safeHandle('briefings:getAll', (limit: number = 20) => {
    const db = getDb()

    return db.prepare('SELECT * FROM briefings ORDER BY created_at DESC LIMIT ?').all(limit)
  })

  safeHandle('ai:checkConnection', async () => {
    return await checkAIConnection()
  })

  safeHandle('ai:getCacheStats', (days?: number) => {
    const db = getDb()

    const lookback = days ?? 30

    const row = db

      .prepare(
        `
  
        SELECT
  
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
  
          COALESCE(SUM(cache_create_tokens), 0) AS cache_create,
  
          COALESCE(SUM(tokens_in), 0) AS tokens_in,
  
          COALESCE(SUM(tokens_out), 0) AS tokens_out,
  
          COUNT(*) AS calls
  
        FROM ai_activity_log
  
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
  
      `,
      )

      .get(lookback) as {
      cache_read: number

      cache_create: number

      tokens_in: number

      tokens_out: number

      calls: number
    }

    const cacheTotal = (row.cache_read ?? 0) + (row.cache_create ?? 0)

    const denom = (row.tokens_in ?? 0) + cacheTotal

    const hitRate = denom > 0 ? (row.cache_read / denom) * 100 : 0

    return {
      hitRatePct: hitRate,

      cacheReadTokens: row.cache_read,

      cacheCreateTokens: row.cache_create,

      inputTokens: row.tokens_in,

      outputTokens: row.tokens_out,

      calls: row.calls,

      lookbackDays: lookback,
    }
  })
}
