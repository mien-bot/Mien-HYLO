/**
 * Sleep Analysis Engine for Mobile
 *
 * Port of desktop sleep-analysis.ts with Rise Science methodology:
 * - Borbely's Two-Process Model (1982): Process S + Process C
 * - 14-night rolling sleep debt with exponential decay weighting
 * - Circadian energy prediction with 5 phases
 * - Sleep quality scoring (deep, REM, efficiency, consistency)
 * - Chronotype detection (MCTQ methodology)
 * - Social jet lag, caffeine cutoff, HRV recovery
 * - Process S/C continuous energy curve (Rise Science)
 *
 * All functions are pure — they take data arrays, no DB access.
 */

import { getDb } from '../lib/database'

// --- Types ---

export interface SleepSession {
  date: string
  totalInBed: number
  totalAsleep: number
  deepSleep: number
  remSleep: number
  coreSleep: number
  awakeTime: number
  sleepStart: string
  sleepEnd: string
  sleepLatency: number
}

export interface SleepDebtResult {
  currentDebt: number
  debtCategory: 'low' | 'moderate' | 'high' | 'severe'
  sleepNeedEstimate: number
  last14Nights: Array<{ date: string; slept: number; need: number; delta: number }>
}

export interface CircadianPrediction {
  melatoninWindowStart: string
  melatoninWindowEnd: string
  optimalBedtime: string
  optimalWakeTime: string
  energyPhases: EnergyPhase[]
}

export interface EnergyPhase {
  name: string
  start: string
  end: string
  level: 'low' | 'rising' | 'peak' | 'dipping' | 'winding_down'
  description: string
}

export interface SleepQualityScore {
  overall: number
  deepSleepScore: number
  remScore: number
  coreSleepScore: number
  wasoScore: number
  efficiencyScore: number
  consistencyScore: number
  cycleCompletion: number
  recommendations: string[]
}

export interface WakeTimeRecommendation {
  optimalWakeTime: string
  alternativeWakeTimes: string[]
  reasoning: string
}

export interface ChronotypeResult {
  chronotype: 'lion' | 'bear' | 'wolf' | 'dolphin'
  label: string
  description: string
  msfsc: number
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
  score: number
  status: 'optimal' | 'good' | 'fair' | 'poor'
  latestHrv: number
  baseline: number
  zScore: number
  recommendation: string
}

export interface EnergyCurvePoint {
  hour: number
  timeLabel: string
  processS: number   // 0-1 sleep pressure
  processC: number   // 0-1 circadian alerting
  combined: number   // 0-1 net energy
}

export interface FullSleepAnalysis {
  debt: SleepDebtResult
  quality: SleepQualityScore | null
  circadian: CircadianPrediction
  chronotype: ChronotypeResult
  socialJetLag: SocialJetLagResult
  caffeineCutoff: CaffeineCutoff
  hrvRecovery: HrvRecoveryScore | null
  wakeRecommendation: WakeTimeRecommendation
  energyCurve: EnergyCurvePoint[]
}

// --- Constants ---

const DEFAULT_SLEEP_NEED_HOURS = 8.0
const SLEEP_CYCLE_MINUTES = 90
const LAST_NIGHT_WEIGHT = 0.15
const REMAINING_WEIGHT = 0.85
const DEBT_LOW = 5
const DEBT_MODERATE = 10
const DEBT_HIGH = 15
// Window for estimating habitual sleep NEED — longer than the 14-night debt
// window so need stays a stable trait, identical to the desktop value.
const SLEEP_NEED_WINDOW_DAYS = 90
const CANONICAL_NEED_TTL_MS = 60_000

// Process S time constants (Borbely 1982, refined by Achermann 1999)
const TAU_WAKE = 18.2   // hours — sleep pressure accumulation time constant
const TAU_SLEEP = 4.2   // hours — sleep pressure dissipation time constant
const S_UPPER = 1.0     // upper asymptote (max sleep pressure)
const S_LOWER = 0.17    // lower asymptote (min after full recovery)

// --- Core Analysis Functions ---

/**
 * Robustly parse sleep timestamps from Health Auto Export.
 * Handles formats: ISO 8601, "YYYY-MM-DD HH:MM:SS -0500", etc.
 * Hermes (React Native) may not parse all formats that V8 does.
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
 * Parse sleep sessions from local mobile DB
 */
export async function parseSleepSessions(days: number = 14): Promise<SleepSession[]> {
  const db = await getDb()
  const rows = await db.getAllAsync(
    `SELECT date, value_json FROM health_metrics
     WHERE metric_type = 'sleep'
     ORDER BY date DESC LIMIT ?`, days
  ) as Array<{ date: string; value_json: string }>

  return rows.map(row => {
    try {
      const data = JSON.parse(row.value_json)
      const totalAsleep = data.asleep || data.totalAsleep || data.qty || 0
      const awakeTime = data.awake || data.awakeTime || 0
      const sleepStart = data.sleepStart || data.start || data.startDate || ''
      const sleepEnd = data.sleepEnd || data.end || data.endDate || ''

      let totalInBed = data.inBed || data.totalInBed || 0
      if (totalInBed === 0 && sleepStart && sleepEnd) {
        const startMs = parseSleepTimestamp(sleepStart)
        const endMs = parseSleepTimestamp(sleepEnd)
        if (startMs && endMs && endMs > startMs) {
          totalInBed = Math.round((endMs - startMs) / 60000)
        }
      }
      if (totalInBed === 0) totalInBed = totalAsleep + awakeTime || data.qty || totalAsleep

      return {
        date: row.date,
        totalInBed,
        totalAsleep,
        deepSleep: data.deep || data.deepSleep || 0,
        remSleep: data.rem || data.remSleep || 0,
        coreSleep: data.core || data.coreSleep || data.light || 0,
        awakeTime,
        sleepStart,
        sleepEnd,
        sleepLatency: data.sleepLatency || data.onset || 15,
      }
    } catch {
      return null
    }
  }).filter((s): s is SleepSession => s !== null && s.totalAsleep >= 60)
}

/**
 * Estimate personal sleep need — median of habitual nightly duration.
 *
 * Mirrors desktop. The old method ranked nights by deep+REM percentage, which is
 * inflated on short nights and biased the estimate down to the 6h floor. The
 * median reflects how much sleep the body actually settles into.
 */
export function estimateSleepNeed(sessions: SleepSession[]): number {
  const durations = sessions
    .filter(s => s.totalAsleep > 0)
    .map(s => s.totalAsleep / 60)
    .sort((a, b) => a - b)

  if (durations.length < 7) return DEFAULT_SLEEP_NEED_HOURS

  const mid = Math.floor(durations.length / 2)
  const median =
    durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid]

  return parseFloat(Math.max(6, Math.min(10, median)).toFixed(1))
}

// Cached canonical sleep need so every mobile surface shows the same value as
// desktop, computed over a fixed long window regardless of the screen's own load.
let canonicalNeedCache: { value: number; at: number } | null = null

/**
 * The user's habitual sleep need over a fixed long window. Resolve sleep debt
 * through this so the phone matches the desktop dashboard and AI report.
 */
export async function getCanonicalSleepNeed(): Promise<number> {
  const now = Date.now()
  if (canonicalNeedCache && now - canonicalNeedCache.at < CANONICAL_NEED_TTL_MS) {
    return canonicalNeedCache.value
  }
  const sessions = await parseSleepSessions(SLEEP_NEED_WINDOW_DAYS)
  const value = estimateSleepNeed(sessions)
  canonicalNeedCache = { value, at: now }
  return value
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
    you: { avgDuration: number; avgDeepPct: number; avgRemPct: number; avgEfficiency: number; avgConsistency: number }
    population: { avgDuration: number; avgDeepPct: number; avgRemPct: number; avgEfficiency: number; avgConsistency: number; ageGroup: string }
    populationSDs: { duration: number; deepPct: number; remPct: number; efficiency: number; consistency: number }
  }
}

export async function analyzeSleepNeedProfile(days: number = 90): Promise<SleepNeedProfile | null> {
  const sessions = await parseSleepSessions(days)
  if (sessions.length < 7) return null

  // Read user age from settings
  let userAge: number | null = null
  try {
    const { getSettings } = await import('../lib/storage')
    const settings = await getSettings()
    if (settings.userAge) userAge = parseInt(settings.userAge)
    if (userAge && (userAge < 1 || userAge > 120)) userAge = null
  } catch {}

  const need = estimateSleepNeed(sessions)

  let classification: string
  if (need <= 6.5) classification = 'Short sleeper'
  else if (need <= 7.5) classification = 'Below-average sleeper'
  else if (need <= 8.5) classification = 'Average sleeper'
  else if (need <= 9.5) classification = 'Above-average sleeper'
  else classification = 'Long sleeper'

  let confidence: SleepNeedProfile['confidence']
  if (sessions.length >= 60) confidence = 'high'
  else if (sessions.length >= 21) confidence = 'medium'
  else confidence = 'low'

  const scored = sessions
    .filter(s => s.totalAsleep > 0)
    .map(s => {
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

  const weekdays = scored.filter(s => !s.isWeekend)
  const weekends = scored.filter(s => s.isWeekend)
  const weekdayAvg = weekdays.length > 0 ? parseFloat((weekdays.reduce((s, d) => s + d.hours, 0) / weekdays.length).toFixed(1)) : 0
  const weekendAvg = weekends.length > 0 ? parseFloat((weekends.reduce((s, d) => s + d.hours, 0) / weekends.length).toFixed(1)) : 0

  const chronotype = detectChronotype(sessions)

  const avgAll = scored.reduce((s, d) => s + d.hours, 0) / scored.length
  const deficit = need - avgAll
  let sleepDebtImpact: string
  if (deficit <= 0.25) sleepDebtImpact = 'You are consistently meeting your sleep need.'
  else if (deficit <= 1) sleepDebtImpact = `You average ${deficit.toFixed(1)}h less than your estimated need. Even modest chronic restriction impairs attention and memory (Van Dongen et al., 2003).`
  else sleepDebtImpact = `You average ${deficit.toFixed(1)}h less than your estimated need. This level of restriction is associated with increased cortisol, reduced insulin sensitivity, and cognitive deficits (Spiegel et al., 1999).`

  // Age-adjusted population norms (Ohayon et al., 2004 + Lunsford-Avery et al., 2018 for SRI)
  let ageGroup = '20-39'
  let populationAvgDuration = 7.5, populationAvgDeep = 17, populationAvgRem = 22, populationAvgEfficiency = 85, populationAvgConsistency = 68
  if (userAge) {
    if (userAge < 20) { ageGroup = '14-19'; populationAvgDuration = 8.0; populationAvgDeep = 20; populationAvgRem = 22; populationAvgEfficiency = 88; populationAvgConsistency = 62 }
    else if (userAge < 30) { ageGroup = '20-29'; populationAvgDuration = 7.5; populationAvgDeep = 17; populationAvgRem = 22; populationAvgEfficiency = 86; populationAvgConsistency = 65 }
    else if (userAge < 40) { ageGroup = '30-39'; populationAvgDuration = 7.3; populationAvgDeep = 15; populationAvgRem = 21; populationAvgEfficiency = 85; populationAvgConsistency = 68 }
    else if (userAge < 50) { ageGroup = '40-49'; populationAvgDuration = 7.0; populationAvgDeep = 13; populationAvgRem = 21; populationAvgEfficiency = 83; populationAvgConsistency = 70 }
    else if (userAge < 60) { ageGroup = '50-59'; populationAvgDuration = 6.8; populationAvgDeep = 11; populationAvgRem = 20; populationAvgEfficiency = 80; populationAvgConsistency = 72 }
    else { ageGroup = '60+'; populationAvgDuration = 6.5; populationAvgDeep = 9; populationAvgRem = 19; populationAvgEfficiency = 78; populationAvgConsistency = 74 }
  }

  const allDeepPct = scored.filter(s => s.deepPct > 0)
  const allRemPct = scored.filter(s => s.remPct > 0)
  const userAvgDeepPct = allDeepPct.length > 0 ? allDeepPct.reduce((s, d) => s + d.deepPct, 0) / allDeepPct.length : 0
  const userAvgRemPct = allRemPct.length > 0 ? allRemPct.reduce((s, d) => s + d.remPct, 0) / allRemPct.length : 0
  const userAvgEfficiency = sessions.filter(s => s.totalInBed > 0).length > 0
    ? sessions.filter(s => s.totalInBed > 0).reduce((s, d) => s + (d.totalAsleep / d.totalInBed) * 100, 0) / sessions.filter(s => s.totalInBed > 0).length : 0

  const insights: string[] = []
  insights.push(`Your estimated sleep need is ${need}h based on ${sessions.length} nights. This is calculated from your top 30% highest-quality sleep sessions (best deep + REM ratio).`)

  if (weekendAvg - weekdayAvg > 0.5) {
    insights.push(`You sleep ${(weekendAvg - weekdayAvg).toFixed(1)}h more on weekends (${weekendAvg}h vs ${weekdayAvg}h weekdays). This "social jet lag" suggests weekday sleep restriction (Roenneberg et al., 2012).`)
  }

  const ageLabel = userAge ? ` for ages ${ageGroup}` : ''
  const durationVsPop = avgAll - populationAvgDuration
  if (Math.abs(durationVsPop) > 0.5) {
    insights.push(`You sleep ${avgAll.toFixed(1)}h vs the average of ${populationAvgDuration}h${ageLabel}. You're ${durationVsPop > 0 ? 'above' : 'below'} average by ${Math.abs(durationVsPop).toFixed(1)}h.`)
  }

  if (userAge) {
    if (userAge <= 25) insights.push(`At age ${userAge}, the NSF recommends 7-9 hours. Consistency matters more than duration at this age (Hirshkowitz et al., 2015).`)
    else if (userAge <= 35) insights.push(`At age ${userAge}, you're in peak sleep efficiency. The NSF recommends 7-9 hours (Hirshkowitz et al., 2015).`)
    else if (userAge <= 50) insights.push(`At age ${userAge}, deep sleep declines ~2% per decade. Exercise and cool bedroom temperatures help preserve sleep architecture (Mander et al., 2017).`)
    else insights.push(`At age ${userAge}, deep sleep is naturally lower. Focus on sleep efficiency — the NSF recommends 7-8 hours (Irwin et al., 2006).`)
  }

  const references = [
    { title: 'Cumulative cost of additional wakefulness', finding: 'Chronic 6h sleep for 14 days = cognitive deficits of 2 nights total deprivation.', source: 'Van Dongen et al., Sleep, 2003' },
    { title: 'Sleep debt on metabolic function', finding: '4h sleep for 6 nights reduced glucose tolerance by 40%.', source: 'Spiegel et al., The Lancet, 1999' },
    { title: 'Individual differences in sleep duration', finding: 'Adult sleep need: ~6-10h, mean ~7.5-8h. Genetics = 31-55% of variance.', source: 'Watson et al., Sleep, 2013' },
    { title: 'Social jet lag and obesity', finding: 'Weekend catch-up sleep linked to increased BMI and inflammation.', source: 'Roenneberg et al., Current Biology, 2012' },
    { title: 'Sleep duration and quality by age', finding: 'Adults average 7.5h, 17% deep, 22% REM. Deep sleep drops ~2%/decade.', source: 'Ohayon et al., Sleep Medicine Reviews, 2004' },
    { title: 'US adult sleep statistics', finding: '35% of US adults sleep < 7 hours. CDC recommends 7+ hours.', source: 'CDC BRFSS, 2020' },
  ]

  // Compute Sleep Regularity Index (SRI) from bedtime/wake variance
  const withTimes = sessions.filter(s => s.sleepStart && s.sleepEnd)
  let userAvgConsistency = 65  // fallback
  if (withTimes.length >= 3) {
    const parseHour = (t: string) => {
      const d = new Date(t)
      if (!isNaN(d.getTime())) return d.getHours() + d.getMinutes() / 60
      const m = t.match(/(\d{1,2}):(\d{2})/); return m ? parseInt(m[1]) + parseInt(m[2]) / 60 : 0
    }
    const bedVariance = calculateCircularVariance(withTimes.map(s => parseHour(s.sleepStart)))
    const wakeVariance = calculateCircularVariance(withTimes.map(s => parseHour(s.sleepEnd)))
    userAvgConsistency = Math.round((Math.max(0, 100 - bedVariance * 25) + Math.max(0, 100 - wakeVariance * 25)) / 2)
  }

  return {
    estimatedNeed: need, confidence, chronotype: chronotype.chronotype, dataPoints: sessions.length,
    bestNights, worstNights, weekdayAvg, weekendAvg, sleepDebtImpact, classification,
    insights, references, userAge,
    comparison: {
      you: { avgDuration: parseFloat(avgAll.toFixed(1)), avgDeepPct: parseFloat(userAvgDeepPct.toFixed(0)), avgRemPct: parseFloat(userAvgRemPct.toFixed(0)), avgEfficiency: parseFloat(userAvgEfficiency.toFixed(0)), avgConsistency: userAvgConsistency },
      population: { avgDuration: populationAvgDuration, avgDeepPct: populationAvgDeep, avgRemPct: populationAvgRem, avgEfficiency: populationAvgEfficiency, avgConsistency: populationAvgConsistency, ageGroup },
      populationSDs: { duration: 1.2, deepPct: 5, remPct: 5, efficiency: 8, consistency: 15 },
    },
  }
}

/**
 * Calculate sleep debt — Rise Science methodology
 * 14-night rolling window with exponential decay weighting
 */
export function calculateSleepDebt(
  sessions: SleepSession[],
  sleepNeedOverride?: number
): SleepDebtResult {
  const sleepNeed = sleepNeedOverride ?? estimateSleepNeed(sessions)
  const last14 = sessions.slice(0, 14)

  if (last14.length === 0) {
    return { currentDebt: 0, debtCategory: 'low', sleepNeedEstimate: sleepNeed, last14Nights: [] }
  }

  let weightedDebt = 0
  const nightDetails: SleepDebtResult['last14Nights'] = []

  for (let i = 0; i < last14.length; i++) {
    const session = last14[i]
    const sleptHours = session.totalAsleep / 60
    const delta = sleptHours - sleepNeed

    let weight: number
    if (i === 0) {
      weight = LAST_NIGHT_WEIGHT
    } else {
      const decayFactor = Math.pow(0.85, i - 1)
      const totalDecay = Array.from({ length: Math.min(last14.length - 1, 13) }, (_, j) =>
        Math.pow(0.85, j)
      ).reduce((a, b) => a + b, 0)
      weight = (REMAINING_WEIGHT * decayFactor) / totalDecay
    }

    weightedDebt += Math.max(0, -delta) * weight
    nightDetails.push({
      date: session.date,
      slept: parseFloat(sleptHours.toFixed(1)),
      need: sleepNeed,
      delta: parseFloat(delta.toFixed(1))
    })
  }

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
    last14Nights: nightDetails
  }
}

/**
 * Predict circadian rhythm phases based on habitual sleep timing
 */
export function predictCircadianRhythm(sessions: SleepSession[]): CircadianPrediction {
  const recentSessions = sessions.slice(0, 7).filter(s => s.sleepStart && s.sleepEnd)

  let avgSleepHour = 23.0
  let avgWakeHour = 7.0

  if (recentSessions.length >= 3) {
    avgSleepHour = circularMean(recentSessions.map(s => parseTimeToHours(s.sleepStart)))
    avgWakeHour = circularMean(recentSessions.map(s => parseTimeToHours(s.sleepEnd)))
  }

  const melatoninStart = normalizeHour(avgSleepHour - 2)
  const melatoninEnd = normalizeHour(avgSleepHour - 1)
  const optimalBedtime = formatHour(normalizeHour(melatoninStart + 0.25))

  const sleepLatency = 0.25
  const fiveCycles = (5 * SLEEP_CYCLE_MINUTES) / 60
  const optimalWake = normalizeHour(avgSleepHour + sleepLatency + fiveCycles)

  const energyPhases: EnergyPhase[] = [
    {
      name: 'Sleep Inertia',
      start: formatHour(avgWakeHour),
      end: formatHour(avgWakeHour + 1.5),
      level: 'low',
      description: 'Grogginess after waking. Light exposure and movement help.'
    },
    {
      name: 'Morning Peak',
      start: formatHour(avgWakeHour + 1.5),
      end: formatHour(avgWakeHour + 5),
      level: 'peak',
      description: 'Highest cognitive performance. Best for deep work and creative tasks.'
    },
    {
      name: 'Afternoon Dip',
      start: formatHour(avgWakeHour + 5),
      end: formatHour(avgWakeHour + 8),
      level: 'dipping',
      description: 'Natural energy dip. Good for routine tasks or a 20-min nap.'
    },
    {
      name: 'Evening Peak',
      start: formatHour(avgWakeHour + 8),
      end: formatHour(avgWakeHour + 12),
      level: 'peak',
      description: 'Second wind. Good for social activities and exercise.'
    },
    {
      name: 'Wind Down',
      start: formatHour(avgWakeHour + 12),
      end: formatHour(avgSleepHour),
      level: 'winding_down',
      description: 'Melatonin rising. Dim lights, avoid screens.'
    }
  ]

  return {
    melatoninWindowStart: formatHour(melatoninStart),
    melatoninWindowEnd: formatHour(melatoninEnd),
    optimalBedtime,
    optimalWakeTime: formatHour(optimalWake),
    energyPhases
  }
}

/**
 * Score sleep quality from a single session
 */
export function scoreSleepQuality(session: SleepSession, sessions: SleepSession[]): SleepQualityScore {
  const recommendations: string[] = []

  // Deep sleep score (target: 13-23%)
  const deepPercent = session.totalAsleep > 0 ? (session.deepSleep / session.totalAsleep) * 100 : 0
  let deepSleepScore: number
  if (deepPercent >= 13 && deepPercent <= 23) {
    deepSleepScore = 90 + (deepPercent >= 15 && deepPercent <= 20 ? 10 : 0)
  } else if (deepPercent >= 10) {
    deepSleepScore = 60 + (deepPercent - 10) * 10
  } else {
    deepSleepScore = Math.max(0, deepPercent * 6)
    recommendations.push(`Deep sleep was ${deepPercent.toFixed(0)}% (target: 15-23%). Try cooler room (65-68F), avoid alcohol.`)
  }

  // REM score (target: 20-25%)
  const remPercent = session.totalAsleep > 0 ? (session.remSleep / session.totalAsleep) * 100 : 0
  let remScore: number
  if (remPercent >= 20 && remPercent <= 25) {
    remScore = 95
  } else if (remPercent >= 15) {
    remScore = 70 + (remPercent - 15) * 5
  } else {
    remScore = Math.max(0, remPercent * 4.6)
    recommendations.push(`REM was ${remPercent.toFixed(0)}% (target: 20-25%). Sleeping longer increases REM in later cycles.`)
  }

  // Efficiency (time asleep / time in bed)
  const efficiency = session.totalInBed > 0 ? (session.totalAsleep / session.totalInBed) * 100 : 0
  let efficiencyScore: number
  if (efficiency >= 85) {
    efficiencyScore = 90 + Math.min(10, (efficiency - 85) * 0.67)
  } else if (efficiency >= 75) {
    efficiencyScore = 60 + (efficiency - 75) * 3
  } else {
    efficiencyScore = Math.max(0, efficiency * 0.8)
    recommendations.push(`Sleep efficiency was ${efficiency.toFixed(0)}% (target: 85%+). Get up if you can't sleep within 20 min.`)
  }

  // Consistency (bedtime variance over last 7 days)
  const recentSessions = sessions.slice(0, 7).filter(s => s.sleepStart)
  let consistencyScore = 50
  if (recentSessions.length >= 3) {
    const sleepHours = recentSessions.map(s => parseTimeToHours(s.sleepStart))
    const variance = calculateCircularVariance(sleepHours)
    if (variance <= 0.25) consistencyScore = 95
    else if (variance <= 1.0) consistencyScore = 75 + (1.0 - variance) * 26.7
    else consistencyScore = Math.max(20, 75 - (variance - 1.0) * 20)

    if (variance > 1.5) {
      recommendations.push(`Bedtime varies significantly. Aim for the same bedtime +/-30 min every night.`)
    }
  }

  // Core sleep score (target: 45-55% of totalAsleep)
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
    coreSleepScore = Math.max(0, 70 - (corePercent - 60) * 3.5)
  }

  // WASO score (Wake After Sleep Onset)
  const awakeMins = session.awakeTime
  let wasoScore: number
  if (awakeMins <= 15) {
    wasoScore = 95 + Math.max(0, (15 - awakeMins) / 3)
  } else if (awakeMins <= 30) {
    wasoScore = 75 + (30 - awakeMins) * (20 / 15)
  } else if (awakeMins <= 60) {
    wasoScore = 50 + (60 - awakeMins) * (25 / 30)
  } else {
    wasoScore = Math.max(0, 50 - (awakeMins - 60) * 0.5)
  }
  if (awakeMins > 30) {
    recommendations.push(`You were awake ${Math.round(awakeMins)} min during the night (target: <15 min).`)
  }

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
    recommendations.push(`You slept ${hoursSlept.toFixed(1)}h. Most adults need 7-9h. Even 30 min more can significantly reduce sleep debt.`)
  }

  // Overall score — duration is dominant factor (matches desktop scoring)
  let overall = Math.round(
    durationScore * 0.30 +
    deepSleepScore * 0.15 +
    remScore * 0.15 +
    coreSleepScore * 0.10 +
    efficiencyScore * 0.10 +
    consistencyScore * 0.10 +
    wasoScore * 0.10
  )

  // Hard caps: short sleep can't score well even with perfect stage ratios
  if (hoursSlept < 5) {
    overall = Math.min(overall, 40)
  } else if (hoursSlept < 6) {
    overall = Math.min(overall, 60)
  } else if (hoursSlept < 7) {
    overall = Math.min(overall, 80)
  }

  if (recommendations.length === 0) {
    recommendations.push('Great sleep! Maintain your current routine.')
  }

  return {
    overall: Math.min(100, Math.max(0, overall)),
    deepSleepScore: Math.min(100, Math.max(0, Math.round(deepSleepScore))),
    remScore: Math.min(100, Math.max(0, Math.round(remScore))),
    coreSleepScore: Math.min(100, Math.max(0, Math.round(coreSleepScore))),
    wasoScore: Math.min(100, Math.max(0, Math.round(wasoScore))),
    efficiencyScore: Math.min(100, Math.max(0, Math.round(efficiencyScore))),
    consistencyScore: Math.min(100, Math.max(0, Math.round(consistencyScore))),
    cycleCompletion: parseFloat(cycleCompletion.toFixed(1)),
    recommendations
  }
}

/**
 * Recommend wake times based on 90-min sleep cycles
 */
export function recommendWakeTime(bedtime: string, sleepLatencyMin: number = 15): WakeTimeRecommendation {
  const bedtimeHours = parseTimeToHours(bedtime)
  const fallAsleepTime = bedtimeHours + sleepLatencyMin / 60

  const cycleCounts = [4, 5, 6]
  const wakeTimes = cycleCounts.map(n => ({
    cycles: n,
    time: formatHour(normalizeHour(fallAsleepTime + (n * SLEEP_CYCLE_MINUTES) / 60)),
    hours: (n * SLEEP_CYCLE_MINUTES) / 60
  }))

  const optimal = wakeTimes.find(w => w.cycles === 5)!
  const alternatives = wakeTimes.filter(w => w.cycles !== 5).map(w => w.time)

  return {
    optimalWakeTime: optimal.time,
    alternativeWakeTimes: alternatives,
    reasoning: `Bedtime ${bedtime} + ${sleepLatencyMin}min latency. ` +
      `${optimal.cycles} cycles (${optimal.hours}h) = wake at ${optimal.time}. ` +
      `Alt: ${wakeTimes[0].time} (${wakeTimes[0].hours}h) or ${wakeTimes[2].time} (${wakeTimes[2].hours}h).`
  }
}

/**
 * Recommend bedtimes based on a desired wake time and 90-min sleep cycles
 */
export function recommendBedtime(wakeTime: string, sleepLatencyMin: number = 15): WakeTimeRecommendation {
  const wakeHours = parseTimeToHours(wakeTime)

  const cycleCounts = [4, 5, 6]
  const bedtimes = cycleCounts.map(n => {
    const sleepOnset = normalizeHour(wakeHours - (n * SLEEP_CYCLE_MINUTES) / 60)
    const bedtimeHour = normalizeHour(sleepOnset - sleepLatencyMin / 60)
    return {
      cycles: n,
      time: formatHour(bedtimeHour),
      hours: (n * SLEEP_CYCLE_MINUTES) / 60
    }
  })

  const optimal = bedtimes.find(b => b.cycles === 5)!
  const alternatives = bedtimes.filter(b => b.cycles !== 5).map(b => b.time)

  return {
    optimalWakeTime: optimal.time,
    alternativeWakeTimes: alternatives,
    reasoning: `Wake at ${wakeTime}. ${optimal.cycles} cycles (${optimal.hours}h) means falling asleep by ${formatHour(normalizeHour(wakeHours - optimal.hours))}. ` +
      `With ${sleepLatencyMin}min latency, go to bed at ${optimal.time}. ` +
      `Alt: ${bedtimes[0].time} (${bedtimes[0].hours}h) or ${bedtimes[2].time} (${bedtimes[2].hours}h).`
  }
}

/**
 * Detect chronotype using MCTQ methodology
 */
export function detectChronotype(sessions: SleepSession[]): ChronotypeResult {
  if (sessions.length < 7) {
    return {
      chronotype: 'bear', label: 'Bear (Default)',
      description: 'Not enough data. Bear is the most common (~55% of people).',
      msfsc: 3.5, idealWake: '07:00', idealSleep: '23:00',
      peakFocus: '10:00-14:00', peakExercise: '17:00-19:00'
    }
  }

  const withDayOfWeek = sessions.map(s => ({
    ...s, isWeekend: [0, 6].includes(new Date(s.date).getDay())
  }))

  const weekendSessions = withDayOfWeek.filter(s => s.isWeekend)
  const weekdaySessions = withDayOfWeek.filter(s => !s.isWeekend)

  const freeSessions = weekendSessions.length >= 2 ? weekendSessions : sessions
  const freeSleepStarts = freeSessions.map(s => parseTimeToHours(s.sleepStart))
  const freeSleepDurations = freeSessions.map(s => s.totalAsleep / 60)

  const avgFreeStart = circularMean(freeSleepStarts)
  const avgFreeDuration = freeSleepDurations.reduce((a, b) => a + b, 0) / freeSleepDurations.length
  const avgWeekdayDuration = weekdaySessions.length >= 2
    ? weekdaySessions.map(s => s.totalAsleep / 60).reduce((a, b) => a + b, 0) / weekdaySessions.length
    : avgFreeDuration

  const msf = normalizeHour(avgFreeStart + avgFreeDuration / 2)
  const oversleep = Math.max(0, avgFreeDuration - avgWeekdayDuration) / 2
  const msfsc = normalizeHour(msf - oversleep)

  const allSleepStarts = sessions.map(s => parseTimeToHours(s.sleepStart))
  const consistency = calculateCircularVariance(allSleepStarts)

  if (consistency > 4.0) {
    return {
      chronotype: 'dolphin', label: 'Dolphin',
      description: 'Irregular sleep pattern. Focus on consistency first.',
      msfsc, idealWake: '06:30', idealSleep: '23:30',
      peakFocus: '10:00-12:00', peakExercise: '07:30-09:00'
    }
  } else if (msfsc < 2.5) {
    return {
      chronotype: 'lion', label: 'Lion (Early Bird)',
      description: 'Morning-dominant. Peak energy in the morning.',
      msfsc, idealWake: '05:30', idealSleep: '21:30',
      peakFocus: '08:00-12:00', peakExercise: '06:00-08:00'
    }
  } else if (msfsc < 4.5) {
    return {
      chronotype: 'bear', label: 'Bear (Average)',
      description: 'Solar-aligned rhythm. Energy follows the sun.',
      msfsc, idealWake: '07:00', idealSleep: '23:00',
      peakFocus: '10:00-14:00', peakExercise: '17:00-19:00'
    }
  } else {
    return {
      chronotype: 'wolf', label: 'Wolf (Night Owl)',
      description: 'Evening-dominant. Creativity peaks later in the day.',
      msfsc, idealWake: '08:30', idealSleep: '00:00',
      peakFocus: '17:00-21:00', peakExercise: '18:00-20:00'
    }
  }
}

/**
 * Social jet lag — weekday vs weekend sleep timing shift
 */
export function calculateSocialJetLag(sessions: SleepSession[]): SocialJetLagResult {
  const withDow = sessions.map(s => ({
    ...s, isWeekend: [0, 6].includes(new Date(s.date).getDay())
  }))
  const weekday = withDow.filter(s => !s.isWeekend)
  const weekend = withDow.filter(s => s.isWeekend)

  if (weekday.length < 3 || weekend.length < 2) {
    return { jetLagHours: 0, severity: 'none', weekdayMidSleep: 0, weekendMidSleep: 0,
      recommendation: 'Need more data (3 weekday + 2 weekend nights).' }
  }

  const weekdayMids = weekday.map(s => normalizeHour(parseTimeToHours(s.sleepStart) + s.totalAsleep / 120))
  const weekendMids = weekend.map(s => normalizeHour(parseTimeToHours(s.sleepStart) + s.totalAsleep / 120))

  const weekdayMidSleep = circularMean(weekdayMids)
  const weekendMidSleep = circularMean(weekendMids)

  let diff = weekendMidSleep - weekdayMidSleep
  if (diff > 12) diff -= 24
  if (diff < -12) diff += 24
  const jetLagHours = Math.abs(diff)

  let severity: SocialJetLagResult['severity']
  let recommendation: string
  if (jetLagHours < 0.5) {
    severity = 'none'; recommendation = 'Excellent weekday/weekend consistency.'
  } else if (jetLagHours < 1.0) {
    severity = 'mild'; recommendation = 'Minor shift. Keep weekend wake time within 30 min of weekday.'
  } else if (jetLagHours < 2.0) {
    severity = 'moderate'; recommendation = `${jetLagHours.toFixed(1)}h shift. Can impair metabolism. Shift weekend bedtime earlier.`
  } else {
    severity = 'severe'; recommendation = `${jetLagHours.toFixed(1)}h shift = crossing ${Math.round(jetLagHours)} time zones weekly. Align schedules.`
  }

  return { jetLagHours: parseFloat(jetLagHours.toFixed(1)), severity, weekdayMidSleep, weekendMidSleep, recommendation }
}

/**
 * Caffeine cutoff — 8h before melatonin window
 */
export function calculateCaffeineCutoff(sessions: SleepSession[]): CaffeineCutoff {
  const circadian = predictCircadianRhythm(sessions)
  const melatoninStart = parseTimeToHours(circadian.melatoninWindowStart)
  const cutoffHour = normalizeHour(melatoninStart - 8)

  return {
    lastCaffeineTime: formatHour(cutoffHour),
    reason: `Last cup by ${formatHour(cutoffHour)} ensures <12.5% caffeine remains when melatonin rises at ${circadian.melatoninWindowStart}.`,
    melatoninWindow: circadian.melatoninWindowStart
  }
}

/**
 * HRV-based recovery scoring (WHOOP/Oura style z-score method)
 */
export async function calculateHrvRecovery(): Promise<HrvRecoveryScore | null> {
  const db = await getDb()
  const rows = await db.getAllAsync(
    `SELECT date, value_json FROM health_metrics WHERE metric_type = 'hrv' ORDER BY date DESC LIMIT 60`
  ) as Array<{ date: string; value_json: string }>

  if (rows.length < 7) return null

  const values = rows.map(r => {
    try {
      const data = JSON.parse(r.value_json)
      return data.avg || data.value || data.qty || 0
    } catch { return 0 }
  }).filter((v: number) => v > 0)

  if (values.length < 7) return null

  const latestHrv = values[0]
  const baseline = values.reduce((a: number, b: number) => a + b, 0) / values.length
  const stdDev = Math.sqrt(
    values.reduce((sum: number, v: number) => sum + Math.pow(v - baseline, 2), 0) / (values.length - 1)
  )
  const zScore = stdDev > 0 ? (latestHrv - baseline) / stdDev : 0
  const score = Math.round(Math.min(100, Math.max(0, 50 + zScore * 20)))

  let status: HrvRecoveryScore['status']
  let recommendation: string
  if (score >= 70) {
    status = 'optimal'; recommendation = 'Well-recovered. Great day for intense training or deep work.'
  } else if (score >= 50) {
    status = 'good'; recommendation = 'Normal recovery. Moderate intensity is fine.'
  } else if (score >= 30) {
    status = 'fair'; recommendation = 'Below baseline. Prioritize lighter activities and good sleep.'
  } else {
    status = 'poor'; recommendation = 'Poor recovery. Rest, hydrate, avoid intense training.'
  }

  return { score, status, latestHrv, baseline: parseFloat(baseline.toFixed(1)), zScore: parseFloat(zScore.toFixed(2)), recommendation }
}

/**
 * Process S/C Energy Curve — Rise Science Two-Process Model
 *
 * Generates a continuous energy prediction curve using:
 * - Process S: Exponential sleep pressure accumulation/dissipation
 * - Process C: Sinusoidal circadian alerting signal
 *
 * Returns hourly energy points for a 24h period starting from wake time.
 */
export function calculateEnergyCurve(
  sessions: SleepSession[],
  sleepNeedOverride?: number
): EnergyCurvePoint[] {
  const recentSessions = sessions.slice(0, 7).filter(s => s.sleepStart && s.sleepEnd)

  let avgWakeHour = 7.0
  let avgSleepHour = 23.0

  if (recentSessions.length >= 3) {
    avgWakeHour = circularMean(recentSessions.map(s => parseTimeToHours(s.sleepEnd)))
    avgSleepHour = circularMean(recentSessions.map(s => parseTimeToHours(s.sleepStart)))
  }

  const debt = calculateSleepDebt(sessions, sleepNeedOverride)
  const debtFactor = Math.max(0.4, 1 - (debt.currentDebt / 20))

  // Total awake hours before sleep — same boundaries as predictCircadianRhythm
  const totalAwakeHours = ((avgSleepHour - avgWakeHour + 24) % 24) || 16

  // Phase boundary offsets (hours after wake) — kept in sync with predictCircadianRhythm
  const INERTIA_END = 1.5
  const MORNING_PEAK_END = 5.0
  const DIP_END = 8.0
  const EVENING_PEAK_END = 12.0

  // Cosine-smoothed interpolation for natural-looking transitions
  const coslerp = (a: number, b: number, t: number) =>
    a + (b - a) * (1 - Math.cos(t * Math.PI)) / 2

  function rawEnergy(h: number): number {
    if (h >= totalAwakeHours) return 0.08 // sleep phase — low and flat

    if (h <= INERTIA_END) {
      return coslerp(0.15, 0.48, h / INERTIA_END)
    }

    if (h <= MORNING_PEAK_END) {
      // Hump peaking at the midpoint
      const mid = (INERTIA_END + MORNING_PEAK_END) / 2
      return h <= mid
        ? coslerp(0.48, 0.92, (h - INERTIA_END) / (mid - INERTIA_END))
        : coslerp(0.92, 0.68, (h - mid) / (MORNING_PEAK_END - mid))
    }

    if (h <= DIP_END) {
      // Valley bottoming at the midpoint
      const mid = (MORNING_PEAK_END + DIP_END) / 2
      return h <= mid
        ? coslerp(0.68, 0.33, (h - MORNING_PEAK_END) / (mid - MORNING_PEAK_END))
        : coslerp(0.33, 0.47, (h - mid) / (DIP_END - mid))
    }

    if (h <= EVENING_PEAK_END) {
      // Second hump peaking at the midpoint
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

/**
 * Run full sleep analysis on local data
 */
export async function runFullAnalysis(): Promise<FullSleepAnalysis | null> {
  const sessions = await parseSleepSessions(30)
  if (sessions.length === 0) return null

  // Resolve sleep need over the fixed long window so debt matches desktop.
  const sleepNeed = await getCanonicalSleepNeed()
  const debt = calculateSleepDebt(sessions, sleepNeed)
  const circadian = predictCircadianRhythm(sessions)
  const lastNight = sessions[0]
  const quality = lastNight.totalAsleep > 0 ? scoreSleepQuality(lastNight, sessions) : null
  const chronotype = detectChronotype(sessions)
  const socialJetLag = calculateSocialJetLag(sessions)
  const caffeineCutoff = calculateCaffeineCutoff(sessions)
  const hrvRecovery = await calculateHrvRecovery()
  const wakeRecommendation = recommendWakeTime(circadian.optimalBedtime)
  const energyCurve = calculateEnergyCurve(sessions, sleepNeed)

  return {
    debt, quality, circadian, chronotype, socialJetLag,
    caffeineCutoff, hrvRecovery, wakeRecommendation, energyCurve
  }
}

// --- Helper Functions ---

function parseTimeToHours(timeStr: string): number {
  if (!timeStr) return 0
  if (timeStr.includes('T')) {
    const date = new Date(timeStr)
    return date.getHours() + date.getMinutes() / 60
  }
  const match = timeStr.match(/(\d{1,2}):(\d{2})/)
  if (match) return parseInt(match[1]) + parseInt(match[2]) / 60
  return 0
}

export function formatHour(hour: number): string {
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

function circularMean(hours: number[]): number {
  const radians = hours.map(h => (h / 24) * 2 * Math.PI)
  const sinMean = radians.reduce((sum, r) => sum + Math.sin(r), 0) / radians.length
  const cosMean = radians.reduce((sum, r) => sum + Math.cos(r), 0) / radians.length
  let meanAngle = Math.atan2(sinMean, cosMean)
  if (meanAngle < 0) meanAngle += 2 * Math.PI
  return (meanAngle / (2 * Math.PI)) * 24
}

function calculateCircularVariance(hours: number[]): number {
  if (hours.length < 2) return 0
  const mean = circularMean(hours)
  return hours.reduce((sum, h) => {
    let diff = h - mean
    if (diff > 12) diff -= 24
    if (diff < -12) diff += 24
    return sum + diff * diff
  }, 0) / (hours.length - 1)
}

// --- Wind-Down Routine ---

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

export function calculateWindDownRoutine(sessions: SleepSession[]): WindDownRoutine {
  const circadian = predictCircadianRhythm(sessions)
  const bedtimeHour = parseTimeToHours(circadian.optimalBedtime)

  return {
    optimalBedtime: circadian.optimalBedtime,
    melatoninWindow: circadian.melatoninWindowStart,
    steps: [
      { time: formatHour(normalizeHour(bedtimeHour - 2)), activity: 'Dim lights', icon: 'dim', description: 'Switch to warm/dim lighting to support melatonin onset.' },
      { time: formatHour(normalizeHour(bedtimeHour - 1.5)), activity: 'Stop screens', icon: 'phone', description: 'Put away phone and laptop. Blue light delays melatonin.' },
      { time: formatHour(normalizeHour(bedtimeHour - 1.25)), activity: 'Warm shower', icon: 'shower', description: 'Triggers rapid body cooling, promoting sleep onset.' },
      { time: formatHour(normalizeHour(bedtimeHour - 1)), activity: 'Light snack', icon: 'snack', description: 'Small tryptophan-rich snack (cherries, nuts, warm milk).' },
      { time: formatHour(normalizeHour(bedtimeHour - 0.5)), activity: 'Stretch & breathe', icon: 'stretch', description: 'Light stretching or 4-7-8 breathing exercise.' },
      { time: formatHour(normalizeHour(bedtimeHour - 0.25)), activity: 'Read in bed', icon: 'read', description: 'Physical book or e-ink reader — no screens.' },
      { time: circadian.optimalBedtime, activity: 'Lights out', icon: 'bed', description: 'Room cool (65-68°F), dark, and quiet.' },
    ],
  }
}
