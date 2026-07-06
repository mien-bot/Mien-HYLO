import { getDb } from '../../db/database'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { timingSafeEqual } from 'crypto'
import { BrowserWindow, Notification } from 'electron'
import store from '../../lib/store'
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
} from './sleep-analysis'
import { generateBriefing } from '../../ai/briefing-generator'
import { wakeDateFor } from '@shared/sleep-date'
import { HEALTH_SERVER_PORT, SLEEP_DEBT_WINDOW_DAYS } from '@shared/constants'
import { checkHealthAlerts } from './health-alerts.service'
import { mergeWorkouts, isStravaWorkout, type WorkoutEntry } from './workout-merge'
import { getAppSettings } from '../../lib/settings'
let watcher: fs.FSWatcher | null = null
let server: http.Server | null = null
let boundPort: number | null = null
const MAX_HEALTH_REQUEST_BYTES = 25 * 1024 * 1024

export function getHealthServerPort(): number | null {
  return boundPort
}

// --- Health Auto Export JSON parsing ---

interface HealthAutoExportPayload {
  data?: {
    metrics?: Array<{
      name: string
      units: string
      data: Array<{
        date: string
        qty?: number
        value?: number
        source?: string
        // Sleep-specific fields
        inBed?: number
        asleep?: number
        awake?: number
        sleepStart?: string
        sleepEnd?: string
      }>
    }>
    workouts?: WorkoutEntry[]
  }
  // Alternative flat format some versions use
  metrics?: Array<{
    name: string
    units: string
    data: Array<Record<string, unknown>>
  }>
  workouts?: WorkoutEntry[]
}

const METRIC_NAME_MAP: Record<string, string> = {
  heart_rate: 'heart_rate',
  heartRate: 'heart_rate',
  resting_heart_rate: 'resting_heart_rate',
  restingHeartRate: 'resting_heart_rate',
  resting_heart_rate_average: 'resting_heart_rate',
  heart_rate_variability: 'hrv',
  heartRateVariability: 'hrv',
  hrv: 'hrv',
  sleep_analysis: 'sleep',
  sleepAnalysis: 'sleep',
  sleep: 'sleep',
  step_count: 'steps',
  stepCount: 'steps',
  steps: 'steps',
  active_energy: 'active_energy',
  activeEnergy: 'active_energy',
  basal_energy: 'basal_energy',
  basalEnergy: 'basal_energy',
  basal_energy_burned: 'basal_energy',
  distance: 'distance',
  distance_walking_running: 'distance',
  distanceWalkingRunning: 'distance',
  exercise_time: 'exercise_time',
  exerciseTime: 'exercise_time',
  apple_exercise_time: 'exercise_time',
  flights_climbed: 'flights_climbed',
  flightsClimbed: 'flights_climbed',
  time_in_daylight: 'time_in_daylight',
  timeInDaylight: 'time_in_daylight',
  vo2max: 'vo2_max',
  vo2_max: 'vo2_max',
  vo2_maximum: 'vo2_max',
  cardio_fitness: 'vo2_max',
  workout: 'workout',
  workouts: 'workout',
}

function normalizeMetricName(name: string): string | null {
  const lower = name.toLowerCase().replace(/[\s-]/g, '_')
  return METRIC_NAME_MAP[lower] || METRIC_NAME_MAP[name] || null
}

// Categorize sleep data sources. AutoSleep's motion-based detection is much more
// accurate than the Apple Watch / Pixel Watch native HR-based algorithm, which
// over-reports by counting awake-in-bed time as "core sleep". When both sources
// are present in a payload, we prefer AutoSleep.
type SleepSourceCategory = 'autosleep' | 'watch' | 'other'
const MAX_SLEEP_MINUTES = 16 * 60

function isInflatedSleepValue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const sleep = value as { totalAsleep?: number; asleep?: number; qty?: number }
  const minutes = sleep.totalAsleep ?? sleep.asleep ?? sleep.qty ?? 0
  return typeof minutes === 'number' && minutes > MAX_SLEEP_MINUTES
}

function categorizeSleepSource(source: unknown): SleepSourceCategory {
  if (typeof source !== 'string' || !source) return 'other'
  const s = source.toLowerCase()
  if (s.includes('autosleep')) return 'autosleep'
  if (s.includes('watch')) return 'watch'
  return 'other'
}

function parseAndStorePayload(payload: HealthAutoExportPayload): number {
  const db = getDb()
  const insert = db.prepare(`
    INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
    VALUES (?, ?, ?, 'health_auto_export')
  `)

  const metrics = payload.data?.metrics || payload.metrics || []
  let stored = 0

  // Handle workouts (separate from metrics in Health Auto Export)
  const workouts: WorkoutEntry[] = payload.data?.workouts || payload.workouts || []
  if (workouts.length > 0) {
    console.log(`Processing ${workouts.length} workouts`)
    // Group workouts by date, store as array per day (UNIQUE(metric_type, date) constraint)
    const workoutsByDate = new Map<string, any[]>()
    for (const w of workouts) {
      const startStr = w.start || w.startDate
      const dateStr = extractDate(startStr || w.date)
      if (!dateStr) continue

      const durationRaw = w.duration ?? 0
      // Duration may be in seconds (>200 for a short workout) — convert to minutes
      const duration = durationRaw > 200 ? durationRaw / 60 : durationRaw
      if (duration < 1) continue

      // Distance may be a nested object {qty, units} or a flat number
      const rawDist = w.distance ?? 0
      const distanceKm =
        typeof rawDist === 'object' && rawDist !== null
          ? (rawDist.qty ?? rawDist.value ?? 0)
          : rawDist
      // Convert km to miles for display
      const distanceMi = distanceKm * 0.621371

      const workoutData = {
        name: w.name || 'Unknown',
        duration: Math.round(duration),
        calories: Math.round(
          w.activeEnergyBurned ?? w.totalEnergy ?? w.calories ?? w.activeEnergy ?? 0,
        ),
        distance: parseFloat(distanceMi.toFixed(2)),
        stepCount: Array.isArray(w.stepCount)
          ? Math.round(w.stepCount.reduce((s: number, e: any) => s + ((e?.qty as number) || 0), 0))
          : (w.stepCount ?? 0),
        start: startStr || '',
        end: w.end || w.endDate || '',
        avgHR: w.heartRateData?.avg ?? w.heartRateAvg ?? 0,
        maxHR: w.heartRateData?.max ?? w.heartRateMax ?? 0,
        source: w.source || '',
      }

      if (!workoutsByDate.has(dateStr)) workoutsByDate.set(dateStr, [])
      workoutsByDate.get(dateStr)!.push(workoutData)
    }

    const selectExistingWorkout = db.prepare(`
      SELECT value_json FROM health_metrics
      WHERE metric_type = 'workout' AND date = ?
    `)
    const insertWorkout = db.prepare(`
      INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
      VALUES ('workout', ?, ?, ?)
    `)
    const insertWorkouts = db.transaction(() => {
      for (const [dateStr, dayWorkouts] of workoutsByDate) {
        let existingWorkouts: any[] = []
        try {
          const existing = selectExistingWorkout.get(dateStr) as { value_json: string } | undefined
          const parsed = existing ? JSON.parse(existing.value_json) : null
          existingWorkouts = Array.isArray(parsed?.workouts) ? parsed.workouts : []
        } catch {}

        const merged = mergeWorkouts(existingWorkouts, dayWorkouts)
        const hasStrava = merged.some(isStravaWorkout)
        const hasNonStrava = merged.some((w) => !isStravaWorkout(w))
        const source =
          hasStrava && hasNonStrava ? 'mixed' : hasStrava ? 'strava' : 'health_auto_export'
        insertWorkout.run(dateStr, JSON.stringify({ workouts: merged }), source)
        stored++
      }
    })
    insertWorkouts()
    console.log(`Stored workouts for ${workoutsByDate.size} days`)
  }

  // Group all entries by (metricType, date) then aggregate
  const grouped: Record<string, Record<string, any[]>> = {}

  for (const metric of metrics) {
    const metricType = normalizeMetricName(metric.name)
    if (!metricType) continue

    if (!grouped[metricType]) grouped[metricType] = {}

    for (const entry of metric.data) {
      const entryRecord = entry as Record<string, unknown>
      const initialDate = extractDate(
        (entryRecord.date as string | undefined) || (entryRecord.dateString as string | undefined),
      )
      if (!initialDate) continue

      // Sleep is binned by the local **wake date** (date of sleepEnd).
      // A sleep 9pm Mon → 6am Tue belongs to Tue.
      let dateStr: string = initialDate
      if (metricType === 'sleep') {
        const wake = wakeDateFor(entry as Record<string, unknown>)
        if (wake) {
          dateStr = wake
          if (initialDate !== dateStr) {
            console.log(
              `Sleep date mapped: ${initialDate} → ${dateStr} (end=${entry.sleepEnd || (entry as Record<string, unknown>).end || (entry as Record<string, unknown>).endDate || 'none'}, start=${entry.sleepStart || (entry as Record<string, unknown>).start || (entry as Record<string, unknown>).startDate || 'none'})`,
            )
          }
        }
      }

      if (!grouped[metricType][dateStr]) grouped[metricType][dateStr] = []
      grouped[metricType][dateStr].push(entry)
    }
  }

  // Check existing sleep data so we don't overwrite good aggregated data with reconstructed
  const existingSleep = new Map<string, any>()
  try {
    const rows = db
      .prepare(`SELECT date, value_json FROM health_metrics WHERE metric_type = 'sleep'`)
      .all() as Array<{ date: string; value_json: string }>
    for (const row of rows) {
      const val = JSON.parse(row.value_json)
      if (val.totalAsleep && !val.reconstructed) {
        existingSleep.set(row.date, val) // Only preserve non-reconstructed data
      }
    }
  } catch {}

  const insertMany = db.transaction(() => {
    for (const [metricType, dates] of Object.entries(grouped)) {
      for (const [dateStr, entries] of Object.entries(dates)) {
        const aggregated = aggregateEntries(metricType, entries)
        if (aggregated === null) continue // Skip invalid/insufficient data

        // Don't overwrite good aggregated sleep with reconstructed fragments
        if (metricType === 'sleep' && aggregated.reconstructed && existingSleep.has(dateStr)) {
          continue
        }

        // Merge new sleep with existing if this is a new session (nap) arriving later
        if (metricType === 'sleep') {
          const existingRow = db
            .prepare(
              `SELECT value_json FROM health_metrics WHERE metric_type = 'sleep' AND date = ?`,
            )
            .get(dateStr) as { value_json: string } | undefined
          if (existingRow) {
            try {
              const existing = JSON.parse(existingRow.value_json)
              const existingTotal = existing.totalAsleep || 0
              const newTotal = aggregated.totalAsleep || 0
              // Only merge if the new data looks like a separate, smaller session (nap)
              // and the existing data has substantial sleep already
              if (existingTotal >= 60 && newTotal > 0 && newTotal < existingTotal) {
                aggregated.totalAsleep = existingTotal + newTotal
                aggregated.deep = (existing.deep || 0) + (aggregated.deep || 0)
                aggregated.rem = (existing.rem || 0) + (aggregated.rem || 0)
                aggregated.core = (existing.core || 0) + (aggregated.core || 0)
                // Use earliest start and latest end for full span
                const starts = [existing.sleepStart, aggregated.sleepStart].filter(Boolean)
                const ends = [existing.sleepEnd, aggregated.sleepEnd].filter(Boolean)
                const earliest = starts.sort()[0] || ''
                const latest = ends.sort().reverse()[0] || ''
                aggregated.sleepStart = earliest
                aggregated.sleepEnd = latest
                // Calculate inBed from full span (includes awake gaps between sessions)
                if (earliest && latest) {
                  const spanMins = Math.round(
                    (new Date(latest).getTime() - new Date(earliest).getTime()) / 60000,
                  )
                  aggregated.inBed =
                    spanMins > 0 && spanMins <= 960 ? spanMins : aggregated.totalAsleep + 30
                } else {
                  aggregated.inBed = (existing.inBed || 0) + (aggregated.inBed || 0)
                }
                aggregated.sessionsCount = (existing.sessionsCount || 1) + 1
                console.log(
                  `Sleep merged: existing ${(existingTotal / 60).toFixed(1)}h + new ${(newTotal / 60).toFixed(1)}h = ${(aggregated.totalAsleep / 60).toFixed(1)}h for ${dateStr}, inBed=${aggregated.inBed}min`,
                )
              }
            } catch {}
          }
        }

        if (metricType === 'sleep' && isInflatedSleepValue(aggregated)) {
          const totalAsleep = aggregated.totalAsleep ?? aggregated.asleep ?? aggregated.qty
          console.warn(
            `[Health] Rejected inflated sleep row for ${dateStr}: totalAsleep=${totalAsleep}min`,
          )
          continue
        }

        insert.run(metricType, dateStr, JSON.stringify(aggregated))
        stored++
      }
    }
  })

  insertMany()
  console.log(
    `Stored ${stored} health metrics (aggregated from ${countRawEntries(grouped)} raw entries)`,
  )
  return stored
}

function countRawEntries(grouped: Record<string, Record<string, any[]>>): number {
  let total = 0
  for (const dates of Object.values(grouped)) {
    for (const entries of Object.values(dates)) {
      total += entries.length
    }
  }
  return total
}

function aggregateEntries(metricType: string, entries: any[]): any | null {
  // Pre-filter: skip zero/near-zero entries for metrics where zero means "not recorded"
  const zeroFilterTypes = ['basal_energy', 'distance']
  if (zeroFilterTypes.includes(metricType)) {
    const valid = entries.filter((e) => (e.qty ?? e.value ?? 0) > 0)
    if (valid.length === 0) return null
    entries = valid
  }
  // These metrics need >= 1 to be meaningful (fractional values are sensor noise)
  const nearZeroFilterTypes = ['exercise_time', 'flights_climbed', 'time_in_daylight']
  if (nearZeroFilterTypes.includes(metricType)) {
    const valid = entries.filter((e) => (e.qty ?? e.value ?? 0) >= 1)
    if (valid.length === 0) return null
    entries = valid
  }
  if (metricType === 'active_energy') {
    const valid = entries.filter((e) => (e.qty ?? e.value ?? 0) >= 1)
    if (valid.length === 0) return null
    entries = valid
  }
  if (metricType === 'vo2_max') {
    const valid = entries.filter((e) => {
      const value = e.qty ?? e.value ?? e.Avg ?? 0
      return typeof value === 'number' && value > 0 && value <= 90
    })
    if (valid.length === 0) return null
    entries = valid
  }
  if (metricType === 'steps') {
    const valid = entries.filter((e) => (e.qty ?? e.value ?? 0) >= 10)
    if (valid.length === 0) return null
    entries = valid
  }
  if (metricType === 'sleep') {
    // Check if these are stage fragments (have 'value' like "Core", "Deep")
    const isFragments = entries.some(
      (e) =>
        typeof e.value === 'string' &&
        [
          'Core',
          'Deep',
          'REM',
          'Awake',
          'InBed',
          'Asleep',
          'core',
          'deep',
          'rem',
          'awake',
          'inBed',
          'asleep',
        ].includes(e.value),
    )
    if (!isFragments) {
      // Non-fragment: check total duration
      // Health Auto Export aggregated format uses totalSleep in hours
      const totalAsleep = entries.reduce((sum, e) => {
        let dur = e.totalSleep ?? e.totalAsleep ?? 0
        if (dur > 0 && dur < 24) dur = dur * 60 // hours → minutes
        if (dur === 0) {
          dur = e.asleep ?? e.qty ?? 0
          if (dur > 0 && dur < 24) dur = dur * 60 // hours → minutes
        }
        if (dur === 0 && (e.core || e.rem || e.deep)) {
          dur = ((e.core || 0) + (e.rem || 0) + (e.deep || 0)) * 60
        }
        return sum + dur
      }, 0)
      if (totalAsleep < 60) return null
    }
    // Fragments are checked after reconstruction in the switch case
  }

  if (entries.length === 1 && metricType !== 'sleep') return entries[0]

  switch (metricType) {
    case 'heart_rate': {
      const values = entries
        .map((e) => e.qty ?? e.Avg ?? e.value)
        .filter((v): v is number => typeof v === 'number' && v > 0 && v <= 220)
      if (values.length === 0) return entries[entries.length - 1]
      return {
        ...entries[entries.length - 1],
        qty: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
        Avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
        Min: Math.min(...values),
        Max: Math.max(...values),
        readings: values.length,
      }
    }
    case 'hrv': {
      const values = entries
        .map((e) => e.qty ?? e.value)
        .filter((v): v is number => typeof v === 'number' && v > 0 && v < 300)
      if (values.length === 0) return entries[entries.length - 1]
      return {
        ...entries[entries.length - 1],
        qty: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        min: Math.min(...values),
        max: Math.max(...values),
        readings: values.length,
      }
    }
    case 'vo2_max': {
      const values = entries
        .map((e) => e.qty ?? e.value ?? e.Avg)
        .filter((v): v is number => typeof v === 'number' && v > 0 && v <= 90)
      if (values.length === 0) return null
      return {
        ...entries[entries.length - 1],
        qty: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
        readings: values.length,
      }
    }
    case 'steps': {
      const values = entries
        .map((e) => e.qty ?? e.value)
        .filter((v): v is number => typeof v === 'number')
      return {
        ...entries[entries.length - 1],
        qty: Math.round(values.reduce((a, b) => a + b, 0)),
        readings: values.length,
      }
    }
    case 'active_energy':
    case 'basal_energy': {
      const values = entries
        .map((e) => e.qty ?? e.value)
        .filter((v): v is number => typeof v === 'number')
      return {
        ...entries[entries.length - 1],
        qty: Math.round(values.reduce((a, b) => a + b, 0)),
        readings: values.length,
      }
    }
    case 'sleep': {
      // Detect fragment format: entries with 'value' field containing stage names
      // Health Auto Export sends individual stage records like:
      //   { qty: 0.42, value: "Core", start: "...", end: "..." }
      // where qty is in HOURS (not minutes) and value is the stage type
      const isFragments = entries.some(
        (e) =>
          typeof e.value === 'string' &&
          [
            'Core',
            'Deep',
            'REM',
            'Awake',
            'InBed',
            'Asleep',
            'core',
            'deep',
            'rem',
            'awake',
            'inBed',
            'asleep',
          ].includes(e.value),
      )

      if (isFragments) {
        // Reconstruct sleep session from stage fragments
        // Parse all fragments with timestamps
        const parsed: Array<{
          start: Date
          end: Date
          stage: string
          durationMins: number
          source: SleepSourceCategory
          rawSource: string
        }> = []
        for (const e of entries) {
          const startStr = e.start || e.startDate
          const endStr = e.end || e.endDate
          let durationMins = 0
          let start: Date | null = null
          let end: Date | null = null

          if (startStr && endStr) {
            start = new Date(startStr)
            end = new Date(endStr)
            durationMins = (end.getTime() - start.getTime()) / 60000
          } else if (e.qty) {
            durationMins = e.qty * 60
          }
          if (durationMins <= 0) continue
          const stage = (e.value || '').toLowerCase()
          if (stage === 'inbed' || stage === 'in bed') continue // skip inBed fragments for sleep total
          const rawSource = typeof e.source === 'string' ? e.source : ''
          parsed.push({
            start: start!,
            end: end!,
            stage,
            durationMins,
            source: categorizeSleepSource(rawSource),
            rawSource,
          })
        }

        // Source-aware preference: AutoSleep's motion-based detection is more
        // accurate than watch HR-based detection. If AutoSleep fragments are
        // present with substantial sleep data, drop watch fragments.
        const bySource = { autosleep: [] as typeof parsed, watch: [] as typeof parsed, other: [] as typeof parsed }
        for (const frag of parsed) bySource[frag.source].push(frag)
        const sourceSummary = Object.entries(bySource)
          .filter(([, frags]) => frags.length > 0)
          .map(
            ([src, frags]) =>
              `${src}=${frags.length} (${(frags.reduce((s, f) => s + (f.stage === 'awake' ? 0 : f.durationMins), 0) / 60).toFixed(1)}h)`,
          )
          .join(', ')
        if (sourceSummary) console.log(`Sleep fragment sources: ${sourceSummary}`)

        let preferredFragments = parsed
        if (bySource.autosleep.length > 0) {
          const autoSleepMins = bySource.autosleep.reduce(
            (s, f) => s + (f.stage === 'awake' ? 0 : f.durationMins),
            0,
          )
          if (autoSleepMins >= 60) {
            preferredFragments = bySource.autosleep.concat(bySource.other)
            console.log(
              `Sleep: using AutoSleep data only (${(autoSleepMins / 60).toFixed(1)}h), dropping ${bySource.watch.length} watch fragments`,
            )
          }
        }

        // Sort by start time, find the longest contiguous sleep session
        // (gap > 60 min = separate session, i.e. nap vs main sleep)
        preferredFragments.sort((a, b) => (a.start?.getTime() || 0) - (b.start?.getTime() || 0))

        // Group into sessions separated by >60 min gaps
        const sessions: (typeof preferredFragments)[] = []
        let currentSession: typeof preferredFragments = []
        for (const frag of preferredFragments) {
          if (!frag.start) {
            currentSession.push(frag)
            continue
          }
          if (currentSession.length > 0) {
            const lastEnd = currentSession[currentSession.length - 1].end
            if (lastEnd && frag.start.getTime() - lastEnd.getTime() > 60 * 60 * 1000) {
              sessions.push(currentSession)
              currentSession = []
            }
          }
          currentSession.push(frag)
        }
        if (currentSession.length > 0) sessions.push(currentSession)

        // Combine ALL sessions (main sleep + naps) for total daily sleep
        let bestSession = preferredFragments // fallback to all if no timestamps
        if (sessions.length > 1) {
          bestSession = sessions.flat()
          const sessionSummary = sessions
            .map((s) => `${(s.reduce((sum, f) => sum + f.durationMins, 0) / 60).toFixed(1)}h`)
            .join(' + ')
          console.log(
            `Sleep fragments: ${sessions.length} sessions combined (${sessionSummary}), ${bestSession.length} total fragments`,
          )
        }

        let deepMins = 0,
          remMins = 0,
          coreMins = 0,
          awakeMins = 0
        let earliest: Date | null = null
        let latest: Date | null = null

        for (const frag of bestSession) {
          if (frag.start && (!earliest || frag.start < earliest)) earliest = frag.start
          if (frag.end && (!latest || frag.end > latest)) latest = frag.end

          switch (frag.stage) {
            case 'deep':
              deepMins += frag.durationMins
              break
            case 'rem':
              remMins += frag.durationMins
              break
            case 'core':
            case 'light':
            case 'asleep':
              coreMins += frag.durationMins
              break
            case 'awake':
              awakeMins += frag.durationMins
              break
            default:
              coreMins += frag.durationMins
              break
          }
        }

        const totalAsleep = Math.round(deepMins + remMins + coreMins)
        // inBed = full time span from first sleep start to last sleep end (includes all awake gaps)
        const spanMins = earliest && latest ? (latest.getTime() - earliest.getTime()) / 60000 : 0
        const totalInBed =
          spanMins > totalAsleep ? Math.round(spanMins) : Math.round(totalAsleep + awakeMins)

        if (totalAsleep < 60) return null // Less than 1 hour

        console.log(
          `Sleep fragments aggregated: ${bestSession.length} fragments → ${totalAsleep}min (${(totalAsleep / 60).toFixed(1)}h), deep=${Math.round(deepMins)} rem=${Math.round(remMins)} core=${Math.round(coreMins)}`,
        )

        const awakeFinal = Math.round(awakeMins) || Math.max(0, totalInBed - totalAsleep)
        const sourceUsed = bestSession[0]?.rawSource || ''
        const sourceCategory = bestSession[0]?.source || 'other'
        const suspectWatchOvercount =
          sourceCategory === 'watch' &&
          totalAsleep > 0 &&
          coreMins / totalAsleep > 0.7 &&
          awakeFinal / Math.max(totalInBed, 1) < 0.05

        return {
          totalAsleep,
          deep: Math.round(deepMins),
          rem: Math.round(remMins),
          core: Math.round(coreMins),
          awake: awakeFinal,
          inBed: totalInBed,
          sleepStart: earliest ? earliest.toISOString() : '',
          sleepEnd: latest ? latest.toISOString() : '',
          sessions: bestSession.length,
          reconstructed: true,
          source: sourceUsed,
          sourceCategory,
          ...(suspectWatchOvercount ? { suspectWatchOvercount: true } : {}),
        }
      }

      // Non-fragment format: already-aggregated sessions
      // Health Auto Export aggregated format has core/rem/deep/awake/inBed in HOURS
      // and may not have a totalAsleep field — calculate from stages
      // Sum ALL sessions for the day (main sleep + nap)

      // Source-aware preference: if AutoSleep entries are present, drop watch entries.
      const sourceCounts = entries.reduce(
        (acc, e) => {
          const cat = categorizeSleepSource(e.source)
          acc[cat] = (acc[cat] || 0) + 1
          return acc
        },
        {} as Record<SleepSourceCategory, number>,
      )
      const sourceList = entries
        .map((e) => (typeof e.source === 'string' && e.source ? e.source : '(unknown)'))
        .filter((v, i, a) => a.indexOf(v) === i)
      if (entries.length > 1 || sourceList.length > 1) {
        console.log(
          `Sleep aggregated sources: ${sourceList.join(', ')} | counts: ${JSON.stringify(sourceCounts)}`,
        )
      }
      let workingEntries = entries
      if ((sourceCounts.autosleep || 0) > 0 && (sourceCounts.watch || 0) > 0) {
        const autoSleepEntries = entries.filter(
          (e) => categorizeSleepSource(e.source) !== 'watch',
        )
        if (autoSleepEntries.length > 0) {
          workingEntries = autoSleepEntries
          console.log(
            `Sleep aggregated: preferring AutoSleep, dropping ${entries.length - autoSleepEntries.length} watch entries`,
          )
        }
      }

      let totalAsleep = 0
      let deepMins = 0
      let remMins = 0
      let coreMins = 0
      let inBedMins = 0
      let best = workingEntries[0] // keep the longest for metadata (sleepStart/sleepEnd)
      let bestDuration = 0

      for (const e of workingEntries) {
        let dur = e.totalSleep ?? e.totalAsleep ?? 0
        if (dur > 0 && dur < 24) dur = dur * 60 // hours → minutes
        if (dur === 0) dur = e.asleep ?? e.qty ?? 0
        if (dur === 0 && (e.core || e.rem || e.deep)) {
          dur = ((e.core || 0) + (e.rem || 0) + (e.deep || 0)) * 60
        }
        if (dur > bestDuration) {
          bestDuration = dur
          best = e
        }
        totalAsleep += dur
        deepMins += e.deep || 0
        remMins += e.rem || 0
        coreMins += e.core || 0
        inBedMins += e.inBed || 0
      }

      totalAsleep = Math.round(totalAsleep)
      if (workingEntries.length > 1) {
        console.log(
          `Sleep sessions combined: ${workingEntries.length} entries → ${(totalAsleep / 60).toFixed(1)}h total`,
        )
      }

      // Stages are in hours (values typically < 12), convert to minutes
      if (deepMins > 0 && deepMins < 12) deepMins = Math.round(deepMins * 60)
      if (remMins > 0 && remMins < 12) remMins = Math.round(remMins * 60)
      if (coreMins > 0 && coreMins < 12) coreMins = Math.round(coreMins * 60)
      if (inBedMins > 0 && inBedMins < 12) inBedMins = Math.round(inBedMins * 60)

      // Calculate inBed from timestamps if field is 0
      // Check both inBedStart/inBedEnd and sleepStart/sleepEnd (Pixel Watch only has the latter)
      const inBedStartTs = best.inBedStart || best.sleepStart || ''
      const inBedEndTs = best.inBedEnd || best.sleepEnd || ''
      if (inBedMins === 0 && inBedStartTs && inBedEndTs) {
        const s = new Date(inBedStartTs)
        const e = new Date(inBedEndTs)
        if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
          inBedMins = Math.round((e.getTime() - s.getTime()) / 60000)
        }
      }

      if (totalAsleep < 60) return null

      const finalInBed = inBedMins || totalAsleep
      const awakeFinal = Math.max(0, finalInBed - totalAsleep)
      const sourceCategory = categorizeSleepSource(best.source)
      const suspectWatchOvercount =
        sourceCategory === 'watch' &&
        totalAsleep > 0 &&
        coreMins / totalAsleep > 0.7 &&
        awakeFinal / Math.max(finalInBed, 1) < 0.05

      return {
        totalAsleep,
        deep: deepMins,
        rem: remMins,
        core: coreMins,
        awake: awakeFinal,
        inBed: finalInBed,
        sleepStart: best.sleepStart || best.inBedStart || '',
        sleepEnd: best.sleepEnd || best.inBedEnd || '',
        source: best.source || '',
        sourceCategory,
        sessions: workingEntries.length,
        ...(suspectWatchOvercount ? { suspectWatchOvercount: true } : {}),
      }
    }
    default:
      // For unknown metrics, keep the last entry
      return entries[entries.length - 1]
  }
}

function extractDate(dateInput: string | undefined): string | null {
  if (!dateInput) return null
  try {
    const d = new Date(dateInput)
    if (isNaN(d.getTime())) return null
    return d.toISOString().split('T')[0]
  } catch {
    return null
  }
}

// --- File watcher mode ---

export function startFileWatcher(): void {
  const settings = getAppSettings()
  const watchPath = settings?.healthDataPath
  if (!watchPath || !fs.existsSync(watchPath)) {
    console.log('Health data path not configured or does not exist, skipping file watcher')
    return
  }

  stopFileWatcher()

  console.log(`Watching health data folder: ${watchPath}`)
  watcher = fs.watch(watchPath, (eventType, filename) => {
    if (!filename) return
    if (!filename.endsWith('.json') && !filename.endsWith('.csv')) return

    const filePath = path.join(watchPath, filename)
    setTimeout(() => {
      // Small delay to ensure file is fully written
      try {
        if (!fs.existsSync(filePath)) return
        const content = fs.readFileSync(filePath, 'utf-8')

        if (filename.endsWith('.json')) {
          const payload = JSON.parse(content)
          const count = parseAndStorePayload(payload)
          console.log(`Processed ${filename}: ${count} metrics`)
        } else if (filename.endsWith('.csv')) {
          const count = parseCsvHealthData(content)
          console.log(`Processed CSV ${filename}: ${count} metrics`)
        }
      } catch (err) {
        console.error(`Failed to process health file ${filename}:`, err)
      }
    }, 500)
  })
}

export function stopFileWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

// --- HTTP server mode ---

export function startHealthServer(): void {
  const settings = getAppSettings()
  const port = parseInt(settings?.healthServerPort ?? '', 10) || HEALTH_SERVER_PORT
  const authToken = settings?.relayToken?.trim() || ''
  const bindHost = authToken ? '0.0.0.0' : '127.0.0.1'

  stopHealthServer()

  server = http.createServer((req, res) => {
    // CORS for mobile app
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (authToken) {
      const supplied = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || ''
      const suppliedBytes = Buffer.from(supplied)
      const expectedBytes = Buffer.from(authToken)
      const valid =
        suppliedBytes.length === expectedBytes.length &&
        timingSafeEqual(suppliedBytes, expectedBytes)
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    } else if (req.headers.origin) {
      // Without a configured token the service is loopback-only. Also reject
      // browser-originated requests to prevent drive-by localhost mutations.
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Browser requests are not allowed' }))
      return
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const pathname = url.pathname

    if (
      req.method === 'POST' &&
      (pathname === '/' || pathname === '/health/import' || pathname === '/health/auto-export')
    ) {
      let body = ''
      let bodyBytes = 0
      let bodyTooLarge = false
      req.on('data', (chunk) => {
        if (bodyTooLarge) return
        bodyBytes += chunk.length
        if (bodyBytes > MAX_HEALTH_REQUEST_BYTES) {
          bodyTooLarge = true
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', message: 'Request body too large' }))
          return
        }
        body += chunk
      })
      req.on('end', () => {
        if (bodyTooLarge) return
        try {
          const payload = JSON.parse(body)
          const count = parseAndStorePayload(payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok', metrics_stored: count }))
          // Check if sleep data was included — trigger morning pipeline
          if (count > 0) {
            checkAndTriggerMorningSleepPipeline(payload)
          }
        } catch (err) {
          console.error('Failed to process health POST:', err)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }))
        }
      })
    } else if (req.method === 'POST' && pathname === '/health/sync') {
      // Receive health data from mobile/relay and store it
      let body = ''
      let bodyBytes = 0
      let bodyTooLarge = false
      req.on('data', (chunk) => {
        if (bodyTooLarge) return
        bodyBytes += chunk.length
        if (bodyBytes > MAX_HEALTH_REQUEST_BYTES) {
          bodyTooLarge = true
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', message: 'Request body too large' }))
          return
        }
        body += chunk
      })
      req.on('end', () => {
        if (bodyTooLarge) return
        try {
          const payload = JSON.parse(body)
          const metrics = payload.metrics || []
          const db = getDb()
          const stmt = db.prepare(
            `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
             VALUES (?, ?, ?, ?)`,
          )
          const existingWorkoutStmt = db.prepare(
            `SELECT value_json FROM health_metrics WHERE metric_type = 'workout' AND date = ?`,
          )
          let added = 0
          for (const m of metrics) {
            const valueParsed =
              typeof m.value === 'string'
                ? (() => {
                    try {
                      return JSON.parse(m.value)
                    } catch {
                      return null
                    }
                  })()
                : m.value
            // Re-bin sleep by local wake date so onset-dated pushes from older
            // clients land on the right day. Skip if we can't compute one.
            let dateStr: string = m.date
            if (m.type === 'sleep' && valueParsed && typeof valueParsed === 'object') {
              const wake = wakeDateFor(valueParsed)
              if (wake) dateStr = wake
            }
            if (
              m.type === 'workout' &&
              valueParsed &&
              typeof valueParsed === 'object' &&
              Array.isArray((valueParsed as Record<string, unknown>).workouts)
            ) {
              let existingWorkouts: any[] = []
              try {
                const existing = existingWorkoutStmt.get(dateStr) as
                  | { value_json: string }
                  | undefined
                const parsed = existing ? JSON.parse(existing.value_json) : null
                existingWorkouts = Array.isArray(parsed?.workouts) ? parsed.workouts : []
              } catch {}

              const merged = mergeWorkouts(
                existingWorkouts,
                (valueParsed as Record<string, unknown>).workouts as WorkoutEntry[],
              )
              const hasStrava = merged.some(isStravaWorkout)
              const hasNonStrava = merged.some((w) => !isStravaWorkout(w))
              const source =
                hasStrava && hasNonStrava ? 'mixed' : hasStrava ? 'strava' : m.source || 'mobile'
              stmt.run(m.type, dateStr, JSON.stringify({ workouts: merged }), source)
              added++
              continue
            }
            const valueJson = typeof m.value === 'string' ? m.value : JSON.stringify(m.value)
            stmt.run(m.type, dateStr, valueJson, m.source || 'mobile')
            added++
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok', added }))
          // Notify the renderer + run morning pipeline if sleep was included.
          if (added > 0) {
            checkAndTriggerMorningSleepPipeline({ metrics })
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }))
        }
      })
    } else if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'mien-health-receiver' }))
    } else if (req.method === 'GET' && pathname === '/health/data') {
      // Serve health data to mobile app
      const requestedDays = parseInt(url.searchParams.get('days') || '14', 10)
      const days = Number.isFinite(requestedDays)
        ? Math.min(Math.max(requestedDays, 1), 3650)
        : 14
      const db = getDb()
      const rows = db
        .prepare(
          `SELECT metric_type, date, value_json, source FROM health_metrics
         WHERE date >= date('now', '-' || ? || ' days') ORDER BY date DESC`,
        )
        .all(days) as Array<{
        metric_type: string
        date: string
        value_json: string
        source: string
      }>

      const metrics = rows.map((r) => ({
        type: r.metric_type,
        date: r.date,
        value: JSON.parse(r.value_json),
        source: r.source,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ metrics }))
    } else if (req.method === 'GET' && pathname === '/sleep/analysis') {
      // Pre-computed sleep analysis for mobile
      try {
        const sessions = parseSleepSessions(SLEEP_DEBT_WINDOW_DAYS)
        if (sessions.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ analysis: null }))
          return
        }

        const debt = calculateSleepDebt(sessions)
        const circadian = predictCircadianRhythm(sessions)
        const quality =
          sessions[0].totalAsleep > 0 ? scoreSleepQuality(sessions[0], sessions) : null
        const chronotype = detectChronotype(sessions)
        const socialJetLag = calculateSocialJetLag(sessions)
        const caffeineCutoff = calculateCaffeineCutoff(sessions)
        const hrvRecovery = calculateHrvRecovery()
        const wakeRecommendation = recommendWakeTime(circadian.optimalBedtime)
        const energyCurve = calculateEnergyCurve(sessions)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            analysis: {
              debt,
              circadian,
              quality,
              chronotype,
              socialJetLag,
              caffeineCutoff,
              hrvRecovery,
              wakeRecommendation,
              energyCurve,
            },
          }),
        )
      } catch (err) {
        console.error('Sleep analysis API error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Sleep analysis failed' }))
      }
    } else if (req.method === 'POST' && pathname === '/health/cleanup') {
      const db = getDb()
      const before = (
        db.prepare('SELECT COUNT(*) as cnt FROM health_metrics').get() as { cnt: number }
      ).cnt
      const details: Record<string, number> = {}

      const runCleanup = (label: string, sql: string) => {
        const result = db.prepare(sql).run()
        if (result.changes > 0) details[label] = result.changes
      }

      // Sleep under 1 hour (not recorded)
      runCleanup(
        'sleep_under_1h',
        `
        DELETE FROM health_metrics WHERE metric_type = 'sleep' AND (
          COALESCE(
            CAST(json_extract(value_json, '$.totalAsleep') AS REAL),
            CAST(json_extract(value_json, '$.asleep') AS REAL),
            CAST(json_extract(value_json, '$.qty') AS REAL),
            0
          ) < 60
        )
      `,
      )
      // Bad HRV (>300ms or <=0)
      runCleanup(
        'hrv_out_of_range',
        `DELETE FROM health_metrics WHERE metric_type = 'hrv' AND (
        CAST(json_extract(value_json, '$.qty') AS REAL) > 300 OR
        CAST(json_extract(value_json, '$.qty') AS REAL) <= 0
      )`,
      )
      // Bad HR (>220 or <=0)
      runCleanup(
        'hr_out_of_range',
        `DELETE FROM health_metrics WHERE metric_type = 'heart_rate' AND (
        COALESCE(
          CAST(json_extract(value_json, '$.qty') AS REAL),
          CAST(json_extract(value_json, '$.Avg') AS REAL),
          0
        ) > 220 OR
        COALESCE(
          CAST(json_extract(value_json, '$.qty') AS REAL),
          CAST(json_extract(value_json, '$.Avg') AS REAL),
          0
        ) <= 0
      )`,
      )
      // Zero-value metrics that mean "not recorded" (watch not worn / sensor off)
      runCleanup(
        'basal_energy_zero',
        `DELETE FROM health_metrics WHERE metric_type = 'basal_energy' AND
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) <= 0`,
      )
      runCleanup(
        'active_energy_near_zero',
        `DELETE FROM health_metrics WHERE metric_type = 'active_energy' AND
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) < 1`,
      )
      runCleanup(
        'steps_near_zero',
        `DELETE FROM health_metrics WHERE metric_type = 'steps' AND
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) < 10`,
      )
      runCleanup(
        'distance_zero',
        `DELETE FROM health_metrics WHERE metric_type = 'distance' AND
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) <= 0`,
      )
      runCleanup(
        'exercise_time_junk',
        `DELETE FROM health_metrics WHERE metric_type = 'exercise_time' AND
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) < 1`,
      )
      runCleanup(
        'flights_climbed_junk',
        `DELETE FROM health_metrics WHERE metric_type = 'flights_climbed' AND
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) < 1`,
      )
      runCleanup(
        'time_in_daylight_junk',
        `DELETE FROM health_metrics WHERE metric_type = 'time_in_daylight' AND
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) < 1`,
      )
      runCleanup(
        'vo2_max_out_of_range',
        `DELETE FROM health_metrics WHERE metric_type = 'vo2_max' AND (
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) <= 0 OR
        COALESCE(CAST(json_extract(value_json, '$.qty') AS REAL), 0) > 90
      )`,
      )
      // Remove inflated reconstructed sleep data (>12h is almost certainly wrong)
      runCleanup(
        'sleep_reconstructed_inflated',
        `DELETE FROM health_metrics WHERE metric_type = 'sleep' AND
        json_extract(value_json, '$.reconstructed') = 1 AND
        COALESCE(CAST(json_extract(value_json, '$.totalAsleep') AS REAL), 0) > 600`,
      )

      const after = (
        db.prepare('SELECT COUNT(*) as cnt FROM health_metrics').get() as { cnt: number }
      ).cnt
      const removed = before - after
      console.log(`Cleanup: removed ${removed} bad entries`, details)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ removed, before, after, details }))
    } else if (req.method === 'GET' && pathname === '/finance/news') {
      // Serve cached news articles to mobile (active/non-archived only).
      const db = getDb()
      const articles = db
        .prepare(
          `SELECT title, url, source, published_at, related_symbols FROM news_articles
         WHERE archived_at IS NULL
         ORDER BY published_at DESC LIMIT 30`,
        )
        .all()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ articles }))
    } else if (req.method === 'GET' && pathname === '/finance/prices') {
      // Serve cached price data to mobile
      const db = getDb()
      const watchlist = db
        .prepare('SELECT symbol, type, name FROM watchlist ORDER BY added_at DESC')
        .all()
      const prices = db
        .prepare(
          `SELECT p.symbol, p.date, p.close, p.open, p.high, p.low, p.volume
         FROM price_history p
         WHERE p.date >= date('now', '-30 days')
         ORDER BY p.symbol, p.date DESC`,
        )
        .all()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ watchlist, prices }))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })

  const MAX_PORT_INCREMENT = 10
  let attempt = 0

  const tryListen = (currentPort: number): void => {
    server!.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_INCREMENT) {
        attempt++
        console.warn(`Health server: port ${currentPort} in use, trying ${currentPort + 1}`)
        // Server emits 'error' before it's listening; safe to re-call listen.
        tryListen(currentPort + 1)
      } else {
        console.error('Health server error:', err)
        boundPort = null
      }
    })
    server!.listen(currentPort, bindHost, () => {
      boundPort = currentPort
      console.log(
        `Health data server listening on ${bindHost}:${currentPort}${authToken ? ' (bearer auth required)' : ' (loopback only; configure a relay token for LAN access)'}`,
      )
    })
  }

  tryListen(port)
}

// --- Morning Sleep Pipeline ---

export function broadcastSleepArrived(): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('health:sleep-data-arrived', { timestamp: Date.now() })
  }
}

let inFlightSleepBriefing: Promise<void> | null = null

/**
 * Generate today's morning_sleep briefing if it hasn't been generated yet.
 * Idempotent and safe to call from multiple paths: HTTP arrival, relay pull,
 * scheduler cron, app startup. Uses the briefings table as source of truth
 * instead of relying solely on the store-key debounce, so a missing row
 * always triggers regeneration even if the store key is stale.
 */
export function runMorningSleepBriefingIfDue(opts: { reason: string }): Promise<void> {
  if (inFlightSleepBriefing) return inFlightSleepBriefing

  inFlightSleepBriefing = (async () => {
    try {
      const settings = getAppSettings()
      if (settings?.enableMorningSleepBriefing === 'false') return

      const today = new Date().toISOString().split('T')[0]
      const db = getDb()
      const existing = db
        .prepare(`SELECT 1 AS ok FROM briefings WHERE type='morning_sleep' AND date=?`)
        .get(today) as { ok: 1 } | undefined
      if (existing) return

      const sleepCount = db
        .prepare(
          `SELECT COUNT(*) AS c FROM health_metrics WHERE metric_type='sleep' AND excluded=0`,
        )
        .get() as { c: number }
      if (!sleepCount || sleepCount.c === 0) return

      console.log(`[Health] Generating morning sleep briefing (trigger: ${opts.reason})`)
      const content = await generateBriefing('morning_sleep')
      store.set('scheduler.lastRun.morning-sleep', Date.now())

      if (Notification.isSupported()) {
        new Notification({
          title: 'Morning Sleep Report',
          body: content.length > 100 ? content.substring(0, 100) + '...' : content,
        }).show()
      }
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('briefing:new', { type: 'morning_sleep' })
      }
      console.log('[Health] Morning sleep briefing generated')
    } catch (err) {
      console.error('[Health] runMorningSleepBriefingIfDue failed:', err)
    } finally {
      inFlightSleepBriefing = null
    }
  })()

  return inFlightSleepBriefing
}

function checkAndTriggerMorningSleepPipeline(payload: any): void {
  try {
    const hasSleep = detectSleepInPayload(payload)
    if (!hasSleep) return

    console.log('[Health] New sleep data detected — broadcasting to renderer')
    broadcastSleepArrived()

    checkHealthAlerts().catch((err) =>
      console.error('[Health] health-alerts after sleep-arrived failed:', err),
    )

    // Slight delay so the just-arrived data is persisted before the briefing reads it.
    setTimeout(() => {
      runMorningSleepBriefingIfDue({ reason: 'http-arrival' })
    }, 2000)
  } catch (err) {
    console.error('[Health] Morning pipeline check failed:', err)
  }
}

function detectSleepInPayload(payload: any): boolean {
  // Check Health Auto Export format
  if (payload?.data?.metrics) {
    return payload.data.metrics.some((m: any) => {
      const name = (m.name || '').toLowerCase()
      return name.includes('sleep') || name.includes('in_bed') || name.includes('inbed')
    })
  }
  // Check { metrics: [{ type, date, value }, ...] } (relay /health/sync shape)
  if (Array.isArray(payload?.metrics)) {
    return payload.metrics.some((m: any) => (m.type || '').toLowerCase() === 'sleep')
  }
  // Check array format
  if (Array.isArray(payload)) {
    return payload.some((entry: any) => {
      const name = (entry.name || entry.metric || entry.type || '').toLowerCase()
      return name.includes('sleep') || name.includes('in_bed')
    })
  }
  // Check single metric
  if (payload?.name || payload?.metric) {
    const name = (payload.name || payload.metric || '').toLowerCase()
    return name.includes('sleep')
  }
  return false
}

export function stopHealthServer(): void {
  if (server) {
    server.close()
    server = null
    boundPort = null
  }
}

// --- Manual import ---

export function importHealthFile(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf-8')
  if (filePath.endsWith('.json')) {
    const payload = JSON.parse(content)
    return parseAndStorePayload(payload)
  } else if (filePath.endsWith('.csv')) {
    return parseCsvHealthData(content)
  }
  throw new Error('Unsupported file format. Use .json or .csv')
}

// --- CSV parsing (basic) ---

function parseCsvHealthData(csvContent: string): number {
  const db = getDb()
  const insert = db.prepare(`
    INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
    VALUES (?, ?, ?, 'health_auto_export')
  `)

  const lines = csvContent.trim().split('\n')
  if (lines.length < 2) return 0

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const typeIndex = headers.findIndex((h) => h === 'type' || h === 'metric' || h === 'name')
  const dateIndex = headers.findIndex((h) => h === 'date' || h === 'start' || h === 'startdate')
  const valueIndex = headers.findIndex((h) => h === 'value' || h === 'qty' || h === 'quantity')

  if (dateIndex === -1) return 0

  let stored = 0
  const insertMany = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim())
      const rawType = typeIndex >= 0 ? cols[typeIndex] : 'unknown'
      const metricType = normalizeMetricName(rawType) || rawType
      const dateStr = extractDate(cols[dateIndex])
      if (!dateStr) continue

      const rowData: Record<string, string> = {}
      for (let j = 0; j < headers.length; j++) {
        rowData[headers[j]] = cols[j]
      }

      insert.run(metricType, dateStr, JSON.stringify(rowData))
      stored++
    }
  })

  insertMany()
  return stored
}

// --- Recalculate historical sleep inBed from timestamps ---

export function recalculateSleepInBed(): { updated: number; total: number; details: string[] } {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, date, value_json FROM health_metrics WHERE metric_type = 'sleep' ORDER BY date`,
    )
    .all() as Array<{ id: number; date: string; value_json: string }>
  const details: string[] = []
  let updated = 0

  const update = db.prepare(`UPDATE health_metrics SET value_json = ? WHERE id = ?`)
  const txn = db.transaction(() => {
    for (const row of rows) {
      try {
        const val = JSON.parse(row.value_json)
        const sleepStart = val.sleepStart
        const sleepEnd = val.sleepEnd
        if (!sleepStart || !sleepEnd) continue

        const startDt = new Date(sleepStart)
        const endDt = new Date(sleepEnd)
        if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) continue

        const spanMins = Math.round((endDt.getTime() - startDt.getTime()) / 60000)
        const totalAsleep = val.totalAsleep || 0
        if (spanMins <= 0 || spanMins < totalAsleep) continue

        const oldInBed = val.inBed || 0
        // Cap at 16h — longer spans indicate bad timestamp data
        const newInBed = spanMins > 960 ? totalAsleep + 30 : spanMins

        // Only update if the new inBed is meaningfully different
        if (Math.abs(newInBed - oldInBed) < 2) continue

        val.inBed = newInBed
        update.run(JSON.stringify(val), row.id)

        const oldEff = oldInBed > 0 ? Math.round((totalAsleep / oldInBed) * 100) : 0
        const newEff = newInBed > 0 ? Math.round((totalAsleep / newInBed) * 100) : 0
        details.push(`${row.date}: inBed ${oldInBed}→${newInBed}min, eff ${oldEff}→${newEff}%`)
        updated++
      } catch {
        /* skip malformed rows */
      }
    }
  })
  txn()

  console.log(`Sleep inBed recalculation: updated ${updated}/${rows.length} records`)
  return { updated, total: rows.length, details }
}

// --- Backfill awake time for existing sleep records ---

export function backfillSleepAwake(): { updated: number; total: number } {
  const db = getDb()
  const rows = db
    .prepare(`SELECT id, date, value_json FROM health_metrics WHERE metric_type = 'sleep'`)
    .all() as Array<{ id: number; date: string; value_json: string }>
  let updated = 0

  const update = db.prepare(`UPDATE health_metrics SET value_json = ? WHERE id = ?`)
  const txn = db.transaction(() => {
    for (const row of rows) {
      try {
        const val = JSON.parse(row.value_json)
        if (val.awake && val.awake > 0) continue // already has awake data
        const totalAsleep = val.totalAsleep || val.asleep || 0
        const inBed = val.inBed || 0
        if (totalAsleep <= 0 || inBed <= 0) continue
        const awake = Math.max(0, inBed - totalAsleep)
        if (awake === 0) continue
        val.awake = awake
        update.run(JSON.stringify(val), row.id)
        updated++
      } catch {
        /* skip malformed rows */
      }
    }
  })
  txn()

  console.log(`Sleep awake backfill: updated ${updated}/${rows.length} records`)
  return { updated, total: rows.length }
}

// --- Startup ---

export function initHealthServices(): void {
  startFileWatcher()
  startHealthServer()
  // One-time backfill: populate awake time for existing sleep records
  try {
    backfillSleepAwake()
  } catch (e) {
    console.error('Sleep awake backfill error:', e)
  }
}

export function shutdownHealthServices(): void {
  stopFileWatcher()
  stopHealthServer()
}
