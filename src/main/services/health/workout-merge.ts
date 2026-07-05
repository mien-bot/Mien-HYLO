import { getDb } from '../../db/database'

export type WorkoutEntry = Record<string, any>

function normalizeText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function parseWorkoutTime(value: unknown): number | null {
  if (!value) return null
  let str = String(value)
  // HAE format: "2018-09-09 08:00:14 -0500" — JS Date can't parse space-separated tz offset
  // Convert to ISO: "2018-09-09T08:00:14-05:00"
  const haeMatch = str.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/)
  if (haeMatch) {
    str = `${haeMatch[1]}T${haeMatch[2]}${haeMatch[3]}:${haeMatch[4]}`
  }
  const ts = new Date(str).getTime()
  return Number.isFinite(ts) ? ts : null
}

function workoutStartMs(workout: WorkoutEntry): number | null {
  return parseWorkoutTime(workout.start || workout.startDate)
}

function workoutDurationMin(workout: WorkoutEntry): number {
  const raw = Number(workout.duration || workout.elapsedTime || workout.movingTime || 0)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw > 200 ? raw / 60 : raw
}

function workoutDistance(workout: WorkoutEntry): number {
  const raw = workout.distance
  if (raw && typeof raw === 'object') {
    return Number(raw.qty ?? raw.value ?? 0) || 0
  }
  return Number(raw || 0) || 0
}

export function isStravaWorkout(workout: WorkoutEntry): boolean {
  return Boolean(
    workout.stravaId ||
    normalizeText(workout.source).includes('strava') ||
    normalizeText(workout.provider).includes('strava'),
  )
}

const SPORT_SYNONYMS: Record<string, string> = {
  'outdoor cycling': 'ride',
  'indoor cycling': 'ride',
  cycling: 'ride',
  'outdoor run': 'run',
  'indoor run': 'run',
  'treadmill run': 'run',
  'outdoor walk': 'walk',
  'indoor walk': 'walk',
  'outdoor swim': 'swim',
  'indoor swim': 'swim',
  'pool swim': 'swim',
  'open water swim': 'swim',
  'outdoor hike': 'hike',
  hiking: 'hike',
  'traditional strength training': 'weight training',
  'strength training': 'weight training',
}

function canonicalSport(name: string): string {
  const n = normalizeText(name)
  return SPORT_SYNONYMS[n] ?? n
}

function workoutNamesCompatible(a: WorkoutEntry, b: WorkoutEntry): boolean {
  const aName = canonicalSport(a.name || a.sportType || a.type)
  const bName = canonicalSport(b.name || b.sportType || b.type)
  if (!aName || !bName) return true
  if (aName === bName) return true
  return aName.includes(bName) || bName.includes(aName)
}

function durationCompatible(a: WorkoutEntry, b: WorkoutEntry): boolean {
  const aDuration = workoutDurationMin(a)
  const bDuration = workoutDurationMin(b)
  if (!aDuration || !bDuration) return true
  return Math.abs(aDuration - bDuration) <= Math.max(10, Math.min(aDuration, bDuration) * 0.25)
}

function distanceCompatible(a: WorkoutEntry, b: WorkoutEntry): boolean {
  const aDistance = workoutDistance(a)
  const bDistance = workoutDistance(b)
  if (!aDistance || !bDistance) return true
  return Math.abs(aDistance - bDistance) <= Math.max(0.25, Math.min(aDistance, bDistance) * 0.25)
}

function sameWorkout(a: WorkoutEntry, b: WorkoutEntry): boolean {
  if (a.stravaId && b.stravaId) return String(a.stravaId) === String(b.stravaId)

  const aStart = workoutStartMs(a)
  const bStart = workoutStartMs(b)
  if (aStart == null || bStart == null) return false

  const startDeltaMin = Math.abs(aStart - bStart) / 60000
  if (startDeltaMin > 20) return false

  return workoutNamesCompatible(a, b) && durationCompatible(a, b) && distanceCompatible(a, b)
}

function workoutCompleteness(workout: WorkoutEntry): number {
  return [
    workout.stravaId,
    workout.avgHR || workout.heartRateAvg || workout.heartRateData?.avg,
    workout.maxHR || workout.heartRateMax || workout.heartRateData?.max,
    workout.distance,
    workout.calories || workout.activeEnergyBurned || workout.totalEnergy,
    workout.elevationGain,
    workout.avgSpeed,
    workout.avgCadence,
    workout.avgWatts,
    workout.normalizedPower,
    workout.maxWatts,
    workout.hrZoneSeconds,
    workout.hasStreams,
    workout.streamSummary,
    workout.hasActivityDetail,
    workout.activityDetailSummary,
    workout.splitsMetric?.length,
    workout.splitsStandard?.length,
    workout.laps?.length,
    workout.bestEfforts?.length,
    workout.segmentEffortCount,
    workout.segmentEfforts?.length,
    workout.perceivedExertion,
    workout.maxSpeed,
    workout.routePointCount,
    workout.avgTemp,
    workout.streamMovingSeconds,
    workout.map?.summaryPolyline,
    workout.deviceName,
    workout.gear?.id,
  ].filter(Boolean).length
}

function preferredWorkout(existing: WorkoutEntry, incoming: WorkoutEntry): WorkoutEntry {
  const existingIsStrava = isStravaWorkout(existing)
  const incomingIsStrava = isStravaWorkout(incoming)
  if (incomingIsStrava && !existingIsStrava) return incoming
  if (existingIsStrava && !incomingIsStrava) return existing
  return workoutCompleteness(incoming) >= workoutCompleteness(existing) ? incoming : existing
}

export function mergeWorkouts(
  existingWorkouts: WorkoutEntry[],
  incomingWorkouts: WorkoutEntry[],
): WorkoutEntry[] {
  const merged = [...existingWorkouts]

  for (const incoming of incomingWorkouts) {
    const idx = merged.findIndex((existing) => sameWorkout(existing, incoming))
    if (idx === -1) {
      merged.push(incoming)
    } else {
      merged[idx] = preferredWorkout(merged[idx], incoming)
    }
  }

  // If a Strava workout exists for a sport on a given date, drop non-Strava duplicates
  // of the same sport. Strava data is authoritative for runs and rides.
  const stravaSports = new Set<string>()
  for (const w of merged) {
    if (isStravaWorkout(w)) {
      stravaSports.add(canonicalSport(w.name || w.sportType || w.type))
    }
  }
  const deduped = merged.filter((w) => {
    if (isStravaWorkout(w)) return true
    const sport = canonicalSport(w.name || w.sportType || w.type)
    return !stravaSports.has(sport)
  })

  return deduped.sort((a, b) => {
    const aStart = workoutStartMs(a) ?? 0
    const bStart = workoutStartMs(b) ?? 0
    return aStart - bStart
  })
}

/**
 * Re-dedup all stored workout rows: for each date, if a Strava workout exists
 * for a sport, drop non-Strava workouts of the same canonical sport.
 */
export function dedupStoredWorkouts(): number {
  const db = getDb()
  const rows = db
    .prepare(`SELECT date, value_json FROM health_metrics WHERE metric_type = 'workout'`)
    .all() as { date: string; value_json: string }[]

  let updated = 0
  for (const row of rows) {
    let workouts: WorkoutEntry[]
    try {
      workouts = JSON.parse(row.value_json)
      if (!Array.isArray(workouts)) continue
    } catch {
      continue
    }

    const stravaSports = new Set<string>()
    for (const w of workouts) {
      if (isStravaWorkout(w)) {
        stravaSports.add(canonicalSport(w.name || w.sportType || w.type))
      }
    }
    if (stravaSports.size === 0) continue

    const deduped = workouts.filter((w) => {
      if (isStravaWorkout(w)) return true
      const sport = canonicalSport(w.name || w.sportType || w.type)
      return !stravaSports.has(sport)
    })

    if (deduped.length < workouts.length) {
      db.prepare(`UPDATE health_metrics SET value_json = ? WHERE metric_type = 'workout' AND date = ?`)
        .run(JSON.stringify(deduped), row.date)
      updated += workouts.length - deduped.length
    }
  }
  return updated
}
