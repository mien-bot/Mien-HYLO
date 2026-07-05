/**
 * HealthKit integration — reads Apple Health data directly on iOS.
 * Requires a development build (not Expo Go) since react-native-health is a native module.
 */
import AppleHealthKit, {
  HealthKitPermissions,
  HealthValue,
  HealthInputOptions,
} from 'react-native-health'
import { Platform } from 'react-native'
import { getDb } from '../lib/database'

const permissions: HealthKitPermissions = {
  permissions: {
    read: [
      AppleHealthKit.Constants.Permissions.SleepAnalysis,
      AppleHealthKit.Constants.Permissions.HeartRate,
      AppleHealthKit.Constants.Permissions.HeartRateVariability,
      AppleHealthKit.Constants.Permissions.StepCount,
      AppleHealthKit.Constants.Permissions.ActiveEnergyBurned,
      AppleHealthKit.Constants.Permissions.RestingHeartRate,
      AppleHealthKit.Constants.Permissions.OxygenSaturation,
      AppleHealthKit.Constants.Permissions.RespiratoryRate,
      AppleHealthKit.Constants.Permissions.Vo2Max,
      AppleHealthKit.Constants.Permissions.Workout,
    ],
    write: [],
  },
}

let initialized = false

export async function initHealthKit(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false
  if (initialized) return true

  return new Promise((resolve) => {
    AppleHealthKit.initHealthKit(permissions, (err) => {
      if (err) {
        console.error('HealthKit init error:', err)
        resolve(false)
        return
      }
      initialized = true
      resolve(true)
    })
  })
}

export function isHealthKitAvailable(): boolean {
  return Platform.OS === 'ios'
}

// --- Data Fetchers ---

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function getDateString(date: Date): string {
  // Use local date (matches what the user sees on the device clock),
  // not UTC — `toISOString` would roll evenings into the next day.
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function wakeDateOf(sample: { startDate: string; endDate: string }): string {
  const end = new Date(sample.endDate)
  if (!isNaN(end.getTime())) return getDateString(end)
  // No end timestamp — fall back to start + 6h.
  const start = new Date(sample.startDate)
  return getDateString(new Date(start.getTime() + 6 * 60 * 60 * 1000))
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(0, 0, 0, 0)
  return d
}

export async function fetchSleepData(days: number = 14): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
  }

  return new Promise((resolve) => {
    AppleHealthKit.getSleepSamples(options, async (err, results) => {
      if (err || !results) {
        console.error('Sleep fetch error:', err)
        resolve()
        return
      }

      // Source-aware filter: AutoSleep's motion-based detection is much more
      // accurate than Apple Watch's HR-based algorithm (watch over-reports by
      // counting awake-in-bed time as Core sleep). If both sources have samples,
      // drop watch samples and keep AutoSleep only. Mirrors the desktop fix in
      // src/main/services/health/health-export.service.ts.
      const sourceOf = (sample: any): 'autosleep' | 'watch' | 'other' => {
        const name = String(sample?.sourceName || sample?.sourceId || '').toLowerCase()
        if (name.includes('autosleep')) return 'autosleep'
        if (name.includes('watch')) return 'watch'
        return 'other'
      }
      const uniqueSources = Array.from(
        new Set(results.map((s: any) => s?.sourceName || s?.sourceId || '(unknown)'))
      )
      console.log(`Sleep HealthKit sources: ${uniqueSources.join(', ')} (${results.length} samples)`)
      const hasAutoSleep = results.some((s: any) => sourceOf(s) === 'autosleep')
      const filteredResults = hasAutoSleep
        ? results.filter((s: any) => sourceOf(s) !== 'watch')
        : results
      if (hasAutoSleep && filteredResults.length < results.length) {
        console.log(
          `Sleep: preferring AutoSleep, dropped ${results.length - filteredResults.length} watch samples`
        )
      }

      // Group sleep samples by night (use end date's date)
      const nights: Record<string, {
        asleep: number; deep: number; rem: number; core: number; inBed: number
        sleepStart: string | null; sleepEnd: string | null
      }> = {}

      for (const sample of filteredResults) {
        // Bin by the local wake date (date of sample.endDate).
        const nightDate = wakeDateOf(sample as any)

        if (!nights[nightDate]) {
          nights[nightDate] = { asleep: 0, deep: 0, rem: 0, core: 0, inBed: 0, sleepStart: null, sleepEnd: null }
        }

        // Track earliest start and latest end for bedtime/wake time
        if (!nights[nightDate].sleepStart || sample.startDate < nights[nightDate].sleepStart!) {
          nights[nightDate].sleepStart = sample.startDate
        }
        if (!nights[nightDate].sleepEnd || sample.endDate > nights[nightDate].sleepEnd!) {
          nights[nightDate].sleepEnd = sample.endDate
        }

        const durationMins = (new Date(sample.endDate).getTime() - new Date(sample.startDate).getTime()) / 60000

        const value = (sample as any).value
        switch (value) {
          case 'ASLEEP':
          case 'ASLEEP_CORE':
            nights[nightDate].core += durationMins
            nights[nightDate].asleep += durationMins
            break
          case 'ASLEEP_DEEP':
            nights[nightDate].deep += durationMins
            nights[nightDate].asleep += durationMins
            break
          case 'ASLEEP_REM':
            nights[nightDate].rem += durationMins
            nights[nightDate].asleep += durationMins
            break
          case 'INBED':
            nights[nightDate].inBed += durationMins
            break
          default:
            // Older iOS versions just report ASLEEP
            if (value === 'ASLEEP_UNSPECIFIED' || !value) {
              nights[nightDate].asleep += durationMins
              nights[nightDate].core += durationMins
            }
        }
      }

      // Save to database
      const db = await getDb()
      for (const [date, data] of Object.entries(nights)) {
        if (data.asleep < 30) continue // Skip very short entries
        const valueJson = JSON.stringify({
          totalAsleep: Math.round(data.asleep),
          deep: Math.round(data.deep),
          rem: Math.round(data.rem),
          core: Math.round(data.core),
          inBed: Math.round(data.inBed),
          sleepStart: data.sleepStart,
          sleepEnd: data.sleepEnd,
        })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('sleep', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }

      resolve()
    })
  })
}

export async function fetchWorkouts(days: number = 14): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
  }

  return new Promise((resolve) => {
    AppleHealthKit.getAnchoredWorkouts(options, async (err, results) => {
      if (err || !results || !results.data || results.data.length === 0) {
        resolve()
        return
      }

      // Group workouts by the local date of `start`. Desktop stores one row per
      // day under metric_type='workout' with shape: { workouts: [{...}, ...] }.
      const byDate: Record<string, Array<{ name: string; duration: number; calories: number; distance: number; start: string; end: string }>> = {}
      for (const w of results.data) {
        if (!w.start) continue
        const dateStr = getDateString(new Date(w.start))
        // getAnchoredWorkouts returns duration as NSTimeInterval (always seconds),
        // distance already in miles, calories already in kcal (per
        // react-native-health docs/getAnchoredWorkouts.md).
        const durationMins = (w.duration || 0) / 60
        if (durationMins < 1) continue

        const entry = {
          name: (w as any).activityName ? String((w as any).activityName) : 'Workout',
          duration: Math.round(durationMins),
          calories: Math.round(w.calories || 0),
          distance: parseFloat(((w.distance || 0)).toFixed(2)),
          start: w.start,
          end: w.end,
        }
        if (!byDate[dateStr]) byDate[dateStr] = []
        byDate[dateStr].push(entry)
      }

      const db = await getDb()
      for (const [date, workouts] of Object.entries(byDate)) {
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('workout', ?, ?, 'healthkit')`,
          date, JSON.stringify({ workouts })
        )
      }
      resolve()
    })
  })
}

export async function fetchHeartRate(days: number = 7): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
    ascending: false,
    limit: 100,
  }

  return new Promise((resolve) => {
    AppleHealthKit.getHeartRateSamples(options, async (err, results) => {
      if (err || !results || results.length === 0) {
        resolve()
        return
      }

      const db = await getDb()

      // Group by date, store latest reading per day
      const byDate: Record<string, { value: number; min: number; max: number; count: number }> = {}
      for (const sample of results) {
        const date = getDateString(new Date(sample.startDate))
        if (!byDate[date]) {
          byDate[date] = { value: sample.value, min: sample.value, max: sample.value, count: 1 }
        } else {
          byDate[date].value = sample.value // latest
          byDate[date].min = Math.min(byDate[date].min, sample.value)
          byDate[date].max = Math.max(byDate[date].max, sample.value)
          byDate[date].count++
        }
      }

      for (const [date, data] of Object.entries(byDate)) {
        const valueJson = JSON.stringify({
          qty: Math.round(data.value),
          min: Math.round(data.min),
          max: Math.round(data.max),
          samples: data.count,
        })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('heart_rate', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }

      resolve()
    })
  })
}

export async function fetchHRV(days: number = 7): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
    ascending: false,
    limit: 50,
  }

  return new Promise((resolve) => {
    AppleHealthKit.getHeartRateVariabilitySamples(options, async (err, results) => {
      if (err || !results || results.length === 0) {
        resolve()
        return
      }

      const db = await getDb()
      const byDate: Record<string, number> = {}

      for (const sample of results) {
        const date = getDateString(new Date(sample.startDate))
        // HRV is in seconds from HealthKit, convert to ms
        const ms = sample.value * 1000
        if (!byDate[date] || ms > byDate[date]) {
          byDate[date] = ms
        }
      }

      for (const [date, value] of Object.entries(byDate)) {
        const valueJson = JSON.stringify({ qty: Math.round(value) })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('hrv', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }

      resolve()
    })
  })
}

export async function fetchSteps(days: number = 7): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
  }

  return new Promise((resolve) => {
    AppleHealthKit.getDailyStepCountSamples(options, async (err, results) => {
      if (err || !results || results.length === 0) {
        resolve()
        return
      }

      const db = await getDb()

      for (const sample of results) {
        const date = getDateString(new Date(sample.startDate))
        const valueJson = JSON.stringify({ qty: Math.round(sample.value) })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('steps', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }

      resolve()
    })
  })
}

/**
 * Fetch resting heart rate (Apple Watch calculates this daily)
 */
export async function fetchRestingHeartRate(days: number = 14): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
  }

  return new Promise((resolve) => {
    AppleHealthKit.getRestingHeartRate(options, async (err: any, results: any) => {
      if (err || !results || results.length === 0) { resolve(); return }
      const db = await getDb()
      for (const sample of results) {
        const date = getDateString(new Date(sample.startDate || sample.endDate))
        const valueJson = JSON.stringify({ qty: Math.round(sample.value) })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('resting_heart_rate', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }
      resolve()
    })
  })
}

/**
 * Fetch active energy burned (calories)
 */
export async function fetchActiveEnergy(days: number = 7): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
  }

  return new Promise((resolve) => {
    AppleHealthKit.getActiveEnergyBurned(options, async (err: any, results: any) => {
      if (err || !results || results.length === 0) { resolve(); return }
      const db = await getDb()
      // Aggregate by day
      const byDate: Record<string, number> = {}
      for (const sample of results) {
        const date = getDateString(new Date(sample.startDate))
        byDate[date] = (byDate[date] || 0) + sample.value
      }
      for (const [date, kcal] of Object.entries(byDate)) {
        const valueJson = JSON.stringify({ qty: Math.round(kcal) })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('active_energy', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }
      resolve()
    })
  })
}

/**
 * Fetch blood oxygen (SpO2)
 */
export async function fetchBloodOxygen(days: number = 7): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
  }

  return new Promise((resolve) => {
    AppleHealthKit.getOxygenSaturationSamples(options, async (err: any, results: any) => {
      if (err || !results || results.length === 0) { resolve(); return }
      const db = await getDb()
      // Store latest per day (value is 0-1, convert to percentage)
      const byDate: Record<string, number> = {}
      for (const sample of results) {
        const date = getDateString(new Date(sample.startDate))
        const pct = sample.value > 1 ? sample.value : sample.value * 100
        if (!byDate[date] || pct > byDate[date]) {
          byDate[date] = pct
        }
      }
      for (const [date, value] of Object.entries(byDate)) {
        const valueJson = JSON.stringify({ qty: Math.round(value * 10) / 10 })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('blood_oxygen', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }
      resolve()
    })
  })
}

/**
 * Fetch respiratory rate (breaths per minute, measured during sleep)
 */
export async function fetchRespiratoryRate(days: number = 7): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
  }

  return new Promise((resolve) => {
    AppleHealthKit.getRespiratoryRateSamples(options, async (err: any, results: any) => {
      if (err || !results || results.length === 0) { resolve(); return }
      const db = await getDb()
      const byDate: Record<string, number> = {}
      for (const sample of results) {
        const date = getDateString(new Date(sample.startDate))
        if (!byDate[date]) byDate[date] = sample.value
      }
      for (const [date, value] of Object.entries(byDate)) {
        const valueJson = JSON.stringify({ qty: Math.round(value * 10) / 10 })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('respiratory_rate', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }
      resolve()
    })
  })
}

/**
 * Fetch VO2 Max (cardio fitness, updated after workouts)
 */
export async function fetchVo2Max(days: number = 30): Promise<void> {
  if (!initialized) return

  const options: HealthInputOptions = {
    startDate: daysAgo(days).toISOString(),
    endDate: new Date().toISOString(),
  }

  return new Promise((resolve) => {
    AppleHealthKit.getVo2MaxSamples(options, async (err: any, results: any) => {
      if (err || !results || results.length === 0) { resolve(); return }
      const db = await getDb()
      for (const sample of results) {
        const date = getDateString(new Date(sample.startDate || sample.endDate))
        const valueJson = JSON.stringify({ qty: Math.round(sample.value * 10) / 10 })
        await db.runAsync(
          `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
           VALUES ('vo2_max', ?, ?, 'healthkit')`,
          date, valueJson
        )
      }
      resolve()
    })
  })
}

/**
 * Full sync — call on app open and pull-to-refresh
 */
export async function syncAllHealthData(): Promise<{ success: boolean; error?: string }> {
  try {
    const ok = await initHealthKit()
    if (!ok) {
      return { success: false, error: 'HealthKit not available or permission denied' }
    }

    await Promise.all([
      fetchSleepData(14),
      fetchWorkouts(14),
      fetchHeartRate(7),
      fetchHRV(7),
      fetchSteps(7),
      fetchRestingHeartRate(14),
      fetchActiveEnergy(7),
      fetchBloodOxygen(7),
      fetchRespiratoryRate(7),
      fetchVo2Max(30),
    ])

    return { success: true }
  } catch (err: any) {
    console.error('Health sync error:', err)
    return { success: false, error: err.message }
  }
}
