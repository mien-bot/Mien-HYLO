/**
 * Cross-domain readiness composite.
 *
 * Extends the sleep+hrv+exercise readiness from sleep-analysis with two new
 * cross-domain components: market stress (from portfolio drawdown + holdings
 * volatility) and calendar load (from today's scheduled work hours).
 *
 * Output is the headline 0-100 score on the Dashboard plus a short,
 * actionable recommendation string.
 */

import { calculateRecoveryReadiness } from '../health/sleep-analysis'
import { listHoldings, getPortfolioValueHistory } from '../finance/portfolio.service'
import { computePortfolioRisk } from '../finance/technical-indicators'
import { getDb } from '../../db/database'

export interface CrossDomainReadiness {
  version: '1.0'
  score: number
  status: 'ready' | 'moderate' | 'rest'
  components: {
    sleep: number
    hrv: number
    trainingLoad: number
    marketStress: number
    calendarLoad: number
  }
  recommendation: string
}

interface CompositeInjection {
  recovery?: ReturnType<typeof calculateRecoveryReadiness>
  marketStress?: number
  calendarLoad?: number
}

/**
 * 0-100 — 100 = no stress, 0 = severe stress (drawdown + high volatility).
 * 7-day max drawdown + average annualized volatility across holdings.
 */
function computeMarketStress(): number {
  const holdings = listHoldings()
  if (holdings.length === 0) return 80 // no exposure = low stress

  const history = getPortfolioValueHistory(7)
  let drawdownPct = 0
  if (history.length >= 2) {
    let peak = history[0].value
    for (const p of history) {
      if (p.value > peak) peak = p.value
      const dd = peak > 0 ? ((peak - p.value) / peak) * 100 : 0
      if (dd > drawdownPct) drawdownPct = dd
    }
  }

  const symbols = Array.from(new Set(holdings.map((h) => h.symbol)))
  const risk = computePortfolioRisk(symbols)
  const vols = Array.from(risk.volatilities.values()).filter((v) => Number.isFinite(v))
  const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0

  // Map: drawdown 0->no penalty, 10%->big penalty. Vol 15->no penalty, 60->big.
  const ddPenalty = Math.min(50, drawdownPct * 5)
  const volPenalty = Math.min(50, Math.max(0, (avgVol - 15) * 0.8))
  return Math.max(0, Math.round(100 - ddPenalty - volPenalty))
}

/**
 * 0-100 — 100 = light day, 0 = packed. Based on total scheduled hours of
 * focus / work blocks today.
 */
function computeCalendarLoad(date?: string): number {
  const today = date || new Date().toISOString().slice(0, 10)
  const db = getDb()
  const row = db
    .prepare(
      `
    SELECT schedule_json FROM daily_schedule
    WHERE date = ? LIMIT 1
  `,
    )
    .get(today) as { schedule_json: string } | undefined
  if (!row) return 75 // unknown -> mildly loaded default

  let workMinutes = 0
  try {
    const parsed = JSON.parse(row.schedule_json)
    const blocks = parsed.blocks || parsed.schedule || parsed || []
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        const type = (b.type || b.category || '').toLowerCase()
        const duration =
          typeof b.duration === 'number'
            ? b.duration
            : b.start && b.end
              ? minutesBetween(b.start, b.end)
              : 0
        if (type.includes('work') || type.includes('focus') || type.includes('deep')) {
          workMinutes += duration
        }
      }
    }
  } catch {
    return 75
  }

  // Map: 4h or less = 95, 8h = 50, 12h+ = 5.
  const hours = workMinutes / 60
  if (hours <= 4) return 95
  if (hours <= 6) return 80
  if (hours <= 8) return 60
  if (hours <= 10) return 35
  return 15
}

function minutesBetween(start: string, end: string): number {
  const parse = (t: string) => {
    const m = t.match(/(\d{1,2}):(\d{2})/)
    if (!m) return 0
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  }
  const diff = parse(end) - parse(start)
  return diff > 0 ? diff : 0
}

export function getCrossDomainReadiness(__inject?: CompositeInjection): CrossDomainReadiness {
  const recovery = __inject?.recovery ?? calculateRecoveryReadiness()
  const marketStress = __inject?.marketStress ?? computeMarketStress()
  const calendarLoad = __inject?.calendarLoad ?? computeCalendarLoad()

  // Weighted composite — body components dominate, market + calendar nudge.
  const score = Math.round(
    recovery.components.sleepScore * 0.3 +
      recovery.components.hrvScore * 0.25 +
      recovery.components.exerciseLoad * 0.15 +
      marketStress * 0.15 +
      calendarLoad * 0.15,
  )

  let status: CrossDomainReadiness['status']
  if (score >= 70) status = 'ready'
  else if (score >= 45) status = 'moderate'
  else status = 'rest'

  const recommendation = buildRecommendation({
    score,
    status,
    sleep: recovery.components.sleepScore,
    hrv: recovery.components.hrvScore,
    trainingLoad: recovery.components.exerciseLoad,
    marketStress,
    calendarLoad,
  })

  return {
    version: '1.0',
    score,
    status,
    components: {
      sleep: recovery.components.sleepScore,
      hrv: recovery.components.hrvScore,
      trainingLoad: recovery.components.exerciseLoad,
      marketStress,
      calendarLoad,
    },
    recommendation,
  }
}

function buildRecommendation(c: {
  score: number
  status: CrossDomainReadiness['status']
  sleep: number
  hrv: number
  trainingLoad: number
  marketStress: number
  calendarLoad: number
}): string {
  const weakest = Object.entries({
    sleep: c.sleep,
    hrv: c.hrv,
    training: c.trainingLoad,
    market: c.marketStress,
    calendar: c.calendarLoad,
  }).sort((a, b) => a[1] - b[1])[0]

  if (c.status === 'ready') {
    return 'All systems green. Strong day for high-effort training, deep work, or major decisions.'
  }
  if (c.status === 'moderate') {
    if (weakest[0] === 'sleep')
      return 'Moderate readiness — sleep is the limiter. Skip the hardest task on the calendar.'
    if (weakest[0] === 'hrv')
      return 'Moderate readiness — HRV is suppressed. Keep training easy and defer high-stakes decisions.'
    if (weakest[0] === 'market')
      return 'Moderate readiness — market stress elevated. Trade smaller size, avoid impulsive moves.'
    if (weakest[0] === 'calendar')
      return 'Moderate readiness — calendar is heavy. Protect one deep-work block and cut a meeting.'
    return 'Moderate readiness. Stick to normal routines.'
  }
  if (weakest[0] === 'sleep')
    return 'Low recovery — major sleep debt. Cancel intense workout, prioritize a 30-min wind-down tonight.'
  if (weakest[0] === 'hrv')
    return 'Low recovery — HRV signal poor. Rest day; light walking only. No alcohol, in bed by 10pm.'
  if (weakest[0] === 'market')
    return 'Low recovery + market stress. Defer trading decisions until the body recovers.'
  return 'Low recovery. Rest day. Light movement, hydration, early bedtime.'
}
