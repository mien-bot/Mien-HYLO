import { useState, useEffect, useCallback, useRef } from 'react'
import type { HealthMetric } from '../../shared/types/ipc.types'

export function useHealthMetrics(type: string, days: number = 7) {
  const [metrics, setMetrics] = useState<HealthMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const hasDataRef = useRef(false)
  const lastParamsRef = useRef({ type, days })

  const refresh = useCallback(async () => {
    const paramsChanged = lastParamsRef.current.type !== type || lastParamsRef.current.days !== days
    lastParamsRef.current = { type, days }
    // Only show spinner on initial load or when query params change — not on background refreshes
    if (!hasDataRef.current || paramsChanged) {
      setLoading(true)
      if (paramsChanged) hasDataRef.current = false
    }
    setError(null)
    try {
      const data = await window.api.getHealthMetrics(type, days)
      setMetrics(data)
      if (data.length > 0) hasDataRef.current = true
    } catch (err: any) {
      setError(err.message || `Failed to load health metrics (${type})`)
    }
    setLoading(false)
  }, [type, days])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { metrics, loading, error, refresh }
}

export function useHealthSummary() {
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.api.getHealthSummary()
      setSummary(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load health summary')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { summary, loading, error, refresh }
}

// Parse the value_json from a health metric into a usable object
export function parseMetricValue(metric: HealthMetric): Record<string, unknown> {
  try {
    return JSON.parse(metric.value_json)
  } catch {
    return {}
  }
}
