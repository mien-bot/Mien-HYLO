/**
 * Health sync service — pulls health data, sleep analysis, and prices
 * from the relay/desktop server and syncs into local SQLite database.
 */
import { DeviceEventEmitter } from 'react-native'
import { getDb } from '../lib/database'
import { getSecure, getSettings, setSecure } from '../lib/storage'
import type { FullSleepAnalysis } from './sleep-analysis.service'

export const SLEEP_UPDATED_EVENT = 'mien:sleep-updated'
const LAST_FULL_SYNC_KEY = 'relay:last-full-sync-at'

// ETag cache for sync efficiency — avoids re-downloading unchanged data
const etagCache = new Map<string, string>()

function noteSyncFailure(
  failures: Record<string, number>,
  errors: Record<string, string[]>,
  table: string,
  err: unknown,
): void {
  failures[table] = (failures[table] || 0) + 1
  if (!errors[table]) errors[table] = []
  if (errors[table].length < 3) {
    errors[table].push(err instanceof Error ? err.message : String(err))
  }
}

function parseJsonMaybe(value: string | null | undefined): any | null {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

function hasSleepTimes(value: any): boolean {
  return Boolean(value && (value.sleepStart || value.start || value.startDate) && (value.sleepEnd || value.end || value.endDate))
}

async function upsertHealthMetric(db: any, metricType: string, date: string, value: any, source: string): Promise<void> {
  let valueToStore = value
  if (metricType === 'sleep' && value && typeof value === 'object') {
    const existing = await db.getFirstAsync(
      `SELECT value_json FROM health_metrics WHERE metric_type = 'sleep' AND date = ?`,
      date
    ) as { value_json: string } | null
    const existingValue = parseJsonMaybe(existing?.value_json)
    if (existingValue && typeof existingValue === 'object') {
      valueToStore = {
        ...existingValue,
        ...value,
        sleepStart: value.sleepStart || value.start || value.startDate || existingValue.sleepStart || existingValue.start || existingValue.startDate || '',
        sleepEnd: value.sleepEnd || value.end || value.endDate || existingValue.sleepEnd || existingValue.end || existingValue.endDate || '',
      }
      if (!valueToStore.inBed && hasSleepTimes(valueToStore)) {
        const start = new Date(valueToStore.sleepStart)
        const end = new Date(valueToStore.sleepEnd)
        if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end > start) {
          valueToStore.inBed = Math.round((end.getTime() - start.getTime()) / 60000)
        }
      }
    }
  }

  const valueJson = typeof valueToStore === 'string' ? valueToStore : JSON.stringify(valueToStore)
  await db.runAsync(
    `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
     VALUES (?, ?, ?, ?)`,
    metricType, date, valueJson, source
  )
}

async function refreshRestaurantVisitSummaries(db: any, placeIds: Set<string>): Promise<void> {
  for (const placeId of placeIds) {
    const rows = await db.getAllAsync(
      'SELECT rating FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL AND rating IS NOT NULL',
      placeId
    ) as Array<{ rating: number }>
    const latest = await db.getFirstAsync(
      'SELECT visit_date FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL ORDER BY visit_date DESC LIMIT 1',
      placeId
    ) as { visit_date: string } | null
    const average = rows.length > 0
      ? Number((rows.reduce((sum, row) => sum + row.rating, 0) / rows.length).toFixed(1))
      : null

    await db.runAsync(
      `UPDATE saved_restaurants
       SET visited = CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
           visit_date = ?,
           personal_rating = ?
       WHERE place_id = ?`,
      latest?.visit_date || null,
      latest?.visit_date || null,
      average,
      placeId
    )
  }
}

async function getRelayConfig(): Promise<{ url: string; headers: Record<string, string> } | null> {
  const settings = await getSettings()
  const relayUrl = settings.relayUrl?.replace(/\/$/, '')
  if (!relayUrl) return null

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.relayToken) {
    headers['Authorization'] = `Bearer ${settings.relayToken}`
  }
  return { url: relayUrl, headers }
}

/**
 * Pull health data from relay server into local DB.
 * @param days Number of days to fetch (default 14 for quick refresh, use higher for initial/full sync)
 */
export async function syncFromRelay(days: number = 14): Promise<{
  success: boolean
  count?: number
  latestDate?: string
  error?: string
}> {
  const config = await getRelayConfig()
  if (!config) {
    return { success: false, error: 'No relay URL configured. Set it in Settings.' }
  }

  try {
    const healthUrl = `${config.url}/health/data?days=${days}`
    const fetchHeaders = { ...config.headers } as Record<string, string>
    const cachedEtag = etagCache.get(healthUrl)
    if (cachedEtag) fetchHeaders['If-None-Match'] = cachedEtag

    const res = await fetch(healthUrl, { headers: fetchHeaders })

    // 304 Not Modified — no new data
    if (res.status === 304) {
      return { success: true, count: 0 }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { success: false, error: `Relay returned ${res.status}: ${errText}` }
    }

    // Store ETag for next request
    const etag = res.headers.get('etag')
    if (etag) etagCache.set(healthUrl, etag)

    const data = await res.json()
    const metrics = data.metrics || []

    if (metrics.length === 0) {
      return { success: true, count: 0 }
    }

    const db = await getDb()
    let sleepSeen = false
    let latestSleepDate = ''

    // Use a transaction for dramatically faster bulk inserts on mobile
    await db.withTransactionAsync(async () => {
      for (const m of metrics) {
        if (!m.type || !m.date) continue
        const value = typeof m.value === 'string' ? parseJsonMaybe(m.value) ?? m.value : m.value
        await upsertHealthMetric(db, m.type, m.date, value, m.source || 'relay')
        if (m.type === 'sleep') {
          sleepSeen = true
          if (m.date > latestSleepDate) latestSleepDate = m.date
        }
      }
    })

    if (sleepSeen) DeviceEventEmitter.emit(SLEEP_UPDATED_EVENT)
    return { success: true, count: metrics.length, latestDate: latestSleepDate || undefined }
  } catch (err: any) {
    return { success: false, error: err.message || 'Connection failed' }
  }
}

/**
 * Fetch pre-computed sleep analysis from desktop server
 * Falls back to local computation if relay unavailable
 */
export async function fetchSleepAnalysisFromRelay(): Promise<{
  analysis: FullSleepAnalysis | null
  sleepNeedProfile: any | null
}> {
  const config = await getRelayConfig()
  if (!config) return { analysis: null, sleepNeedProfile: null }

  try {
    const sleepUrl = `${config.url}/sleep/analysis`
    const fetchHeaders = { ...config.headers } as Record<string, string>
    const cachedEtag = etagCache.get(sleepUrl)
    if (cachedEtag) fetchHeaders['If-None-Match'] = cachedEtag

    const res = await fetch(sleepUrl, { headers: fetchHeaders })

    if (res.status === 304) return { analysis: null, sleepNeedProfile: null }
    if (!res.ok) return { analysis: null, sleepNeedProfile: null }

    const etag = res.headers.get('etag')
    if (etag) etagCache.set(sleepUrl, etag)

    const data = await res.json()
    return {
      analysis: data.analysis || null,
      sleepNeedProfile: data.sleepNeedProfile || null,
    }
  } catch {
    return { analysis: null, sleepNeedProfile: null }
  }
}

/**
 * Fetch prices and watchlist from desktop server
 */
export async function fetchPricesFromRelay(): Promise<{
  watchlist: Array<{ symbol: string; type: string; name: string | null }>
  prices: Array<{ symbol: string; date: string; close: number; open: number; high: number; low: number; volume: number }>
} | null> {
  const config = await getRelayConfig()
  if (!config) return null

  try {
    const res = await fetch(`${config.url}/finance/prices`, { headers: config.headers })
    if (!res.ok) return null

    const data = await res.json()
    return { watchlist: data.watchlist || [], prices: data.prices || [] }
  } catch {
    return null
  }
}

/**
 * Clean up bad data on both relay server and local DB
 */
export async function cleanupBadData(): Promise<{ success: boolean; relayRemoved?: number; localRemoved?: number; detail?: any; error?: string }> {
  const db = await getDb()
  let relayRemoved = 0
  let detail: any = null

  // Clean relay server
  const config = await getRelayConfig()
  if (config) {
    try {
      const res = await fetch(`${config.url}/health/cleanup`, {
        method: 'POST',
        headers: config.headers,
      })
      if (res.ok) {
        const data = await res.json()
        relayRemoved = data.removed || 0
        detail = data.detail
      }
    } catch {}
  }

  // Clean local DB
  const localBefore = await db.getFirstAsync(
    `SELECT COUNT(*) as cnt FROM health_metrics`
  ) as any
  const beforeCount = localBefore?.cnt || 0

  // Remove bad HRV (>300ms or <=0)
  await db.runAsync(
    `DELETE FROM health_metrics WHERE metric_type = 'hrv' AND (
      CAST(json_extract(value_json, '$.qty') AS REAL) > 300 OR
      CAST(json_extract(value_json, '$.qty') AS REAL) <= 0
    )`
  )
  // Remove bad SpO2 (>100% or <50%)
  await db.runAsync(
    `DELETE FROM health_metrics WHERE metric_type = 'blood_oxygen' AND (
      CAST(json_extract(value_json, '$.qty') AS REAL) > 100 OR
      CAST(json_extract(value_json, '$.qty') AS REAL) < 50
    )`
  )
  // Remove bad HR (>220 or <=0)
  await db.runAsync(
    `DELETE FROM health_metrics WHERE metric_type = 'heart_rate' AND (
      CAST(json_extract(value_json, '$.qty') AS REAL) > 220 OR
      CAST(json_extract(value_json, '$.qty') AS REAL) <= 0
    )`
  )
  // Remove bad sleep (<=1min or >14h)
  await db.runAsync(
    `DELETE FROM health_metrics WHERE metric_type = 'sleep' AND (
      COALESCE(CAST(json_extract(value_json, '$.totalAsleep') AS REAL), CAST(json_extract(value_json, '$.asleep') AS REAL), 0) <= 1 OR
      COALESCE(CAST(json_extract(value_json, '$.totalAsleep') AS REAL), CAST(json_extract(value_json, '$.asleep') AS REAL), 0) > 840
    )`
  )

  const localAfter = await db.getFirstAsync(
    `SELECT COUNT(*) as cnt FROM health_metrics`
  ) as any
  const localRemoved = beforeCount - (localAfter?.cnt || 0)

  return { success: true, relayRemoved, localRemoved, detail }
}

/**
 * Push health data from mobile to desktop server (for Apple Watch data),
 * then immediately pull the relay's view back so the local DB reflects
 * whatever the server may have normalized (e.g. wake-date re-binning).
 */
/**
 * Fetch Strava stream data for a specific activity from relay
 */
export async function fetchStravaStream(activityId: number): Promise<{
  heartrate?: number[]
  velocity_smooth?: number[]
  cadence?: number[]
  altitude?: number[]
  grade_smooth?: number[]
  watts?: number[]
  time?: number[]
  distance?: number[]
} | null> {
  const config = await getRelayConfig()
  if (!config) return null

  try {
    const res = await fetch(`${config.url}/strava/streams/${activityId}`, { headers: config.headers })
    if (!res.ok) return null
    const data = await res.json()
    return data.streams || null
  } catch {
    return null
  }
}

/**
 * Fetch Strava stream metadata list (what's available) from relay
 */
export async function fetchStravaStreamList(days: number = 90): Promise<Array<{
  activityId: number
  date: string
  name: string
  fetchedAt: string
}>> {
  const config = await getRelayConfig()
  if (!config) return []

  try {
    const res = await fetch(`${config.url}/strava/streams?days=${days}&meta=1`, { headers: config.headers })
    if (!res.ok) return []
    const data = await res.json()
    return (data.streams || []).map((s: any) => ({
      activityId: s.activityId,
      date: s.date,
      name: s.name,
      fetchedAt: s.fetchedAt,
    }))
  } catch {
    return []
  }
}

export async function pushHealthToRelay(metrics: Array<{ type: string; date: string; value: any; source: string }>): Promise<boolean> {
  const config = await getRelayConfig()
  if (!config) return false

  let ok = false
  try {
    const res = await fetch(`${config.url}/health/sync`, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify({ metrics }),
    })
    ok = res.ok
  } catch {
    return false
  }

  if (!ok) return false

  // Pull the relay's last-2-day view back into local SQLite so the UI
  // reflects whatever was just pushed/normalized.
  let sleepSeen = metrics.some(m => m.type === 'sleep')
  try {
    const pullRes = await fetch(`${config.url}/health/data?days=2`, { headers: config.headers })
    if (pullRes.ok) {
      const data = await pullRes.json()
      const pulled = data.metrics || []
      if (pulled.length > 0) {
        const db = await getDb()
        for (const m of pulled) {
          const value = typeof m.value === 'string' ? parseJsonMaybe(m.value) ?? m.value : m.value
          try {
            await upsertHealthMetric(db, m.type, m.date, value, m.source || 'relay')
            if (m.type === 'sleep') sleepSeen = true
          } catch {}
        }
      }
    }
  } catch {}

  if (sleepSeen) DeviceEventEmitter.emit(SLEEP_UPDATED_EVENT)
  return true
}

/**
 * Full sync — pull all data from relay (watchlist, prices, news, briefings,
 * chat, weekend plans, schedules, restaurants) and merge into local DB.
 */
export async function fullSyncFromRelay(): Promise<{
  success: boolean
  tables: Record<string, number>
  failures?: Record<string, number>
  errors?: Record<string, string[]>
  error?: string
}> {
  const config = await getRelayConfig()
  if (!config) {
    return { success: false, tables: {}, error: 'No relay URL configured' }
  }

  try {
    const pullUrl = `${config.url}/sync/pull-all?includeHealth=false`
    const fetchHeaders = { ...config.headers } as Record<string, string>
    const cachedEtag = etagCache.get(pullUrl)
    if (cachedEtag) fetchHeaders['If-None-Match'] = cachedEtag

    const res = await fetch(pullUrl, { headers: fetchHeaders })

    // 304 Not Modified — relay data unchanged since last pull
    if (res.status === 304) {
      return { success: true, tables: {} }
    }

    if (!res.ok) {
      return { success: false, tables: {}, error: `Relay returned ${res.status}` }
    }

    // Store ETag for next request
    const etag = res.headers.get('etag')
    if (etag) etagCache.set(pullUrl, etag)

    const data = await res.json()
    // Don't bail if updated_at is missing — health data from HAE may still exist
    // even when the desktop has never pushed sync data
    const hasAnyData = data.updated_at || [
      'watchlist',
      'prices',
      'news',
      'briefings',
      'chat_messages',
      'weekend_plans',
      'weekend_event_cache',
      'daily_schedule',
      'saved_restaurants',
      'restaurant_visits',
      'holdings',
      'alerts',
      'health_alerts',
      'fundamentals',
    ].some(table => data[table]?.length > 0)
    if (!hasAnyData) {
      return { success: false, tables: {}, error: 'No data on relay yet.' }
    }

    const db = await getDb()
    const counts: Record<string, number> = {}
    const failures: Record<string, number> = {}
    const errors: Record<string, string[]> = {}
    let sleepSeen = false

    // Wrap all inserts in a single transaction for dramatically faster writes
    await db.withTransactionAsync(async () => {

    // Watchlist
    if (data.watchlist?.length > 0) {
      let n = 0
      for (const w of data.watchlist) {
        try {
          await db.runAsync(
            `INSERT OR IGNORE INTO watchlist (symbol, type, name, added_at) VALUES (?, ?, ?, ?)`,
            w.symbol, w.type, w.name, w.added_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'watchlist', err) }
      }
      counts.watchlist = n
    }

    // Price history
    if (data.prices?.length > 0) {
      let n = 0
      for (const p of data.prices) {
        try {
          await db.runAsync(
            `INSERT OR REPLACE INTO price_history (symbol, date, open, high, low, close, volume, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            p.symbol, p.date, p.open, p.high, p.low, p.close, p.volume, p.source || 'sync'
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'prices', err) }
      }
      counts.prices = n
    }

    // News
    if (data.news?.length > 0) {
      let n = 0
      for (const a of data.news) {
        try {
          await db.runAsync(
            `INSERT INTO news_articles
             (title, url, source, published_at, related_symbols, summary, content_context, transcript_status, transcript_source, transcript_fetched_at, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(url) DO UPDATE SET
               summary = COALESCE(excluded.summary, news_articles.summary),
               content_context = COALESCE(excluded.content_context, news_articles.content_context),
               transcript_status = COALESCE(excluded.transcript_status, news_articles.transcript_status),
               transcript_source = COALESCE(excluded.transcript_source, news_articles.transcript_source),
               transcript_fetched_at = COALESCE(excluded.transcript_fetched_at, news_articles.transcript_fetched_at)`,
            a.title, a.url, a.source, a.published_at, a.related_symbols || '[]',
            a.summary || null, a.content_context || null, a.transcript_status || null,
            a.transcript_source || null, a.transcript_fetched_at || null, a.fetched_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'news', err) }
      }
      counts.news = n
    }

    // Briefings — UPSERT by (type, date), keep newer created_at
    if (data.briefings?.length > 0) {
      let n = 0
      for (const b of data.briefings) {
        try {
          await db.runAsync(
            `INSERT INTO briefings (type, date, content, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(type, date) DO UPDATE SET
               content = excluded.content,
               created_at = excluded.created_at
             WHERE excluded.created_at > briefings.created_at`,
            b.type, b.date, b.content, b.created_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'briefings', err) }
      }
      counts.briefings = n
    }

    // Chat messages
    if (data.chat_messages?.length > 0) {
      let n = 0
      for (const m of data.chat_messages) {
        try {
          await db.runAsync(
            `INSERT OR IGNORE INTO chat_messages (role, content, conversation_id, created_at)
             VALUES (?, ?, ?, ?)`,
            m.role, m.content, m.conversation_id || 'default', m.created_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'chat', err) }
      }
      counts.chat = n
    }

    // Weekend plans
    if (data.weekend_plans?.length > 0) {
      let n = 0
      for (const wp of data.weekend_plans.filter((row: any) => !row.deleted_at)) {
        try {
          await db.runAsync(
            `INSERT OR REPLACE INTO weekend_plans (weekend_date, plan_json, events_json, ai_rationale, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            wp.weekend_date, wp.plan_json, wp.events_json, wp.ai_rationale, wp.created_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'weekend_plans', err) }
      }
      counts.weekend_plans = n
    }

    if (data.weekend_event_cache?.length > 0) {
      let n = 0
      for (const e of data.weekend_event_cache) {
        try {
          await db.runAsync(
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
            e.event_key, e.name, e.event_date || '', e.time || '', e.venue || '',
            e.address || '', e.city || '', e.type || 'other', e.price_range || '',
            e.url || '', e.image_url || null, e.description || '', e.source || 'sync',
            e.query || '', e.category || '', e.saved_at || new Date().toISOString(),
            e.updated_at || new Date().toISOString()
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'weekend_event_cache', err) }
      }
      counts.weekend_event_cache = n
    }

    // Daily schedule
    if (data.daily_schedule?.length > 0) {
      let n = 0
      for (const ds of data.daily_schedule.filter((row: any) => !row.deleted_at)) {
        try {
          await db.runAsync(
            `INSERT OR REPLACE INTO daily_schedule (date, schedule_json, ai_rationale, created_at)
             VALUES (?, ?, ?, ?)`,
            ds.date, ds.schedule_json, ds.ai_rationale, ds.created_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'daily_schedule', err) }
      }
      counts.daily_schedule = n
    }

    // Saved restaurants
    if (data.saved_restaurants?.length > 0) {
      let n = 0
      for (const r of data.saved_restaurants) {
        try {
          await db.runAsync(
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
            r.place_id, r.name, r.address || '', r.price_level, r.rating,
            r.cuisine || '', r.lat || 0, r.lng || 0, r.notes,
            r.booking_advance, r.venue_type || 'restaurant', r.cuisine_category,
            r.spice_level, r.reservation_link, r.peak_times, r.description,
            r.visited || 0, r.visit_date, r.personal_rating,
            r.booking_advance_days ?? null,
            typeof r.busy_days_matrix === 'string' ? r.busy_days_matrix
              : r.busy_days_matrix ? JSON.stringify(r.busy_days_matrix) : null,
            r.last_researched_at ?? null,
            r.updated_at || r.saved_at || new Date().toISOString()
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'restaurants', err) }
      }
      counts.restaurants = n
    }

    if (data.restaurant_visits?.length > 0) {
      let n = 0
      const affectedPlaceIds = new Set<string>()
      for (const v of data.restaurant_visits) {
        try {
          if (!v.place_id || !v.visit_date) continue
          await db.runAsync(
            `INSERT INTO restaurant_visits (place_id, visit_date, rating, notes, created_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(place_id, visit_date) DO UPDATE SET
               rating = excluded.rating,
               notes = excluded.notes,
               created_at = excluded.created_at,
               deleted_at = excluded.deleted_at
             WHERE restaurant_visits.created_at IS NULL
                OR excluded.created_at >= restaurant_visits.created_at`,
            v.place_id, v.visit_date, v.rating, v.notes, v.created_at || new Date().toISOString(), v.deleted_at || null
          )
          affectedPlaceIds.add(v.place_id)
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'restaurant_visits', err) }
      }
      await refreshRestaurantVisitSummaries(db, affectedPlaceIds)
      counts.restaurant_visits = n
    }

    // Health data
    if (data.health?.length > 0) {
      let n = 0
      for (const m of data.health) {
        const value = typeof m.value === 'string' ? parseJsonMaybe(m.value) ?? m.value : m.value
        try {
          await upsertHealthMetric(db, m.type, m.date, value, m.source || 'relay')
          n++
          if (m.type === 'sleep') sleepSeen = true
        } catch (err) { noteSyncFailure(failures, errors, 'health', err) }
      }
      counts.health = n
    }

    // Holdings (read-only mirror)
    if (Array.isArray(data.holdings)) {
      await db.runAsync('DELETE FROM holdings')
      let n = 0
      for (const h of data.holdings.filter((row: any) => !row.deleted_at)) {
        try {
          await db.runAsync(
            `INSERT OR REPLACE INTO holdings (id, symbol, quantity, cost_basis, acquired_at, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            h.id, h.symbol, h.quantity, h.cost_basis, h.acquired_at, h.notes, h.created_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'holdings', err) }
      }
      counts.holdings = n
    }

    // Alerts (read-only mirror)
    if (Array.isArray(data.alerts)) {
      await db.runAsync('DELETE FROM alerts')
      let n = 0
      for (const a of data.alerts.filter((row: any) => !row.deleted_at)) {
        try {
          await db.runAsync(
            `INSERT OR REPLACE INTO alerts (id, symbol, type, threshold, note, active, one_shot, last_fired_at, last_value, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            a.id, a.symbol, a.type, a.threshold, a.note, a.active, a.one_shot, a.last_fired_at, a.last_value, a.created_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'alerts', err) }
      }
      counts.alerts = n
    }

    if (Array.isArray(data.health_alerts)) {
      await db.runAsync('DELETE FROM health_alerts')
      let n = 0
      for (const a of data.health_alerts.filter((row: any) => !row.deleted_at)) {
        try {
          await db.runAsync(
            `INSERT OR REPLACE INTO health_alerts (id, type, threshold, note, active, one_shot, last_fired_at, last_value, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            a.id, a.type, a.threshold, a.note, a.active, a.one_shot, a.last_fired_at, a.last_value, a.created_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'health_alerts', err) }
      }
      counts.health_alerts = n
    }

    // Fundamentals
    if (Array.isArray(data.fundamentals)) {
      let n = 0
      for (const f of data.fundamentals) {
        try {
          await db.runAsync(
            `INSERT OR REPLACE INTO fundamentals
             (symbol, pe, pb, eps, revenue, market_cap, dividend_yield, sector, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            f.symbol, f.pe, f.pb, f.eps, f.revenue, f.market_cap, f.dividend_yield, f.sector, f.fetched_at
          )
          n++
        } catch (err) { noteSyncFailure(failures, errors, 'fundamentals', err) }
      }
      counts.fundamentals = n
    }

    }) // end transaction

    if (sleepSeen) DeviceEventEmitter.emit(SLEEP_UPDATED_EVENT)
    const hasFailures = Object.keys(failures).length > 0
    return {
      success: !hasFailures,
      tables: counts,
      failures: hasFailures ? failures : undefined,
      errors: hasFailures ? errors : undefined,
      error: hasFailures ? 'Some rows failed to sync' : undefined,
    }
  } catch (err: any) {
    return { success: false, tables: {}, error: err.message || 'Connection failed' }
  }
}

/**
 * Push mobile-only data back to relay (restaurants, chat)
 */
export async function pushMobileDataToRelay(): Promise<boolean> {
  const config = await getRelayConfig()
  if (!config) return false

  const db = await getDb()

  try {
    const saved_restaurants = await db.getAllAsync(
      `SELECT place_id, name, address, price_level, rating, cuisine, lat, lng, notes,
              booking_advance, venue_type, cuisine_category, spice_level,
              reservation_link, peak_times, description, visited, visit_date, personal_rating,
              booking_advance_days, busy_days_matrix, last_researched_at, updated_at
       FROM saved_restaurants ORDER BY saved_at DESC`
    )

    const restaurant_visits = await db.getAllAsync(
      `SELECT place_id, visit_date, rating, notes, created_at, deleted_at
       FROM restaurant_visits ORDER BY visit_date DESC`
    ).catch(() => [])

    const chat_messages = await db.getAllAsync(
      `SELECT role, content, conversation_id, created_at FROM chat_messages
       ORDER BY created_at DESC LIMIT 100`
    )

    const weekend_event_cache = await db.getAllAsync(
      `SELECT event_key, name, event_date, time, venue, address, city, type,
              price_range, url, image_url, description, source, query, category,
              saved_at, updated_at
       FROM weekend_event_cache
       WHERE updated_at >= datetime('now', '-90 days')
       ORDER BY updated_at DESC`
    ).catch(() => [])

    const daily_schedule = await db.getAllAsync(
      `SELECT date, schedule_json, ai_rationale, created_at FROM daily_schedule
       WHERE date >= date('now', '-14 days')
       ORDER BY date DESC`
    ).catch(() => [])

    // Weekend plans generated on the phone — push so the desktop picks them up.
    // created_at is sent as-is: both mobile (this column's datetime('now') default)
    // and desktop (weekend_plans.updated_at, also datetime('now')) use SQLite's
    // "YYYY-MM-DD HH:MM:SS" format, so they string-compare correctly in the
    // version-merge on the relay and on the desktop upsert. Do NOT reformat to ISO
    // here — that would make every phone plan sort newer than desktop plans.
    const weekend_plans = await db.getAllAsync(
      `SELECT weekend_date, plan_json, events_json, ai_rationale, created_at
       FROM weekend_plans
       WHERE weekend_date >= date('now', '-30 days')
       ORDER BY weekend_date DESC`
    ).catch(() => [])

    const res = await fetch(`${config.url}/sync/push-mobile`, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify({ saved_restaurants, restaurant_visits, chat_messages, weekend_event_cache, daily_schedule, weekend_plans }),
    })

    return res.ok
  } catch {
    return false
  }
}

/**
 * App-level sync for normal mobile use. Health is refreshed frequently while
 * full app data and mobile writes are synced on a slower throttle.
 */
export async function seamlessSyncFromRelay(options: {
  forceFull?: boolean
  healthDays?: number
  fullEveryMs?: number
} = {}): Promise<{
  success: boolean
  health: Awaited<ReturnType<typeof syncFromRelay>>
  full?: Awaited<ReturnType<typeof fullSyncFromRelay>>
  pushedMobile?: boolean
  error?: string
}> {
  // On first sync (no data), pull all history; otherwise 14 days
  let healthDays = options.healthDays ?? 14
  if (!options.healthDays) {
    try {
      const db = await (await import('../lib/database')).getDb()
      const row = await db.getFirstAsync('SELECT COUNT(*) as n FROM health_metrics') as { n: number } | null
      if ((row?.n ?? 0) === 0) healthDays = 3650
    } catch {}
  }
  const health = await syncFromRelay(healthDays)
  const fullEveryMs = options.fullEveryMs ?? 30 * 60_000

  let shouldFull = !!options.forceFull
  if (!shouldFull) {
    const lastFull = Number(await getSecure(LAST_FULL_SYNC_KEY)) || 0
    shouldFull = Date.now() - lastFull >= fullEveryMs
  }

  if (!shouldFull) {
    return { success: health.success, health, error: health.error }
  }

  const pushedMobile = await pushMobileDataToRelay()
  const full = await fullSyncFromRelay()
  if (full.success) {
    await setSecure(LAST_FULL_SYNC_KEY, String(Date.now()))
  }

  return {
    success: health.success && full.success,
    health,
    full,
    pushedMobile,
    error: full.error || health.error,
  }
}
