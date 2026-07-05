/**
 * Composite per-symbol "health score" (0-100) blending:
 *   - Valuation: P/E vs sector median (lower = better, asymmetric cap)
 *   - Momentum: 20-day return + RSI normalization
 *   - Risk: inverse of annualized volatility and 30-day drawdown
 *   - Sentiment: AI/heuristic 7-day news score
 *
 * Each subscore is 0-100. The composite is a weighted average. Missing inputs
 * for a subscore drop it to neutral (50) rather than dragging the score down
 * — the goal is signal, not punishment for low coverage.
 */

import { getDb } from '../../db/database'
import { getAllFundamentals } from './alphavantage.fetcher'
import { computeIndicators, computePortfolioRisk } from './technical-indicators'
import { getSymbolSentimentSummary } from './news-sentiment.service'

export interface HealthScore {
  symbol: string
  score: number
  breakdown: {
    valuation: number | null
    momentum: number | null
    risk: number | null
    sentiment: number | null
  }
  weights: { valuation: number; momentum: number; risk: number; sentiment: number }
}

const WEIGHTS = { valuation: 0.25, momentum: 0.3, risk: 0.25, sentiment: 0.2 }

function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x))
}

/**
 * Valuation: lower P/E relative to sector median = higher score.
 * P/E < 0 (loss-making) → 30 (cautious), no P/E data → null (neutral).
 */
function scoreValuation(symbolPe: number | null, sectorMedianPe: number | null): number | null {
  if (symbolPe == null) return null
  if (symbolPe < 0) return 30
  if (sectorMedianPe == null || sectorMedianPe <= 0) {
    // Absolute fallback: P/E 15 = 100, 30 = 50, 60 = 0 (linear)
    return clamp(100 - (symbolPe - 15) * (100 / 45))
  }
  const ratio = symbolPe / sectorMedianPe
  // 0.6× sector = 100, 1.0× = 60, 1.5× = 30, 2.0× = 10
  if (ratio <= 0.6) return 100
  if (ratio <= 1.0) return 100 - (ratio - 0.6) * 100 // 100 → 60
  if (ratio <= 1.5) return 60 - (ratio - 1.0) * 60 // 60 → 30
  if (ratio <= 2.0) return 30 - (ratio - 1.5) * 40 // 30 → 10
  return clamp(10 - (ratio - 2.0) * 10, 0)
}

/**
 * Momentum: blend of 20-day return and RSI.
 */
function scoreMomentum(priceChange20d: number | null, rsi14: number | null): number | null {
  let returnScore: number | null = null
  if (priceChange20d != null) {
    // -10% return = 20, 0% = 50, +10% = 80, +20% = 100, -20% = 0
    returnScore = clamp(50 + priceChange20d * 2.5)
  }
  let rsiScore: number | null = null
  if (rsi14 != null) {
    // Bell-shaped: 50 RSI = 100, <30 oversold = 60 (recovery upside), >70 overbought = 40
    if (rsi14 < 30) rsiScore = 60
    else if (rsi14 > 70) rsiScore = 40
    else rsiScore = 100 - Math.abs(rsi14 - 50) * 2
  }
  if (returnScore == null && rsiScore == null) return null
  if (returnScore == null) return rsiScore
  if (rsiScore == null) return returnScore
  return returnScore * 0.6 + rsiScore * 0.4
}

/**
 * Risk: inverse of volatility and drawdown. Lower vol + smaller drawdown = higher.
 */
function scoreRisk(volatility: number, maxDrawdown: number): number {
  // Volatility: 15% = 100, 30% = 60, 60% = 20, 100%+ = 0
  let volScore: number
  if (volatility <= 15) volScore = 100
  else if (volatility <= 30) volScore = 100 - (volatility - 15) * (40 / 15)
  else if (volatility <= 60) volScore = 60 - (volatility - 30) * (40 / 30)
  else volScore = Math.max(0, 20 - (volatility - 60) * (20 / 40))

  // Drawdown: 0% = 100, 10% = 70, 25% = 30, 50%+ = 0
  let ddScore: number
  if (maxDrawdown <= 0) ddScore = 100
  else if (maxDrawdown <= 10) ddScore = 100 - maxDrawdown * 3
  else if (maxDrawdown <= 25) ddScore = 70 - (maxDrawdown - 10) * (40 / 15)
  else if (maxDrawdown <= 50) ddScore = 30 - (maxDrawdown - 25) * (30 / 25)
  else ddScore = 0

  return clamp(volScore * 0.6 + ddScore * 0.4)
}

/**
 * Sentiment: -1..+1 score → 0..100.
 */
function scoreSentiment(score: number): number {
  return clamp(50 + score * 50)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function computeHealthScores(): HealthScore[] {
  const db = getDb()
  const symbols = (
    db.prepare('SELECT symbol FROM watchlist').all() as Array<{ symbol: string }>
  ).map((r) => r.symbol)
  if (symbols.length === 0) return []

  const allFundamentals = getAllFundamentals()
  const fundMap = new Map(allFundamentals.map((f) => [f.symbol, f]))

  // Sector medians for P/E
  const sectorPes = new Map<string, number[]>()
  for (const f of allFundamentals) {
    if (!f.sector || f.pe == null || f.pe <= 0) continue
    if (!sectorPes.has(f.sector)) sectorPes.set(f.sector, [])
    sectorPes.get(f.sector)!.push(f.pe)
  }
  const sectorMedian = new Map<string, number>()
  for (const [sec, pes] of sectorPes) {
    const m = median(pes)
    if (m != null) sectorMedian.set(sec, m)
  }

  // Risk metrics in one batch
  const risk = computePortfolioRisk([...symbols, 'SPY'])

  return symbols.map((sym): HealthScore => {
    const f = fundMap.get(sym)
    const sectorPe = f?.sector ? (sectorMedian.get(f.sector) ?? null) : null
    const valuation = scoreValuation(f?.pe ?? null, sectorPe)

    let momentum: number | null = null
    try {
      const { indicators } = computeIndicators(sym)
      momentum = scoreMomentum(indicators.priceChange20d, indicators.rsi14)
    } catch {
      /* no price history */
    }

    const vol = risk.volatilities.get(sym) ?? null
    const dd = risk.maxDrawdowns.get(sym) ?? null
    const riskScore = vol != null && dd != null ? scoreRisk(vol, dd) : null

    const sentSummary = getSymbolSentimentSummary(sym, 7)
    const sentimentScore =
      sentSummary.positive + sentSummary.negative + sentSummary.neutral > 0
        ? scoreSentiment(sentSummary.score)
        : null

    // Compose. Missing subscores fall back to 50 (neutral).
    const valE = valuation ?? 50
    const momE = momentum ?? 50
    const riskE = riskScore ?? 50
    const sentE = sentimentScore ?? 50
    const composite =
      valE * WEIGHTS.valuation +
      momE * WEIGHTS.momentum +
      riskE * WEIGHTS.risk +
      sentE * WEIGHTS.sentiment

    return {
      symbol: sym,
      score: Math.round(composite),
      breakdown: { valuation, momentum, risk: riskScore, sentiment: sentimentScore },
      weights: WEIGHTS,
    }
  })
}

// Cached version (5min TTL) — health scores are expensive to recompute on every render.
let cache: { ts: number; data: HealthScore[] } | null = null
export function getHealthScoresCached(): HealthScore[] {
  const now = Date.now()
  if (cache && now - cache.ts < 5 * 60 * 1000) return cache.data
  cache = { ts: now, data: computeHealthScores() }
  return cache.data
}

export function invalidateHealthScoreCache(): void {
  cache = null
}
