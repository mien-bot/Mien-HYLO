import { getDb } from '../../db/database'
import { fetchJson } from '../../lib/fetch-with-retry'

const CG_HEADERS = { Accept: 'application/json' }

interface CoinGeckoMarket {
  id: string
  symbol: string
  name: string
  current_price: number
  price_change_24h: number
  price_change_percentage_24h: number
  total_volume: number
  high_24h: number
  low_24h: number
}

export async function fetchCoinGeckoPrices(coinIds: string[]): Promise<number> {
  const db = getDb()
  const insert = db.prepare(`
    INSERT OR REPLACE INTO price_history (symbol, date, open, high, low, close, volume, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'coingecko')
  `)

  try {
    const ids = coinIds.join(',')
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false`
    const coins = await fetchJson<CoinGeckoMarket[]>(url, {
      headers: CG_HEADERS,
      label: 'coingecko markets',
    })
    if (!coins) return 0
    const today = new Date().toISOString().split('T')[0]

    const insertMany = db.transaction(() => {
      for (const coin of coins) {
        const symbol = coin.symbol.toUpperCase()
        insert.run(
          symbol,
          today,
          null,
          coin.high_24h,
          coin.low_24h,
          coin.current_price,
          coin.total_volume,
        )
      }
    })
    insertMany()

    console.log(`Fetched ${coins.length} coins from CoinGecko`)
    return coins.length
  } catch (err) {
    console.error('Failed to fetch from CoinGecko:', err)
    return 0
  }
}

export async function fetchCoinGeckoQuote(coinId: string): Promise<{
  price: number
  change: number
  changePercent: number
  volume: number
} | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coinId}&sparkline=false`
    const coins = await fetchJson<CoinGeckoMarket[]>(url, {
      headers: CG_HEADERS,
      label: `coingecko quote ${coinId}`,
    })
    if (!coins || coins.length === 0) return null

    const coin = coins[0]
    return {
      price: coin.current_price,
      change: coin.price_change_24h,
      changePercent: coin.price_change_percentage_24h,
      volume: coin.total_volume,
    }
  } catch {
    return null
  }
}

// Map common crypto symbols to CoinGecko IDs
export const CRYPTO_ID_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  LINK: 'chainlink',
  UNI: 'uniswap',
  ATOM: 'cosmos',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  SHIB: 'shiba-inu',
  LTC: 'litecoin',
  BNB: 'binancecoin',
  PEPE: 'pepe',
}
