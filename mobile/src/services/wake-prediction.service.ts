/**
 * Wake Prediction Service — Mobile (React Native / Expo)
 *
 * Mobile port of the desktop wake-prediction model.
 * Same "latest of three floors" algorithm; adapted for expo-sqlite
 * and the mobile sleep-analysis service interface.
 *
 * See src/main/services/health/wake-prediction.ts for full references.
 */

import { getDb } from '../lib/database'
import {
  getCanonicalSleepNeed,
  calculateSleepDebt,
  detectChronotype,
  calculateSocialJetLag,
  formatHour,
} from './sleep-analysis.service'
import type { SleepSession } from './sleep-analysis.service'

// ─── Constants ───────────────────────────────────────────────────────────────
const TAU_S = 4.2
const TAU_W = 18.2
const S_UPPER = 1.0
const S_LOWER = 0.17
const INERTIA_HIGH_S  = 0.55
const INERTIA_MED_S   = 0.38
const MIN_NIGHTS      = 5
const SLEEP_CYCLE_H   = 1.5
const CYCLE_SNAP_H    = 0.75
const PRC_MORNING_MAX = 1.0
const PRC_EVENING_MAX = 1.2
const CIRC_OFFSET_H   = 1.0    // CBTmin + this = circadian wake-zone onset

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WakePredictionInput {
  recentSleepDays?: number
  isWorkday?: boolean
  currentDate?: Date
}

export interface WakePredictionResult {
  rangeStart: string
  rangeEnd: string
  optimalPoint: string
  confidence: 'low' | 'medium' | 'high'
  confidenceScore: number
  explanation: {
    sleepDebt: string
    circadianAlignment: string
    consistency: string
    inertiaRisk: string
    summary: string
  }
  signals: {
    estimatedDLMO: string
    processSAtPredictedWake: number
    sleepDebtHours: number
    sleepNeedHours: number
    chronotype: string
    sleepRegularityIndex: number
    habitualWakeTime: string
    habitualSleepOnset: string
    estimatedMSFsc: string
    socialJetLagHours: number
    dataPoints: number
    prcAdjustmentMinutes: number
    inertiaRisk: 'low' | 'medium' | 'high'
    cycleAlignedWakes: string[]
    bindingFloor: 'sleep_need' | 'circadian' | 'consistency'
  }
  dataQuality: 'phone_only' | 'wearable_actigraphy'
  disclaimer: string
}

export interface WakePredictionRecord {
  date: string
  predictedRangeStart: string
  predictedRangeEnd: string
  optimalPoint: string
  confidence: string
  confidenceScore: number
  bindingFloor: string
  actualWakeTime?: string
  grogginessRating?: number
  energyRating?: number
  minutesToAlertAfterWake?: number
  snoozed?: boolean
}

export interface WakePredictionValidation {
  totalPredictions: number
  withOutcomes: number
  avgErrorMinutes: number
  pctWithinRange: number
  avgGrogginessInRange: number
  avgGrogginessOutRange: number
  snoozedPct: number
  bindingFloorBreakdown: Record<string, number>
  verdict: string
}

// ─── Time Utilities ──────────────────────────────────────────────────────────

function parseTimeToHours(t: string): number {
  if (!t) return 7.0
  if (t.includes('T') || (t.includes(' ') && t.length > 8)) {
    const m = t.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/)
    if (m) {
      const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`)
      if (!isNaN(d.getTime())) return d.getHours() + d.getMinutes() / 60
    }
    const d = new Date(t)
    if (!isNaN(d.getTime())) return d.getHours() + d.getMinutes() / 60
  }
  const parts = t.split(':')
  if (parts.length >= 2) return parseInt(parts[0]) + parseInt(parts[1]) / 60
  return 7.0
}

function normalizeHour(h: number): number {
  return ((h % 24) + 24) % 24
}

function fmtHour(h: number): string {
  return formatHour(normalizeHour(h))
}

function circularMean(hours: number[]): number {
  if (!hours.length) return 7.0
  const ω = (2 * Math.PI) / 24
  const sin = hours.reduce((s, h) => s + Math.sin(h * ω), 0) / hours.length
  const cos = hours.reduce((s, h) => s + Math.cos(h * ω), 0) / hours.length
  return normalizeHour(Math.atan2(sin, cos) / ω)
}

function circularStdDev(hours: number[]): number {
  if (hours.length < 2) return 0
  const mean = circularMean(hours)
  const diffs = hours.map(h => {
    let d = h - mean
    if (d > 12) d -= 24
    if (d < -12) d += 24
    return d
  })
  return Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length)
}

function circDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 24
  return d > 12 ? 24 - d : d
}

function hoursAfterRef(ref: number, t: number): number {
  let diff = normalizeHour(t - ref)
  if (diff > 20) diff -= 24
  return diff
}

function circularLatest(
  candidates: number[],
  refH: number,
): { hour: number; index: number } {
  let idx = 0
  let best = hoursAfterRef(refH, candidates[0])
  for (let i = 1; i < candidates.length; i++) {
    const off = hoursAfterRef(refH, candidates[i])
    if (off > best) { best = off; idx = i }
  }
  return { hour: candidates[idx], index: idx }
}

/** Inline Sleep Regularity Index (0–100). Correlates consecutive days' wake times. */
function calcSRI(sessions: SleepSession[]): number {
  if (sessions.length < 7) return 50
  const wakeH = sessions.slice(0, 14).map(s => parseTimeToHours(s.sleepEnd))
  let agreements = 0
  let total = 0
  for (let i = 0; i < wakeH.length - 1; i++) {
    const diff = circDist(wakeH[i], wakeH[i + 1])
    agreements += diff <= 0.5 ? 1 : Math.max(0, 1 - diff / 2)
    total++
  }
  return Math.round((agreements / total) * 100)
}

// ─── Process S ───────────────────────────────────────────────────────────────

function processSAfterSleep(sOnset: number, dH: number): number {
  return S_LOWER + (sOnset - S_LOWER) * Math.exp(-dH / TAU_S)
}

function processSAfterWake(sWake: number, tH: number): number {
  return S_UPPER - (S_UPPER - sWake) * Math.exp(-tH / TAU_W)
}

function estimateSAtSleepOnset(wakeH: number, onsetH: number): number {
  const awake = normalizeHour(onsetH - wakeH + 24) || 16
  return processSAfterWake(0.28, awake)
}

// ─── Phase & PRC ─────────────────────────────────────────────────────────────

function estimateDLMO(msfsc: number): number {
  return normalizeHour(msfsc - 7)
}

async function estimatePRCShift(): Promise<number> {
  try {
    const db = await getDb()
    const rows: Array<{ value_json: string }> = db.getAllSync(
      `SELECT value_json FROM health_metrics
       WHERE metric_type = 'light_exposure'
       ORDER BY date DESC LIMIT 14`
    )
    if (rows.length < 3) return 0.1
    let total = 0
    for (const row of rows) {
      const d = JSON.parse(row.value_json)
      const ml: number = d.morning_lux ?? d.morningLux ?? 0
      const el: number = d.evening_lux ?? d.eveningLux ?? 0
      if (ml > 100) total += PRC_MORNING_MAX * Math.min(1, ml / 10_000) * 0.3
      if (el > 50)  total -= PRC_EVENING_MAX * Math.min(1, el / 1_000)  * 0.3
    }
    return total / rows.length
  } catch {
    return 0.1
  }
}

// ─── Cycle Alignment ─────────────────────────────────────────────────────────

function getCycleAlignedWakes(onsetH: number, latencyMin: number): string[] {
  const startH = normalizeHour(onsetH + latencyMin / 60)
  return [4, 5, 6, 7].map(n => fmtHour(startH + n * SLEEP_CYCLE_H))
}

// ─── Adjustments ─────────────────────────────────────────────────────────────

function debtAdjH(debtH: number): number {
  if (debtH > 10) return 0.5
  if (debtH > 5)  return 0.25
  if (debtH > 2)  return 0.1
  return 0
}

async function grogginessAdjH(): Promise<number> {
  try {
    const db = await getDb()
    const rows: Array<{ value_json: string }> = db.getAllSync(
      `SELECT value_json FROM health_metrics
       WHERE metric_type = 'wake_prediction'
       ORDER BY date DESC LIMIT 7`
    )
    const rated = rows
      .map(r => JSON.parse(r.value_json) as WakePredictionRecord)
      .filter(r => typeof r.grogginessRating === 'number' && r.actualWakeTime)
    if (rated.length < 3) return 0
    const avg = rated.reduce((s, r) => s + r.grogginessRating!, 0) / rated.length
    if (avg > 3.5) return  0.25
    if (avg < 2.0) return -0.17
    return 0
  } catch {
    return 0
  }
}

// ─── Confidence ──────────────────────────────────────────────────────────────

function calcConfidence(
  dataPoints: number, sri: number, jetLagH: number,
  wakeStdDevH: number, chronotype: string, debtH: number,
): { score: number; level: 'low' | 'medium' | 'high' } {
  let s = 0
  s += dataPoints >= 21 ? 30 : dataPoints >= 14 ? 22 : dataPoints >= 7 ? 12 : 4
  s += sri >= 90 ? 25 : sri >= 80 ? 20 : sri >= 70 ? 14 : sri >= 60 ? 8 : 3
  s += wakeStdDevH <= 0.25 ? 20 : wakeStdDevH <= 0.5 ? 15 : wakeStdDevH <= 1.0 ? 8 : 2
  s += jetLagH < 0.5 ? 15 : jetLagH < 1.0 ? 10 : jetLagH < 2.0 ? 5 : 0
  s += chronotype !== 'dolphin' ? 10 : 3
  if (debtH > 10) s -= 5
  const score = Math.max(0, Math.min(100, s))
  return { score, level: score >= 65 ? 'high' : score >= 35 ? 'medium' : 'low' }
}

// ─── Explanation ─────────────────────────────────────────────────────────────

function buildExplanation(p: {
  debtH: number; debtCategory: string; sleepNeedH: number
  dlmoH: number; wakeStdDevH: number; sri: number
  jetLagH: number; sAtWake: number; inertiaRisk: 'low' | 'medium' | 'high'
  rangeStart: string; rangeEnd: string; dataPoints: number
  prcH: number; chronotype: string; bindingFloor: string
}): WakePredictionResult['explanation'] {

  const sleepDebt = p.debtH < 1
    ? `Well-rested — under 1 hour of sleep debt. Operating near your ${p.sleepNeedH.toFixed(1)}-hour baseline.`
    : p.debtCategory === 'low'
    ? `Modest ${p.debtH.toFixed(1)}-hour debt. The window is shifted slightly later to allow recovery.`
    : p.debtCategory === 'moderate'
    ? `${p.debtH.toFixed(1)}-hour debt impairs alertness and reaction time. Consistent earlier bedtimes — not a single long sleep — are needed.`
    : `Significant debt: ${p.debtH.toFixed(1)} hours. Perceived sleepiness underestimates true impairment. 1–2 weeks of earlier bedtimes required.`

  const prcNote = p.prcH > 0.1
    ? ` Morning light estimated to advance clock ~${Math.round(p.prcH * 60)} min.`
    : p.prcH < -0.1
    ? ` Evening light estimated to delay clock ~${Math.round(Math.abs(p.prcH) * 60)} min.`
    : ''

  const floorNote =
    p.bindingFloor === 'circadian'   ? 'Body clock is the limiting factor.'
    : p.bindingFloor === 'sleep_need' ? 'Sleep need is the limiting factor.'
    : 'Established wake pattern is the anchor.'

  const circadianAlignment = `Chronotype: ${p.chronotype}. Estimated DLMO ~${fmtHour(p.dlmoH)} (behavioral estimate, ±1–2h uncertainty). Circadian wake zone begins ~${CIRC_OFFSET_H}h after CBT minimum. ${floorNote}${prcNote}`

  const stdMin = Math.round(p.wakeStdDevH * 60)
  const consistency = p.sri >= 85 && stdMin <= 20
    ? `Excellent regularity: ±${stdMin} min variance (SRI ${p.sri}/100).`
    : p.jetLagH >= 1
    ? `Social jet lag of ${p.jetLagH.toFixed(1)}h detected. Bringing weekend wake within 30–45 min of weekday time would improve accuracy.`
    : `Wake times vary ±${stdMin} min (SRI ${p.sri}/100). More consistency improves confidence.`

  const sPct = (p.sAtWake * 100).toFixed(0)
  const inertiaRisk = p.inertiaRisk === 'low'
    ? `Low inertia risk (Process S ≈ ${sPct}%): waking near a cycle boundary — faster cortical re-activation expected.`
    : p.inertiaRisk === 'medium'
    ? `Moderate inertia risk (Process S ≈ ${sPct}%): 10–20 min of grogginess. Earlier bedtime or one more cycle would help.`
    : `Elevated inertia risk (Process S ≈ ${sPct}%): wake cuts into deep/REM sleep. Earlier bedtime is the primary fix.`

  const summary = `Based on ${p.dataPoints} nights, optimal window is ${p.rangeStart}–${p.rangeEnd} — the latest of: (1) your ${p.sleepNeedH.toFixed(1)}-hour sleep need, (2) circadian wake-zone onset, (3) your established schedule. Not a universal time — calibrated to your data.`

  return { sleepDebt, circadianAlignment, consistency, inertiaRisk, summary }
}

// ─── Main Prediction ─────────────────────────────────────────────────────────

export async function predictOptimalWakeTime(
  sessions: SleepSession[],
  input?: WakePredictionInput,
): Promise<WakePredictionResult | null> {
  if (sessions.length < MIN_NIGHTS) return null

  const isWorkday = input?.isWorkday ?? _isWorkday(input?.currentDate ?? new Date())

  const sleepNeedH  = await getCanonicalSleepNeed()
  const debtResult  = calculateSleepDebt(sessions, sleepNeedH)
  const chronotype  = detectChronotype(sessions)
  const jetLag      = calculateSocialJetLag(sessions)
  const sri         = calcSRI(sessions)

  const wakeHours  = sessions.map(s => parseTimeToHours(s.sleepEnd))
  const onsetHours = sessions.map(s => parseTimeToHours(s.sleepStart))

  const habitualWakeH  = circularMean(wakeHours)
  const habitualOnsetH = circularMean(onsetHours)
  const wakeStdDevH    = circularStdDev(wakeHours)

  const avgLatencyMin = sessions.slice(0, 7)
    .reduce((s, sess) => s + (sess.sleepLatency || 15), 0) / Math.min(7, sessions.length)

  const projectedOnsetH   = habitualOnsetH
  const actualSleepStartH = normalizeHour(projectedOnsetH + avgLatencyMin / 60)

  const msfsc = chronotype.msfsc
  const dlmoH = estimateDLMO(msfsc)
  const prcH  = await estimatePRCShift()

  // Three floors
  const floor1 = normalizeHour(actualSleepStartH + sleepNeedH)
  const floor2  = normalizeHour(msfsc + CIRC_OFFSET_H - prcH)
  const consistencyTolH = Math.min(1.0, wakeStdDevH * 1.5)
  const floor3  = normalizeHour(habitualWakeH - consistencyTolH)

  const { hour: baseWakeH, index: bindingIdx } = circularLatest(
    [floor1, floor2, floor3], actualSleepStartH
  )
  const FLOOR_NAMES = ['sleep_need', 'circadian', 'consistency'] as const
  const bindingFloor = FLOOR_NAMES[bindingIdx]

  let finalWakeH = normalizeHour(baseWakeH + debtAdjH(debtResult.currentDebt) + await grogginessAdjH())

  // Workday cap
  if (isWorkday && jetLag.jetLagHours >= 1.0 && jetLag.weekdayMidSleep > 0) {
    const cap = normalizeHour(jetLag.weekdayMidSleep + sleepNeedH / 2 + 0.5)
    if (hoursAfterRef(finalWakeH, cap) < 0) finalWakeH = cap
  }

  // Cycle alignment (40% blend)
  const cycleWakes = getCycleAlignedWakes(projectedOnsetH, avgLatencyMin)
  let bestCycleH = finalWakeH, minDist = Infinity
  for (const cw of cycleWakes) {
    const cwH = parseTimeToHours(cw)
    const d   = circDist(cwH, finalWakeH)
    if (d < minDist && d <= CYCLE_SNAP_H) { minDist = d; bestCycleH = cwH }
  }
  if (minDist <= CYCLE_SNAP_H) {
    const ω = (2 * Math.PI) / 24
    const sin = 0.6 * Math.sin(finalWakeH * ω) + 0.4 * Math.sin(bestCycleH * ω)
    const cos = 0.6 * Math.cos(finalWakeH * ω) + 0.4 * Math.cos(bestCycleH * ω)
    finalWakeH = normalizeHour(Math.atan2(sin, cos) / ω)
  }

  // Process S
  const sAtOnset = estimateSAtSleepOnset(habitualWakeH, habitualOnsetH)
  const sleepDurH = hoursAfterRef(actualSleepStartH, finalWakeH)
  const sAtWake   = processSAfterSleep(sAtOnset, Math.max(0, sleepDurH))

  const inertiaRisk: 'low' | 'medium' | 'high' =
    sAtWake >= INERTIA_HIGH_S ? 'high' :
    sAtWake >= INERTIA_MED_S  ? 'medium' : 'low'

  const { score: confScore, level: confLevel } = calcConfidence(
    sessions.length, sri, jetLag.jetLagHours,
    wakeStdDevH, chronotype.chronotype, debtResult.currentDebt
  )

  const halfW       = confLevel === 'high' ? 0.25 : confLevel === 'medium' ? 0.375 : 0.5
  const rangeStartH = normalizeHour(finalWakeH - halfW)
  const rangeEndH   = normalizeHour(finalWakeH + halfW)

  // Data quality (mobile: max wearable_actigraphy — no full biomarker tier)
  const hasStages   = sessions.filter(s => s.deepSleep > 0 || s.remSleep > 0).length > sessions.length * 0.5
  const dataQuality: WakePredictionResult['dataQuality'] = hasStages ? 'wearable_actigraphy' : 'phone_only'

  const explanation = buildExplanation({
    debtH: debtResult.currentDebt,
    debtCategory: debtResult.debtCategory,
    sleepNeedH, dlmoH, wakeStdDevH, sri,
    jetLagH: jetLag.jetLagHours, sAtWake, inertiaRisk,
    rangeStart: fmtHour(rangeStartH),
    rangeEnd:   fmtHour(rangeEndH),
    dataPoints: sessions.length, prcH,
    chronotype: chronotype.chronotype, bindingFloor,
  })

  return {
    rangeStart:   fmtHour(rangeStartH),
    rangeEnd:     fmtHour(rangeEndH),
    optimalPoint: fmtHour(finalWakeH),
    confidence:   confLevel,
    confidenceScore: confScore,
    explanation,
    signals: {
      estimatedDLMO:             fmtHour(dlmoH),
      processSAtPredictedWake:   parseFloat(sAtWake.toFixed(3)),
      sleepDebtHours:            debtResult.currentDebt,
      sleepNeedHours:            sleepNeedH,
      chronotype:                chronotype.label,
      sleepRegularityIndex:      sri,
      habitualWakeTime:          fmtHour(habitualWakeH),
      habitualSleepOnset:        fmtHour(habitualOnsetH),
      estimatedMSFsc:            fmtHour(msfsc),
      socialJetLagHours:         jetLag.jetLagHours,
      dataPoints:                sessions.length,
      prcAdjustmentMinutes:      Math.round(prcH * 60),
      inertiaRisk,
      cycleAlignedWakes:         cycleWakes,
      bindingFloor,
    },
    dataQuality,
    disclaimer: dataQuality === 'wearable_actigraphy'
      ? 'Uses Apple Watch sleep stages. Uncertainty ±15–30 min. Consumer wearable stage accuracy is ~70–80% vs polysomnography.'
      : 'Based on sleep timing only. Uncertainty ±30–45 min. Apple Watch data improves accuracy significantly.',
  }
}

function _isWorkday(date: Date): boolean {
  const d = date.getDay()
  return d >= 1 && d <= 5
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export async function saveWakePrediction(
  result: WakePredictionResult,
  dateStr?: string,
): Promise<void> {
  try {
    const db   = await getDb()
    const date = dateStr ?? new Date().toISOString().split('T')[0]
    const record: WakePredictionRecord = {
      date,
      predictedRangeStart: result.rangeStart,
      predictedRangeEnd:   result.rangeEnd,
      optimalPoint:        result.optimalPoint,
      confidence:          result.confidence,
      confidenceScore:     result.confidenceScore,
      bindingFloor:        result.signals.bindingFloor,
    }
    db.runSync(
      `INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
       VALUES ('wake_prediction', ?, ?, 'wake-prediction-model')`,
      [date, JSON.stringify(record)]
    )
  } catch (err) {
    console.error('[wake-prediction] save failed:', err)
  }
}

export async function recordWakeOutcome(params: {
  date: string
  actualWakeTime: string
  grogginessRating?: number
  energyRating?: number
  minutesToAlertAfterWake?: number
  snoozed?: boolean
}): Promise<void> {
  try {
    const db = await getDb()
    const rows: Array<{ value_json: string }> = db.getAllSync(
      `SELECT value_json FROM health_metrics WHERE metric_type = 'wake_prediction' AND date = ?`,
      [params.date]
    )
    if (!rows.length) return

    const record: WakePredictionRecord = JSON.parse(rows[0].value_json)
    record.actualWakeTime          = params.actualWakeTime
    record.grogginessRating        = params.grogginessRating
    record.energyRating            = params.energyRating
    record.minutesToAlertAfterWake = params.minutesToAlertAfterWake
    record.snoozed                 = params.snoozed

    db.runSync(
      `UPDATE health_metrics SET value_json = ? WHERE metric_type = 'wake_prediction' AND date = ?`,
      [JSON.stringify(record), params.date]
    )
  } catch (err) {
    console.error('[wake-prediction] recordOutcome failed:', err)
  }
}

export async function validateWakePredictions(days: number = 30): Promise<WakePredictionValidation | null> {
  try {
    const db = await getDb()
    const rows: Array<{ value_json: string }> = db.getAllSync(
      `SELECT value_json FROM health_metrics
       WHERE metric_type = 'wake_prediction'
       ORDER BY date DESC LIMIT ?`,
      [days]
    )
    if (rows.length < 3) return null

    const records = rows.map(r => JSON.parse(r.value_json) as WakePredictionRecord)
    const withOutcomes = records.filter(r => r.actualWakeTime)

    const breakdown: Record<string, number> = {}
    for (const r of records) {
      const f = r.bindingFloor ?? 'unknown'
      breakdown[f] = (breakdown[f] ?? 0) + 1
    }

    if (withOutcomes.length < 3) {
      return {
        totalPredictions: records.length, withOutcomes: 0,
        avgErrorMinutes: 0, pctWithinRange: 0,
        avgGrogginessInRange: 0, avgGrogginessOutRange: 0,
        snoozedPct: 0, bindingFloorBreakdown: breakdown,
        verdict: `${records.length} predictions saved but no outcomes recorded yet.`,
      }
    }

    let errMin = 0, inRange = 0
    let grogIn = 0, grogInN = 0, grogOut = 0, grogOutN = 0, snoozed = 0

    for (const r of withOutcomes) {
      const actualH = parseTimeToHours(r.actualWakeTime!)
      errMin += circDist(actualH, parseTimeToHours(r.optimalPoint)) * 60

      const sH = parseTimeToHours(r.predictedRangeStart)
      const eH = parseTimeToHours(r.predictedRangeEnd)
      const inR = sH <= eH ? actualH >= sH && actualH <= eH : actualH >= sH || actualH <= eH

      if (inR) {
        inRange++
        if (r.grogginessRating) { grogIn += r.grogginessRating; grogInN++ }
      } else {
        if (r.grogginessRating) { grogOut += r.grogginessRating; grogOutN++ }
      }
      if (r.snoozed) snoozed++
    }

    const n = withOutcomes.length
    const pct = (inRange / n) * 100
    const avgGrogIn = grogInN > 0 ? grogIn / grogInN : 0
    const avgGrogOt = grogOutN > 0 ? grogOut / grogOutN : 0

    let verdict = pct >= 70
      ? `Good: ${pct.toFixed(0)}% of wake times within predicted window.`
      : pct >= 50
      ? `Moderate: ${pct.toFixed(0)}% within range. Consistent scheduling will improve this.`
      : `Below target: ${pct.toFixed(0)}% within range. External alarms or schedule variability may be overriding natural wake.`

    if (avgGrogIn > 0 && avgGrogOt > 0 && avgGrogIn < avgGrogOt)
      verdict += ` In-range wakes had ${(avgGrogOt - avgGrogIn).toFixed(1)} pts lower grogginess.`

    return {
      totalPredictions: records.length, withOutcomes: n,
      avgErrorMinutes: parseFloat((errMin / n).toFixed(1)),
      pctWithinRange: parseFloat(pct.toFixed(1)),
      avgGrogginessInRange: parseFloat(avgGrogIn.toFixed(2)),
      avgGrogginessOutRange: parseFloat(avgGrogOt.toFixed(2)),
      snoozedPct: parseFloat(((snoozed / n) * 100).toFixed(1)),
      bindingFloorBreakdown: breakdown,
      verdict,
    }
  } catch (err) {
    console.error('[wake-prediction] validateWakePredictions failed:', err)
    return null
  }
}
