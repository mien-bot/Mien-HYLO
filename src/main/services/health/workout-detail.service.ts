/**
 * Workout Detail Service
 *
 * Returns full per-activity detail for the Activity Detail page:
 * - The workout entry (with all fields enriched by relay's activity-detail fetch)
 * - Raw streams (if available): HR, distance, altitude, velocity, cadence, watts, grade
 * - HR zone distribution computed against the user's effective zones for this sport
 * - Comparison vs. user's 90-day baseline for the same sport
 *
 * Key format:
 *   - `strava-<id>` (numeric Strava activity id) — preferred
 *   - `hae-<YYYY-MM-DD>-<index>` for HAE-only workouts (no Strava id)
 */

import { getDb } from '../../db/database'
import { getActivityStreams, type StravaStream } from './strava.service'
import {
  getEffectiveHRZones,
  getEffectiveLTHR,
  getEffectiveMaxHR,
  getEffectiveRestingHR,
  getSportFromName,
  type HRZoneDef,
  type Sport,
} from './hr-zones.service'

export type WorkoutEntry = Record<string, any>

interface ZoneSecond {
  zone: string
  color: string
  minBpm: number
  maxBpm: number
  seconds: number
  pct: number
}

export interface ActivityDetail {
  key: string
  date: string
  workout: WorkoutEntry
  sport: Sport
  hr: {
    maxHr: number
    lthr: number | null
    restingHr: number
    model: 'maxhr' | 'friel'
    zones: HRZoneDef[]
    distribution: ZoneSecond[]
    source: 'stream' | 'stored' | 'estimated' | 'none'
  }
  streams: {
    hasData: boolean
    seconds: number[]
    heartrate?: number[]
    distance?: number[] // meters
    altitude?: number[] // meters
    velocity?: number[] // m/s (smoothed)
    cadence?: number[]
    watts?: number[]
    grade?: number[]
    /** Downsampled to ~600 points for charting */
    sampled?: Array<{
      t: number // seconds from start
      hr?: number
      paceMinPerMi?: number // for run/walk
      speedMph?: number // for ride/other
      altitudeFt?: number
      cadence?: number
      watts?: number
      gradePct?: number
      distMi?: number
    }>
  }
  comparison: {
    sportLabel: string
    sampleCount: number
    days: number
    avgDistance: number | null // miles
    avgDuration: number | null // minutes
    avgHR: number | null
    avgPaceMinPerMi: number | null // run/walk
    avgSpeedMph: number | null // ride/other
    avgElevationGain: number | null // ft
  }
}

// ---- key parsing / workout lookup ----

function parseKey(key: string): { kind: 'strava'; id: number } | { kind: 'hae'; date: string; index: number } | null {
  const stravaMatch = /^strava-(\d+)$/.exec(key)
  if (stravaMatch) return { kind: 'strava', id: parseInt(stravaMatch[1], 10) }
  const haeMatch = /^hae-(\d{4}-\d{2}-\d{2})-(\d+)$/.exec(key)
  if (haeMatch) return { kind: 'hae', date: haeMatch[1], index: parseInt(haeMatch[2], 10) }
  return null
}

function loadWorkoutByKey(
  parsed: NonNullable<ReturnType<typeof parseKey>>,
): { workout: WorkoutEntry; date: string } | null {
  const db = getDb()
  if (parsed.kind === 'strava') {
    const rows = db
      .prepare(
        `SELECT date, value_json FROM health_metrics
         WHERE metric_type = 'workout'
         ORDER BY date DESC
         LIMIT 4000`,
      )
      .all() as Array<{ date: string; value_json: string }>
    for (const row of rows) {
      let parsedRow: any
      try {
        parsedRow = JSON.parse(row.value_json)
      } catch {
        continue
      }
      const workouts = Array.isArray(parsedRow?.workouts) ? parsedRow.workouts : []
      for (const w of workouts) {
        if (String(w?.stravaId) === String(parsed.id)) {
          return { workout: w, date: row.date }
        }
      }
    }
    return null
  }
  // HAE — direct lookup by date
  const row = db
    .prepare(
      `SELECT value_json FROM health_metrics WHERE metric_type = 'workout' AND date = ?`,
    )
    .get(parsed.date) as { value_json: string } | undefined
  if (!row) return null
  let parsedRow: any
  try {
    parsedRow = JSON.parse(row.value_json)
  } catch {
    return null
  }
  const workouts = Array.isArray(parsedRow?.workouts) ? parsedRow.workouts : []
  const w = workouts[parsed.index]
  return w ? { workout: w, date: parsed.date } : null
}

// ---- HR zone classification ----

function classifyHRStreamToZones(
  hr: number[],
  time: number[],
  zones: HRZoneDef[],
): { distribution: ZoneSecond[]; totalSeconds: number } {
  const buckets = zones.map((z) => ({ zone: z, seconds: 0 }))
  let total = 0
  for (let i = 0; i < hr.length; i++) {
    const v = hr[i]
    if (!(v > 30 && v < 230)) continue
    const dt = i === 0 ? 1 : Math.max(0, Math.min(60, time[i] - time[i - 1]))
    if (dt <= 0) continue
    const z = buckets.find((b) => v >= b.zone.minBpm && v < b.zone.maxBpm)
    if (z) z.seconds += dt
    total += dt
  }
  const distribution: ZoneSecond[] = buckets.map((b) => ({
    zone: b.zone.name,
    color: b.zone.color,
    minBpm: b.zone.minBpm,
    maxBpm: b.zone.maxBpm === Infinity ? 999 : b.zone.maxBpm,
    seconds: Math.round(b.seconds),
    pct: total > 0 ? parseFloat(((b.seconds / total) * 100).toFixed(1)) : 0,
  }))
  return { distribution, totalSeconds: Math.round(total) }
}

function classifyStoredZoneSecondsToZones(
  hrZoneSeconds: number[],
  zones: HRZoneDef[],
): ZoneSecond[] {
  // Strava returns 5 zones (Z1-Z5). Map proportionally if our model has 7 (Friel).
  const total = hrZoneSeconds.reduce((s, v) => s + (v || 0), 0)
  const result: ZoneSecond[] = []
  if (zones.length === hrZoneSeconds.length) {
    for (let i = 0; i < zones.length; i++) {
      const sec = hrZoneSeconds[i] || 0
      const z = zones[i]
      result.push({
        zone: z.name,
        color: z.color,
        minBpm: z.minBpm,
        maxBpm: z.maxBpm === Infinity ? 999 : z.maxBpm,
        seconds: Math.round(sec),
        pct: total > 0 ? parseFloat(((sec / total) * 100).toFixed(1)) : 0,
      })
    }
    return result
  }
  // Otherwise project Strava's 5 zones onto first 5 of our zones; extra display
  // zones (e.g. Friel Z5b/Z5c) get 0 since stored data can't disambiguate them.
  for (let i = 0; i < zones.length; i++) {
    const sec = i < hrZoneSeconds.length ? hrZoneSeconds[i] || 0 : 0
    const z = zones[i]
    result.push({
      zone: z.name,
      color: z.color,
      minBpm: z.minBpm,
      maxBpm: z.maxBpm === Infinity ? 999 : z.maxBpm,
      seconds: Math.round(sec),
      pct: total > 0 ? parseFloat(((sec / total) * 100).toFixed(1)) : 0,
    })
  }
  return result
}

// ---- Stream downsampling for charts ----

function downsample(
  s: Partial<StravaStream>,
  sport: Sport,
  targetPoints = 600,
): ActivityDetail['streams']['sampled'] {
  const time = s.time || []
  const n = time.length
  if (n === 0) return []
  const step = Math.max(1, Math.floor(n / targetPoints))

  const hr = s.heartrate || []
  const dist = s.distance || [] // meters
  const alt = s.altitude || []
  const vel = s.velocity_smooth || [] // m/s
  const cad = s.cadence || []
  const wat = s.watts || []
  const grade = s.grade_smooth || []

  const useSpeed = sport === 'ride' || sport === 'other'
  const out: NonNullable<ActivityDetail['streams']['sampled']> = []
  for (let i = 0; i < n; i += step) {
    const t = time[i] - time[0]
    const v = vel[i]
    const point: NonNullable<ActivityDetail['streams']['sampled']>[number] = { t }
    if (hr[i] && hr[i] > 30 && hr[i] < 230) point.hr = Math.round(hr[i])
    if (typeof v === 'number' && v > 0) {
      if (useSpeed) {
        point.speedMph = parseFloat((v * 2.23694).toFixed(2))
      } else {
        // pace = 26.8224 / v (m/s -> min/mile)
        const paceMinPerMi = v > 0.3 ? 26.8224 / v : null
        if (paceMinPerMi && paceMinPerMi < 30) {
          point.paceMinPerMi = parseFloat(paceMinPerMi.toFixed(2))
        }
      }
    }
    if (typeof alt[i] === 'number') point.altitudeFt = parseFloat((alt[i] * 3.28084).toFixed(1))
    if (typeof cad[i] === 'number' && cad[i] > 0) point.cadence = Math.round(cad[i])
    if (typeof wat[i] === 'number' && wat[i] > 0) point.watts = Math.round(wat[i])
    if (typeof grade[i] === 'number') point.gradePct = parseFloat(grade[i].toFixed(1))
    if (typeof dist[i] === 'number') point.distMi = parseFloat((dist[i] * 0.000621371).toFixed(3))
    out.push(point)
  }
  return out
}

// ---- Sport baseline comparison ----

function computeSportBaseline(
  date: string,
  sport: Sport,
  days = 90,
  excludeKey?: string,
): ActivityDetail['comparison'] {
  const db = getDb()
  const endDate = new Date(date)
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - days)
  const startStr = startDate.toISOString().slice(0, 10)
  const rows = db
    .prepare(
      `SELECT date, value_json FROM health_metrics
       WHERE metric_type = 'workout' AND date >= ? AND date <= ?`,
    )
    .all(startStr, date) as Array<{ date: string; value_json: string }>

  let countWithDistance = 0
  let countWithDuration = 0
  let countWithHR = 0
  let countWithPace = 0
  let countWithSpeed = 0
  let countWithElev = 0
  let sumDistance = 0
  let sumDuration = 0
  let sumHR = 0
  let sumPace = 0
  let sumSpeed = 0
  let sumElev = 0
  let total = 0

  for (const row of rows) {
    let parsed: any
    try {
      parsed = JSON.parse(row.value_json)
    } catch {
      continue
    }
    const workouts = Array.isArray(parsed?.workouts) ? parsed.workouts : []
    for (let i = 0; i < workouts.length; i++) {
      const w = workouts[i]
      if (getSportFromName(w?.name) !== sport) continue
      // exclude the activity we're comparing against
      if (excludeKey) {
        const stravaKey = w.stravaId ? `strava-${w.stravaId}` : null
        const haeKey = `hae-${row.date}-${i}`
        if (stravaKey === excludeKey || haeKey === excludeKey) continue
      }
      total++
      const distance = Number(w.distance || 0)
      const durationRaw = Number(w.duration || 0)
      const duration = durationRaw > 200 ? durationRaw / 60 : durationRaw // -> minutes
      const avgHR = Number(w.avgHR || 0)
      const avgSpeed = Number(w.avgSpeed || 0) // m/s
      const elev = Number(w.elevationGain || 0)
      if (distance > 0) {
        sumDistance += distance
        countWithDistance++
      }
      if (duration > 0) {
        sumDuration += duration
        countWithDuration++
      }
      if (avgHR > 0) {
        sumHR += avgHR
        countWithHR++
      }
      if (avgSpeed > 0) {
        if (sport === 'run' || sport === 'other') {
          // only treat as pace for run; walk is also useful, but 'other' could be anything
          if (sport === 'run') {
            const pace = 26.8224 / avgSpeed
            if (pace > 3 && pace < 25) {
              sumPace += pace
              countWithPace++
            }
          } else {
            // for 'other' use speed (mph)
            sumSpeed += avgSpeed * 2.23694
            countWithSpeed++
          }
        } else {
          sumSpeed += avgSpeed * 2.23694
          countWithSpeed++
        }
      }
      if (elev > 0) {
        sumElev += elev
        countWithElev++
      }
    }
  }

  return {
    sportLabel: sport === 'run' ? 'Runs' : sport === 'ride' ? 'Rides' : 'Activities',
    sampleCount: total,
    days,
    avgDistance: countWithDistance > 0 ? parseFloat((sumDistance / countWithDistance).toFixed(2)) : null,
    avgDuration: countWithDuration > 0 ? parseFloat((sumDuration / countWithDuration).toFixed(1)) : null,
    avgHR: countWithHR > 0 ? Math.round(sumHR / countWithHR) : null,
    avgPaceMinPerMi: countWithPace > 0 ? parseFloat((sumPace / countWithPace).toFixed(2)) : null,
    avgSpeedMph: countWithSpeed > 0 ? parseFloat((sumSpeed / countWithSpeed).toFixed(2)) : null,
    avgElevationGain: countWithElev > 0 ? Math.round((sumElev / countWithElev) * 3.28084) : null,
  }
}

// ---- Main entry ----

export function getWorkoutDetail(key: string): ActivityDetail | null {
  const parsed = parseKey(key)
  if (!parsed) return null
  const loaded = loadWorkoutByKey(parsed)
  if (!loaded) return null

  const { workout, date } = loaded
  const sport = getSportFromName(workout.name || workout.sportType || workout.type)
  const zoneSetup = getEffectiveHRZones(sport)
  const maxHr = getEffectiveMaxHR(sport)
  const lthr = getEffectiveLTHR(sport)
  const restingHr = getEffectiveRestingHR()

  // ---- Streams ----
  let rawStreams: Partial<StravaStream> | null = null
  if (workout.stravaId) {
    rawStreams = getActivityStreams(Number(workout.stravaId))
  }

  let distribution: ZoneSecond[] = []
  let zoneSource: 'stream' | 'stored' | 'estimated' | 'none' = 'none'

  if (rawStreams?.heartrate?.length && rawStreams.time?.length) {
    const result = classifyHRStreamToZones(rawStreams.heartrate, rawStreams.time, zoneSetup.zones)
    distribution = result.distribution
    zoneSource = 'stream'
  } else if (Array.isArray(workout.hrZoneSeconds) && workout.hrZoneSeconds.some((v: number) => v > 0)) {
    distribution = classifyStoredZoneSecondsToZones(workout.hrZoneSeconds, zoneSetup.zones)
    zoneSource = 'stored'
  } else if (workout.avgHR > 0 && workout.duration > 0) {
    // Estimate: dump all duration into the single zone matching avgHR
    const totalSec = Math.round((workout.duration > 200 ? workout.duration : workout.duration * 60))
    distribution = zoneSetup.zones.map((z) => {
      const inZone = workout.avgHR >= z.minBpm && workout.avgHR < z.maxBpm
      return {
        zone: z.name,
        color: z.color,
        minBpm: z.minBpm,
        maxBpm: z.maxBpm === Infinity ? 999 : z.maxBpm,
        seconds: inZone ? totalSec : 0,
        pct: inZone ? 100 : 0,
      }
    })
    zoneSource = 'estimated'
  } else {
    distribution = zoneSetup.zones.map((z) => ({
      zone: z.name,
      color: z.color,
      minBpm: z.minBpm,
      maxBpm: z.maxBpm === Infinity ? 999 : z.maxBpm,
      seconds: 0,
      pct: 0,
    }))
  }

  const streams: ActivityDetail['streams'] = {
    hasData: Boolean(rawStreams && Object.keys(rawStreams).length > 0),
    seconds: rawStreams?.time || [],
    heartrate: rawStreams?.heartrate,
    distance: rawStreams?.distance,
    altitude: rawStreams?.altitude,
    velocity: rawStreams?.velocity_smooth,
    cadence: rawStreams?.cadence,
    watts: rawStreams?.watts,
    grade: rawStreams?.grade_smooth,
    sampled: rawStreams ? downsample(rawStreams, sport) : [],
  }

  const comparison = computeSportBaseline(date, sport, 90, key)

  return {
    key,
    date,
    workout,
    sport,
    hr: {
      maxHr,
      lthr,
      restingHr,
      model: zoneSetup.model,
      zones: zoneSetup.zones,
      distribution,
      source: zoneSource,
    },
    streams,
    comparison,
  }
}
