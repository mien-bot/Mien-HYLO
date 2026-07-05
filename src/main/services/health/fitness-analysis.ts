/**
 * Fitness Analysis Engine — Banister Impulse-Response Model + Recovery Science
 *
 * Based on:
 * - Banister's Fitness-Fatigue Model (1975): CTL/ATL/TSB with exponential decay
 * - TRIMP (Training Impulse): Heart rate weighted training load (Banister 1991)
 * - EPOC estimation: Excess Post-Exercise Oxygen Consumption from HR zones
 * - Garmin/Firstbeat methodology: Training Load, Recovery Time, Training Status
 * - HRV recovery science: Autonomic nervous system readiness (RMSSD-based)
 * - Sleep-exercise correlation: Athletes need 8-10h sleep during heavy training
 *
 * References:
 * - Banister et al. (1991) "Modeling human performance in running"
 * - Borbély (1982) Two-Process Model of Sleep
 * - TrainingPeaks Performance Manager (CTL τ=42d, ATL τ=7d)
 * - Fellrnr.com Modeling Human Performance
 * - Firstbeat Analytics (Garmin): EPOC-based training load
 */

import { getDb } from '../../db/database'
import { getAppSettings } from '../../lib/settings'
import {
  ACWR_INJURY_RISK,
  ACWR_SWEET_SPOT,
  ATL_TIME_CONSTANT,
  BANISTER_EXPONENT,
  BANISTER_GENDER_FACTOR,
  CTL_TIME_CONSTANT,
  DEFAULT_MAX_HR,
  DEFAULT_TRAINING_DAYS,
} from '@shared/constants'
import {
  getEffectiveHRZones,
  getEffectiveLTHR,
  getEffectiveMaxHR,
  getEffectiveRestingHR,
  getSportFromName,
  type HRZoneDef,
  type Sport,
} from './hr-zones.service'
import { getAllStreams, type StravaStream } from './strava.service'

// --- Types ---

export interface DailyActivityRecord {
  date: string
  steps: number
  activeCalories: number
  exerciseMinutes: number
  hrAvg: number
  hrMax: number
  hrMin: number
  restingHr: number
  hrv: number
  vo2Max: number
  sleepHours: number
  deepSleepPct: number
  workouts: WorkoutRecord[]
}

export interface WorkoutRecord {
  stravaId?: number | string
  name: string
  duration: number // minutes
  calories: number
  distance: number // miles
  stepCount: number
  avgHR: number
  maxHR: number
  hrZoneSeconds?: number[]
  start: string
  end: string
}

export interface TrainingLoadResult {
  // TRIMP-based load scores
  dailyLoads: Array<{ date: string; trimp: number; epoc: number }>
  // Banister model
  ctl: number // Chronic Training Load (fitness, τ=42d)
  atl: number // Acute Training Load (fatigue, τ=7d)
  tsb: number // Training Stress Balance (form = CTL - ATL)
  // Training status
  trainingStatus:
    | 'detraining'
    | 'recovery'
    | 'maintaining'
    | 'productive'
    | 'peaking'
    | 'overreaching'
  trainingStatusLabel: string
  // Historical CTL/ATL/TSB for charting
  history: Array<{
    date: string
    trimp: number
    ctl: number
    atl: number
    tsb: number
  }>
}

export interface RecoveryAnalysis {
  recoveryScore: number // 0-100
  recoveryStatus: 'optimal' | 'good' | 'fair' | 'poor' | 'critical'
  estimatedRecoveryHours: number
  readinessToTrain: boolean
  factors: RecoveryFactor[]
  sleepRecommendation: SleepRecommendation
}

export interface RecoveryFactor {
  name: string
  score: number // 0-100
  weight: number // contribution weight
  observation: string
}

export interface SleepRecommendation {
  baseNeed: number // hours (7-9 for most adults)
  trainingAdjustment: number // extra hours needed based on training load
  totalRecommended: number // base + adjustment
  reasoning: string
}

export interface FitnessProfile {
  // Cardio fitness
  vo2Max: number | null
  vo2Trend: 'improving' | 'stable' | 'declining' | null
  vo2Category: string // "poor" | "below_average" | "average" | "above_average" | "excellent" | "superior"
  // Resting heart rate
  restingHr: number | null
  rhrTrend: 'improving' | 'stable' | 'worsening' | null
  rhrCategory: string
  // HRV
  hrvBaseline: number | null
  hrvCurrent: number | null
  hrvTrend: 'improving' | 'stable' | 'declining' | null
  // Training volume
  weeklyExerciseMinutes: number
  weeklyActiveCalories: number
  exerciseConsistencyPct: number // % of days with 20+ min exercise
  // Composite
  fitnessScore: number // 0-100
  fitnessLevel: string // "beginner" | "developing" | "intermediate" | "advanced" | "elite"
}

export interface FitnessAnalysisResult {
  trainingLoad: TrainingLoadResult
  recovery: RecoveryAnalysis
  profile: FitnessProfile
  insights: string[]
}

// --- HR Zone Analysis (Elevate-style) ---

export interface HRZone {
  name: string
  /** Lower bound in BPM (inclusive). Resolved per-sport from the user's zone model. */
  minBpm: number
  /** Upper bound in BPM (exclusive). Top zone uses Number.POSITIVE_INFINITY. */
  maxBpm: number
  color: string
}

export interface HRZoneDistribution {
  zone: string
  minutes: number
  pct: number
  color: string
}

export interface HRZoneAnalysisResult {
  /** Canonical zone schema for the aggregate (BPM bounds use the dominant sport). */
  zones: HRZone[]
  /** Zone model in use: 'friel' (%LTHR, 7 zones) or 'maxhr' (%HRmax, 5 zones). */
  model: 'friel' | 'maxhr'
  /** Aggregate time-in-zone across all workouts in the range */
  aggregate: HRZoneDistribution[]
  /** Per-workout breakdown */
  perWorkout: Array<{
    date: string
    name: string
    sport: 'run' | 'ride' | 'other'
    duration: number
    distribution: HRZoneDistribution[]
    hrss: number
    zoneSource?: 'stream' | 'stored' | 'estimated'
  }>
  /** Total workout minutes analyzed */
  totalMinutes: number
  /** Workouts with HR data */
  workoutsAnalyzed: number
}

// --- HRSS (Heart Rate Stress Score — Elevate / TrainingPeaks TRIMP normalized) ---
// HRSS normalizes TRIMP so that 1 hour at LTHR = 100 points
// Formula: HRSS = (TRIMP_workout / TRIMP_1hr_at_LTHR) × 100

export interface HRSSResult {
  dailyHRSS: Array<{ date: string; hrss: number }>
  weeklyAvg: number
  monthlyAvg: number
  total: number
}

// --- Year-over-Year Progression (Elevate-style) ---

export interface YearProgressionResult {
  years: Array<{
    year: number
    data: Array<{
      dayOfYear: number
      date: string
      cumulativeDistance: number // miles
      cumulativeTime: number // minutes
      cumulativeElevation: number // feet
      cumulativeCount: number
      cumulativeCalories: number
    }>
  }>
}

// --- Best Efforts / Peak Performances ---

export interface BestEffort {
  date: string
  workoutName: string
  value: number
  unit: string
  duration?: number // minutes (for the workout)
}

export interface BestEffortsResult {
  longestWorkout: BestEffort | null
  highestCalories: BestEffort | null
  fastestPace: BestEffort | null // min/mile
  longestDistance: BestEffort | null
  highestAvgHR: BestEffort | null
  highestElevation: BestEffort | null
  records: Array<{
    category: string
    best: BestEffort
  }>
}

// --- Pace / Cadence / Power / Grade Zone Types ---

export interface ZoneDefinition {
  name: string
  min: number
  max: number
  color: string
}

export interface ZoneDistribution {
  zone: string
  seconds: number
  pct: number
  color: string
}

export interface StreamZoneAnalysisResult {
  paceZones: {
    zones: ZoneDefinition[]
    aggregate: ZoneDistribution[]
    perWorkout: StreamWorkoutZone[]
  } | null
  cadenceZones: {
    zones: ZoneDefinition[]
    aggregate: ZoneDistribution[]
    perWorkout: StreamWorkoutZone[]
  } | null
  powerZones: {
    zones: ZoneDefinition[]
    aggregate: ZoneDistribution[]
    perWorkout: StreamWorkoutZone[]
  } | null
  gradeZones: {
    zones: ZoneDefinition[]
    aggregate: ZoneDistribution[]
    perWorkout: StreamWorkoutZone[]
  } | null
}

export interface StreamWorkoutZone {
  activityId: number
  date: string
  name: string
  duration: number
  distribution: ZoneDistribution[]
}

// --- Best Splits from Streams ---

export interface BestSplit {
  range: number // seconds for time-based, meters for distance-based
  rangeLabel: string // e.g. "5 min", "1 km"
  value: number
  unit: string
  activityId: number
  date: string
  workoutName: string
}

export interface BestSplitsResult {
  hrSplits: BestSplit[] // best avg HR over time windows
  paceSplits: BestSplit[] // best pace over distance windows
  powerSplits: BestSplit[] // best avg power over time windows
}

// --- Grade-Adjusted Pace ---

export interface GAPResult {
  perActivity: Array<{
    activityId: number
    date: string
    name: string
    avgPace: number // min/mile actual
    avgGAP: number // min/mile grade-adjusted
    gapDelta: number // seconds faster/slower per mile
    elevationGain: number // meters
  }>
}

// --- Estimated Running Power ---

export interface RunningPowerResult {
  perActivity: Array<{
    activityId: number
    date: string
    name: string
    avgPower: number // watts
    maxPower: number
    normalizedPower: number
  }>
}

// --- Constants ---

const DEFAULT_REST_HR = 60

// Recovery factors weights
const RECOVERY_WEIGHTS = {
  hrv: 0.3,
  restingHr: 0.2,
  sleepQuality: 0.25,
  trainingLoad: 0.25,
}

// VO2 max categories (ACSM guidelines, males 20-29)
const VO2_CATEGORIES = [
  { max: 25, label: 'Very Poor' },
  { max: 33, label: 'Poor' },
  { max: 37, label: 'Below Average' },
  { max: 42, label: 'Average' },
  { max: 47, label: 'Above Average' },
  { max: 52, label: 'Excellent' },
  { max: Infinity, label: 'Superior' },
]

// RHR categories
const RHR_CATEGORIES = [
  { max: 50, label: 'Athletic' },
  { max: 60, label: 'Excellent' },
  { max: 65, label: 'Good' },
  { max: 72, label: 'Average' },
  { max: 80, label: 'Below Average' },
  { max: Infinity, label: 'Poor' },
]

// --- Core Functions ---

/**
 * Load all activity data for a given number of days
 */
function loadActivityData(days: number): DailyActivityRecord[] {
  const db = getDb()
  const types = [
    'steps',
    'active_energy',
    'exercise_time',
    'heart_rate',
    'resting_heart_rate',
    'hrv',
    'vo2_max',
    'sleep',
    'workout',
  ]

  const allMetrics: Record<string, Record<string, any>> = {}

  for (const type of types) {
    const rows = db
      .prepare(
        `
      SELECT date, value_json FROM health_metrics
      WHERE metric_type = ? AND date >= date('now', '-' || ? || ' days')
      ORDER BY date ASC
    `,
      )
      .all(type, days) as Array<{ date: string; value_json: string }>

    for (const row of rows) {
      if (!allMetrics[row.date]) allMetrics[row.date] = {}
      try {
        allMetrics[row.date][type] = JSON.parse(row.value_json)
      } catch {}
    }
  }

  return Object.entries(allMetrics)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => {
      const steps = data.steps?.qty || 0
      const activeCalories = data.active_energy?.qty || 0
      const exerciseMinutes = data.exercise_time?.qty || 0
      const hrAvg = data.heart_rate?.Avg || data.heart_rate?.qty || 0
      const hrMax = data.heart_rate?.Max || 0
      const hrMin = data.heart_rate?.Min || 0
      const restingHr = data.resting_heart_rate?.qty || 0
      const hrv = data.hrv?.qty || data.hrv?.Avg || 0
      const vo2Max = data.vo2_max?.qty || 0
      const asleep = data.sleep?.totalAsleep || data.sleep?.asleep || data.sleep?.qty || 0
      const deep = data.sleep?.deep || 0
      const sleepHours = asleep >= 60 ? asleep / 60 : 0
      const deepSleepPct = asleep > 0 ? (deep / asleep) * 100 : 0

      // Parse workouts — handle both raw (from Health Auto Export) and pre-parsed formats
      const workouts: WorkoutRecord[] = []
      if (data.workout?.workouts) {
        for (const w of data.workout.workouts) {
          // Duration: may be in seconds (raw) or minutes (pre-parsed)
          const rawDur = w.duration || 0
          const duration = rawDur > 200 ? rawDur / 60 : rawDur

          // Distance: may be nested {qty, units} (raw km) or flat number (pre-parsed miles)
          let distance = 0
          if (typeof w.distance === 'object' && w.distance !== null) {
            const km = w.distance.qty ?? w.distance.value ?? 0
            distance = km * 0.621371
          } else {
            distance = w.distance || 0
          }

          // StepCount: may be per-minute array (raw) or total number (pre-parsed)
          const stepCount = Array.isArray(w.stepCount)
            ? Math.round(
                w.stepCount.reduce((s: number, e: any) => s + ((e?.qty as number) || 0), 0),
              )
            : w.stepCount || 0

          // Calories: may be null in raw data
          const calories =
            w.calories ?? w.activeEnergyBurned ?? w.totalEnergy ?? w.activeEnergy ?? 0

          // Heart rate: check multiple field names from raw exports
          const avgHR = w.avgHR || w.heartRateData?.avg || w.heartRateAvg || 0
          const maxHR = w.maxHR || w.heartRateData?.max || w.heartRateMax || 0

          workouts.push({
            stravaId: w.stravaId || w.activityId || w.id,
            name: w.name || 'Unknown',
            duration: Math.round(duration),
            calories: Math.round(calories),
            distance: parseFloat(distance.toFixed(2)),
            stepCount,
            avgHR,
            maxHR,
            hrZoneSeconds: Array.isArray(w.hrZoneSeconds) ? w.hrZoneSeconds : undefined,
            start: w.start || w.startDate || '',
            end: w.end || w.endDate || '',
          })
        }
      }

      return {
        date,
        steps,
        activeCalories,
        exerciseMinutes,
        hrAvg,
        hrMax,
        hrMin,
        restingHr,
        hrv,
        vo2Max,
        sleepHours,
        deepSleepPct,
        workouts,
      }
    })
}

/**
 * Estimate max heart rate from observed data (highest recorded + margin)
 */
function estimateMaxHR(data: DailyActivityRecord[]): number {
  const dailyMax = data.map((d) => d.hrMax).filter((v) => v > 0)
  const workoutMax = data.flatMap((d) => d.workouts.map((w) => w.maxHR).filter((v) => v > 0))
  const maxObserved = Math.max(...dailyMax, ...workoutMax, 0)
  // Use observed max directly — inflating it pushes zone boundaries too high
  if (maxObserved > 0) return maxObserved
  return DEFAULT_MAX_HR
}

/**
 * Estimate resting heart rate from data (use measured or lowest avg)
 */
function estimateRestHR(data: DailyActivityRecord[]): number {
  const resting = data.filter((d) => d.restingHr > 0).map((d) => d.restingHr)
  if (resting.length > 0) return Math.round(resting.reduce((s, v) => s + v, 0) / resting.length)
  const minHRs = data.filter((d) => d.hrMin > 30).map((d) => d.hrMin)
  if (minHRs.length > 0) return Math.round(minHRs.reduce((s, v) => s + v, 0) / minHRs.length)
  return DEFAULT_REST_HR
}

/**
 * Calculate TRIMP for a single day
 * Uses Banister's exponential heart rate weighting:
 * TRIMP = duration(min) × %HRR × 0.64 × e^(1.92 × %HRR)
 *
 * When no workout HR available, estimates from exercise minutes + avg daily HR
 */
function calculateDailyTRIMP(day: DailyActivityRecord, maxHR: number, restHR: number): number {
  let totalTrimp = 0

  // If we have workouts with HR data, use that
  for (const w of day.workouts) {
    if (w.avgHR > 0 && w.duration > 0) {
      const hrr = Math.max(0, Math.min(1, (w.avgHR - restHR) / (maxHR - restHR)))
      const y = BANISTER_GENDER_FACTOR * Math.exp(BANISTER_EXPONENT * hrr)
      totalTrimp += w.duration * hrr * y
    } else if (w.duration > 0) {
      // No HR — estimate based on workout type
      const intensityFactor = estimateWorkoutIntensity(w.name)
      const estimatedHRR = intensityFactor
      const y = BANISTER_GENDER_FACTOR * Math.exp(BANISTER_EXPONENT * estimatedHRR)
      totalTrimp += w.duration * estimatedHRR * y
    }
  }

  // If no workouts but exercise minutes exist, estimate TRIMP from daily HR
  if (day.workouts.length === 0 && day.exerciseMinutes > 0) {
    const avgHR = day.hrAvg > 0 ? day.hrAvg : 80 // fallback
    const hrr = Math.max(0, Math.min(1, (avgHR - restHR) / (maxHR - restHR)))
    // Only count exercise minutes, not entire day
    const y = BANISTER_GENDER_FACTOR * Math.exp(BANISTER_EXPONENT * hrr)
    totalTrimp += day.exerciseMinutes * hrr * y
  }

  // Add small background TRIMP for high step counts (walking load)
  if (day.steps > 5000 && totalTrimp === 0) {
    // Walking TRIMP: low intensity, long duration equivalent
    const walkingMinutes = Math.min(day.steps / 100, 60) // rough: 100 steps/min
    const walkHRR = 0.3 // light activity ~30% HRR
    const y = BANISTER_GENDER_FACTOR * Math.exp(BANISTER_EXPONENT * walkHRR)
    totalTrimp += walkingMinutes * walkHRR * y * 0.3 // discount factor for non-structured
  }

  return parseFloat(totalTrimp.toFixed(1))
}

/**
 * Estimate workout intensity from name (when no HR data available)
 * Returns estimated %HRR (0-1)
 */
function estimateWorkoutIntensity(name: string): number {
  const lower = name.toLowerCase()
  if (lower.includes('run') || lower.includes('hiit') || lower.includes('sprint')) return 0.75
  if (lower.includes('swim')) return 0.7
  if (lower.includes('cycling') || lower.includes('bike') || lower.includes('ride')) return 0.7
  if (lower.includes('strength') || lower.includes('weight') || lower.includes('functional'))
    return 0.6
  if (lower.includes('walk')) return 0.4
  if (lower.includes('yoga') || lower.includes('stretch') || lower.includes('pilates')) return 0.35
  return 0.55 // default moderate
}

/**
 * Estimate EPOC (ml O2/kg) from exercise data
 * Based on Garmin/Firstbeat: EPOC rises exponentially with intensity
 * Light (<65% HRmax): ~10-20 ml/kg
 * Moderate (65-80%): ~20-60 ml/kg
 * High (>80%): ~60-150+ ml/kg
 */
function estimateDailyEPOC(day: DailyActivityRecord, maxHR: number): number {
  let epoc = 0

  for (const w of day.workouts) {
    const hr = w.avgHR > 0 ? w.avgHR : maxHR * estimateWorkoutIntensity(w.name)
    const pctMax = hr / maxHR
    // Exponential EPOC model
    if (pctMax < 0.65) {
      epoc += w.duration * 0.5 // ~15 for 30min
    } else if (pctMax < 0.8) {
      epoc += w.duration * 1.5 // ~45 for 30min
    } else {
      epoc += w.duration * 3.5 // ~105 for 30min
    }
  }

  // Fallback: estimate from exercise minutes
  if (day.workouts.length === 0 && day.exerciseMinutes > 0) {
    const avgPctMax = day.hrAvg > 0 ? day.hrAvg / maxHR : 0.6
    if (avgPctMax < 0.65) epoc += day.exerciseMinutes * 0.5
    else if (avgPctMax < 0.8) epoc += day.exerciseMinutes * 1.5
    else epoc += day.exerciseMinutes * 3.5
  }

  return parseFloat(epoc.toFixed(1))
}

// Effectively "all history" — used to warm up the Banister EMAs so the current
// CTL/ATL/TSB do not depend on the caller's display window. ~100 years covers
// any real dataset (data starts 2020) while the SQL date filter caps the scan.
const FULL_HISTORY_DAYS = 36500

/**
 * Calculate Banister Fitness-Fatigue Model
 * CTL (Chronic Training Load) = exponential moving average, τ=42 days
 * ATL (Acute Training Load) = exponential moving average, τ=7 days
 * TSB (Training Stress Balance) = CTL - ATL
 *
 * Formula: CTL_today = CTL_yesterday × (1 - 1/τ) + TRIMP_today × (1/τ)
 */
export function calculateTrainingLoad(days: number = DEFAULT_TRAINING_DAYS): TrainingLoadResult {
  // The Banister CTL/ATL EMAs MUST accumulate from the full available history,
  // not just the requested display window. CTL has a 42-day time constant, so a
  // short window (e.g. 30d) starting from zero never converges and reports an
  // artificially low "current fitness". To keep every surface consistent
  // (page header, chart, dashboard card) the model always warms up over all
  // history; `days` only controls how much of the series is returned for display.
  const fullData = loadActivityData(FULL_HISTORY_DAYS)
  const maxHR = estimateMaxHR(fullData)
  const restHR = estimateRestHR(fullData)

  const allDailyLoads: Array<{ date: string; trimp: number; epoc: number }> = []
  const allHistory: TrainingLoadResult['history'] = []

  let ctl = 0
  let atl = 0

  const ctlDecay = 1 - 1 / CTL_TIME_CONSTANT
  const ctlGain = 1 / CTL_TIME_CONSTANT
  const atlDecay = 1 - 1 / ATL_TIME_CONSTANT
  const atlGain = 1 / ATL_TIME_CONSTANT

  for (const day of fullData) {
    const trimp = calculateDailyTRIMP(day, maxHR, restHR)
    const epoc = estimateDailyEPOC(day, maxHR)

    allDailyLoads.push({ date: day.date, trimp, epoc })

    ctl = ctl * ctlDecay + trimp * ctlGain
    atl = atl * atlDecay + trimp * atlGain
    const tsb = ctl - atl

    allHistory.push({
      date: day.date,
      trimp,
      ctl: parseFloat(ctl.toFixed(1)),
      atl: parseFloat(atl.toFixed(1)),
      tsb: parseFloat(tsb.toFixed(1)),
    })
  }

  const tsb = ctl - atl

  // Determine training status from the full warmed-up series (recency handled internally)
  const trainingStatus = determineTrainingStatus(ctl, atl, tsb, fullData)

  // Slice the series down to the requested display window. The "current"
  // CTL/ATL/TSB scalars stay anchored to the latest full-history value so they
  // are identical regardless of the window the caller asked for.
  const windowDates = new Set(loadActivityData(days).map((d) => d.date))
  const dailyLoads = allDailyLoads.filter((d) => windowDates.has(d.date))
  const history = allHistory.filter((h) => windowDates.has(h.date))

  return {
    dailyLoads,
    ctl: parseFloat(ctl.toFixed(1)),
    atl: parseFloat(atl.toFixed(1)),
    tsb: parseFloat(tsb.toFixed(1)),
    trainingStatus: trainingStatus.status,
    trainingStatusLabel: trainingStatus.label,
    history,
  }
}

function determineTrainingStatus(
  ctl: number,
  atl: number,
  tsb: number,
  data: DailyActivityRecord[],
): { status: TrainingLoadResult['trainingStatus']; label: string } {
  // Check VO2 max trend
  const vo2values = data.filter((d) => d.vo2Max > 0).map((d) => d.vo2Max)
  const vo2Improving = vo2values.length >= 2 && vo2values[vo2values.length - 1] > vo2values[0]

  // Recent exercise consistency
  const recentDays = data.slice(-14)
  const activeDays = recentDays.filter((d) => d.exerciseMinutes >= 15).length

  if (ctl < 5 && activeDays < 3) {
    return { status: 'detraining', label: 'Detraining — fitness declining due to inactivity' }
  }

  if (tsb > 15 && ctl > 10) {
    return { status: 'peaking', label: 'Peaking — well-rested with strong fitness base' }
  }

  if (tsb < -20) {
    return { status: 'overreaching', label: 'Overreaching — high fatigue, recovery needed' }
  }

  if (tsb > 0 && tsb <= 15) {
    return { status: 'recovery', label: 'Recovery — freshening up, fatigue dissipating' }
  }

  if (vo2Improving || (ctl > 10 && tsb >= -15 && tsb <= 5)) {
    return { status: 'productive', label: 'Productive — fitness improving from balanced training' }
  }

  return { status: 'maintaining', label: 'Maintaining — consistent training, stable fitness' }
}

/**
 * Calculate recovery readiness score
 * Combines HRV, resting HR, sleep quality, and training load
 */
export function calculateRecovery(days: number = 30): RecoveryAnalysis {
  const data = loadActivityData(days)
  if (data.length < 3) {
    return {
      recoveryScore: 50,
      recoveryStatus: 'fair',
      estimatedRecoveryHours: 24,
      readinessToTrain: true,
      factors: [],
      sleepRecommendation: {
        baseNeed: 8,
        trainingAdjustment: 0,
        totalRecommended: 8,
        reasoning: 'Not enough data for personalized recommendation.',
      },
    }
  }

  const factors: RecoveryFactor[] = []
  const maxHR = estimateMaxHR(data)
  const restHR = estimateRestHR(data)

  // 1. HRV Factor — z-score based (higher HRV = better recovery)
  const hrvValues = data.filter((d) => d.hrv > 0).map((d) => d.hrv)
  if (hrvValues.length >= 5) {
    const mean = hrvValues.reduce((s, v) => s + v, 0) / hrvValues.length
    const std = Math.sqrt(hrvValues.reduce((s, v) => s + (v - mean) ** 2, 0) / hrvValues.length)
    const latest = hrvValues[hrvValues.length - 1]
    const zScore = std > 0 ? (latest - mean) / std : 0
    // Map z-score to 0-100: -2σ=10, 0=50, +2σ=90
    const score = Math.min(100, Math.max(0, 50 + zScore * 20))

    factors.push({
      name: 'HRV Recovery',
      score: Math.round(score),
      weight: RECOVERY_WEIGHTS.hrv,
      observation:
        zScore > 0.5
          ? `HRV ${latest}ms is above your baseline (${Math.round(mean)}ms) — good parasympathetic recovery.`
          : zScore < -0.5
            ? `HRV ${latest}ms is below baseline (${Math.round(mean)}ms) — autonomic system under stress.`
            : `HRV ${latest}ms is near your baseline (${Math.round(mean)}ms) — normal recovery state.`,
    })
  }

  // 2. Resting HR Factor — lower than baseline = better recovery
  const rhrValues = data.filter((d) => d.restingHr > 0).map((d) => d.restingHr)
  if (rhrValues.length >= 3) {
    const mean = rhrValues.reduce((s, v) => s + v, 0) / rhrValues.length
    const latest = rhrValues[rhrValues.length - 1]
    const diff = latest - mean
    // Each bpm above baseline reduces score by 8 points
    const score = Math.min(100, Math.max(0, 70 - diff * 8))

    factors.push({
      name: 'Resting Heart Rate',
      score: Math.round(score),
      weight: RECOVERY_WEIGHTS.restingHr,
      observation:
        diff > 3
          ? `Resting HR ${latest}bpm is elevated (+${Math.round(diff)}bpm above baseline) — indicates cumulative stress or incomplete recovery.`
          : diff < -2
            ? `Resting HR ${latest}bpm is below baseline — excellent cardiovascular recovery.`
            : `Resting HR ${latest}bpm is near baseline (${Math.round(mean)}bpm) — normal recovery.`,
    })
  }

  // 3. Sleep Quality Factor
  const recentSleep = data.slice(-7).filter((d) => d.sleepHours > 0)
  if (recentSleep.length >= 3) {
    const avgSleep = recentSleep.reduce((s, d) => s + d.sleepHours, 0) / recentSleep.length
    const avgDeep = recentSleep.reduce((s, d) => s + d.deepSleepPct, 0) / recentSleep.length
    // Target: 7-9h sleep, 15-23% deep
    let score = 50
    if (avgSleep >= 7 && avgSleep <= 9) score += 25
    else if (avgSleep >= 6) score += 10
    else score -= 20
    if (avgDeep >= 15) score += 15
    else if (avgDeep >= 10) score += 5
    // Last night weight
    const lastNight = recentSleep[recentSleep.length - 1]
    if (lastNight.sleepHours >= 7) score += 10
    else if (lastNight.sleepHours < 5) score -= 15

    score = Math.min(100, Math.max(0, score))

    factors.push({
      name: 'Sleep Quality',
      score: Math.round(score),
      weight: RECOVERY_WEIGHTS.sleepQuality,
      observation:
        avgSleep >= 7
          ? `Averaging ${avgSleep.toFixed(1)}h sleep (last 7 days) — meeting recovery needs.`
          : `Averaging only ${avgSleep.toFixed(1)}h sleep — below the 7-9h needed for optimal recovery.`,
    })
  }

  // 4. Training Load Factor — acute load vs chronic (ACWR)
  const trainingLoad = calculateTrainingLoad(days)
  const acwr = trainingLoad.ctl > 0 ? trainingLoad.atl / trainingLoad.ctl : 1
  let loadScore = 50
  // Sweet spot: ACWR 0.8-1.3 (Gabbett 2016)
  if (acwr >= ACWR_SWEET_SPOT[0] && acwr <= ACWR_SWEET_SPOT[1]) loadScore = 80
  else if (acwr < ACWR_SWEET_SPOT[0])
    loadScore = 60 // undertrained
  else if (acwr > ACWR_INJURY_RISK)
    loadScore = 20 // injury risk zone
  else loadScore = 40

  // TSB adjustment
  if (trainingLoad.tsb > 10)
    loadScore += 15 // well-rested
  else if (trainingLoad.tsb < -15) loadScore -= 15 // fatigued

  loadScore = Math.min(100, Math.max(0, loadScore))

  factors.push({
    name: 'Training Load Balance',
    score: Math.round(loadScore),
    weight: RECOVERY_WEIGHTS.trainingLoad,
    observation:
      acwr > ACWR_INJURY_RISK
        ? `Acute:Chronic ratio ${acwr.toFixed(2)} is in the danger zone (>1.5) — high injury risk, reduce intensity.`
        : acwr >= ACWR_SWEET_SPOT[0] && acwr <= ACWR_SWEET_SPOT[1]
          ? `Acute:Chronic ratio ${acwr.toFixed(2)} is in the sweet spot (0.8-1.3) — optimal training progression.`
          : acwr < 0.5
            ? `Acute:Chronic ratio ${acwr.toFixed(2)} — training volume is low relative to your fitness base.`
            : `Acute:Chronic ratio ${acwr.toFixed(2)} — training load is moderately elevated.`,
  })

  // Compute weighted recovery score
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0)
  const recoveryScore =
    totalWeight > 0
      ? Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight)
      : 50

  const recoveryStatus: RecoveryAnalysis['recoveryStatus'] =
    recoveryScore >= 80
      ? 'optimal'
      : recoveryScore >= 65
        ? 'good'
        : recoveryScore >= 45
          ? 'fair'
          : recoveryScore >= 25
            ? 'poor'
            : 'critical'

  // Estimate recovery time based on recent load
  const lastTrimp =
    trainingLoad.dailyLoads.length > 0
      ? trainingLoad.dailyLoads[trainingLoad.dailyLoads.length - 1].trimp
      : 0
  // Base: 12-48h depending on load
  const estimatedRecoveryHours = Math.round(12 + lastTrimp / 5 + (recoveryScore < 50 ? 12 : 0))

  // Sleep recommendation based on training load
  const sleepRecommendation = calculateSleepRecommendation(trainingLoad, data)

  return {
    recoveryScore,
    recoveryStatus,
    estimatedRecoveryHours: Math.min(72, estimatedRecoveryHours),
    readinessToTrain: recoveryScore >= 45 && trainingLoad.tsb > -25,
    factors,
    sleepRecommendation,
  }
}

/**
 * Calculate personalized sleep recommendation based on training load
 * Research: Athletes need 8-10h during heavy training (Fullagar et al. 2015)
 * Each ~100 TRIMP/week adds ~15min sleep need
 */
function calculateSleepRecommendation(
  trainingLoad: TrainingLoadResult,
  data: DailyActivityRecord[],
): SleepRecommendation {
  const baseNeed = 7.5 // hours for general adults

  // Weekly training load from last 7 days
  const last7 = trainingLoad.dailyLoads.slice(-7)
  const weeklyTrimp = last7.reduce((s, d) => s + d.trimp, 0)

  // Training adjustment: ~15 min per 50 TRIMP units per week
  // Heavy training week (~300 TRIMP) → +1.5h extra sleep
  const trainingAdjustment = parseFloat(((weeklyTrimp / 50) * 0.25).toFixed(1))

  // Cap at 2h extra
  const cappedAdjustment = Math.min(2, trainingAdjustment)
  const totalRecommended = parseFloat((baseNeed + cappedAdjustment).toFixed(1))

  // Current sleep
  const recentSleep = data.slice(-7).filter((d) => d.sleepHours > 0)
  const avgSleep =
    recentSleep.length > 0
      ? recentSleep.reduce((s, d) => s + d.sleepHours, 0) / recentSleep.length
      : 0

  let reasoning = ''
  if (weeklyTrimp > 200) {
    reasoning = `Your weekly training load is high (${Math.round(weeklyTrimp)} TRIMP). Research shows athletes need 8-10h during heavy training periods for optimal recovery, muscle repair, and hormone regulation.`
  } else if (weeklyTrimp > 100) {
    reasoning = `Moderate weekly training load (${Math.round(weeklyTrimp)} TRIMP). An extra ${(cappedAdjustment * 60).toFixed(0)} minutes of sleep supports recovery and performance gains.`
  } else {
    reasoning = `Light training load (${Math.round(weeklyTrimp)} TRIMP). Standard 7.5-8h sleep should be sufficient for recovery.`
  }

  if (avgSleep > 0 && avgSleep < totalRecommended - 0.5) {
    reasoning += ` You're currently averaging ${avgSleep.toFixed(1)}h — ${((totalRecommended - avgSleep) * 60).toFixed(0)} minutes short of your optimal need.`
  } else if (avgSleep >= totalRecommended) {
    reasoning += ` You're currently meeting your sleep needs at ${avgSleep.toFixed(1)}h average.`
  }

  return {
    baseNeed,
    trainingAdjustment: cappedAdjustment,
    totalRecommended,
    reasoning,
  }
}

/**
 * Build comprehensive fitness profile
 */
export function buildFitnessProfile(days: number = DEFAULT_TRAINING_DAYS): FitnessProfile {
  const data = loadActivityData(days)

  // VO2 Max
  const vo2Values = data.filter((d) => d.vo2Max > 0).map((d) => d.vo2Max)
  const vo2Max = vo2Values.length > 0 ? vo2Values[vo2Values.length - 1] : null
  let vo2Trend: FitnessProfile['vo2Trend'] = null
  if (vo2Values.length >= 2) {
    const first = vo2Values[0]
    const last = vo2Values[vo2Values.length - 1]
    vo2Trend = last > first + 0.5 ? 'improving' : last < first - 0.5 ? 'declining' : 'stable'
  }
  const vo2Category = vo2Max
    ? VO2_CATEGORIES.find((c) => vo2Max <= c.max)?.label || 'Unknown'
    : 'Unknown'

  // Resting HR
  const rhrValues = data.filter((d) => d.restingHr > 0).map((d) => d.restingHr)
  const restingHr =
    rhrValues.length > 0
      ? Math.round(rhrValues.reduce((s, v) => s + v, 0) / rhrValues.length)
      : null
  let rhrTrend: FitnessProfile['rhrTrend'] = null
  if (rhrValues.length >= 3) {
    const firstHalf = rhrValues.slice(0, Math.floor(rhrValues.length / 2))
    const secondHalf = rhrValues.slice(Math.floor(rhrValues.length / 2))
    const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length
    const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length
    rhrTrend =
      avgSecond < avgFirst - 1 ? 'improving' : avgSecond > avgFirst + 1 ? 'worsening' : 'stable'
  }
  const rhrCategory = restingHr
    ? RHR_CATEGORIES.find((c) => restingHr <= c.max)?.label || 'Unknown'
    : 'Unknown'

  // HRV
  const hrvValues = data.filter((d) => d.hrv > 0).map((d) => d.hrv)
  const hrvBaseline =
    hrvValues.length >= 7
      ? Math.round(hrvValues.reduce((s, v) => s + v, 0) / hrvValues.length)
      : null
  const hrvCurrent = hrvValues.length > 0 ? hrvValues[hrvValues.length - 1] : null
  let hrvTrend: FitnessProfile['hrvTrend'] = null
  if (hrvValues.length >= 7) {
    const recent = hrvValues.slice(-7)
    const older = hrvValues.slice(0, -7)
    if (older.length >= 3) {
      const avgRecent = recent.reduce((s, v) => s + v, 0) / recent.length
      const avgOlder = older.reduce((s, v) => s + v, 0) / older.length
      hrvTrend =
        avgRecent > avgOlder + 3 ? 'improving' : avgRecent < avgOlder - 3 ? 'declining' : 'stable'
    }
  }

  // Training volume (last 7 days)
  const last7 = data.slice(-7)
  const weeklyExerciseMinutes = Math.round(last7.reduce((s, d) => s + d.exerciseMinutes, 0))
  const weeklyActiveCalories = Math.round(last7.reduce((s, d) => s + d.activeCalories, 0))

  // Exercise consistency (last 30 days)
  const last30 = data.slice(-30)
  const exerciseConsistencyPct =
    last30.length > 0
      ? Math.round((last30.filter((d) => d.exerciseMinutes >= 20).length / last30.length) * 100)
      : 0

  // Composite fitness score
  let score = 0
  let components = 0
  if (vo2Max) {
    score += Math.min(100, Math.max(0, (vo2Max - 20) * (100 / 40)))
    components++
  }
  if (restingHr) {
    score += Math.min(100, Math.max(0, (80 - restingHr) * (100 / 40)))
    components++
  }
  if (hrvBaseline) {
    score += Math.min(100, Math.max(0, (hrvBaseline - 20) * (100 / 60)))
    components++
  }
  score += Math.min(100, exerciseConsistencyPct)
  components++

  const fitnessScore = components > 0 ? Math.round(score / components) : 0

  const fitnessLevel =
    fitnessScore >= 85
      ? 'Elite'
      : fitnessScore >= 70
        ? 'Advanced'
        : fitnessScore >= 50
          ? 'Intermediate'
          : fitnessScore >= 30
            ? 'Developing'
            : 'Beginner'

  return {
    vo2Max,
    vo2Trend,
    vo2Category,
    restingHr,
    rhrTrend,
    rhrCategory,
    hrvBaseline,
    hrvCurrent,
    hrvTrend,
    weeklyExerciseMinutes,
    weeklyActiveCalories,
    exerciseConsistencyPct,
    fitnessScore,
    fitnessLevel,
  }
}

/**
 * Generate insights by correlating all health data
 */
function generateInsights(
  data: DailyActivityRecord[],
  trainingLoad: TrainingLoadResult,
  recovery: RecoveryAnalysis,
  profile: FitnessProfile,
): string[] {
  const insights: string[] = []

  // Sleep-exercise correlation
  const daysWithBoth = data.filter((d) => d.sleepHours > 0 && d.exerciseMinutes > 0)
  if (daysWithBoth.length >= 10) {
    const goodSleep = daysWithBoth.filter((d) => d.sleepHours >= 7)
    const poorSleep = daysWithBoth.filter((d) => d.sleepHours < 6)
    if (goodSleep.length >= 3 && poorSleep.length >= 3) {
      const avgExGood = Math.round(
        goodSleep.reduce((s, d) => s + d.exerciseMinutes, 0) / goodSleep.length,
      )
      const avgExPoor = Math.round(
        poorSleep.reduce((s, d) => s + d.exerciseMinutes, 0) / poorSleep.length,
      )
      if (avgExGood > avgExPoor + 5) {
        insights.push(
          `Sleep-exercise link: You exercise ${avgExGood}min on well-slept days vs ${avgExPoor}min on poor sleep days. Prioritizing sleep amplifies training capacity.`,
        )
      }
    }
  }

  // HRV and training load relationship
  const hrvExDays = data.filter((d) => d.hrv > 0 && d.exerciseMinutes > 0)
  if (hrvExDays.length >= 7) {
    const highLoad = hrvExDays.filter((d) => d.exerciseMinutes >= 30)
    const lowLoad = hrvExDays.filter((d) => d.exerciseMinutes < 15)
    if (highLoad.length >= 3 && lowLoad.length >= 3) {
      const hrvHigh = Math.round(highLoad.reduce((s, d) => s + d.hrv, 0) / highLoad.length)
      const hrvLow = Math.round(lowLoad.reduce((s, d) => s + d.hrv, 0) / lowLoad.length)
      if (Math.abs(hrvHigh - hrvLow) > 5) {
        insights.push(
          `HRV responds to training: ${hrvHigh}ms on active days vs ${hrvLow}ms on rest days. ${hrvHigh > hrvLow ? 'Exercise is boosting your autonomic recovery.' : 'High training loads are suppressing HRV — consider lighter sessions.'}`,
        )
      }
    }
  }

  // Training status insight
  insights.push(
    `Training status: ${trainingLoad.trainingStatusLabel} (CTL: ${trainingLoad.ctl}, ATL: ${trainingLoad.atl}, Form: ${trainingLoad.tsb > 0 ? '+' : ''}${trainingLoad.tsb}).`,
  )

  // Recovery insight
  if (recovery.recoveryScore < 45) {
    insights.push(
      `Recovery alert: Score ${recovery.recoveryScore}/100 (${recovery.recoveryStatus}). Consider a rest day or light activity only. ${recovery.sleepRecommendation.reasoning}`,
    )
  } else if (recovery.recoveryScore >= 75) {
    insights.push(
      `Recovery is strong (${recovery.recoveryScore}/100). Your body is ready for a productive training session.`,
    )
  }

  // Sleep recommendation
  const sr = recovery.sleepRecommendation
  if (sr.trainingAdjustment > 0.3) {
    insights.push(
      `Sleep need: ${sr.totalRecommended}h recommended (${sr.baseNeed}h base + ${(sr.trainingAdjustment * 60).toFixed(0)}min for training recovery). ${sr.reasoning}`,
    )
  }

  // VO2 max insight
  if (profile.vo2Max) {
    insights.push(
      `Cardio fitness: VO2 max ${profile.vo2Max} mL/kg/min (${profile.vo2Category}). ${profile.vo2Trend === 'improving' ? 'Your aerobic capacity is improving — keep up current training.' : profile.vo2Trend === 'declining' ? 'VO2 declining — increase aerobic training frequency.' : 'VO2 stable — vary intensity to stimulate further adaptation.'}`,
    )
  }

  // Exercise consistency
  if (profile.exerciseConsistencyPct < 40) {
    insights.push(
      `Exercise consistency at ${profile.exerciseConsistencyPct}% of days. WHO recommends 150-300min moderate exercise per week. Consistency matters more than intensity for long-term health.`,
    )
  }

  // Resting HR
  if (profile.restingHr && profile.rhrTrend) {
    if (profile.rhrTrend === 'improving') {
      insights.push(
        `Resting heart rate trending down (${profile.restingHr}bpm, ${profile.rhrCategory}) — cardiovascular fitness is improving.`,
      )
    } else if (profile.rhrTrend === 'worsening') {
      insights.push(
        `Resting heart rate trending up (${profile.restingHr}bpm) — may indicate overtraining, stress, or inadequate recovery.`,
      )
    }
  }

  return insights
}

/**
 * Main entry point: Full fitness analysis
 */
export function getFullFitnessAnalysis(
  days: number = DEFAULT_TRAINING_DAYS,
): FitnessAnalysisResult {
  const data = loadActivityData(days)
  const trainingLoad = calculateTrainingLoad(days)
  const recovery = calculateRecovery(days)
  const profile = buildFitnessProfile(days)
  const insights = generateInsights(data, trainingLoad, recovery, profile)

  return { trainingLoad, recovery, profile, insights }
}

// =============================================================================
// HR Zone Analysis (Elevate-inspired)
// =============================================================================

/**
 * Classify a workout's average HR into a zone distribution.
 * Fallback used only when neither stream nor stored zoneSeconds are available:
 * primary zone gets 70%, adjacent zones get 15% each.
 */
function classifyWorkoutToBpmZones(
  workout: WorkoutRecord,
  zones: HRZoneDef[],
): HRZoneDistribution[] {
  if (workout.avgHR <= 0 || workout.duration <= 0) {
    return zones.map((z) => ({ zone: z.name, minutes: 0, pct: 0, color: z.color }))
  }

  const idx = Math.max(
    0,
    zones.findIndex((z) => workout.avgHR >= z.minBpm && workout.avgHR < z.maxBpm),
  )
  return zones.map((z, i) => {
    let pct = 0
    if (i === idx) pct = 0.7
    else if (i === idx - 1 || i === idx + 1) pct = 0.15
    return {
      zone: z.name,
      minutes: parseFloat((workout.duration * pct).toFixed(1)),
      pct: parseFloat((pct * 100).toFixed(1)),
      color: z.color,
    }
  })
}

/**
 * Calculate HRSS for a single workout. Uses the workout's sport-specific LTHR.
 * HRSS = (TRIMP_workout / TRIMP_1hr_at_LTHR) × 100
 */
function calculateWorkoutHRSS(
  workout: WorkoutRecord,
  sport: Sport,
  maxHR: number,
  restHR: number,
): number {
  if (workout.avgHR <= 0 || workout.duration <= 0) return 0

  const lthr = getEffectiveLTHR(sport) ?? Math.round(maxHR * 0.85)

  const hrr = Math.max(0, Math.min(1, (workout.avgHR - restHR) / (maxHR - restHR)))
  const y = BANISTER_GENDER_FACTOR * Math.exp(BANISTER_EXPONENT * hrr)
  const workoutTrimp = workout.duration * hrr * y

  const lthrHRR = Math.max(0.01, (lthr - restHR) / (maxHR - restHR))
  const lthrY = BANISTER_GENDER_FACTOR * Math.exp(BANISTER_EXPONENT * lthrHRR)
  const lthrTrimp = 60 * lthrHRR * lthrY

  if (lthrTrimp === 0) return 0
  return parseFloat(((workoutTrimp / lthrTrimp) * 100).toFixed(1))
}

/**
 * Classify HR from stream data (second-by-second) into zone distribution.
 * Bucket each sample into the BPM-bounded zone for its sport.
 */
function classifyHRStreamToBpmZones(
  hrStream: number[],
  timeStream: number[],
  zones: HRZoneDef[],
): HRZoneDistribution[] {
  const zoneTimes = new Array(zones.length).fill(0)
  let totalTime = 0

  for (let i = 1; i < hrStream.length && i < timeStream.length; i++) {
    const dt = timeStream[i] - timeStream[i - 1]
    if (dt <= 0 || dt > 60) continue
    const hr = hrStream[i]
    if (!hr || hr <= 0) continue

    let zoneIdx = zones.findIndex((z) => hr >= z.minBpm && hr < z.maxBpm)
    if (zoneIdx === -1) zoneIdx = hr >= zones[zones.length - 1].minBpm ? zones.length - 1 : 0

    zoneTimes[zoneIdx] += dt
    totalTime += dt
  }

  return zones.map((z, i) => ({
    zone: z.name,
    minutes: parseFloat((zoneTimes[i] / 60).toFixed(1)),
    pct: totalTime > 0 ? parseFloat(((zoneTimes[i] / totalTime) * 100).toFixed(1)) : 0,
    color: z.color,
  }))
}

function classifyStoredZoneSecondsToZones(
  zoneSeconds: number[],
  durationMinutes: number,
  zones: HRZoneDef[],
): HRZoneDistribution[] {
  const seconds = zoneSeconds.filter((v) => Number.isFinite(v) && v > 0)
  const totalSeconds = seconds.reduce((sum, value) => sum + value, 0)
  if (totalSeconds <= 0) {
    return zones.map((z) => ({ zone: z.name, minutes: 0, pct: 0, color: z.color }))
  }

  return zones
    .map((z, i) => {
      const storedIndex =
        zones.length === seconds.length
          ? i
          : Math.min(seconds.length - 1, Math.floor((i * seconds.length) / zones.length))
      const secondsInZone = seconds[storedIndex] || 0
      return {
        zone: z.name,
        minutes: parseFloat((secondsInZone / 60).toFixed(1)),
        pct: parseFloat(((secondsInZone / totalSeconds) * 100).toFixed(1)),
        color: z.color,
      }
    })
    .filter((z) => durationMinutes > 0 || z.minutes > 0)
}

function toResultZone(z: HRZoneDef): HRZone {
  return {
    name: z.name,
    minBpm: z.minBpm,
    maxBpm: Number.isFinite(z.maxBpm) ? z.maxBpm : Number.POSITIVE_INFINITY,
    color: z.color,
  }
}

export function calculateHRZoneAnalysis(
  days: number = DEFAULT_TRAINING_DAYS,
): HRZoneAnalysisResult {
  const data = loadActivityData(days)
  const restHR = getEffectiveRestingHR()

  // Pre-resolve zones per sport (BPM bounds depend on sport-specific max HR / LTHR)
  const zonesBySport: Record<Sport, ReturnType<typeof getEffectiveHRZones>> = {
    run: getEffectiveHRZones('run'),
    ride: getEffectiveHRZones('ride'),
    other: getEffectiveHRZones('other'),
  }

  // Build stream lookup
  const streams = getAllStreams(days)
  const streamMapById = new Map<string, { heartrate: number[]; time: number[] }>()
  const streamsByDate = new Map<
    string,
    Array<{ key: string; heartrate: number[]; time: number[] }>
  >()
  for (const s of streams) {
    if (s.streams.heartrate?.length && s.streams.time?.length) {
      const stream = { heartrate: s.streams.heartrate, time: s.streams.time }
      const key = String(s.activityId)
      streamMapById.set(key, stream)
      if (!streamsByDate.has(s.date)) streamsByDate.set(s.date, [])
      streamsByDate.get(s.date)!.push({ key, ...stream })
    }
  }
  const usedStreamIds = new Set<string>()

  const perWorkout: HRZoneAnalysisResult['perWorkout'] = []
  const sportMinutes: Record<Sport, number> = { run: 0, ride: 0, other: 0 }
  // Aggregate minutes per zone NAME (uniform across sports — same zone model picks consistent name set)
  const aggregateByName = new Map<string, { minutes: number; color: string }>()
  let totalMinutes = 0
  let workoutsAnalyzed = 0

  for (const day of data) {
    for (const w of day.workouts) {
      if (w.avgHR <= 0) continue

      const sport = getSportFromName(w.name)
      const sportZones = zonesBySport[sport].zones

      const stravaId = w.stravaId ? String(w.stravaId) : ''
      let stream = stravaId ? streamMapById.get(stravaId) : undefined
      let streamKey = stravaId
      if (!stream) {
        const unusedStream = streamsByDate
          .get(day.date)
          ?.find((candidate) => !usedStreamIds.has(candidate.key))
        if (unusedStream) {
          stream = unusedStream
          streamKey = unusedStream.key
        }
      }

      let zoneSource: 'stream' | 'stored' | 'estimated' = 'estimated'
      let dist: HRZoneDistribution[]
      if (stream) {
        usedStreamIds.add(streamKey)
        zoneSource = 'stream'
        dist = classifyHRStreamToBpmZones(stream.heartrate, stream.time, sportZones)
      } else if (w.hrZoneSeconds?.some((value) => value > 0)) {
        zoneSource = 'stored'
        dist = classifyStoredZoneSecondsToZones(w.hrZoneSeconds, w.duration, sportZones)
      } else {
        dist = classifyWorkoutToBpmZones(w, sportZones)
      }

      const sportMaxHR = getEffectiveMaxHR(sport)
      const hrss = calculateWorkoutHRSS(w, sport, sportMaxHR, restHR)
      perWorkout.push({
        date: day.date,
        name: w.name,
        sport,
        duration: w.duration,
        distribution: dist,
        hrss,
        zoneSource,
      })
      for (const d of dist) {
        const cur = aggregateByName.get(d.zone) ?? { minutes: 0, color: d.color }
        cur.minutes += d.minutes
        aggregateByName.set(d.zone, cur)
      }
      sportMinutes[sport] += w.duration
      totalMinutes += w.duration
      workoutsAnalyzed++
    }
  }

  // Pick the dominant sport for the canonical schema returned in `zones`
  const dominantSport: Sport =
    sportMinutes.run >= sportMinutes.ride && sportMinutes.run >= sportMinutes.other
      ? 'run'
      : sportMinutes.ride >= sportMinutes.other
        ? 'ride'
        : 'other'
  const canonical = zonesBySport[dominantSport]

  const aggregate: HRZoneDistribution[] = canonical.zones.map((z) => {
    const cur = aggregateByName.get(z.name) ?? { minutes: 0, color: z.color }
    return {
      zone: z.name,
      minutes: parseFloat(cur.minutes.toFixed(1)),
      pct: totalMinutes > 0 ? parseFloat(((cur.minutes / totalMinutes) * 100).toFixed(1)) : 0,
      color: z.color,
    }
  })

  perWorkout.sort((a, b) => b.date.localeCompare(a.date))

  return {
    zones: canonical.zones.map(toResultZone),
    model: canonical.model,
    aggregate,
    perWorkout,
    totalMinutes: parseFloat(totalMinutes.toFixed(1)),
    workoutsAnalyzed,
  }
}

// =============================================================================
// HRSS (Heart Rate Stress Score) — normalized daily stress
// =============================================================================

export function calculateHRSS(days: number = DEFAULT_TRAINING_DAYS): HRSSResult {
  const data = loadActivityData(days)
  const restHR = getEffectiveRestingHR()

  const dailyHRSS: Array<{ date: string; hrss: number }> = []

  for (const day of data) {
    let dayHRSS = 0
    for (const w of day.workouts) {
      const sport = getSportFromName(w.name)
      dayHRSS += calculateWorkoutHRSS(w, sport, getEffectiveMaxHR(sport), restHR)
    }
    dailyHRSS.push({ date: day.date, hrss: parseFloat(dayHRSS.toFixed(1)) })
  }

  const total = dailyHRSS.reduce((s, d) => s + d.hrss, 0)
  const last7 = dailyHRSS.slice(-7)
  const last30 = dailyHRSS.slice(-30)
  const weeklyAvg =
    last7.length > 0 ? parseFloat((last7.reduce((s, d) => s + d.hrss, 0) / 7).toFixed(1)) : 0
  const monthlyAvg =
    last30.length > 0 ? parseFloat((last30.reduce((s, d) => s + d.hrss, 0) / 30).toFixed(1)) : 0

  return { dailyHRSS, weeklyAvg, monthlyAvg, total: parseFloat(total.toFixed(1)) }
}

// =============================================================================
// Year-over-Year Progression (Elevate-style cumulative charts)
// =============================================================================

export function calculateYearProgression(days: number = 730): YearProgressionResult {
  const data = loadActivityData(days)

  // Group by year
  const byYear = new Map<number, typeof data>()
  for (const day of data) {
    const year = parseInt(day.date.slice(0, 4))
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year)!.push(day)
  }

  const years: YearProgressionResult['years'] = []

  for (const [year, yearData] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    let cumDist = 0,
      cumTime = 0,
      cumElev = 0,
      cumCount = 0,
      cumCal = 0

    const progressions = yearData.map((day) => {
      // Calculate day-of-year
      const d = new Date(day.date)
      const start = new Date(d.getFullYear(), 0, 1)
      const dayOfYear = Math.floor((d.getTime() - start.getTime()) / 86400000) + 1

      for (const w of day.workouts) {
        cumDist += w.distance || 0
        cumTime += w.duration || 0
        cumElev += (w as Record<string, unknown>).elevationGain
          ? (w as Record<string, unknown>).elevationGain * 3.28084
          : 0 // m→ft
        cumCount++
        cumCal += w.calories || 0
      }

      return {
        dayOfYear,
        date: day.date,
        cumulativeDistance: parseFloat(cumDist.toFixed(2)),
        cumulativeTime: Math.round(cumTime),
        cumulativeElevation: Math.round(cumElev),
        cumulativeCount: cumCount,
        cumulativeCalories: Math.round(cumCal),
      }
    })

    years.push({ year, data: progressions })
  }

  return { years }
}

// =============================================================================
// Best Efforts / Personal Records
// =============================================================================

export function calculateBestEfforts(days: number = 365): BestEffortsResult {
  const data = loadActivityData(days)

  let longestWorkout: BestEffort | null = null
  let highestCalories: BestEffort | null = null
  let fastestPace: BestEffort | null = null
  let longestDistance: BestEffort | null = null
  let highestAvgHR: BestEffort | null = null
  let highestElevation: BestEffort | null = null

  for (const day of data) {
    for (const w of day.workouts) {
      // Longest workout
      if (w.duration > 0 && (!longestWorkout || w.duration > longestWorkout.value)) {
        longestWorkout = {
          date: day.date,
          workoutName: w.name,
          value: w.duration,
          unit: 'min',
          duration: w.duration,
        }
      }
      // Highest calories
      if (w.calories > 0 && (!highestCalories || w.calories > highestCalories.value)) {
        highestCalories = {
          date: day.date,
          workoutName: w.name,
          value: w.calories,
          unit: 'cal',
          duration: w.duration,
        }
      }
      // Fastest pace (only for activities with distance)
      if (w.distance > 0.1 && w.duration > 0) {
        const pace = w.duration / w.distance // min/mile
        if (!fastestPace || pace < fastestPace.value) {
          fastestPace = {
            date: day.date,
            workoutName: w.name,
            value: parseFloat(pace.toFixed(2)),
            unit: 'min/mi',
            duration: w.duration,
          }
        }
      }
      // Longest distance
      if (w.distance > 0 && (!longestDistance || w.distance > longestDistance.value)) {
        longestDistance = {
          date: day.date,
          workoutName: w.name,
          value: w.distance,
          unit: 'mi',
          duration: w.duration,
        }
      }
      // Highest avg HR
      if (w.avgHR > 0 && (!highestAvgHR || w.avgHR > highestAvgHR.value)) {
        highestAvgHR = {
          date: day.date,
          workoutName: w.name,
          value: w.avgHR,
          unit: 'bpm',
          duration: w.duration,
        }
      }
      // Highest elevation
      const elev = (w as Record<string, unknown>).elevationGain || 0
      if (elev > 0 && (!highestElevation || elev > highestElevation.value)) {
        highestElevation = {
          date: day.date,
          workoutName: w.name,
          value: Math.round(elev * 3.28084),
          unit: 'ft',
          duration: w.duration,
        }
      }
    }
  }

  const records: BestEffortsResult['records'] = []
  if (longestWorkout) records.push({ category: 'Longest Workout', best: longestWorkout })
  if (highestCalories) records.push({ category: 'Most Calories', best: highestCalories })
  if (longestDistance) records.push({ category: 'Longest Distance', best: longestDistance })
  if (fastestPace) records.push({ category: 'Fastest Pace', best: fastestPace })
  if (highestAvgHR) records.push({ category: 'Highest Avg HR', best: highestAvgHR })
  if (highestElevation) records.push({ category: 'Most Elevation', best: highestElevation })

  return {
    longestWorkout,
    highestCalories,
    fastestPace,
    longestDistance,
    highestAvgHR,
    highestElevation,
    records,
  }
}

// =============================================================================
// Stream-Based Zone Analysis (Pace, Cadence, Power, Grade)
// Requires Strava activity streams (second-by-second data)
// =============================================================================

const DEFAULT_PACE_ZONES: ZoneDefinition[] = [
  { name: 'Easy (<12:00)', min: 0, max: 720, color: '#94a3b8' },
  { name: 'Moderate (10-12)', min: 720, max: 600, color: '#3b82f6' }, // note: pace is inverted (lower = faster)
  { name: 'Tempo (8-10)', min: 600, max: 480, color: '#22c55e' },
  { name: 'Threshold (7-8)', min: 480, max: 420, color: '#f59e0b' },
  { name: 'Speed (<7:00)', min: 420, max: 0, color: '#ef4444' },
]

const DEFAULT_CADENCE_ZONES: ZoneDefinition[] = [
  { name: 'Walking (<100)', min: 0, max: 100, color: '#94a3b8' },
  { name: 'Low (100-150)', min: 100, max: 150, color: '#3b82f6' },
  { name: 'Moderate (150-170)', min: 150, max: 170, color: '#22c55e' },
  { name: 'Optimal (170-185)', min: 170, max: 185, color: '#f59e0b' },
  { name: 'High (185+)', min: 185, max: 999, color: '#ef4444' },
]

const DEFAULT_POWER_ZONES: ZoneDefinition[] = [
  { name: 'Z1 Recovery (<55%)', min: 0, max: 55, color: '#94a3b8' },
  { name: 'Z2 Endurance (55-75%)', min: 55, max: 75, color: '#3b82f6' },
  { name: 'Z3 Tempo (75-90%)', min: 75, max: 90, color: '#22c55e' },
  { name: 'Z4 Threshold (90-105%)', min: 90, max: 105, color: '#f59e0b' },
  { name: 'Z5 VO2max (105-120%)', min: 105, max: 120, color: '#ef4444' },
  { name: 'Z6 Anaerobic (120%+)', min: 120, max: 999, color: '#dc2626' },
]

const DEFAULT_GRADE_ZONES: ZoneDefinition[] = [
  { name: 'Steep downhill (<-8%)', min: -100, max: -8, color: '#3b82f6' },
  { name: 'Downhill (-8 to -2%)', min: -8, max: -2, color: '#60a5fa' },
  { name: 'Flat (-2 to 2%)', min: -2, max: 2, color: '#94a3b8' },
  { name: 'Uphill (2-8%)', min: 2, max: 8, color: '#f59e0b' },
  { name: 'Steep uphill (8-15%)', min: 8, max: 15, color: '#ef4444' },
  { name: 'Very steep (15%+)', min: 15, max: 100, color: '#dc2626' },
]

function classifyStreamToZones(
  stream: number[],
  timeStream: number[],
  zones: ZoneDefinition[],
  inverted = false, // for pace: lower value = higher zone
): ZoneDistribution[] {
  const zoneTimes = new Array(zones.length).fill(0)
  let totalTime = 0

  for (let i = 1; i < stream.length && i < timeStream.length; i++) {
    const dt = timeStream[i] - timeStream[i - 1]
    if (dt <= 0 || dt > 60) continue // skip gaps
    const val = stream[i]
    if (val === 0 || val === null || val === undefined) continue

    let zoneIdx = -1
    if (inverted) {
      // For pace: higher zone = lower pace value (faster)
      for (let z = zones.length - 1; z >= 0; z--) {
        if (val <= zones[z].min && (zones[z].max === 0 || val > zones[z].max)) {
          zoneIdx = z
          break
        }
      }
      if (zoneIdx === -1) zoneIdx = 0 // slowest zone
    } else {
      for (let z = 0; z < zones.length; z++) {
        if (val >= zones[z].min && val < zones[z].max) {
          zoneIdx = z
          break
        }
      }
      if (zoneIdx === -1) zoneIdx = zones.length - 1
    }

    zoneTimes[zoneIdx] += dt
    totalTime += dt
  }

  return zones.map((z, i) => ({
    zone: z.name,
    seconds: Math.round(zoneTimes[i]),
    pct: totalTime > 0 ? parseFloat(((zoneTimes[i] / totalTime) * 100).toFixed(1)) : 0,
    color: z.color,
  }))
}

export function calculateStreamZoneAnalysis(
  days: number = DEFAULT_TRAINING_DAYS,
): StreamZoneAnalysisResult {
  const streams = getAllStreams(days)
  if (streams.length === 0)
    return { paceZones: null, cadenceZones: null, powerZones: null, gradeZones: null }

  const pacePerWorkout: StreamWorkoutZone[] = []
  const cadencePerWorkout: StreamWorkoutZone[] = []
  const powerPerWorkout: StreamWorkoutZone[] = []
  const gradePerWorkout: StreamWorkoutZone[] = []

  const paceAgg = new Array(DEFAULT_PACE_ZONES.length).fill(0)
  const cadenceAgg = new Array(DEFAULT_CADENCE_ZONES.length).fill(0)
  const powerAgg = new Array(DEFAULT_POWER_ZONES.length).fill(0)
  const gradeAgg = new Array(DEFAULT_GRADE_ZONES.length).fill(0)

  // Estimate FTP from best 20min power (if available)
  const ftp = getUserFTP()

  for (const s of streams) {
    const time = s.streams.time
    if (!time || time.length < 10) continue
    const duration = Math.round((time[time.length - 1] - time[0]) / 60)

    // Pace zones (from velocity, convert m/s to sec/mile)
    if (s.streams.velocity_smooth && s.streams.velocity_smooth.length === time.length) {
      const paceStream = s.streams.velocity_smooth.map(
        (v) => (v > 0.1 ? 1609.34 / v : 9999), // sec per mile
      )
      const dist = classifyStreamToZones(paceStream, time, DEFAULT_PACE_ZONES, true)
      pacePerWorkout.push({
        activityId: s.activityId,
        date: s.date,
        name: s.name,
        duration,
        distribution: dist,
      })
      dist.forEach((d, i) => (paceAgg[i] += d.seconds))
    }

    // Cadence zones
    if (s.streams.cadence && s.streams.cadence.length === time.length) {
      // Running cadence is typically per leg in Strava, multiply by 2 for SPM
      const cadStream = s.streams.cadence.map((c) => c * 2)
      const dist = classifyStreamToZones(cadStream, time, DEFAULT_CADENCE_ZONES)
      cadencePerWorkout.push({
        activityId: s.activityId,
        date: s.date,
        name: s.name,
        duration,
        distribution: dist,
      })
      dist.forEach((d, i) => (cadenceAgg[i] += d.seconds))
    }

    // Power zones (% of FTP)
    if (s.streams.watts && s.streams.watts.length === time.length && ftp > 0) {
      const pctStream = s.streams.watts.map((w) => (w / ftp) * 100)
      const dist = classifyStreamToZones(pctStream, time, DEFAULT_POWER_ZONES)
      powerPerWorkout.push({
        activityId: s.activityId,
        date: s.date,
        name: s.name,
        duration,
        distribution: dist,
      })
      dist.forEach((d, i) => (powerAgg[i] += d.seconds))
    }

    // Grade zones
    if (s.streams.grade_smooth && s.streams.grade_smooth.length === time.length) {
      const dist = classifyStreamToZones(s.streams.grade_smooth, time, DEFAULT_GRADE_ZONES)
      gradePerWorkout.push({
        activityId: s.activityId,
        date: s.date,
        name: s.name,
        duration,
        distribution: dist,
      })
      dist.forEach((d, i) => (gradeAgg[i] += d.seconds))
    }
  }

  const makeResult = (zones: ZoneDefinition[], agg: number[], perWorkout: StreamWorkoutZone[]) => {
    if (perWorkout.length === 0) return null
    const total = agg.reduce((s, v) => s + v, 0)
    return {
      zones,
      aggregate: zones.map((z, i) => ({
        zone: z.name,
        seconds: agg[i],
        pct: total > 0 ? parseFloat(((agg[i] / total) * 100).toFixed(1)) : 0,
        color: z.color,
      })),
      perWorkout,
    }
  }

  return {
    paceZones: makeResult(DEFAULT_PACE_ZONES, paceAgg, pacePerWorkout),
    cadenceZones: makeResult(DEFAULT_CADENCE_ZONES, cadenceAgg, cadencePerWorkout),
    powerZones: makeResult(DEFAULT_POWER_ZONES, powerAgg, powerPerWorkout),
    gradeZones: makeResult(DEFAULT_GRADE_ZONES, gradeAgg, gradePerWorkout),
  }
}

function getUserFTP(): number {
  try {
    const settings = getAppSettings()
    const ftp = parseInt(settings?.ftp)
    return ftp > 0 ? ftp : 0
  } catch {}
  return 0
}

// =============================================================================
// Best Splits from Streams (sliding window over time/distance)
// Based on Elevate's SplitCalculator algorithm
// =============================================================================

function bestSplitOverTimeWindow(
  dataStream: number[],
  timeStream: number[],
  windowSeconds: number,
): { avg: number; startIdx: number; endIdx: number } | null {
  if (dataStream.length < 2 || timeStream.length < 2) return null

  let bestAvg = -Infinity
  let bestStart = 0
  let bestEnd = 0
  let winStart = 0
  let sum = 0
  let count = 0

  for (let i = 0; i < dataStream.length; i++) {
    const val = dataStream[i]
    if (val === null || val === undefined) continue
    sum += val
    count++

    // Check if window exceeds target duration
    while (winStart < i && timeStream[i] - timeStream[winStart] > windowSeconds) {
      sum -= dataStream[winStart] || 0
      count--
      winStart++
    }

    // Check if window is at least 90% of target
    if (timeStream[i] - timeStream[winStart] >= windowSeconds * 0.9 && count > 0) {
      const avg = sum / count
      if (avg > bestAvg) {
        bestAvg = avg
        bestStart = winStart
        bestEnd = i
      }
    }
  }

  if (bestAvg === -Infinity) return null
  return { avg: parseFloat(bestAvg.toFixed(2)), startIdx: bestStart, endIdx: bestEnd }
}

function bestSplitOverDistance(
  dataStream: number[],
  distanceStream: number[],
  windowMeters: number,
): { avg: number; startIdx: number; endIdx: number } | null {
  if (dataStream.length < 2 || distanceStream.length < 2) return null

  let bestAvg = -Infinity
  let bestStart = 0
  let bestEnd = 0
  let winStart = 0
  let sum = 0
  let count = 0

  for (let i = 0; i < dataStream.length; i++) {
    const val = dataStream[i]
    if (val === null || val === undefined) continue
    sum += val
    count++

    while (winStart < i && distanceStream[i] - distanceStream[winStart] > windowMeters) {
      sum -= dataStream[winStart] || 0
      count--
      winStart++
    }

    if (distanceStream[i] - distanceStream[winStart] >= windowMeters * 0.9 && count > 0) {
      const avg = sum / count
      if (avg > bestAvg) {
        bestAvg = avg
        bestStart = winStart
        bestEnd = i
      }
    }
  }

  if (bestAvg === -Infinity) return null
  return { avg: parseFloat(bestAvg.toFixed(2)), startIdx: bestStart, endIdx: bestEnd }
}

const TIME_WINDOWS = [
  { seconds: 10, label: '10 sec' },
  { seconds: 30, label: '30 sec' },
  { seconds: 60, label: '1 min' },
  { seconds: 300, label: '5 min' },
  { seconds: 600, label: '10 min' },
  { seconds: 1200, label: '20 min' },
  { seconds: 3600, label: '1 hour' },
]

const DISTANCE_WINDOWS = [
  { meters: 400, label: '400m' },
  { meters: 1000, label: '1 km' },
  { meters: 1609.34, label: '1 mile' },
  { meters: 5000, label: '5 km' },
  { meters: 10000, label: '10 km' },
]

export function calculateBestSplits(days: number = 365): BestSplitsResult {
  const streams = getAllStreams(days)

  const hrSplits: BestSplit[] = []
  const paceSplits: BestSplit[] = []
  const powerSplits: BestSplit[] = []

  // Best HR over time windows
  for (const w of TIME_WINDOWS) {
    let bestResult: BestSplit | null = null
    for (const s of streams) {
      if (!s.streams.heartrate || !s.streams.time) continue
      const result = bestSplitOverTimeWindow(s.streams.heartrate, s.streams.time, w.seconds)
      if (result && (!bestResult || result.avg > bestResult.value)) {
        bestResult = {
          range: w.seconds,
          rangeLabel: w.label,
          value: Math.round(result.avg),
          unit: 'bpm',
          activityId: s.activityId,
          date: s.date,
          workoutName: s.name,
        }
      }
    }
    if (bestResult) hrSplits.push(bestResult)
  }

  // Best pace over distance windows (lowest = best, so we invert)
  for (const w of DISTANCE_WINDOWS) {
    let bestPace = Infinity
    let bestActivity: (typeof streams)[0] | null = null
    for (const s of streams) {
      if (!s.streams.velocity_smooth || !s.streams.distance) continue
      const paceStream = s.streams.velocity_smooth.map((v) => (v > 0.1 ? 1 / v : 9999)) // sec/meter
      const result = bestSplitOverDistance(paceStream, s.streams.distance, w.meters)
      if (result && result.avg < bestPace && result.avg > 0) {
        bestPace = result.avg
        bestActivity = s
      }
    }
    if (bestActivity && bestPace < 9999) {
      const paceMinPerMile = (bestPace * 1609.34) / 60
      paceSplits.push({
        range: w.meters,
        rangeLabel: w.label,
        value: parseFloat(paceMinPerMile.toFixed(2)),
        unit: 'min/mi',
        activityId: bestActivity.activityId,
        date: bestActivity.date,
        workoutName: bestActivity.name,
      })
    }
  }

  // Best power over time windows
  for (const w of TIME_WINDOWS) {
    let bestResult: BestSplit | null = null
    for (const s of streams) {
      if (!s.streams.watts || !s.streams.time) continue
      const result = bestSplitOverTimeWindow(s.streams.watts, s.streams.time, w.seconds)
      if (result && (!bestResult || result.avg > bestResult.value)) {
        bestResult = {
          range: w.seconds,
          rangeLabel: w.label,
          value: Math.round(result.avg),
          unit: 'W',
          activityId: s.activityId,
          date: s.date,
          workoutName: s.name,
        }
      }
    }
    if (bestResult) powerSplits.push(bestResult)
  }

  return { hrSplits, paceSplits, powerSplits }
}

// =============================================================================
// Grade-Adjusted Pace (GAP) — Elevate / Strava polynomial model
// Adjusts running pace for elevation changes so flat/uphill/downhill efforts are comparable
// =============================================================================

// Polynomial coefficients from Elevate (fitted to Strava's GAP model)
const GAP_KA = 1
const GAP_KB = 0.029290920646623777
const GAP_KC = 0.0018083953212790634
const GAP_KD = 4.0662425671715924e-7
const GAP_KE = -3.686186584867523e-7
const GAP_KF = -2.6628107325930747e-9

function gradeAdjustedSpeedFactor(gradePercent: number): number {
  const g = Math.max(-34, Math.min(34, gradePercent))
  return (
    GAP_KA +
    GAP_KB * g +
    GAP_KC * g * g +
    GAP_KD * g * g * g +
    GAP_KE * g * g * g * g +
    GAP_KF * g * g * g * g * g
  )
}

export function calculateGradeAdjustedPace(days: number = 365): GAPResult {
  const streams = getAllStreams(days)
  const perActivity: GAPResult['perActivity'] = []

  for (const s of streams) {
    const vel = s.streams.velocity_smooth
    const grade = s.streams.grade_smooth
    const time = s.streams.time
    const alt = s.streams.altitude
    if (!vel || !grade || !time || vel.length < 10) continue

    let sumVel = 0,
      sumGAP = 0,
      count = 0
    let totalElevGain = 0

    for (let i = 1; i < vel.length; i++) {
      if (vel[i] <= 0.1) continue
      const dt = time[i] - time[i - 1]
      if (dt <= 0 || dt > 60) continue

      const factor = gradeAdjustedSpeedFactor(grade[i] || 0)
      sumVel += vel[i]
      sumGAP += vel[i] * factor
      count++

      // Elevation gain
      if (alt && alt[i] > alt[i - 1]) {
        totalElevGain += alt[i] - alt[i - 1]
      }
    }

    if (count === 0) continue

    const avgVel = sumVel / count // m/s
    const avgGAPVel = sumGAP / count // m/s grade-adjusted

    // Convert to min/mile
    const avgPace = avgVel > 0 ? 1609.34 / avgVel / 60 : 0
    const avgGAP = avgGAPVel > 0 ? 1609.34 / avgGAPVel / 60 : 0

    perActivity.push({
      activityId: s.activityId,
      date: s.date,
      name: s.name,
      avgPace: parseFloat(avgPace.toFixed(2)),
      avgGAP: parseFloat(avgGAP.toFixed(2)),
      gapDelta: Math.round((avgGAP - avgPace) * 60), // seconds difference per mile
      elevationGain: Math.round(totalElevGain),
    })
  }

  return { perActivity }
}

// =============================================================================
// Estimated Running Power (Elevate formula)
// Watts = 1.04 x weight_kg x grade_adjusted_speed_m/s
// =============================================================================

export function calculateRunningPower(days: number = 365): RunningPowerResult {
  const streams = getAllStreams(days)
  const perActivity: RunningPowerResult['perActivity'] = []

  // Get athlete weight
  let weightKg = 70 // default
  try {
    const settings = getAppSettings()
    const lbs = parseFloat(settings?.userWeight)
    if (lbs > 0) weightKg = lbs * 0.453592
  } catch {}

  for (const s of streams) {
    const vel = s.streams.velocity_smooth
    const grade = s.streams.grade_smooth
    const time = s.streams.time
    if (!vel || !grade || !time || vel.length < 10) continue

    // Skip if already has real power data
    if (s.streams.watts && s.streams.watts.some((w) => w > 0)) continue

    let sumPower = 0,
      maxPower = 0,
      count = 0
    const powerValues: number[] = []

    for (let i = 0; i < vel.length; i++) {
      if (vel[i] <= 0.1) continue
      const factor = gradeAdjustedSpeedFactor(grade[i] || 0)
      const gasVel = vel[i] * factor
      const watts = 1.04 * weightKg * gasVel
      if (watts > 0 && watts < 2000) {
        sumPower += watts
        maxPower = Math.max(maxPower, watts)
        powerValues.push(watts)
        count++
      }
    }

    if (count === 0) continue

    // Normalized power (4th root of mean of 4th powers of 30s rolling averages)
    let np = sumPower / count
    if (powerValues.length > 30) {
      const rolling: number[] = []
      for (let i = 29; i < powerValues.length; i++) {
        let sum = 0
        for (let j = i - 29; j <= i; j++) sum += powerValues[j]
        rolling.push(sum / 30)
      }
      const fourthPowerMean = rolling.reduce((s, v) => s + v ** 4, 0) / rolling.length
      np = fourthPowerMean ** 0.25
    }

    perActivity.push({
      activityId: s.activityId,
      date: s.date,
      name: s.name,
      avgPower: Math.round(sumPower / count),
      maxPower: Math.round(maxPower),
      normalizedPower: Math.round(np),
    })
  }

  return { perActivity }
}

// =============================================================================
// Activity Name Pattern Filtering for Fitness Trend
// =============================================================================

export function getFilteredFitnessAnalysis(
  days: number = DEFAULT_TRAINING_DAYS,
  ignorePatterns: string[] = [],
): FitnessAnalysisResult {
  // If no patterns, just return normal analysis
  if (ignorePatterns.length === 0) return getFullFitnessAnalysis(days)

  // Load data and filter out matching workouts
  const data = loadActivityData(days)
  const regexes = ignorePatterns.map((p) => new RegExp(p, 'i'))

  for (const day of data) {
    day.workouts = day.workouts.filter((w) => !regexes.some((r) => r.test(w.name)))
  }

  // Recalculate with filtered data
  const trainingLoad = calculateTrainingLoad(days)
  const recovery = calculateRecovery(days)
  const profile = buildFitnessProfile(days)
  const insights = generateInsights(data, trainingLoad, recovery, profile)

  return { trainingLoad, recovery, profile, insights }
}
