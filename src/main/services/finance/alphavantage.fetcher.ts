/**
 * Alpha Vantage fetcher — company overview (fundamentals) and earnings.
 *
 * The free tier is 25 requests/day, so calls are aggressive about caching:
 * fundamentals/earnings rows are valid for 24h before being re-fetched.
 */

import { getDb } from '../../db/database'
import { fetchJson, fetchText } from '../../lib/fetch-with-retry'
import { getAppSettings } from '../../lib/settings'

const BASE = 'https://www.alphavantage.co/query'
const FUNDAMENTALS_COLUMNS =
  'symbol, pe, pb, eps, revenue, market_cap, dividend_yield, sector, fetched_at'

function getApiKey(): string | null {
  const settings = getAppSettings()
  const key = settings?.alphaVantageKey
  return typeof key === 'string' && key.length > 0 ? key : null
}

async function alphaVantageGet(params: Record<string, string>): Promise<any | null> {
  const key = getApiKey()
  if (!key) return null
  const url = `${BASE}?${new URLSearchParams({ ...params, apikey: key }).toString()}`
  const data = await fetchJson<any>(url, { label: `alphavantage ${params.function}` })
  if (!data) return null
  // Free-tier rate-limit messages come back as { Note: "..." } or { Information: "..." }
  if (data?.Note || data?.Information) {
    console.warn('[AlphaVantage] rate-limited or info:', data.Note || data.Information)
    return null
  }
  return data
}

export interface FundamentalsRow {
  symbol: string
  pe: number | null
  pb: number | null
  eps: number | null
  revenue: number | null
  market_cap: number | null
  dividend_yield: number | null
  sector: string | null
  fetched_at: string
}

export interface EarningsCalendarRow {
  symbol: string
  report_date: string
  fiscal_period: string | null
  eps_estimate: number | null
  eps_actual: number | null
  surprise_pct: number | null
}

function num(v: unknown): number | null {
  if (v == null || v === '' || v === 'None' || v === '-') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

/**
 * Fetch and store company OVERVIEW for one symbol.
 * Skips the network call if a row was fetched in the last 24h.
 */
export async function fetchFundamentals(
  symbol: string,
  force = false,
): Promise<FundamentalsRow | null> {
  const db = getDb()
  const upper = symbol.toUpperCase()

  if (!force) {
    const cached = db
      .prepare(
        `SELECT ${FUNDAMENTALS_COLUMNS} FROM fundamentals WHERE symbol = ? AND fetched_at > datetime('now', '-1 day')`,
      )
      .get(upper) as FundamentalsRow | undefined
    if (cached) return cached
  }

  const data = await alphaVantageGet({ function: 'OVERVIEW', symbol: upper })
  if (!data || !data.Symbol) return null

  const row: FundamentalsRow = {
    symbol: upper,
    pe: num(data.PERatio),
    pb: num(data.PriceToBookRatio),
    eps: num(data.EPS),
    revenue: num(data.RevenueTTM),
    market_cap: num(data.MarketCapitalization),
    dividend_yield: num(data.DividendYield),
    sector: data.Sector || null,
    fetched_at: new Date().toISOString(),
  }

  db.prepare(
    `
    INSERT INTO fundamentals (symbol, pe, pb, eps, revenue, market_cap, dividend_yield, sector, fetched_at)
    VALUES (@symbol, @pe, @pb, @eps, @revenue, @market_cap, @dividend_yield, @sector, @fetched_at)
    ON CONFLICT(symbol) DO UPDATE SET
      pe = excluded.pe,
      pb = excluded.pb,
      eps = excluded.eps,
      revenue = excluded.revenue,
      market_cap = excluded.market_cap,
      dividend_yield = excluded.dividend_yield,
      sector = excluded.sector,
      fetched_at = excluded.fetched_at
  `,
  ).run(row)

  return row
}

/**
 * Fetch upcoming earnings calendar (next N months). Returns rows inserted.
 * Alpha Vantage EARNINGS_CALENDAR returns CSV.
 */
export async function fetchEarningsCalendar(
  horizon: '3month' | '6month' | '12month' = '3month',
): Promise<number> {
  const key = getApiKey()
  if (!key) return 0

  const url = `${BASE}?${new URLSearchParams({ function: 'EARNINGS_CALENDAR', horizon, apikey: key }).toString()}`
  const csv = await fetchText(url, { label: 'alphavantage earnings_calendar' })
  if (!csv) return 0

  // Header: symbol,name,reportDate,fiscalDateEnding,estimate,currency
  const lines = csv.trim().split('\n')
  if (lines.length < 2) return 0
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const idx = (k: string) => header.indexOf(k)

  const symIdx = idx('symbol')
  const reportIdx = idx('reportdate')
  const fiscalIdx = idx('fiscaldateending')
  const estIdx = idx('estimate')
  if (symIdx < 0 || reportIdx < 0) return 0

  // Limit to watchlist symbols to avoid bloating the table.
  const db = getDb()
  const watchSyms = new Set(
    (db.prepare('SELECT symbol FROM watchlist').all() as Array<{ symbol: string }>).map(
      (r) => r.symbol,
    ),
  )

  const insert = db.prepare(`
    INSERT INTO earnings_calendar (symbol, report_date, fiscal_period, eps_estimate, fetched_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(symbol, report_date) DO UPDATE SET
      fiscal_period = excluded.fiscal_period,
      eps_estimate = excluded.eps_estimate,
      fetched_at = excluded.fetched_at
  `)

  let inserted = 0
  const tx = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',')
      const sym = cols[symIdx]?.trim()
      if (!sym || !watchSyms.has(sym)) continue
      const reportDate = cols[reportIdx]?.trim()
      if (!reportDate) continue
      const fiscal = fiscalIdx >= 0 ? cols[fiscalIdx]?.trim() || null : null
      const est = estIdx >= 0 ? num(cols[estIdx]) : null
      insert.run(sym, reportDate, fiscal, est)
      inserted++
    }
  })
  tx()
  return inserted
}

/**
 * Refresh fundamentals for all watchlist symbols. Respects 24h cache so a
 * second call same day is a no-op. Returns count of symbols actually refreshed
 * from the network.
 */
export async function refreshAllFundamentals(): Promise<number> {
  const db = getDb()
  const symbols = (
    db.prepare('SELECT symbol, type FROM watchlist').all() as Array<{
      symbol: string
      type: string
    }>
  )
    .filter((r) => r.type === 'stock' || r.type === 'etf')
    .map((r) => r.symbol)
  let refreshed = 0
  for (const sym of symbols) {
    const row = await fetchFundamentals(sym)
    if (row) refreshed++
    // Small delay to be polite to the free tier (12s recommended between calls)
    await new Promise((r) => setTimeout(r, 500))
  }
  return refreshed
}

export function getFundamentals(symbol: string): FundamentalsRow | null {
  const db = getDb()
  return (
    (db
      .prepare(`SELECT ${FUNDAMENTALS_COLUMNS} FROM fundamentals WHERE symbol = ?`)
      .get(symbol.toUpperCase()) as FundamentalsRow | undefined) || null
  )
}

export function getAllFundamentals(): FundamentalsRow[] {
  return getDb()
    .prepare(`SELECT ${FUNDAMENTALS_COLUMNS} FROM fundamentals`)
    .all() as FundamentalsRow[]
}

export function getUpcomingEarnings(days: number = 7): EarningsCalendarRow[] {
  const db = getDb()
  return db
    .prepare(
      `
    SELECT symbol, report_date, fiscal_period, eps_estimate, eps_actual, surprise_pct
    FROM earnings_calendar
    WHERE report_date BETWEEN date('now') AND date('now', '+' || ? || ' days')
    ORDER BY report_date ASC
  `,
    )
    .all(days) as EarningsCalendarRow[]
}
