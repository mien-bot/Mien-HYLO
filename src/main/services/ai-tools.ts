/**
 * Agent tools for the chat assistant.
 *
 * These turn Mien from a text responder into an agent: the model decides when
 * to call them, and each one pulls *fresh* data on demand (live quotes, current
 * sleep/fitness analysis, recent news, portfolio) rather than relying on a
 * static context snapshot baked into the system prompt.
 *
 * Every tool is READ-ONLY and side-effect free — the agent can gather and
 * analyse, but never mutates user data. Each executor is defensive: it returns
 * a readable string (or an error marker) instead of throwing, so a single bad
 * tool call never derails the turn. The caller (runChatStream) additionally
 * wraps each call in a hard timeout.
 */
import { getDb } from '../db/database'
import { getLatestPricesLive } from './finance'
import { fetchYahooQuote } from './finance/yahoo.fetcher'
import { fetchCoinGeckoQuote } from './finance/coingecko.fetcher'
import { buildSleepAnalysisContext } from './health/sleep-analysis'
import { calculateTrainingLoad, calculateRecovery } from './health/fitness-analysis'

/** Anthropic custom-tool definition shape. */
export interface AgentToolDef {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolResult {
  content: string
  isError: boolean
}

/** Tool catalogue advertised to the model. */
export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: 'get_watchlist_prices',
    description:
      "Get the user's full watchlist with LIVE current prices and intraday change. Use this for any question about how the portfolio/watchlist is doing right now.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_quote',
    description:
      'Get a live price quote for one or more specific tickers. Use for stocks/ETFs the user names. Set asset_type to "crypto" for coins (e.g. BTC, ETH).',
    input_schema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ticker symbols, e.g. ["AAPL","NVDA"] or ["BTC"].',
        },
        asset_type: {
          type: 'string',
          enum: ['stock', 'crypto'],
          description: 'Defaults to stock. Use crypto for coins.',
        },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'get_sleep_analysis',
    description:
      "Get the user's current sleep analysis: sleep debt, last night's stages/efficiency, circadian energy phases, recovery readiness, chronotype. Use for any sleep/recovery question.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_fitness_analysis',
    description:
      'Get current training load (CTL/ATL/TSB form), ACWR injury-risk ratio, and recovery scoring (HRV, resting HR, sleep). Use for fitness, training, or recovery questions.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback window in days (default 42).' },
      },
    },
  },
  {
    name: 'get_health_metrics',
    description:
      'Get raw daily values for one health metric over a date range. Metrics: sleep, heart_rate, hrv, resting_heart_rate, steps, active_energy, vo2_max, respiratory_rate, blood_oxygen, exercise_time.',
    input_schema: {
      type: 'object',
      properties: {
        metric_type: { type: 'string', description: 'The metric to fetch.' },
        days: { type: 'number', description: 'How many days back (default 14).' },
      },
      required: ['metric_type'],
    },
  },
  {
    name: 'get_recent_news',
    description:
      'Get recent finance news/video headlines the app has collected (Google News + YouTube). Optionally filter by ticker symbol.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max headlines (default 15).' },
        symbol: { type: 'string', description: 'Optional ticker to filter by.' },
      },
    },
  },
  {
    name: 'get_portfolio',
    description:
      "Get the user's actual holdings with quantity, cost basis, latest known price, and unrealized gain/loss. Use for net-worth, allocation, or P/L questions.",
    input_schema: { type: 'object', properties: {} },
  },
]

/** Short present-tense labels for the "Mien is …" status line in the UI. */
export const TOOL_LABELS: Record<string, string> = {
  get_watchlist_prices: 'checking your watchlist',
  get_quote: 'fetching live quotes',
  get_sleep_analysis: 'reviewing your sleep',
  get_fitness_analysis: 'reviewing your training load',
  get_health_metrics: 'pulling your health metrics',
  get_recent_news: 'scanning recent news',
  get_portfolio: 'opening your portfolio',
  web_search: 'searching the web',
}

const CRYPTO_ID_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  DOT: 'polkadot',
  LINK: 'chainlink',
  MATIC: 'matic-network',
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

async function getQuotes(input: Record<string, unknown>): Promise<string> {
  const rawSymbols = Array.isArray(input.symbols) ? input.symbols : []
  const symbols = rawSymbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 10)
  if (symbols.length === 0) return 'No symbols provided.'
  const isCrypto = asString(input.asset_type).toLowerCase() === 'crypto'

  const lines: string[] = []
  for (const sym of symbols) {
    try {
      if (isCrypto) {
        const coinId = CRYPTO_ID_MAP[sym] || sym.toLowerCase()
        const q = await fetchCoinGeckoQuote(coinId)
        lines.push(
          q
            ? `${sym}: $${q.price.toLocaleString()} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}% 24h)`
            : `${sym}: no data`,
        )
      } else {
        const q = await fetchYahooQuote(sym)
        lines.push(
          q
            ? `${sym}: $${q.price.toFixed(2)} (${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}, ${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%) vol ${q.volume.toLocaleString()}`
            : `${sym}: no data`,
        )
      }
    } catch {
      lines.push(`${sym}: fetch failed`)
    }
  }
  return lines.join('\n')
}

function getHealthMetrics(input: Record<string, unknown>): string {
  const metricType = asString(input.metric_type)
  if (!metricType) return 'metric_type is required.'
  const days = Math.max(1, Math.min(365, asNumber(input.days, 14)))
  const db = getDb()
  // Match the rest of the app: skip rows flagged as outliers (excluded = 1),
  // e.g. AutoSleep over-counts. Cap the row count so a large window of fat
  // value_json blobs (sleep stages) can't blow up the tool-result payload.
  const MAX_ROWS = 60
  const rows = db
    .prepare(
      `SELECT date, value_json FROM health_metrics
       WHERE metric_type = ? AND excluded = 0 AND date >= date('now', ?)
       ORDER BY date DESC LIMIT ?`,
    )
    .all(metricType, `-${days} days`, MAX_ROWS) as Array<{ date: string; value_json: string }>
  if (rows.length === 0) return `No ${metricType} data in the last ${days} days.`
  const lines = rows.map((r) => `${r.date}: ${r.value_json}`)
  const note = rows.length === MAX_ROWS ? ` (showing most recent ${MAX_ROWS})` : ''
  return `${metricType} (last ${days} days, ${rows.length} records${note}):\n${lines.join('\n')}`
}

function getRecentNews(input: Record<string, unknown>): string {
  const limit = Math.max(1, Math.min(50, asNumber(input.limit, 15)))
  const symbol = asString(input.symbol).trim().toUpperCase()
  const db = getDb()
  // archived_at IS NULL skips articles that have aged out of the feeds, matching
  // how the rest of the app reads news.
  const rows = symbol
    ? (db
        .prepare(
          `SELECT title, source, published_at, related_symbols FROM news_articles
           WHERE archived_at IS NULL AND related_symbols LIKE ? ORDER BY published_at DESC LIMIT ?`,
        )
        .all(`%${symbol}%`, limit) as Array<Record<string, string | null>>)
    : (db
        .prepare(
          `SELECT title, source, published_at, related_symbols FROM news_articles
           WHERE archived_at IS NULL ORDER BY published_at DESC LIMIT ?`,
        )
        .all(limit) as Array<Record<string, string | null>>)
  if (rows.length === 0) return symbol ? `No recent news for ${symbol}.` : 'No recent news collected.'
  const lines = rows.map(
    (r) => `- [${r.source || '?'}] ${r.title}${r.published_at ? ` (${r.published_at.slice(0, 10)})` : ''}`,
  )
  return `Recent news${symbol ? ` for ${symbol}` : ''}:\n${lines.join('\n')}`
}

function getPortfolio(): string {
  const db = getDb()
  const holdings = db
    .prepare('SELECT symbol, quantity, cost_basis, notes FROM holdings ORDER BY symbol')
    .all() as Array<{ symbol: string; quantity: number; cost_basis: number; notes: string | null }>
  if (holdings.length === 0) return 'No holdings recorded.'

  const lastClose = db.prepare(
    `SELECT close FROM price_history WHERE symbol = ? ORDER BY date DESC LIMIT 1`,
  )
  const lines = holdings.map((h) => {
    const row = lastClose.get(h.symbol) as { close: number } | undefined
    const price = row?.close
    const value = price != null ? price * h.quantity : null
    const cost = h.cost_basis * h.quantity
    const pl = value != null ? value - cost : null
    const plPct = value != null && cost > 0 ? (pl! / cost) * 100 : null
    const parts = [`${h.symbol}: ${h.quantity} @ cost $${h.cost_basis.toFixed(2)}`]
    if (price != null) parts.push(`last $${price.toFixed(2)}`)
    if (value != null) parts.push(`value $${value.toFixed(2)}`)
    if (pl != null) parts.push(`P/L ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)} (${plPct!.toFixed(1)}%)`)
    if (h.notes) parts.push(`note: ${h.notes}`)
    return `- ${parts.join(' | ')}`
  })
  return `Holdings (prices are latest stored close, not live):\n${lines.join('\n')}`
}

/**
 * Run a tool by name. Never throws — returns { content, isError } so the agent
 * loop can feed the result straight back to the model.
 */
export async function executeAgentTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_watchlist_prices': {
        const prices = await getLatestPricesLive()
        if (prices.length === 0) return { content: 'Watchlist is empty.', isError: false }
        const content = prices
          .map(
            (p) =>
              `${p.symbol} (${p.type}): $${p.price.toFixed(2)} (${p.change >= 0 ? '+' : ''}${p.changePercent.toFixed(2)}%)`,
          )
          .join('\n')
        return { content, isError: false }
      }
      case 'get_quote':
        return { content: await getQuotes(input), isError: false }
      case 'get_sleep_analysis': {
        const content = buildSleepAnalysisContext()
        return { content: content || 'No sleep data available.', isError: false }
      }
      case 'get_fitness_analysis': {
        const days = Math.max(7, Math.min(180, asNumber(input.days, 42)))
        const load = calculateTrainingLoad(days)
        const recovery = calculateRecovery(Math.min(days, 60))
        return {
          content: JSON.stringify({ trainingLoad: load, recovery }, null, 2),
          isError: false,
        }
      }
      case 'get_health_metrics':
        return { content: getHealthMetrics(input), isError: false }
      case 'get_recent_news':
        return { content: getRecentNews(input), isError: false }
      case 'get_portfolio':
        return { content: getPortfolio(), isError: false }
      default:
        return { content: `Unknown tool: ${name}`, isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `Tool ${name} failed: ${msg}`, isError: true }
  }
}
