/**
 * Cross-domain Pearson correlation across sleep × HRV × portfolio × training load.
 *
 * Returns pairwise r values plus a `sig` flag (n >= 30) so the UI can hide
 * unreliable correlations by default. Sample size shapes confidence;
 * "spurious correlation" is the main risk this guards against.
 */

import { getDb } from '../../db/database'
import { getPortfolioValueHistory } from '../finance/portfolio.service'
import { calculateTrainingLoad } from '../health/fitness-analysis'

export interface CorrelationPair {
  a: string
  b: string
  r: number
  n: number
  sig: boolean
  description: string
}

export interface CrossDomainCorrelations {
  version: '1.0'
  days: number
  pairs: CorrelationPair[]
}

function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length === 0) return 0
  const n = xs.length
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let num = 0,
    dx = 0,
    dy = 0
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx
    const ay = ys[i] - my
    num += ax * ay
    dx += ax * ax
    dy += ay * ay
  }
  const denom = Math.sqrt(dx * dy)
  return denom === 0 ? 0 : num / denom
}

interface DailyMetric {
  date: string
  sleepHours: number | null
  deepPct: number | null
  hrv: number | null
}

function loadDailyMetrics(days: number): Map<string, DailyMetric> {
  const db = getDb()
  const result = new Map<string, DailyMetric>()

  const sleepRows = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'sleep' AND excluded = 0
      AND date >= date('now', '-' || ? || ' days')
  `,
    )
    .all(days) as Array<{ date: string; value_json: string }>
  for (const r of sleepRows) {
    try {
      const d = JSON.parse(r.value_json)
      const asleep = d.asleep ?? d.totalAsleep ?? d.qty ?? 0
      const deep = d.deep ?? d.deepSleep ?? 0
      const rem = d.rem ?? d.remSleep ?? 0
      const light = d.core ?? d.coreSleep ?? d.light ?? 0
      const total = deep + rem + light
      const entry = result.get(r.date) || {
        date: r.date,
        sleepHours: null,
        deepPct: null,
        hrv: null,
      }
      entry.sleepHours = asleep ? asleep / 60 : null
      entry.deepPct = total > 0 ? (deep / total) * 100 : null
      result.set(r.date, entry)
    } catch {
      /* skip */
    }
  }

  const hrvRows = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'hrv'
      AND date >= date('now', '-' || ? || ' days')
  `,
    )
    .all(days) as Array<{ date: string; value_json: string }>
  for (const r of hrvRows) {
    try {
      const d = JSON.parse(r.value_json)
      const v = d.avg ?? d.value ?? d.qty ?? null
      const entry = result.get(r.date) || {
        date: r.date,
        sleepHours: null,
        deepPct: null,
        hrv: null,
      }
      if (typeof v === 'number') entry.hrv = v
      result.set(r.date, entry)
    } catch {
      /* skip */
    }
  }

  return result
}

function loadDailyPortfolioReturns(days: number): Map<string, number> {
  const history = getPortfolioValueHistory(days)
  const map = new Map<string, number>()
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].value
    const curr = history[i].value
    if (prev > 0) {
      map.set(history[i].date, ((curr - prev) / prev) * 100)
    }
  }
  return map
}

function loadTsbByDate(days: number): Map<string, number> {
  const load = calculateTrainingLoad(days)
  const map = new Map<string, number>()
  for (const h of load.history) map.set(h.date, h.tsb)
  return map
}

function collectPair(
  dates: string[],
  getX: (d: string) => number | null,
  getY: (d: string) => number | null,
): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const d of dates) {
    const x = getX(d)
    const y = getY(d)
    if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x)
      ys.push(y)
    }
  }
  return { xs, ys }
}

export function getCrossDomainCorrelations(days: number = 60): CrossDomainCorrelations {
  const metrics = loadDailyMetrics(days)
  const portfolio = loadDailyPortfolioReturns(days)
  const tsbByDate = loadTsbByDate(days)
  const allDates = new Set<string>([...metrics.keys(), ...portfolio.keys(), ...tsbByDate.keys()])
  const dates = Array.from(allDates).sort()

  const pairs: CorrelationPair[] = []

  const sleepHours = (d: string) => metrics.get(d)?.sleepHours ?? null
  const hrv = (d: string) => metrics.get(d)?.hrv ?? null
  const deepPct = (d: string) => metrics.get(d)?.deepPct ?? null
  const portfolioRet = (d: string) => portfolio.get(d) ?? null
  const tsb = (d: string) => tsbByDate.get(d) ?? null

  const cases: Array<
    [string, string, (d: string) => number | null, (d: string) => number | null, string]
  > = [
    ['Sleep hours', 'HRV', sleepHours, hrv, 'Does more sleep raise next-day HRV?'],
    ['Deep sleep %', 'HRV next-day', deepPct, hrv, 'Deep sleep predicts autonomic recovery.'],
    [
      'Sleep hours',
      'Portfolio return',
      sleepHours,
      portfolioRet,
      'Are you trading better after good sleep?',
    ],
    ['TSB (form)', 'Portfolio return', tsb, portfolioRet, 'Training form vs investing decisions.'],
    ['Sleep hours', 'TSB', sleepHours, tsb, 'Recovery quality vs training form.'],
    ['HRV', 'Portfolio return', hrv, portfolioRet, 'Body stress vs market decisions.'],
  ]

  for (const [a, b, getX, getY, desc] of cases) {
    const { xs, ys } = collectPair(dates, getX, getY)
    const r = xs.length >= 3 ? pearson(xs, ys) : 0
    pairs.push({
      a,
      b,
      r: Number.isFinite(r) ? r : 0,
      n: xs.length,
      sig: xs.length >= 30,
      description: desc,
    })
  }

  return { version: '1.0', days, pairs }
}
