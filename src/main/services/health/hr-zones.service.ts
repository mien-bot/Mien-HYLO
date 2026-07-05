/**
 * HR Zones Service
 *
 * Stream-based estimation of Max HR, Lactate Threshold HR (LTHR), and resting HR.
 * Sport-aware (run vs ride): physiologically these can differ by 5-10+ bpm.
 *
 * Zone models:
 *   - 'maxhr' — classic %HRmax zones (Karvonen / generic 5-zone)
 *   - 'friel' — Joel Friel's 7-zone %LTHR model (more accurate for trained athletes)
 *
 * References:
 *   - Friel, J. "The Triathlete's Training Bible" — 7-zone LTHR model
 *   - Tanaka et al. (2001) — 208 - 0.7 × age (max HR fallback)
 *   - Karvonen, M. (1957) — HRR-based zones
 */
import { getDb } from '../../db/database'
import { getAppSettings } from '../../lib/settings'
import { getAllStreams } from './strava.service'

// --- Types ---

export type Sport = 'run' | 'ride' | 'other'

export interface HRZoneDef {
  name: string
  /** Lower bound in BPM (inclusive) */
  minBpm: number
  /** Upper bound in BPM (exclusive); use Infinity for the topmost zone */
  maxBpm: number
  color: string
}

export interface RecommendedHRSettings {
  restingHr: { value: number | null; sampleDays: number; sampleCount: number }
  run: {
    maxHr: { value: number | null; observedAt: string | null; sampleCount: number }
    lthr: { value: number | null; activityCount: number; bestActivityDate: string | null }
  }
  ride: {
    maxHr: { value: number | null; observedAt: string | null; sampleCount: number }
    lthr: { value: number | null; activityCount: number; bestActivityDate: string | null }
  }
}

// --- Zone definitions ---

/** %HRmax zones — generic 5-zone model used by Garmin/Polar */
const MAXHR_ZONE_PCTS = [
  { name: 'Z1 Recovery', minPct: 0, maxPct: 60, color: '#94a3b8' },
  { name: 'Z2 Aerobic', minPct: 60, maxPct: 70, color: '#3b82f6' },
  { name: 'Z3 Tempo', minPct: 70, maxPct: 80, color: '#22c55e' },
  { name: 'Z4 Threshold', minPct: 80, maxPct: 90, color: '#f59e0b' },
  { name: 'Z5 VO2max', minPct: 90, maxPct: 100, color: '#ef4444' },
]

/** %LTHR zones — Friel 7-zone model */
const FRIEL_ZONE_PCTS = [
  { name: 'Z1 Active Recovery', minPct: 0, maxPct: 81, color: '#94a3b8' },
  { name: 'Z2 Aerobic Endurance', minPct: 81, maxPct: 89, color: '#3b82f6' },
  { name: 'Z3 Tempo', minPct: 89, maxPct: 94, color: '#22c55e' },
  { name: 'Z4 Subthreshold', minPct: 94, maxPct: 100, color: '#eab308' },
  { name: 'Z5a Threshold', minPct: 100, maxPct: 103, color: '#f59e0b' },
  { name: 'Z5b VO2max', minPct: 103, maxPct: 106, color: '#ef4444' },
  { name: 'Z5c Anaerobic', minPct: 106, maxPct: 999, color: '#7c2d12' },
]

// --- Sport detection ---

export function getSportFromName(name: string | null | undefined): Sport {
  if (!name) return 'other'
  const n = name.toLowerCase()
  if (n.includes('run')) return 'run'
  if (n.includes('cycl') || n.includes('ride') || n.includes('bike')) return 'ride'
  return 'other'
}

// --- Stream-based estimation ---

interface RawStream {
  activityId: number
  date: string
  name: string
  sport: Sport
  heartrate: number[]
  time: number[]
}

function loadHrStreams(sinceDays: number = 3650): RawStream[] {
  const streams = getAllStreams(sinceDays)
  const out: RawStream[] = []
  for (const s of streams) {
    const hr = (s.streams as { heartrate?: number[] }).heartrate
    const time = (s.streams as { time?: number[] }).time
    if (!Array.isArray(hr) || !Array.isArray(time) || hr.length === 0) continue
    out.push({
      activityId: s.activityId,
      date: s.date,
      name: s.name,
      sport: getSportFromName(s.name),
      heartrate: hr,
      time,
    })
  }
  return out
}

/**
 * Find peak HR observed in streams for a sport. Prefers recent windows because
 * max HR drifts with age and fitness — a single 2019 outlier shouldn't pin zones.
 */
export function estimateMaxHRFromStreams(
  sport: Sport,
  preferredMonths: number = 24,
): { value: number | null; observedAt: string | null; sampleCount: number } {
  const all = loadHrStreams(3650).filter((s) => s.sport === sport)
  if (all.length === 0) return { value: null, observedAt: null, sampleCount: 0 }

  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - preferredMonths)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const recent = all.filter((s) => s.date >= cutoffStr)
  const pool = recent.length >= 5 ? recent : all

  let peak = 0
  let peakDate: string | null = null
  for (const s of pool) {
    const m = Math.max(...s.heartrate.filter((v) => v > 0 && v < 230))
    if (m > peak) {
      peak = m
      peakDate = s.date
    }
  }
  return { value: peak > 0 ? peak : null, observedAt: peakDate, sampleCount: pool.length }
}

/**
 * Estimate LTHR using Friel's method: best sustained 20-min average HR across
 * threshold/tempo efforts. Implemented as a sliding window over each activity's
 * HR stream — the LTHR is the maximum 20-min average observed.
 *
 * Excludes warm-up by starting the search at index 10% in to avoid early HR
 * spikes from anxiety/wind, per Friel's protocol.
 */
export function estimateLTHRFromStreams(
  sport: Sport,
  windowMinutes: number = 20,
): { value: number | null; activityCount: number; bestActivityDate: string | null } {
  const all = loadHrStreams(3650).filter((s) => s.sport === sport)
  if (all.length === 0) return { value: null, activityCount: 0, bestActivityDate: null }

  let bestAvg = 0
  let bestDate: string | null = null

  for (const s of all) {
    const { heartrate: hr, time } = s
    if (hr.length < 60) continue

    // Compute cumulative HR×dt and cumulative dt so we can read any window in O(1)
    const n = hr.length
    const cumHrSec = new Float64Array(n + 1)
    const cumSec = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) {
      const dt = i === 0 ? 1 : time[i] - time[i - 1]
      const safeDt = dt > 0 && dt < 60 ? dt : 1
      const v = hr[i] > 30 && hr[i] < 230 ? hr[i] : 0
      cumHrSec[i + 1] = cumHrSec[i] + v * safeDt
      cumSec[i + 1] = cumSec[i] + (v > 0 ? safeDt : 0)
    }

    const windowSec = windowMinutes * 60
    const startIdx = Math.floor(n * 0.1)
    // Sliding window over end indices
    for (let end = startIdx + 1; end <= n; end++) {
      // Find start such that time[end-1] - time[start] >= windowSec
      // Linear scan with two pointers
      // (n is bounded by activity length, typically a few thousand — fast enough)
      let start = end - 1
      while (start > 0 && time[end - 1] - time[start - 1] < windowSec) start--
      const elapsed = time[end - 1] - time[start]
      if (elapsed < windowSec * 0.95) continue
      const totalSec = cumSec[end] - cumSec[start]
      if (totalSec < windowSec * 0.9) continue
      const avg = (cumHrSec[end] - cumHrSec[start]) / totalSec
      if (avg > bestAvg) {
        bestAvg = avg
        bestDate = s.date
      }
    }
  }

  return {
    value: bestAvg > 0 ? Math.round(bestAvg) : null,
    activityCount: all.length,
    bestActivityDate: bestDate,
  }
}

/**
 * Read resting HR from the resting_heart_rate metric. Uses the median of the
 * last N days to ignore single-day spikes from poor sleep / illness.
 */
export function estimateRestingHRFromMetrics(days: number = 30): {
  value: number | null
  sampleDays: number
  sampleCount: number
} {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT value_json FROM health_metrics
       WHERE metric_type = 'resting_heart_rate'
         AND date >= date('now', '-' || ? || ' days')
       ORDER BY date DESC`,
    )
    .all(days) as Array<{ value_json: string }>

  const values: number[] = []
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.value_json) as { qty?: number; value?: number }
      const v = parsed.qty ?? parsed.value
      if (typeof v === 'number' && v >= 30 && v <= 120) values.push(v)
    } catch {}
  }

  if (values.length === 0) return { value: null, sampleDays: days, sampleCount: 0 }
  values.sort((a, b) => a - b)
  const median = values[Math.floor(values.length / 2)]
  return { value: Math.round(median), sampleDays: days, sampleCount: values.length }
}

export function getRecommendedHRSettings(): RecommendedHRSettings {
  return {
    restingHr: estimateRestingHRFromMetrics(30),
    run: {
      maxHr: estimateMaxHRFromStreams('run', 24),
      lthr: estimateLTHRFromStreams('run'),
    },
    ride: {
      maxHr: estimateMaxHRFromStreams('ride', 24),
      lthr: estimateLTHRFromStreams('ride'),
    },
  }
}

// --- Effective settings (user override > auto-detected > Tanaka fallback) ---

function parseNum(s: string | undefined | null): number | null {
  if (!s) return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function getEffectiveMaxHR(sport: Sport): number {
  const settings = getAppSettings()
  const sportField = sport === 'ride' ? settings.maxHrRide : settings.maxHrRun
  const userVal = parseNum(sportField)
  if (userVal) return userVal

  // Fall back to other sport if only one is set (better than Tanaka)
  const otherField = sport === 'ride' ? settings.maxHrRun : settings.maxHrRide
  const otherVal = parseNum(otherField)
  if (otherVal) return otherVal

  // Tanaka 208 - 0.7 × age
  const age = parseNum(settings.userAge)
  if (age) return Math.round(208 - 0.7 * age)
  return 190
}

export function getEffectiveLTHR(sport: Sport): number | null {
  const settings = getAppSettings()
  const sportField = sport === 'ride' ? settings.lthrRide : settings.lthrRun
  const userVal = parseNum(sportField)
  if (userVal) return userVal

  // Legacy single-LTHR setting
  const legacy = parseNum(settings.lactateThresholdHR)
  if (legacy) return legacy

  // Fall back to other sport
  const otherField = sport === 'ride' ? settings.lthrRun : settings.lthrRide
  const otherVal = parseNum(otherField)
  if (otherVal) return otherVal

  return null
}

export function getEffectiveRestingHR(): number {
  const settings = getAppSettings()
  const userVal = parseNum(settings.restingHr)
  if (userVal) return userVal
  return 60
}

/**
 * Resolve zones to absolute BPM bounds for a given sport.
 * Picks model based on `zoneModel` setting (defaults to 'friel' if LTHR available).
 */
export function getEffectiveHRZones(sport: Sport): {
  zones: HRZoneDef[]
  model: 'maxhr' | 'friel'
  reference: number
} {
  const settings = getAppSettings()
  const lthr = getEffectiveLTHR(sport)
  const maxHr = getEffectiveMaxHR(sport)

  const requested = settings.zoneModel === 'maxhr' ? 'maxhr' : settings.zoneModel === 'friel' ? 'friel' : null
  // Default: Friel when LTHR known, else %max HR
  const model: 'maxhr' | 'friel' = requested ?? (lthr ? 'friel' : 'maxhr')

  if (model === 'friel' && lthr) {
    const zones = FRIEL_ZONE_PCTS.map((z) => ({
      name: z.name,
      minBpm: Math.round((z.minPct / 100) * lthr),
      maxBpm: z.maxPct >= 999 ? Infinity : Math.round((z.maxPct / 100) * lthr),
      color: z.color,
    }))
    return { zones, model: 'friel', reference: lthr }
  }

  const zones = MAXHR_ZONE_PCTS.map((z, i) => ({
    name: z.name,
    minBpm: Math.round((z.minPct / 100) * maxHr),
    maxBpm: i === MAXHR_ZONE_PCTS.length - 1 ? Infinity : Math.round((z.maxPct / 100) * maxHr),
    color: z.color,
  }))
  return { zones, model: 'maxhr', reference: maxHr }
}
