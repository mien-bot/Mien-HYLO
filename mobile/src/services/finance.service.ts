import { getDb } from '../lib/database'
import { getSettings } from '../lib/storage'

export interface LatestPrice {
  symbol: string
  type: string
  name: string | null
  price: number
  change: number
  changePercent: number
}

const SYMBOL_ALIASES: Record<string, string> = {
  'BERKSHIRE': 'BRK-B',
  'BERKSHIRE HATHAWAY': 'BRK-B',
  'BRK.A': 'BRK-B',
  'BRK/A': 'BRK-B',
  'BRK B': 'BRK-B',
  'BRK.B': 'BRK-B',
  'GOOGLE': 'GOOGL',
  'ALPHABET': 'GOOGL',
  'NVIDIA': 'NVDA',
}

export function normalizeMarketSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase()
  return SYMBOL_ALIASES[normalized] || normalized.replace('.', '-')
}

/**
 * Fetch stock/ETF quote from Yahoo Finance v8
 */
export async function fetchYahooQuote(symbol: string): Promise<LatestPrice | null> {
  const querySymbol = normalizeMarketSymbol(symbol)
  // Try query2 first (more reliable for mobile), then query1
  const endpoints = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(querySymbol)}?interval=1d&range=1d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(querySymbol)}?interval=1d&range=1d`,
  ]

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept': 'application/json',
        }
      })
      if (!res.ok) {
        console.log(`[Finance] Yahoo returned ${res.status} for ${querySymbol} from ${url}`)
        continue
      }
      const data = await res.json()
      const meta = data?.chart?.result?.[0]?.meta
      if (!meta || meta.regularMarketPrice == null) continue

      const price = meta.regularMarketPrice
      const prevClose = meta.chartPreviousClose || meta.previousClose || price
      return {
        symbol: meta.symbol || querySymbol,
        type: 'stock',
        name: null,
        price,
        change: price - prevClose,
        changePercent: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      }
    } catch (err) {
      console.log(`[Finance] Yahoo fetch failed for ${querySymbol}:`, err)
    }
  }
  return null
}

/**
 * Fetch crypto price from CoinGecko
 */
export async function fetchCryptoPrice(coinId: string, symbol: string): Promise<LatestPrice | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`
    const res = await fetch(url)
    const data = await res.json()
    const coin = data[coinId]
    if (!coin) return null

    return {
      symbol,
      type: 'crypto',
      name: coinId,
      price: coin.usd,
      change: 0,
      changePercent: coin.usd_24h_change || 0,
    }
  } catch {
    return null
  }
}

export async function getWatchlist() {
  const db = await getDb()
  return db.getAllAsync('SELECT * FROM watchlist ORDER BY added_at DESC')
}

export async function addToWatchlist(symbol: string, type: string, name?: string) {
  const db = await getDb()
  const storedSymbol = type === 'crypto' ? symbol.trim().toUpperCase() : normalizeMarketSymbol(symbol)
  await db.runAsync(
    'INSERT OR IGNORE INTO watchlist (symbol, type, name) VALUES (?, ?, ?)',
    storedSymbol, type, name || null
  )
}

export async function removeFromWatchlist(symbol: string) {
  const db = await getDb()
  await db.runAsync('DELETE FROM watchlist WHERE symbol = ?', normalizeMarketSymbol(symbol))
}

/**
 * Fetch detailed stock data from Alpha Vantage (requires API key)
 */
export async function fetchAlphaVantageQuote(symbol: string): Promise<LatestPrice | null> {
  try {
    const querySymbol = normalizeMarketSymbol(symbol).replace('-', '.')
    const settings = await getSettings()
    const apiKey = settings.alphaVantageKey
    if (!apiKey) return null

    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(querySymbol)}&apikey=${apiKey}`
    const res = await fetch(url)
    const data = await res.json()
    const quote = data['Global Quote']
    if (!quote || !quote['05. price']) return null

    const price = parseFloat(quote['05. price'])
    const change = parseFloat(quote['09. change'])
    const changePercent = parseFloat(quote['10. change percent']?.replace('%', '') || '0')

    return {
      symbol: quote['01. symbol'],
      type: 'stock',
      name: null,
      price,
      change,
      changePercent,
    }
  } catch {
    return null
  }
}

/**
 * Fetch stock quote — tries Yahoo first (no key), falls back to Alpha Vantage
 */
export async function fetchQuote(symbol: string): Promise<LatestPrice | null> {
  const yahoo = await fetchYahooQuote(symbol)
  if (yahoo) return yahoo
  return fetchAlphaVantageQuote(symbol)
}

// === MARKET PULSE: Sector Performance ===

export interface SectorPerformance {
  name: string
  symbol: string
  price: number
  changePercent: number
}

const SECTOR_ETFS: Array<{ name: string; symbol: string }> = [
  { name: 'Technology', symbol: 'XLK' },
  { name: 'Energy', symbol: 'XLE' },
  { name: 'Healthcare', symbol: 'XLV' },
  { name: 'Financials', symbol: 'XLF' },
  { name: 'Consumer Disc.', symbol: 'XLY' },
  { name: 'Industrials', symbol: 'XLI' },
  { name: 'Materials', symbol: 'XLB' },
  { name: 'Utilities', symbol: 'XLU' },
  { name: 'Real Estate', symbol: 'XLRE' },
  { name: 'Comm. Services', symbol: 'XLC' },
  { name: 'Cons. Staples', symbol: 'XLP' },
]

export async function fetchSectorPerformance(): Promise<SectorPerformance[]> {
  const symbols = SECTOR_ETFS.map(s => s.symbol).join(',')
  const url = `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${symbols}&range=1d&interval=1d`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      },
    })
    if (res.ok) {
      const data = await res.json()
      const results: SectorPerformance[] = []
      for (const sector of SECTOR_ETFS) {
        const spark = data?.spark?.result?.find((r: any) => r.symbol === sector.symbol)
        if (spark?.response?.[0]?.meta) {
          const meta = spark.response[0].meta
          const price = meta.regularMarketPrice
          const prev = meta.chartPreviousClose || meta.previousClose || price
          results.push({
            name: sector.name,
            symbol: sector.symbol,
            price,
            changePercent: prev > 0 ? ((price - prev) / prev) * 100 : 0,
          })
        }
      }
      if (results.length > 0) return results
    }
  } catch (err) {
    console.log('[Finance] Spark API failed, falling back to individual fetches:', err)
  }

  // Fallback: fetch each sector ETF individually
  const results: SectorPerformance[] = []
  const promises = SECTOR_ETFS.map(async (sector) => {
    const quote = await fetchYahooQuote(sector.symbol)
    if (quote) {
      return {
        name: sector.name,
        symbol: sector.symbol,
        price: quote.price,
        changePercent: quote.changePercent,
      }
    }
    return null
  })

  const settled = await Promise.allSettled(promises)
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) results.push(r.value)
  }
  return results
}

// === MARKET PULSE: Momentum Detection ===

export type MomentumTimeframe = '1D' | '1M' | '3M' | '1Y' | '3Y' | '5Y'

export const MOMENTUM_TIMEFRAMES: MomentumTimeframe[] = ['1D', '1M', '3M', '1Y', '3Y', '5Y']

// Calendar-day lookback per timeframe. We pick the most recent bar at or before
// (latestBarTimestamp − N days), so holidays and weekends don't skew the result.
const TIMEFRAME_SECONDS: Record<MomentumTimeframe, number> = {
  '1D': 86400,
  '1M': 30 * 86400,
  '3M': 91 * 86400,
  '1Y': 365 * 86400,
  '3Y': 3 * 365 * 86400,
  '5Y': 5 * 365 * 86400,
}

export interface MomentumStock {
  symbol: string
  name: string | null
  price: number
  changePercent: number
  changePercents: Record<MomentumTimeframe, number | null>
  avgVolume: number
  currentVolume: number
  volumeRatio: number
  momentumScore: number
}

export async function fetchMomentumPlays(): Promise<MomentumStock[]> {
  const db = await getDb()

  // Get user's watchlist symbols plus popular momentum candidates
  const wl = await db.getAllAsync('SELECT symbol, type, name FROM watchlist') as Array<{ symbol: string; type: string; name: string | null }>
  const watchlistSymbols = wl.filter(w => w.type !== 'crypto').map(w => normalizeMarketSymbol(w.symbol))

  // Add some high-volume momentum candidates
  const scanSymbols = [
    ...watchlistSymbols,
    'NVDA', 'AMD', 'SMCI', 'MU', 'WDC', 'MRVL', 'ARM',
    'MSFT', 'GOOGL', 'META', 'AMZN', 'TSLA',
    'AVGO', 'QCOM', 'ANET', 'PLTR', 'SNOW',
  ]
  // Deduplicate
  const uniqueSymbols = [...new Set(scanSymbols)].slice(0, 20)

  const results: MomentumStock[] = []

  const promises = uniqueSymbols.map(async (symbol) => {
    try {
      // range=10y gives a comfortable buffer for the 5Y window (yahoo's range=5y returns ~1257 bars,
      // which leaves zero margin for a 5-year lookback).
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=10y`
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        },
      })
      if (!res.ok) return null
      const data = await res.json()
      const result = data?.chart?.result?.[0]
      if (!result) return null

      const meta = result.meta
      const volumes = result.indicators?.quote?.[0]?.volume || []
      const closes = result.indicators?.quote?.[0]?.close || []
      const timestamps = (result.timestamp as number[] | undefined) || []

      if (closes.length < 5 || volumes.length < 5) return null

      const currentPrice = meta.regularMarketPrice
      const prevClose = meta.chartPreviousClose || closes[closes.length - 2] || currentPrice
      const changePercent = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0

      // Multi-timeframe percentages: for each window, find the latest bar at or before
      // (lastBarTimestamp − N days) via binary search, then % change vs currentPrice.
      // Returns null when history is shorter than the window (e.g. recent IPOs).
      const lastTs = timestamps[timestamps.length - 1] ?? Math.floor(Date.now() / 1000)
      const changePercents = {} as Record<MomentumTimeframe, number | null>
      for (const tf of MOMENTUM_TIMEFRAMES) {
        if (timestamps.length === 0) { changePercents[tf] = null; continue }
        const target = lastTs - TIMEFRAME_SECONDS[tf]
        if (timestamps[0] > target) { changePercents[tf] = null; continue }
        // Largest index with timestamps[idx] <= target
        let lo = 0, hi = timestamps.length - 1, refIdx = -1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (timestamps[mid] <= target) { refIdx = mid; lo = mid + 1 }
          else { hi = mid - 1 }
        }
        if (refIdx < 0) { changePercents[tf] = null; continue }
        const refClose = closes[refIdx]
        if (refClose == null || refClose <= 0) { changePercents[tf] = null; continue }
        changePercents[tf] = ((currentPrice - refClose) / refClose) * 100
      }
      // 1D special-case: keep parity with the prior implementation (regularMarketPrice vs chartPreviousClose)
      changePercents['1D'] = changePercent

      // Calculate average volume over recent 30 trading days (excluding latest day)
      const recentVolumes = volumes.slice(Math.max(0, volumes.length - 31), volumes.length - 1)
      const validVolumes = recentVolumes.filter((v: number | null) => v != null && v > 0) as number[]
      const avgVolume = validVolumes.length > 0 ? validVolumes.reduce((a: number, b: number) => a + b, 0) / validVolumes.length : 0
      const currentVolume = volumes[volumes.length - 1] || 0
      const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0

      // Calculate momentum score: weighted combination of price change and volume
      const absChange = Math.abs(changePercent)
      const volScore = Math.min(volumeRatio, 5) / 5 // normalize to 0-1, cap at 5x
      const priceScore = Math.min(absChange, 10) / 10 // normalize to 0-1, cap at 10%

      // 5-day trend strength
      const recent5 = closes.slice(-5).filter((c: number | null) => c != null) as number[]
      let trendScore = 0
      if (recent5.length >= 2) {
        const fiveDayChange = (recent5[recent5.length - 1] - recent5[0]) / recent5[0]
        trendScore = Math.min(Math.abs(fiveDayChange), 0.15) / 0.15
      }

      const momentumScore = Math.round((priceScore * 35 + volScore * 35 + trendScore * 30))

      const wlMatch = wl.find(w => w.symbol === symbol)
      return {
        symbol,
        name: wlMatch?.name || null,
        price: currentPrice,
        changePercent,
        changePercents,
        avgVolume,
        currentVolume,
        volumeRatio,
        momentumScore,
      }
    } catch {
      return null
    }
  })

  const settled = await Promise.allSettled(promises)
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value && r.value.momentumScore >= 15) {
      results.push(r.value)
    }
  }

  return results.sort((a, b) => b.momentumScore - a.momentumScore)
}
