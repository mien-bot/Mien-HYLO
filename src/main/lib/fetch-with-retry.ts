/**
 * Bounded fetch helpers: explicit timeout, bounded retries with exponential
 * backoff, and 429 Retry-After awareness. Use in place of raw fetch() for
 * any external network call so scheduler jobs and IPC handlers cannot hang
 * indefinitely.
 *
 * Returns `null` on hard failure (after retries exhausted) rather than
 * throwing — most call sites already had `try { ... } catch { return null }`
 * patterns, and shifting to null keeps that contract while logging the cause.
 */

export interface FetchRetryOptions {
  timeoutMs?: number
  retries?: number
  backoffMs?: number
  headers?: Record<string, string>
  label?: string
  method?: string
  body?: string
}

const DEFAULTS = {
  timeoutMs: 10_000,
  retries: 3,
  backoffMs: 500,
}

interface ErrorWithName {
  name?: string
  message?: string
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status === 425 || (status >= 500 && status < 600)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchOnce(url: string, opts: FetchRetryOptions): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULTS.timeoutMs)
  try {
    return await fetch(url, {
      method: opts.method,
      body: opts.body,
      headers: opts.headers,
      signal: controller.signal,
    })
  } catch (err) {
    const label = opts.label || url
    const error = err as ErrorWithName
    if (error.name === 'AbortError') {
      console.warn(`[fetch] ${label} timed out after ${opts.timeoutMs ?? DEFAULTS.timeoutMs}ms`)
    } else {
      console.warn(`[fetch] ${label} network error:`, error.message || err)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithRetry(url: string, opts: FetchRetryOptions): Promise<Response | null> {
  const retries = opts.retries ?? DEFAULTS.retries
  const baseBackoff = opts.backoffMs ?? DEFAULTS.backoffMs
  const label = opts.label || url

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchOnce(url, opts)
    if (res && res.ok) return res
    if (res && !shouldRetry(res.status)) {
      console.warn(`[fetch] ${label} non-retryable ${res.status}`)
      return res
    }

    if (attempt === retries) {
      if (res)
        console.warn(
          `[fetch] ${label} gave up after ${retries + 1} tries (last status ${res.status})`,
        )
      return res
    }

    let waitMs = baseBackoff * Math.pow(2, attempt)
    if (res?.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '', 10)
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        waitMs = Math.min(retryAfter * 1000, 30_000)
      }
    }
    await sleep(waitMs)
  }
  return null
}

export async function fetchJson<T = any>(
  url: string,
  opts: FetchRetryOptions = {},
): Promise<T | null> {
  const res = await fetchWithRetry(url, opts)
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as T
  } catch (err) {
    console.warn(`[fetch] ${opts.label || url} JSON parse failed:`, (err as Error)?.message)
    return null
  }
}

export async function fetchText(url: string, opts: FetchRetryOptions = {}): Promise<string | null> {
  const res = await fetchWithRetry(url, opts)
  if (!res || !res.ok) return null
  try {
    return await res.text()
  } catch (err) {
    console.warn(`[fetch] ${opts.label || url} text read failed:`, (err as Error)?.message)
    return null
  }
}
