import { getDb } from '../db/database'
import { generateAnalysisStreaming, type AnalysisOptions } from '../services/ai.service'
import { getLatestPricesLive } from '../services/finance'
import {
  FINANCE_SYSTEM_PROMPT,
  HEALTH_SYSTEM_PROMPT,
  MORNING_SLEEP_SYSTEM_PROMPT,
  buildFinanceBriefingPrompt,
  buildHealthBriefingPrompt,
} from './prompts'
import { MARKET_RESEARCH_SYSTEM, buildMarketResearchPrompt } from './skills/finance'
import {
  buildSleepAnalysisContext,
  calculateRecoveryReadiness,
  calculateWorkoutSleepCorrelation,
} from '../services/health/sleep-analysis'
import type { BriefingType } from '../../shared/types/ipc.types'

const SONNET_MODEL = 'claude-sonnet-4-6'
const HAIKU_MODEL = 'claude-haiku-4-5'

function getBriefingOptions(type: BriefingType): AnalysisOptions {
  switch (type) {
    case 'morning_finance':
      return { webSearch: true, cacheSystem: false }
    case 'market_research':
      return { webSearch: true, thinking: true, effort: 'high', cacheSystem: false }
    case 'health_weekly':
      return { model: SONNET_MODEL, cacheSystem: false }
    case 'morning_sleep':
      return { model: HAIKU_MODEL, cacheSystem: false, maxTokens: 1200 }
    default:
      throw new Error(`Unknown briefing type: ${type}`)
  }
}

export async function buildBriefingPrompt(
  type: BriefingType,
): Promise<{ system: string; user: string }> {
  switch (type) {
    case 'morning_finance':
      return { system: FINANCE_SYSTEM_PROMPT, user: await buildFinanceContext() }
    case 'market_research':
      return { system: MARKET_RESEARCH_SYSTEM, user: await buildMarketResearchContext() }
    case 'health_weekly':
      return { system: HEALTH_SYSTEM_PROMPT, user: buildHealthContext() }
    case 'morning_sleep':
      return { system: MORNING_SLEEP_SYSTEM_PROMPT, user: buildMorningSleepContext() }
    default:
      throw new Error(`Unknown briefing type: ${type}`)
  }
}

export async function generateBriefing(type: BriefingType): Promise<string> {
  const db = getDb()

  let systemPrompt: string
  let userPrompt: string

  switch (type) {
    case 'morning_finance':
      systemPrompt = FINANCE_SYSTEM_PROMPT
      userPrompt = await buildFinanceContext()
      break
    case 'market_research':
      systemPrompt = MARKET_RESEARCH_SYSTEM
      userPrompt = await buildMarketResearchContext()
      break
    case 'health_weekly':
      systemPrompt = HEALTH_SYSTEM_PROMPT
      userPrompt = buildHealthContext()
      break
    case 'morning_sleep':
      systemPrompt = MORNING_SLEEP_SYSTEM_PROMPT
      userPrompt = buildMorningSleepContext()
      break
    default:
      throw new Error(`Unknown briefing type: ${type}`)
  }

  const opts = getBriefingOptions(type)

  const content = await generateAnalysisStreaming(
    systemPrompt,
    userPrompt,
    opts,
    `briefing:${type}`,
  )
  const today = new Date().toISOString().split('T')[0]

  // UPSERT: one briefing per (type, date). Re-running replaces the prior row
  // rather than stacking duplicates from cron + manual + relay paths.
  db.prepare(
    `
    INSERT INTO briefings (type, date, content, raw_prompt, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(type, date) DO UPDATE SET
      content = excluded.content,
      raw_prompt = excluded.raw_prompt,
      created_at = excluded.created_at
  `,
  ).run(type, today, content, userPrompt.substring(0, 2000))

  return content
}

async function buildFinanceContext(): Promise<string> {
  const db = getDb()

  // Get live prices
  const prices = await getLatestPricesLive()
  const watchlist = prices.map((p) => ({
    symbol: p.symbol,
    type: p.type,
    price: p.price,
    change: p.change,
    changePercent: p.changePercent,
  }))

  // Get recent price history (7 days)
  const priceHistory = db
    .prepare(
      `
    SELECT symbol, date, close FROM price_history
    WHERE date >= date('now', '-7 days') AND close IS NOT NULL
    ORDER BY symbol, date
  `,
    )
    .all() as Array<{ symbol: string; date: string; close: number }>

  // Get recent news (last day, never archived)
  const news = db
    .prepare(
      `
    SELECT title, source, published_at, related_symbols FROM news_articles
    WHERE archived_at IS NULL
      AND fetched_at >= datetime('now', '-1 day')
    ORDER BY published_at DESC
    LIMIT 20
  `,
    )
    .all() as Array<{
    title: string
    source: string | null
    published_at: string | null
    related_symbols: string | null
  }>

  return buildFinanceBriefingPrompt({ watchlist, priceHistory, news })
}

async function buildMarketResearchContext(): Promise<string> {
  const db = getDb()

  const prices = await getLatestPricesLive()
  const watchlist = prices.map((p) => ({
    symbol: p.symbol,
    type: p.type,
    price: p.price,
    change: p.change,
    changePercent: p.changePercent,
  }))

  const priceHistory = db
    .prepare(
      `
    SELECT symbol, date, close FROM price_history
    WHERE date >= date('now', '-7 days') AND close IS NOT NULL
    ORDER BY symbol, date
  `,
    )
    .all() as Array<{ symbol: string; date: string; close: number }>

  const news = db
    .prepare(
      `
    SELECT title, source, related_symbols FROM news_articles
    WHERE archived_at IS NULL
      AND fetched_at >= datetime('now', '-2 days')
    ORDER BY published_at DESC
    LIMIT 15
  `,
    )
    .all() as Array<{ title: string; source?: string; related_symbols?: string }>

  return buildMarketResearchPrompt({ watchlist, priceHistory, news })
}

function buildMorningSleepContext(): string {
  const db = getDb()
  const latestSleep = db
    .prepare(
      `SELECT date FROM health_metrics
       WHERE metric_type = 'sleep' AND excluded = 0
       ORDER BY date DESC LIMIT 1`,
    )
    .get() as { date: string } | undefined
  if (!latestSleep) {
    throw new Error('No sleep data available for morning report.')
  }

  // buildSleepAnalysisContext already includes all analysis (debt, circadian, quality,
  // regularity, recovery readiness, workout correlation)
  return buildSleepAnalysisContext()
}

function buildHealthContext(): string {
  const db = getDb()

  const sleep = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'sleep' AND excluded = 0
    ORDER BY date DESC LIMIT 7
  `,
    )
    .all() as Array<{ date: string; value_json: string }>

  const heartRate = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'heart_rate'
    ORDER BY date DESC LIMIT 7
  `,
    )
    .all() as Array<{ date: string; value_json: string }>

  const hrv = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'hrv'
    ORDER BY date DESC LIMIT 7
  `,
    )
    .all() as Array<{ date: string; value_json: string }>

  const steps = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'steps'
    ORDER BY date DESC LIMIT 7
  `,
    )
    .all() as Array<{ date: string; value_json: string }>

  if (sleep.length === 0 && heartRate.length === 0 && hrv.length === 0 && steps.length === 0) {
    throw new Error('No health data available for weekly briefing.')
  }

  // Add comprehensive sleep analysis
  let sleepAnalysis = ''
  try {
    sleepAnalysis = buildSleepAnalysisContext()
  } catch {}

  const rawPrompt = buildHealthBriefingPrompt({ sleep, heartRate, hrv, steps })
  return sleepAnalysis ? `${sleepAnalysis}\n\n${rawPrompt}` : rawPrompt
}
