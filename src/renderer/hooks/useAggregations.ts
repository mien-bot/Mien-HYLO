import { useCallback } from 'react'
import { useManualQuery } from './useManualQuery'

// --- Finance aggregations ---

export function usePriceTimeSeries(symbol: string | null, days = 90, withIndicators = false) {
  return useManualQuery(
    useCallback(async () => {
      if (!symbol) return []
      return await window.api.getPriceTimeSeries(symbol, days, withIndicators)
    }, [symbol, days, withIndicators]),
    { deps: [symbol, days, withIndicators] },
  )
}

export function usePortfolioVsBenchmark(days = 90, benchmarks: string[] = ['SPY']) {
  const benchmarkKey = benchmarks.join(',')
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getPortfolioVsBenchmark(days, benchmarks)
    }, [days, benchmarks, benchmarkKey]),
    { deps: [days, benchmarkKey] },
  )
}

export function useCorrelationMatrix(symbols?: string[], days = 60) {
  const symbolKey = symbols?.join(',')
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getCorrelationMatrix(symbols, days)
    }, [symbols, symbolKey, days]),
    { deps: [symbolKey, days] },
  )
}

export function useSectorExposure() {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getSectorExposure()
    }, []),
  )
}

export function useSentimentTimeSeries(symbol?: string, days = 30) {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getSentimentTimeSeries(symbol, days)
    }, [symbol, days]),
    { deps: [symbol, days] },
  )
}

// --- Health aggregations ---

export function useMetricRollingAverages(
  metricType: string,
  windows: number[] = [7, 14, 30],
  days = 90,
) {
  const windowKey = windows.join(',')
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getMetricRollingAverages(metricType, windows, days)
    }, [metricType, windows, windowKey, days]),
    { deps: [metricType, windowKey, days] },
  )
}

export function useSleepStageHistory(days = 30) {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getSleepStageHistory(days)
    }, [days]),
    { deps: [days] },
  )
}

export function useCircadianPhases24h() {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getCircadianPhases24h()
    }, []),
  )
}

export function useFitnessHistory(days = 90) {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getFitnessHistory(days)
    }, [days]),
    { deps: [days] },
  )
}

// --- Diagnostics ---

export function useAiCacheStats(days = 30) {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getAiCacheStats(days)
    }, [days]),
    { deps: [days] },
  )
}

export function useRelayStats() {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getRelayStats()
    }, []),
  )
}

export function useSchedulerSuccessRate(days = 30) {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getSchedulerSuccessRate(days)
    }, [days]),
    { deps: [days] },
  )
}

// --- Cross-domain composite engine ---

export function useCrossDomainReadiness() {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getCrossDomainReadiness()
    }, []),
  )
}

export function useEnergyAlignment(date?: string) {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getEnergyAlignment(date)
    }, [date]),
    { deps: [date] },
  )
}

export function useCrossDomainCorrelations(days = 60) {
  return useManualQuery(
    useCallback(async () => {
      return await window.api.getCrossDomainCorrelations(days)
    }, [days]),
    { deps: [days] },
  )
}
