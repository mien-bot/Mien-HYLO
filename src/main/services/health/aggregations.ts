/**
 * Health aggregations — time-series, day-of-week buckets, and circadian helpers
 * derived from the health_metrics table and existing analysis services.
 *
 * Same in-memory cache pattern as the finance aggregations.
 */

import { getDb } from '../../db/database'
import { getFullFitnessAnalysis } from './fitness-analysis'
import { parseSleepSessions, predictCircadianRhythm } from './sleep-analysis'
import {
  CACHE_TTL_MS,
  DEFAULT_CHART_DAYS,
  DEFAULT_ROLLING_WINDOWS,
  DEFAULT_TRAINING_DAYS,
  SLEEP_DEBT_WINDOW_DAYS,
} from '@shared/constants'

interface CacheEntry<T> {
  expires: number
  value: T
}

const CACHE = new Map<string, CacheEntry<any>>()

function cached<T>(key: string, compute: () => T): T {
  const now = Date.now()
  const hit = CACHE.get(key)
  if (hit && hit.expires > now) return hit.value as T
  const value = compute()
  CACHE.set(key, { value, expires: now + CACHE_TTL_MS })
  return value
}

// --- Rolling averages ---

export interface RollingPoint {
  date: string
  value: number
  rolling7?: number | null
  rolling14?: number | null
  rolling30?: number | null
}

function pickScalar(parsed: Record<string, unknown>, metricType: string): number | null {
  if (metricType === 'sleep') {
    const v = parsed.asleep ?? parsed.totalAsleep ?? parsed.qty ?? null
    return typeof v === 'number' ? v / 60 : null // hours
  }
  if (metricType === 'hrv') {
    const v = parsed.avg ?? parsed.value ?? parsed.qty ?? null
    return typeof v === 'number' ? v : null
  }
  if (metricType === 'heart_rate') {
    const v = parsed.avg ?? parsed.average ?? parsed.qty ?? null
    return typeof v === 'number' ? v : null
  }
  const numericKeys = ['qty', 'value', 'avg', 'total']
  for (const k of numericKeys) {
    const v = parsed[k]
    if (typeof v === 'number') return v
  }
  return null
}

function rolling(values: Array<number | null>, window: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1)
    let sum = 0
    let n = 0
    for (let j = start; j <= i; j++) {
      const v = values[j]
      if (v != null) {
        sum += v
        n += 1
      }
    }
    if (n >= Math.min(3, window)) {
      out[i] = sum / n
    }
  }
  return out
}

export function getMetricRollingAverages(
  metricType: string,
  windows: number[] = [...DEFAULT_ROLLING_WINDOWS],
  days = DEFAULT_TRAINING_DAYS,
): RollingPoint[] {
  const key = `roll:${metricType}:${windows.join(',')}:${days}`
  return cached(key, () => {
    const db = getDb()
    const rows = db
      .prepare(
        `
      SELECT date, value_json FROM health_metrics
      WHERE metric_type = ?
        AND (? != 'sleep' OR excluded = 0)
        AND date >= date('now', '-' || ? || ' days')
      ORDER BY date ASC
    `,
      )
      .all(metricType, metricType, days) as Array<{ date: string; value_json: string }>

    const parsed = rows.map((r) => {
      try {
        const data = JSON.parse(r.value_json)
        return { date: r.date, value: pickScalar(data, metricType) }
      } catch {
        return { date: r.date, value: null }
      }
    })

    const values = parsed.map((p) => p.value)
    const series7 = windows.includes(7) ? rolling(values, 7) : null
    const series14 = windows.includes(14) ? rolling(values, 14) : null
    const series30 = windows.includes(30) ? rolling(values, 30) : null

    return parsed
      .filter((p) => p.value != null)
      .map((p, _ignored, _arr): RollingPoint => {
        const idx = parsed.findIndex((x) => x.date === p.date)
        return {
          date: p.date,
          value: p.value as number,
          rolling7: series7?.[idx] ?? null,
          rolling14: series14?.[idx] ?? null,
          rolling30: series30?.[idx] ?? null,
        }
      })
  })
}

// --- Sleep stage history ---

export interface StagePoint {
  date: string
  deepPct: number
  remPct: number
  lightPct: number
  awakePct: number
  asleepHours: number
}

export function getSleepStageHistory(days = DEFAULT_CHART_DAYS): StagePoint[] {
  const key = `stages:${days}`
  return cached(key, () => {
    const db = getDb()
    const rows =
      days > 0
        ? (db
            .prepare(
              `
        SELECT date, value_json FROM health_metrics
        WHERE metric_type = 'sleep' AND excluded = 0
          AND date >= date('now', '-' || ? || ' days')
        ORDER BY date ASC
      `,
            )
            .all(days) as Array<{ date: string; value_json: string }>)
        : (db
            .prepare(
              `
        SELECT date, value_json FROM health_metrics
        WHERE metric_type = 'sleep' AND excluded = 0
        ORDER BY date ASC
      `,
            )
            .all() as Array<{ date: string; value_json: string }>)

    return rows
      .map((r): StagePoint | null => {
        try {
          const d = JSON.parse(r.value_json)
          const asleepMin = d.asleep ?? d.totalAsleep ?? d.total_asleep ?? d.qty ?? d.value ?? 0
          const deepMin = d.deep ?? d.deepSleep ?? 0
          const remMin = d.rem ?? d.remSleep ?? 0
          const lightMin = d.core ?? d.coreSleep ?? d.light ?? 0
          const awakeMin = d.awake ?? d.awakeTime ?? 0
          const total = deepMin + remMin + lightMin + awakeMin
          if (asleepMin < 60) return null
          return {
            date: r.date,
            asleepHours: asleepMin / 60,
            deepPct: total > 0 ? (deepMin / total) * 100 : 0,
            remPct: total > 0 ? (remMin / total) * 100 : 0,
            lightPct: total > 0 ? (lightMin / total) * 100 : 0,
            awakePct: total > 0 ? (awakeMin / total) * 100 : 0,
          }
        } catch {
          return null
        }
      })
      .filter((p): p is StagePoint => p !== null)
  })
}

// --- Circadian 24h polar phases ---

export interface CircadianPhasePoint {
  startHour: number
  endHour: number
  level: string
  label: string
  description: string
}

function parseTimeToFractionalHours(t: string): number {
  if (!t) return 0
  const match = t.match(/^(\d{1,2}):(\d{2})/)
  if (!match) return 0
  return parseInt(match[1], 10) + parseInt(match[2], 10) / 60
}

export function getCircadianPhases24h(): CircadianPhasePoint[] {
  return cached('circadian:24h', () => {
    const sessions = parseSleepSessions(SLEEP_DEBT_WINDOW_DAYS)
    if (sessions.length === 0) return []
    const rhythm = predictCircadianRhythm(sessions)
    return rhythm.energyPhases.map((p) => ({
      startHour: parseTimeToFractionalHours(p.start),
      endHour: parseTimeToFractionalHours(p.end),
      level: p.level,
      label: p.name,
      description: p.description,
    }))
  })
}

// --- Fitness history (lighter slice of fitness analysis) ---

export interface FitnessHistoryPoint {
  date: string
  trimp: number
  ctl: number
  atl: number
  tsb: number
}

export function getFitnessHistory(days = DEFAULT_TRAINING_DAYS): FitnessHistoryPoint[] {
  return cached(`fitnessHist:${days}`, () => {
    const analysis = getFullFitnessAnalysis(days)
    return analysis.trainingLoad.history
  })
}
