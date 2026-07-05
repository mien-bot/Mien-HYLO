/**
 * Aggregation services for the visualization overhaul.
 *
 * Each function returns a shape ready for charting (time-series, matrices,
 * grouped buckets). All computations run on read with a small in-memory
 * cache to keep panels snappy. The underlying math lives in the existing
 * services (technical-indicators, portfolio, news-sentiment) — these
 * helpers only reshape and join.
 */

import { getDb } from '../../db/database'
import { computePortfolioRisk, sma } from './technical-indicators'
import { listHoldings, getPortfolioValueHistory } from './portfolio.service'
import { getAllFundamentals } from './alphavantage.fetcher'

// --- In-memory cache ---

interface CacheEntry<T> {
  expires: number
  value: T
}

const CACHE = new Map<string, CacheEntry<any>>()
const TTL_MS = 60_000

function cached<T>(key: string, compute: () => T): T {
  const now = Date.now()
  const hit = CACHE.get(key)
  if (hit && hit.expires > now) return hit.value as T
  const value = compute()
  CACHE.set(key, { value, expires: now + TTL_MS })
  return value
}

// --- Price time series with indicator overlays ---

export interface PricePoint {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  sma20?: number | null
  sma50?: number | null
  ema12?: number | null
  ema26?: number | null
  rsi14?: number | null
  bbUpper?: number | null
  bbMiddle?: number | null
  bbLower?: number | null
  macdLine?: number | null
  macdSignal?: number | null
  macdHistogram?: number | null
}

function emaSeries(values: number[], period: number): Array<number | null> {
  const k = 2 / (period + 1)
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (values.length === 0) return out
  let prev = values[0]
  out[0] = prev
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = i >= period - 1 ? prev : null
  }
  return out
}

function rsiSeries(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (values.length <= period) return out
  let gainSum = 0
  let lossSum = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gainSum += d
    else lossSum += -d
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    const gain = d > 0 ? d : 0
    const loss = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

function smaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (values.length < period) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  out[period - 1] = sum / period
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period]
    out[i] = sum / period
  }
  return out
}

function bollingerSeries(
  values: number[],
  period = 20,
  mult = 2,
): {
  upper: Array<number | null>
  middle: Array<number | null>
  lower: Array<number | null>
} {
  const upper: Array<number | null> = new Array(values.length).fill(null)
  const middle: Array<number | null> = new Array(values.length).fill(null)
  const lower: Array<number | null> = new Array(values.length).fill(null)
  if (values.length < period) return { upper, middle, lower }
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1)
    const mean = window.reduce((a, b) => a + b, 0) / period
    const variance = window.reduce((s, v) => s + (v - mean) * (v - mean), 0) / period
    const sd = Math.sqrt(variance)
    middle[i] = mean
    upper[i] = mean + mult * sd
    lower[i] = mean - mult * sd
  }
  return { upper, middle, lower }
}

export function getPriceTimeSeries(
  symbol: string,
  days = 90,
  withIndicators = false,
): PricePoint[] {
  const key = `priceTS:${symbol}:${days}:${withIndicators}`
  return cached(key, () => {
    const db = getDb()
    // Pull extra context so the early window has full indicator coverage
    const fetchDays = withIndicators ? days + 60 : days
    const rows = db
      .prepare(
        `
      SELECT date, open, high, low, close, volume FROM price_history
      WHERE symbol = ?
        AND close IS NOT NULL
        AND date >= date('now', '-' || ? || ' days')
      ORDER BY date ASC
    `,
      )
      .all(symbol, fetchDays) as Array<{
      date: string
      open: number | null
      high: number | null
      low: number | null
      close: number | null
      volume: number | null
    }>

    const points: PricePoint[] = rows
      .filter((r) => r.close != null && r.open != null)
      .map((r) => ({
        date: r.date,
        open: r.open!,
        high: r.high ?? r.close!,
        low: r.low ?? r.close!,
        close: r.close!,
        volume: r.volume ?? 0,
      }))

    if (!withIndicators || points.length === 0) {
      return points.slice(-days)
    }

    const closes = points.map((p) => p.close)
    const sma20 = smaSeries(closes, 20)
    const sma50 = smaSeries(closes, 50)
    const ema12 = emaSeries(closes, 12)
    const ema26 = emaSeries(closes, 26)
    const rsi14 = rsiSeries(closes, 14)
    const bb = bollingerSeries(closes, 20, 2)

    const macdLineSeries: Array<number | null> = closes.map((_, i) => {
      if (ema12[i] == null || ema26[i] == null) return null
      return (ema12[i] as number) - (ema26[i] as number)
    })

    // MACD signal = EMA9 of macd line (only computed where line is defined)
    const macdSignal: Array<number | null> = new Array(closes.length).fill(null)
    let signalPrev: number | null = null
    const k = 2 / (9 + 1)
    for (let i = 0; i < macdLineSeries.length; i++) {
      const v = macdLineSeries[i]
      if (v == null) continue
      signalPrev = signalPrev == null ? v : v * k + signalPrev * (1 - k)
      macdSignal[i] = signalPrev
    }

    for (let i = 0; i < points.length; i++) {
      points[i].sma20 = sma20[i]
      points[i].sma50 = sma50[i]
      points[i].ema12 = ema12[i]
      points[i].ema26 = ema26[i]
      points[i].rsi14 = rsi14[i]
      points[i].bbUpper = bb.upper[i]
      points[i].bbMiddle = bb.middle[i]
      points[i].bbLower = bb.lower[i]
      points[i].macdLine = macdLineSeries[i]
      points[i].macdSignal = macdSignal[i]
      const line = macdLineSeries[i]
      const sig = macdSignal[i]
      points[i].macdHistogram = line != null && sig != null ? line - sig : null
    }

    return points.slice(-days)
  })
}

// --- Portfolio vs benchmark series ---

export interface BenchmarkPoint {
  date: string
  portfolio: number
  [benchmark: string]: number | string
}

export function getPortfolioVsBenchmark(
  days = 90,
  benchmarks: string[] = ['SPY'],
): BenchmarkPoint[] {
  const key = `pVsB:${days}:${benchmarks.join(',')}`
  return cached(key, () => {
    const portfolio = getPortfolioValueHistory(days)
    if (portfolio.length === 0) return []

    const dates = portfolio.map((p) => p.date)
    const minDate = dates[0]
    const portfolioBase = portfolio[0].value || 1

    const db = getDb()
    const benchmarkSeries: Record<string, Map<string, number>> = {}
    for (const sym of benchmarks) {
      const rows = db
        .prepare(
          `
        SELECT date, close FROM price_history
        WHERE symbol = ? AND close IS NOT NULL AND date >= ?
        ORDER BY date ASC
      `,
        )
        .all(sym, minDate) as Array<{ date: string; close: number }>
      const m = new Map<string, number>()
      for (const r of rows) m.set(r.date, r.close)
      benchmarkSeries[sym] = m
    }

    const benchmarkBase: Record<string, number | null> = {}
    for (const sym of benchmarks) benchmarkBase[sym] = null

    return portfolio.map((p) => {
      const point: BenchmarkPoint = {
        date: p.date,
        portfolio: ((p.value - portfolioBase) / portfolioBase) * 100,
      }
      for (const sym of benchmarks) {
        const close = benchmarkSeries[sym].get(p.date)
        if (close == null) {
          point[sym] = NaN
          continue
        }
        if (benchmarkBase[sym] == null) benchmarkBase[sym] = close
        const base = benchmarkBase[sym] as number
        point[sym] = base > 0 ? ((close - base) / base) * 100 : 0
      }
      return point
    })
  })
}

// --- Correlation matrix ---

export interface CorrelationMatrix {
  symbols: string[]
  matrix: number[][]
}

export function getCorrelationMatrix(symbols?: string[], _days = 60): CorrelationMatrix {
  const useSyms = symbols && symbols.length > 0 ? symbols : listHoldings().map((h) => h.symbol)
  if (useSyms.length === 0) return { symbols: [], matrix: [] }
  const uniq = Array.from(new Set(useSyms))

  const key = `corr:${uniq.join(',')}`
  return cached(key, () => {
    const { correlations } = computePortfolioRisk(uniq)
    const idx = new Map(uniq.map((s, i) => [s, i]))
    const matrix: number[][] = uniq.map((_, i) => uniq.map((_2, j) => (i === j ? 1 : 0)))
    for (const c of correlations) {
      const i = idx.get(c.symbolA)
      const j = idx.get(c.symbolB)
      if (i == null || j == null) continue
      matrix[i][j] = c.correlation
      matrix[j][i] = c.correlation
    }
    return { symbols: uniq, matrix }
  })
}

// --- Sector exposure ---

export interface SectorBucket {
  sector: string
  value: number
  count: number
  weight: number
}

export async function getSectorExposure(): Promise<SectorBucket[]> {
  const holdings = listHoldings()
  if (holdings.length === 0) return []
  const fundamentals = await getAllFundamentals()
  const sectorMap = new Map<string, { value: number; count: number }>()

  // Use latest stored close for each symbol — keeps this fast and offline-safe.
  const db = getDb()
  let total = 0
  for (const h of holdings) {
    const row = db
      .prepare(
        `
      SELECT close FROM price_history
      WHERE symbol = ? AND close IS NOT NULL
      ORDER BY date DESC LIMIT 1
    `,
      )
      .get(h.symbol) as { close: number } | undefined
    if (!row) continue
    const value = row.close * h.quantity
    total += value
    const f = fundamentals.find((x: any) => x.symbol === h.symbol)
    const sector = f?.sector || 'Other'
    const bucket = sectorMap.get(sector) || { value: 0, count: 0 }
    bucket.value += value
    bucket.count += 1
    sectorMap.set(sector, bucket)
  }

  return Array.from(sectorMap.entries())
    .map(([sector, b]) => ({
      sector,
      value: b.value,
      count: b.count,
      weight: total > 0 ? (b.value / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value)
}

// --- Sentiment time series ---

export interface SentimentPoint {
  date: string
  positive: number
  negative: number
  neutral: number
  score: number
}

export function getSentimentTimeSeries(symbol?: string, days = 30): SentimentPoint[] {
  const key = `sentTS:${symbol || 'all'}:${days}`
  return cached(key, () => {
    const db = getDb()
    const params: any[] = []
    let where = `published_at >= date('now', '-' || ? || ' days')
                 AND sentiment IS NOT NULL`
    params.push(days)
    if (symbol) {
      where += ' AND related_symbols LIKE ?'
      params.push(`%${symbol}%`)
    }
    const rows = db
      .prepare(
        `
      SELECT date(published_at) AS day, sentiment, COUNT(*) AS n
      FROM news_articles
      WHERE ${where}
      GROUP BY day, sentiment
      ORDER BY day ASC
    `,
      )
      .all(...params) as Array<{ day: string; sentiment: string; n: number }>

    const map = new Map<string, SentimentPoint>()
    for (const r of rows) {
      const p = map.get(r.day) || { date: r.day, positive: 0, negative: 0, neutral: 0, score: 0 }
      if (r.sentiment === 'positive') p.positive += r.n
      else if (r.sentiment === 'negative') p.negative += r.n
      else p.neutral += r.n
      map.set(r.day, p)
    }
    const series = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
    for (const p of series) {
      const total = p.positive + p.negative + p.neutral
      p.score = total === 0 ? 0 : (p.positive - p.negative) / total
    }
    return series
  })
}

// --- Helper: re-export sma for callers that want a single-value SMA ---
export { sma }
