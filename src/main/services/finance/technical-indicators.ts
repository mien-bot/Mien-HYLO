/**
 * Technical Indicators Engine
 *
 * Computes RSI, SMA, EMA, MACD, Bollinger Bands, ATR, support/resistance
 * from stored OHLCV price_history data. All calculations run locally.
 */

import { getDb } from '../../db/database'

interface OHLCV {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TechnicalIndicators {
  rsi14: number | null
  sma20: number | null
  sma50: number | null
  ema12: number | null
  ema26: number | null
  macdLine: number | null
  macdSignal: number | null
  macdHistogram: number | null
  bollingerUpper: number | null
  bollingerMiddle: number | null
  bollingerLower: number | null
  atr14: number | null
  avgVolume20: number | null
  latestVolume: number | null
  volumeRatio: number | null
  priceChange5d: number | null
  priceChange20d: number | null
  high52w: number | null
  low52w: number | null
}

export interface SupportResistance {
  supports: number[]
  resistances: number[]
}

/**
 * Load OHLCV data for a symbol from the database
 */
function loadPriceData(symbol: string, days: number = 90): OHLCV[] {
  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT date, open, high, low, close, volume FROM price_history
    WHERE symbol = ? AND close IS NOT NULL AND open IS NOT NULL
    ORDER BY date ASC
    LIMIT ?
  `,
    )
    .all(symbol, days) as Array<{
    date: string
    open: number | null
    high: number | null
    low: number | null
    close: number | null
    volume: number | null
  }>

  return rows
    .filter((r) => r.close != null && r.open != null)
    .map((r) => ({
      date: r.date,
      open: r.open!,
      high: r.high || r.close!,
      low: r.low || r.close!,
      close: r.close!,
      volume: r.volume || 0,
    }))
}

/**
 * Compute all technical indicators for a symbol
 */
export function computeIndicators(symbol: string): {
  indicators: TechnicalIndicators
  supportResistance: SupportResistance
  priceHistory: OHLCV[]
} {
  const longData = loadPriceData(symbol, 260) // single fetch for all indicators + 52-week
  const data = longData.length > 120 ? longData.slice(-120) : longData
  const closes = data.map((d) => d.close)

  const indicators: TechnicalIndicators = {
    rsi14: closes.length >= 15 ? computeRSI(closes, 14) : null,
    sma20: closes.length >= 20 ? sma(closes, 20) : null,
    sma50: closes.length >= 50 ? sma(closes, 50) : null,
    ema12: closes.length >= 12 ? ema(closes, 12) : null,
    ema26: closes.length >= 26 ? ema(closes, 26) : null,
    macdLine: null,
    macdSignal: null,
    macdHistogram: null,
    bollingerUpper: null,
    bollingerMiddle: null,
    bollingerLower: null,
    atr14: data.length >= 15 ? computeATR(data, 14) : null,
    avgVolume20: null,
    latestVolume: null,
    volumeRatio: null,
    priceChange5d: null,
    priceChange20d: null,
    high52w: null,
    low52w: null,
  }

  // MACD (12, 26, 9)
  if (closes.length >= 35) {
    const macd = computeMACD(closes)
    indicators.macdLine = macd.line
    indicators.macdSignal = macd.signal
    indicators.macdHistogram = macd.histogram
  }

  // Bollinger Bands (20, 2)
  if (closes.length >= 20) {
    const bb = computeBollingerBands(closes, 20, 2)
    indicators.bollingerUpper = bb.upper
    indicators.bollingerMiddle = bb.middle
    indicators.bollingerLower = bb.lower
  }

  // Volume analysis
  if (data.length >= 20) {
    const volumes = data.map((d) => d.volume)
    indicators.avgVolume20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
    indicators.latestVolume = volumes[volumes.length - 1]
    indicators.volumeRatio =
      indicators.avgVolume20 > 0 ? indicators.latestVolume / indicators.avgVolume20 : null
  }

  // Price changes
  if (closes.length >= 6) {
    indicators.priceChange5d =
      ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
  }
  if (closes.length >= 21) {
    indicators.priceChange20d =
      ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
  }

  // 52-week high/low (use all available data, up to 252 trading days)
  if (longData.length > 0) {
    indicators.high52w = Math.max(...longData.map((d) => d.high))
    indicators.low52w = Math.min(...longData.map((d) => d.low))
  }

  // Support and resistance from pivot points
  const sr = computeSupportResistance(data, closes[closes.length - 1])

  return { indicators, supportResistance: sr, priceHistory: data }
}

/**
 * Compute portfolio-level risk metrics
 */
export function computePortfolioRisk(symbols: string[]): {
  volatilities: Map<string, number>
  correlations: Array<{ symbolA: string; symbolB: string; correlation: number }>
  maxDrawdowns: Map<string, number>
  betas: Map<string, number | null>
} {
  const returns = new Map<string, number[]>()

  // Compute daily returns for each symbol
  for (const symbol of symbols) {
    const data = loadPriceData(symbol, 60)
    if (data.length < 10) continue
    const closes = data.map((d) => d.close)
    const dailyReturns: number[] = []
    for (let i = 1; i < closes.length; i++) {
      dailyReturns.push((closes[i] - closes[i - 1]) / closes[i - 1])
    }
    returns.set(symbol, dailyReturns)
  }

  // Volatilities (annualized)
  const volatilities = new Map<string, number>()
  for (const [symbol, rets] of returns) {
    const std = stdDev(rets)
    volatilities.set(symbol, std * Math.sqrt(252) * 100) // annualized %
  }

  // Correlations between all pairs
  const correlations: Array<{ symbolA: string; symbolB: string; correlation: number }> = []
  const syms = [...returns.keys()]
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const a = returns.get(syms[i])!
      const b = returns.get(syms[j])!
      const minLen = Math.min(a.length, b.length)
      if (minLen < 10) continue
      const corr = pearsonCorrelation(a.slice(-minLen), b.slice(-minLen))
      correlations.push({ symbolA: syms[i], symbolB: syms[j], correlation: corr })
    }
  }

  // Max drawdown (30-day)
  const maxDrawdowns = new Map<string, number>()
  for (const symbol of symbols) {
    const data = loadPriceData(symbol, 30)
    if (data.length < 2) {
      maxDrawdowns.set(symbol, 0)
      continue
    }
    const closes = data.map((d) => d.close)
    let maxDD = 0
    let peak = closes[0]
    for (const c of closes) {
      if (c > peak) peak = c
      const dd = ((peak - c) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
    maxDrawdowns.set(symbol, maxDD)
  }

  // Beta vs SPY (if we have SPY data)
  const betas = new Map<string, number | null>()
  const spyReturns = returns.get('SPY') || returns.get('^GSPC')
  for (const symbol of symbols) {
    if (symbol === 'SPY' || symbol === '^GSPC') {
      betas.set(symbol, 1.0)
      continue
    }
    const rets = returns.get(symbol)
    if (!rets || !spyReturns) {
      betas.set(symbol, null)
      continue
    }
    const minLen = Math.min(rets.length, spyReturns.length)
    if (minLen < 10) {
      betas.set(symbol, null)
      continue
    }
    const covar = covariance(rets.slice(-minLen), spyReturns.slice(-minLen))
    const spyVar = variance(spyReturns.slice(-minLen))
    betas.set(symbol, spyVar > 0 ? covar / spyVar : null)
  }

  return { volatilities, correlations, maxDrawdowns, betas }
}

// --- Core indicator calculations ---

export function sma(data: number[], period: number): number {
  const slice = data.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

function ema(data: number[], period: number): number {
  const k = 2 / (period + 1)
  let result = data[0]
  for (let i = 1; i < data.length; i++) {
    result = data[i] * k + result * (1 - k)
  }
  return result
}

export function computeRSI(closes: number[], period: number = 14): number {
  let gains = 0
  let losses = 0

  // Initial average
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) gains += change
    else losses += Math.abs(change)
  }

  let avgGain = gains / period
  let avgLoss = losses / period

  // Smooth with Wilder's method
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function computeMACD(closes: number[]): { line: number; signal: number; histogram: number } {
  // Iterative EMA computation to avoid O(n²)
  const k12 = 2 / (12 + 1)
  const k26 = 2 / (26 + 1)

  // Seed EMA12 with SMA of first 12 values
  let ema12val = 0
  for (let i = 0; i < 12; i++) ema12val += closes[i]
  ema12val /= 12

  // Seed EMA26 with SMA of first 26 values
  let ema26val = 0
  for (let i = 0; i < 26; i++) ema26val += closes[i]
  ema26val /= 26

  // Build EMA12 iteratively from index 12 onward
  for (let i = 12; i < 26; i++) {
    ema12val = closes[i] * k12 + ema12val * (1 - k12)
  }

  // Build MACD series from index 26 onward (both EMAs now active)
  const macdSeries: number[] = []
  for (let i = 26; i < closes.length; i++) {
    ema12val = closes[i] * k12 + ema12val * (1 - k12)
    ema26val = closes[i] * k26 + ema26val * (1 - k26)
    macdSeries.push(ema12val - ema26val)
  }

  const macdLine = macdSeries[macdSeries.length - 1] ?? 0

  // Signal line = EMA(9) of MACD series, computed iteratively
  let signal = macdLine
  if (macdSeries.length >= 9) {
    const k9 = 2 / (9 + 1)
    // Seed with SMA of first 9 MACD values
    let signalVal = 0
    for (let i = 0; i < 9; i++) signalVal += macdSeries[i]
    signalVal /= 9
    // Continue iteratively
    for (let i = 9; i < macdSeries.length; i++) {
      signalVal = macdSeries[i] * k9 + signalVal * (1 - k9)
    }
    signal = signalVal
  }

  return {
    line: macdLine,
    signal,
    histogram: macdLine - signal,
  }
}

function computeBollingerBands(
  closes: number[],
  period: number = 20,
  multiplier: number = 2,
): { upper: number; middle: number; lower: number } {
  const slice = closes.slice(-period)
  const middle = slice.reduce((a, b) => a + b, 0) / slice.length
  const std = stdDev(slice)
  return {
    upper: middle + multiplier * std,
    middle,
    lower: middle - multiplier * std,
  }
}

function computeATR(data: OHLCV[], period: number = 14): number {
  const trueRanges: number[] = []
  for (let i = 1; i < data.length; i++) {
    const tr = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low - data[i - 1].close),
    )
    trueRanges.push(tr)
  }
  if (trueRanges.length < period) return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length

  // Wilder's smoothing
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period
  }
  return atr
}

function computeSupportResistance(data: OHLCV[], currentPrice: number): SupportResistance {
  if (data.length < 5) return { supports: [], resistances: [] }

  // Find local highs and lows using 5-day window
  const pivotHighs: number[] = []
  const pivotLows: number[] = []

  for (let i = 2; i < data.length - 2; i++) {
    const h = data[i].high
    const l = data[i].low
    if (
      h > data[i - 1].high &&
      h > data[i - 2].high &&
      h > data[i + 1].high &&
      h > data[i + 2].high
    ) {
      pivotHighs.push(h)
    }
    if (l < data[i - 1].low && l < data[i - 2].low && l < data[i + 1].low && l < data[i + 2].low) {
      pivotLows.push(l)
    }
  }

  // Cluster nearby levels (within 1.5% of each other)
  const clusterLevels = (levels: number[]): number[] => {
    if (levels.length === 0) return []
    const sorted = [...levels].sort((a, b) => a - b)
    const clusters: number[][] = [[sorted[0]]]
    for (let i = 1; i < sorted.length; i++) {
      const lastCluster = clusters[clusters.length - 1]
      const lastAvg = lastCluster.reduce((a, b) => a + b, 0) / lastCluster.length
      if (Math.abs(sorted[i] - lastAvg) / lastAvg < 0.015) {
        lastCluster.push(sorted[i])
      } else {
        clusters.push([sorted[i]])
      }
    }
    return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length)
  }

  const allLevels = clusterLevels([...pivotHighs, ...pivotLows])
  const supports = allLevels
    .filter((l) => l < currentPrice)
    .slice(-3)
    .reverse()
  const resistances = allLevels.filter((l) => l > currentPrice).slice(0, 3)

  return { supports, resistances }
}

// --- Math utilities ---

function stdDev(arr: number[]): number {
  const n = arr.length
  if (n < 2) return 0
  const mean = arr.reduce((a, b) => a + b, 0) / n
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1))
}

function variance(arr: number[]): number {
  const n = arr.length
  if (n < 2) return 0
  const mean = arr.reduce((a, b) => a + b, 0) / n
  return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)
}

function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return 0
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n
  let cov = 0
  for (let i = 0; i < n; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB)
  }
  return cov / (n - 1)
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const cov = covariance(a, b)
  const stdA = stdDev(a)
  const stdB = stdDev(b)
  if (stdA === 0 || stdB === 0) return 0
  return cov / (stdA * stdB)
}
