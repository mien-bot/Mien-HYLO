import { useCallback, useEffect, useState } from 'react'

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error')
}

export function useApiCall<T>(
  fn: () => Promise<T>,
  options?: { deps?: unknown[]; immediate?: boolean },
): {
  data: T | null
  loading: boolean
  error: string | null
  execute: () => Promise<void>
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deps = options?.deps ?? []
  const immediate = options?.immediate ?? true

  const execute = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await fn())
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fn, ...deps])

  useEffect(() => {
    if (immediate) void execute()
  }, [execute, immediate])

  return { data, loading, error, execute }
}
