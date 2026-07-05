import { getDb } from '../../db/database'
import { fetchYahooPrices, fetchYahooQuote } from './yahoo.fetcher'
import { fetchCoinGeckoPrices, fetchCoinGeckoQuote, CRYPTO_ID_MAP } from './coingecko.fetcher'
import { fetchFinanceNews } from './news.fetcher'
import { fetchYouTubeVideos, parseChannelsSetting } from './youtube.fetcher'
import type { WatchlistItem, LatestPrice } from '../../../shared/types/ipc.types'
import { getAppSettings } from '../../lib/settings'

export interface FinanceRefreshResult {
  stocks: number
  crypto: number
  news: number
  youtube: number
  errors: Record<string, string>
}

async function safeRun<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
  errors: Record<string, string>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = (err as Error)?.message || String(err)
    errors[label] = msg
    console.error(`[refresh] ${label} failed:`, msg)
    return fallback
  }
}

export async function refreshAllFinanceData(): Promise<FinanceRefreshResult> {
  const db = getDb()
  const watchlist: WatchlistItem[] = db
    .prepare('SELECT id, symbol, type, name, added_at FROM watchlist')
    .all() as WatchlistItem[]
  const errors: Record<string, string> = {}

  const stocks = watchlist
    .filter((w) => w.type === 'stock' || w.type === 'etf')
    .map((w) => w.symbol)
  const cryptos = watchlist.filter((w) => w.type === 'crypto')

  const stockCount =
    stocks.length > 0 ? await safeRun('yahoo', () => fetchYahooPrices(stocks), 0, errors) : 0

  let cryptoCount = 0
  if (cryptos.length > 0) {
    const coinIds = cryptos
      .map((c) => CRYPTO_ID_MAP[c.symbol] || c.symbol.toLowerCase())
      .filter(Boolean)
    if (coinIds.length > 0) {
      cryptoCount = await safeRun('coingecko', () => fetchCoinGeckoPrices(coinIds), 0, errors)
    }
  }

  const allSymbols = watchlist.map((w) => w.symbol)
  const newsCount = await safeRun('news', () => fetchFinanceNews(allSymbols), 0, errors)

  const settings = getAppSettings()
  const channels = settings?.youtubeChannels
    ? parseChannelsSetting(settings.youtubeChannels)
    : undefined
  const youtubeResult = await safeRun(
    'youtube',
    () => fetchYouTubeVideos(channels),
    { fetched: 0, inserted: 0, failed: 0 },
    errors,
  )
  const youtubeCount = youtubeResult.inserted

  return { stocks: stockCount, crypto: cryptoCount, news: newsCount, youtube: youtubeCount, errors }
}

/** Return cached prices from DB — instant, no network calls. */
export function getCachedPrices(): LatestPrice[] {
  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT pc.symbol, pc.type, pc.name, pc.price, pc.change,
           pc.change_percent AS changePercent, pc.volume, pc.updated_at AS updatedAt
    FROM price_cache pc
    JOIN watchlist w ON w.symbol = pc.symbol
    ORDER BY w.added_at DESC
  `,
    )
    .all() as (LatestPrice & { updatedAt?: string })[]
  return rows
}

/** Save a batch of live prices into the cache table. */
function cachePrices(prices: LatestPrice[]): void {
  const db = getDb()
  const upsert = db.prepare(`
    INSERT INTO price_cache (symbol, type, name, price, change, change_percent, volume, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(symbol) DO UPDATE SET
      type = excluded.type, name = excluded.name,
      price = excluded.price, change = excluded.change,
      change_percent = excluded.change_percent, volume = excluded.volume,
      updated_at = excluded.updated_at
  `)
  const tx = db.transaction(() => {
    for (const p of prices) {
      upsert.run(p.symbol, p.type, p.name, p.price, p.change, p.changePercent, p.volume)
    }
  })
  tx()
}

export async function getLatestPricesLive(): Promise<LatestPrice[]> {
  const db = getDb()
  const watchlist: WatchlistItem[] = db
    .prepare('SELECT id, symbol, type, name, added_at FROM watchlist')
    .all() as WatchlistItem[]

  const stocks = watchlist.filter((w) => w.type !== 'crypto')
  const cryptos = watchlist.filter((w) => w.type === 'crypto')

  // Fetch stocks sequentially to avoid Yahoo rate-limiting
  const prices: LatestPrice[] = []
  for (const item of stocks) {
    try {
      const quote = await fetchYahooQuote(item.symbol)
      if (quote) {
        prices.push({
          symbol: item.symbol,
          type: item.type as 'stock' | 'etf',
          name: item.name,
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
        })
      }
    } catch {
      console.warn(`[prices] failed to fetch quote for ${item.symbol}`)
    }
  }

  // Fetch crypto in parallel (CoinGecko handles batch well)
  const cryptoResults = await Promise.allSettled(
    cryptos.map(async (item) => {
      const coinId = CRYPTO_ID_MAP[item.symbol] || item.symbol.toLowerCase()
      const quote = await fetchCoinGeckoQuote(coinId)
      if (!quote) return null
      return {
        symbol: item.symbol,
        type: 'crypto' as const,
        name: item.name,
        price: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
        volume: quote.volume,
      }
    }),
  )

  for (const r of cryptoResults) {
    if (r.status === 'fulfilled' && r.value) prices.push(r.value)
  }

  // Persist to cache for instant load next time
  if (prices.length > 0) cachePrices(prices)

  return prices
}
