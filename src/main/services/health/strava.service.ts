/**
 * Strava Integration Service
 *
 * OAuth2 flow + activity syncing. Fetches workouts from Strava API
 * and stores them in health_metrics table as 'workout' type.
 */

import { BrowserWindow, shell } from 'electron'
import http from 'http'
import { getDb } from '../../db/database'
import store from '../../lib/store'
import { mergeWorkouts, isStravaWorkout } from './workout-merge'
import { getAppSettings } from '../../lib/settings'

// --- Types ---

interface StravaTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // unix timestamp
  athleteId: number
  athleteName: string
}

interface StravaActivity {
  id: number
  name: string
  type: string
  sport_type: string
  start_date: string
  start_date_local: string
  elapsed_time: number // seconds
  moving_time: number // seconds
  distance: number // meters
  total_elevation_gain: number
  average_heartrate?: number
  max_heartrate?: number
  average_speed?: number
  max_speed?: number
  kilojoules?: number
  calories?: number
  suffer_score?: number
  average_cadence?: number
  average_watts?: number
  weighted_average_watts?: number
  has_heartrate: boolean
  elev_high?: number
  elev_low?: number
}

const STRAVA_API = 'https://www.strava.com/api/v3'
const STRAVA_AUTH = 'https://www.strava.com/oauth/authorize'
const STRAVA_TOKEN = 'https://www.strava.com/oauth/token'
const CALLBACK_PORT = 19877
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`

// --- Token Management ---

function getTokens(): StravaTokens | null {
  const tokens = store.get('stravaTokens') as StravaTokens | undefined
  return tokens || null
}

function saveTokens(tokens: StravaTokens): void {
  store.set('stravaTokens', tokens)
}

function clearTokens(): void {
  store.delete('stravaTokens')
}

async function ensureValidToken(): Promise<string> {
  const tokens = getTokens()
  if (!tokens) throw new Error('Strava not connected')

  // Refresh if expired (with 60s buffer)
  if (Date.now() / 1000 > tokens.expiresAt - 60) {
    const clientId = getAppSettings()?.stravaClientId
    const clientSecret = getAppSettings()?.stravaClientSecret
    if (!clientId || !clientSecret) throw new Error('Strava client ID/secret not configured')

    const res = await fetch(STRAVA_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      clearTokens()
      throw new Error(`Token refresh failed: ${text}`)
    }

    const data = await res.json()
    saveTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      athleteId: tokens.athleteId,
      athleteName: tokens.athleteName,
    })
    return data.access_token
  }

  return tokens.accessToken
}

// --- OAuth Flow ---

export async function startStravaAuth(): Promise<{
  success: boolean
  athlete?: string
  error?: string
}> {
  const settings = getAppSettings()
  const clientId = settings?.stravaClientId
  const clientSecret = settings?.stravaClientSecret

  if (!clientId || !clientSecret) {
    return { success: false, error: 'Set Strava Client ID and Client Secret in Settings first' }
  }

  return new Promise((resolve) => {
    let callbackServer: http.Server | null = null
    let resolved = false

    const cleanup = () => {
      if (callbackServer) {
        callbackServer.close()
        callbackServer = null
      }
    }

    const finish = (result: { success: boolean; athlete?: string; error?: string }) => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    // Timeout after 2 minutes
    setTimeout(() => finish({ success: false, error: 'OAuth timed out' }), 120_000)

    callbackServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`)

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')

        if (error || !code) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            '<html><body><h2>Strava authorization denied.</h2><p>You can close this tab.</p></body></html>',
          )
          finish({ success: false, error: error || 'No authorization code received' })
          return
        }

        try {
          // Exchange code for tokens
          const tokenRes = await fetch(STRAVA_TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              grant_type: 'authorization_code',
            }),
          })

          if (!tokenRes.ok) {
            const text = await tokenRes.text()
            throw new Error(`Token exchange failed: ${text}`)
          }

          const data = await tokenRes.json()
          const athleteName =
            `${data.athlete?.firstname || ''} ${data.athlete?.lastname || ''}`.trim()

          saveTokens({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: data.expires_at,
            athleteId: data.athlete?.id,
            athleteName,
          })

          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            `<html><body><h2>Connected to Strava!</h2><p>Welcome ${athleteName}. You can close this tab.</p></body></html>`,
          )
          finish({ success: true, athlete: athleteName })
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(`<html><body><h2>Error</h2><p>${err.message}</p></body></html>`)
          finish({ success: false, error: err.message })
        }
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    callbackServer.listen(CALLBACK_PORT, () => {
      const authUrl = `${STRAVA_AUTH}?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=read,activity:read&approval_prompt=auto`
      shell.openExternal(authUrl)
    })

    callbackServer.on('error', (err) => {
      finish({ success: false, error: `Callback server error: ${err.message}` })
    })
  })
}

export function disconnectStrava(): void {
  clearTokens()
}

export function getStravaStatus(): { connected: boolean; athlete?: string; athleteId?: number } {
  const tokens = getTokens()
  if (!tokens) return { connected: false }
  return { connected: true, athlete: tokens.athleteName, athleteId: tokens.athleteId }
}

// --- Activity Fetching ---

async function fetchActivities(after?: number, page = 1, perPage = 100): Promise<StravaActivity[]> {
  const token = await ensureValidToken()
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  })
  if (after) params.set('after', String(after))

  const res = await fetch(`${STRAVA_API}/athlete/activities?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    if (res.status === 401) {
      clearTokens()
      throw new Error('Strava session expired — please reconnect')
    }
    throw new Error(`Strava API error: ${res.status} ${res.statusText}`)
  }

  return res.json()
}

function stravaActivityToWorkout(activity: StravaActivity) {
  const durationMin = Math.round(activity.moving_time / 60)
  const distanceMi = parseFloat((activity.distance * 0.000621371).toFixed(2))

  // Strava may provide calories or kilojoules
  let calories = 0
  if (activity.calories) {
    calories = Math.round(activity.calories)
  } else if (activity.kilojoules) {
    calories = Math.round(activity.kilojoules) // kJ ~= kcal for cycling
  }

  return {
    name: activity.type || activity.sport_type || 'Unknown',
    duration: durationMin,
    calories,
    distance: distanceMi,
    stepCount: 0,
    avgHR: activity.average_heartrate || 0,
    maxHR: activity.max_heartrate || 0,
    start: activity.start_date,
    end: new Date(
      new Date(activity.start_date).getTime() + activity.elapsed_time * 1000,
    ).toISOString(),
    source: 'Strava',
    // Extra Strava fields for richer analysis
    stravaId: activity.id,
    sportType: activity.sport_type,
    elevationGain: activity.total_elevation_gain || 0,
    avgSpeed: activity.average_speed || 0,
    sufferScore: activity.suffer_score || 0,
    avgCadence: activity.average_cadence || 0,
    avgWatts: activity.average_watts || 0,
    normalizedPower: activity.weighted_average_watts || 0,
  }
}

function extractDate(isoStr: string): string {
  return isoStr.slice(0, 10)
}

// --- Sync ---

export async function syncStravaActivities(days = 90): Promise<{ synced: number; total: number }> {
  const tokens = getTokens()
  if (!tokens) throw new Error('Strava not connected')

  const db = getDb()
  const after = Math.floor(Date.now() / 1000) - days * 86400

  // Fetch all activities in the range (paginate)
  const allActivities: StravaActivity[] = []
  let page = 1
  while (true) {
    const batch = await fetchActivities(after, page, 100)
    if (batch.length === 0) break
    allActivities.push(...batch)
    if (batch.length < 100) break
    page++
  }

  if (allActivities.length === 0) return { synced: 0, total: 0 }

  // Group by date
  const byDate = new Map<string, any[]>()
  for (const activity of allActivities) {
    const workout = stravaActivityToWorkout(activity)
    const dateStr = extractDate(activity.start_date_local || activity.start_date)
    if (!byDate.has(dateStr)) byDate.set(dateStr, [])
    byDate.get(dateStr)!.push(workout)
  }

  // Store in health_metrics. Strava takes precedence for matching workouts,
  // while Health Auto Export can still contribute non-Strava activities.
  const insert = db.prepare(`
    INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
    VALUES ('workout', ?, ?, ?)
  `)
  const selectExisting = db.prepare(`
    SELECT value_json FROM health_metrics
    WHERE metric_type = 'workout' AND date = ?
  `)

  const tx = db.transaction(() => {
    let count = 0
    for (const [dateStr, workouts] of byDate) {
      let existingWorkouts: any[] = []
      try {
        const existing = selectExisting.get(dateStr) as { value_json: string } | undefined
        const parsed = existing ? JSON.parse(existing.value_json) : null
        existingWorkouts = Array.isArray(parsed?.workouts) ? parsed.workouts : []
      } catch {}

      const merged = mergeWorkouts(existingWorkouts, workouts)
      const hasNonStrava = merged.some((w) => !isStravaWorkout(w))
      insert.run(dateStr, JSON.stringify({ workouts: merged }), hasNonStrava ? 'mixed' : 'strava')
      count++
    }
    return count
  })

  const synced = tx()
  console.log(`Strava sync: ${allActivities.length} activities across ${synced} days`)

  return { synced, total: allActivities.length }
}

export async function syncAllStravaHistory(): Promise<{ synced: number; total: number }> {
  // Sync all history (up to ~10 years)
  return syncStravaActivities(3650)
}

// --- Activity Streams (second-by-second data) ---

export interface StravaStream {
  time: number[]
  distance: number[]
  heartrate: number[]
  altitude: number[]
  velocity_smooth: number[]
  cadence: number[]
  watts: number[]
  temp: number[]
  moving: boolean[]
  grade_smooth: number[]
  latlng: Array<[number, number]>
}

async function fetchActivityStreams(activityId: number): Promise<Partial<StravaStream>> {
  const token = await ensureValidToken()
  const keys =
    'time,latlng,distance,altitude,velocity_smooth,heartrate,cadence,watts,temp,moving,grade_smooth'
  const res = await fetch(
    `${STRAVA_API}/activities/${activityId}/streams?keys=${keys}&key_by_type=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  )

  if (!res.ok) {
    if (res.status === 401) {
      clearTokens()
      throw new Error('Strava session expired')
    }
    if (res.status === 404) return {} // activity might not have streams
    throw new Error(`Strava streams API: ${res.status}`)
  }

  const data = await res.json()
  const result: Partial<StravaStream> = {}
  if (Array.isArray(data)) {
    for (const stream of data) {
      if (stream.type && stream.data) {
        ;(result as Record<string, unknown>)[stream.type] = stream.data
      }
    }
  } else {
    for (const [key, stream] of Object.entries(data)) {
      ;(result as Record<string, unknown>)[key] =
        (stream as Record<string, unknown>)?.data ?? stream
    }
  }
  return result
}

/**
 * Fetch and store streams for recent activities that don't have them yet.
 * Rate-limited: fetches at most `limit` activities per call.
 */
export async function syncStravaStreams(
  days = 90,
  limit = 30,
): Promise<{ fetched: number; skipped: number }> {
  const tokens = getTokens()
  if (!tokens) throw new Error('Strava not connected')

  const db = getDb()

  // Ensure streams table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS strava_streams (
      activity_id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      workout_name TEXT,
      streams_json TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Get activities we already have streams for
  const existing = new Set(
    db
      .prepare('SELECT activity_id FROM strava_streams')
      .all()
      .map((r: any) => r.activity_id),
  )

  // Get recent workout data to find Strava IDs
  const after = new Date()
  after.setDate(after.getDate() - days)
  const afterStr = after.toISOString().slice(0, 10)

  const workoutRows = db
    .prepare(
      `SELECT date, value_json FROM health_metrics WHERE metric_type = 'workout' AND date >= ? ORDER BY date DESC`,
    )
    .all(afterStr) as Array<{ date: string; value_json: string }>

  const toFetch: Array<{ activityId: number; date: string; name: string }> = []
  for (const row of workoutRows) {
    const val = JSON.parse(row.value_json)
    for (const w of val.workouts || []) {
      if (w.stravaId && !existing.has(w.stravaId)) {
        toFetch.push({ activityId: w.stravaId, date: row.date, name: w.name })
      }
    }
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO strava_streams (activity_id, date, workout_name, streams_json)
    VALUES (?, ?, ?, ?)
  `)

  let fetched = 0
  const toProcess = toFetch.slice(0, limit)
  for (const item of toProcess) {
    try {
      const streams = await fetchActivityStreams(item.activityId)
      if (Object.keys(streams).length > 0) {
        insert.run(item.activityId, item.date, item.name, JSON.stringify(streams))
        fetched++
      }
      // Small delay to respect rate limits
      if (fetched < toProcess.length) {
        await new Promise((r) => setTimeout(r, 200))
      }
    } catch (err) {
      console.warn(`Failed to fetch streams for activity ${item.activityId}:`, err)
    }
  }

  console.log(`Strava streams: fetched ${fetched}, skipped ${toFetch.length - toProcess.length}`)
  return { fetched, skipped: toFetch.length - toProcess.length }
}

/**
 * Get stored streams for an activity
 */
export function getActivityStreams(activityId: number): Partial<StravaStream> | null {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS strava_streams (
      activity_id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      workout_name TEXT,
      streams_json TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    )
  `)
  const row = db
    .prepare('SELECT streams_json FROM strava_streams WHERE activity_id = ?')
    .get(activityId) as { streams_json: string } | undefined
  if (!row) return null
  return JSON.parse(row.streams_json)
}

/**
 * Get all stored streams for a date range
 */
export function getAllStreams(
  days = 90,
): Array<{ activityId: number; date: string; name: string; streams: Partial<StravaStream> }> {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS strava_streams (
      activity_id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      workout_name TEXT,
      streams_json TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    )
  `)
  const after = new Date()
  after.setDate(after.getDate() - days)
  const afterStr = after.toISOString().slice(0, 10)

  const rows = db
    .prepare(
      'SELECT activity_id, date, workout_name, streams_json FROM strava_streams WHERE date >= ? ORDER BY date DESC',
    )
    .all(afterStr) as Array<{
    activity_id: number
    date: string
    workout_name: string
    streams_json: string
  }>

  return rows.map((r) => ({
    activityId: r.activity_id,
    date: r.date,
    name: r.workout_name || 'Unknown',
    streams: JSON.parse(r.streams_json),
  }))
}
