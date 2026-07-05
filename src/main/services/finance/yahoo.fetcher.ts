import { getDb } from '../../db/database'
import { fetchJson } from '../../lib/fetch-with-retry'

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
}

/** Yahoo uses dashes for share classes (BRK.A → BRK-A, BRK.B → BRK-B) */
function toYahooSymbol(symbol: string): string {
  return symbol.replace(/\.([A-Z])$/, '-$1')
}

interface YahooChartResult {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number
        previousClose: number
        symbol: string
      }
      timestamp: number[]
      indicators: {
        quote: Array<{
          open: number[]
          high: number[]
          low: number[]
          close: number[]
          volume: number[]
        }>
      }
    }>
  }
}

export async function fetchYahooPrices(symbols: string[]): Promise<number> {
  const db = getDb()
  const insert = db.prepare(`
    INSERT OR REPLACE INTO price_history (symbol, date, open, high, low, close, volume, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'yahoo')
  `)

  let fetched = 0

  for (const symbol of symbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahooSymbol(symbol))}?range=3mo&interval=1d`
      const data = await fetchJson<YahooChartResult>(url, {
        headers: YAHOO_HEADERS,
        label: `yahoo ${symbol}`,
      })
      if (!data) continue
      const result = data.chart.result?.[0]
      if (!result || !result.timestamp) continue

      const quotes = result.indicators.quote[0]
      const insertMany = db.transaction(() => {
        for (let i = 0; i < result.timestamp.length; i++) {
          const date = new Date(result.timestamp[i] * 1000).toISOString().split('T')[0]
          insert.run(
            symbol,
            date,
            quotes.open[i] ?? null,
            quotes.high[i] ?? null,
            quotes.low[i] ?? null,
            quotes.close[i] ?? null,
            quotes.volume[i] ?? null,
          )
        }
      })
      insertMany()
      fetched++
      console.log(`Fetched ${result.timestamp.length} days for ${symbol}`)
    } catch (err) {
      console.error(`Failed to fetch ${symbol} from Yahoo:`, err)
    }
  }

  return fetched
}

export async function fetchYahooQuote(symbol: string): Promise<{
  price: number
  change: number
  changePercent: number
  volume: number
} | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahooSymbol(symbol))}?range=2d&interval=1d`
    const data = await fetchJson<YahooChartResult>(url, {
      headers: YAHOO_HEADERS,
      label: `yahoo quote ${symbol}`,
    })
    if (!data) return null
    const meta = data.chart.result?.[0]?.meta
    if (!meta) return null

    const price = meta.regularMarketPrice ?? 0
    const prevClose = meta.previousClose ?? 0
    const change = prevClose > 0 ? price - prevClose : 0
    const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0
    const quotes = data.chart.result[0].indicators.quote[0]
    const volume = quotes.volume?.[quotes.volume.length - 1] ?? 0

    return { price, change, changePercent, volume }
  } catch {
    return null
  }
}
