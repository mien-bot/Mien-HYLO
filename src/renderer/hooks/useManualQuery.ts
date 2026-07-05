import { useCallback, useEffect, useRef, useState } from 'react'

export interface ManualQueryResult<T> {
  data: T | null
  error: Error | null
  loading: boolean
  lastUpdated: number | null
  refresh: () => Promise<void>
}

export function useManualQuery<T>(
  fetcher: () => Promise<T>,
  options: { runOnMount?: boolean; deps?: unknown[] } = {},
): ManualQueryResult<T> {
  const { runOnMount = true, deps = [] } = options
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetcherRef.current()
      setData(result)
      setLastUpdated(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (runOnMount) {
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading, lastUpdated, refresh }
}

export function useManualQueries(queries: Array<{ refresh: () => Promise<void> }>) {
  return useCallback(async () => {
    await Promise.all(queries.map((q) => q.refresh()))
  }, [queries])
}

export function formatLastUpdated(ts: number | null | undefined): string {
  if (!ts) return ''
  const delta = Date.now() - ts
  if (delta < 1000) return 'just now'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}
