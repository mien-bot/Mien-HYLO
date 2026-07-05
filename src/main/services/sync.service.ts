/**
 * Sync service — pushes desktop data to the relay server
 * so the mobile app can pull it. Runs periodically.
 */
import { applySleepOutlierExclusions, getDb } from '../db/database'
import { randomUUID } from 'crypto'
import { mergeWorkouts, isStravaWorkout } from './health/workout-merge'
import {
  parseSleepSessions,
  calculateSleepDebt,
  predictCircadianRhythm,
  scoreSleepQuality,
  detectChronotype,
  calculateSocialJetLag,
  calculateCaffeineCutoff,
  calculateHrvRecovery,
  recommendWakeTime,
  calculateEnergyCurve,
  analyzeSleepNeed,
} from './health/sleep-analysis'
import { broadcastSleepArrived, runMorningSleepBriefingIfDue } from './health/health-export.service'
import { getAppSettings } from '../lib/settings'

function getRelayUrl(): string | null {
  const settings = getAppSettings()
  return settings?.relayUrl || null
}

/**
 * Per-table push checkpoints — we only send rows whose imported_at /
 * fetched_at / created_at exceeds the last successful push timestamp.
 * On a successful push we bump the checkpoint to "now". Null = no prior
 * push, send everything.
 */
function getPushCheckpoint(tableName: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT last_pushed_at FROM sync_checkpoints WHERE table_name = ?')
      .get(tableName) as { last_pushed_at: string } | undefined
    return row?.last_pushed_at
      ? toSqliteUtcTimestamp(row.last_pushed_at) || row.last_pushed_at
      : null
  } catch (err) {
    console.error(`[sync] getPushCheckpoint(${tableName}) failed:`, err)
    return null
  }
}

function setPushCheckpoint(tableName: string, ts: string): void {
  try {
    getDb()
      .prepare(
        `
      INSERT INTO sync_checkpoints (table_name, last_pushed_at)
      VALUES (?, ?)
      ON CONFLICT(table_name) DO UPDATE SET last_pushed_at = excluded.last_pushed_at
    `,
      )
      .run(tableName, ts)
  } catch (err) {
    console.error(`[sync] setPushCheckpoint(${tableName}) failed:`, err)
  }
}

/**
 * Parse a timestamp to epoch ms, treating zone-less strings as UTC. SQLite's
 * `datetime('now')` stores `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker;
 * V8 would otherwise parse that as LOCAL time and shift it by the local offset
 * (and compound the shift on every read), corrupting the push checkpoints.
 */
function parseTimestampMs(value: string): number {
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value)
  const normalized = hasZone ? value : value.replace(' ', 'T') + 'Z'
  return Date.parse(normalized)
}

/**
 * Normalize any timestamp (ISO `...Z` or bare SQLite `YYYY-MM-DD HH:MM:SS`) to
 * the SQLite UTC form. Idempotent: a SQLite-UTC string round-trips to itself,
 * so re-reading a checkpoint never drifts.
 */
export function toSqliteUtcTimestamp(value: string): string | null {
  const ms = parseTimestampMs(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function getMaxTimestamp<T extends Record<string, unknown>>(rows: T[], key: keyof T): string | null {
  let maxMs = -Infinity
  let maxValue: string | null = null

  for (const row of rows) {
    const value = row[key]
    if (typeof value !== 'string' || !value) continue
    const ms = parseTimestampMs(value)
    if (Number.isFinite(ms) && ms > maxMs) {
      maxMs = ms
      maxValue = value
    }
  }

  return maxValue ? toSqliteUtcTimestamp(maxValue) : null
}

function getRelayHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const settings = getAppSettings()
  const token = settings?.relayToken || null
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

function refreshRestaurantVisitSummaries(db: any, placeIds: Set<string>): void {
  const ratings = db.prepare(
    'SELECT rating FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL AND rating IS NOT NULL',
  )
  const latestVisit = db.prepare(
    'SELECT visit_date FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL ORDER BY visit_date DESC LIMIT 1',
  )
  const updateSummary = db.prepare(
    `UPDATE saved_restaurants
     SET visited = CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
         visit_date = ?,
         personal_rating = ?
     WHERE place_id = ?`,
  )

  for (const placeId of placeIds) {
    const rows = ratings.all(placeId) as Array<{ rating: number }>
    const latest = latestVisit.get(placeId) as { visit_date: string } | undefined
    const average =
      rows.length > 0
        ? Number((rows.reduce((sum, row) => sum + row.rating, 0) / rows.length).toFixed(1))
        : null
    updateSummary.run(latest?.visit_date || null, latest?.visit_date || null, average, placeId)
  }
}

// ETag cache — stores last-seen ETags per endpoint to enable 304 responses
const etagCache = new Map<string, string>()

class NotModifiedError extends Error {
  constructor() {
    super('304 Not Modified')
  }
}

async function fetchRelayJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  // Attach If-None-Match header for GET requests if we have a cached ETag
  const headers = { ...((init.headers as Record<string, string>) || {}) }
  if (!init.method || init.method === 'GET') {
    const cachedEtag = etagCache.get(url)
    if (cachedEtag) {
      headers['If-None-Match'] = cachedEtag
    }
  }

  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal })

    // 304 Not Modified — data hasn't changed
    if (res.status === 304) {
      throw new NotModifiedError()
    }

    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok) {
      const detail = data?.error?.message || data?.error || text || `HTTP ${res.status}`
      throw new Error(`Relay returned ${res.status}: ${detail}`)
    }

    // Store ETag from response for future requests
    const etag = res.headers.get('etag')
    if (etag) {
      etagCache.set(url, etag)
    }

    return data
  } catch (err: any) {
    if (err instanceof NotModifiedError) throw err
    if (err?.name === 'AbortError') throw new Error(`Relay request timed out after ${timeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

type SyncStepResult = {
  success: boolean
  pushed?: number
  pulled?: number
  skipped?: number
  received?: number
  error?: string
}

const MAX_SLEEP_MINUTES = 16 * 60

export type RelaySyncResult = {
  success: boolean
  steps: {
    pushHealth: SyncStepResult
    pullHealth: SyncStepResult
    pullMobileData: SyncStepResult
    pushAll: SyncStepResult
    pushSleepAnalysis: SyncStepResult
    pullStravaStreams: SyncStepResult
  }
}

let inFlightSync: Promise<RelaySyncResult> | null = null

/**
 * Push health data to relay server
 */
export async function pushHealthToRelay(): Promise<{ success: boolean; pushed: number }> {
  const relayUrl = getRelayUrl()
  if (!relayUrl) return { success: false, pushed: 0 }

  const db = getDb()
  ensureSyncIds(db, 'holdings')
  ensureSyncIds(db, 'alerts')
  ensureSyncIds(db, 'health_alerts')
  const checkpoint = getPushCheckpoint('health_metrics')
  const rowsStmt = checkpoint
    ? db.prepare(
        `SELECT metric_type, date, value_json, source, imported_at FROM health_metrics
         WHERE imported_at > ?
            OR (metric_type = 'sleep' AND date >= date('now', '-7 days'))
         ORDER BY date DESC`,
      )
    : db.prepare(
        `SELECT metric_type, date, value_json, source, imported_at FROM health_metrics
         ORDER BY date DESC`,
      )
  const rows = (checkpoint ? rowsStmt.all(checkpoint) : rowsStmt.all()) as Array<{
    metric_type: string
    date: string
    value_json: string
    source: string
    imported_at: string
  }>

  if (rows.length === 0) return { success: true, pushed: 0 }

  const metrics: Array<{ type: string; date: string; value: any; source: string }> = []
  const pushedRows: typeof rows = []
  for (const r of rows) {
    try {
      metrics.push({
        type: r.metric_type,
        date: r.date,
        value: JSON.parse(r.value_json),
        source: r.source || 'desktop',
      })
      pushedRows.push(r)
    } catch (err) {
      console.warn(
        `[sync] skipping malformed health_metrics row ${r.metric_type}/${r.date}:`,
        (err as Error)?.message,
      )
    }
  }

  if (metrics.length === 0) return { success: true, pushed: 0 }

  try {
    const data = await fetchRelayJson(
      `${relayUrl.replace(/\/$/, '')}/health/sync`,
      {
        method: 'POST',
        headers: getRelayHeaders(),
        body: JSON.stringify({ metrics }),
      },
      60_000,
    )
    const maxImportedAt = getMaxTimestamp(pushedRows, 'imported_at')
    if (maxImportedAt) setPushCheckpoint('health_metrics', maxImportedAt)
    return { success: true, pushed: data.added || 0 }
  } catch (err) {
    console.error('Relay sync error:', err)
    return { success: false, pushed: 0 }
  }
}

type HealthPullOptions = {
  days?: number
  type?: string
}

type HealthPullResult = {
  success: boolean
  pulled: number
  received?: number
  skipped?: number
  requestedDays?: number
  earliestDate?: string | null
  latestDate?: string | null
  error?: string
}

/**
 * Pull health data from relay (e.g. data that came from Apple Shortcuts).
 * Defaults to a cheap recent sync unless this is the first desktop sync.
 */
export async function pullHealthFromRelay(
  options: HealthPullOptions = {},
): Promise<HealthPullResult> {
  const relayUrl = getRelayUrl()
  if (!relayUrl) return { success: false, pulled: 0, error: 'No relay URL' }

  // First-time sync: if the local health table is empty, backfill everything
  // the relay has (up to ~10 years). Subsequent syncs only refresh the recent
  // window so the 30-min periodic sync stays cheap.
  const db = getDb()
  const localCount = (db.prepare('SELECT COUNT(*) AS n FROM health_metrics').get() as { n: number })
    .n
  const days = options.days ?? (localCount === 0 ? 3650 : 14)

  try {
    const params = new URLSearchParams({ days: String(days) })
    if (options.type) params.set('type', options.type)

    let data: any
    try {
      data = await fetchRelayJson(
        `${relayUrl.replace(/\/$/, '')}/health/data?${params.toString()}`,
        {
          headers: getRelayHeaders(),
        },
        60_000,
      )
    } catch (err) {
      if (err instanceof NotModifiedError) {
        return {
          success: true,
          pulled: 0,
          received: 0,
          skipped: 0,
          requestedDays: days,
          earliestDate: null,
          latestDate: null,
        }
      }
      throw err
    }
    const metrics = data.metrics || []

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
       VALUES (?, ?, ?, ?)`,
    )
    const existingWorkoutStmt = db.prepare(
      `SELECT value_json FROM health_metrics WHERE metric_type = 'workout' AND date = ?`,
    )

    let pulled = 0
    let skipped = 0
    let sleepSeen = false
    for (const m of metrics) {
      if (m.type === 'sleep') sleepSeen = true
      // Skip known bad data before inserting
      if (typeof m.value === 'object') {
        const qty = m.value.qty ?? m.value.Avg ?? null
        const zeroTypes = [
          'basal_energy',
          'distance',
          'exercise_time',
          'flights_climbed',
          'time_in_daylight',
        ]
        if (zeroTypes.includes(m.type) && (qty === null || qty <= 0)) {
          skipped++
          continue
        }
        if (m.type === 'active_energy' && (qty === null || qty < 1)) {
          skipped++
          continue
        }
        if (m.type === 'steps' && (qty === null || qty < 10)) {
          skipped++
          continue
        }
        if (m.type === 'heart_rate' && qty !== null && (qty <= 0 || qty > 220)) {
          skipped++
          continue
        }
        if (m.type === 'hrv' && qty !== null && (qty <= 0 || qty > 300)) {
          skipped++
          continue
        }
        // Sleep: check totalAsleep or qty, and compute inBed from timestamps if missing
        if (m.type === 'sleep') {
          const sleepMins = m.value.totalAsleep ?? m.value.asleep ?? m.value.qty ?? 0
          if (sleepMins < 60 || sleepMins > MAX_SLEEP_MINUTES) {
            if (sleepMins > MAX_SLEEP_MINUTES) {
              console.warn(
                `[Sync] Rejected inflated sleep row from relay for ${m.date}: totalAsleep=${sleepMins}min`,
              )
            }
            skipped++
            continue
          }
          // Ensure inBed is computed from timestamps when the raw field is 0
          if (!m.value.inBed && m.value.sleepStart && m.value.sleepEnd) {
            const s = new Date(m.value.sleepStart)
            const e = new Date(m.value.sleepEnd)
            if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
              const ms = e.getTime() - s.getTime()
              if (ms > 0) m.value.inBed = Math.round(ms / 60000)
            }
          }
          if (!m.value.inBed) m.value.inBed = sleepMins
        }
      }
      if (m.type === 'workout' && typeof m.value === 'object' && Array.isArray(m.value.workouts)) {
        let existingWorkouts: any[] = []
        try {
          const existing = existingWorkoutStmt.get(m.date) as { value_json: string } | undefined
          const parsed = existing ? JSON.parse(existing.value_json) : null
          existingWorkouts = Array.isArray(parsed?.workouts) ? parsed.workouts : []
        } catch {}

        const merged = mergeWorkouts(existingWorkouts, m.value.workouts)
        const hasStrava = merged.some(isStravaWorkout)
        const hasNonStrava = merged.some((w) => !isStravaWorkout(w))
        const source =
          hasStrava && hasNonStrava ? 'mixed' : hasStrava ? 'strava' : m.source || 'shortcut'
        stmt.run(m.type, m.date, JSON.stringify({ workouts: merged }), source)
        pulled++
        continue
      }
      const valueJson = typeof m.value === 'string' ? m.value : JSON.stringify(m.value)
      stmt.run(m.type, m.date, valueJson, m.source || 'shortcut')
      pulled++
    }

    if (sleepSeen) {
      applySleepOutlierExclusions(db)
      broadcastSleepArrived()
      markNewSleepData()
      // Fire morning sleep briefing after the new data is persisted. Idempotent —
      // generates once per calendar day. Critical for users whose sleep data
      // arrives via the relay (not via the local HTTP server).
      setTimeout(() => {
        runMorningSleepBriefingIfDue({ reason: 'relay-pull' })
      }, 2000)
    }

    return {
      success: true,
      pulled,
      received: metrics.length,
      skipped,
      requestedDays: data.requestedDays ?? days,
      earliestDate: data.earliestDate ?? null,
      latestDate: data.latestDate ?? null,
    }
  } catch (err) {
    console.error('Relay pull error:', err)
    return {
      success: false,
      pulled: 0,
      requestedDays: days,
      error: err instanceof Error ? err.message : 'Relay pull failed',
    }
  }
}

/**
 * Manual long-range backfill for sleep trends. Kept separate from scheduled
 * sync so the 30-minute relay job does not repeatedly request years of data.
 */
export async function pullHistoricalSleepFromRelay(
  days: number = 3650,
): Promise<HealthPullResult & { days: number }> {
  const result = await pullHealthFromRelay({ days, type: 'sleep' })
  return { ...result, days }
}

/**
 * Push ALL desktop data to relay for mobile sync.
 * Includes: watchlist, prices, news, briefings, chat, weekend plans, schedules, restaurants.
 */
export async function pushAllToRelay(): Promise<{ success: boolean; error?: string }> {
  const relayUrl = getRelayUrl()
  if (!relayUrl) return { success: false, error: 'No relay URL' }

  const db = getDb()

  try {
    // Watchlist (small, always full snapshot)
    const watchlist = db.prepare('SELECT symbol, type, name, added_at FROM watchlist').all()

    // Prices — initial push: last 30 days; subsequent pushes: only rows
    // fetched since the last successful push.
    const pricesCheckpoint = getPushCheckpoint('price_history')
    const prices = pricesCheckpoint
      ? db
          .prepare(
            `SELECT symbol, date, open, high, low, close, volume, source, fetched_at
           FROM price_history WHERE fetched_at > ?
           ORDER BY symbol, date ASC`,
          )
          .all(pricesCheckpoint)
      : db
          .prepare(
            `SELECT symbol, date, open, high, low, close, volume, source, fetched_at
           FROM price_history WHERE date >= date('now', '-30 days')
           ORDER BY symbol, date ASC`,
          )
          .all()

    // News — initial push: last 7 days; subsequent pushes: new fetches only.
    // Archived (stale) articles are never pushed so mobile only sees fresh items.
    const newsCheckpoint = getPushCheckpoint('news_articles')
    const news = newsCheckpoint
      ? db
          .prepare(
            `SELECT title, url, source, published_at, related_symbols, summary, content_context,
                    transcript_status, transcript_source, transcript_fetched_at, fetched_at
           FROM news_articles
           WHERE fetched_at > ? AND archived_at IS NULL
           ORDER BY published_at DESC LIMIT 100`,
          )
          .all(newsCheckpoint)
      : db
          .prepare(
            `SELECT title, url, source, published_at, related_symbols, summary, content_context,
                    transcript_status, transcript_source, transcript_fetched_at, fetched_at
           FROM news_articles
           WHERE fetched_at >= datetime('now', '-7 days')
             AND archived_at IS NULL
           ORDER BY published_at DESC LIMIT 100`,
          )
          .all()

    // Briefings (last 14 days)
    const briefings = db
      .prepare(
        `SELECT type, date, content, created_at FROM briefings
       WHERE created_at >= datetime('now', '-14 days')
       ORDER BY created_at DESC`,
      )
      .all()

    // Chat messages (last 100)
    const chat_messages = db
      .prepare(
        `SELECT role, content, conversation_id, created_at FROM chat_messages
       ORDER BY created_at DESC LIMIT 100`,
      )
      .all()

    // Weekend plans (last 30 days)
    const weekend_plans = db
      .prepare(
        `SELECT weekend_date, plan_json, events_json, ai_rationale, created_at, updated_at, deleted_at
       FROM weekend_plans WHERE weekend_date >= date('now', '-30 days')
       ORDER BY weekend_date DESC`,
      )
      .all()

    const weekend_event_cache = db
      .prepare(
        `SELECT event_key, name, event_date, time, venue, address, city, type,
              price_range, url, image_url, description, source, query, category,
              saved_at, updated_at
       FROM weekend_event_cache
       WHERE updated_at >= datetime('now', '-90 days')
       ORDER BY updated_at DESC`,
      )
      .all()

    // Daily schedules (last 14 days)
    const daily_schedule = db
      .prepare(
        `SELECT date, schedule_json, ai_rationale, created_at, updated_at, deleted_at FROM daily_schedule
       WHERE date >= date('now', '-14 days')
       ORDER BY date DESC`,
      )
      .all()

    // Holdings — always full snapshot (small).
    const holdings = db
      .prepare(
        `SELECT id, sync_id, symbol, quantity, cost_basis, acquired_at, notes, created_at, updated_at, deleted_at FROM holdings ORDER BY symbol ASC`,
      )
      .all()

    // Finance alerts — read-only on mobile, full snapshot.
    const alerts = db
      .prepare(
        `SELECT id, sync_id, symbol, type, threshold, note, active, one_shot, last_fired_at, last_value, created_at, updated_at, deleted_at
       FROM alerts ORDER BY active DESC, created_at DESC`,
      )
      .all()

    // Health alerts — read-only on mobile, full snapshot.
    const health_alerts = db
      .prepare(
        `SELECT id, sync_id, type, threshold, note, active, one_shot, last_fired_at, last_value, created_at, updated_at, deleted_at
       FROM health_alerts ORDER BY active DESC, created_at DESC`,
      )
      .all()

    // Fundamentals — full snapshot (one row per watchlist symbol).
    const fundamentals = db
      .prepare(
        `SELECT symbol, pe, pb, eps, revenue, market_cap, dividend_yield, sector, fetched_at FROM fundamentals`,
      )
      .all()

    // Saved restaurants (all)
    const saved_restaurants = db
      .prepare(
        `SELECT place_id, name, address, price_level, rating, cuisine, lat, lng,
              notes, booking_advance, saved_at, venue_type, cuisine_category,
              spice_level, reservation_link, peak_times, description,
              visited, visit_date, personal_rating,
              booking_advance_days, busy_days_matrix, last_researched_at, updated_at
       FROM saved_restaurants ORDER BY saved_at DESC`,
      )
      .all()

    // Restaurant visits
    const restaurant_visits = db
      .prepare(
        `SELECT id, place_id, visit_date, rating, notes, created_at, deleted_at FROM restaurant_visits ORDER BY visit_date DESC`,
      )
      .all()

    const payload = {
      watchlist,
      prices,
      news,
      briefings,
      chat_messages,
      weekend_plans,
      weekend_event_cache,
      daily_schedule,
      saved_restaurants,
      restaurant_visits,
      holdings,
      alerts,
      health_alerts,
      fundamentals,
    }

    const result = await fetchRelayJson(
      `${relayUrl.replace(/\/$/, '')}/sync/push-all`,
      {
        method: 'POST',
        headers: getRelayHeaders(),
        body: JSON.stringify(payload),
      },
      60_000,
    )
    // Bump per-table checkpoints only to timestamps that were actually sent.
    const maxPriceFetchedAt = getMaxTimestamp(prices as Array<Record<string, unknown>>, 'fetched_at')
    const maxNewsFetchedAt = getMaxTimestamp(news as Array<Record<string, unknown>>, 'fetched_at')
    if (maxPriceFetchedAt) setPushCheckpoint('price_history', maxPriceFetchedAt)
    if (maxNewsFetchedAt) setPushCheckpoint('news_articles', maxNewsFetchedAt)
    console.log(`[Sync] Full push complete: ${JSON.stringify(result)}`)
    return { success: true }
  } catch (err: any) {
    console.error('[Sync] Full push error:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Pull relay data into this desktop. This includes data pushed by mobile and
 * data pushed by other desktop sessions.
 */
export async function pullMobileDataFromRelay(): Promise<{ success: boolean; pulled: number }> {
  const relayUrl = getRelayUrl()
  if (!relayUrl) return { success: false, pulled: 0 }

  try {
    let data: any
    try {
      data = await fetchRelayJson(
        `${relayUrl.replace(/\/$/, '')}/sync/pull-all?includeHealth=false`,
        {
          headers: getRelayHeaders(),
        },
        60_000,
      )
    } catch (err) {
      if (err instanceof NotModifiedError) return { success: true, pulled: 0 }
      throw err
    }
    const db = getDb()
    ensureSyncIds(db, 'holdings')
    ensureSyncIds(db, 'alerts')
    ensureSyncIds(db, 'health_alerts')
    let pulled = 0

    // Merge watchlist from relay/other desktops.
    if (data.watchlist?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO watchlist (symbol, type, name, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           type = excluded.type,
           name = COALESCE(excluded.name, watchlist.name)`,
      )
      for (const w of data.watchlist) {
        if (!w.symbol || !w.type) continue
        stmt.run(w.symbol, w.type, w.name || null, w.added_at || new Date().toISOString())
        pulled++
      }
    }

    // Merge price history from relay/other desktops.
    if (data.prices?.length > 0) {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO price_history (symbol, date, open, high, low, close, volume, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const p of data.prices) {
        if (!p.symbol || !p.date) continue
        stmt.run(p.symbol, p.date, p.open, p.high, p.low, p.close, p.volume, p.source || 'sync')
        pulled++
      }
    }

    // Merge news from relay/other desktops.
    if (data.news?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO news_articles
         (title, url, source, published_at, related_symbols, summary, content_context,
          transcript_status, transcript_source, transcript_fetched_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           summary = COALESCE(excluded.summary, news_articles.summary),
           content_context = COALESCE(excluded.content_context, news_articles.content_context),
           transcript_status = COALESCE(excluded.transcript_status, news_articles.transcript_status),
           transcript_source = COALESCE(excluded.transcript_source, news_articles.transcript_source),
           transcript_fetched_at = COALESCE(excluded.transcript_fetched_at, news_articles.transcript_fetched_at)`,
      )
      for (const article of data.news) {
        if (!article.title || !article.url) continue
        stmt.run(
          article.title,
          article.url,
          article.source || null,
          article.published_at || null,
          article.related_symbols || '[]',
          article.summary || null,
          article.content_context || null,
          article.transcript_status || null,
          article.transcript_source || null,
          article.transcript_fetched_at || null,
          article.fetched_at || new Date().toISOString(),
        )
        pulled++
      }
    }

    // Merge saved restaurants from relay/mobile/other desktops.
    if (data.saved_restaurants?.length > 0) {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO saved_restaurants
         (place_id, name, address, price_level, rating, cuisine, lat, lng, notes,
          booking_advance, venue_type, cuisine_category, spice_level,
          reservation_link, peak_times, description, visited, visit_date, personal_rating,
          booking_advance_days, busy_days_matrix, last_researched_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(place_id) DO UPDATE SET
           name = excluded.name,
           address = excluded.address,
           price_level = excluded.price_level,
           rating = excluded.rating,
           cuisine = excluded.cuisine,
           lat = excluded.lat,
           lng = excluded.lng,
           notes = excluded.notes,
           booking_advance = excluded.booking_advance,
           venue_type = excluded.venue_type,
           cuisine_category = excluded.cuisine_category,
           spice_level = excluded.spice_level,
           reservation_link = excluded.reservation_link,
           peak_times = excluded.peak_times,
           description = excluded.description,
           visited = excluded.visited,
           visit_date = excluded.visit_date,
           personal_rating = excluded.personal_rating,
           booking_advance_days = excluded.booking_advance_days,
           busy_days_matrix = excluded.busy_days_matrix,
           last_researched_at = excluded.last_researched_at,
           updated_at = excluded.updated_at
         WHERE COALESCE(excluded.updated_at, excluded.saved_at, '') >= COALESCE(saved_restaurants.updated_at, saved_restaurants.saved_at, '')`,
      )
      for (const r of data.saved_restaurants) {
        stmt.run(
          r.place_id,
          r.name,
          r.address || '',
          r.price_level,
          r.rating,
          r.cuisine || '',
          r.lat || 0,
          r.lng || 0,
          r.notes,
          r.booking_advance,
          r.venue_type || 'restaurant',
          r.cuisine_category,
          r.spice_level,
          r.reservation_link,
          r.peak_times,
          r.description,
          r.visited || 0,
          r.visit_date,
          r.personal_rating,
          r.booking_advance_days ?? null,
          typeof r.busy_days_matrix === 'string'
            ? r.busy_days_matrix
            : r.busy_days_matrix
              ? JSON.stringify(r.busy_days_matrix)
              : null,
          r.last_researched_at ?? null,
          r.updated_at || r.saved_at || new Date().toISOString(),
        )
        pulled++
      }
    }

    // Merge restaurant visits from relay/mobile/other desktops.
    if (data.restaurant_visits?.length > 0) {
      const affectedPlaceIds = new Set<string>()
      const upsertVisit = db.prepare(
        `INSERT INTO restaurant_visits (place_id, visit_date, rating, notes, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(place_id, visit_date) DO UPDATE SET
           rating = excluded.rating,
           notes = excluded.notes,
           created_at = excluded.created_at,
           deleted_at = excluded.deleted_at
         WHERE restaurant_visits.created_at IS NULL
            OR excluded.created_at >= restaurant_visits.created_at`,
      )
      for (const v of data.restaurant_visits) {
        if (!v.place_id || !v.visit_date) continue
        upsertVisit.run(
          v.place_id,
          v.visit_date,
          v.rating,
          v.notes,
          v.created_at || new Date().toISOString(),
          v.deleted_at || null,
        )
        affectedPlaceIds.add(v.place_id)
        pulled++
      }
      refreshRestaurantVisitSummaries(db, affectedPlaceIds)
    }

    // Merge chat messages from relay/mobile/other desktops.
    if (data.chat_messages?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO chat_messages (role, content, conversation_id, created_at)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM chat_messages
           WHERE role = ? AND content = ? AND conversation_id = ? AND created_at = ?
         )`,
      )
      for (const msg of data.chat_messages) {
        if (!msg.role || !msg.content) continue
        const conversationId = msg.conversation_id || 'default'
        const createdAt = msg.created_at || new Date().toISOString()
        stmt.run(
          msg.role,
          msg.content,
          conversationId,
          createdAt,
          msg.role,
          msg.content,
          conversationId,
          createdAt,
        )
        pulled++
      }
    }

    // Merge weekend plans from relay/other desktops.
    if (data.weekend_plans?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO weekend_plans (weekend_date, plan_json, events_json, ai_rationale, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(weekend_date) DO UPDATE SET
           plan_json = excluded.plan_json,
           events_json = excluded.events_json,
           ai_rationale = excluded.ai_rationale,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at
         WHERE COALESCE(excluded.deleted_at, excluded.updated_at, excluded.created_at, '') >=
               COALESCE(weekend_plans.deleted_at, weekend_plans.updated_at, weekend_plans.created_at, '')`,
      )
      for (const wp of data.weekend_plans) {
        if (!wp.weekend_date || !wp.plan_json) continue
        stmt.run(
          wp.weekend_date,
          wp.plan_json,
          wp.events_json || null,
          wp.ai_rationale || null,
          wp.created_at || new Date().toISOString(),
          wp.updated_at || wp.created_at || null,
          wp.deleted_at || null,
        )
        pulled++
      }
    }

    // Merge daily schedules from relay (covers schedules created on other desktops or mobile)
    if (data.daily_schedule?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO daily_schedule (date, schedule_json, ai_rationale, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           schedule_json = excluded.schedule_json,
           ai_rationale = excluded.ai_rationale,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at
         WHERE COALESCE(excluded.deleted_at, excluded.updated_at, excluded.created_at, '') >=
               COALESCE(daily_schedule.deleted_at, daily_schedule.updated_at, daily_schedule.created_at, '')`,
      )
      for (const ds of data.daily_schedule) {
        if (!ds.date) continue
        stmt.run(
          ds.date,
          ds.schedule_json,
          ds.ai_rationale,
          ds.created_at,
          ds.updated_at || ds.created_at || null,
          ds.deleted_at || null,
        )
        pulled++
      }
    }

    // Merge briefings from relay. UPSERT keyed by (type, date) — keep most recent.
    if (data.briefings?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO briefings (type, date, content, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(type, date) DO UPDATE SET
           content = excluded.content,
           created_at = excluded.created_at
         WHERE excluded.created_at > briefings.created_at`,
      )
      for (const b of data.briefings) {
        if (!b.type || !b.date) continue
        stmt.run(b.type, b.date, b.content, b.created_at)
        pulled++
      }
    }

    if (data.weekend_event_cache?.length > 0) {
      const insertEvent = db.prepare(
        `INSERT INTO weekend_event_cache (
          event_key, name, event_date, time, venue, address, city, type,
          price_range, url, image_url, description, source, query, category,
          saved_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET
          name = excluded.name,
          event_date = excluded.event_date,
          time = excluded.time,
          venue = excluded.venue,
          address = excluded.address,
          city = excluded.city,
          type = excluded.type,
          price_range = excluded.price_range,
          url = excluded.url,
          image_url = excluded.image_url,
          description = excluded.description,
          source = excluded.source,
          query = excluded.query,
          category = excluded.category,
          updated_at = excluded.updated_at`,
      )
      for (const e of data.weekend_event_cache) {
        insertEvent.run(
          e.event_key,
          e.name,
          e.event_date || '',
          e.time || '',
          e.venue || '',
          e.address || '',
          e.city || '',
          e.type || 'other',
          e.price_range || '',
          e.url || '',
          e.image_url || null,
          e.description || '',
          e.source || 'sync',
          e.query || '',
          e.category || '',
          e.saved_at || new Date().toISOString(),
          e.updated_at || new Date().toISOString(),
        )
        pulled++
      }
    }

    if (data.holdings?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO holdings (sync_id, symbol, quantity, cost_basis, acquired_at, notes, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sync_id) DO UPDATE SET
           symbol = excluded.symbol,
           quantity = excluded.quantity,
           cost_basis = excluded.cost_basis,
           acquired_at = excluded.acquired_at,
           notes = excluded.notes,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at
         WHERE COALESCE(excluded.deleted_at, excluded.updated_at, excluded.created_at, '') >=
               COALESCE(holdings.deleted_at, holdings.updated_at, holdings.created_at, '')`,
      )
      for (const h of data.holdings) {
        const syncId = h.sync_id || (h.id ? `legacy:${h.id}` : null)
        if (!syncId || !h.symbol) continue
        stmt.run(
          syncId,
          h.symbol,
          h.quantity,
          h.cost_basis,
          h.acquired_at || null,
          h.notes || null,
          h.created_at || new Date().toISOString(),
          h.updated_at || h.created_at || null,
          h.deleted_at || null,
        )
        pulled++
      }
    }

    // Merge finance alerts from relay/other desktops.
    if (data.alerts?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO alerts (sync_id, symbol, type, threshold, note, active, one_shot, last_fired_at, last_value, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sync_id) DO UPDATE SET
           symbol = excluded.symbol,
           type = excluded.type,
           threshold = excluded.threshold,
           note = excluded.note,
           active = excluded.active,
           one_shot = excluded.one_shot,
           last_fired_at = excluded.last_fired_at,
           last_value = excluded.last_value,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at
         WHERE COALESCE(excluded.deleted_at, excluded.updated_at, excluded.created_at, '') >=
               COALESCE(alerts.deleted_at, alerts.updated_at, alerts.created_at, '')`,
      )
      for (const alert of data.alerts) {
        const syncId = alert.sync_id || (alert.id ? `legacy:${alert.id}` : null)
        if (!syncId || !alert.symbol || !alert.type) continue
        stmt.run(
          syncId,
          alert.symbol,
          alert.type,
          alert.threshold,
          alert.note || null,
          alert.active ?? 1,
          alert.one_shot ?? 1,
          alert.last_fired_at || null,
          alert.last_value ?? null,
          alert.created_at || new Date().toISOString(),
          alert.updated_at || alert.created_at || null,
          alert.deleted_at || null,
        )
        pulled++
      }
    }

    // Merge health alerts from relay/other desktops.
    if (data.health_alerts?.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO health_alerts (sync_id, type, threshold, note, active, one_shot, last_fired_at, last_value, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sync_id) DO UPDATE SET
           type = excluded.type,
           threshold = excluded.threshold,
           note = excluded.note,
           active = excluded.active,
           one_shot = excluded.one_shot,
           last_fired_at = excluded.last_fired_at,
           last_value = excluded.last_value,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at
         WHERE COALESCE(excluded.deleted_at, excluded.updated_at, excluded.created_at, '') >=
               COALESCE(health_alerts.deleted_at, health_alerts.updated_at, health_alerts.created_at, '')`,
      )
      for (const alert of data.health_alerts) {
        const syncId = alert.sync_id || (alert.id ? `legacy:${alert.id}` : null)
        if (!syncId || !alert.type) continue
        stmt.run(
          syncId,
          alert.type,
          alert.threshold,
          alert.note || null,
          alert.active ?? 1,
          alert.one_shot ?? 0,
          alert.last_fired_at || null,
          alert.last_value ?? null,
          alert.created_at || new Date().toISOString(),
          alert.updated_at || alert.created_at || null,
          alert.deleted_at || null,
        )
        pulled++
      }
    }

    // Merge fundamentals from relay/other desktops.
    if (data.fundamentals?.length > 0) {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO fundamentals
         (symbol, pe, pb, eps, revenue, market_cap, dividend_yield, sector, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const f of data.fundamentals) {
        if (!f.symbol) continue
        stmt.run(
          f.symbol,
          f.pe,
          f.pb,
          f.eps,
          f.revenue,
          f.market_cap,
          f.dividend_yield,
          f.sector || null,
          f.fetched_at || new Date().toISOString(),
        )
        pulled++
      }
    }

    return { success: true, pulled }
  } catch (err) {
    console.error('[Sync] Pull relay data error:', err)
    return { success: false, pulled: 0 }
  }
}

function ensureSyncIds(db: any, tableName: string): void {
  const rows = db
    .prepare(`SELECT id FROM ${tableName} WHERE sync_id IS NULL OR sync_id = ''`)
    .all() as Array<{ id: number }>
  if (rows.length === 0) return
  const stmt = db.prepare(
    `UPDATE ${tableName} SET sync_id = ?, updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE id = ?`,
  )
  for (const row of rows) stmt.run(randomUUID(), row.id)
}

function rowVersion(row: any): string {
  return row?.deleted_at || row?.updated_at || row?.created_at || ''
}

function incomingIsNewer(existing: any, incoming: any): boolean {
  if (!existing) return true
  return rowVersion(incoming) >= rowVersion(existing)
}

// Track whether new sleep data has arrived since the last analysis push
let newSleepDataSinceLastPush = true

export function markNewSleepData(): void {
  newSleepDataSinceLastPush = true
}

/**
 * Push computed sleep analysis to relay so mobile gets identical results.
 * Skips computation if no new sleep data has arrived since last push.
 */
export async function pushSleepAnalysisToRelay(): Promise<{ success: boolean }> {
  const relayUrl = getRelayUrl()
  if (!relayUrl) return { success: false }

  if (!newSleepDataSinceLastPush) {
    return { success: true }
  }

  try {
    const sessions = parseSleepSessions(30)
    if (sessions.length === 0) return { success: true }

    const debt = calculateSleepDebt(sessions)
    const circadian = predictCircadianRhythm(sessions)
    const lastNight = sessions[0]
    const quality = lastNight.totalAsleep > 0 ? scoreSleepQuality(lastNight, sessions) : null
    const chronotype = detectChronotype(sessions)
    const socialJetLag = calculateSocialJetLag(sessions)
    const caffeineCutoff = calculateCaffeineCutoff(sessions)
    const hrvRecovery = calculateHrvRecovery()
    const wakeRecommendation = recommendWakeTime(circadian.optimalBedtime)
    const energyCurve = calculateEnergyCurve(sessions)

    // Also include sleep need profile
    let sleepNeedProfile = null
    try {
      sleepNeedProfile = analyzeSleepNeed(90)
    } catch {}

    const analysis = {
      debt,
      quality,
      circadian,
      chronotype,
      socialJetLag,
      caffeineCutoff,
      hrvRecovery,
      wakeRecommendation,
      energyCurve,
    }

    await fetchRelayJson(
      `${relayUrl.replace(/\/$/, '')}/sleep/analysis`,
      {
        method: 'POST',
        headers: getRelayHeaders(),
        body: JSON.stringify({ analysis, sleepNeedProfile }),
      },
      30_000,
    )

    newSleepDataSinceLastPush = false
    console.log('[Sync] Sleep analysis pushed to relay')
    return { success: true }
  } catch (err) {
    console.error('[Sync] Push sleep analysis error:', err)
    return { success: false }
  }
}

/**
 * Pull Strava stream data from relay into local strava_streams table.
 * Uses incremental sync — only fetches streams added since last pull.
 */
export async function pullStravaStreamsFromRelay(
  days = 90,
): Promise<{ success: boolean; pulled: number }> {
  const relayUrl = getRelayUrl()
  if (!relayUrl) return { success: false, pulled: 0 }

  const db = getDb()

  // Ensure strava_streams table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS strava_streams (
      activity_id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      workout_name TEXT,
      streams_json TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Get the latest fetchedAt we have locally for incremental sync
  const lastFetched = db.prepare('SELECT MAX(fetched_at) AS latest FROM strava_streams').get() as
    | { latest: string | null }
    | undefined

  const params = new URLSearchParams({ days: String(days) })
  if (lastFetched?.latest) {
    params.set('after', lastFetched.latest)
  }

  try {
    const data = await fetchRelayJson(
      `${relayUrl.replace(/\/$/, '')}/strava/streams?${params}`,
      {
        headers: getRelayHeaders(),
      },
      60_000,
    )
    const streams = data.streams || []

    if (streams.length === 0) return { success: true, pulled: 0 }

    const insert = db.prepare(`
      INSERT OR REPLACE INTO strava_streams (activity_id, date, workout_name, streams_json, fetched_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const tx = db.transaction(() => {
      let count = 0
      for (const s of streams) {
        if (!s.activityId || !s.streams) continue
        insert.run(
          s.activityId,
          s.date || '',
          s.name || 'Unknown',
          JSON.stringify(s.streams),
          s.fetchedAt || new Date().toISOString(),
        )
        count++
      }
      return count
    })

    const pulled = tx()
    if (pulled > 0) {
      console.log(`[Sync] Pulled ${pulled} Strava streams from relay`)
    }
    return { success: true, pulled }
  } catch (err) {
    console.error('[Sync] Pull Strava streams error:', err)
    return { success: false, pulled: 0 }
  }
}

/**
 * Full bidirectional sync
 */
function toStepResult(result: any): SyncStepResult {
  return {
    success: !!result?.success,
    pushed: result?.pushed,
    pulled: result?.pulled,
    skipped: result?.skipped,
    received: result?.received,
    error: result?.error,
  }
}

function stepError(err: unknown): SyncStepResult {
  const message = err instanceof Error ? err.message : String(err)
  return { success: false, error: message }
}

export async function syncWithRelay(): Promise<RelaySyncResult> {
  if (inFlightSync) return inFlightSync

  inFlightSync = (async () => {
    const [
      pushHealth,
      pullHealth,
      pullMobileData,
      pushAll,
      pushSleepAnalysis,
      pullStravaStreams,
    ] = await Promise.all([
      pushHealthToRelay().then(toStepResult).catch(stepError),
      pullHealthFromRelay().then(toStepResult).catch(stepError),
      pullMobileDataFromRelay().then(toStepResult).catch(stepError),
      pushAllToRelay().then(toStepResult).catch(stepError),
      pushSleepAnalysisToRelay().then(toStepResult).catch(stepError),
      pullStravaStreamsFromRelay().then(toStepResult).catch(stepError),
    ])
    const steps = {
      pushHealth,
      pullHealth,
      pullMobileData,
      pushAll,
      pushSleepAnalysis,
      pullStravaStreams,
    }
    const success = Object.values(steps).every((step) => step.success)

    if (pushHealth.pushed || pullHealth.pulled) {
      console.log(`Relay sync: pushed ${pushHealth.pushed || 0}, pulled ${pullHealth.pulled || 0}`)
    }
    if (!success) {
      const failed = Object.entries(steps)
        .filter(([, step]) => !step.success)
        .map(([name, step]) => `${name}${step.error ? ` (${step.error})` : ''}`)
        .join(', ')
      console.warn(`[Sync] Relay sync completed with failures: ${failed}`)
    }

    return { success, steps }
  })().finally(() => {
    inFlightSync = null
  })

  return inFlightSync
}
