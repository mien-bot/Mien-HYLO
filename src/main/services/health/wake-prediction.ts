/**
 * Sleep/Wake Prediction Model — Two-Process Model + "Latest Of" Formulation
 *
 * The predicted wake window is the LATEST of three independent lower bounds:
 *   Floor 1 — Sleep need:    earliest wake that satisfies the person's full sleep need
 *   Floor 2 — Circadian:     earliest wake the body clock can support alertness
 *   Floor 3 — Consistency:   earliest wake within the established behavioral window
 *
 * Whichever floor is most restrictive sets the base. Adjustments are then applied:
 *   + Sleep debt bonus       (more debt → push later: body needs recovery)
 *   + Grogginess feedback    (self-correcting loop from reported outcomes)
 *   Workday cap              (soft ceiling on free-day drift for work schedules)
 *
 * Output is a window (range), not a single minute. Window width reflects confidence:
 *   High confidence  → ±15 min   Low confidence → ±30 min
 *
 * Circadian phase estimation (Roenneberg et al. 2012):
 *   MSFsc (mid-sleep on free days, sleep-corrected) ≈ CBTmin
 *   DLMO ≈ MSFsc − 7h   |   Circadian wake-zone onset ≈ MSFsc + 1h
 *   Without lab DLMO, all phase estimates carry ±1–2h uncertainty.
 *
 * Process S (Borbély 1982; Daan et al. 1984):
 *   τ_s = 4.2h (dissipation during sleep), τ_w = 18.2h (build-up during wake)
 *   S at wake determines inertia risk — lower S = faster cortical re-activation.
 *
 * Light PRC (Kronauer et al. 1999; St. Hilaire et al. 2007):
 *   Morning bright light → phase advance (earlier wake)
 *   Evening bright light → phase delay (later wake)
 *
 * Consumer wearable limitations (de Zambotti et al. 2019):
 *   Stage classification ~70–80% PSG agreement. Estimates, not measurements.
 *
 * References:
 *   Borbély (1982) Hum Neurobiol — two-process model.
 *   Daan et al. (1984) Am J Physiol — timing of human sleep.
 *   Roenneberg et al. (2012) Curr Biol — social jet lag and chronotype.
 *   Van Dongen et al. (2003) Sleep — cumulative cost of additional wakefulness.
 *   Kronauer et al. (1999) J Biol Rhythms — light PRC.
 *   de Zambotti et al. (2019) Med Sci Sports Exerc — wearable limitations.
 */

import { getDb } from '../../db/database'
import {
  parseSleepSessions,
  getCanonicalSleepNeed,
  calculateSleepDebt,
  detectChronotype,
  calculateSocialJetLag,
  calculateSleepRegularityIndex,
  calculateHrvRecovery,
  scoreSleepQuality,
  calculateRecoveryReadiness,
  predictCircadianRhythm,
} from './sleep-analysis'
import type { SleepSession } from './sleep-analysis'
import { calculateRecovery } from './fitness-analysis'

// ─── Borbély Constants ───────────────────────────────────────────────────────
const TAU_S = 4.2 // sleep dissipation time constant (hours)
const TAU_W = 18.2 // wake build-up time constant (hours)
const S_UPPER = 1.0
const S_LOWER = 0.17

// S-at-wake thresholds → inertia risk
const INERTIA_HIGH_S = 0.55
const INERTIA_MED_S = 0.38

// ─── Algorithm Config ────────────────────────────────────────────────────────
const MIN_NIGHTS = 5 // minimum sessions for any prediction
const SLEEP_CYCLE_H = 1.5 // 90-minute cycles
const CYCLE_SNAP_WINDOW_H = 0.75 // only snap to cycle end if within ±45 min
const PRC_MORNING_MAX_H = 1.0 // max advance from morning light
const PRC_EVENING_MAX_H = 1.2 // max delay from evening light
const CIRC_FLOOR_OFFSET_H = 1.0 // CBTmin + this = circadian wake-zone onset

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WakePredictionInput {
  recentSleepDays?: number // nights of history (default 21)
  isWorkday?: boolean // influences social-schedule cap
  currentDate?: Date
  plannedBedtime?: string // HH:MM or flexible time string for calculator scenarios
  sleepLatencyMinutes?: number
}

export interface WakePredictionResult {
  rangeStart: string // HH:MM 24-hour
  rangeEnd: string
  optimalPoint: string // midpoint
  confidence: 'low' | 'medium' | 'high'
  confidenceScore: number // 0–100

  explanation: {
    sleepDebt: string
    circadianAlignment: string
    consistency: string
    inertiaRisk: string
    summary: string
  }

  signals: {
    /** Estimated DLMO — behavioral estimate, not lab measurement */
    estimatedDLMO: string
    processSAtPredictedWake: number // 0–1, lower = less inertia
    sleepDebtHours: number
    sleepNeedHours: number
    chronotype: string
    sleepRegularityIndex: number
    habitualWakeTime: string
    habitualSleepOnset: string
    estimatedMSFsc: string
    socialJetLagHours: number
    dataPoints: number
    prcAdjustmentMinutes: number // + = advance, − = delay
    inertiaRisk: 'low' | 'medium' | 'high'
    cycleAlignedWakes: string[] // end-of-cycle times for reference
    /** Which floor was binding: 'sleep_need' | 'circadian' | 'consistency' */
    bindingFloor: 'sleep_need' | 'circadian' | 'consistency'
    /** Training-adjusted extra sleep hours (Fullagar et al. 2015) */
    trainingAdjustmentHours: number
    /** HRV z-score vs 30-day baseline (autonomic recovery proxy) */
    hrvZScore: number
    /** Recovery readiness score (0–100, weighted sleep/HRV/exercise) */
    recoveryScore: number
    /** Average sleep quality score for last 3 nights (0–100) */
    recentSleepQuality: number
  }

  dataQuality: 'phone_only' | 'wearable_actigraphy' | 'full_biomarker'
  disclaimer: string
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

function formatHour(h: number): string {
  const n = normalizeHour(h)
  const hr = Math.floor(n)
  const mn = Math.round((n - hr) * 60)
  if (mn === 60) return `${String((hr + 1) % 24).padStart(2, '0')}:00`
  return `${String(hr).padStart(2, '0')}:${String(mn).padStart(2, '0')}`
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
  const diffs = hours.map((h) => {
    let d = h - mean
    if (d > 12) d -= 24
    if (d < -12) d += 24
    return d
  })
  return Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length)
}

/** Unsigned circular distance between two hour values (0–12). */
function circDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 24
  return d > 12 ? 24 - d : d
}

/**
 * "Hours after reference" — converts circular hour to a signed offset from ref.
 * Assumes the result is within [-4h, +20h] of ref (valid for sleep/wake pairs).
 */
function hoursAfterRef(ref: number, t: number): number {
  let diff = normalizeHour(t - ref)
  // If diff > 20, the candidate is actually slightly before ref in real time
  if (diff > 20) diff -= 24
  return diff
}

/**
 * Return the LATEST of a set of candidate hours, judged relative to a reference
 * point (typically projected sleep onset). All candidates are expected within
 * [ref + 4h, ref + 14h] — i.e., a plausible wake window after sleeping.
 */
function circularLatest(candidates: number[], refH: number): { hour: number; index: number } {
  let latestIdx = 0
  let latestOffset = hoursAfterRef(refH, candidates[0])
  for (let i = 1; i < candidates.length; i++) {
    const off = hoursAfterRef(refH, candidates[i])
    if (off > latestOffset) {
      latestOffset = off
      latestIdx = i
    }
  }
  return { hour: candidates[latestIdx], index: latestIdx }
}

// ─── Process S ───────────────────────────────────────────────────────────────

function processSAfterSleep(sOnset: number, durationH: number): number {
  return S_LOWER + (sOnset - S_LOWER) * Math.exp(-durationH / TAU_S)
}

function processSAfterWake(sWake: number, tH: number): number {
  return S_UPPER - (S_UPPER - sWake) * Math.exp(-tH / TAU_W)
}

/** Estimate S at habitual sleep onset, starting from a rested state at wake. */
function estimateSAtSleepOnset(habitualWakeH: number, habitualSleepH: number): number {
  const hoursAwake = normalizeHour(habitualSleepH - habitualWakeH + 24) || 16
  return processSAfterWake(0.28, hoursAwake) // 0.28 = S after adequate sleep
}

// ─── Phase Estimation ────────────────────────────────────────────────────────

/** DLMO estimate: Roenneberg 2012 — DLMO ≈ MSFsc − 7h. */
function estimatedDLMO(msfsc: number): number {
  return normalizeHour(msfsc - 7)
}

/**
 * Estimate net PRC shift from light exposure records (if available).
 * Returns hours: positive = phase advance (earlier wake), negative = delay.
 * Falls back to +0.1h (mild morning light assumption) when no data exists.
 */
function estimatePRCShift(_sessions: SleepSession[]): number {
  try {
    const db = getDb()
    const rows = db
      .prepare(
        `
      SELECT value_json FROM health_metrics
      WHERE metric_type = 'light_exposure'
      ORDER BY date DESC LIMIT 14
    `,
      )
      .all() as Array<{ value_json: string }>

    if (rows.length < 3) return 0.1

    let total = 0
    for (const row of rows) {
      const d = JSON.parse(row.value_json)
      const morningLux: number = d.morning_lux ?? d.morningLux ?? 0
      const eveningLux: number = d.evening_lux ?? d.eveningLux ?? 0
      if (morningLux > 100) total += PRC_MORNING_MAX_H * Math.min(1, morningLux / 10_000) * 0.3
      if (eveningLux > 50) total -= PRC_EVENING_MAX_H * Math.min(1, eveningLux / 1_000) * 0.3
    }
    return total / rows.length
  } catch {
    return 0.1
  }
}

// ─── Sleep Cycle Alignment ───────────────────────────────────────────────────

function getCycleAlignedWakes(sleepOnsetH: number, latencyMin: number): string[] {
  const sleepStartH = normalizeHour(sleepOnsetH + latencyMin / 60)
  return [4, 5, 6, 7].map((n) => formatHour(normalizeHour(sleepStartH + n * SLEEP_CYCLE_H)))
}

// ─── Adjustments ─────────────────────────────────────────────────────────────

/** Sleep debt pushes the base window later — a heavily indebted sleeper benefits
 *  from extra time even if circadian phase would otherwise allow earlier waking. */
function debtAdjustmentH(debtHours: number): number {
  if (debtHours > 10) return 0.5
  if (debtHours > 5) return 0.25
  if (debtHours > 2) return 0.1
  return 0
}

/**
 * Self-correcting grogginess feedback.
 * Reads the last 5–7 stored wake_prediction records that have outcome data.
 * If recent wake-ups were consistently groggy (>3.5/5), push prediction later.
 * If consistently alert (≤2/5), allow a small pull earlier.
 */
function grogginessAdjustmentH(): number {
  try {
    const db = getDb()
    const rows = db
      .prepare(
        `
      SELECT value_json FROM health_metrics
      WHERE metric_type = 'wake_prediction'
      ORDER BY date DESC LIMIT 7
    `,
      )
      .all() as Array<{ value_json: string }>

    const withRatings = rows
      .map(
        (r) =>
          JSON.parse(r.value_json) as {
            grogginessRating?: number
            predictedRangeStart?: string
            predictedRangeEnd?: string
            actualWakeTime?: string
          },
      )
      .filter((r) => typeof r.grogginessRating === 'number' && r.actualWakeTime)

    if (withRatings.length < 3) return 0

    const avgGrog = withRatings.reduce((s, r) => s + r.grogginessRating!, 0) / withRatings.length

    if (avgGrog > 3.5) return 0.25 // consistently groggy → push 15 min later
    if (avgGrog < 2.0) return -0.17 // consistently alert  → allow 10 min earlier
    return 0
  } catch {
    return 0
  }
}

// ─── Confidence ──────────────────────────────────────────────────────────────

function calcConfidence(
  dataPoints: number,
  sri: number,
  jetLagH: number,
  wakeStdDevH: number,
  chronotype: string,
  debtH: number,
  recoveryScore: number = 50,
  recentQualityAvg: number = 50,
): { score: number; level: 'low' | 'medium' | 'high' } {
  let s = 0
  // Data quantity            (0–25)
  s += dataPoints >= 21 ? 25 : dataPoints >= 14 ? 18 : dataPoints >= 7 ? 10 : 3
  // Sleep Regularity Index   (0–20)
  s += sri >= 90 ? 20 : sri >= 80 ? 16 : sri >= 70 ? 11 : sri >= 60 ? 6 : 2
  // Wake-time consistency    (0–15)
  s += wakeStdDevH <= 0.25 ? 15 : wakeStdDevH <= 0.5 ? 11 : wakeStdDevH <= 1.0 ? 6 : 1
  // Social jet lag           (0–10)
  s += jetLagH < 0.5 ? 10 : jetLagH < 1.0 ? 7 : jetLagH < 2.0 ? 3 : 0
  // Chronotype clarity       (0–8)
  s += chronotype !== 'dolphin' ? 8 : 2
  // Recovery readiness       (0–12) — low recovery = more uncertainty
  s += recoveryScore >= 75 ? 12 : recoveryScore >= 55 ? 8 : recoveryScore >= 35 ? 4 : 0
  // Recent sleep quality     (0–10) — poor recent quality = less predictable
  s += recentQualityAvg >= 75 ? 10 : recentQualityAvg >= 55 ? 7 : recentQualityAvg >= 35 ? 3 : 0
  // Severe debt widens uncertainty
  if (debtH > 10) s -= 5

  const score = Math.max(0, Math.min(100, s))
  return { score, level: score >= 65 ? 'high' : score >= 35 ? 'medium' : 'low' }
}

// ─── Explanation ─────────────────────────────────────────────────────────────

function buildExplanation(p: {
  debtH: number
  debtCategory: string
  sleepNeedH: number
  dlmoH: number
  habitualWakeH: number
  wakeStdDevH: number
  sri: number
  jetLagH: number
  sAtWake: number
  inertiaRisk: 'low' | 'medium' | 'high'
  rangeStart: string
  rangeEnd: string
  dataPoints: number
  prcH: number
  chronotype: string
  bindingFloor: 'sleep_need' | 'circadian' | 'consistency'
  trainingAdjH?: number
  hrvZScore?: number
  recoveryScore?: number
  recentQualityAvg?: number
}): WakePredictionResult['explanation'] {
  // Sleep debt
  let sleepDebt: string
  if (p.debtH < 1) {
    sleepDebt = `You are well-rested — less than 1 hour of accumulated sleep debt over the past 14 nights. Your body is operating near its baseline need of ${p.sleepNeedH.toFixed(1)} hours.`
  } else if (p.debtCategory === 'low') {
    sleepDebt = `A modest ${p.debtH.toFixed(1)}-hour sleep debt has built up over the past 14 nights — a small daily shortfall against your estimated ${p.sleepNeedH.toFixed(1)}-hour need. The predicted window is shifted slightly later to allow recovery time.`
  } else if (p.debtCategory === 'moderate') {
    sleepDebt = `Accumulated debt of ${p.debtH.toFixed(1)} hours is enough to measurably impair alertness and reaction time (Van Dongen et al. 2003). Recovery requires consistently earlier bedtimes, not one long sleep. The prediction reflects the added recovery margin needed.`
  } else {
    sleepDebt = `Significant sleep debt: ${p.debtH.toFixed(1)} hours. At this level, perceived sleepiness underestimates true performance impairment. Sustained recovery — earlier bedtimes over 1–2 weeks — is the only effective remedy. The predicted window is adjusted accordingly.`
  }

  // Circadian alignment
  const dlmoFmt = formatHour(p.dlmoH)
  const ctLabel = p.chronotype.charAt(0).toUpperCase() + p.chronotype.slice(1)
  const prcNote =
    p.prcH > 0.1
      ? ` Morning light is advancing your clock by an estimated ~${Math.round(p.prcH * 60)} min.`
      : p.prcH < -0.1
        ? ` Evening light is delaying your clock by an estimated ~${Math.round(Math.abs(p.prcH) * 60)} min.`
        : ''

  const floorNote =
    p.bindingFloor === 'circadian'
      ? 'The circadian floor is binding — your body clock is the limiting factor, not sleep duration.'
      : p.bindingFloor === 'sleep_need'
        ? 'Sleep need is the binding constraint — full sleep duration must be met first.'
        : 'Your established wake pattern is the binding constraint, anchoring the window to your schedule.'

  const circadianAlignment = `Chronotype: ${ctLabel}. Estimated DLMO around ${dlmoFmt} (behavioral estimate — not a lab measurement; ±1–2h uncertainty without direct assay). The circadian wake-zone onset is ~1h after your CBT minimum, which is when your body clock begins actively supporting alertness. ${floorNote}${prcNote}`

  // Consistency
  const stdMin = Math.round(p.wakeStdDevH * 60)
  let consistency: string
  if (p.sri >= 85 && stdMin <= 20) {
    consistency = `Excellent regularity: wake times fall within ±${stdMin} min (Sleep Regularity Index ${p.sri}/100). This tight schedule strengthens circadian entrainment and raises prediction confidence.`
  } else if (p.jetLagH >= 1) {
    consistency = `Social jet lag of ${p.jetLagH.toFixed(1)}h detected — your weekend sleep runs ${p.jetLagH.toFixed(1)} hours later than weekdays. This chronic misalignment widens prediction uncertainty. Bringing weekend wake within 30–45 min of your weekday time would significantly improve model accuracy over 2–3 weeks.`
  } else if (p.wakeStdDevH <= 0.5) {
    consistency = `Good consistency: wake times vary ±${stdMin} min (SRI ${p.sri}/100). Maintaining this on weekends too would narrow the predicted window.`
  } else {
    consistency = `Moderate consistency: ±${stdMin} min wake-time variance (SRI ${p.sri}/100). A more regular 7-day schedule would materially improve confidence.`
  }

  // Inertia risk
  const sPct = (p.sAtWake * 100).toFixed(0)
  const hrvNote =
    p.hrvZScore != null && Math.abs(p.hrvZScore) > 0.5
      ? p.hrvZScore > 0
        ? ` HRV is above baseline (z=${p.hrvZScore.toFixed(1)}), indicating good autonomic recovery — this reduces inertia risk.`
        : ` HRV is below baseline (z=${p.hrvZScore.toFixed(1)}), suggesting incomplete autonomic recovery — expect slower wake-up.`
      : ''
  let inertiaRisk: string
  if (p.inertiaRisk === 'low') {
    inertiaRisk = `Low inertia risk: the window aligns near the end of a 90-min sleep cycle when homeostatic pressure (Process S ≈ ${sPct}% of maximum) is near its overnight trough. Lighter sleep stages at this point mean faster cortical re-activation.${hrvNote}`
  } else if (p.inertiaRisk === 'medium') {
    inertiaRisk = `Moderate inertia risk (Process S ≈ ${sPct}%): expect 10–20 min of grogginess. Shifting bedtime 30 min earlier, or sleeping through one more 90-min cycle, would lower this.${hrvNote}`
  } else {
    inertiaRisk = `Elevated inertia risk (Process S ≈ ${sPct}%): the window falls earlier than natural sleep completion, likely due to sleep debt cutting into a deep or REM cycle. Expect 20–45 min of grogginess. An earlier bedtime is the most effective intervention; 0.5 mg melatonin 2h before your desired bedtime can also help advance your schedule.${hrvNote}`
  }

  // Training context
  const trainingNote =
    p.trainingAdjH && p.trainingAdjH > 0.1
      ? ` Training load adds +${Math.round(p.trainingAdjH * 60)} min to your sleep need (Fullagar et al. 2015).`
      : ''
  const recoveryNote =
    p.recoveryScore != null && p.recoveryScore < 40
      ? ` Recovery readiness is low (${p.recoveryScore}/100) — prioritize extra sleep.`
      : ''
  const qualityNote =
    p.recentQualityAvg != null && p.recentQualityAvg < 40
      ? ` Recent sleep quality has been poor (${Math.round(p.recentQualityAvg)}/100) — deeper sleep would improve prediction accuracy.`
      : ''

  // Summary
  const summary = `Based on ${p.dataPoints} nights of data, the optimal wake window is ${p.rangeStart}–${p.rangeEnd}. This is the latest of: (1) time to meet your ${p.sleepNeedH.toFixed(1)}-hour sleep need, (2) when your body clock supports alertness, and (3) your established wake pattern. It is not a universal "best" — it is calibrated to your history and updated as new data arrives.${trainingNote}${recoveryNote}${qualityNote}`

  return { sleepDebt, circadianAlignment, consistency, inertiaRisk, summary }
}

// ─── Main Prediction ─────────────────────────────────────────────────────────

export function predictOptimalWakeTime(input?: WakePredictionInput): WakePredictionResult | null {
  const days = input?.recentSleepDays ?? 21
  const isWorkday = input?.isWorkday ?? _isWorkday(input?.currentDate ?? new Date())

  const sessions = parseSleepSessions(days)
  if (sessions.length < MIN_NIGHTS) return null

  // ── Baseline signals ──────────────────────────────────────────────────────
  const debtResult = calculateSleepDebt(sessions)
  const chronotype = detectChronotype(sessions)
  const jetLag = calculateSocialJetLag(sessions)
  const sriResult = calculateSleepRegularityIndex(sessions)
  const baseSleepNeedH = getCanonicalSleepNeed()

  // ── Training-adjusted sleep need (Fullagar et al. 2015) ─────────────────
  // Heavy training increases sleep need by up to +2h for recovery.
  let trainingAdjH = 0
  try {
    const recovery = calculateRecovery(30)
    if (recovery.sleepRecommendation?.trainingAdjustment > 0) {
      trainingAdjH = Math.min(2.0, recovery.sleepRecommendation.trainingAdjustment)
    }
  } catch {
    /* fitness data unavailable — no adjustment */
  }

  const sleepNeedH = baseSleepNeedH + trainingAdjH

  // ── HRV recovery (autonomic readiness) ──────────────────────────────────
  let hrvZScore = 0
  try {
    const hrv = calculateHrvRecovery()
    if (hrv) hrvZScore = hrv.zScore
  } catch {
    /* HRV data unavailable */
  }

  // ── Recent sleep quality (last 3 nights) ────────────────────────────────
  let recentQualityAvg = 50
  try {
    const recent = sessions.slice(0, 3)
    if (recent.length >= 2) {
      const scores = recent.map((s) => scoreSleepQuality(s, sessions).overall)
      recentQualityAvg = scores.reduce((a, b) => a + b, 0) / scores.length
    }
  } catch {
    /* quality scoring failed */
  }

  // ── Recovery readiness ──────────────────────────────────────────────────
  let recoveryScore = 50
  try {
    const rr = calculateRecoveryReadiness()
    recoveryScore = rr.score
  } catch {
    /* recovery data unavailable */
  }

  const wakeHours = sessions.map((s) => parseTimeToHours(s.sleepEnd))
  const onsetHours = sessions.map((s) => parseTimeToHours(s.sleepStart))

  const habitualWakeH = circularMean(wakeHours)
  const habitualOnsetH = circularMean(onsetHours)
  const wakeStdDevH = circularStdDev(wakeHours)
  const sri = sriResult?.sri ?? 50

  const avgLatencyMin = Number.isFinite(input?.sleepLatencyMinutes)
    ? Math.max(0, Math.min(180, input?.sleepLatencyMinutes as number))
    : sessions.slice(0, 7).reduce((s, sess) => s + (sess.sleepLatency || 15), 0) /
      Math.min(7, sessions.length)

  // Projected sleep onset and actual sleep start (after latency)
  const plannedBedtimeH = input?.plannedBedtime ? parseTimeToHours(input.plannedBedtime) : null
  const projectedOnsetH = plannedBedtimeH == null ? habitualOnsetH : plannedBedtimeH
  const actualSleepStartH = normalizeHour(projectedOnsetH + avgLatencyMin / 60)

  // ── Circadian phase ───────────────────────────────────────────────────────
  const msfsc = chronotype.msfsc
  const dlmoH = estimatedDLMO(msfsc)
  const prcH = estimatePRCShift(sessions)

  // ── Three independent floors ──────────────────────────────────────────────

  // Floor 1: Sleep need must be satisfied
  const floor1 = normalizeHour(actualSleepStartH + sleepNeedH)

  // Floor 2: Circadian alerting must be adequate
  // CBTmin ≈ MSFsc; circadian wake-zone onset ≈ CBTmin + CIRC_FLOOR_OFFSET_H
  // PRC shift: positive (advance) = earlier floor → subtract
  const floor2 = normalizeHour(msfsc + CIRC_FLOOR_OFFSET_H - prcH)

  // Floor 3: Within established behavioral wake window
  // Tolerance: up to 1h before habitual mean (capped by stdDev × 1.5)
  // When a specific bedtime is provided, shift the floor proportionally —
  // going to bed earlier should allow waking earlier.
  const consistencyTolH = Math.min(1.0, wakeStdDevH * 1.5)
  let floor3 = normalizeHour(habitualWakeH - consistencyTolH)
  if (plannedBedtimeH != null) {
    const bedtimeShiftH = hoursAfterRef(habitualOnsetH, projectedOnsetH)
    // Negative shift = earlier bedtime → earlier wake; positive = later → later wake
    // Only shift floor3 if the bedtime differs meaningfully (>15 min)
    if (Math.abs(bedtimeShiftH) > 0.25) {
      floor3 = normalizeHour(floor3 + bedtimeShiftH)
    }
  }

  // Base wake = latest of the three floors
  const { hour: baseWakeH, index: bindingIdx } = circularLatest(
    [floor1, floor2, floor3],
    actualSleepStartH,
  )
  const FLOOR_NAMES = ['sleep_need', 'circadian', 'consistency'] as const
  const bindingFloor = FLOOR_NAMES[bindingIdx]

  // ── Adjustments ───────────────────────────────────────────────────────────

  const debtAdjH = debtAdjustmentH(debtResult.currentDebt)
  const grogAdjH = grogginessAdjustmentH()

  let finalWakeH = normalizeHour(baseWakeH + debtAdjH + grogAdjH)

  // ── Social-schedule cap (workday ceiling) ─────────────────────────────────
  // On workdays, prevent circadian-floor drift from pushing prediction so late
  // it becomes impractical. Soft cap at weekday habitual wake + 30 min.
  if (isWorkday && jetLag.jetLagHours >= 1.0 && jetLag.weekdayMidSleep > 0) {
    // Estimate weekday habitual wake from weekday mid-sleep + half sleep need
    const weekdayWakeCap = normalizeHour(jetLag.weekdayMidSleep + sleepNeedH / 2 + 0.5)
    const cappedDiff = hoursAfterRef(finalWakeH, weekdayWakeCap)
    if (cappedDiff < 0) finalWakeH = weekdayWakeCap // finalWake exceeded cap
  }

  // ── Max sleep duration cap ───────────────────────────────────────────────
  // Prevent absurd predictions (e.g. 11h sleep) when consistency/circadian
  // floors drift far from the planned bedtime. Cap at sleepNeed + debt + 2h.
  if (plannedBedtimeH != null) {
    const maxSleepH = sleepNeedH + debtAdjH + 2.0
    const projectedSleepH = hoursAfterRef(actualSleepStartH, finalWakeH)
    if (projectedSleepH > maxSleepH) {
      finalWakeH = normalizeHour(actualSleepStartH + maxSleepH)
    }
  }

  // ── Sleep cycle alignment (blend, not hard snap) ──────────────────────────
  const cycleWakes = getCycleAlignedWakes(projectedOnsetH, avgLatencyMin)
  let bestCycleH = finalWakeH
  let minCycleDist = Infinity

  for (const cw of cycleWakes) {
    const cwH = parseTimeToHours(cw)
    const d = circDist(cwH, finalWakeH)
    if (d < minCycleDist && d <= CYCLE_SNAP_WINDOW_H) {
      minCycleDist = d
      bestCycleH = cwH
    }
  }

  // Weight: 60% adjusted base + 40% nearest cycle end (if within window)
  if (minCycleDist <= CYCLE_SNAP_WINDOW_H) {
    const ω = (2 * Math.PI) / 24
    const sin = 0.6 * Math.sin(finalWakeH * ω) + 0.4 * Math.sin(bestCycleH * ω)
    const cos = 0.6 * Math.cos(finalWakeH * ω) + 0.4 * Math.cos(bestCycleH * ω)
    finalWakeH = normalizeHour(Math.atan2(sin, cos) / ω)
  }

  // ── Process S at predicted wake → inertia risk ────────────────────────────
  // HRV z-score modulates inertia: high HRV (parasympathetic dominance) =
  // faster cortical re-activation; low HRV = sluggish autonomic recovery.
  const sAtOnset = estimateSAtSleepOnset(habitualWakeH, projectedOnsetH)
  const sleepDurH = hoursAfterRef(actualSleepStartH, finalWakeH)
  const sAtWake = processSAfterSleep(sAtOnset, Math.max(0, sleepDurH))

  // Shift effective S threshold by HRV: high HRV lowers apparent S (less groggy)
  const hrvInertiaShift = hrvZScore > 0.5 ? -0.05 : hrvZScore < -0.5 ? 0.05 : 0
  const effectiveS = sAtWake + hrvInertiaShift

  const inertiaRisk: 'low' | 'medium' | 'high' =
    effectiveS >= INERTIA_HIGH_S ? 'high' : effectiveS >= INERTIA_MED_S ? 'medium' : 'low'

  // ── Confidence & range width ──────────────────────────────────────────────
  const { score: confScore, level: confLevel } = calcConfidence(
    sessions.length,
    sri,
    jetLag.jetLagHours,
    wakeStdDevH,
    chronotype.chronotype,
    debtResult.currentDebt,
    recoveryScore,
    recentQualityAvg,
  )

  // ±15 min (high), ±22.5 min (medium), ±30 min (low)
  const halfW = confLevel === 'high' ? 0.25 : confLevel === 'medium' ? 0.375 : 0.5
  const rangeStartH = normalizeHour(finalWakeH - halfW)
  const rangeEndH = normalizeHour(finalWakeH + halfW)

  // ── Data quality tier ─────────────────────────────────────────────────────
  const hasStages =
    sessions.filter((s) => s.deepSleep > 0 || s.remSleep > 0).length > sessions.length * 0.5

  let dataQuality: WakePredictionResult['dataQuality'] = 'phone_only'
  try {
    const db = getDb()
    const hrvN =
      (
        db.prepare(`SELECT COUNT(*) c FROM health_metrics WHERE metric_type='hrv'`).get() as Record<
          string,
          unknown
        >
      )?.c ?? 0
    const tmpN =
      (
        db
          .prepare(
            `SELECT COUNT(*) c FROM health_metrics WHERE metric_type IN ('skin_temperature','body_temperature')`,
          )
          .get() as Record<string, unknown>
      )?.c ?? 0
    if (hasStages && hrvN > 7 && tmpN > 7) dataQuality = 'full_biomarker'
    else if (hasStages && hrvN > 7) dataQuality = 'wearable_actigraphy'
  } catch {
    /* non-fatal */
  }

  // ── Explanation ───────────────────────────────────────────────────────────
  const explanation = buildExplanation({
    debtH: debtResult.currentDebt,
    debtCategory: debtResult.debtCategory,
    sleepNeedH,
    dlmoH,
    habitualWakeH,
    wakeStdDevH,
    sri,
    jetLagH: jetLag.jetLagHours,
    sAtWake,
    inertiaRisk,
    rangeStart: formatHour(rangeStartH),
    rangeEnd: formatHour(rangeEndH),
    dataPoints: sessions.length,
    prcH,
    chronotype: chronotype.chronotype,
    bindingFloor,
    trainingAdjH,
    hrvZScore,
    recoveryScore,
    recentQualityAvg,
  })

  const disclaimer =
    dataQuality === 'phone_only'
      ? 'Based on sleep timing (start/end) only. Without wearable biomarkers, uncertainty is ±30–45 min. Apple Watch data improves accuracy significantly.'
      : dataQuality === 'wearable_actigraphy'
        ? 'Uses Apple Watch sleep stages + HRV. Uncertainty ±15–30 min. Consumer wearable stage accuracy is ~70–80% vs polysomnography (de Zambotti et al. 2019). Direct DLMO measurement would reduce uncertainty further.'
        : 'Uses sleep stages, HRV, and temperature. Uncertainty ±10–20 min. Saliva DLMO assay remains the gold standard for circadian phase.'

  return {
    rangeStart: formatHour(rangeStartH),
    rangeEnd: formatHour(rangeEndH),
    optimalPoint: formatHour(finalWakeH),
    confidence: confLevel,
    confidenceScore: confScore,
    explanation,
    signals: {
      estimatedDLMO: formatHour(dlmoH),
      processSAtPredictedWake: parseFloat(sAtWake.toFixed(3)),
      sleepDebtHours: debtResult.currentDebt,
      sleepNeedHours: sleepNeedH,
      chronotype: chronotype.label,
      sleepRegularityIndex: sri,
      habitualWakeTime: formatHour(habitualWakeH),
      habitualSleepOnset: formatHour(habitualOnsetH),
      estimatedMSFsc: formatHour(msfsc),
      socialJetLagHours: jetLag.jetLagHours,
      dataPoints: sessions.length,
      prcAdjustmentMinutes: Math.round(prcH * 60),
      inertiaRisk,
      cycleAlignedWakes: cycleWakes,
      bindingFloor,
      trainingAdjustmentHours: trainingAdjH,
      hrvZScore,
      recoveryScore,
      recentSleepQuality: recentQualityAvg,
    },
    dataQuality,
    disclaimer,
  }
}

function _isWorkday(date: Date): boolean {
  const d = date.getDay()
  return d >= 1 && d <= 5
}

// ─── Prediction Persistence ──────────────────────────────────────────────────

export interface WakePredictionRecord {
  date: string
  predictedRangeStart: string
  predictedRangeEnd: string
  optimalPoint: string
  confidence: string
  confidenceScore: number
  bindingFloor: string
  actualWakeTime?: string
  grogginessRating?: number // 1 (none) – 5 (severe)
  energyRating?: number // 1 (exhausted) – 5 (great)
  minutesToAlertAfterWake?: number // time-to-alertness proxy
  snoozed?: boolean
}

/** Persist today's prediction for later validation comparison. */
export function saveWakePrediction(result: WakePredictionResult, dateStr?: string): void {
  try {
    const db = getDb()
    const date = dateStr ?? new Date().toISOString().split('T')[0]
    const record: WakePredictionRecord = {
      date,
      predictedRangeStart: result.rangeStart,
      predictedRangeEnd: result.rangeEnd,
      optimalPoint: result.optimalPoint,
      confidence: result.confidence,
      confidenceScore: result.confidenceScore,
      bindingFloor: result.signals.bindingFloor,
    }
    db.prepare(
      `
      INSERT OR REPLACE INTO health_metrics (metric_type, date, value_json, source)
      VALUES ('wake_prediction', ?, ?, 'wake-prediction-model')
    `,
    ).run(date, JSON.stringify(record))
  } catch (err) {
    console.error('[wake-prediction] save failed:', err)
  }
}

/** Record the actual wake outcome for model validation and self-correction. */
export function recordWakeOutcome(params: {
  date: string
  actualWakeTime: string
  grogginessRating?: number
  energyRating?: number
  minutesToAlertAfterWake?: number
  snoozed?: boolean
}): void {
  try {
    const db = getDb()
    const row = db
      .prepare(
        `
      SELECT value_json FROM health_metrics
      WHERE metric_type = 'wake_prediction' AND date = ?
    `,
      )
      .get(params.date) as { value_json: string } | undefined

    if (!row) return

    const record: WakePredictionRecord = JSON.parse(row.value_json)
    record.actualWakeTime = params.actualWakeTime
    record.grogginessRating = params.grogginessRating
    record.energyRating = params.energyRating
    record.minutesToAlertAfterWake = params.minutesToAlertAfterWake
    record.snoozed = params.snoozed

    db.prepare(
      `
      UPDATE health_metrics SET value_json = ? WHERE metric_type = 'wake_prediction' AND date = ?
    `,
    ).run(JSON.stringify(record), params.date)
  } catch (err) {
    console.error('[wake-prediction] recordOutcome failed:', err)
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface WakePredictionValidation {
  totalPredictions: number
  withOutcomes: number
  avgErrorMinutes: number
  pctWithinRange: number
  avgGrogginessInRange: number
  avgGrogginessOutRange: number
  avgEnergyInRange: number
  snoozedPct: number
  bindingFloorBreakdown: Record<string, number> // e.g. { sleep_need: 12, circadian: 5, ... }
  verdict: string
}

/**
 * Compare historical predictions with recorded outcomes.
 *
 * Validation signals mirror sleep-research validity criteria:
 *   - Grogginess rating (sleep inertia proxy, Karolinska Sleepiness Scale)
 *   - Time to alertness (cortical re-activation proxy)
 *   - Snooze frequency (spontaneous vs. forced waking indicator)
 *   - Prediction error vs. actual wake time
 */
export function validateWakePredictions(days: number = 30): WakePredictionValidation | null {
  try {
    const db = getDb()
    const rows = db
      .prepare(
        `
      SELECT value_json FROM health_metrics
      WHERE metric_type = 'wake_prediction'
      ORDER BY date DESC LIMIT ?
    `,
      )
      .all(days) as Array<{ value_json: string }>

    if (rows.length < 3) return null

    const records = rows.map((r) => JSON.parse(r.value_json) as WakePredictionRecord)
    const withOutcomes = records.filter((r) => r.actualWakeTime)

    // Binding floor breakdown (all records, not just ones with outcomes)
    const breakdown: Record<string, number> = {}
    for (const r of records) {
      const f = r.bindingFloor ?? 'unknown'
      breakdown[f] = (breakdown[f] ?? 0) + 1
    }

    if (withOutcomes.length < 3) {
      return {
        totalPredictions: records.length,
        withOutcomes: 0,
        avgErrorMinutes: 0,
        pctWithinRange: 0,
        avgGrogginessInRange: 0,
        avgGrogginessOutRange: 0,
        avgEnergyInRange: 0,
        snoozedPct: 0,
        bindingFloorBreakdown: breakdown,
        verdict: `${records.length} prediction${records.length !== 1 ? 's' : ''} saved but no outcomes recorded yet. Use recordWakeOutcome() to compare predictions against reality.`,
      }
    }

    let totalErrMin = 0,
      inRange = 0
    let grogIn = 0,
      grogInN = 0,
      grogOut = 0,
      grogOutN = 0
    let energyIn = 0,
      energyInN = 0,
      snoozed = 0

    for (const r of withOutcomes) {
      const actualH = parseTimeToHours(r.actualWakeTime!)
      const errH = circDist(actualH, parseTimeToHours(r.optimalPoint))
      totalErrMin += errH * 60

      const startH = parseTimeToHours(r.predictedRangeStart)
      const endH = parseTimeToHours(r.predictedRangeEnd)
      const inR =
        startH <= endH ? actualH >= startH && actualH <= endH : actualH >= startH || actualH <= endH

      if (inR) {
        inRange++
        if (r.grogginessRating) {
          grogIn += r.grogginessRating
          grogInN++
        }
        if (r.energyRating) {
          energyIn += r.energyRating
          energyInN++
        }
      } else {
        if (r.grogginessRating) {
          grogOut += r.grogginessRating
          grogOutN++
        }
      }
      if (r.snoozed) snoozed++
    }

    const n = withOutcomes.length
    const pct = (inRange / n) * 100
    const avgGrogIn = grogInN > 0 ? grogIn / grogInN : 0
    const avgGrogOt = grogOutN > 0 ? grogOut / grogOutN : 0

    let verdict: string
    if (pct >= 70)
      verdict = `Good accuracy: ${pct.toFixed(0)}% of actual wake times fell within the predicted window.`
    else if (pct >= 50)
      verdict = `Moderate accuracy: ${pct.toFixed(0)}% within range. Consistent scheduling will improve this.`
    else
      verdict = `Below target: ${pct.toFixed(0)}% within range. External alarms, obligations, or high schedule variability may be overriding natural wake signals.`

    if (avgGrogIn > 0 && avgGrogOt > 0 && avgGrogIn < avgGrogOt)
      verdict += ` Waking inside the predicted range was associated with ${(avgGrogOt - avgGrogIn).toFixed(1)} pts lower grogginess (1–5 scale).`

    return {
      totalPredictions: records.length,
      withOutcomes: n,
      avgErrorMinutes: parseFloat((totalErrMin / n).toFixed(1)),
      pctWithinRange: parseFloat(pct.toFixed(1)),
      avgGrogginessInRange: parseFloat(avgGrogIn.toFixed(2)),
      avgGrogginessOutRange: parseFloat(avgGrogOt.toFixed(2)),
      avgEnergyInRange: parseFloat((energyInN > 0 ? energyIn / energyInN : 0).toFixed(2)),
      snoozedPct: parseFloat(((snoozed / n) * 100).toFixed(1)),
      bindingFloorBreakdown: breakdown,
      verdict,
    }
  } catch (err) {
    console.error('[wake-prediction] validateWakePredictions failed:', err)
    return null
  }
}
