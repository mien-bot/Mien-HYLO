/**
 * Mien Relay Server
 *
 * Secure relay for cross-network use. Supports:
 *   - Bearer token auth (auto-generated on first run, stored in relay.key)
 *   - Rate limiting (prevents abuse if exposed)
 *   - Cloudflare Tunnel integration (one command for public HTTPS)
 *   - Claude API key or CLI OAuth (auto-detected)
 *   - OpenAI / Codex API key
 *
 * Usage:
 *   # First run generates a secret key:
 *   node server.js
 *
 *   # With Claude API key:
 *   ANTHROPIC_API_KEY=sk-ant-... node server.js
 *
 *   # With Cloudflare Tunnel (public HTTPS, no port forwarding):
 *   TUNNEL=1 node server.js
 *
 *   # Custom port:
 *   PORT=4000 node server.js
 *
 *   # Disable auth (local network only, NOT recommended for remote):
 *   AUTH=off node server.js
 */

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync, spawn } from 'node:child_process'
import { mergeSleepEntry } from './lib/sleep-merge.js'

// Load .env from relay directory if present
const __envDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
const __envPath = path.join(__envDir, '.env')
if (fs.existsSync(__envPath)) {
  for (const line of fs.readFileSync(__envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const PORT = parseInt(process.env.PORT || '3456')
const AI_PROVIDER = process.env.AI_PROVIDER || 'anthropic'
const AUTH_DISABLED = process.env.AUTH === 'off'
const TUNNEL_ENABLED = process.env.TUNNEL === '1'

if (AUTH_DISABLED && TUNNEL_ENABLED) {
  console.error('Refusing to start: AUTH=off cannot be combined with TUNNEL=1.')
  console.error('Enable bearer auth or disable the public tunnel before starting the relay.')
  process.exit(1)
}

// --- Base directory (handles Windows paths) ---
const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
const RELAY_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'))
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
})()
const RELAY_COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim()
  } catch {
    return null
  }
})()

// --- Tunnel URL persistence ---

const TUNNEL_URL_PATH = path.join(__dirname, 'tunnel-url.txt')
let currentTunnelUrl = null
let tunnelStartedAt = null

// CLI helper so the user can grab the URL without scrolling stderr.
if (process.argv.includes('--print-tunnel-url')) {
  try {
    const url = fs.readFileSync(TUNNEL_URL_PATH, 'utf-8').trim()
    if (!url) {
      process.stderr.write('Tunnel URL not available yet — cloudflared has not issued one.\n')
      process.exit(1)
    }
    console.log(url)
    process.exit(0)
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stderr.write(`No ${TUNNEL_URL_PATH} — start the relay with TUNNEL=1 first.\n`)
    } else {
      process.stderr.write(`Failed to read tunnel URL: ${err.message}\n`)
    }
    process.exit(1)
  }
}

// --- Auth: Bearer Token ---

const KEY_PATH = path.join(__dirname, 'relay.key')
let AUTH_TOKEN = ''

function initAuth() {
  if (AUTH_DISABLED) {
    console.log('  Auth:      DISABLED (local network mode)')
    return
  }

  if (fs.existsSync(KEY_PATH)) {
    AUTH_TOKEN = fs.readFileSync(KEY_PATH, 'utf-8').trim()
  }

  if (AUTH_TOKEN.length < 32) {
    // Generate a secure random token on first run
    AUTH_TOKEN = crypto.randomBytes(32).toString('base64url')
    fs.writeFileSync(KEY_PATH, AUTH_TOKEN, { mode: 0o600 })
    console.log('')
    console.log('  ========================================')
    console.log('  NEW AUTH TOKEN GENERATED')
    console.log('  ========================================')
    console.log(`  Token: ${AUTH_TOKEN}`)
    console.log(`  Saved: ${KEY_PATH}`)
    console.log('')
    console.log('  Add this to your phone\'s Mien Settings:')
    console.log(`  Relay Token: ${AUTH_TOKEN}`)
    console.log('  ========================================')
    console.log('')
  }
}

function checkAuth(req, res) {
  if (AUTH_DISABLED) return true

  const authHeader = req.headers['authorization']
  if (!authHeader) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Missing Authorization header. Use: Bearer <your-relay-token>' } }))
    return false
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1] || ''
  const tokenBytes = Buffer.from(token)
  const expectedBytes = Buffer.from(AUTH_TOKEN)
  const valid =
    tokenBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(tokenBytes, expectedBytes)
  if (!valid) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Invalid token. Check relay.key on the server.' } }))
    return false
  }

  return true
}

// --- Rate Limiting ---

const rateLimits = new Map() // ip -> { count, resetTime }
const RATE_LIMIT = 200 // requests per minute
const RATE_WINDOW = 60 * 1000 // 1 minute
const DEFAULT_JSON_BODY_LIMIT = 10 * 1024 * 1024
const LARGE_JSON_BODY_LIMIT = 25 * 1024 * 1024

function checkRateLimit(req, res) {
  const ip = req.socket.remoteAddress || 'unknown'
  const now = Date.now()

  let entry = rateLimits.get(ip)
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + RATE_WINDOW }
    rateLimits.set(ip, entry)
  }

  entry.count++
  if (entry.count > RATE_LIMIT) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Rate limited. Try again in a minute.' } }))
    return false
  }

  return true
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req, res, maxBytes = DEFAULT_JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    let tooLarge = false

    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        tooLarge = true
        sendJson(res, 413, { error: `Payload too large. Limit is ${maxBytes} bytes.` })
        req.destroy()
        reject(new Error('Payload too large'))
        return
      }
      body += chunk
    })

    req.on('end', () => {
      if (tooLarge) return
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (err) {
        reject(err)
      }
    })

    req.on('error', err => {
      if (!tooLarge) reject(err)
    })
  })
}

function writeJsonAtomic(filePath, data, pretty = false) {
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, pretty ? 2 : 0))
  fs.renameSync(tmpPath, filePath)
}

let dataWriteQueue = Promise.resolve()

async function withDataWriteLock(fn) {
  const previous = dataWriteQueue
  let release
  dataWriteQueue = new Promise(resolve => { release = resolve })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetTime) rateLimits.delete(ip)
  }
}, 5 * 60 * 1000)

// --- Health Data Storage ---

const HEALTH_DATA_PATH = path.join(__dirname, 'health-data.json')
const SLEEP_ANALYSIS_PATH = path.join(__dirname, 'sleep-analysis.json')

let healthData = { metrics: [] }
let cachedSleepAnalysis = null // pushed by desktop, served to mobile
let cachedSleepNeedProfile = null // pushed by desktop alongside analysis

// --- Content hashing for sync efficiency (ETag support) ---
// Tracks when data last changed so clients can skip redundant pulls
let healthDataHash = ''
let syncDataHash = ''
let sleepAnalysisHash = ''

function computeHash(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex').slice(0, 16)
}

function updateHealthDataHash() {
  healthDataHash = computeHash({
    count: healthData.metrics.length,
    metrics: healthData.metrics.map(m => ({
      type: m.type,
      date: m.date,
      source: m.source || '',
      synced_at: m.synced_at || '',
      value: m.value,
    })),
  })
}

function updateSyncDataHash() {
  syncDataHash = computeHash({ updated_at: syncData.updated_at, counts: Object.fromEntries(Object.entries(syncData).filter(([k]) => k !== 'updated_at').map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])) })
}

function updateSleepAnalysisHash() {
  sleepAnalysisHash = computeHash({ analysis: cachedSleepAnalysis, profile: cachedSleepNeedProfile })
}

// Check If-None-Match header; returns true if client already has current data (304 sent)
function handleETag(req, res, etag) {
  const clientEtag = req.headers['if-none-match']
  if (clientEtag && clientEtag === etag) {
    res.writeHead(304, { 'ETag': etag, 'Access-Control-Allow-Origin': '*' })
    res.end()
    return true
  }
  return false
}

function loadHealthData() {
  try {
    if (fs.existsSync(HEALTH_DATA_PATH)) {
      healthData = JSON.parse(fs.readFileSync(HEALTH_DATA_PATH, 'utf-8'))
    }
  } catch {}
}

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

function pad2(n) { return n < 10 ? `0${n}` : String(n) }

function localDateOf(timestamp) {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp)
  if (isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function sleepStartOf(value) {
  return value && (value.sleepStart || value.start || value.startDate || '')
}

function sleepEndOf(value) {
  return value && (value.sleepEnd || value.end || value.endDate || '')
}

function mergeSleepMetric(existing, incoming) {
  const existingValue = existing && typeof existing.value === 'string' ? safeParse(existing.value) : existing?.value
  const incomingValue = incoming && typeof incoming.value === 'string' ? safeParse(incoming.value) : incoming?.value
  if (!incomingValue || typeof incomingValue !== 'object') return incoming
  if (!existingValue || typeof existingValue !== 'object') return { ...incoming, value: incomingValue }

  const value = {
    ...existingValue,
    ...incomingValue,
    sleepStart: sleepStartOf(incomingValue) || sleepStartOf(existingValue),
    sleepEnd: sleepEndOf(incomingValue) || sleepEndOf(existingValue),
  }

  if (!value.inBed && sleepStartOf(value) && sleepEndOf(value)) {
    const ms = new Date(sleepEndOf(value)).getTime() - new Date(sleepStartOf(value)).getTime()
    if (ms > 0) value.inBed = Math.round(ms / 60000)
  }

  return { ...existing, ...incoming, value }
}

function upsertHealthMetric(metric, syncedAt = new Date().toISOString()) {
  const idx = healthData.metrics.findIndex(existing => existing.type === metric.type && existing.date === metric.date)
  const next = metric.type === 'sleep' && idx >= 0
    ? mergeSleepMetric(healthData.metrics[idx], metric)
    : metric
  if (idx >= 0) healthData.metrics[idx] = { ...next, synced_at: syncedAt }
  else healthData.metrics.push({ ...next, synced_at: syncedAt })
}

function saveHealthData() {
  try {
    writeJsonAtomic(HEALTH_DATA_PATH, healthData, true)
    updateHealthDataHash()
  } catch (err) {
    console.error('Failed to save health data:', err.message)
  }
}

loadHealthData()
updateHealthDataHash()

function loadSleepAnalysisCache() {
  try {
    if (!fs.existsSync(SLEEP_ANALYSIS_PATH)) return
    const parsed = JSON.parse(fs.readFileSync(SLEEP_ANALYSIS_PATH, 'utf-8'))
    cachedSleepAnalysis = parsed.analysis || null
    cachedSleepNeedProfile = parsed.sleepNeedProfile || null
    updateSleepAnalysisHash()
  } catch (err) {
    console.error('Failed to load sleep analysis cache:', err.message)
  }
}

function saveSleepAnalysisCache() {
  try {
    fs.writeFileSync(SLEEP_ANALYSIS_PATH, JSON.stringify({
      analysis: cachedSleepAnalysis,
      sleepNeedProfile: cachedSleepNeedProfile,
      updated_at: new Date().toISOString(),
    }, null, 2))
    updateSleepAnalysisHash()
  } catch (err) {
    console.error('Failed to save sleep analysis cache:', err.message)
  }
}

loadSleepAnalysisCache()

// --- Strava Streams Storage ---
// Stores raw second-by-second stream data keyed by activity ID.
// Format: { [activityId]: { date, name, streams, fetchedAt } }

const STRAVA_STREAMS_PATH = path.join(__dirname, 'strava-streams.json')
const STRAVA_ACTIVITY_DETAILS_PATH = path.join(__dirname, 'strava-activity-details.json')

let stravaStreamsStore = {} // { [activityId]: { date, name, streams, fetchedAt } }
let stravaActivityDetailsStore = {} // { [activityId]: { date, name, detail, fetchedAt } }

const STRAVA_STORE_LIMIT = 200
const STRAVA_STORE_TTL_DAYS = 90

function pruneStravaStore(store) {
  const cutoff = Date.now() - STRAVA_STORE_TTL_DAYS * 24 * 60 * 60 * 1000
  return Object.fromEntries(
    Object.entries(store || {})
      .filter(([, entry]) => {
        const stamp = new Date(entry?.date || entry?.fetchedAt || 0).getTime()
        return !Number.isNaN(stamp) && stamp >= cutoff
      })
      .sort(([, a], [, b]) => {
        const aStamp = new Date(a?.date || a?.fetchedAt || 0).getTime()
        const bStamp = new Date(b?.date || b?.fetchedAt || 0).getTime()
        return bStamp - aStamp
      })
      .slice(0, STRAVA_STORE_LIMIT),
  )
}

function loadStravaStreams() {
  try {
    if (fs.existsSync(STRAVA_STREAMS_PATH)) {
      stravaStreamsStore = JSON.parse(fs.readFileSync(STRAVA_STREAMS_PATH, 'utf-8'))
    }
  } catch (err) {
    console.error('Failed to load Strava streams:', err.message)
  }
}

function saveStravaStreams() {
  try {
    stravaStreamsStore = pruneStravaStore(stravaStreamsStore)
    fs.writeFileSync(STRAVA_STREAMS_PATH, JSON.stringify(stravaStreamsStore))
  } catch (err) {
    console.error('Failed to save Strava streams:', err.message)
  }
}

function loadStravaActivityDetails() {
  try {
    if (fs.existsSync(STRAVA_ACTIVITY_DETAILS_PATH)) {
      stravaActivityDetailsStore = JSON.parse(fs.readFileSync(STRAVA_ACTIVITY_DETAILS_PATH, 'utf-8'))
    }
  } catch (err) {
    console.error('Failed to load Strava activity details:', err.message)
  }
}

function saveStravaActivityDetails() {
  try {
    stravaActivityDetailsStore = pruneStravaStore(stravaActivityDetailsStore)
    fs.writeFileSync(STRAVA_ACTIVITY_DETAILS_PATH, JSON.stringify(stravaActivityDetailsStore))
  } catch (err) {
    console.error('Failed to save Strava activity details:', err.message)
  }
}

loadStravaStreams()
loadStravaActivityDetails()
console.log(`  Strava streams: ${Object.keys(stravaStreamsStore).length} activities stored`)
console.log(`  Strava activity details: ${Object.keys(stravaActivityDetailsStore).length} activities stored`)

// --- Strava Integration ---

const STRAVA_TOKENS_PATH = path.join(__dirname, 'strava-tokens.json')
const STRAVA_API = 'https://www.strava.com/api/v3'
const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize'
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token'

let stravaTokens = null // { accessToken, refreshToken, expiresAt, athleteId, athleteName, clientId, clientSecret }

function loadStravaTokens() {
  try {
    if (fs.existsSync(STRAVA_TOKENS_PATH)) {
      stravaTokens = JSON.parse(fs.readFileSync(STRAVA_TOKENS_PATH, 'utf-8'))
    }
  } catch {}
}

function saveStravaTokens() {
  try {
    fs.writeFileSync(STRAVA_TOKENS_PATH, JSON.stringify(stravaTokens, null, 2), { mode: 0o600 })
  } catch (err) {
    console.error('Failed to save Strava tokens:', err.message)
  }
}

loadStravaTokens()

const STRAVA_CONFIG_PATH = path.join(__dirname, 'strava-config.json')

function loadStravaConfig() {
  // Check env vars first
  if (process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET) {
    return { clientId: process.env.STRAVA_CLIENT_ID, clientSecret: process.env.STRAVA_CLIENT_SECRET }
  }
  // Fall back to saved config
  try {
    if (fs.existsSync(STRAVA_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(STRAVA_CONFIG_PATH, 'utf-8'))
    }
  } catch {}
  // Fall back to tokens file (has client creds embedded)
  if (stravaTokens?.clientId && stravaTokens?.clientSecret) {
    return { clientId: stravaTokens.clientId, clientSecret: stravaTokens.clientSecret }
  }
  return null
}

function saveStravaConfig(config) {
  try {
    fs.writeFileSync(STRAVA_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
  } catch (err) {
    console.error('Failed to save Strava config:', err.message)
  }
}

function getStravaCallbackUrl() {
  if (process.env.RELAY_PUBLIC_URL) return `${process.env.RELAY_PUBLIC_URL}/strava/callback`
  if (currentTunnelUrl) return `${currentTunnelUrl}/strava/callback`
  return `http://localhost:${PORT}/strava/callback`
}

async function ensureStravaToken() {
  if (!stravaTokens) throw new Error('Strava not connected')
  // Refresh if expired (60s buffer)
  if (Date.now() / 1000 > stravaTokens.expiresAt - 60) {
    const res = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: stravaTokens.clientId,
        client_secret: stravaTokens.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: stravaTokens.refreshToken,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      stravaTokens = null
      saveStravaTokens()
      throw new Error(`Token refresh failed: ${text}`)
    }
    const data = await res.json()
    stravaTokens.accessToken = data.access_token
    stravaTokens.refreshToken = data.refresh_token
    stravaTokens.expiresAt = data.expires_at
    saveStravaTokens()
  }
  return stravaTokens.accessToken
}

async function fetchStravaActivities(after, page = 1, perPage = 100) {
  const token = await ensureStravaToken()
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) })
  if (after) params.set('after', String(after))
  const res = await fetch(`${STRAVA_API}/athlete/activities?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    if (res.status === 401) {
      stravaTokens = null
      saveStravaTokens()
      throw new Error('Strava session expired — reconnect via /strava/connect')
    }
    throw new Error(`Strava API ${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function fetchStravaActivityDetail(activityId) {
  const token = await ensureStravaToken()
  const params = new URLSearchParams({ include_all_efforts: 'true' })
  const res = await fetch(`${STRAVA_API}/activities/${activityId}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    if (res.status === 401) {
      stravaTokens = null
      saveStravaTokens()
      throw new Error('Strava session expired - reconnect via /strava/connect')
    }
    throw new Error(`Strava activity detail API ${res.status} ${res.statusText}`)
  }
  return res.json()
}

function stravaActivityToWorkout(activity) {
  const durationMin = Math.round(activity.moving_time / 60)
  const distanceMi = parseFloat((activity.distance * 0.000621371).toFixed(2))
  let calories = 0
  if (activity.calories) calories = Math.round(activity.calories)
  else if (activity.kilojoules) calories = Math.round(activity.kilojoules)

  return {
    name: activity.type || activity.sport_type || 'Unknown',
    duration: durationMin,
    calories,
    distance: distanceMi,
    stepCount: 0,
    avgHR: activity.average_heartrate || 0,
    maxHR: activity.max_heartrate || 0,
    start: activity.start_date,
    end: new Date(new Date(activity.start_date).getTime() + activity.elapsed_time * 1000).toISOString(),
    source: 'Strava',
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

function summarizeStravaDetailArray(items, maxItems, mapper) {
  return Array.isArray(items) ? items.slice(0, maxItems).map(mapper).filter(Boolean) : []
}

function compactStravaActivityDetail(activity) {
  if (!activity) return null
  return {
    schemaVersion: 2,
    id: activity.id,
    name: activity.name,
    description: typeof activity.description === 'string' ? activity.description.slice(0, 1000) : undefined,
    type: activity.type,
    sportType: activity.sport_type,
    workoutType: activity.workout_type,
    routeId: activity.route?.id,
    startDate: activity.start_date,
    startDateLocal: activity.start_date_local,
    timezone: activity.timezone,
    utcOffset: activity.utc_offset,
    locationCity: activity.location_city,
    locationState: activity.location_state,
    locationCountry: activity.location_country,
    startLatlng: activity.start_latlng,
    endLatlng: activity.end_latlng,
    map: activity.map ? {
      id: activity.map.id,
      summaryPolyline: activity.map.summary_polyline,
      resourceState: activity.map.resource_state,
    } : undefined,
    movingTime: activity.moving_time,
    elapsedTime: activity.elapsed_time,
    distanceMeters: activity.distance,
    calories: activity.calories,
    kilojoules: activity.kilojoules,
    averageHeartrate: activity.average_heartrate,
    maxHeartrate: activity.max_heartrate,
    hasHeartrate: activity.has_heartrate,
    averageSpeed: activity.average_speed,
    maxSpeed: activity.max_speed,
    averageCadence: activity.average_cadence,
    averageWatts: activity.average_watts,
    weightedAverageWatts: activity.weighted_average_watts,
    maxWatts: activity.max_watts,
    deviceWatts: activity.device_watts,
    sufferScore: activity.suffer_score,
    perceivedExertion: activity.perceived_exertion,
    deviceName: activity.device_name,
    embedToken: activity.embed_token,
    uploadId: activity.upload_id,
    uploadIdStr: activity.upload_id_str,
    externalId: activity.external_id,
    totalElevationGain: activity.total_elevation_gain,
    elevationHigh: activity.elev_high,
    elevationLow: activity.elev_low,
    achievementCount: activity.achievement_count,
    prCount: activity.pr_count,
    athleteCount: activity.athlete_count,
    kudosCount: activity.kudos_count,
    commentCount: activity.comment_count,
    photoCount: activity.photo_count,
    totalPhotoCount: activity.total_photo_count,
    visibility: activity.visibility,
    trainer: !!activity.trainer,
    commute: !!activity.commute,
    manual: !!activity.manual,
    private: !!activity.private,
    flagged: !!activity.flagged,
    hideFromHome: !!activity.hide_from_home,
    gearId: activity.gear_id,
    gear: activity.gear ? {
      id: activity.gear.id,
      name: activity.gear.name,
      nickname: activity.gear.nickname,
      brandName: activity.gear.brand_name,
      modelName: activity.gear.model_name,
      distance: activity.gear.distance,
      primary: activity.gear.primary,
    } : undefined,
    splitsMetric: summarizeStravaDetailArray(activity.splits_metric, 80, split => ({
      distance: split.distance,
      movingTime: split.moving_time,
      elapsedTime: split.elapsed_time,
      elevationDifference: split.elevation_difference,
      averageSpeed: split.average_speed,
      paceZone: split.pace_zone,
      split: split.split,
    })),
    splitsStandard: summarizeStravaDetailArray(activity.splits_standard, 80, split => ({
      distance: split.distance,
      movingTime: split.moving_time,
      elapsedTime: split.elapsed_time,
      elevationDifference: split.elevation_difference,
      averageSpeed: split.average_speed,
      paceZone: split.pace_zone,
      split: split.split,
    })),
    laps: summarizeStravaDetailArray(activity.laps, 40, lap => ({
      id: lap.id,
      name: lap.name,
      distance: lap.distance,
      movingTime: lap.moving_time,
      elapsedTime: lap.elapsed_time,
      totalElevationGain: lap.total_elevation_gain,
      averageSpeed: lap.average_speed,
      maxSpeed: lap.max_speed,
      averageHeartrate: lap.average_heartrate,
      maxHeartrate: lap.max_heartrate,
      averageCadence: lap.average_cadence,
      averageWatts: lap.average_watts,
      startDate: lap.start_date,
      lapIndex: lap.lap_index,
      split: lap.split,
    })),
    bestEfforts: summarizeStravaDetailArray(activity.best_efforts, 30, effort => ({
      id: effort.id,
      name: effort.name,
      distance: effort.distance,
      movingTime: effort.moving_time,
      elapsedTime: effort.elapsed_time,
      startDate: effort.start_date,
      startDateLocal: effort.start_date_local,
      prRank: effort.pr_rank,
    })),
    segmentEfforts: summarizeStravaDetailArray(activity.segment_efforts, 80, effort => ({
      id: effort.id,
      name: effort.name,
      elapsedTime: effort.elapsed_time,
      movingTime: effort.moving_time,
      startDate: effort.start_date,
      startDateLocal: effort.start_date_local,
      distance: effort.distance,
      averageCadence: effort.average_cadence,
      averageWatts: effort.average_watts,
      averageHeartrate: effort.average_heartrate,
      maxHeartrate: effort.max_heartrate,
      prRank: effort.pr_rank,
      komRank: effort.kom_rank,
      achievements: summarizeStravaDetailArray(effort.achievements, 10, achievement => ({
        type: achievement.type,
        rank: achievement.rank,
      })),
      segment: effort.segment ? {
        id: effort.segment.id,
        name: effort.segment.name,
        activityType: effort.segment.activity_type,
        distance: effort.segment.distance,
        averageGrade: effort.segment.average_grade,
        maximumGrade: effort.segment.maximum_grade,
        elevationHigh: effort.segment.elevation_high,
        elevationLow: effort.segment.elevation_low,
        climbCategory: effort.segment.climb_category,
        city: effort.segment.city,
        state: effort.segment.state,
        country: effort.segment.country,
        private: effort.segment.private,
        hazardous: effort.segment.hazardous,
        starred: effort.segment.starred,
      } : undefined,
    })),
    segmentEffortCount: Array.isArray(activity.segment_efforts) ? activity.segment_efforts.length : 0,
  }
}

function storeStravaActivityDetail(activityId, dateStr, workoutName, activity) {
  const detail = compactStravaActivityDetail(activity)
  if (!detail) return null
  stravaActivityDetailsStore[String(activityId)] = {
    date: dateStr || activity?.start_date_local?.slice(0, 10) || activity?.start_date?.slice(0, 10) || '',
    name: workoutName || activity?.name || 'Unknown',
    detail,
    fetchedAt: new Date().toISOString(),
  }
  return detail
}

function hasExpandedActivityDetail(activityId) {
  const detail = stravaActivityDetailsStore[String(activityId)]?.detail
  return Number(detail?.schemaVersion || 0) >= 2
}

function enrichWorkoutWithActivityDetail(workout, detail) {
  if (!detail) return workout
  workout.name = detail.type || detail.sportType || workout.name
  workout.duration = detail.movingTime ? Math.round(detail.movingTime / 60) : workout.duration
  workout.elapsedSeconds = detail.elapsedTime || workout.elapsedSeconds
  workout.movingSeconds = detail.movingTime || workout.movingSeconds
  workout.description = detail.description || workout.description
  workout.routeId = detail.routeId || workout.routeId
  workout.location = {
    city: detail.locationCity || '',
    state: detail.locationState || '',
    country: detail.locationCountry || '',
  }
  if (detail.startLatlng) workout.startLatlng = detail.startLatlng
  if (detail.endLatlng) workout.endLatlng = detail.endLatlng
  if (detail.map) workout.map = detail.map
  workout.calories = detail.calories ? Math.round(detail.calories) : workout.calories
  workout.distance = detail.distanceMeters ? parseFloat((detail.distanceMeters * 0.000621371).toFixed(2)) : workout.distance
  workout.avgHR = detail.averageHeartrate || workout.avgHR
  workout.maxHR = detail.maxHeartrate || workout.maxHR
  workout.avgSpeed = detail.averageSpeed || workout.avgSpeed
  workout.maxSpeed = detail.maxSpeed || workout.maxSpeed
  workout.avgCadence = detail.averageCadence || workout.avgCadence
  workout.avgWatts = detail.averageWatts || workout.avgWatts
  workout.normalizedPower = detail.weightedAverageWatts || workout.normalizedPower
  workout.maxWatts = detail.maxWatts || workout.maxWatts
  workout.elevationGain = detail.totalElevationGain || workout.elevationGain
  workout.elevHigh = detail.elevationHigh || workout.elevHigh
  workout.elevLow = detail.elevationLow || workout.elevLow
  workout.sufferScore = detail.sufferScore || workout.sufferScore
  workout.perceivedExertion = detail.perceivedExertion || workout.perceivedExertion
  workout.deviceName = detail.deviceName || workout.deviceName
  workout.embedToken = detail.embedToken || workout.embedToken
  workout.uploadId = detail.uploadId || workout.uploadId
  workout.uploadIdStr = detail.uploadIdStr || workout.uploadIdStr
  workout.externalId = detail.externalId || workout.externalId
  workout.workoutType = detail.workoutType ?? workout.workoutType
  workout.hasHeartRate = detail.hasHeartrate ?? workout.hasHeartRate
  workout.deviceWatts = detail.deviceWatts ?? workout.deviceWatts
  workout.trainer = detail.trainer
  workout.commute = detail.commute
  workout.manual = detail.manual
  workout.private = detail.private
  workout.flagged = detail.flagged
  workout.hideFromHome = detail.hideFromHome
  workout.visibility = detail.visibility || workout.visibility
  workout.achievementCount = detail.achievementCount || 0
  workout.prCount = detail.prCount || 0
  workout.athleteCount = detail.athleteCount || 0
  workout.kudosCount = detail.kudosCount || 0
  workout.commentCount = detail.commentCount || 0
  workout.photoCount = detail.photoCount || 0
  workout.totalPhotoCount = detail.totalPhotoCount || 0
  workout.gearId = detail.gearId || workout.gearId
  if (detail.gear) workout.gear = detail.gear
  if (detail.splitsMetric?.length) workout.splitsMetric = detail.splitsMetric
  if (detail.splitsStandard?.length) workout.splitsStandard = detail.splitsStandard
  if (detail.laps?.length) workout.laps = detail.laps
  if (detail.bestEfforts?.length) workout.bestEfforts = detail.bestEfforts
  if (detail.segmentEfforts?.length) workout.segmentEfforts = detail.segmentEfforts
  workout.segmentEffortCount = detail.segmentEffortCount || 0
  workout.hasActivityDetail = true
  workout.activityDetailSummary = {
    splitsMetric: detail.splitsMetric?.length || 0,
    splitsStandard: detail.splitsStandard?.length || 0,
    laps: detail.laps?.length || 0,
    bestEfforts: detail.bestEfforts?.length || 0,
    segmentEfforts: detail.segmentEffortCount || 0,
    storedSegmentEfforts: detail.segmentEfforts?.length || 0,
  }
  return workout
}

async function enrichWorkoutWithStoredOrFetchedActivityDetail(workout, activity, dateStr, forceFetch = false) {
  const activityId = activity?.id
  if (!activityId) return { workout, fetched: false, reused: false }
  const cached = stravaActivityDetailsStore[String(activityId)]?.detail
  if (cached && !forceFetch && hasExpandedActivityDetail(activityId)) {
    return { workout: enrichWorkoutWithActivityDetail(workout, cached), fetched: false, reused: true }
  }
  const detailActivity = forceFetch ? activity : await fetchStravaActivityDetail(activityId)
  const detail = storeStravaActivityDetail(activityId, dateStr, workout.name, detailActivity)
  return { workout: enrichWorkoutWithActivityDetail(workout, detail), fetched: true, reused: false }
}

function copyStoredStreamEnrichment(workout, existing) {
  if (!existing?.hasStreams) return workout
  for (const key of ['hrZoneSeconds', 'streamSummary']) {
    if (existing[key] !== undefined) workout[key] = existing[key]
  }
  for (const key of ['avgCadence', 'avgWatts', 'maxWatts', 'elevationGain', 'maxSpeed']) {
    if ((workout[key] === undefined || workout[key] === 0) && existing[key] !== undefined) workout[key] = existing[key]
  }
  workout.hasStreams = true
  return workout
}

function hasExpandedStreamData(activityId) {
  const streams = stravaStreamsStore[String(activityId)]?.streams
  return !!(streams?.time?.length && streams?.latlng?.length && streams?.moving?.length)
}

function normalizeWorkoutText(value) {
  return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim()
}

const SPORT_SYNONYMS = {
  'outdoor cycling': 'ride', 'indoor cycling': 'ride', cycling: 'ride',
  'outdoor run': 'run', 'indoor run': 'run', 'treadmill run': 'run',
  'outdoor walk': 'walk', 'indoor walk': 'walk',
  'outdoor swim': 'swim', 'indoor swim': 'swim', 'pool swim': 'swim', 'open water swim': 'swim',
  'outdoor hike': 'hike', hiking: 'hike',
  'traditional strength training': 'weight training', 'strength training': 'weight training',
}

function canonicalSport(name) {
  const n = normalizeWorkoutText(name)
  return SPORT_SYNONYMS[n] || n
}

function workoutStartMs(workout) {
  let raw = workout?.start || workout?.startDate
  if (!raw) return null
  raw = String(raw)
  // HAE format: "2018-09-09 08:00:14 -0500" — JS Date can't parse space-separated tz offset
  const haeMatch = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/)
  if (haeMatch) raw = `${haeMatch[1]}T${haeMatch[2]}${haeMatch[3]}:${haeMatch[4]}`
  const ts = new Date(raw).getTime()
  return Number.isFinite(ts) ? ts : null
}

function workoutDurationMin(workout) {
  const raw = Number(workout?.duration || workout?.elapsedTime || workout?.movingTime || 0)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw > 200 ? raw / 60 : raw
}

function workoutDistance(workout) {
  const raw = workout?.distance
  if (raw && typeof raw === 'object') return Number(raw.qty ?? raw.value ?? 0) || 0
  return Number(raw || 0) || 0
}

function isStravaWorkout(workout) {
  return !!(
    workout?.stravaId ||
    normalizeWorkoutText(workout?.source).includes('strava') ||
    normalizeWorkoutText(workout?.provider).includes('strava')
  )
}

function sameWorkout(a, b) {
  if (a?.stravaId && b?.stravaId) return String(a.stravaId) === String(b.stravaId)
  const aStart = workoutStartMs(a)
  const bStart = workoutStartMs(b)
  if (aStart == null || bStart == null) return false
  if (Math.abs(aStart - bStart) / 60000 > 20) return false

  const aName = canonicalSport(a?.name || a?.sportType || a?.type)
  const bName = canonicalSport(b?.name || b?.sportType || b?.type)
  const namesMatch = !aName || !bName || aName === bName || aName.includes(bName) || bName.includes(aName)
  if (!namesMatch) return false

  const aDuration = workoutDurationMin(a)
  const bDuration = workoutDurationMin(b)
  if (aDuration && bDuration && Math.abs(aDuration - bDuration) > Math.max(10, Math.min(aDuration, bDuration) * 0.25)) return false

  const aDistance = workoutDistance(a)
  const bDistance = workoutDistance(b)
  if (aDistance && bDistance && Math.abs(aDistance - bDistance) > Math.max(0.25, Math.min(aDistance, bDistance) * 0.25)) return false

  return true
}

function workoutCompleteness(workout) {
  return [
    workout?.stravaId,
    workout?.avgHR || workout?.heartRateAvg || workout?.heartRateData?.avg,
    workout?.maxHR || workout?.heartRateMax || workout?.heartRateData?.max,
    workout?.distance,
    workout?.calories || workout?.activeEnergyBurned || workout?.totalEnergy,
    workout?.elevationGain,
    workout?.avgSpeed,
    workout?.avgCadence,
    workout?.avgWatts,
    workout?.normalizedPower,
    workout?.maxWatts,
    workout?.hrZoneSeconds,
    workout?.hasStreams,
    workout?.streamSummary,
    workout?.hasActivityDetail,
    workout?.activityDetailSummary,
    workout?.splitsMetric?.length,
    workout?.splitsStandard?.length,
    workout?.laps?.length,
    workout?.bestEfforts?.length,
    workout?.segmentEffortCount,
    workout?.segmentEfforts?.length,
    workout?.perceivedExertion,
    workout?.maxSpeed,
    workout?.routePointCount,
    workout?.avgTemp,
    workout?.streamMovingSeconds,
    workout?.map?.summaryPolyline,
    workout?.deviceName,
    workout?.gear?.id,
  ].filter(Boolean).length
}

function mergeWorkouts(existingWorkouts, incomingWorkouts) {
  const merged = [...(existingWorkouts || [])]
  for (const incoming of incomingWorkouts || []) {
    const idx = merged.findIndex(existing => sameWorkout(existing, incoming))
    if (idx === -1) {
      merged.push(incoming)
      continue
    }
    const existingIsStrava = isStravaWorkout(merged[idx])
    const incomingIsStrava = isStravaWorkout(incoming)
    if (incomingIsStrava && !existingIsStrava) merged[idx] = incoming
    else if (!incomingIsStrava && existingIsStrava) continue
    else if (workoutCompleteness(incoming) >= workoutCompleteness(merged[idx])) merged[idx] = incoming
  }
  return merged.sort((a, b) => (workoutStartMs(a) || 0) - (workoutStartMs(b) || 0))
}

function workoutRowSource(workouts) {
  const hasStrava = (workouts || []).some(isStravaWorkout)
  const hasNonStrava = (workouts || []).some(w => !isStravaWorkout(w))
  return hasStrava && hasNonStrava ? 'mixed' : hasStrava ? 'strava' : 'health_auto_export'
}

function existingStravaWorkout(activityId) {
  if (!activityId) return null
  for (const row of healthData.metrics) {
    if (row?.type !== 'workout') continue
    const workouts = Array.isArray(row.value?.workouts) ? row.value.workouts : []
    const match = workouts.find(w => String(w?.stravaId || '') === String(activityId))
    if (match) return match
  }
  return null
}

function upsertWorkoutRow(dateStr, incomingWorkouts) {
  const existingRows = healthData.metrics.filter(m => m.type === 'workout' && m.date === dateStr)
  const existingWorkouts = existingRows.flatMap(m => Array.isArray(m.value?.workouts) ? m.value.workouts : [])
  const merged = mergeWorkouts(existingWorkouts, incomingWorkouts)
  healthData.metrics = healthData.metrics.filter(m => !(m.type === 'workout' && m.date === dateStr))
  if (merged.length > 0) {
    healthData.metrics.push({
      type: 'workout',
      date: dateStr,
      value: { workouts: merged },
      source: workoutRowSource(merged),
      synced_at: new Date().toISOString(),
    })
  }
}

// Fetch per-second streams for a single activity (HR, cadence, power, altitude)
async function fetchActivityStreams(activityId) {
  const token = await ensureStravaToken()
  const keys = 'time,latlng,distance,altitude,velocity_smooth,heartrate,cadence,watts,temp,moving,grade_smooth'
  const res = await fetch(
    `${STRAVA_API}/activities/${activityId}/streams?keys=${keys}&key_by_type=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) return null
  return res.json()
}

// Compute seconds in each of 5 HR zones based on % of activity max HR
function computeHRZones(hrValues, maxHR) {
  if (!hrValues?.length || !maxHR) return null
  const zones = [0, 0, 0, 0, 0]
  for (const hr of hrValues) {
    const pct = hr / maxHR
    if (pct < 0.60) zones[0]++
    else if (pct < 0.70) zones[1]++
    else if (pct < 0.80) zones[2]++
    else if (pct < 0.90) zones[3]++
    else zones[4]++
  }
  return zones // [z1_sec, z2_sec, z3_sec, z4_sec, z5_sec]
}

// Convert Strava API stream response ({type, data} array or key_by_type object) to flat format
function normalizeStreams(streams) {
  if (!streams) return null
  // key_by_type format: { heartrate: { data: [...] }, ... }
  // array format: [{ type: 'heartrate', data: [...] }, ...]
  const result = {}
  if (Array.isArray(streams)) {
    for (const s of streams) {
      if (s.type && s.data) result[s.type] = s.data
    }
  } else {
    for (const [key, val] of Object.entries(streams)) {
      result[key] = val?.data ?? val
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

// Store raw stream data for an activity
function storeRawStreams(activityId, dateStr, workoutName, rawStreams) {
  const normalized = normalizeStreams(rawStreams)
  if (!normalized) return
  stravaStreamsStore[String(activityId)] = {
    date: dateStr,
    name: workoutName || 'Unknown',
    streams: normalized,
    fetchedAt: new Date().toISOString(),
  }
  // Debounced save — we batch saves during sync
}

// Enrich a workout object with stream-derived fields
async function enrichWorkoutWithStreams(workout, activityId, dateStr) {
  try {
    const streams = await fetchActivityStreams(activityId)
    if (!streams) return workout
    const normalizedStreams = normalizeStreams(streams)
    if (!normalizedStreams) return workout
    const hrData = normalizedStreams.heartrate
    const cadData = normalizedStreams.cadence
    const wattData = normalizedStreams.watts
    const altData = normalizedStreams.altitude
    const velocityData = normalizedStreams.velocity_smooth
    const distanceData = normalizedStreams.distance
    const gradeData = normalizedStreams.grade_smooth
    const latlngData = normalizedStreams.latlng
    const tempData = normalizedStreams.temp
    const movingData = normalizedStreams.moving
    const streamPoints = normalizedStreams.time?.length || hrData?.length || distanceData?.length || 0
    if (!streamPoints && !cadData?.length && !wattData?.length && !altData?.length && !velocityData?.length && !gradeData?.length && !latlngData?.length && !tempData?.length && !movingData?.length) {
      return workout
    }

    // Store raw streams for later retrieval
    storeRawStreams(activityId, dateStr || workout.start?.slice(0, 10) || '', workout.name, normalizedStreams)

    if (hrData?.length && workout.maxHR) {
      workout.hrZoneSeconds = computeHRZones(hrData, workout.maxHR)
    }
    if (cadData?.length) {
      const nonZero = cadData.filter(v => v > 0)
      if (nonZero.length) workout.avgCadence = Math.round(nonZero.reduce((a, b) => a + b, 0) / nonZero.length)
    }
    if (wattData?.length) {
      const nonZero = wattData.filter(v => v > 0)
      if (nonZero.length) {
        workout.avgWatts = Math.round(nonZero.reduce((a, b) => a + b, 0) / nonZero.length)
        workout.maxWatts = Math.max(...nonZero)
      }
    }
    if (altData?.length) {
      let gain = 0
      for (let i = 1; i < altData.length; i++) {
        const d = altData[i] - altData[i - 1]
        if (d > 0) gain += d
      }
      workout.elevationGain = Math.round(gain)
    }
    if (velocityData?.length) {
      const nonZero = velocityData.filter(v => v > 0)
      if (nonZero.length) workout.maxSpeed = Math.max(...nonZero)
    }
    if (latlngData?.length) {
      workout.routePointCount = latlngData.length
    }
    if (tempData?.length) {
      const temps = tempData.filter(v => Number.isFinite(v))
      if (temps.length) {
        workout.avgTemp = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length)
        workout.minTemp = Math.min(...temps)
        workout.maxTemp = Math.max(...temps)
      }
    }
    if (movingData?.length && normalizedStreams.time?.length) {
      let movingSeconds = 0
      for (let i = 1; i < movingData.length && i < normalizedStreams.time.length; i++) {
        const dt = normalizedStreams.time[i] - normalizedStreams.time[i - 1]
        if (movingData[i] && dt > 0 && dt <= 60) movingSeconds += dt
      }
      if (movingSeconds > 0) workout.streamMovingSeconds = movingSeconds
    }
    workout.streamSummary = {
      points: streamPoints,
      hasHeartRate: !!hrData?.length,
      hasCadence: !!cadData?.length,
      hasPower: !!wattData?.length,
      hasAltitude: !!altData?.length,
      hasVelocity: !!velocityData?.length,
      hasGrade: !!gradeData?.length,
      hasLatlng: !!latlngData?.length,
      hasTemp: !!tempData?.length,
      hasMoving: !!movingData?.length,
    }
    workout.hasStreams = true
  } catch (err) {
    console.error(`  [Strava] Stream fetch failed for ${activityId}:`, err.message)
  }
  return workout
}

// Fetch and store a single activity by ID with full stream data (used by webhook)
async function syncSingleActivity(activityId) {
  const token = await ensureStravaToken()
  const res = await fetch(`${STRAVA_API}/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Activity fetch failed: ${res.status}`)
  const activity = await res.json()
  let workout = stravaActivityToWorkout(activity)
  const dateStr = (activity.start_date_local || activity.start_date).slice(0, 10)
  storeStravaActivityDetail(activityId, dateStr, workout.name, activity)
  workout = enrichWorkoutWithActivityDetail(workout, stravaActivityDetailsStore[String(activityId)]?.detail)
  workout = await enrichWorkoutWithStreams(workout, activityId, dateStr)

  upsertWorkoutRow(dateStr, [workout])
  saveHealthData()
  saveStravaStreams()
  saveStravaActivityDetails()
  console.log(`  [Strava Webhook] Synced activity: ${workout.name} on ${dateStr}`)
  return { date: dateStr, name: workout.name }
}

// Background backfill state
let backfillState = { inProgress: false, total: 0, processed: 0, enriched: 0, from: '', to: '', startedAt: null, error: null }

// Backfill a date range with stream data — runs in background, rate-limit aware (~5s/activity)
async function startBackfillWithStreams(from, to) {
  if (backfillState.inProgress) throw new Error('Backfill already in progress')

  const after = Math.floor(new Date(from).getTime() / 1000)
  const before = Math.floor(new Date(to + 'T23:59:59').getTime() / 1000)

  const allActivities = []
  let page = 1
  while (true) {
    const token = await ensureStravaToken()
    const params = new URLSearchParams({ page: String(page), per_page: '100', after: String(after), before: String(before) })
    const res = await fetch(`${STRAVA_API}/athlete/activities?${params}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) break
    const batch = await res.json()
    if (!Array.isArray(batch) || batch.length === 0) break
    allActivities.push(...batch)
    if (batch.length < 100) break
    page++
  }

  backfillState = { inProgress: true, total: allActivities.length, processed: 0, enriched: 0, from, to, startedAt: new Date().toISOString(), error: null }
  console.log(`  [Strava] Backfill started: ${allActivities.length} activities from ${from} to ${to}`)

  ;(async () => {
    for (const activity of allActivities) {
      try {
        let workout = stravaActivityToWorkout(activity)
        const dateStr = (activity.start_date_local || activity.start_date).slice(0, 10)
        await new Promise(r => setTimeout(r, 5000)) // 5s gap = ~180 req/15min, safely under limits
        workout = await enrichWorkoutWithStreams(workout, activity.id, dateStr)
        upsertWorkoutRow(dateStr, [workout])
        if (workout.hasStreams) backfillState.enriched++
      } catch (err) {
        console.error(`  [Strava] Backfill error for ${activity.id}:`, err.message)
      }
      backfillState.processed++
      // Periodic save every 10 activities
      if (backfillState.processed % 10 === 0) { saveHealthData(); saveStravaStreams() }
    }
    saveHealthData()
    saveStravaStreams()
    backfillState.inProgress = false
    console.log(`  [Strava] Backfill complete: ${backfillState.enriched}/${backfillState.total} enriched with streams`)
  })()

  return { started: true, total: allActivities.length, estimatedMinutes: Math.ceil(allActivities.length * 5 / 60) }
}

async function syncStravaToRelay(days = 90, options = {}) {
  if (!stravaTokens) throw new Error('Strava not connected')
  const detailed = options.detailed !== false
  const streamLimit = Math.max(0, Math.min(Number(options.streamLimit ?? 25) || 0, 100))
  const activityDetailLimit = Math.max(0, Math.min(Number(options.activityDetailLimit ?? streamLimit) || 0, 100))
  const after = Math.floor(Date.now() / 1000) - days * 86400
  const allActivities = []
  let page = 1
  while (true) {
    const batch = await fetchStravaActivities(after, page, 100)
    if (batch.length === 0) break
    allActivities.push(...batch)
    if (batch.length < 100) break
    page++
  }
  if (allActivities.length === 0) return { synced: 0, total: 0 }

  // Group by date
  const byDate = new Map()
  let enriched = 0
  let reusedDetailed = 0
  let activityDetailsFetched = 0
  let activityDetailsReused = 0
  for (const activity of allActivities) {
    let workout = stravaActivityToWorkout(activity)
    const dateStr = (activity.start_date_local || activity.start_date).slice(0, 10)
    const existing = existingStravaWorkout(activity.id)

    if (detailed) {
      try {
        if (activityDetailsFetched < activityDetailLimit) {
          const detailResult = await enrichWorkoutWithStoredOrFetchedActivityDetail(workout, activity, dateStr)
          workout = detailResult.workout
          if (detailResult.fetched) activityDetailsFetched++
          if (detailResult.reused) activityDetailsReused++
        } else {
          const cached = stravaActivityDetailsStore[String(activity.id)]?.detail
          if (cached) {
            workout = enrichWorkoutWithActivityDetail(workout, cached)
            activityDetailsReused++
          }
        }
      } catch (err) {
        console.error(`  [Strava] Activity detail fetch failed for ${activity.id}:`, err.message)
      }
    }

    if (existing?.hasStreams && hasExpandedStreamData(activity.id)) {
      workout = copyStoredStreamEnrichment(workout, existing)
      reusedDetailed++
    } else if (detailed && enriched < streamLimit) {
      workout = await enrichWorkoutWithStreams(workout, activity.id, dateStr)
      if (workout.hasStreams) enriched++
      if (enriched < streamLimit) await new Promise(r => setTimeout(r, 200))
    }
    if (!byDate.has(dateStr)) byDate.set(dateStr, [])
    byDate.get(dateStr).push(workout)
  }

  // Store in healthData. Strava wins for matching workouts, but HAE-only
  // workouts such as swims remain in the same daily row.
  for (const [dateStr, workouts] of byDate) {
    upsertWorkoutRow(dateStr, workouts)
  }
  saveHealthData()
  if (enriched > 0) saveStravaStreams()
  if (activityDetailsFetched > 0) saveStravaActivityDetails()
  console.log(`  [Strava] Synced ${allActivities.length} activities across ${byDate.size} days; streams enriched ${enriched}, streams reused ${reusedDetailed}, details fetched ${activityDetailsFetched}, details reused ${activityDetailsReused}`)
  return {
    synced: byDate.size,
    total: allActivities.length,
    enriched,
    reusedDetailed,
    activityDetailsFetched,
    activityDetailsReused,
    detailed,
  }
}

// --- Sync Data Storage (all tables from desktop) ---

const SYNC_DATA_PATH = path.join(__dirname, 'sync-data.json')

let syncData = {
  watchlist: [],
  prices: [],
  news: [],
  briefings: [],
  lastBriefingDate: null,
  chat_messages: [],
  weekend_plans: [],
  weekend_event_cache: [],
  daily_schedule: [],
  saved_restaurants: [],
  restaurant_visits: [],
  updated_at: null,
}

function loadSyncData() {
  try {
    if (fs.existsSync(SYNC_DATA_PATH)) {
      syncData = JSON.parse(fs.readFileSync(SYNC_DATA_PATH, 'utf-8'))
    }
  } catch {}
}

function saveSyncData() {
  try {
    writeJsonAtomic(SYNC_DATA_PATH, syncData)
    updateSyncDataHash()
  } catch (err) {
    console.error('Failed to save sync data:', err.message)
  }
}

loadSyncData()
updateSyncDataHash()

function mergeByKey(existingRows = [], incomingRows = [], keyFn, options = {}) {
  const map = new Map()
  for (const row of existingRows || []) {
    const key = keyFn(row)
    if (key) map.set(key, row)
  }
  for (const row of incomingRows || []) {
    const key = keyFn(row)
    if (key) map.set(key, row)
  }
  let rows = [...map.values()]
  if (options.sortFn) rows.sort(options.sortFn)
  if (options.limit && rows.length > options.limit) rows = rows.slice(-options.limit)
  return rows
}

function recentDateValue(row) {
  return row?.updated_at || row?.saved_at || row?.fetched_at || row?.published_at || row?.created_at || row?.date || ''
}

function isBlankValue(value) {
  return value === undefined || value === null || value === ''
}

function mergeRestaurantRow(existing = {}, incoming = {}) {
  const existingVersion = new Date(existing.updated_at || existing.saved_at || existing.last_researched_at || 0).getTime() || 0
  const incomingVersion = new Date(incoming.updated_at || incoming.saved_at || incoming.last_researched_at || 0).getTime() || 0
  const base = incomingVersion >= existingVersion ? { ...existing, ...incoming } : { ...incoming, ...existing }
  const merged = { ...base }
  for (const [key, value] of Object.entries(incoming)) {
    if (isBlankValue(value) && !isBlankValue(existing[key])) {
      merged[key] = existing[key]
    }
  }
  const existingResearch = existing.last_researched_at ? new Date(existing.last_researched_at).getTime() : 0
  const incomingResearch = incoming.last_researched_at ? new Date(incoming.last_researched_at).getTime() : 0
  if (existingResearch > incomingResearch) {
    for (const key of ['booking_advance_days', 'busy_days_matrix', 'last_researched_at', 'description', 'peak_times', 'reservation_link']) {
      if (!isBlankValue(existing[key])) merged[key] = existing[key]
    }
  }
  return merged
}

function mergeRestaurantVisits(existingRows = [], incomingRows = []) {
  const map = new Map()
  for (const row of existingRows || []) {
    if (!row?.place_id || !row?.visit_date) continue
    map.set(`${row.place_id}:${row.visit_date}`, row)
  }
  for (const row of incomingRows || []) {
    if (!row?.place_id || !row?.visit_date) continue
    const key = `${row.place_id}:${row.visit_date}`
    const existing = map.get(key)
    const existingStamp = existing?.deleted_at || existing?.created_at
    const incomingStamp = row?.deleted_at || row?.created_at
    const existingVersion = existingStamp ? new Date(existingStamp).getTime() : 0
    const incomingVersion = incomingStamp ? new Date(incomingStamp).getTime() : Date.now()
    if (!existing || incomingVersion >= existingVersion) {
      map.set(key, { ...existing, ...row, created_at: row.created_at || new Date().toISOString() })
    }
  }
  return [...map.values()].sort((a, b) => recentDateValue(a).localeCompare(recentDateValue(b)))
}

function rowVersion(row) {
  return row?.deleted_at || row?.updated_at || row?.created_at || ''
}

function mergeVersionedRows(existingRows = [], incomingRows = [], keyFn, sortFn = null, limit = null) {
  const map = new Map()
  for (const row of existingRows || []) {
    const key = keyFn(row)
    if (key) map.set(key, row)
  }
  for (const row of incomingRows || []) {
    const key = keyFn(row)
    if (!key) continue
    const existing = map.get(key)
    if (!existing || rowVersion(row) >= rowVersion(existing)) {
      map.set(key, row)
    }
  }
  const values = [...map.values()]
  const sorted = sortFn ? values.sort(sortFn) : values
  return limit ? sorted.slice(0, limit) : sorted
}

function mergeSyncTable(table, incoming) {
  if (!Array.isArray(incoming)) return

  if (table === 'prices') {
    syncData.prices = mergeByKey(
      syncData.prices,
      incoming,
      p => p?.symbol && p?.date ? `${p.symbol}:${p.date}:${p.source || 'sync'}` : null,
      { sortFn: (a, b) => `${a.date}:${a.symbol}`.localeCompare(`${b.date}:${b.symbol}`), limit: 5000 }
    )
    return
  }

  if (table === 'news') {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 14)
    const cutoffStr = cutoff.toISOString()
    syncData.news = mergeByKey(
      (syncData.news || []).filter(n => !recentDateValue(n) || recentDateValue(n) >= cutoffStr),
      incoming,
      n => n?.url || (n?.title && n?.published_at ? `${n.title}:${n.published_at}` : null),
      { sortFn: (a, b) => recentDateValue(a).localeCompare(recentDateValue(b)), limit: 300 }
    )
    return
  }

  if (table === 'saved_restaurants') {
    const map = new Map((syncData.saved_restaurants || []).map(r => [r.place_id, r]))
    for (const row of incoming || []) {
      if (!row?.place_id) continue
      map.set(row.place_id, mergeRestaurantRow(map.get(row.place_id), row))
    }
    syncData.saved_restaurants = [...map.values()].sort((a, b) => recentDateValue(a).localeCompare(recentDateValue(b)))
    return
  }

  if (table === 'restaurant_visits') {
    syncData.restaurant_visits = mergeRestaurantVisits(syncData.restaurant_visits, incoming)
    return
  }

  if (table === 'chat_messages') {
    syncData.chat_messages = mergeByKey(
      syncData.chat_messages,
      incoming,
      m => m?.role && m?.created_at ? `${m.role}:${m.created_at}:${m.content || ''}` : null,
      { sortFn: (a, b) => recentDateValue(a).localeCompare(recentDateValue(b)), limit: 300 }
    )
    return
  }

  if (table === 'weekend_event_cache') {
    syncData.weekend_event_cache = mergeByKey(
      syncData.weekend_event_cache,
      incoming,
      e => e?.event_key || e?.url || (e?.name && e?.event_date ? `${e.name}:${e.event_date}:${e.time || ''}:${e.venue || ''}` : null),
      { sortFn: (a, b) => recentDateValue(a).localeCompare(recentDateValue(b)), limit: 500 }
    )
    return
  }

  if (table === 'daily_schedule') {
    syncData.daily_schedule = mergeVersionedRows(
      syncData.daily_schedule,
      incoming,
      row => row?.date || null,
      (a, b) => recentDateValue(b).localeCompare(recentDateValue(a)),
      365
    )
    return
  }

  if (table === 'weekend_plans') {
    syncData.weekend_plans = mergeVersionedRows(
      syncData.weekend_plans,
      incoming,
      row => row?.weekend_date || null,
      (a, b) => recentDateValue(b).localeCompare(recentDateValue(a)),
      120
    )
    return
  }

  if (table === 'holdings' || table === 'alerts' || table === 'health_alerts') {
    const limits = { holdings: 500, alerts: 500, health_alerts: 500 }
    syncData[table] = mergeVersionedRows(
      syncData[table],
      incoming,
      row => row?.sync_id || (row?.id ? `legacy:${row.id}` : null),
      (a, b) => recentDateValue(b).localeCompare(recentDateValue(a)),
      limits[table]
    )
    return
  }

  // Desktop-owned snapshots: replace intentionally.
  syncData[table] = incoming
}

// --- Independent Data Fetching (runs even when desktop is off) ---

// Crypto ID map for CoinGecko
const CRYPTO_ID_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano',
  DOGE: 'dogecoin', DOT: 'polkadot', AVAX: 'avalanche-2', MATIC: 'matic-network',
  LINK: 'chainlink', UNI: 'uniswap', ATOM: 'cosmos', XRP: 'ripple',
  LTC: 'litecoin', SHIB: 'shiba-inu', ARB: 'arbitrum',
}

async function fetchYahooPrice(symbol) {
  const urls = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      })
      if (!res.ok) continue
      const data = await res.json()
      const result = data?.chart?.result?.[0]
      if (!result?.meta?.regularMarketPrice) continue
      const meta = result.meta
      const closes = result.indicators?.quote?.[0]?.close || []
      const volumes = result.indicators?.quote?.[0]?.volume || []
      const timestamps = result.timestamp || []

      // Build price history entries
      const entries = []
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] == null) continue
        const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0]
        entries.push({
          symbol: meta.symbol || symbol,
          date: d,
          close: Math.round(closes[i] * 100) / 100,
          volume: volumes[i] || 0,
          source: 'yahoo',
        })
      }

      return {
        symbol: meta.symbol || symbol,
        price: meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice,
        entries,
      }
    } catch {}
  }
  return null
}

async function fetchCoinGeckoPrice(coinId) {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`)
    const data = await res.json()
    const coin = data[coinId]
    if (!coin) return null
    return { price: coin.usd, changePercent: coin.usd_24h_change || 0 }
  } catch { return null }
}

async function fetchGoogleNewsRSS(query) {
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MienRelay/1.0)' },
    })
    if (!res.ok) return []
    const xml = await res.text()

    // Simple XML parsing for RSS items
    const items = []
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    let match
    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1]
      const title = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '') || ''
      const link = itemXml.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '') || ''
      const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || ''
      const source = title.match(/ - ([^-]+)$/)?.[1]?.trim() || 'Google News'
      items.push({ title: title.trim(), url: link.trim(), source, published_at: pubDate ? new Date(pubDate).toISOString() : null })
    }
    return items.slice(0, 10)
  } catch { return [] }
}

async function relayRefreshFinance() {
  const watchlist = syncData.watchlist || []
  if (watchlist.length === 0) {
    console.log('  [Relay Cron] No watchlist symbols to refresh')
    return
  }

  console.log(`  [Relay Cron] Refreshing finance data for ${watchlist.length} symbols...`)

  // Fetch stock/ETF prices
  const stocks = watchlist.filter(w => w.type === 'stock' || w.type === 'etf')
  const cryptos = watchlist.filter(w => w.type === 'crypto')
  let newPrices = []
  let priceCount = 0

  for (const stock of stocks) {
    const result = await fetchYahooPrice(stock.symbol)
    if (result?.entries) {
      newPrices.push(...result.entries)
      priceCount++
    }
  }

  for (const crypto of cryptos) {
    const coinId = CRYPTO_ID_MAP[crypto.symbol] || crypto.symbol.toLowerCase()
    const result = await fetchCoinGeckoPrice(coinId)
    if (result) {
      const today = new Date().toISOString().split('T')[0]
      newPrices.push({
        symbol: crypto.symbol,
        date: today,
        close: result.price,
        volume: 0,
        source: 'coingecko',
      })
      priceCount++
    }
  }

  // Merge new prices with existing (keep last 30 days)
  if (newPrices.length > 0) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    // Build map of existing prices for dedup
    const priceMap = new Map()
    for (const p of (syncData.prices || [])) {
      if (p.date >= cutoffStr) priceMap.set(`${p.symbol}:${p.date}`, p)
    }
    for (const p of newPrices) {
      if (p.date >= cutoffStr) priceMap.set(`${p.symbol}:${p.date}`, p)
    }
    syncData.prices = [...priceMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  }

  // Fetch news
  const symbols = watchlist.map(w => w.symbol)
  const queries = ['stock market today', 'cryptocurrency news', ...symbols.slice(0, 5).map(s => `${s} stock`)]
  let newsCount = 0

  const existingUrls = new Set((syncData.news || []).map(n => n.url))
  const newArticles = []

  for (const query of queries) {
    const articles = await fetchGoogleNewsRSS(query)
    for (const article of articles) {
      if (!existingUrls.has(article.url)) {
        const related = symbols.filter(s => article.title.toUpperCase().includes(s.toUpperCase()))
        newArticles.push({
          ...article,
          related_symbols: related.length > 0 ? JSON.stringify(related) : null,
          fetched_at: new Date().toISOString(),
        })
        existingUrls.add(article.url)
        newsCount++
      }
    }
  }

  if (newArticles.length > 0) {
    syncData.news = [...(syncData.news || []), ...newArticles]
    // Keep last 7 days of news
    const newsCutoff = new Date()
    newsCutoff.setDate(newsCutoff.getDate() - 7)
    const newsCutoffStr = newsCutoff.toISOString()
    syncData.news = syncData.news.filter(n => !n.fetched_at || n.fetched_at >= newsCutoffStr)
    // Cap at 200 articles
    if (syncData.news.length > 200) syncData.news = syncData.news.slice(-200)
  }

  syncData.updated_at = new Date().toISOString()
  saveSyncData()
  console.log(`  [Relay Cron] Finance refresh: ${priceCount} prices, ${newsCount} news articles`)
}

async function relayGenerateBriefing() {
  const creds = getCredentials()
  if (!creds) {
    console.log('  [Relay Cron] No AI credentials — skipping briefing')
    return
  }

  const watchlist = syncData.watchlist || []
  const prices = syncData.prices || []
  if (watchlist.length === 0) {
    console.log('  [Relay Cron] No watchlist — skipping briefing')
    return
  }

  // Build market context
  const latestPrices = {}
  for (const p of prices) {
    if (!latestPrices[p.symbol] || p.date > latestPrices[p.symbol].date) {
      latestPrices[p.symbol] = p
    }
  }

  const recentNews = (syncData.news || []).slice(-20).map(n => n.title).join('\n- ')

  const portfolioSummary = watchlist.map(w => {
    const p = latestPrices[w.symbol]
    return p ? `${w.symbol} (${w.type}): $${p.close}` : `${w.symbol}: no data`
  }).join('\n')

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  const prompt = `You are a personal finance analyst. Generate a concise morning market briefing for ${today}.

Portfolio:
${portfolioSummary}

Recent Headlines:
- ${recentNews || 'No recent news'}

Write a brief (3-5 paragraphs) market briefing covering:
1. Key portfolio movers and why
2. Important market themes
3. What to watch today
Be concise, data-driven, and actionable.`

  try {
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }
    if (creds.type === 'api_key') {
      headers['x-api-key'] = creds.key
    } else {
      headers['Authorization'] = `Bearer ${creds.key}`
    }

    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      // 1024 truncated the requested 3-5 paragraph briefing mid-thought.
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })

    let response = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
          }, (res) => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => {
              if (res.statusCode !== 200) {
                const err = new Error(`Claude API returned ${res.statusCode}: ${data.slice(0, 200)}`)
                err.statusCode = res.statusCode
                reject(err)
                return
              }
              resolve(JSON.parse(data))
            })
          })
          req.on('error', reject)
          req.write(body)
          req.end()
        })
        break
      } catch (err) {
        const retryable = err.statusCode === 429 || err.statusCode === 529
        if (!retryable || attempt === 2) throw err
        const delayMs = attempt === 0 ? 2_000 : 8_000
        console.log(`  [Relay Cron] Briefing API ${err.statusCode}; retrying in ${delayMs / 1000}s`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }

    const content = response.content?.[0]?.text || ''
    if (content) {
      const briefing = {
        type: 'morning_finance',
        date: new Date().toISOString().split('T')[0],
        content,
        created_at: new Date().toISOString(),
      }
      // Prepend to briefings (most recent first)
      syncData.briefings = [briefing, ...(syncData.briefings || []).slice(0, 29)]
      syncData.lastBriefingDate = briefing.date
      syncData.updated_at = new Date().toISOString()
      saveSyncData()
      console.log(`  [Relay Cron] Briefing generated (${content.length} chars)`)
    }
  } catch (err) {
    console.error('  [Relay Cron] Briefing generation failed:', err.message)
  }
}

// Schedule relay cron jobs
function initRelayCron() {
  // Refresh finance data every 4 hours
  setInterval(async () => {
    try { await relayRefreshFinance() } catch (err) {
      console.error('  [Relay Cron] Finance refresh error:', err.message)
    }
  }, 4 * 60 * 60 * 1000)

  // Generate once per day after 7 AM; persisted so relay restarts do not duplicate or miss the window.
  setInterval(async () => {
    const now = new Date()
    const hour = now.getHours()
    const today = now.toISOString().split('T')[0]

    if (hour >= 7 && syncData.lastBriefingDate !== today) {
      try { await relayGenerateBriefing() } catch (err) {
        console.error('  [Relay Cron] Briefing error:', err.message)
      }
    }
  }, 30 * 60 * 1000)

  // Run initial finance refresh after 10s startup delay (if data is stale)
  setTimeout(async () => {
    const lastUpdate = syncData.updated_at ? new Date(syncData.updated_at).getTime() : 0
    const staleThreshold = 4 * 60 * 60 * 1000 // 4 hours
    if (Date.now() - lastUpdate > staleThreshold) {
      console.log('  [Relay Cron] Data is stale — running initial finance refresh...')
      try { await relayRefreshFinance() } catch (err) {
        console.error('  [Relay Cron] Initial refresh error:', err.message)
      }
    }
  }, 10000)

  // Strava safety-net sync once per day (webhook handles real-time updates)
  setInterval(async () => {
    if (!stravaTokens) return
    try { await syncStravaToRelay(2) } catch (err) {
      console.error('  [Relay Cron] Strava daily sync error:', err.message)
    }
  }, 24 * 60 * 60 * 1000)

  // Initial Strava sync on boot (last 7 days, after 15s delay)
  setTimeout(async () => {
    if (!stravaTokens) return
    try {
      console.log('  [Relay Cron] Initial Strava sync (last 7 days)...')
      await syncStravaToRelay(7)
    } catch (err) {
      console.error('  [Relay Cron] Initial Strava sync error:', err.message)
    }
  }, 15000)

  console.log('  Relay Cron: finance refresh every 4h, briefing daily at ~7:30 AM, Strava via webhook + daily safety-net')
}

// --- Credential Resolution ---

function resolveAnthropicCredentials({ avoidKey = null } = {}) {
  const candidates = []

  if (process.env.ANTHROPIC_API_KEY) {
    candidates.push({ type: 'api_key', key: process.env.ANTHROPIC_API_KEY, source: 'env:ANTHROPIC_API_KEY' })
  }

  // claude setup-token generates a 1-year OAuth token
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    candidates.push({ type: 'oauth', key: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: 'env:CLAUDE_CODE_OAUTH_TOKEN' })
  }

  const claudeDir = path.join(os.homedir(), '.claude')
  const credPaths = [
    path.join(claudeDir, 'credentials.json'),
    path.join(claudeDir, 'auth.json'),
    path.join(claudeDir, '.credentials.json'),
  ]

  for (const credPath of credPaths) {
    try {
      if (fs.existsSync(credPath)) {
        const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
        const token = data.accessToken || data.access_token ||
                      data.token || data.oauthToken ||
                      (data.claudeAiOauth && data.claudeAiOauth.accessToken)
        if (token) {
          candidates.push({ type: 'oauth', key: token, source: credPath })
        }
      }
    } catch {}
  }

  try {
    const files = fs.readdirSync(claudeDir)
    for (const file of files) {
      if (file.endsWith('.json') && file !== 'settings.json') {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(claudeDir, file), 'utf-8'))
          if (data.sessionKey || data.accessToken || data.access_token) {
            const token = data.sessionKey || data.accessToken || data.access_token
            candidates.push({ type: 'oauth', key: token, source: path.join(claudeDir, file) })
          }
        } catch {}
      }
    }
  } catch {}

  return pickCandidate(candidates, avoidKey, 'Claude')
}

function resolveOpenAICredentials({ avoidKey = null } = {}) {
  const candidates = []
  if (process.env.OPENAI_API_KEY) {
    candidates.push({ type: 'api_key', key: process.env.OPENAI_API_KEY, source: 'env:OPENAI_API_KEY' })
  }

  const codexPaths = [
    path.join(os.homedir(), '.codex', 'auth.json'),
    path.join(os.homedir(), '.config', 'codex', 'auth.json'),
  ]

  for (const credPath of codexPaths) {
    try {
      if (fs.existsSync(credPath)) {
        const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
        const token = data.accessToken || data.access_token || data.token || data.api_key ||
                      data.OPENAI_API_KEY || data.tokens?.access_token
        if (token) {
          candidates.push({ type: 'oauth', key: token, source: credPath })
        }
      }
    } catch {}
  }

  return pickCandidate(candidates, avoidKey, 'OpenAI')
}

// De-dupe candidates by key, skip the one we just failed on, return the first match.
// Logs which credential source ended up being used so it's visible in relay logs.
function pickCandidate(candidates, avoidKey, providerLabel) {
  const seen = new Set()
  for (const c of candidates) {
    if (seen.has(c.key)) continue
    seen.add(c.key)
    if (avoidKey && c.key === avoidKey) continue
    console.log(`  Using ${providerLabel} ${c.type} credentials from ${c.source}`)
    return c
  }
  return null
}

// --- Proxy Logic ---

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

function proxyToAnthropic(body, credentials, res, isStream, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }

  if (credentials.type === 'api_key') {
    headers['x-api-key'] = credentials.key
  } else {
    // Claude CLI OAuth tokens are only accepted when the request looks like
    // it's coming from Claude Code: oauth beta header + identity-prefixed system prompt.
    headers['Authorization'] = `Bearer ${credentials.key}`
    headers['anthropic-beta'] = 'oauth-2025-04-20'

    const userSystem = body.system
    const identityBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY }
    if (!userSystem) {
      body.system = [identityBlock]
    } else if (typeof userSystem === 'string') {
      body.system = [identityBlock, { type: 'text', text: userSystem }]
    } else if (Array.isArray(userSystem)) {
      body.system = [identityBlock, ...userSystem]
    }
  }

  const payload = JSON.stringify(body)

  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      ...headers,
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (upstream) => {
    if ((upstream.statusCode === 401 || upstream.statusCode === 403) && opts.onAuthFailure) {
      if (opts.onAuthFailure(upstream.statusCode)) {
        upstream.resume() // retry took over — drain & free the socket
        return
      }
      // No fallback available: fall through and forward the upstream
      // error verbatim to the client (status + body).
    }
    res.writeHead(upstream.statusCode, {
      'Content-Type': upstream.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    upstream.pipe(res)
  })

  req.on('error', (err) => {
    console.error('Anthropic proxy error:', err.message)
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: `Relay error: ${err.message}` } }))
  })

  req.write(payload)
  req.end()
}

function proxyToOpenAI(body, credentials, res, opts = {}) {
  const openaiBody = {
    model: body.model || 'gpt-4o',
    max_tokens: body.max_tokens || 4096,
    stream: body.stream || false,
    messages: [],
  }

  if (body.system) {
    openaiBody.messages.push({ role: 'system', content: body.system })
  }

  if (body.messages) {
    for (const msg of body.messages) {
      openaiBody.messages.push({ role: msg.role, content: msg.content })
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credentials.key}`,
  }

  const payload = JSON.stringify(openaiBody)

  const req = https.request({
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      ...headers,
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (upstream) => {
    if ((upstream.statusCode === 401 || upstream.statusCode === 403) && opts.onAuthFailure) {
      if (opts.onAuthFailure(upstream.statusCode)) {
        upstream.resume()
        return
      }
      // No fallback. The downstream translation code assumes a 200 OpenAI
      // body, so emit an explicit error response instead of letting the
      // translator silently mangle the 401 body.
      upstream.resume()
      res.writeHead(upstream.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify({ error: { message: `Upstream OpenAI returned ${upstream.statusCode}; no fallback credentials available` } }))
      return
    }
    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      })

      let buffer = ''
      upstream.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            res.write('data: {"type":"message_stop"}\n\n')
            continue
          }
          try {
            const event = JSON.parse(data)
            const delta = event.choices?.[0]?.delta?.content
            if (delta) {
              const anthropicEvent = {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: delta }
              }
              res.write(`data: ${JSON.stringify(anthropicEvent)}\n\n`)
            }
          } catch {}
        }
      })

      upstream.on('end', () => res.end())
    } else {
      let data = ''
      upstream.on('data', chunk => { data += chunk })
      upstream.on('end', () => {
        try {
          const openaiResp = JSON.parse(data)
          if (upstream.statusCode >= 400 || openaiResp.error) {
            res.writeHead(upstream.statusCode || 502, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            res.end(JSON.stringify({
              error: openaiResp.error || { message: 'OpenAI request failed' },
            }))
            return
          }
          const text = openaiResp.choices?.[0]?.message?.content || ''
          const anthropicResp = {
            content: [{ type: 'text', text }],
            model: openaiResp.model,
            usage: openaiResp.usage,
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(JSON.stringify(anthropicResp))
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: { message: 'Failed to parse OpenAI response' } }))
        }
      })
    }
  })

  req.on('error', (err) => {
    console.error('OpenAI proxy error:', err.message)
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: `Relay error: ${err.message}` } }))
  })

  req.write(payload)
  req.end()
}

// --- Cloudflare Tunnel ---

let tunnelProc = null
let tunnelRestartAttempt = 0
let tunnelShuttingDown = false
let tunnelRestartTimer = null

function persistTunnelUrl(url) {
  try {
    fs.writeFileSync(TUNNEL_URL_PATH, url + '\n', { mode: 0o600 })
  } catch (err) {
    console.error('  Failed to persist tunnel URL:', err.message)
  }
}

function startTunnel() {
  if (!TUNNEL_ENABLED) return
  if (tunnelShuttingDown) return

  // Clear any stale URL from a previous run before cloudflared comes up,
  // so consumers (desktop banner, mobile, --print-tunnel-url) don't read
  // a dead URL during the startup window.
  if (currentTunnelUrl === null) {
    try { fs.unlinkSync(TUNNEL_URL_PATH) } catch {}
  }

  console.log('  Starting Cloudflare Tunnel...')
  tunnelProc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  tunnelProc.stderr.on('data', (data) => {
    const line = data.toString()
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (match && match[0] !== currentTunnelUrl) {
      currentTunnelUrl = match[0]
      tunnelStartedAt = Date.now()
      tunnelRestartAttempt = 0
      persistTunnelUrl(currentTunnelUrl)
      console.log('')
      console.log('  ========================================')
      console.log(`  TUNNEL URL: ${currentTunnelUrl}`)
      if (AUTH_TOKEN) console.log(`  TOKEN:      ${AUTH_TOKEN}`)
      console.log('  ========================================')
      console.log(`  Written to ${TUNNEL_URL_PATH}`)
      console.log('  Use this as your Relay URL on any network.')
      console.log('  (Changes each time you restart)')
      console.log('')
    }
  })

  tunnelProc.on('error', (err) => {
    if (err.code === 'ENOENT') {
      // Binary missing — stop respawning, the exit handler will see this flag.
      tunnelShuttingDown = true
      console.log('')
      console.log('  Cloudflare Tunnel not installed. Install it:')
      console.log('    Windows: winget install cloudflare.cloudflared')
      console.log('    Mac:     brew install cloudflare/cloudflare/cloudflared')
      console.log('    Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
      console.log('')
    } else {
      console.error('  Tunnel error:', err.message)
    }
  })

  tunnelProc.on('exit', (code) => {
    tunnelProc = null
    // The URL we were serving is now dead — stop advertising it.
    currentTunnelUrl = null
    tunnelStartedAt = null
    try { fs.unlinkSync(TUNNEL_URL_PATH) } catch {}
    if (tunnelShuttingDown) return
    // Cap restart attempts so a permanently failing tunnel doesn't burn CPU forever.
    if (tunnelRestartAttempt >= 10) {
      console.log('  Tunnel failed 10 times in a row — giving up. Restart the relay manually after fixing cloudflared.')
      return
    }
    const backoff = Math.min(60_000, Math.pow(2, tunnelRestartAttempt) * 1000)
    tunnelRestartAttempt++
    console.log(`  Tunnel exited (code=${code}) — restarting in ${Math.round(backoff / 1000)}s (attempt ${tunnelRestartAttempt})`)
    tunnelRestartTimer = setTimeout(startTunnel, backoff)
  })
}

// One-shot shutdown handler — registered at module load, not per-spawn.
function shutdownTunnel() {
  tunnelShuttingDown = true
  if (tunnelRestartTimer) clearTimeout(tunnelRestartTimer)
  if (tunnelProc) tunnelProc.kill()
}
process.on('SIGINT', () => { shutdownTunnel(); process.exit() })
process.on('SIGTERM', () => { shutdownTunnel(); process.exit() })

// --- Keep-Alive & Resilience ---

// Re-resolve credentials periodically (handles token refresh)
let cachedCreds = null
let credsResolvedAt = 0
const CREDS_TTL = 30 * 60 * 1000 // 30 minutes

function getCredentials({ fresh = false, avoidKey = null } = {}) {
  const now = Date.now()
  if (!fresh && !avoidKey && cachedCreds && (now - credsResolvedAt) < CREDS_TTL) {
    return cachedCreds
  }
  const resolved = AI_PROVIDER === 'openai'
    ? resolveOpenAICredentials({ avoidKey })
    : resolveAnthropicCredentials({ avoidKey })
  // Only update the shared cache for the unconstrained lookup so that a
  // retry doesn't poison the next request's primary credential.
  if (!avoidKey) {
    cachedCreds = resolved
    credsResolvedAt = now
  }
  return resolved
}

function invalidateCreds() {
  cachedCreds = null
  credsResolvedAt = 0
}

// Heartbeat: log uptime and check credentials every 10 minutes
let startTime = Date.now()
setInterval(() => {
  const uptimeMin = Math.floor((Date.now() - startTime) / 60000)
  const creds = getCredentials()
  const status = creds ? `${creds.type} ok` : 'NO CREDENTIALS'
  const tunnel = TUNNEL_ENABLED ? `tunnel=${currentTunnelUrl || 'pending'}` : ''
  console.log(`  [heartbeat] uptime=${uptimeMin}m | ai=${status} | connections=${activeConnections}${tunnel ? ' | ' + tunnel : ''}`)
}, 10 * 60 * 1000)

// Track active connections for heartbeat
let activeConnections = 0

// --- Server ---

const server = http.createServer(async (req, res) => {
  activeConnections++
  res.on('finish', () => { activeConnections-- })
  // CORS preflight (always allowed)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization, anthropic-version',
    })
    res.end()
    return
  }

  // Rate limit check
  if (!checkRateLimit(req, res)) return

  // Expo Go launch shim — bridges iOS Safari to Expo Go's exp+https:// scheme.
  // iOS Camera won't directly open `exps://<host>` from a QR (the scheme is
  // too obscure for Camera's quick-action banner), and recent Expo Go
  // versions removed the manual URL entry from the home screen. Scanning a
  // regular https:// URL works because iOS Camera offers "Open in Safari" —
  // Safari then runs this page, which redirects into Expo Go via the
  // registered URL scheme. Public on purpose; no auth header on the QR path.
  // The Metro tunnel host is whatever your own Cloudflare ingress exposes it
  // as — set METRO_TUNNEL_HOST to match (see mobile/.env).
  if (req.method === 'GET' && req.url === '/expo') {
    const metroHost = process.env.METRO_TUNNEL_HOST || 'metro.example.com'
    const target = `exps://${metroHost}`
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta http-equiv="refresh" content="0;url=${target}">` +
      `<title>Opening Mien in Expo Go…</title>` +
      `<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;font-family:-apple-system,system-ui,sans-serif;background:#000;color:#fff;text-align:center;padding:24px}a{color:#9aa0ff}</style>` +
      `</head><body><div><h2>Opening Mien…</h2><p>If the app doesn't open automatically, tap the link below.</p>` +
      `<p><a href="${target}">Launch in Expo Go</a></p></div>` +
      `<script>location.replace(${JSON.stringify(target)})</script></body></html>`)
    return
  }

  // Health check — requires auth when tunnel is active (no info leak)
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    if (TUNNEL_ENABLED && !AUTH_DISABLED && !checkAuth(req, res)) return
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      status: 'ok',
      service: 'mien-relay',
      provider: AI_PROVIDER,
      version: RELAY_VERSION,
      commit: RELAY_COMMIT,
      strava: stravaTokens
        ? {
            connected: true,
            athlete: stravaTokens.athleteName,
            streamsStored: Object.keys(stravaStreamsStore).length,
            activityDetailsStored: Object.keys(stravaActivityDetailsStore).length,
          }
        : { connected: false },
    }))
    return
  }

  // Tunnel info — same auth gate as /health, for desktop diagnostics
  if (req.method === 'GET' && req.url === '/tunnel-info') {
    if (!AUTH_DISABLED && !checkAuth(req, res)) return
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      enabled: TUNNEL_ENABLED,
      url: currentTunnelUrl,
      since: tunnelStartedAt,
    }))
    return
  }

  // --- Strava OAuth callback (no auth — browser redirect from Strava) ---
  if (req.method === 'GET' && req.url?.startsWith('/strava/callback')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')

    if (error || !code) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body style="background:#000;color:#fff;font-family:system-ui;text-align:center;padding:60px"><h2>Strava authorization denied.</h2><p>You can close this tab.</p></body></html>')
      return
    }

    // We need client_id and client_secret — read from env or strava-config.json
    const stravaConfig = loadStravaConfig()
    if (!stravaConfig) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body style="background:#000;color:#fff;font-family:system-ui;text-align:center;padding:60px"><h2>Error</h2><p>Strava client ID/secret not configured on the server.</p></body></html>')
      return
    }

    try {
      const tokenRes = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: stravaConfig.clientId,
          client_secret: stravaConfig.clientSecret,
          code,
          grant_type: 'authorization_code',
        }),
      })

      if (!tokenRes.ok) {
        const text = await tokenRes.text()
        throw new Error(`Token exchange failed: ${text}`)
      }

      const data = await tokenRes.json()
      const athleteName = `${data.athlete?.firstname || ''} ${data.athlete?.lastname || ''}`.trim()

      stravaTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at,
        athleteId: data.athlete?.id,
        athleteName,
        clientId: stravaConfig.clientId,
        clientSecret: stravaConfig.clientSecret,
      }
      saveStravaTokens()

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="background:#000;color:#fff;font-family:system-ui;text-align:center;padding:60px"><h2>Connected to Strava!</h2><p>Welcome ${athleteName}. You can close this tab.</p><p style="color:#888;margin-top:20px">New workouts sync instantly via webhook.</p></body></html>`)

      // Kick off an initial sync
      syncStravaToRelay(90).catch(err => console.error('  [Strava] Initial sync after auth error:', err.message))
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="background:#000;color:#fff;font-family:system-ui;text-align:center;padding:60px"><h2>Error</h2><p>${err.message}</p></body></html>`)
    }
    return
  }

  // --- Strava Webhook (no auth — Strava sends these directly) ---

  // GET /strava/webhook — Strava subscription validation challenge
  if (req.method === 'GET' && req.url?.startsWith('/strava/webhook')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const mode = url.searchParams.get('hub.mode')
    const challenge = url.searchParams.get('hub.challenge')
    const verifyToken = url.searchParams.get('hub.verify_token')
    const config = loadStravaConfig()
    if (mode === 'subscribe' && challenge && verifyToken === (config?.webhookVerifyToken || 'mien-strava-webhook')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ 'hub.challenge': challenge }))
    } else {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden' }))
    }
    return
  }

  // POST /strava/webhook — incoming activity events from Strava
  if (req.method === 'POST' && req.url === '/strava/webhook') {
    let body = ''
    let bodyTooLarge = false
    req.on('data', chunk => {
      if (bodyTooLarge) return
      if (Buffer.byteLength(body) + chunk.length > 64 * 1024) {
        bodyTooLarge = true
        body = ''
        return
      }
      body += chunk
    })
    req.on('end', async () => {
      if (bodyTooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body too large' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ received: true })) // respond fast — Strava expects <2s
      try {
        const event = JSON.parse(body)
        const config = loadStravaConfig() || {}
        const objectId = Number(event.object_id)
        const aspect = event.aspect_type
        const subscriptionId = event.subscription_id != null ? String(event.subscription_id) : null
        const expectedSubscriptionId = config.webhookSubscriptionId != null ? String(config.webhookSubscriptionId) : null
        const ownerId = event.owner_id != null ? String(event.owner_id) : null
        const expectedOwnerId = stravaTokens?.athleteId != null ? String(stravaTokens.athleteId) : null

        if (event.object_type !== 'activity' || !Number.isFinite(objectId) || !['create', 'update', 'delete'].includes(aspect)) {
          console.warn('  [Strava Webhook] Ignoring malformed event')
          return
        }
        if (expectedSubscriptionId && subscriptionId !== expectedSubscriptionId) {
          console.warn('  [Strava Webhook] Ignoring event with unexpected subscription_id')
          return
        }
        if (expectedOwnerId && ownerId && ownerId !== expectedOwnerId) {
          console.warn('  [Strava Webhook] Ignoring event with unexpected owner_id')
          return
        }
        if (stravaTokens) {
          if (aspect === 'create' || aspect === 'update') {
            console.log(`  [Strava Webhook] ${aspect} event for activity ${objectId}`)
            await syncSingleActivity(objectId)
          } else if (aspect === 'delete') {
            const id = objectId
            let knownActivity = !!stravaActivityDetailsStore[String(id)] || !!stravaStreamsStore[String(id)]
            if (!knownActivity) {
              for (const m of healthData.metrics) {
                if (m.type === 'workout' && m.value?.workouts?.some(w => w.stravaId === id)) {
                  knownActivity = true
                  break
                }
              }
            }
            if (!knownActivity) {
              console.warn(`  [Strava Webhook] Ignoring delete for unknown activity ${id}`)
              return
            }
            for (const m of healthData.metrics) {
              if (m.type === 'workout' && m.value?.workouts) {
                m.value.workouts = m.value.workouts.filter(w => w.stravaId !== id)
                m.source = workoutRowSource(m.value.workouts)
              }
            }
            healthData.metrics = healthData.metrics.filter(m => !(m.type === 'workout' && m.value?.workouts?.length === 0))
            saveHealthData()
            // Also remove stored streams
            if (stravaStreamsStore[String(id)]) {
              delete stravaStreamsStore[String(id)]
              saveStravaStreams()
            }
            console.log(`  [Strava Webhook] Deleted activity ${id}`)
          }
        }
      } catch (err) {
        console.error('  [Strava Webhook] Event handling error:', err.message)
      }
    })
    return
  }

  // --- All routes below require auth ---
  if (!checkAuth(req, res)) return

  // --- Strava API routes (auth required) ---

  // GET /strava/status — check connection
  if (req.method === 'GET' && req.url === '/strava/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    if (stravaTokens) {
      res.end(JSON.stringify({
        connected: true,
        athlete: stravaTokens.athleteName,
        athleteId: stravaTokens.athleteId,
        streamsStored: Object.keys(stravaStreamsStore).length,
        activityDetailsStored: Object.keys(stravaActivityDetailsStore).length,
      }))
    } else {
      res.end(JSON.stringify({ connected: false }))
    }
    return
  }

  // POST /strava/connect — start OAuth (returns URL to open)
  if ((req.method === 'POST' || req.method === 'GET') && req.url?.startsWith('/strava/connect')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const body = req.method === 'POST' ? await readJsonBody(req, res) : {}
    const savedConfig = loadStravaConfig() || {}
    const clientId = body.client_id || url.searchParams.get('client_id') || savedConfig.clientId || process.env.STRAVA_CLIENT_ID
    const clientSecret = body.client_secret || savedConfig.clientSecret || process.env.STRAVA_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: 'Provide Strava credentials in the POST body, relay config, or STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET env vars' }))
      return
    }

    // Save config for the callback to use
    saveStravaConfig({ ...savedConfig, clientId, clientSecret })

    const callbackUrl = getStravaCallbackUrl()
    const authUrl = `${STRAVA_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&response_type=code&scope=read,activity:read&approval_prompt=auto`

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ authUrl, callbackUrl }))
    return
  }

  // POST /strava/disconnect — clear tokens
  if (req.method === 'POST' && req.url === '/strava/disconnect') {
    stravaTokens = null
    saveStravaTokens()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ success: true }))
    return
  }

  // POST /strava/sync?days=90 — trigger manual sync with detailed activity fields and streams
  if (req.method === 'POST' && req.url?.startsWith('/strava/sync')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const days = parseInt(url.searchParams.get('days') || '90')
    const detailed = url.searchParams.get('detailed') !== '0'
    const streamLimit = parseInt(url.searchParams.get('stream_limit') || (days > 365 ? '50' : '25'))
    const activityDetailLimit = parseInt(url.searchParams.get('detail_limit') || String(streamLimit))
    try {
      const result = await syncStravaToRelay(days, { detailed, streamLimit, activityDetailLimit })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // POST /strava/backfill?from=YYYY-MM-DD&to=YYYY-MM-DD — enrich date range with stream data
  if (req.method === 'POST' && req.url?.startsWith('/strava/backfill')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (!from || !to) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: 'Provide from and to as YYYY-MM-DD query params' }))
      return
    }
    try {
      const result = await startBackfillWithStreams(from, to)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // GET /strava/backfill/status — check backfill progress
  if (req.method === 'GET' && req.url === '/strava/backfill/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(backfillState))
    return
  }

  // GET /strava/streams?days=90 — list all stored streams (metadata + data)
  // GET /strava/streams?days=90&meta=1 — metadata only (no raw data, for checking what's available)
  // GET /strava/streams?after=ISO — streams fetched after a timestamp (for incremental sync)
  if (req.method === 'GET' && req.url?.startsWith('/strava/streams') && !req.url?.includes('/strava/streams/')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const days = parseInt(url.searchParams.get('days') || '90')
    const metaOnly = url.searchParams.get('meta') === '1'
    const afterTs = url.searchParams.get('after') // ISO timestamp for incremental sync

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    const results = []
    for (const [activityId, entry] of Object.entries(stravaStreamsStore)) {
      if (entry.date < cutoffStr) continue
      if (afterTs && entry.fetchedAt && entry.fetchedAt <= afterTs) continue
      if (metaOnly) {
        const streamKeys = Object.keys(entry.streams || {})
        const points = entry.streams?.time?.length || entry.streams?.heartrate?.length || 0
        results.push({ activityId: Number(activityId), date: entry.date, name: entry.name, fetchedAt: entry.fetchedAt, streamKeys, points })
      } else {
        results.push({ activityId: Number(activityId), date: entry.date, name: entry.name, fetchedAt: entry.fetchedAt, streams: entry.streams })
      }
    }
    results.sort((a, b) => b.date.localeCompare(a.date))

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ streams: results, count: results.length, totalStored: Object.keys(stravaStreamsStore).length }))
    return
  }

  // GET /strava/streams/:activityId — get raw streams for a single activity
  const streamsMatch = req.method === 'GET' && req.url?.match(/^\/strava\/streams\/(\d+)/)
  if (streamsMatch) {
    const activityId = streamsMatch[1]
    const entry = stravaStreamsStore[activityId]
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: 'No stored streams for this activity' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ activityId: Number(activityId), date: entry.date, name: entry.name, fetchedAt: entry.fetchedAt, streams: entry.streams }))
    return
  }

  // POST /strava/webhook/subscribe — register Strava push subscription
  if (req.method === 'POST' && req.url === '/strava/webhook/subscribe') {
    const stravaConfig = loadStravaConfig()
    if (!stravaConfig) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: 'Strava client credentials not configured' }))
      return
    }
    const verifyToken = stravaConfig.webhookVerifyToken || 'mien-strava-webhook'
    const callbackUrl = getStravaCallbackUrl().replace('/strava/callback', '/strava/webhook')
    try {
      const subRes = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: stravaConfig.clientId,
          client_secret: stravaConfig.clientSecret,
          callback_url: callbackUrl,
          verify_token: verifyToken,
        }),
      })
      const data = await subRes.json()
      if (!subRes.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: data.message || 'Subscription failed', detail: data }))
        return
      }
      saveStravaConfig({ ...stravaConfig, webhookVerifyToken: verifyToken, webhookSubscriptionId: data.id })
      console.log(`  [Strava] Webhook subscription registered (id=${data.id}, callback=${callbackUrl})`)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ subscriptionId: data.id, callbackUrl }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Simple health POST — Apple Shortcuts friendly (flat key-value, no nesting)
  // POST /health/simple?sleep=420&deep=90&rem=100&core=230&hr=68&steps=8500&hrv=45
  //   Optional: rhr, active_energy, spo2, resp_rate, vo2max
  if (req.method === 'POST' && req.url?.startsWith('/health/simple')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]
    const sleep = url.searchParams.get('sleep')
    const deep = url.searchParams.get('deep')
    const rem = url.searchParams.get('rem')
    const core = url.searchParams.get('core')
    const hr = url.searchParams.get('hr')
    const rhr = url.searchParams.get('rhr')
    const steps = url.searchParams.get('steps')
    const hrv = url.searchParams.get('hrv')
    const activeEnergy = url.searchParams.get('active_energy')
    const spo2 = url.searchParams.get('spo2')
    const respRate = url.searchParams.get('resp_rate')
    const vo2max = url.searchParams.get('vo2max')

    const now = new Date().toISOString()
    let added = 0

    if (sleep) {
      const sleepValue = { totalAsleep: parseInt(sleep) }
      if (deep) sleepValue.deep = parseInt(deep)
      if (rem) sleepValue.rem = parseInt(rem)
      if (core) sleepValue.core = parseInt(core)
      upsertHealthMetric({ type: 'sleep', date, value: sleepValue }, now)
      added++
    }
    if (hr) {
      healthData.metrics = healthData.metrics.filter(m => !(m.type === 'heart_rate' && m.date === date))
      healthData.metrics.push({ type: 'heart_rate', date, value: { qty: parseInt(hr) }, synced_at: now })
      added++
    }
    if (rhr) {
      healthData.metrics = healthData.metrics.filter(m => !(m.type === 'resting_heart_rate' && m.date === date))
      healthData.metrics.push({ type: 'resting_heart_rate', date, value: { qty: parseInt(rhr) }, synced_at: now })
      added++
    }
    if (steps) {
      healthData.metrics = healthData.metrics.filter(m => !(m.type === 'steps' && m.date === date))
      healthData.metrics.push({ type: 'steps', date, value: { qty: parseInt(steps) }, synced_at: now })
      added++
    }
    if (hrv) {
      healthData.metrics = healthData.metrics.filter(m => !(m.type === 'hrv' && m.date === date))
      healthData.metrics.push({ type: 'hrv', date, value: { qty: parseInt(hrv) }, synced_at: now })
      added++
    }
    if (activeEnergy) {
      healthData.metrics = healthData.metrics.filter(m => !(m.type === 'active_energy' && m.date === date))
      healthData.metrics.push({ type: 'active_energy', date, value: { qty: parseInt(activeEnergy) }, synced_at: now })
      added++
    }
    if (spo2) {
      healthData.metrics = healthData.metrics.filter(m => !(m.type === 'blood_oxygen' && m.date === date))
      healthData.metrics.push({ type: 'blood_oxygen', date, value: { qty: parseFloat(spo2) }, synced_at: now })
      added++
    }
    if (respRate) {
      healthData.metrics = healthData.metrics.filter(m => !(m.type === 'respiratory_rate' && m.date === date))
      healthData.metrics.push({ type: 'respiratory_rate', date, value: { qty: parseFloat(respRate) }, synced_at: now })
      added++
    }
    if (vo2max) {
      healthData.metrics = healthData.metrics.filter(m => !(m.type === 'vo2_max' && m.date === date))
      healthData.metrics.push({ type: 'vo2_max', date, value: { qty: parseFloat(vo2max) }, synced_at: now })
      added++
    }

    saveHealthData()
    console.log(`  Simple health sync: ${added} metrics for ${date}`)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, added, date }))
    return
  }

  // AutoSleep direct ingest — receives data from an iOS Shortcut that calls
  // AutoSleep's "Get Last Sleep" / "Get Sleep" action. Bypasses Health Auto
  // Export entirely so we get AutoSleep's accurate motion-based numbers
  // instead of Apple Watch's HR-only over-counted ones.
  //
  // Accepts either a single night (object) or an array (for CSV backfill).
  // Each night may use seconds (numeric) or "HH:MM:SS" strings for durations.
  //
  // Recognized fields (matches AutoSleep CSV + Shortcuts dictionary):
  //   bedtime, waketime          — ISO timestamps OR "YYYY-MM-DD HH:MM:SS"
  //   asleep, inBed, awake       — duration (seconds or "HH:MM:SS")
  //   deep, quality              — duration; rem = quality - deep, core = asleep - quality
  //   efficiency                 — percentage 0-100 (informational, derived from asleep/inBed)
  //   sleepBPM, sleepHRV         — averaged values (also stored as heart_rate / hrv if not already present)
  //   date                       — optional override for the wake-date bucket (YYYY-MM-DD)
  if (req.method === 'POST' && req.url?.startsWith('/health/autosleep')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let payload
      try { payload = JSON.parse(body) } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }))
        return
      }

      // Coerce duration to MINUTES. Accepts seconds (number) or "HH:MM:SS" string.
      const toMin = (v) => {
        if (v == null || v === '') return 0
        if (typeof v === 'number') return Math.round(v / 60) // seconds → minutes
        if (typeof v === 'string') {
          const hhmmss = v.match(/^(\d+):(\d{2}):(\d{2})$/)
          if (hhmmss) {
            return parseInt(hhmmss[1]) * 60 + parseInt(hhmmss[2]) + Math.round(parseInt(hhmmss[3]) / 60)
          }
          const n = parseFloat(v)
          if (!isNaN(n)) return Math.round(n / 60)
        }
        return 0
      }
      // Coerce timestamp. Accepts ISO, "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DD HH:MM:SS ±HHMM"
      const toIso = (v) => {
        if (!v) return null
        if (typeof v !== 'string') return null
        const d = new Date(v)
        if (!isNaN(d.getTime())) return d.toISOString()
        const m = v.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/)
        if (m) {
          const d2 = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`)
          if (!isNaN(d2.getTime())) return d2.toISOString()
        }
        // "YYYY-MM-DD HH:MM:SS" treated as local time
        const m2 = v.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/)
        if (m2) {
          const d2 = new Date(`${m2[1]}T${m2[2]}`)
          if (!isNaN(d2.getTime())) return d2.toISOString()
        }
        return null
      }

      const nights = Array.isArray(payload) ? payload : [payload]
      const now = new Date().toISOString()
      let added = 0
      let skipped = 0

      // Build a lookup map for fast dedup (type+date → index)
      const existingIdx = new Map()
      healthData.metrics.forEach((m, i) => existingIdx.set(`${m.type}:${m.date}`, i))

      for (const night of nights) {
        if (!night || typeof night !== 'object') { skipped++; continue }

        // AutoSleep Shortcuts variables are JSON-encoded dicts — unwrap them
        if (typeof night.asleep === 'string' && night.asleep.trim().startsWith('{')) {
          try {
            const asd = JSON.parse(night.asleep)
            if (asd.Sleep != null) night.asleep = Math.round(parseFloat(asd.Sleep) * 3600) // hours → seconds
            if (!night.bedtime && asd.Start) night.bedtime = asd.Start
            if (!night.waketime && asd.Until) night.waketime = asd.Until
          } catch {}
        }

        const sleepStart = toIso(night.bedtime || night.sleepStart || night.start)
        const sleepEnd = toIso(night.waketime || night.sleepEnd || night.end)
        // Wake date is the local date of sleepEnd; fall back to provided date or today
        let date = night.date ? String(night.date).slice(0, 10) : null
        if (!date && sleepEnd) {
          // Use the date portion of sleepEnd in the original local zone if provided
          const raw = night.waketime || night.sleepEnd || ''
          const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/)
          date = m ? m[1] : new Date(sleepEnd).toISOString().slice(0, 10)
        }
        if (!date) { skipped++; continue }

        const totalAsleep = toMin(night.asleep ?? night.totalAsleep)
        if (totalAsleep < 30) { skipped++; continue }
        let inBed = toMin(night.inBed)
        if (!inBed && sleepStart && sleepEnd) {
          const ms = new Date(sleepEnd).getTime() - new Date(sleepStart).getTime()
          if (ms > 0) inBed = Math.round(ms / 60000)
        }
        if (!inBed) inBed = totalAsleep
        const awake = toMin(night.awake) || Math.max(0, inBed - totalAsleep)
        const deep = toMin(night.deep)
        const quality = toMin(night.quality) // AutoSleep "quality" = deep + REM combined
        const rem = quality > deep ? quality - deep : toMin(night.rem)
        const core = totalAsleep > quality ? totalAsleep - quality : toMin(night.core)

        const value = {
          totalAsleep,
          deep,
          rem,
          core,
          awake,
          inBed,
          sleepStart,
          sleepEnd,
          quality: quality || undefined,
          efficiency: typeof night.efficiency === 'number' ? night.efficiency : undefined,
          sleepBPM: typeof night.sleepBPM === 'number' ? night.sleepBPM : undefined,
          sleepHRV: typeof night.sleepHRV === 'number' ? night.sleepHRV : undefined,
          sourceCategory: 'autosleep',
        }
        // Strip undefined for cleaner storage
        for (const k of Object.keys(value)) if (value[k] === undefined) delete value[k]

        const key = `sleep:${date}`
        const idx = existingIdx.get(key)
        const entry = { type: 'sleep', date, value, source: 'autosleep', synced_at: now }
        if (idx !== undefined) {
          // AutoSleep has the accurate total but no stage split — merge so it
          // doesn't wipe a watch/HAE deep/REM breakdown stored for this night.
          healthData.metrics[idx] = mergeSleepEntry(healthData.metrics[idx], entry)
        } else {
          existingIdx.set(key, healthData.metrics.length)
          healthData.metrics.push(entry)
        }
        added++
      }

      saveHealthData()
      console.log(`  AutoSleep ingest: ${added} nights stored, ${skipped} skipped (${nights.length} received)`)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: true, added, skipped, received: nights.length }))
    })
    return
  }

  // Health Auto Export app — receives JSON payload with health metrics
  // The app sends arrays of samples grouped by metric type
  if (req.method === 'POST' && req.url?.startsWith('/health/auto-export')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let payload
      try {
        payload = JSON.parse(body)
      } catch (err) {
        console.error('  Health Auto Export parse error:', err.message)
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }))
        return
      }

      // Respond immediately to avoid Cloudflare tunnel timeout (524)
      // Processing continues asynchronously after response is sent
      const metrics = payload?.data?.metrics || payload?.metrics || []
      if (!Array.isArray(metrics)) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Invalid Health Auto Export payload: metrics must be an array' }))
        return
      }
      const totalSamples = metrics.reduce((sum, m) => sum + (m.data?.length || 0), 0)
      console.log(`  Health Auto Export: received ${metrics.length} metric types, ${totalSamples} total samples — processing async`)
      res.writeHead(202, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: true, accepted: true, metricTypes: metrics.length, samples: totalSamples }))

      // Process in next tick so the response is flushed first
      setImmediate(() => {
        try {
          const now = new Date().toISOString()
          let added = 0
          const sleepSamples = []

          // Accumulator for daily aggregation — sum or average depending on type
          const SUM_TYPES = new Set(['steps', 'active_energy', 'basal_energy', 'flights_climbed', 'exercise_time', 'distance', 'time_in_daylight'])
          // All other types use "latest value" or average
          const dayAccum = new Map()  // key: type:date → { sum, count, min, max }

          // Build a lookup map for fast dedup (type+date → index)
          const existingIdx = new Map()
          healthData.metrics.forEach((m, i) => existingIdx.set(`${m.type}:${m.date}`, i))

          for (const metric of metrics) {
            const name = (metric.name || '').toLowerCase()
            const samples = metric.data || []

            for (const sample of samples) {
              // Normalize date to YYYY-MM-DD — handles both ISO (2026-05-09T20:24:40)
              // and HAE format (2026-05-09 20:24:40 -0500)
              const rawDate = sample.date || ''
              const date = rawDate.slice(0, 10)  // First 10 chars = YYYY-MM-DD
              if (!date || date.length < 10 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue

              let type = null
              let value = null

              // Map Health Auto Export metric names to our types
              if (name.includes('sleep_analysis') || name.includes('sleep analysis')) {
                // HAE ships sleep in two shapes depending on Export mode:
                //
                //  1. "Aggregated" (modern default) — one sample per night,
                //     per-stage durations as top-level numeric fields:
                //       { date, asleep, inBed, core, deep, rem, awake,
                //         sleepStart, sleepEnd, source }
                //     Values are in HOURS by default but the iOS app lets the
                //     user pick minutes; detect by magnitude (> 24 = minutes).
                //
                //  2. "Per-segment" (legacy) — each sample is a single
                //     contiguous sleep stage:
                //       { date, start, end, value: "Deep"|"Core"|"REM"|
                //         "Asleep"|"InBed", qty: <hours> }
                //     Note: HAE uses "start"/"end" for actual timestamps; "date"
                //     is used for night-bucket binning. We aggregate by night below.
                //
                // First sample shape is logged so future format drift is easy
                // to spot in relay-stdout.tmp.
                if (sleepSamples.length === 0) {
                  console.log(`  [Sleep RAW first sample] ${JSON.stringify(sample)}`)
                }

                const isAggregated = (
                  sample.asleep != null || sample.inBed != null ||
                  sample.core   != null || sample.deep  != null ||
                  sample.rem    != null || sample.awake != null
                )

                if (isAggregated) {
                  // Normalize values to MINUTES. Heuristic: a single night
                  // can't exceed 24 hours, so any value > 24 must already be
                  // in minutes; otherwise it's hours and we multiply.
                  const toMin = (v) => {
                    if (v == null || v <= 0) return 0
                    return v > 24 ? v : v * 60
                  }
                  const sleepStart = sample.sleepStart || sample.inBedStart || sample.startDate || sample.start || sample.date
                  const sleepEnd = sample.sleepEnd || sample.inBedEnd || sample.endDate || sample.end || sample.date
                  const sourceRaw = typeof sample.source === 'string' ? sample.source : ''

                  // Emit one synthetic per-stage sample so the night-aggregation
                  // pass below produces the same shape as the legacy path.
                  const push = (stage, mins) => {
                    if (mins > 0) sleepSamples.push({ date, stage, startDate: sleepStart, endDate: sleepEnd, duration: mins, source: sourceRaw })
                  }
                  const deep  = toMin(sample.deep)
                  const rem   = toMin(sample.rem)
                  const core  = toMin(sample.core)
                  const inBed = toMin(sample.inBed)
                  const asleep = toMin(sample.asleep)
                  push('deep', deep)
                  push('rem',  rem)
                  push('core', core)
                  push('inbed', inBed)
                  // Only emit broad "asleep" when no leaf stages came through,
                  // so the night-aggregator doesn't double-count.
                  if (deep === 0 && rem === 0 && core === 0 && asleep > 0) {
                    push('asleep', asleep)
                  }
                  continue
                }

                // Legacy per-segment path
                // HAE per-segment format uses "start"/"end" timestamp fields distinct from
                // "date"/"startDate"/"endDate". Keep date-field for night binning (unchanged),
                // but capture the actual timestamps in segStart/segEnd so the night aggregator
                // can populate sleepStart/sleepEnd correctly.
                const stage = (sample.value || sample.sleepValue || '').toString().toLowerCase()
                const startDate = sample.date || sample.startDate   // used for night-bucket binning
                const endDate = sample.endDate                       // used for night-bucket binning
                const segStart = sample.start || sample.startDate || sample.date
                const segEnd = sample.end || sample.endDate

                // Calculate duration in MINUTES — HAE qty is in HOURS.
                let duration = 0
                if (sample.qty) {
                  duration = sample.qty * 60
                } else if (sample.duration) {
                  duration = sample.duration * 60
                } else if (segStart && segEnd) {
                  duration = (new Date(segEnd).getTime() - new Date(segStart).getTime()) / 60000
                }

                if (sleepSamples.length < 3) {
                  console.log(`  Sleep sample (segment): stage="${stage}", duration=${duration.toFixed(1)}min (qty=${sample.qty}h), start=${segStart}, end=${segEnd}`)
                }

                const sourceRaw = typeof sample.source === 'string' ? sample.source : ''
                sleepSamples.push({ date, stage, startDate, endDate, segStart, segEnd, duration, source: sourceRaw })
                continue
              } else if (name.includes('heart_rate_variability') || name.includes('hrv')) {
                type = 'hrv'
                // HAE may send in seconds (< 1) or milliseconds (> 1) depending on summarize setting
                const rawHrv = sample.qty || 0
                value = { qty: Math.round(rawHrv < 1 ? rawHrv * 1000 : rawHrv) } // normalize to ms
              } else if (name.includes('resting_heart_rate') || name.includes('resting heart rate')) {
                type = 'resting_heart_rate'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('heart_rate') || name.includes('heart rate')) {
                type = 'heart_rate'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('step_count') || name.includes('step count') || name.includes('steps')) {
                type = 'steps'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('oxygen_saturation') || name.includes('oxygen saturation') || name.includes('blood_oxygen') || name.includes('spo2')) {
                type = 'blood_oxygen'
                // HAE may send as 0-1 fraction or 0-100 percentage
                const rawO2 = sample.qty || 0
                value = { qty: Math.round((rawO2 <= 1 ? rawO2 * 100 : rawO2) * 10) / 10 } // normalize to %
              } else if (name.includes('respiratory_rate') || name.includes('respiratory rate')) {
                type = 'respiratory_rate'
                value = { qty: Math.round((sample.qty || 0) * 10) / 10 }
              } else if (name.includes('vo2max') || name.includes('vo2_max') || name.includes('vo2 max')) {
                type = 'vo2_max'
                value = { qty: Math.round((sample.qty || 0) * 10) / 10 }
              } else if (name.includes('active_energy') || name.includes('active energy')) {
                type = 'active_energy'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('flights_climbed')) {
                type = 'flights_climbed'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('walking_running_distance') || name.includes('walking running distance')) {
                type = 'distance'
                value = { qty: Math.round((sample.qty || 0) * 100) / 100 }
              } else if (name.includes('apple_exercise_time') || name.includes('exercise_time')) {
                type = 'exercise_time'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('basal_energy') || name.includes('basal energy')) {
                type = 'basal_energy'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('walking_heart_rate') || name.includes('walking heart rate')) {
                type = 'walking_heart_rate'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('sleeping_wrist_temperature') || name.includes('wrist_temperature')) {
                type = 'wrist_temperature'
                value = { qty: Math.round((sample.qty || 0) * 100) / 100 }
              } else if (name.includes('cardio_recovery')) {
                type = 'cardio_recovery'
                value = { qty: Math.round(sample.qty || 0) }
              } else if (name.includes('time_in_daylight')) {
                type = 'time_in_daylight'
                value = { qty: Math.round(sample.qty || 0) }
              }

              if (!type || !value) continue

              // Accumulate per day instead of storing each sample
              const key = `${type}:${date}`
              const qty = value.qty || 0
              if (!dayAccum.has(key)) {
                dayAccum.set(key, { type, date, sum: 0, count: 0, min: qty, max: qty })
              }
              const acc = dayAccum.get(key)
              acc.sum += qty
              acc.count++
              if (qty < acc.min) acc.min = qty
              if (qty > acc.max) acc.max = qty
            }
          }

          // Write aggregated daily values
          for (const [key, acc] of dayAccum) {
            let value
            if (SUM_TYPES.has(acc.type)) {
              value = { qty: Math.round(acc.sum) }
            } else if (acc.type === 'heart_rate') {
              value = { qty: Math.round(acc.sum / acc.count), min: Math.round(acc.min), max: Math.round(acc.max), samples: acc.count }
            } else if (acc.type === 'hrv' || acc.type === 'resting_heart_rate') {
              // Preserve min/max for HRV and resting HR (useful for daily range analysis)
              const avg = Math.round((acc.sum / acc.count) * 10) / 10
              value = acc.count > 1
                ? { qty: avg, min: Math.round(acc.min * 10) / 10, max: Math.round(acc.max * 10) / 10, samples: acc.count }
                : { qty: avg }
            } else {
              // Average for blood_oxygen, respiratory_rate, vo2_max, etc.
              value = { qty: Math.round((acc.sum / acc.count) * 10) / 10 }
            }

            const idx = existingIdx.get(key)
            if (idx !== undefined) {
              healthData.metrics[idx] = { type: acc.type, date: acc.date, value, source: 'health_auto_export', synced_at: now }
            } else {
              existingIdx.set(key, healthData.metrics.length)
              healthData.metrics.push({ type: acc.type, date: acc.date, value, source: 'health_auto_export', synced_at: now })
            }
            added++
          }

          // Aggregate sleep samples by night
          console.log(`  Sleep samples collected: ${sleepSamples.length}`)
          if (sleepSamples.length > 0) {
            // Source-aware filter: Apple Watch / Pixel Watch native sleep tracking
            // over-reports asleep time by 2-3h per night (counts awake-in-bed as
            // Core sleep). AutoSleep's motion-based detection is the accurate
            // source. When both sources have samples in the same payload, drop
            // watch samples and keep AutoSleep only. Mirrors the desktop fix in
            // src/main/services/health/health-export.service.ts.
            const sourceCat = (raw) => {
              if (typeof raw !== 'string' || !raw) return 'other'
              const s = raw.toLowerCase()
              if (s.includes('autosleep')) return 'autosleep'
              if (s.includes('watch')) return 'watch'
              return 'other'
            }
            const uniqueSources = Array.from(new Set(sleepSamples.map(s => s.source || '(unknown)')))
            console.log(`  Sleep sources in payload: ${uniqueSources.join(', ')}`)
            const hasAutoSleep = sleepSamples.some(s => sourceCat(s.source) === 'autosleep')
            const dominantCategory = (() => {
              if (hasAutoSleep) return 'autosleep'
              const watchCount = sleepSamples.filter(s => sourceCat(s.source) === 'watch').length
              return watchCount > 0 ? 'watch' : 'other'
            })()
            let workingSamples = sleepSamples
            if (hasAutoSleep) {
              const before = sleepSamples.length
              workingSamples = sleepSamples.filter(s => sourceCat(s.source) !== 'watch')
              if (workingSamples.length < before) {
                console.log(`  Sleep: preferring AutoSleep, dropped ${before - workingSamples.length} watch samples`)
              }
            }

            // Two-pass approach to avoid double-counting:
            // HAE sends both broad "Asleep" intervals AND leaf stages (Core/Deep/REM).
            // The "Asleep" interval overlaps the leaf stages, so we only use it as fallback
            // when no leaf stages exist for that night.

            // Pass 1: collect all samples per night, separating broad "asleep" from leaf stages
            const nights = {}
            for (const s of workingSamples) {
              // Bin by the local wake date (date of endDate).
              const endRaw = s.endDate || s.startDate
              const nightDate = localDateOf(endRaw)
              if (!nightDate) continue

              if (!nights[nightDate]) {
                nights[nightDate] = {
                  deep: 0, rem: 0, core: 0, inBed: 0, awake: 0, broadAsleep: 0,
                  hasLeafStages: false, sleepStart: null, sleepEnd: null
                }
              }
              const n = nights[nightDate]
              const mins = s.duration || 0
              const stage = s.stage

              // Classify stage
              if (stage === '4' || stage.includes('deep')) {
                n.deep += mins; n.hasLeafStages = true
              } else if (stage === '5' || stage.includes('rem')) {
                n.rem += mins; n.hasLeafStages = true
              } else if (stage === '3' || stage.includes('core')) {
                n.core += mins; n.hasLeafStages = true
              } else if (stage === '1' || stage === 'asleep' || stage.includes('unspecified')) {
                // Broad "asleep" — might overlap leaf stages, save separately
                n.broadAsleep += mins
              } else if (stage === '0' || stage.includes('inbed') || stage.includes('in bed')) {
                n.inBed += mins
              } else if (stage === '2' || stage.includes('awake')) {
                n.awake += mins
              }

              // Prefer actual segment timestamps (segStart/segEnd) over date-field fallback
              const trackStart = s.segStart || s.startDate
              const trackEnd = s.segEnd || s.endDate
              if (trackStart && (!n.sleepStart || trackStart < n.sleepStart)) n.sleepStart = trackStart
              if (trackEnd && (!n.sleepEnd || trackEnd > n.sleepEnd)) n.sleepEnd = trackEnd
            }

            // Pass 2: compute totalAsleep and inBed
            for (const n of Object.values(nights)) {
              if (n.hasLeafStages) {
                n.totalAsleep = n.deep + n.rem + n.core
              } else {
                // No leaf stages (older data or basic tracking) — use broad asleep as core
                n.totalAsleep = n.broadAsleep
                n.core = n.broadAsleep
              }
              // Apple Watch doesn't emit an inBed stage — derive it from timestamps or stages
              if (n.inBed === 0) {
                if (n.sleepStart && n.sleepEnd) {
                  const ms = new Date(n.sleepEnd).getTime() - new Date(n.sleepStart).getTime()
                  if (ms > 0) n.inBed = Math.round(ms / 60000)
                }
                // If timestamps still don't give us inBed, add awake time to totalAsleep
                if (n.inBed === 0) n.inBed = n.totalAsleep + n.awake
              }
            }

            const nightCount = Object.keys(nights).length
            console.log(`  Sleep nights found: ${nightCount}`)
            // Log a sample night
            const sampleNight = Object.entries(nights)[0]
            if (sampleNight) {
              console.log(`  Sample night ${sampleNight[0]}: totalAsleep=${sampleNight[1].totalAsleep.toFixed(1)}, deep=${sampleNight[1].deep.toFixed(1)}, rem=${sampleNight[1].rem.toFixed(1)}, core=${sampleNight[1].core.toFixed(1)}, inBed=${sampleNight[1].inBed.toFixed(1)}`)
            }

            for (const [date, data] of Object.entries(nights)) {
              if (data.totalAsleep < 30) continue
              const key = `sleep:${date}`
              const idx = existingIdx.get(key)
              const totalAsleepRounded = Math.round(data.totalAsleep)
              const inBedRounded = Math.round(data.inBed)
              const awakeRounded = Math.round(data.awake) || Math.max(0, inBedRounded - totalAsleepRounded)
              const coreRounded = Math.round(data.core)
              const suspectWatchOvercount =
                dominantCategory === 'watch' &&
                totalAsleepRounded > 0 &&
                coreRounded / totalAsleepRounded > 0.7 &&
                awakeRounded / Math.max(inBedRounded, 1) < 0.05
              const entry = {
                type: 'sleep', date,
                value: {
                  totalAsleep: totalAsleepRounded,
                  deep: Math.round(data.deep),
                  rem: Math.round(data.rem),
                  core: coreRounded,
                  awake: awakeRounded,
                  inBed: inBedRounded,
                  sleepStart: data.sleepStart,
                  sleepEnd: data.sleepEnd,
                  sourceCategory: dominantCategory,
                  ...(suspectWatchOvercount ? { suspectWatchOvercount: true } : {}),
                },
                source: 'health_auto_export',
                synced_at: now,
              }
              if (idx !== undefined) {
                // Merge rather than blind-overwrite: a stage-less nap fragment must
                // not wipe a complete staged night, and a watch breakdown should be
                // grafted onto an existing AutoSleep total for the same wake-date.
                healthData.metrics[idx] = mergeSleepEntry(healthData.metrics[idx], entry)
              } else {
                existingIdx.set(key, healthData.metrics.length)
                healthData.metrics.push(entry)
              }
              added++
            }
          }

          // Clean up existing data: normalize any full-timestamp dates to YYYY-MM-DD
          // and re-aggregate duplicates from previous buggy imports
          const preCleanCount = healthData.metrics.length
          const cleanMap = new Map()
          for (const m of healthData.metrics) {
            // Normalize date to YYYY-MM-DD
            const normDate = m.date.slice(0, 10)
            if (normDate !== m.date) m.date = normDate

            const key = `${m.type}:${m.date}`
            // For duplicates, keep the latest (by synced_at) or the one with more data
            const existing = cleanMap.get(key)
            if (!existing || (m.synced_at && (!existing.synced_at || m.synced_at > existing.synced_at))) {
              cleanMap.set(key, m)
            }
          }
          healthData.metrics = Array.from(cleanMap.values())

          // Remove outliers / bad data
          const preOutlierCount = healthData.metrics.length
          healthData.metrics = healthData.metrics.filter(m => {
            const v = m.value
            if (!v || typeof v !== 'object') return true
            const qty = v.qty || 0
            const type = m.type

            // Remove zero-value entries (empty syncs)
            if (['heart_rate', 'steps', 'active_energy', 'basal_energy', 'distance',
                 'exercise_time', 'flights_climbed', 'time_in_daylight'].includes(type) && qty === 0) return false

            // Remove clearly impossible values
            if (type === 'hrv' && (qty > 300 || qty <= 0)) return false           // HRV > 300ms is implausible
            if (type === 'blood_oxygen' && (qty > 100 || qty < 50)) return false   // SpO2 must be 50-100%
            if (type === 'heart_rate' && (qty > 220 || qty <= 0)) return false     // HR must be 1-220
            if (type === 'resting_heart_rate' && (qty > 120 || qty < 30)) return false
            if (type === 'respiratory_rate' && (qty > 50 || qty < 4)) return false
            if (type === 'vo2_max' && (qty > 90 || qty <= 0)) return false

            // Sleep: remove ghost records and impossibly long nights
            if (type === 'sleep') {
              const ta = v.totalAsleep || 0
              if (ta <= 1 || ta > 840) return false  // < 1 min or > 14 hours
            }

            return true
          })
          const outliersRemoved = preOutlierCount - healthData.metrics.length
          if (outliersRemoved > 0) console.log(`  Outliers removed: ${outliersRemoved}`)

          // Keep up to 10 years of data for historical backfill/trends.
          const cutoff = new Date()
          cutoff.setFullYear(cutoff.getFullYear() - 10)
          const cutoffStr = cutoff.toISOString().split('T')[0]
          healthData.metrics = healthData.metrics.filter(m => m.date >= cutoffStr)

          saveHealthData()
          const cleaned = preCleanCount - healthData.metrics.length
          console.log(`  Health Auto Export: processed ${added} metrics, cleaned ${cleaned} duplicates, total stored: ${healthData.metrics.length}`)
        } catch (err) {
          console.error('  Health Auto Export processing error:', err.message)
        }
      })
    })
    return
  }

  // Health data POST — receives data from Apple Shortcuts or desktop
  if (req.method === 'POST' && req.url === '/health/sync') {
    try {
        const parsed = await readJsonBody(req, res, LARGE_JSON_BODY_LIMIT)
        const metrics = parsed.metrics || parsed
        if (!Array.isArray(metrics)) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: 'Expected { metrics: [...] } or an array' }))
          return
        }

        const now = new Date().toISOString()
        let added = 0
        for (const m of metrics) {
          if (!m.type || !m.date) continue
          // Defensive: if a client pushed a sleep row with sleepEnd, re-bin it
          // by the local wake date so the relay never holds onset-dated rows.
          if (m.type === 'sleep') {
            const v = typeof m.value === 'string' ? safeParse(m.value) : m.value
            const endRaw = v && (v.sleepEnd || v.end || v.endDate)
            if (endRaw) {
              const wake = localDateOf(endRaw)
              if (wake) m.date = wake
            }
            // Compute inBed from timestamps if missing (Pixel Watch data has inBed: 0)
            if (v && !v.inBed && v.sleepStart && v.sleepEnd) {
              const ms = new Date(v.sleepEnd).getTime() - new Date(v.sleepStart).getTime()
              if (ms > 0) v.inBed = Math.round(ms / 60000)
              if (typeof m.value === 'string') m.value = JSON.stringify(v)
              else m.value = v
            }
          }
          if (m.type === 'workout') {
            const v = typeof m.value === 'string' ? safeParse(m.value) : m.value
            if (Array.isArray(v?.workouts)) {
              upsertWorkoutRow(m.date, v.workouts)
              added++
              continue
            }
          }
          upsertHealthMetric(m, now)
          added++
        }

        // Keep enough history for the desktop historical backfill while
        // bounding the relay file size.
        const cutoff = new Date()
        cutoff.setFullYear(cutoff.getFullYear() - 10)
        const cutoffStr = cutoff.toISOString().split('T')[0]
        healthData.metrics = healthData.metrics.filter(m => m.date >= cutoffStr)

        saveHealthData()
        console.log(`  Health sync: received ${added} metrics`)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: true, added, total: healthData.metrics.length }))
      } catch (err) {
        if (res.writableEnded) return
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    return
  }

  // Health trends — monthly aggregates for historical analysis
  if (req.method === 'GET' && req.url?.startsWith('/health/trends')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const months = parseInt(url.searchParams.get('months') || '36')

    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    const filtered = healthData.metrics.filter(m => m.date >= cutoffStr)

    // Group by month + type, compute aggregates
    const monthlyBuckets = {}

    for (const m of filtered) {
      const month = m.date.slice(0, 7) // YYYY-MM
      const key = `${month}:${m.type}`

      if (!monthlyBuckets[key]) {
        monthlyBuckets[key] = { month, type: m.type, values: [], sum: 0, count: 0 }
      }

      const bucket = monthlyBuckets[key]
      let qty = 0

      if (typeof m.value === 'object') {
        if (m.type === 'sleep') {
          qty = m.value.totalAsleep || m.value.asleep || 0
        } else {
          qty = m.value.qty || m.value.value || 0
        }
      } else if (typeof m.value === 'number') {
        qty = m.value
      }

      if (qty > 0) {
        bucket.values.push(qty)
        bucket.sum += qty
        bucket.count++
      }

      // For sleep, also track stages
      if (m.type === 'sleep' && typeof m.value === 'object') {
        if (!bucket.deepSum) { bucket.deepSum = 0; bucket.remSum = 0; bucket.coreSum = 0; bucket.inBedSum = 0 }
        bucket.deepSum += m.value.deep || 0
        bucket.remSum += m.value.rem || 0
        bucket.coreSum += m.value.core || 0
        bucket.inBedSum += m.value.inBed || 0
      }
    }

    // Build response: monthly averages per type
    const trends = {}
    for (const bucket of Object.values(monthlyBuckets)) {
      const b = bucket
      if (!trends[b.type]) trends[b.type] = []

      const entry = {
        month: b.month,
        avg: b.count > 0 ? Math.round((b.sum / b.count) * 10) / 10 : 0,
        count: b.count,
      }

      // Add sleep stage breakdowns
      if (b.type === 'sleep' && b.deepSum !== undefined) {
        entry.avgDeep = b.count > 0 ? Math.round(b.deepSum / b.count) : 0
        entry.avgRem = b.count > 0 ? Math.round(b.remSum / b.count) : 0
        entry.avgCore = b.count > 0 ? Math.round(b.coreSum / b.count) : 0
        entry.avgInBed = b.count > 0 ? Math.round(b.inBedSum / b.count) : 0
        // Efficiency
        entry.avgEfficiency = b.inBedSum > 0 ? Math.round((b.sum / b.inBedSum) * 1000) / 10 : 0
      }

      trends[b.type].push(entry)
    }

    // Sort each type by month ascending
    for (const type of Object.keys(trends)) {
      trends[type].sort((a, b) => a.month.localeCompare(b.month))
    }

    // Summary stats
    const sleepTrend = trends.sleep || []
    const summary = {
      totalMonths: new Set(Object.values(monthlyBuckets).map(b => b.month)).size,
      totalDataPoints: filtered.length,
      metricTypes: Object.keys(trends),
    }

    if (sleepTrend.length >= 2) {
      const recent3 = sleepTrend.slice(-3)
      const oldest3 = sleepTrend.slice(0, 3)
      const recentAvg = recent3.reduce((s, m) => s + m.avg, 0) / recent3.length
      const oldestAvg = oldest3.reduce((s, m) => s + m.avg, 0) / oldest3.length
      summary.sleepTrendDirection = recentAvg > oldestAvg ? 'improving' : recentAvg < oldestAvg ? 'declining' : 'stable'
      summary.recentAvgSleep = Math.round(recentAvg * 10) / 10
      summary.oldestAvgSleep = Math.round(oldestAvg * 10) / 10
    }

    console.log(`  Health trends: ${summary.totalDataPoints} points across ${summary.totalMonths} months`)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ trends, summary }))
    return
  }

  // Health data GET — mobile/desktop pulls latest data
  // Clean up bad/outlier health data
  if (req.method === 'POST' && req.url === '/health/cleanup') {
    const before = healthData.metrics.length
    const removed = { hrv: 0, blood_oxygen: 0, heart_rate: 0, sleep: 0, other: 0 }

    healthData.metrics = healthData.metrics.filter(m => {
      const val = m.value
      const qty = typeof val === 'object' ? (val.qty ?? val.value ?? null) : null

      if (m.type === 'hrv' && qty !== null && (qty > 300 || qty <= 0)) { removed.hrv++; return false }
      if (m.type === 'blood_oxygen' && qty !== null && (qty > 100 || qty < 50)) { removed.blood_oxygen++; return false }
      if (m.type === 'heart_rate' && qty !== null && (qty > 220 || qty <= 0)) { removed.heart_rate++; return false }
      if (m.type === 'sleep' && typeof val === 'object') {
        const ta = val.totalAsleep || val.asleep || 0
        if (ta <= 1 || ta > 840) { removed.sleep++; return false }
      }
      return true
    })

    const after = healthData.metrics.length
    const totalRemoved = before - after
    if (totalRemoved > 0) saveHealthData()

    console.log(`  Cleanup: removed ${totalRemoved} bad records (HRV: ${removed.hrv}, SpO2: ${removed.blood_oxygen}, HR: ${removed.heart_rate}, Sleep: ${removed.sleep})`)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, before, after, removed: totalRemoved, detail: removed }))
    return
  }

  // Sleep analysis — serves pre-computed analysis from desktop
  if (req.method === 'GET' && req.url === '/sleep/analysis') {
    const etag = `"sleep-${sleepAnalysisHash}"`
    if (handleETag(req, res, etag)) return
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'ETag': etag })
    res.end(JSON.stringify({ analysis: cachedSleepAnalysis, sleepNeedProfile: cachedSleepNeedProfile }))
    return
  }

  // Desktop pushes its computed sleep analysis
  if (req.method === 'POST' && req.url === '/sleep/analysis') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        cachedSleepAnalysis = data.analysis || null
        cachedSleepNeedProfile = data.sleepNeedProfile || null
        saveSleepAnalysisCache()
        console.log(`[Health] Sleep analysis + need profile cached from desktop`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  if (req.method === 'GET' && req.url?.startsWith('/health/data')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const type = url.searchParams.get('type')
    const days = parseInt(url.searchParams.get('days') || '14')

    // ETag check — use health data hash + query params for cache key
    const etag = `"health-${healthDataHash}-${days}-${type || 'all'}"`
    if (handleETag(req, res, etag)) return

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    let results = healthData.metrics.filter(m => m.date >= cutoffStr)
    if (type) {
      results = results.filter(m => m.type === type)
    }
    results.sort((a, b) => b.date.localeCompare(a.date))
    const dates = results.map(m => m.date).filter(Boolean).sort()

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'ETag': etag })
    res.end(JSON.stringify({
      metrics: results,
      count: results.length,
      requestedDays: days,
      type: type || null,
      earliestDate: dates[0] || null,
      latestDate: dates[dates.length - 1] || null,
    }))
    return
  }

  // General sync push (desktop pushes bulk data)
  if (req.method === 'POST' && req.url === '/sync/push') {
      try {
        const parsed = await readJsonBody(req, res, LARGE_JSON_BODY_LIMIT)
        let totalAdded = 0

        if (parsed.health && Array.isArray(parsed.health)) {
          const now = new Date().toISOString()
          for (const m of parsed.health) {
            if (!m.type || !m.date) continue
            if (m.type === 'workout' && Array.isArray(m.value?.workouts)) {
              upsertWorkoutRow(m.date, m.value.workouts)
              totalAdded++
              continue
            }
            upsertHealthMetric(m, now)
            totalAdded++
          }
          saveHealthData()
        }

        console.log(`  Sync push: received ${totalAdded} items`)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: true, added: totalAdded }))
      } catch (err) {
        if (res.writableEnded) return
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    return
  }

  // General sync pull (health only — legacy)
  if (req.method === 'GET' && req.url?.startsWith('/sync/pull') && !req.url?.startsWith('/sync/pull-all')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const days = parseInt(url.searchParams.get('days') || '14')
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    const health = healthData.metrics.filter(m => m.date >= cutoffStr)
    health.sort((a, b) => b.date.localeCompare(a.date))

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ health }))
    return
  }

  // Full sync push — desktop pushes all table data
  if (req.method === 'POST' && req.url === '/sync/push-all') {
      try {
        const parsed = await readJsonBody(req, res, LARGE_JSON_BODY_LIMIT)
        let counts = ''
        await withDataWriteLock(async () => {
        const tables = ['watchlist', 'prices', 'news', 'briefings', 'chat_messages', 'weekend_plans', 'weekend_event_cache', 'daily_schedule', 'saved_restaurants', 'restaurant_visits', 'holdings', 'alerts', 'health_alerts', 'fundamentals']
        for (const table of tables) {
          if (parsed[table] !== undefined) {
            mergeSyncTable(table, parsed[table])
          }
        }
        syncData.updated_at = new Date().toISOString()
        saveSyncData()

        // Also store health data if included.
        // MERGE per (type, date) instead of wholesale-replacing. Desktop pushes
        // INCREMENTALLY (only rows imported since last checkpoint, see
        // pushAllToRelay in src/main/services/sync.service.ts), so a replace
        // would wipe HAE history and any older data desktop hasn't seen yet.
        if (parsed.health && Array.isArray(parsed.health)) {
          const incoming = parsed.health
          const now = new Date().toISOString()
          const before = healthData.metrics.length
          if (incoming.length > 0) {
            // Index existing rows by `${type}:${date}` for O(1) dedup
            const byKey = new Map()
            for (const m of healthData.metrics) {
              if (m && m.type && m.date) byKey.set(`${m.type}:${m.date}`, m)
            }
            for (const m of incoming) {
              if (!m || !m.type || !m.date) continue
              if (m.type === 'workout' && Array.isArray(m.value?.workouts)) {
                const existing = byKey.get(`${m.type}:${m.date}`)
                const existingWorkouts = Array.isArray(existing?.value?.workouts) ? existing.value.workouts : []
                const merged = mergeWorkouts(existingWorkouts, m.value.workouts)
                byKey.set(`${m.type}:${m.date}`, {
                  ...m,
                  value: { workouts: merged },
                  source: workoutRowSource(merged),
                  synced_at: now,
                })
                continue
              }
              const key = `${m.type}:${m.date}`
              const existing = byKey.get(key)
              byKey.set(key, m.type === 'sleep'
                ? mergeSleepMetric(existing, { ...m, synced_at: now })
                : { ...m, synced_at: now })
            }
            healthData.metrics = Array.from(byKey.values())
            saveHealthData()
          }
          console.log(`  [Sync] Health merge: +${incoming.length} incoming, ${before} -> ${healthData.metrics.length} total`)
        }

        counts = tables.map(t => `${t}: ${(syncData[t] || []).length}`).join(', ')
        })
        console.log(`  [Sync] Push received: ${counts}`)

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: true, updated_at: syncData.updated_at }))
      } catch (err) {
        if (res.writableEnded) return
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    return
  }

  // Full sync pull — mobile pulls all data
  if (req.method === 'GET' && req.url?.startsWith('/sync/pull-all')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const includeHealth = url.searchParams.get('includeHealth') !== 'false'
    const healthDays = parseInt(url.searchParams.get('healthDays') || '0')
    const since = url.searchParams.get('since')

    // ETag check — skip response if data hasn't changed
    const etag = `"sync-${syncDataHash}-${includeHealth ? healthDataHash : 'no'}-${healthDays}-${since || ''}"`
    if (handleETag(req, res, etag)) return

    let health = []
    if (includeHealth) {
      health = healthData.metrics
      if (healthDays > 0) {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - healthDays)
        const cutoffStr = cutoff.toISOString().split('T')[0]
        health = health.filter(m => m.date >= cutoffStr)
      }
      if (since) {
        health = health.filter(m => !m.synced_at || m.synced_at >= since)
      }
    }

    const response = {
      ...syncData,
      health,
      health_included: includeHealth,
      health_count: health.length,
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'ETag': etag })
    res.end(JSON.stringify(response))
    return
  }

  // Sync push from mobile — push specific tables back to relay
  if (req.method === 'POST' && req.url === '/sync/push-mobile') {
      try {
        const parsed = await readJsonBody(req, res)
        const updated = await withDataWriteLock(async () => {
        // Mobile can push: saved_restaurants, restaurant_visits, chat_messages, events, schedules, weekend plans
        const mobileWritable = ['saved_restaurants', 'restaurant_visits', 'chat_messages', 'weekend_event_cache', 'daily_schedule', 'weekend_plans']
        let updated = []
        for (const table of mobileWritable) {
          if (parsed[table] && Array.isArray(parsed[table])) {
            // Merge by unique key
            if (table === 'saved_restaurants') {
              // Merge by place_id
              const existing = new Map((syncData[table] || []).map(r => [r.place_id, r]))
              for (const item of parsed[table]) {
                if (!item?.place_id) continue
                existing.set(item.place_id, mergeRestaurantRow(existing.get(item.place_id), item))
              }
              syncData[table] = [...existing.values()]
            } else if (table === 'restaurant_visits') {
              syncData[table] = mergeRestaurantVisits(syncData[table], parsed[table])
            } else if (table === 'chat_messages') {
              // Append new messages (dedupe by content+created_at)
              const existingKeys = new Set((syncData[table] || []).map(m => `${m.role}:${m.created_at}:${m.content?.slice(0, 50)}`))
              for (const msg of parsed[table]) {
                const key = `${msg.role}:${msg.created_at}:${msg.content?.slice(0, 50)}`
                if (!existingKeys.has(key)) {
                  syncData[table].push(msg)
                  existingKeys.add(key)
                }
              }
            } else if (table === 'weekend_event_cache' || table === 'daily_schedule' || table === 'weekend_plans') {
              mergeSyncTable(table, parsed[table])
            }
            updated.push(table)
          }
        }
        syncData.updated_at = new Date().toISOString()
        saveSyncData()
        return updated
        })

        console.log(`  [Sync] Mobile push: ${updated.join(', ') || 'nothing'}`)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: true, updated }))
      } catch (err) {
        if (res.writableEnded) return
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    return
  }

  // Manual trigger: refresh finance data now
  if (req.method === 'POST' && req.url === '/relay/refresh-finance') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, message: 'Finance refresh started' }))
    setImmediate(async () => {
      try { await relayRefreshFinance() } catch (err) {
        console.error('  [Relay] Manual finance refresh error:', err.message)
      }
    })
    return
  }

  // Manual trigger: generate briefing now
  if (req.method === 'POST' && req.url === '/relay/generate-briefing') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, message: 'Briefing generation started' }))
    setImmediate(async () => {
      try { await relayGenerateBriefing() } catch (err) {
        console.error('  [Relay] Manual briefing error:', err.message)
      }
    })
    return
  }

  // AI proxy endpoint
  if (req.method === 'POST' && (req.url === '/v1/messages' || req.url === '/api/chat')) {
    console.log('  [AI] Request received:', req.url)
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        console.log('  [AI] Model:', parsed.model, '| Stream:', !!parsed.stream)

        let creds = getCredentials()
        if (!creds) {
          // Force re-resolve in case token file was just created
          creds = getCredentials({ fresh: true })
          if (!creds) {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
            res.end(JSON.stringify({ error: { message: `No ${AI_PROVIDER} credentials found. See relay SETUP.md.` } }))
            return
          }
        }

        // Try once with current creds; on 401/403 from upstream, invalidate
        // the cache, re-read from disk, and fall back to a different
        // credential source (e.g. API key after OAuth fails). Bail after one
        // retry so a permanently-bad provider doesn't burn requests.
        const triedKeys = new Set()
        const attempt = (activeCreds) => {
          triedKeys.add(activeCreds.key)
          const onAuthFailure = (status) => {
            invalidateCreds()
            const refreshed = getCredentials({ fresh: true })
            // If the on-disk OAuth token was rotated externally (e.g. claude CLI
            // refreshed it), this new resolution may yield a different key
            // even though the source is the same. Accept it.
            if (refreshed && !triedKeys.has(refreshed.key)) {
              console.log(`  [AI] Upstream ${status} with ${activeCreds.source}; retrying with ${refreshed.source}`)
              attempt(refreshed)
              return true
            }
            const next = getCredentials({ avoidKey: activeCreds.key })
            if (next && !triedKeys.has(next.key)) {
              console.log(`  [AI] Upstream ${status} with ${activeCreds.source}; falling back to ${next.source}`)
              attempt(next)
              return true
            }
            console.log(`  [AI] Upstream ${status} with ${activeCreds.source}; no alternative credentials available`)
            return false
          }
          if (AI_PROVIDER === 'openai') {
            proxyToOpenAI(parsed, activeCreds, res, { onAuthFailure })
          } else {
            proxyToAnthropic(parsed, activeCreds, res, parsed.stream, { onAuthFailure })
          }
        }
        attempt(creds)
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }))
      }
    })
    return
  }

  // App update endpoints — serve source files so desktop can self-update over WiFi
  const updateUrl = (() => {
    try { return new URL(req.url, 'http://localhost') } catch { return null }
  })()
  const updateFilePattern = /\.(ts|tsx|js|jsx|json|css|json5|md|svg|ico|png|jpg|vbs|ps1|nsh|html)$/
  const updateDirs = ['src', 'relay', 'resources', 'build', 'scripts', 'docs']
  const updateExcludedDirs = new Set(['node_modules', '.git', 'out', 'dist', '.expo'])
  const updateRootFiles = new Set([
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'electron-builder.json5',
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json',
    'CLAUDE.md',
    'DATA-SYNC.md',
    'SETUP.md',
    'README.md',
    'VERSION',
    '.gitignore',
    'setup.ps1',
  ])
  const normalizeUpdateRel = (rel) => rel.replace(/\\/g, '/')
  const isUpdateFile = (rel) => {
    const clean = normalizeUpdateRel(rel)
    return updateRootFiles.has(clean)
      || (updateFilePattern.test(clean) && updateDirs.some((dir) => clean.startsWith(`${dir}/`)))
  }
  const collectUpdateFiles = (projectRoot, only = null) => {
    const files = {}
    const onlySet = only ? new Set(only.map(normalizeUpdateRel).filter(isUpdateFile)) : null
    const addFile = (rel) => {
      const clean = normalizeUpdateRel(rel)
      if (!isUpdateFile(clean)) return
      if (onlySet && !onlySet.has(clean)) return
      try {
        const isBinary = /\.(ico|png|jpg|jpeg|gif|webp|woff2?|ttf|eot)$/i.test(clean)
        if (isBinary) {
          files[clean] = '__base64__' + fs.readFileSync(path.join(projectRoot, clean)).toString('base64')
        } else {
          files[clean] = fs.readFileSync(path.join(projectRoot, clean), 'utf8')
        }
      } catch {}
    }
    function collectDir(dir) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory() && !updateExcludedDirs.has(entry.name)) {
            collectDir(full)
          } else if (entry.isFile()) {
            addFile(path.relative(projectRoot, full))
          }
        }
      } catch {}
    }
    if (onlySet) {
      for (const rel of onlySet) addFile(rel)
    } else {
      for (const dir of updateDirs) collectDir(path.join(projectRoot, dir))
      for (const rel of updateRootFiles) addFile(rel)
    }
    return files
  }
  const getChangedUpdateFiles = (projectRoot, since) => {
    const cleanSince = String(since || '').trim()
    if (!/^[0-9a-f]{7,40}$/i.test(cleanSince)) return null
    try {
      execSync(`git cat-file -e ${cleanSince}^{commit}`, { cwd: projectRoot, stdio: 'ignore' })
      const out = execSync(`git diff --name-status --find-renames ${cleanSince} HEAD -- ${updateDirs.join(' ')} ${[...updateRootFiles].join(' ')}`, { cwd: projectRoot })
        .toString()
        .trim()
      const changed = []
      const deleted = []
      if (!out) return { changed, deleted }
      for (const line of out.split(/\r?\n/)) {
        const parts = line.split('\t')
        const status = parts[0] || ''
        const rel = normalizeUpdateRel(status.startsWith('R') ? parts[2] : parts[1])
        if (!isUpdateFile(rel)) continue
        if (status.startsWith('D')) deleted.push(rel)
        else changed.push(rel)
      }
      return { changed: [...new Set(changed)], deleted: [...new Set(deleted)] }
    } catch {
      return null
    }
  }

  if (req.method === 'GET' && updateUrl?.pathname === '/update/info') {
    const projectRoot = path.join(__dirname, '..')
    // Include git commit info for version comparison
    let commitHash = null, commitMessage = null, commitDate = null
    try {
      commitHash = execSync('git rev-parse HEAD', { cwd: projectRoot }).toString().trim()
      commitMessage = execSync('git log -1 --pretty=%s', { cwd: projectRoot }).toString().trim()
      commitDate = execSync('git log -1 --pretty=%ci', { cwd: projectRoot }).toString().trim()
    } catch {}
    const packageVersion = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version || null } catch { return null }
    })()
    const mobileVersion = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'mobile/package.json'), 'utf8')).version || null } catch { return null }
    })()
    const diff = getChangedUpdateFiles(projectRoot, updateUrl.searchParams.get('since'))
    const allFiles = diff ? null : collectUpdateFiles(projectRoot)
    const changedCount = diff ? diff.changed.length : Object.keys(allFiles).length
    const deletedCount = diff ? diff.deleted.length : 0
    const fileCount = changedCount + deletedCount
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      timestamp: Date.now(),
      fileCount,
      changedCount,
      deletedCount,
      commitHash,
      commitMessage,
      commitDate,
      packageVersion,
      mobileVersion,
    }))
    return
  }

  if (req.method === 'GET' && updateUrl?.pathname === '/update/files') {
    const projectRoot = path.join(__dirname, '..')
    let commitHash = null, commitMessage = null, commitDate = null
    try {
      commitHash = execSync('git rev-parse HEAD', { cwd: projectRoot }).toString().trim()
      commitMessage = execSync('git log -1 --pretty=%s', { cwd: projectRoot }).toString().trim()
      commitDate = execSync('git log -1 --pretty=%ci', { cwd: projectRoot }).toString().trim()
    } catch {}
    const diff = getChangedUpdateFiles(projectRoot, updateUrl.searchParams.get('since'))
    const files = collectUpdateFiles(projectRoot, diff?.changed || null)
    const deleted = diff?.deleted || []
    const fileCount = Object.keys(files).length + deleted.length
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ files, deleted, timestamp: Date.now(), fileCount, commitHash, commitMessage, commitDate }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify({ error: { message: 'Not found' } }))
})

// --- Startup ---

initAuth()

const initialCreds = getCredentials()
startTime = Date.now()

console.log('\n  Mien Relay Server v3.0 (autonomous mode)\n')
console.log(`  Provider:  ${AI_PROVIDER}`)
console.log(`  AI Auth:   ${initialCreds ? `${initialCreds.type} (${initialCreds.key.substring(0, 12)}...)` : 'No credentials found'}`)
console.log(`  Port:      ${PORT}`)
console.log(`  Auth:      ${AUTH_DISABLED ? 'DISABLED' : 'Bearer token (see relay.key)'}`)
console.log(`  Tunnel:    ${TUNNEL_ENABLED ? 'Cloudflare (starting...)' : 'Off (set TUNNEL=1 to enable)'}`)
console.log(`  Cron:      finance every 4h, briefing daily ~7:30 AM`)
console.log(`  Keep-alive: credentials refresh every 30m, heartbeat every 10m`)
console.log('')

if (!AUTH_DISABLED && AUTH_TOKEN) {
  console.log(`  Token:     ${AUTH_TOKEN.substring(0, 8)}...${AUTH_TOKEN.substring(AUTH_TOKEN.length - 4)}`)
  console.log('')
}

if (!initialCreds) {
  console.log('  No AI credentials detected. Set one of:')
  console.log('')
  console.log('     RECOMMENDED (lasts 1 year, no disconnections):')
  console.log('       claude setup-token')
  console.log('       CLAUDE_CODE_OAUTH_TOKEN=<token> node server.js')
  console.log('')
  console.log('     ALTERNATIVES:')
  console.log('       ANTHROPIC_API_KEY=sk-ant-...  (Claude API, pay-per-token)')
  console.log('       OPENAI_API_KEY=sk-...         (OpenAI/Codex)')
  console.log('       claude login                  (CLI OAuth, disconnects ~1h)')
  console.log('')
}

// Handle uncaught errors gracefully (don't crash the server)
process.on('uncaughtException', (err) => {
  console.error(`  [FATAL] Uncaught exception: ${err.message}`)
  console.error(err.stack)
  // Don't exit — let the server keep running for other requests
})

process.on('unhandledRejection', (reason) => {
  console.error(`  [WARN] Unhandled rejection:`, reason)
})

// Keep-alive: prevent Node.js from exiting when idle
server.keepAliveTimeout = 65000 // slightly above typical LB timeout (60s)
server.headersTimeout = 66000

server.listen(PORT, '0.0.0.0', () => {
  console.log(`  Listening on http://0.0.0.0:${PORT}`)
  console.log('')
  initRelayCron()
  startTunnel()
})
