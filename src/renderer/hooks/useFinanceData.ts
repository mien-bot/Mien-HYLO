import { useState, useEffect, useCallback } from 'react'
import type {
  LatestPrice,
  NewsArticle,
  WatchlistItem,
  PriceRecord,
  RiskMetric,
} from '../../shared/types/ipc.types'

export function useWatchlist() {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.api.getWatchlist()
      setWatchlist(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load watchlist')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const add = async (symbol: string, type: string, name?: string) => {
    await window.api.addToWatchlist(symbol, type, name)
    await refresh()
  }

  const remove = async (symbol: string) => {
    await window.api.removeFromWatchlist(symbol)
    await refresh()
  }

  return { watchlist, loading, error, refresh, add, remove }
}

export function useLatestPrices() {
  const [prices, setPrices] = useState<LatestPrice[]>([])
  const [loading, setLoading] = useState(false)
  const [hasCached, setHasCached] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load cached prices from DB on mount — instant, no network
  useEffect(() => {
    window.api
      .getCachedPrices()
      .then((cached) => {
        if (cached.length > 0) {
          setPrices(cached)
          setHasCached(true)
        }
      })
      .catch((err) => console.warn('[Finance] Failed to load cached prices:', err))
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.api.getLatestPrices()
      setPrices(data)
      setHasCached(true)
    } catch (err: any) {
      setError(err.message || 'Failed to fetch prices')
    }
    setLoading(false)
  }, [])

  // Only show spinner when there's no cached data to display yet
  return { prices, loading: loading && !hasCached, refreshing: loading, error, refresh }
}

export function usePriceHistory(symbol: string | null, days: number = 30) {
  const [history, setHistory] = useState<PriceRecord[]>([])

  useEffect(() => {
    if (!symbol) return
    window.api.getPrices(symbol, days).then(setHistory)
  }, [symbol, days])

  return history
}

export function useNews() {
  const [news, setNews] = useState<NewsArticle[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const data = await window.api.getNews()
    setNews(data)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { news, loading, refresh }
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

export function useFundamentals() {
  const [byId, setById] = useState<Record<string, FundamentalsRow>>({})
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const rows = (await window.api.getFundamentals()) as FundamentalsRow[]
      const map: Record<string, FundamentalsRow> = {}
      for (const r of rows) map[r.symbol] = r
      setById(map)
    } catch (err) {
      console.error('Failed to fetch fundamentals:', err)
    }
  }, [])

  const refreshNetwork = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.api.refreshFundamentals()
      await window.api.refreshEarningsCalendar()
      await refresh()
    } catch (err) {
      console.error('Fundamentals network refresh failed:', err)
    }
    setRefreshing(false)
  }, [refresh])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { fundamentals: byId, refresh, refreshNetwork, refreshing }
}

export function useUpcomingEarnings(days: number = 7) {
  const [rows, setRows] = useState<EarningsCalendarRow[]>([])

  const refresh = useCallback(async () => {
    try {
      const data = (await window.api.getEarningsCalendar(days)) as EarningsCalendarRow[]
      setRows(data)
    } catch (err) {
      console.error('Failed to fetch earnings calendar:', err)
    }
  }, [days])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { earnings: rows, refresh }
}

export interface HealthScoreRow {
  symbol: string
  score: number
  breakdown: {
    valuation: number | null
    momentum: number | null
    risk: number | null
    sentiment: number | null
  }
}

export function useHealthScores() {
  const [scores, setScores] = useState<Record<string, HealthScoreRow>>({})

  const refresh = useCallback(async () => {
    try {
      const rows = (await window.api.getHealthScores()) as HealthScoreRow[]
      const map: Record<string, HealthScoreRow> = {}
      for (const r of rows) map[r.symbol] = r
      setScores(map)
    } catch (err) {
      console.error('Failed to fetch health scores:', err)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { scores, refresh }
}

export function useRiskMetrics() {
  const [metrics, setMetrics] = useState<Record<string, RiskMetric>>({})

  const refresh = useCallback(async () => {
    try {
      const data = await window.api.getRiskMetrics()
      setMetrics(data)
    } catch (err) {
      console.error('Failed to fetch risk metrics:', err)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { metrics, refresh }
}

export function useFinanceRefresh() {
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.api.refreshFinance()
    } catch (err) {
      console.error('Failed to refresh finance data:', err)
    }
    setRefreshing(false)
  }, [])

  return { refreshing, refresh }
}
