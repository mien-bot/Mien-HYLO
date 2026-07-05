/**
 * Sleep Analysis Engine — inspired by Rise Science / Two-Process Model
 *
 * Based on:
 * - Borbély's Two-Process Model (1982): Process S (homeostatic) + Process C (circadian)
 * - SAFTE model (US DoT/DoD): Sleep, Activity, Fatigue, and Task Effectiveness
 * - Sleep cycle architecture: 90-min cycles with stage progression
 *
 * Apple Watch provides: REM, Core (stages 1-2), Deep (stage 3), Awake durations
 */

import { getDb } from '../../db/database'
import { getAppSettings } from '../../lib/settings'
import {
  ACWR_INJURY_RISK,
  ACWR_SWEET_SPOT,
  CACHE_TTL_MS,
  SLEEP_CYCLE_MINUTES,
  SLEEP_DEBT_WINDOW_DAYS,
  SLEEP_NEED_WINDOW_DAYS,
} from '@shared/constants'

// --- Types ---

export interface SleepSession {
  date: string
  totalInBed: number // minutes
  totalAsleep: number // minutes
  deepSleep: number // minutes
  remSleep: number // minutes
  coreSleep: number // minutes
  awakeTime: number // minutes
  sleepStart: string // ISO time or HH:MM
  sleepEnd: string // ISO time or HH:MM
  sleepLatency: number // minutes to fall asleep
}

export interface SleepDebtResult {
  currentDebt: number // hours of debt
  debtCategory: 'low' | 'moderate' | 'high' | 'severe'
  sleepNeedEstimate: number // hours
  last14Nights: Array<{ date: string; slept: number; need: number; delta: number }>
}

export interface CircadianPrediction {
  melatoninWindowStart: string // HH:MM
  melatoninWindowEnd: string // HH:MM
  optimalBedtime: string // HH:MM
  optimalWakeTime: string // HH:MM
  energyPhases: EnergyPhase[]
}

export interface EnergyPhase {
  name: string
  start: string // HH:MM
  end: string // HH:MM
  level: 'low' | 'rising' | 'peak' | 'dipping' | 'winding_down'
  description: string
}

export interface SleepQualityScore {
  overall: number // 0-100
  deepSleepScore: number // 0-100
  remScore: number // 0-100
  coreSleepScore: number // 0-100 (core/light sleep proportion)
  wasoScore: number // 0-100 (Wake After Sleep Onset — less awake = better)
  efficiencyScore: number // 0-100 (time asleep / time in bed)
  consistencyScore: number // 0-100 (how consistent bedtime/wake time)
  cycleCompletion: number // estimated complete 90-min cycles
  recommendations: string[]
}

export interface WakeTimeRecommendation {
  optimalWakeTime: string
  alternativeWakeTimes: string[]
  reasoning: string
}

// --- Constants ---

// Average sleep need — can be personalized with more data
const DEFAULT_SLEEP_NEED_HOURS = 8.0

// Deep sleep targets by age group (% of total sleep)
const DEEP_SLEEP_TARGET_PERCENT = 15 // 13-23% is healthy for adults
const REM_SLEEP_TARGET_PERCENT = 25 // 20-25% is healthy

// Sleep debt thresholds (hours)
const DEBT_LOW = 5
const DEBT_MODERATE = 10
const DEBT_HIGH = 15

// Sleep debt weighting: last night = 15%, remaining 85% across 13 nights
const LAST_NIGHT_WEIGHT = 0.15
const REMAINING_WEIGHT = 0.85

// --- Core Analysis Functions ---

/**
 * Robustly parse sleep timestamps from Health Auto Export.
 * Handles formats: ISO 8601, "YYYY-MM-DD HH:MM:SS -0500", etc.
 * Returns epoch ms or null if unparseable.
 */
function parseSleepTimestamp(ts: string): number | null {
  if (!ts) return null
  let d = new Date(ts)
  if (!isNaN(d.getTime())) return d.getTime()
  // Fallback: "2026-05-14 00:38:46 -0500" → ISO "2026-05-14T00:38:46-05:00"
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/)
  if (m) {
    d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`)
    if (!isNaN(d.getTime())) return d.getTime()
  }
  return null
}

/**
 * Parse Apple Watch sleep stage data from health_metrics
 * Health Auto Export sends sleep data with stage breakdowns
 */
export function parseSleepSessions(days: number = SLEEP_DEBT_WINDOW_DAYS): SleepSession[] {
  const db = getDb()
  const rowsStmt = db.prepare(
    `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'sleep' AND excluded = 0
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `,
  )
  const sessions: SleepSession[] = []
  const batchSize = Math.max(days * 2, 60)
  let offset = 0

  while (sessions.length < days) {
    const rows = rowsStmt.all(batchSize, offset) as Array<{ date: string; value_json: string }>
    if (rows.length === 0) break

    for (const row of rows) {
      const data = JSON.parse(row.value_json)

      // Handle various data formats from Health Auto Export
      const totalAsleep = data.asleep || data.totalAsleep || data.qty || 0
      const awakeTime = data.awake || data.awakeTime || 0
      const sleepStart = data.sleepStart || data.startDate || ''
      const sleepEnd = data.sleepEnd || data.endDate || ''

      let totalInBed = data.inBed || data.totalInBed || 0
      if (totalInBed === 0 && sleepStart && sleepEnd) {
        const startMs = parseSleepTimestamp(sleepStart)
        const endMs = parseSleepTimestamp(sleepEnd)
        if (startMs && endMs && endMs > startMs) {
          totalInBed = Math.round((endMs - startMs) / 60000)
        }
      }
      if (totalInBed === 0) totalInBed = totalAsleep + awakeTime || data.qty || totalAsleep

      const session: SleepSession = {
        date: row.date,
        totalInBed,
        totalAsleep,
        deepSleep: data.deep || data.deepSleep || 0,
        remSleep: data.rem || data.remSleep || 0,
        coreSleep: data.core || data.coreSleep || data.light || 0,
        awakeTime,
        sleepStart,
        sleepEnd,
        sleepLatency: data.sleepLatency || data.onset || 15, // default 15 min
      }
      if (session.totalAsleep >= 60) sessions.push(session)
      if (sessions.length >= days) break
    }

    offset += rows.length
    if (rows.length < batchSize) break
  }

  return sessions
}

/**
 * Calculate sleep debt using Rise Science's methodology:
 * - 14-night rolling window
 * - Last night weighted at 15%
 * - Remaining 85% distributed across 13 prior nights with recency bias
 */
export function calculateSleepDebt(
  sessions: SleepSession[],
  sleepNeedOverride?: number,
): SleepDebtResult {
  const sleepNeed = sleepNeedOverride ?? resolveSleepNeed(sessions)
  const sleepNeedMinutes = sleepNeed * 60

  // Get last 14 nights
  const last14 = sessions.slice(0, SLEEP_DEBT_WINDOW_DAYS)

  if (last14.length === 0) {
    return {
      currentDebt: 0,
      debtCategory: 'low',
      sleepNeedEstimate: sleepNeed,
      last14Nights: [],
    }
  }

  // Calculate weighted debt
  let weightedDebt = 0
  const nightDetails: SleepDebtResult['last14Nights'] = []

  for (let i = 0; i < last14.length; i++) {
    const session = last14[i]
    const sleptHours = session.totalAsleep / 60
    const delta = sleptHours - sleepNeed

    // Weight calculation: night 0 (most recent) = 15%
    // Remaining nights get exponentially decreasing weights summing to 85%
    let weight: number
    if (i === 0) {
      weight = LAST_NIGHT_WEIGHT
    } else {
      // Exponential decay for remaining nights
      const decayFactor = Math.pow(0.85, i - 1)
      const totalDecay = Array.from({ length: Math.min(last14.length - 1, 13) }, (_, j) =>
        Math.pow(0.85, j),
      ).reduce((a, b) => a + b, 0)
      weight = (REMAINING_WEIGHT * decayFactor) / totalDecay
    }

    weightedDebt += Math.max(0, -delta) * weight

    nightDetails.push({
      date: session.date,
      slept: parseFloat(sleptHours.toFixed(1)),
      need: sleepNeed,
      delta: parseFloat(delta.toFixed(1)),
    })
  }

  // Scale weighted debt to approximate total hours
  const totalDebt = weightedDebt * last14.length

  let debtCategory: SleepDebtResult['debtCategory']
  if (totalDebt < DEBT_LOW) debtCategory = 'low'
  else if (totalDebt < DEBT_MODERATE) debtCategory = 'moderate'
  else if (totalDebt < DEBT_HIGH) debtCategory = 'high'
  else debtCategory = 'severe'

  return {
    currentDebt: parseFloat(totalDebt.toFixed(1)),
    debtCategory,
    sleepNeedEstimate: sleepNeed,
    last14Nights: nightDetails,
  }
}

/**
 * Estimate personal sleep need from historical data.
 *
 * Uses the median of habitual nightly sleep duration. An earlier version ranked
 * nights by deep+REM *percentage* and averaged the "best" ones, but that fraction
 * is inflated on short nights (deep sleep is front-loaded into the first cycles),
 * so it systematically favoured short nights and pinned the estimate to the 6h
 * floor even for people who habitually sleep ~7h. The median reflects the
 * duration the body actually settles into and is immune to both that artifact and
 * to occasional very-long catch-up nights.
 */
export function estimateSleepNeed(sessions: SleepSession[]): number {
  const durations = sessions
    .filter((s) => s.totalAsleep > 0)
    .map((s) => s.totalAsleep / 60)
    .sort((a, b) => a - b)

  if (durations.length < 7) return DEFAULT_SLEEP_NEED_HOURS

  const mid = Math.floor(durations.length / 2)
  const median =
    durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid]

  // Clamp to a physiologically plausible adult range
  return parseFloat(Math.max(6, Math.min(10, median)).toFixed(1))
}

// Sleep need is a stable trait, so compute it once over a fixed long window and
// reuse it everywhere. Cached briefly because the underlying nights change at
// most once per day, and several surfaces ask for it in quick succession.
let canonicalNeedCache: { value: number; at: number } | null = null

/**
 * The user's habitual sleep need over a fixed long window (SLEEP_NEED_WINDOW_DAYS).
 * Every screen — dashboard, AI report, wake prediction, relay sync — resolves the
 * same value through here, so sleep debt no longer drifts based on how many nights
 * a given screen happened to load.
 */
export function getCanonicalSleepNeed(): number {
  const now = Date.now()
  if (canonicalNeedCache && now - canonicalNeedCache.at < CACHE_TTL_MS) {
    return canonicalNeedCache.value
  }
  const sessions = parseSleepSessions(SLEEP_NEED_WINDOW_DAYS)
  const value = estimateSleepNeed(sessions)
  canonicalNeedCache = { value, at: now }
  return value
}

/**
 * Resolve sleep need for a debt calculation: prefer the canonical long-window
 * value; fall back to the passed-in sessions when the database is unavailable
 * (e.g. unit tests) so the function stays pure and testable.
 */
function resolveSleepNeed(fallbackSessions: SleepSession[]): number {
  try {
    const need = getCanonicalSleepNeed()
    if (Number.isFinite(need)) return need
  } catch {
    // DB not available — fall through to the local estimate
  }
  return estimateSleepNeed(fallbackSessions)
}

export interface SleepNeedProfile {
  estimatedNeed: number
  confidence: 'low' | 'medium' | 'high'
  chronotype: string
  dataPoints: number
  bestNights: { avgHours: number; avgDeepPct: number; avgRemPct: number; count: number }
  worstNights: { avgHours: number; avgDeepPct: number; avgRemPct: number; count: number }
  weekdayAvg: number
  weekendAvg: number
  sleepDebtImpact: string
  classification: string
  insights: string[]
  references: Array<{ title: string; finding: string; source: string }>
  userAge: number | null
  comparison: {
    you: {
      avgDuration: number
      avgDeepPct: number
      avgRemPct: number
      avgEfficiency: number
      avgConsistency: number
    }
    population: {
      avgDuration: number
      avgDeepPct: number
      avgRemPct: number
      avgEfficiency: number
      avgConsistency: number
      ageGroup: string
    }
    populationSDs: {
      duration: number
      deepPct: number
      remPct: number
      efficiency: number
      consistency: number
    }
  }
}

/**
 * Build a detailed sleep need profile with scientific context
 */
export function analyzeSleepNeed(days: number = 90): SleepNeedProfile | null {
  const sessions = parseSleepSessions(days)
  if (sessions.length < 7) return null

  // Read user age/weight from settings
  let userAge: number | null = null
  let userWeight: number | null = null
  try {
    const store = require('../../lib/store').default
    const settings = getAppSettings()
    if (settings?.userAge) userAge = parseInt(settings.userAge)
    if (settings?.userWeight) userWeight = parseInt(settings.userWeight)
    if (userAge && (userAge < 1 || userAge > 120)) userAge = null
    if (userWeight && (userWeight < 50 || userWeight > 500)) userWeight = null
  } catch {}

  const need = estimateSleepNeed(sessions)

  // Classify sleeper type
  let classification: string
  if (need <= 6.5) classification = 'Short sleeper'
  else if (need <= 7.5) classification = 'Below-average sleeper'
  else if (need <= 8.5) classification = 'Average sleeper'
  else if (need <= 9.5) classification = 'Above-average sleeper'
  else classification = 'Long sleeper'

  // Confidence based on data volume
  let confidence: SleepNeedProfile['confidence']
  if (sessions.length >= 60) confidence = 'high'
  else if (sessions.length >= 21) confidence = 'medium'
  else confidence = 'low'

  // Score and sort sessions by quality
  const scored = sessions
    .filter((s) => s.totalAsleep > 0)
    .map((s) => {
      const hours = s.totalAsleep / 60
      const deepPct = s.totalAsleep > 0 ? (s.deepSleep / s.totalAsleep) * 100 : 0
      const remPct = s.totalAsleep > 0 ? (s.remSleep / s.totalAsleep) * 100 : 0
      const quality = (s.deepSleep + s.remSleep) / Math.max(s.totalAsleep, 1)
      const day = new Date(s.date).getDay()
      const isWeekend = day === 0 || day === 6
      return { hours, deepPct, remPct, quality, isWeekend }
    })
    .sort((a, b) => b.quality - a.quality)

  const topCount = Math.max(Math.ceil(scored.length * 0.3), 3)
  const bottomCount = Math.max(Math.ceil(scored.length * 0.3), 3)
  const top = scored.slice(0, topCount)
  const bottom = scored.slice(-bottomCount)

  const bestNights = {
    avgHours: parseFloat((top.reduce((s, d) => s + d.hours, 0) / top.length).toFixed(1)),
    avgDeepPct: parseFloat((top.reduce((s, d) => s + d.deepPct, 0) / top.length).toFixed(0)),
    avgRemPct: parseFloat((top.reduce((s, d) => s + d.remPct, 0) / top.length).toFixed(0)),
    count: top.length,
  }
  const worstNights = {
    avgHours: parseFloat((bottom.reduce((s, d) => s + d.hours, 0) / bottom.length).toFixed(1)),
    avgDeepPct: parseFloat((bottom.reduce((s, d) => s + d.deepPct, 0) / bottom.length).toFixed(0)),
    avgRemPct: parseFloat((bottom.reduce((s, d) => s + d.remPct, 0) / bottom.length).toFixed(0)),
    count: bottom.length,
  }

  // Weekday vs weekend
  const weekdays = scored.filter((s) => !s.isWeekend)
  const weekends = scored.filter((s) => s.isWeekend)
  const weekdayAvg =
    weekdays.length > 0
      ? parseFloat((weekdays.reduce((s, d) => s + d.hours, 0) / weekdays.length).toFixed(1))
      : 0
  const weekendAvg =
    weekends.length > 0
      ? parseFloat((weekends.reduce((s, d) => s + d.hours, 0) / weekends.length).toFixed(1))
      : 0

  // Chronotype
  const chronotype = detectChronotype(sessions)

  // Sleep debt impact
  const avgAll = scored.reduce((s, d) => s + d.hours, 0) / scored.length
  const deficit = need - avgAll
  let sleepDebtImpact: string
  if (deficit <= 0.25)
    sleepDebtImpact =
      'You are consistently meeting your sleep need. This supports optimal cognitive function, immune health, and emotional regulation.'
  else if (deficit <= 1)
    sleepDebtImpact = `You average ${deficit.toFixed(1)}h less than your estimated need. Research shows even modest chronic sleep restriction (< 1h/night) impairs attention, working memory, and emotional reactivity within days (Van Dongen et al., 2003).`
  else
    sleepDebtImpact = `You average ${deficit.toFixed(1)}h less than your estimated need. Chronic restriction of this magnitude is associated with increased cortisol, reduced insulin sensitivity, impaired immune function, and cognitive deficits equivalent to 1-2 nights of total sleep deprivation (Spiegel et al., 1999; Van Dongen et al., 2003).`

  // Build insights
  const insights: string[] = []

  insights.push(
    `Your estimated sleep need is ${need}h based on analysis of ${sessions.length} nights. This is calculated by identifying your top 30% highest-quality sleep sessions (best deep + REM ratio) and averaging their duration — the idea being that on nights your body achieves optimal sleep architecture, the duration reflects your true biological need.`,
  )

  if (weekendAvg - weekdayAvg > 0.5) {
    insights.push(
      `You sleep ${(weekendAvg - weekdayAvg).toFixed(1)}h more on weekends (${weekendAvg}h vs ${weekdayAvg}h weekdays). This "weekend catch-up" pattern suggests weekday sleep restriction. Research by Roenneberg et al. (2012) calls this "social jet lag" — the mismatch between your biological clock and social schedule. Your weekend sleep may better reflect your true need.`,
    )
  } else if (Math.abs(weekendAvg - weekdayAvg) <= 0.3) {
    insights.push(
      `Your weekday and weekend sleep are nearly identical (${weekdayAvg}h vs ${weekendAvg}h). This consistency is excellent — Philips et al. (2017) found that regular sleep timing is independently associated with better academic performance, well-being, and delayed sleep phase prevention.`,
    )
  }

  if (bestNights.avgDeepPct > 0 && worstNights.avgDeepPct > 0) {
    const deepDiff = bestNights.avgDeepPct - worstNights.avgDeepPct
    if (deepDiff > 5) {
      insights.push(
        `Your best nights average ${bestNights.avgDeepPct}% deep sleep vs ${worstNights.avgDeepPct}% on worst nights. Deep sleep is primarily driven by adenosine pressure (time awake) and temperature. Longer sleep allows more deep sleep in the first half of the night (Carskadon & Dement, 2005).`,
      )
    }
  }

  if (need < 7) {
    insights.push(
      `Your data suggests a below-average sleep need. True short sleepers (< 6.5h) are rare — about 1-3% of the population carry mutations in genes like DEC2/ADRB1 that enable efficient sleep (He et al., 2009; Shi et al., 2019). However, many people who think they're short sleepers are actually chronically sleep-deprived and habituated to the impairment.`,
    )
  } else if (need > 9) {
    insights.push(
      `Your data suggests an above-average sleep need. About 2% of adults genuinely need 9+ hours. This can reflect higher sleep pressure from intense physical or cognitive activity, or individual variation in sleep consolidation efficiency. If you feel rested at this duration, it's likely your biological need.`,
    )
  }

  const chronoInsight =
    chronotype.type === 'evening'
      ? `Your ${chronotype.type} chronotype means your circadian rhythm runs later. Evening types often accumulate social jet lag during the work week. Matching your sleep schedule to your chronotype when possible can improve sleep quality (Wittmann et al., 2006).`
      : chronotype.type === 'morning'
        ? `Your ${chronotype.type} chronotype means your circadian clock runs earlier. Morning types tend to have easier weekday schedules but may miss out on evening social time. Your sleep quality likely peaks with early bedtimes.`
        : `Your ${chronotype.type} chronotype falls in the middle range, which offers the most schedule flexibility.`
  insights.push(chronoInsight)

  // Age-adjusted population norms (Ohayon et al., 2004 meta-analysis + Lunsford-Avery et al., 2018 for SRI)
  // Deep sleep declines ~2% per decade; efficiency drops ~3% per decade after 30
  // Consistency (SRI) tends to improve with age as lifestyle stabilises
  let ageGroup = '20-39'
  let populationAvgDuration = 7.5
  let populationAvgDeep = 17
  let populationAvgRem = 22
  let populationAvgEfficiency = 85
  let populationAvgConsistency = 68 // SRI score (0-100), Lunsford-Avery et al. 2018

  if (userAge) {
    if (userAge < 20) {
      ageGroup = '14-19'
      populationAvgDuration = 8.0
      populationAvgDeep = 20
      populationAvgRem = 22
      populationAvgEfficiency = 88
      populationAvgConsistency = 62
    } else if (userAge < 30) {
      ageGroup = '20-29'
      populationAvgDuration = 7.5
      populationAvgDeep = 17
      populationAvgRem = 22
      populationAvgEfficiency = 86
      populationAvgConsistency = 65
    } else if (userAge < 40) {
      ageGroup = '30-39'
      populationAvgDuration = 7.3
      populationAvgDeep = 15
      populationAvgRem = 21
      populationAvgEfficiency = 85
      populationAvgConsistency = 68
    } else if (userAge < 50) {
      ageGroup = '40-49'
      populationAvgDuration = 7.0
      populationAvgDeep = 13
      populationAvgRem = 21
      populationAvgEfficiency = 83
      populationAvgConsistency = 70
    } else if (userAge < 60) {
      ageGroup = '50-59'
      populationAvgDuration = 6.8
      populationAvgDeep = 11
      populationAvgRem = 20
      populationAvgEfficiency = 80
      populationAvgConsistency = 72
    } else {
      ageGroup = '60+'
      populationAvgDuration = 6.5
      populationAvgDeep = 9
      populationAvgRem = 19
      populationAvgEfficiency = 78
      populationAvgConsistency = 74
    }
  }

  const allDeepPct = scored.filter((s) => s.deepPct > 0)
  const allRemPct = scored.filter((s) => s.remPct > 0)
  const userAvgDeepPct =
    allDeepPct.length > 0 ? allDeepPct.reduce((s, d) => s + d.deepPct, 0) / allDeepPct.length : 0
  const userAvgRemPct =
    allRemPct.length > 0 ? allRemPct.reduce((s, d) => s + d.remPct, 0) / allRemPct.length : 0
  const userAvgEfficiency =
    sessions.filter((s) => s.totalInBed > 0).length > 0
      ? sessions
          .filter((s) => s.totalInBed > 0)
          .reduce((s, d) => s + (d.totalAsleep / d.totalInBed) * 100, 0) /
        sessions.filter((s) => s.totalInBed > 0).length
      : 0

  const durationVsPop = avgAll - populationAvgDuration
  const durationComparison = durationVsPop > 0.5 ? 'above' : durationVsPop < -0.5 ? 'below' : 'near'

  const ageLabel = userAge ? ` for your age group (${ageGroup})` : ''
  let comparisonSummary = `You sleep ${avgAll.toFixed(1)}h on average vs the${userAge ? ` age-adjusted` : ' US adult'} average of ${populationAvgDuration}h${ageLabel}. `
  if (durationComparison === 'above') {
    comparisonSummary += `You're getting ${durationVsPop.toFixed(1)}h more than average — only ~30% of US adults consistently meet the 7+ hour recommendation.`
  } else if (durationComparison === 'below') {
    comparisonSummary += `You're getting ${Math.abs(durationVsPop).toFixed(1)}h less than average. About 35% of US adults report sleeping less than 7 hours (CDC BRFSS, 2020).`
  } else {
    comparisonSummary += `You're right at the average for your demographic.`
  }

  insights.push(comparisonSummary)

  if (userAvgDeepPct > 0) {
    const deepVsPop = userAvgDeepPct - populationAvgDeep
    const ageNote = userAge ? ` for ages ${ageGroup}` : ''
    if (Math.abs(deepVsPop) > 3) {
      insights.push(
        `Your deep sleep averages ${userAvgDeepPct.toFixed(0)}% vs the norm of ~${populationAvgDeep}%${ageNote} (Ohayon et al., 2004). Deep sleep ${deepVsPop > 0 ? 'above' : 'below'} average by ${Math.abs(deepVsPop).toFixed(0)} percentage points. Deep sleep declines naturally with age (~2% per decade after 20).`,
      )
    }
  }

  if (userAge) {
    if (userAge >= 18 && userAge <= 25) {
      insights.push(
        `At age ${userAge}, the NSF recommends 7-9 hours of sleep. Young adults often have high sleep drive but irregular schedules — consistency is more impactful than duration at this age (Hirshkowitz et al., 2015).`,
      )
    } else if (userAge > 25 && userAge <= 35) {
      insights.push(
        `At age ${userAge}, you're in peak adult sleep efficiency. The NSF recommends 7-9 hours. Sleep quality typically remains stable through your 30s, though work/family demands often compress sleep opportunity (Hirshkowitz et al., 2015).`,
      )
    } else if (userAge > 35 && userAge <= 50) {
      insights.push(
        `At age ${userAge}, deep sleep begins to decline noticeably (~2% per decade). Maintaining exercise, limiting alcohol, and keeping a cool bedroom become increasingly important for preserving sleep architecture (Mander et al., 2017).`,
      )
    } else if (userAge > 50) {
      insights.push(
        `At age ${userAge}, deep sleep is naturally lower and sleep fragmentation increases. This is biological, not pathological. The NSF recommends 7-8 hours. Focus on sleep efficiency — shorter time in bed can paradoxically improve sleep quality (Irwin et al., 2006).`,
      )
    }
  }

  // Scientific references
  const references = [
    {
      title: 'The cumulative cost of additional wakefulness',
      finding:
        'Chronic sleep restriction to 6h/night for 14 days produces cognitive deficits equivalent to 2 nights of total sleep deprivation, yet subjects rate themselves as only mildly sleepy.',
      source: 'Van Dongen et al., Sleep, 2003',
    },
    {
      title: 'Impact of sleep debt on metabolic and endocrine function',
      finding:
        'Restricting sleep to 4h/night for 6 nights reduced glucose tolerance by 40% and increased evening cortisol levels, mimicking age-related metabolic changes.',
      source: 'Spiegel, Leproult & Van Cauter, The Lancet, 1999',
    },
    {
      title: 'Individual differences in sleep duration',
      finding:
        'Adult sleep need follows a normal distribution from ~6-10h, with a mean around 7.5-8h. Genetics account for 31-55% of the variance in sleep duration.',
      source: 'Watson et al., Sleep, 2013',
    },
    {
      title: 'Social jet lag and obesity',
      finding:
        'The discrepancy between social and biological clocks (sleeping longer on weekends) is associated with increased BMI, inflammation markers, and metabolic risk.',
      source: 'Roenneberg et al., Current Biology, 2012',
    },
    {
      title: 'Sleep duration and quality by age',
      finding:
        'Meta-analysis of 65 studies: adults average 7.5h total sleep, 17% deep sleep, 22% REM. Deep sleep decreases ~2% per decade after age 20. Sleep efficiency averages 85% in young adults.',
      source: 'Ohayon et al., Sleep Medicine Reviews, 2004',
    },
    {
      title: 'US adult sleep duration statistics',
      finding:
        '35.2% of US adults report sleeping < 7 hours per night. The CDC recommends 7+ hours for adults 18-60. Insufficient sleep is associated with chronic conditions including obesity, diabetes, and cardiovascular disease.',
      source: 'CDC Behavioral Risk Factor Surveillance System, 2020',
    },
    {
      title: 'Short sleep gene mutations',
      finding:
        'A mutation in the DEC2 gene allows carriers to feel fully rested after only 6.25 hours — but this is extremely rare (< 3% of population).',
      source: 'He et al., Science, 2009',
    },
    {
      title: 'Sleep regularity and well-being',
      finding:
        'Irregular sleep patterns (varying bedtime/wake time by > 1h) are associated with poorer academic performance and delayed circadian phase, independent of sleep duration.',
      source: 'Phillips et al., Scientific Reports, 2017',
    },
  ]

  return {
    estimatedNeed: need,
    confidence,
    chronotype: chronotype.type,
    dataPoints: sessions.length,
    bestNights,
    worstNights,
    weekdayAvg,
    weekendAvg,
    sleepDebtImpact,
    classification,
    insights,
    references,
    userAge,
    comparison: {
      you: {
        avgDuration: parseFloat(avgAll.toFixed(1)),
        avgDeepPct: parseFloat(userAvgDeepPct.toFixed(0)),
        avgRemPct: parseFloat(userAvgRemPct.toFixed(0)),
        avgEfficiency: parseFloat(userAvgEfficiency.toFixed(0)),
        avgConsistency: calculateSleepRegularityIndex(sessions).sri,
      },
      population: {
        avgDuration: populationAvgDuration,
        avgDeepPct: populationAvgDeep,
        avgRemPct: populationAvgRem,
        avgEfficiency: populationAvgEfficiency,
        avgConsistency: populationAvgConsistency,
        ageGroup,
      },
      // Approximate population SDs — used by renderer for percentile estimates
      // Sources: Ohayon 2004 (stages/efficiency), Watson 2013 (duration), Lunsford-Avery 2018 (SRI)
      populationSDs: { duration: 1.2, deepPct: 5, remPct: 5, efficiency: 8, consistency: 15 },
    },
  }
}

/**
 * Predict circadian rhythm phases based on recent sleep patterns
 * Uses habitual sleep/wake times to model the circadian cycle
 */
export function predictCircadianRhythm(sessions: SleepSession[]): CircadianPrediction {
  // Calculate average sleep/wake times from recent data
  const recentSessions = sessions.slice(0, 7).filter((s) => s.sleepStart && s.sleepEnd)

  let avgSleepHour = 23.0 // default 11 PM
  let avgWakeHour = 7.0 // default 7 AM

  if (recentSessions.length >= 3) {
    const sleepHours = recentSessions.map((s) => parseTimeToHours(s.sleepStart))
    const wakeHours = recentSessions.map((s) => parseTimeToHours(s.sleepEnd))

    avgSleepHour = circularMean(sleepHours)
    avgWakeHour = circularMean(wakeHours)
  }

  // Melatonin window: starts ~2 hours before habitual bedtime, lasts ~1 hour
  const melatoninStart = normalizeHour(avgSleepHour - 2)
  const melatoninEnd = normalizeHour(avgSleepHour - 1)

  // Optimal bedtime: during the melatonin window
  const optimalBedtime = formatHour(normalizeHour(melatoninStart + 0.25))

  // Optimal wake time: after 5 complete 90-min cycles from optimal bedtime
  // Add ~15 min sleep latency
  const sleepLatency = 0.25 // 15 min in hours
  const fiveCycles = (5 * SLEEP_CYCLE_MINUTES) / 60 // 7.5 hours
  const optimalWake = normalizeHour(avgSleepHour + sleepLatency + fiveCycles)

  // Energy phases based on circadian model
  const energyPhases: EnergyPhase[] = [
    {
      name: 'Sleep Inertia',
      start: formatHour(avgWakeHour),
      end: formatHour(avgWakeHour + 1.5),
      level: 'low',
      description:
        'Grogginess after waking. Avoid important decisions. Light exposure and movement help.',
    },
    {
      name: 'Morning Peak',
      start: formatHour(avgWakeHour + 1.5),
      end: formatHour(avgWakeHour + 5),
      level: 'peak',
      description:
        'Highest cognitive performance. Best time for deep work, complex decisions, creative tasks.',
    },
    {
      name: 'Afternoon Dip',
      start: formatHour(avgWakeHour + 5),
      end: formatHour(avgWakeHour + 8),
      level: 'dipping',
      description: 'Natural energy dip. Good for routine tasks, light exercise, or a 20-min nap.',
    },
    {
      name: 'Evening Peak',
      start: formatHour(avgWakeHour + 8),
      end: formatHour(avgWakeHour + 12),
      level: 'peak',
      description:
        'Second wind. Good for social activities, exercise, and moderate cognitive tasks.',
    },
    {
      name: 'Wind Down',
      start: formatHour(avgWakeHour + 12),
      end: formatHour(avgSleepHour),
      level: 'winding_down',
      description: 'Melatonin rising. Dim lights, avoid screens, prepare for sleep.',
    },
  ]

  return {
    melatoninWindowStart: formatHour(melatoninStart),
    melatoninWindowEnd: formatHour(melatoninEnd),
    optimalBedtime,
    optimalWakeTime: formatHour(optimalWake),
    energyPhases,
  }
}

/**
 * Calculate sleep quality score from a single session
 */
export function scoreSleepQuality(
  session: SleepSession,
  sessions: SleepSession[],
): SleepQualityScore {
  const recommendations: string[] = []

  // 1. Deep sleep score (target: 15-23% of total sleep AND >= 60 min absolute)
  const deepPercent = session.totalAsleep > 0 ? (session.deepSleep / session.totalAsleep) * 100 : 0
  const deepMins = session.deepSleep
  let deepSleepScore: number
  if (deepPercent >= 13 && deepPercent <= 23) {
    deepSleepScore = 90 + (deepPercent >= 15 && deepPercent <= 20 ? 10 : 0)
  } else if (deepPercent >= 10) {
    deepSleepScore = 60 + (deepPercent - 10) * 10
  } else {
    deepSleepScore = Math.max(0, deepPercent * 6)
    recommendations.push(
      `Deep sleep was ${deepPercent.toFixed(0)}% (target: 15-23%). Try earlier bedtime, cooler room (65-68°F), and avoid alcohol.`,
    )
  }
  // Penalize if absolute deep sleep is too low (target: ~60-90 min)
  if (deepMins < 60) {
    const absPenalty = deepMins / 60 // 0-1 scale
    deepSleepScore = Math.round(deepSleepScore * absPenalty)
  }

  // 2. REM score (target: 20-25% of total sleep AND >= 90 min absolute)
  const remPercent = session.totalAsleep > 0 ? (session.remSleep / session.totalAsleep) * 100 : 0
  const remMins = session.remSleep
  let remScore: number
  if (remPercent >= 20 && remPercent <= 25) {
    remScore = 95
  } else if (remPercent >= 15) {
    remScore = 70 + (remPercent - 15) * 5
  } else {
    remScore = Math.max(0, remPercent * 4.6)
    recommendations.push(
      `REM sleep was ${remPercent.toFixed(0)}% (target: 20-25%). REM increases in later cycles — sleeping longer helps.`,
    )
  }
  // Penalize if absolute REM is too low (target: ~90-120 min)
  if (remMins < 90) {
    const absPenalty = remMins / 90 // 0-1 scale
    remScore = Math.round(remScore * absPenalty)
  }

  // 3. Sleep efficiency (time asleep / time in bed)
  const efficiency = session.totalInBed > 0 ? (session.totalAsleep / session.totalInBed) * 100 : 0
  let efficiencyScore: number
  if (efficiency >= 85) {
    efficiencyScore = 90 + Math.min(10, (efficiency - 85) * 0.67)
  } else if (efficiency >= 75) {
    efficiencyScore = 60 + (efficiency - 75) * 3
  } else {
    efficiencyScore = Math.max(0, efficiency * 0.8)
    recommendations.push(
      `Sleep efficiency was ${efficiency.toFixed(0)}% (target: 85%+). If you can't sleep within 20 min, get up and do something relaxing.`,
    )
  }

  // 4. Consistency score (bedtime variance over last 7 days)
  const recentSessions = sessions.slice(0, 7).filter((s) => s.sleepStart)
  let consistencyScore = 50 // default if not enough data
  if (recentSessions.length >= 3) {
    const sleepHours = recentSessions.map((s) => parseTimeToHours(s.sleepStart))
    const variance = calculateCircularVariance(sleepHours)
    // Low variance = high consistency. Variance of 0.25 (30 min) = perfect
    if (variance <= 0.25) consistencyScore = 95
    else if (variance <= 1.0) consistencyScore = 75 + (1.0 - variance) * 26.7
    else consistencyScore = Math.max(20, 75 - (variance - 1.0) * 20)

    if (variance > 1.5) {
      recommendations.push(
        `Bedtime varies by ${Math.sqrt(variance * 60).toFixed(0)}+ minutes. Aim for the same bedtime ±30 min every night, including weekends.`,
      )
    }
  }

  // 5. Core sleep score (target: 45-55% of totalAsleep)
  const corePercent = session.totalAsleep > 0 ? (session.coreSleep / session.totalAsleep) * 100 : 0
  let coreSleepScore: number
  if (corePercent >= 45 && corePercent <= 55) {
    coreSleepScore = 90 + (corePercent >= 47 && corePercent <= 53 ? 10 : 0)
  } else if (corePercent >= 40 && corePercent < 45) {
    coreSleepScore = 70 + (corePercent - 40) * 4
  } else if (corePercent > 55 && corePercent <= 60) {
    coreSleepScore = 70 + (60 - corePercent) * 4
  } else if (corePercent < 40) {
    coreSleepScore = Math.max(0, corePercent * 1.75)
  } else {
    // >60% — too much light sleep, not enough deep/REM
    coreSleepScore = Math.max(0, 70 - (corePercent - 60) * 3.5)
  }

  // 6. WASO score (Wake After Sleep Onset — awake time during sleep period)
  const awakeMins = session.awakeTime
  let wasoScore: number
  if (awakeMins <= 15) {
    wasoScore = 95 + Math.max(0, (15 - awakeMins) / 3) // 95-100
  } else if (awakeMins <= 30) {
    wasoScore = 75 + (30 - awakeMins) * (20 / 15) // 75-95
  } else if (awakeMins <= 60) {
    wasoScore = 50 + (60 - awakeMins) * (25 / 30) // 50-75
  } else {
    wasoScore = Math.max(0, 50 - (awakeMins - 60) * 0.5) // 0-50
  }
  if (awakeMins > 30) {
    recommendations.push(
      `You were awake ${Math.round(awakeMins)} min during the night (target: <15 min). Avoid screens and bright light if you wake up.`,
    )
  }

  // 7. Cycle completion estimate
  const cycleCompletion = session.totalAsleep / SLEEP_CYCLE_MINUTES

  // Duration score (target: 7-9 hours)
  const hoursSlept = session.totalAsleep / 60
  let durationScore: number
  if (hoursSlept >= 7 && hoursSlept <= 9) {
    durationScore = 95
  } else if (hoursSlept >= 6) {
    durationScore = 60 + (hoursSlept - 6) * 35
  } else if (hoursSlept >= 5) {
    durationScore = 30 + (hoursSlept - 5) * 30
  } else {
    durationScore = Math.max(0, hoursSlept * 6)
  }

  if (hoursSlept < 7) {
    recommendations.push(
      `You slept ${hoursSlept.toFixed(1)} hours. Most adults need 7-9 hours. Even 30 min more can significantly reduce sleep debt.`,
    )
  }

  // Overall score (weighted average — duration is the dominant factor)
  let overall = Math.round(
    durationScore * 0.3 +
      deepSleepScore * 0.15 +
      remScore * 0.15 +
      coreSleepScore * 0.1 +
      efficiencyScore * 0.1 +
      consistencyScore * 0.1 +
      wasoScore * 0.1,
  )

  // Duration penalty: very short sleep caps the overall score regardless of stage quality
  // (e.g. 4h of sleep with perfect deep/REM % shouldn't score well)
  if (hoursSlept < 5) {
    overall = Math.min(overall, 40)
  } else if (hoursSlept < 6) {
    overall = Math.min(overall, 60)
  } else if (hoursSlept < 7) {
    overall = Math.min(overall, 80)
  }

  // Wake habit recommendations
  if (recommendations.length === 0) {
    recommendations.push('Great sleep! Maintain your current routine.')
  }

  // Add morning routine recommendations based on data
  recommendations.push(
    'Morning routine: Get bright light within 30 min of waking to anchor your circadian rhythm.',
    `Based on your data, your peak cognitive window is ~1.5–5 hours after waking. Schedule your hardest tasks then.`,
  )

  return {
    overall: Math.min(100, Math.max(0, overall)),
    deepSleepScore: Math.min(100, Math.max(0, Math.round(deepSleepScore))),
    remScore: Math.min(100, Math.max(0, Math.round(remScore))),
    coreSleepScore: Math.min(100, Math.max(0, Math.round(coreSleepScore))),
    wasoScore: Math.min(100, Math.max(0, Math.round(wasoScore))),
    efficiencyScore: Math.min(100, Math.max(0, Math.round(efficiencyScore))),
    consistencyScore: Math.min(100, Math.max(0, Math.round(consistencyScore))),
    cycleCompletion: parseFloat(cycleCompletion.toFixed(1)),
    recommendations,
  }
}

/**
 * Recommend optimal wake-up times based on sleep cycles
 * Waking at the end of a REM phase (end of a cycle) = least grogginess
 */
export function recommendWakeTime(
  bedtime: string,
  sleepLatencyMin: number = 15,
): WakeTimeRecommendation {
  const bedtimeHours = parseTimeToHours(bedtime)
  const fallAsleepTime = bedtimeHours + sleepLatencyMin / 60

  // Calculate wake times for 4, 5, and 6 complete cycles
  const cycleCounts = [4, 5, 6]
  const wakeTimes = cycleCounts.map((n) => {
    const wakeHour = normalizeHour(fallAsleepTime + (n * SLEEP_CYCLE_MINUTES) / 60)
    return {
      cycles: n,
      time: formatHour(wakeHour),
      hours: (n * SLEEP_CYCLE_MINUTES) / 60,
    }
  })

  // 5 cycles (7.5h) is ideal for most adults
  const optimal = wakeTimes.find((w) => w.cycles === 5)!
  const alternatives = wakeTimes.filter((w) => w.cycles !== 5).map((w) => w.time)

  return {
    optimalWakeTime: optimal.time,
    alternativeWakeTimes: alternatives,
    reasoning:
      `Bedtime ${bedtime} + ${sleepLatencyMin} min to fall asleep → sleep onset at ${formatHour(fallAsleepTime)}. ` +
      `${optimal.cycles} complete 90-min cycles (${optimal.hours}h of sleep) → wake at ${optimal.time} at the end of a REM phase. ` +
      `Alternatives: ${wakeTimes[0].cycles} cycles = ${wakeTimes[0].time} (${wakeTimes[0].hours}h), ` +
      `${wakeTimes[2].cycles} cycles = ${wakeTimes[2].time} (${wakeTimes[2].hours}h).`,
  }
}

/**
 * Recommend optimal bedtimes given a desired wake-up time
 * Reverse of recommendWakeTime — works backward from wake time through sleep cycles
 */
export function recommendBedtime(
  wakeTime: string,
  sleepLatencyMin: number = 15,
): WakeTimeRecommendation {
  const wakeHours = parseTimeToHours(wakeTime)

  // Calculate bedtimes for 4, 5, and 6 complete cycles (working backward)
  const cycleCounts = [4, 5, 6]
  const bedtimes = cycleCounts.map((n) => {
    const sleepOnset = normalizeHour(wakeHours - (n * SLEEP_CYCLE_MINUTES) / 60)
    const bedtimeHour = normalizeHour(sleepOnset - sleepLatencyMin / 60)
    return {
      cycles: n,
      time: formatHour(bedtimeHour),
      hours: (n * SLEEP_CYCLE_MINUTES) / 60,
    }
  })

  const optimal = bedtimes.find((b) => b.cycles === 5)!
  const alternatives = bedtimes.filter((b) => b.cycles !== 5).map((b) => b.time)

  return {
    optimalWakeTime: optimal.time, // reusing the interface — this is actually the optimal bedtime
    alternativeWakeTimes: alternatives,
    reasoning:
      `Wake at ${wakeTime} → ${optimal.cycles} complete 90-min cycles (${optimal.hours}h) means falling asleep by ${formatHour(normalizeHour(wakeHours - optimal.hours))}. ` +
      `With ~${sleepLatencyMin} min to fall asleep, go to bed at ${optimal.time}. ` +
      `Alternatives: ${bedtimes[0].cycles} cycles = bed at ${bedtimes[0].time} (${bedtimes[0].hours}h sleep), ` +
      `${bedtimes[2].cycles} cycles = bed at ${bedtimes[2].time} (${bedtimes[2].hours}h sleep).`,
  }
}

/**
 * Build a comprehensive sleep analysis for the AI prompt
 */
export function buildSleepAnalysisContext(): string {
  const sessions = parseSleepSessions(SLEEP_DEBT_WINDOW_DAYS)
  if (sessions.length === 0) return 'No sleep data available.'

  const debt = calculateSleepDebt(sessions)
  const circadian = predictCircadianRhythm(sessions)
  const lastNight = sessions[0]
  const quality = scoreSleepQuality(lastNight, sessions)
  const wakeRec = recommendWakeTime(circadian.optimalBedtime)

  let context = `## Sleep Analysis (${sessions.length} nights of data)\n\n`

  // Sleep debt
  context += `### Sleep Debt: ${debt.currentDebt} hours (${debt.debtCategory})\n`
  context += `- Estimated sleep need: ${debt.sleepNeedEstimate} hours/night\n`
  context += `- Last 3 nights: ${debt.last14Nights
    .slice(0, 3)
    .map((n) => `${n.date}: ${n.slept}h (${n.delta >= 0 ? '+' : ''}${n.delta}h)`)
    .join(', ')}\n\n`

  // Last night quality
  context += `### Last Night Quality Score: ${quality.overall}/100\n`
  context += `- Deep sleep: ${quality.deepSleepScore}/100 (${lastNight.deepSleep} min, ${((lastNight.deepSleep / Math.max(lastNight.totalAsleep, 1)) * 100).toFixed(0)}%)\n`
  context += `- REM: ${quality.remScore}/100 (${lastNight.remSleep} min, ${((lastNight.remSleep / Math.max(lastNight.totalAsleep, 1)) * 100).toFixed(0)}%)\n`
  context += `- Core/Light: ${quality.coreSleepScore}/100 (${lastNight.coreSleep} min, ${((lastNight.coreSleep / Math.max(lastNight.totalAsleep, 1)) * 100).toFixed(0)}%)\n`
  context += `- WASO (awake): ${quality.wasoScore}/100 (${lastNight.awakeTime} min)\n`
  context += `- Efficiency: ${quality.efficiencyScore}/100\n`
  context += `- Consistency: ${quality.consistencyScore}/100\n`
  context += `- Sleep cycles completed: ~${quality.cycleCompletion}\n\n`

  // Circadian prediction
  context += `### Circadian Rhythm Prediction\n`
  context += `- Melatonin window: ${circadian.melatoninWindowStart} - ${circadian.melatoninWindowEnd}\n`
  context += `- Optimal bedtime: ${circadian.optimalBedtime}\n`
  context += `- Optimal wake time: ${circadian.optimalWakeTime}\n`
  context += `- Energy phases:\n`
  for (const phase of circadian.energyPhases) {
    context += `  - ${phase.start}-${phase.end}: ${phase.name} (${phase.level})\n`
  }

  // Wake time recommendation
  context += `\n### Wake Time Recommendation\n`
  context += `- ${wakeRec.reasoning}\n`

  // Chronotype
  const chrono = detectChronotype(sessions)
  context += `\n### Chronotype: ${chrono.label}\n`
  context += `- ${chrono.description}\n`
  context += `- Peak focus window: ${chrono.peakFocus}\n`
  context += `- Best exercise time: ${chrono.peakExercise}\n`

  // Social jet lag
  const sjl = calculateSocialJetLag(sessions)
  context += `\n### Social Jet Lag: ${sjl.jetLagHours}h (${sjl.severity})\n`
  context += `- ${sjl.recommendation}\n`

  // Caffeine cutoff
  const caffeine = calculateCaffeineCutoff(sessions)
  context += `\n### Caffeine Cutoff: ${caffeine.lastCaffeineTime}\n`
  context += `- ${caffeine.reason}\n`

  // HRV recovery
  const hrv = calculateHrvRecovery()
  if (hrv) {
    context += `\n### HRV Recovery Score: ${hrv.score}/100 (${hrv.status})\n`
    context += `- Latest HRV: ${hrv.latestHrv}ms, Baseline: ${hrv.baseline}ms (z=${hrv.zScore})\n`
    context += `- ${hrv.recommendation}\n`
  }

  // Sleep Regularity
  const regularity = calculateSleepRegularityIndex(sessions)
  context += `\n### Sleep Regularity Index: ${regularity.sri}/100 (${regularity.interpretation})\n`
  context += `- Bedtime variance: ±${regularity.avgBedtimeVariance}h, Wake variance: ±${regularity.avgWakeVariance}h\n`

  // Recovery Readiness
  try {
    const readiness = calculateRecoveryReadiness()
    context += `\n### Recovery Readiness: ${readiness.score}/100 (${readiness.status})\n`
    context += `- Sleep: ${readiness.components.sleepScore}, HRV: ${readiness.components.hrvScore}, Exercise Load: ${readiness.components.exerciseLoad}\n`
    context += `- ${readiness.recommendation}\n`
  } catch {}

  // Workout-Sleep Correlation
  try {
    const workoutCorr = calculateWorkoutSleepCorrelation()
    if (workoutCorr) {
      context += `\n### Workout-Sleep Correlation\n`
      context += `- Correlation coefficient: ${workoutCorr.correlation}\n`
      context += `- Avg quality on workout days: ${workoutCorr.avgQualityWithWorkout}, rest days: ${workoutCorr.avgQualityWithout}\n`
      context += `- ${workoutCorr.timingInsight}\n`
      context += `- Best workout window for sleep: ${workoutCorr.bestWorkoutWindow}\n`
    }
  } catch {}

  // Training-adjusted sleep need
  try {
    const { calculateRecovery: calcFitnessRecovery } = require('./fitness-analysis')
    const fitnessRecovery = calcFitnessRecovery(30)
    if (fitnessRecovery?.sleepRecommendation) {
      const sr = fitnessRecovery.sleepRecommendation
      context += `\n### Training-Adjusted Sleep Need\n`
      context += `- Base need: ${sr.baseNeed}h, Training adjustment: +${(sr.trainingAdjustment * 60).toFixed(0)}min\n`
      context += `- Total recommended: ${sr.totalRecommended}h/night\n`
      context += `- ${sr.reasoning}\n`
    }
    if (fitnessRecovery?.recoveryScore !== undefined) {
      context += `\n### Fitness Recovery Score: ${fitnessRecovery.recoveryScore}/100 (${fitnessRecovery.recoveryStatus})\n`
      context += `- Estimated recovery time: ${fitnessRecovery.estimatedRecoveryHours}h\n`
      context += `- Ready to train: ${fitnessRecovery.readinessToTrain ? 'Yes' : 'No — rest recommended'}\n`
    }
  } catch {}

  // Recommendations
  context += `\n### Recommendations\n`
  for (const rec of quality.recommendations) {
    context += `- ${rec}\n`
  }

  return context
}

// --- Helper Functions ---

function parseTimeToHours(timeStr: string): number {
  if (!timeStr) return 0

  // Handle ISO date strings
  if (timeStr.includes('T')) {
    const date = new Date(timeStr)
    return date.getHours() + date.getMinutes() / 60
  }

  // Handle HH:MM format
  const match = timeStr.match(/(\d{1,2}):(\d{2})/)
  if (match) {
    return parseInt(match[1]) + parseInt(match[2]) / 60
  }

  return 0
}

function formatHour(hour: number): string {
  const h = normalizeHour(hour)
  let hours = Math.floor(h)
  let minutes = Math.round((h - hours) * 60)
  // Rounding can push minutes to 60 (e.g. h = 23.9917 → 59.5 → 60); carry into the hour.
  if (minutes >= 60) {
    minutes -= 60
    hours = (hours + 1) % 24
  }
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
}

function normalizeHour(hour: number): number {
  return ((hour % 24) + 24) % 24
}

/**
 * Circular mean for hours (handles midnight wrapping)
 * E.g., averaging 23:00 and 01:00 should give 00:00, not 12:00
 */
function circularMean(hours: number[]): number {
  const radians = hours.map((h) => (h / 24) * 2 * Math.PI)
  const sinMean = radians.reduce((sum, r) => sum + Math.sin(r), 0) / radians.length
  const cosMean = radians.reduce((sum, r) => sum + Math.cos(r), 0) / radians.length
  let meanAngle = Math.atan2(sinMean, cosMean)
  if (meanAngle < 0) meanAngle += 2 * Math.PI
  return (meanAngle / (2 * Math.PI)) * 24
}

function calculateCircularVariance(hours: number[]): number {
  if (hours.length < 2) return 0
  const mean = circularMean(hours)
  return (
    hours.reduce((sum, h) => {
      // Shortest angular distance (handles midnight wrapping)
      let diff = h - mean
      if (diff > 12) diff -= 24
      if (diff < -12) diff += 24
      return sum + diff * diff
    }, 0) /
    (hours.length - 1)
  )
}

// --- Sleep Intelligence Features ---

export interface ChronotypeResult {
  chronotype: 'lion' | 'bear' | 'wolf' | 'dolphin'
  label: string
  description: string
  msfsc: number // Mid-sleep on free days, sleep-corrected (hours)
  idealWake: string
  idealSleep: string
  peakFocus: string
  peakExercise: string
}

export interface SocialJetLagResult {
  jetLagHours: number
  severity: 'none' | 'mild' | 'moderate' | 'severe'
  weekdayMidSleep: number
  weekendMidSleep: number
  recommendation: string
}

export interface CaffeineCutoff {
  lastCaffeineTime: string
  reason: string
  melatoninWindow: string
}

export interface HrvRecoveryScore {
  score: number // 0-100
  status: 'optimal' | 'good' | 'fair' | 'poor'
  latestHrv: number
  baseline: number
  zScore: number
  recommendation: string
}

/**
 * Chronotype detection using Munich Chronotype Questionnaire (MCTQ) methodology
 * MSFsc = Mid-Sleep on Free days, sleep-corrected
 * Lion (early) / Bear (average) / Wolf (late) / Dolphin (irregular)
 */
export function detectChronotype(sessions: SleepSession[]): ChronotypeResult {
  if (sessions.length < 7) {
    return {
      chronotype: 'bear',
      label: 'Bear (Default)',
      description:
        'Not enough data for detection. Bear is the most common chronotype (~55% of people).',
      msfsc: 3.5,
      idealWake: '07:00',
      idealSleep: '23:00',
      peakFocus: '10:00–14:00',
      peakExercise: '17:00–19:00',
    }
  }

  // Separate weekday vs weekend sessions
  const withDayOfWeek = sessions.map((s) => {
    const d = new Date(s.date)
    const dow = d.getDay() // 0=Sun, 6=Sat
    return { ...s, isWeekend: dow === 0 || dow === 6 }
  })

  const weekendSessions = withDayOfWeek.filter((s) => s.isWeekend)
  const weekdaySessions = withDayOfWeek.filter((s) => !s.isWeekend)

  // Calculate mid-sleep point on free/weekend days
  const freeSleepStarts = (weekendSessions.length >= 2 ? weekendSessions : sessions).map((s) =>
    parseTimeToHours(s.sleepStart),
  )
  const freeSleepDurations = (weekendSessions.length >= 2 ? weekendSessions : sessions).map(
    (s) => s.totalAsleep / 60,
  )

  const avgFreeStart = circularMean(freeSleepStarts)
  const avgFreeDuration = freeSleepDurations.reduce((a, b) => a + b, 0) / freeSleepDurations.length
  const avgWeekdayDuration =
    weekdaySessions.length >= 2
      ? weekdaySessions.map((s) => s.totalAsleep / 60).reduce((a, b) => a + b, 0) /
        weekdaySessions.length
      : avgFreeDuration

  // MSFsc: Mid-sleep on free days, corrected for oversleeping on weekends
  const msf = normalizeHour(avgFreeStart + avgFreeDuration / 2) // mid-sleep on free days
  const oversleep = Math.max(0, avgFreeDuration - avgWeekdayDuration) / 2
  const msfsc = normalizeHour(msf - oversleep)

  // Check bedtime consistency for dolphin detection
  const allSleepStarts = sessions.map((s) => parseTimeToHours(s.sleepStart))
  const consistency = calculateCircularVariance(allSleepStarts)

  // Classify chronotype based on MSFsc
  let chronotype: ChronotypeResult['chronotype']
  let label: string
  let description: string
  let idealWake: string
  let idealSleep: string
  let peakFocus: string
  let peakExercise: string

  if (consistency > 4.0) {
    // High variability = dolphin (light/irregular sleeper)
    chronotype = 'dolphin'
    label = 'Dolphin'
    description =
      'Irregular sleep pattern. Dolphins are light sleepers with highly variable schedules. Focus on consistency first.'
    idealWake = '06:30'
    idealSleep = '23:30'
    peakFocus = '10:00–12:00'
    peakExercise = '07:30–09:00'
  } else if (msfsc < 2.5) {
    chronotype = 'lion'
    label = 'Lion (Early Bird)'
    description =
      'Morning-dominant circadian rhythm. You naturally wake early with peak energy in the morning.'
    idealWake = '05:30'
    idealSleep = '21:30'
    peakFocus = '08:00–12:00'
    peakExercise = '06:00–08:00'
  } else if (msfsc >= 2.5 && msfsc < 4.5) {
    chronotype = 'bear'
    label = 'Bear (Average)'
    description =
      'Solar-aligned circadian rhythm (most common). Energy follows the sun — rising with daylight, winding down at sunset.'
    idealWake = '07:00'
    idealSleep = '23:00'
    peakFocus = '10:00–14:00'
    peakExercise = '17:00–19:00'
  } else {
    chronotype = 'wolf'
    label = 'Wolf (Night Owl)'
    description =
      'Evening-dominant circadian rhythm. Your creativity and energy peak later in the day.'
    idealWake = '08:30'
    idealSleep = '00:00'
    peakFocus = '17:00–21:00'
    peakExercise = '18:00–20:00'
  }

  return { chronotype, label, description, msfsc, idealWake, idealSleep, peakFocus, peakExercise }
}

/**
 * Social jet lag: misalignment between weekday and weekend sleep timing
 * >1h = significant, associated with metabolic issues and reduced cognitive performance
 */
export function calculateSocialJetLag(sessions: SleepSession[]): SocialJetLagResult {
  const withDayOfWeek = sessions.map((s) => {
    const d = new Date(s.date)
    const dow = d.getDay()
    return { ...s, isWeekend: dow === 0 || dow === 6 }
  })

  const weekday = withDayOfWeek.filter((s) => !s.isWeekend)
  const weekend = withDayOfWeek.filter((s) => s.isWeekend)

  if (weekday.length < 3 || weekend.length < 2) {
    return {
      jetLagHours: 0,
      severity: 'none',
      weekdayMidSleep: 0,
      weekendMidSleep: 0,
      recommendation: 'Need at least 3 weekday and 2 weekend nights to calculate.',
    }
  }

  // Calculate mid-sleep point for weekdays and weekends
  const weekdayMids = weekday.map((s) => {
    const start = parseTimeToHours(s.sleepStart)
    return normalizeHour(start + s.totalAsleep / 120) // mid-sleep
  })
  const weekendMids = weekend.map((s) => {
    const start = parseTimeToHours(s.sleepStart)
    return normalizeHour(start + s.totalAsleep / 120)
  })

  const weekdayMidSleep = circularMean(weekdayMids)
  const weekendMidSleep = circularMean(weekendMids)

  // Circular difference
  let diff = weekendMidSleep - weekdayMidSleep
  if (diff > 12) diff -= 24
  if (diff < -12) diff += 24
  const jetLagHours = Math.abs(diff)

  let severity: SocialJetLagResult['severity']
  let recommendation: string
  if (jetLagHours < 0.5) {
    severity = 'none'
    recommendation = 'Excellent consistency between weekday and weekend sleep timing.'
  } else if (jetLagHours < 1.0) {
    severity = 'mild'
    recommendation =
      'Minor weekday-weekend shift. Try keeping weekend wake time within 30 min of weekday.'
  } else if (jetLagHours < 2.0) {
    severity = 'moderate'
    recommendation = `${jetLagHours.toFixed(1)}h shift between weekday and weekend sleep. This can impair metabolism and cognitive function. Gradually shift weekend bedtime earlier.`
  } else {
    severity = 'severe'
    recommendation = `${jetLagHours.toFixed(1)}h shift — equivalent to crossing ${Math.round(jetLagHours)} time zones weekly. Strongly recommend aligning weekend schedule closer to weekday.`
  }

  return {
    jetLagHours: parseFloat(jetLagHours.toFixed(1)),
    severity,
    weekdayMidSleep,
    weekendMidSleep,
    recommendation,
  }
}

/**
 * Caffeine cutoff recommendation
 * Caffeine half-life ~5-6h. For sleep quality, last caffeine should be
 * at least 8h before melatonin window (when <25% remains in system)
 */
export function calculateCaffeineCutoff(sessions: SleepSession[]): CaffeineCutoff {
  const circadian = predictCircadianRhythm(sessions)
  const melatoninStart = parseTimeToHours(circadian.melatoninWindowStart)

  // 8 hours before melatonin window = caffeine at <12.5% by bedtime
  const cutoffHour = normalizeHour(melatoninStart - 8)

  return {
    lastCaffeineTime: formatHour(cutoffHour),
    reason: `Caffeine has a ~5-6h half-life. Last cup by ${formatHour(cutoffHour)} ensures <12.5% remains when melatonin rises at ${circadian.melatoninWindowStart}.`,
    melatoninWindow: circadian.melatoninWindowStart,
  }
}

/**
 * HRV-based recovery scoring
 * Uses 60-day baseline with z-score (similar to WHOOP/Oura recovery)
 */
export function calculateHrvRecovery(): HrvRecoveryScore | null {
  const db = getDb()

  const rows = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'hrv'
    ORDER BY date DESC
    LIMIT 60
  `,
    )
    .all() as Array<{ date: string; value_json: string }>

  if (rows.length < 7) return null

  const values = rows
    .map((r) => {
      const data = JSON.parse(r.value_json)
      return data.avg || data.value || data.qty || 0
    })
    .filter((v: number) => v > 0)

  if (values.length < 7) return null

  const latestHrv = values[0]
  const baseline = values.reduce((a: number, b: number) => a + b, 0) / values.length
  const stdDev = Math.sqrt(
    values.reduce((sum: number, v: number) => sum + Math.pow(v - baseline, 2), 0) /
      (values.length - 1),
  )

  const zScore = stdDev > 0 ? (latestHrv - baseline) / stdDev : 0

  // Convert z-score to 0-100 score (z=0 → 50, z=2 → ~98, z=-2 → ~2)
  // Using a sigmoid-like mapping
  const score = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        50 + zScore * 20, // Each std dev = 20 points
      ),
    ),
  )

  let status: HrvRecoveryScore['status']
  let recommendation: string

  if (score >= 70) {
    status = 'optimal'
    recommendation =
      'HRV is above baseline — your body is well-recovered. Great day for intense training or deep cognitive work.'
  } else if (score >= 50) {
    status = 'good'
    recommendation =
      'HRV is near baseline — normal recovery. Moderate intensity work and training are fine.'
  } else if (score >= 30) {
    status = 'fair'
    recommendation =
      'HRV is below baseline — incomplete recovery. Prioritize lighter activities and ensure quality sleep tonight.'
  } else {
    status = 'poor'
    recommendation =
      'HRV is significantly below baseline — poor recovery. Consider rest, hydration, and stress management. Avoid intense training.'
  }

  return {
    score,
    status,
    latestHrv,
    baseline: parseFloat(baseline.toFixed(1)),
    zScore: parseFloat(zScore.toFixed(2)),
    recommendation,
  }
}

// --- New Analysis Functions ---

export interface SleepRegularityResult {
  sri: number // 0-100
  interpretation: 'excellent' | 'good' | 'fair' | 'poor'
  avgBedtimeVariance: number // hours
  avgWakeVariance: number // hours
}

export interface RecoveryReadinessResult {
  score: number // 0-100
  status: 'ready' | 'moderate' | 'rest'
  components: {
    sleepScore: number
    hrvScore: number
    exerciseLoad: number
  }
  recommendation: string
}

export interface WorkoutSleepCorrelation {
  correlation: number
  avgQualityWithWorkout: number
  avgQualityWithout: number
  sampleSize: { workoutDays: number; restDays: number }
  timingInsight: string
  bestWorkoutWindow: string
}

export interface BatchQualityEntry {
  date: string
  overall: number
  deep: number
  rem: number
  core: number
  waso: number
  efficiency: number
  consistency: number
}

/**
 * Sleep Regularity Index (SRI)
 * Measures consistency of sleep/wake timing across consecutive nights
 * Score 0-100 (100 = perfectly regular)
 */
export function calculateSleepRegularityIndex(sessions?: SleepSession[]): SleepRegularityResult {
  const data = sessions || parseSleepSessions(SLEEP_DEBT_WINDOW_DAYS)
  const withTimes = data.filter((s) => s.sleepStart && s.sleepEnd)

  if (withTimes.length < 3) {
    return { sri: 50, interpretation: 'fair', avgBedtimeVariance: 0, avgWakeVariance: 0 }
  }

  // Calculate bedtime and wake time deviations across consecutive pairs
  const bedtimeHours = withTimes.map((s) => parseTimeToHours(s.sleepStart))
  const wakeHours = withTimes.map((s) => parseTimeToHours(s.sleepEnd))

  const bedtimeVariance = calculateCircularVariance(bedtimeHours)
  const wakeVariance = calculateCircularVariance(wakeHours)

  // Convert variance to a 0-100 score
  // Variance of 0 = 100, variance of 4+ hours² = 0
  const bedtimeScore = Math.max(0, 100 - bedtimeVariance * 25)
  const wakeScore = Math.max(0, 100 - wakeVariance * 25)
  const sri = Math.round((bedtimeScore + wakeScore) / 2)

  let interpretation: SleepRegularityResult['interpretation']
  if (sri >= 80) interpretation = 'excellent'
  else if (sri >= 60) interpretation = 'good'
  else if (sri >= 40) interpretation = 'fair'
  else interpretation = 'poor'

  return {
    sri,
    interpretation,
    avgBedtimeVariance: parseFloat(Math.sqrt(bedtimeVariance).toFixed(1)),
    avgWakeVariance: parseFloat(Math.sqrt(wakeVariance).toFixed(1)),
  }
}

/**
 * Recovery Readiness Score
 * Combines sleep quality (40%) + HRV recovery (40%) + exercise load (20%)
 * Inspired by WHOOP Recovery / Oura Readiness
 */
export function calculateRecoveryReadiness(): RecoveryReadinessResult {
  const sessions = parseSleepSessions(SLEEP_DEBT_WINDOW_DAYS)
  const lastNight = sessions[0]
  const sleepScore = lastNight ? scoreSleepQuality(lastNight, sessions).overall : 50

  const hrv = calculateHrvRecovery()
  const hrvScore = hrv ? hrv.score : 50

  // Exercise load: last 3 days workout duration vs 7-day average
  const db = getDb()
  const workouts = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'workout'
    ORDER BY date DESC
    LIMIT 7
  `,
    )
    .all() as Array<{ date: string; value_json: string }>

  let exerciseLoad = 50 // neutral default
  if (workouts.length >= 3) {
    const durations = workouts.map((w) => {
      const data = JSON.parse(w.value_json)
      const wkts = data.workouts || []
      return wkts.reduce((sum: number, wk: any) => sum + (wk.duration || 0), 0)
    })
    const last3Avg = durations.slice(0, 3).reduce((a, b) => a + b, 0) / 3
    const weekAvg = durations.reduce((a, b) => a + b, 0) / durations.length
    // Acute:chronic ratio — 0.8-1.3 is optimal, >1.5 = overreaching
    const ratio = weekAvg > 0 ? last3Avg / weekAvg : 1
    if (ratio >= ACWR_SWEET_SPOT[0] && ratio <= ACWR_SWEET_SPOT[1]) exerciseLoad = 80
    else if (ratio < ACWR_SWEET_SPOT[0])
      exerciseLoad = 60 // under-trained
    else if (ratio <= ACWR_INJURY_RISK)
      exerciseLoad = 40 // pushing hard
    else exerciseLoad = 20 // overreaching
  }

  const score = Math.round(sleepScore * 0.4 + hrvScore * 0.4 + exerciseLoad * 0.2)

  let status: RecoveryReadinessResult['status']
  let recommendation: string
  if (score >= 70) {
    status = 'ready'
    recommendation =
      'Body is well-recovered. Great day for intense training, deep work, or challenging tasks.'
  } else if (score >= 45) {
    status = 'moderate'
    recommendation =
      'Moderate recovery. Stick to normal routines — avoid max effort training or all-nighters.'
  } else {
    status = 'rest'
    recommendation =
      'Low recovery. Prioritize rest, hydration, light movement, and early bedtime tonight.'
  }

  return {
    score,
    status,
    components: { sleepScore, hrvScore, exerciseLoad },
    recommendation,
  }
}

/**
 * Workout-Sleep Correlation
 * Analyzes how exercise affects sleep quality
 */
export function calculateWorkoutSleepCorrelation(): WorkoutSleepCorrelation | null {
  const db = getDb()
  const sessions = parseSleepSessions(60)
  if (sessions.length < 7) return null

  const workouts = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'workout'
      AND date >= date('now', '-60 days')
    ORDER BY date DESC
  `,
    )
    .all() as Array<{ date: string; value_json: string }>

  const workoutDates = new Set(workouts.map((w) => w.date))

  // Score each night's sleep quality
  const nightScores: Array<{
    date: string
    score: number
    hadWorkout: boolean
    workoutTiming?: string
  }> = []
  for (const session of sessions) {
    const quality = scoreSleepQuality(session, sessions)
    const hadWorkout = workoutDates.has(session.date)

    // Determine workout timing if applicable
    let workoutTiming: string | undefined
    if (hadWorkout) {
      const wk = workouts.find((w) => w.date === session.date)
      if (wk) {
        const data = JSON.parse(wk.value_json)
        const wkts = data.workouts || []
        if (wkts.length > 0 && wkts[0].start) {
          const hour = new Date(wkts[0].start).getHours()
          workoutTiming = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
        }
      }
    }

    nightScores.push({ date: session.date, score: quality.overall, hadWorkout, workoutTiming })
  }

  const workoutDays = nightScores.filter((n) => n.hadWorkout)
  const restDays = nightScores.filter((n) => !n.hadWorkout)

  if (workoutDays.length < 3 || restDays.length < 3) return null

  const avgWithWorkout = workoutDays.reduce((s, n) => s + n.score, 0) / workoutDays.length
  const avgWithout = restDays.reduce((s, n) => s + n.score, 0) / restDays.length

  // Simple correlation coefficient
  const allScores = nightScores.map((n) => n.score)
  const allWorkout = nightScores.map((n) => (n.hadWorkout ? 1 : 0))
  const meanScore = allScores.reduce((a, b) => a + b, 0) / allScores.length
  const meanWorkout = allWorkout.reduce((a, b) => a + b, 0) / allWorkout.length

  let numerator = 0,
    denomScore = 0,
    denomWorkout = 0
  for (let i = 0; i < allScores.length; i++) {
    const ds = allScores[i] - meanScore
    const dw = allWorkout[i] - meanWorkout
    numerator += ds * dw
    denomScore += ds * ds
    denomWorkout += dw * dw
  }
  const correlation =
    denomScore > 0 && denomWorkout > 0 ? numerator / Math.sqrt(denomScore * denomWorkout) : 0

  // Timing analysis
  const timingGroups: Record<string, number[]> = { morning: [], afternoon: [], evening: [] }
  for (const n of workoutDays) {
    if (n.workoutTiming && timingGroups[n.workoutTiming]) {
      timingGroups[n.workoutTiming].push(n.score)
    }
  }
  const timingAvgs = Object.entries(timingGroups)
    .filter(([, scores]) => scores.length >= 2)
    .map(([time, scores]) => ({ time, avg: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => b.avg - a.avg)

  const bestWindow = timingAvgs[0]?.time || 'any time'
  const timingInsight =
    timingAvgs.length >= 2
      ? `${timingAvgs[0].time} workouts correlate with best sleep (avg ${Math.round(timingAvgs[0].avg)}), while ${timingAvgs[timingAvgs.length - 1].time} workouts average ${Math.round(timingAvgs[timingAvgs.length - 1].avg)}.`
      : avgWithWorkout > avgWithout
        ? `Exercise days show ${Math.round(avgWithWorkout - avgWithout)} points higher sleep quality on average.`
        : `No significant timing pattern detected yet — more data needed.`

  return {
    correlation: parseFloat(correlation.toFixed(2)),
    avgQualityWithWorkout: Math.round(avgWithWorkout),
    avgQualityWithout: Math.round(avgWithout),
    sampleSize: { workoutDays: workoutDays.length, restDays: restDays.length },
    timingInsight,
    bestWorkoutWindow: bestWindow,
  }
}

/**
 * Batch sleep quality scoring — compute per-night quality scores for charting
 */
export function scoreSleepQualityBatch(days: number = 30): BatchQualityEntry[] {
  const sessions = parseSleepSessions(days)
  if (sessions.length < 2) return []

  return sessions.map((session) => {
    const q = scoreSleepQuality(session, sessions)
    return {
      date: session.date,
      overall: q.overall,
      deep: q.deepSleepScore,
      rem: q.remScore,
      core: q.coreSleepScore,
      waso: q.wasoScore,
      efficiency: q.efficiencyScore,
      consistency: q.consistencyScore,
    }
  })
}

// --- Wind-Down Routine Timeline ---

export interface WindDownRoutine {
  optimalBedtime: string
  melatoninWindow: string
  steps: Array<{
    time: string
    activity: string
    icon: 'dim' | 'phone' | 'shower' | 'read' | 'stretch' | 'snack' | 'bed'
    description: string
  }>
}

/**
 * Generate a pre-sleep wind-down routine timeline
 * Based on optimal bedtime and sleep science research:
 * - Blue light cessation: 60-90 min before bed (melatonin suppression)
 * - Warm shower/bath: 60-90 min before (thermoregulation - Haghayegh 2019)
 * - Dim lights: 120 min before (melatonin onset support)
 * - Light snack: 60 min before (tryptophan/magnesium support)
 * - Stretching/relaxation: 30 min before
 * - In bed, lights out: at bedtime
 */
export function calculateWindDownRoutine(sessions?: SleepSession[]): WindDownRoutine {
  const data = sessions || parseSleepSessions(SLEEP_DEBT_WINDOW_DAYS)
  const circadian = predictCircadianRhythm(data)
  const bedtimeHour = parseTimeToHours(circadian.optimalBedtime)

  const steps: WindDownRoutine['steps'] = [
    {
      time: formatHour(normalizeHour(bedtimeHour - 2)),
      activity: 'Dim lights',
      icon: 'dim',
      description:
        'Switch to warm/dim lighting. Avoid overhead fluorescents. This supports natural melatonin onset.',
    },
    {
      time: formatHour(normalizeHour(bedtimeHour - 1.5)),
      activity: 'Stop screens',
      icon: 'phone',
      description:
        'Put away phone, laptop, and TV. Blue light delays melatonin by up to 90 minutes.',
    },
    {
      time: formatHour(normalizeHour(bedtimeHour - 1.25)),
      activity: 'Warm shower',
      icon: 'shower',
      description:
        'A warm shower 60-90 min before bed triggers rapid body cooling, which promotes sleep onset.',
    },
    {
      time: formatHour(normalizeHour(bedtimeHour - 1)),
      activity: 'Light snack (optional)',
      icon: 'snack',
      description: 'Small tryptophan-rich snack (cherries, nuts, warm milk). Avoid heavy meals.',
    },
    {
      time: formatHour(normalizeHour(bedtimeHour - 0.5)),
      activity: 'Stretch & breathe',
      icon: 'stretch',
      description: 'Light stretching or 4-7-8 breathing. Activates parasympathetic nervous system.',
    },
    {
      time: formatHour(normalizeHour(bedtimeHour - 0.25)),
      activity: 'Read in bed',
      icon: 'read',
      description:
        'Physical book or e-ink reader only. Fiction works better than non-fiction for winding down.',
    },
    {
      time: circadian.optimalBedtime,
      activity: 'Lights out',
      icon: 'bed',
      description: 'Target sleep onset. Room should be cool (65-68°F), dark, and quiet.',
    },
  ]

  return {
    optimalBedtime: circadian.optimalBedtime,
    melatoninWindow: circadian.melatoninWindowStart,
    steps,
  }
}

// --- Process S/C Energy Curve ---

export interface EnergyCurvePoint {
  hour: number
  timeLabel: string
  processS: number
  processC: number
  combined: number
}

const TAU_WAKE = 18.2
const TAU_SLEEP = 4.2
const S_UPPER = 1.0
const S_LOWER = 0.17

/**
 * Generate continuous energy prediction curve using Borbely's Two-Process Model
 */
export function calculateEnergyCurve(sessions: SleepSession[]): EnergyCurvePoint[] {
  const recentSessions = sessions.slice(0, 7).filter((s) => s.sleepStart && s.sleepEnd)

  let avgWakeHour = 7.0
  let avgSleepHour = 23.0

  if (recentSessions.length >= 3) {
    avgWakeHour = circularMean(recentSessions.map((s) => parseTimeToHours(s.sleepEnd)))
    avgSleepHour = circularMean(recentSessions.map((s) => parseTimeToHours(s.sleepStart)))
  }

  const debt = calculateSleepDebt(sessions)
  const debtFactor = Math.max(0.4, 1 - debt.currentDebt / 20)

  // Total awake hours before sleep — same boundaries as predictCircadianRhythm
  const totalAwakeHours = (avgSleepHour - avgWakeHour + 24) % 24 || 16

  // Phase boundary offsets (hours after wake) — kept in sync with predictCircadianRhythm
  const INERTIA_END = 1.5
  const MORNING_PEAK_END = 5.0
  const DIP_END = 8.0
  const EVENING_PEAK_END = 12.0

  // Cosine-smoothed interpolation for natural-looking transitions
  const coslerp = (a: number, b: number, t: number) =>
    a + ((b - a) * (1 - Math.cos(t * Math.PI))) / 2

  function rawEnergy(h: number): number {
    if (h >= totalAwakeHours) return 0.08 // sleep phase — low and flat

    if (h <= INERTIA_END) {
      return coslerp(0.15, 0.48, h / INERTIA_END)
    }

    if (h <= MORNING_PEAK_END) {
      const mid = (INERTIA_END + MORNING_PEAK_END) / 2
      return h <= mid
        ? coslerp(0.48, 0.92, (h - INERTIA_END) / (mid - INERTIA_END))
        : coslerp(0.92, 0.68, (h - mid) / (MORNING_PEAK_END - mid))
    }

    if (h <= DIP_END) {
      const mid = (MORNING_PEAK_END + DIP_END) / 2
      return h <= mid
        ? coslerp(0.68, 0.33, (h - MORNING_PEAK_END) / (mid - MORNING_PEAK_END))
        : coslerp(0.33, 0.47, (h - mid) / (DIP_END - mid))
    }

    if (h <= EVENING_PEAK_END) {
      const mid = (DIP_END + EVENING_PEAK_END) / 2
      return h <= mid
        ? coslerp(0.47, 0.82, (h - DIP_END) / (mid - DIP_END))
        : coslerp(0.82, 0.62, (h - mid) / (EVENING_PEAK_END - mid))
    }

    // Wind Down: smooth fall to near-zero at sleep onset
    return coslerp(0.62, 0.12, (h - EVENING_PEAK_END) / (totalAwakeHours - EVENING_PEAK_END))
  }

  const points: EnergyCurvePoint[] = []

  for (let i = 0; i <= 24; i++) {
    const combined = Math.max(0, Math.min(1, rawEnergy(i) * debtFactor))
    points.push({
      hour: normalizeHour(avgWakeHour + i),
      timeLabel: formatHour(normalizeHour(avgWakeHour + i)),
      processS: 0,
      processC: 0,
      combined: parseFloat(combined.toFixed(3)),
    })
  }

  return points
}
