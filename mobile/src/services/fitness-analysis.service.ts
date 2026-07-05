/**
 * Mobile Fitness Analysis Engine — port of desktop fitness-analysis.ts
 *
 * Banister Impulse-Response Model (CTL/ATL/TSB), TRIMP, Recovery Analysis,
 * Fitness Profile. Uses local expo-sqlite health_metrics data.
 */
import { getDb } from '../lib/database'

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
  name: string
  duration: number
  calories: number
  distance: number
  stepCount: number
  avgHR: number
  maxHR: number
  start: string
  end: string
}

export interface TrainingLoadResult {
  dailyLoads: Array<{ date: string; trimp: number; epoc: number }>
  ctl: number
  atl: number
  tsb: number
  trainingStatus: 'detraining' | 'recovery' | 'maintaining' | 'productive' | 'peaking' | 'overreaching'
  trainingStatusLabel: string
  history: Array<{ date: string; trimp: number; ctl: number; atl: number; tsb: number }>
}

export interface RecoveryFactor {
  name: string
  score: number
  weight: number
  observation: string
}

export interface SleepRecommendation {
  baseNeed: number
  trainingAdjustment: number
  totalRecommended: number
  reasoning: string
}

export interface RecoveryAnalysis {
  recoveryScore: number
  recoveryStatus: 'optimal' | 'good' | 'fair' | 'poor' | 'critical'
  estimatedRecoveryHours: number
  readinessToTrain: boolean
  factors: RecoveryFactor[]
  sleepRecommendation: SleepRecommendation
}

export interface FitnessProfile {
  vo2Max: number | null
  vo2Trend: 'improving' | 'stable' | 'declining' | null
  vo2Category: string
  restingHr: number | null
  rhrTrend: 'improving' | 'stable' | 'worsening' | null
  rhrCategory: string
  hrvBaseline: number | null
  hrvCurrent: number | null
  hrvTrend: 'improving' | 'stable' | 'declining' | null
  weeklyExerciseMinutes: number
  weeklyActiveCalories: number
  exerciseConsistencyPct: number
  fitnessScore: number
  fitnessLevel: string
}

export interface FitnessAnalysisResult {
  trainingLoad: TrainingLoadResult
  recovery: RecoveryAnalysis
  profile: FitnessProfile
  insights: string[]
}

// --- Constants ---

const CTL_TAU = 42
const ATL_TAU = 7
const TRIMP_MALE_A = 0.64
const TRIMP_MALE_B = 1.92
const DEFAULT_MAX_HR = 190
const DEFAULT_REST_HR = 60

const RECOVERY_WEIGHTS = { hrv: 0.30, restingHr: 0.20, sleepQuality: 0.25, trainingLoad: 0.25 }

const VO2_CATEGORIES = [
  { max: 25, label: 'Very Poor' }, { max: 33, label: 'Poor' },
  { max: 37, label: 'Below Average' }, { max: 42, label: 'Average' },
  { max: 47, label: 'Above Average' }, { max: 52, label: 'Excellent' },
  { max: Infinity, label: 'Superior' },
]

const RHR_CATEGORIES = [
  { max: 50, label: 'Athletic' }, { max: 60, label: 'Excellent' },
  { max: 65, label: 'Good' }, { max: 72, label: 'Average' },
  { max: 80, label: 'Below Average' }, { max: Infinity, label: 'Poor' },
]

// --- Data Loading (async for expo-sqlite) ---

async function loadActivityData(days: number): Promise<DailyActivityRecord[]> {
  const db = await getDb()
  const types = ['steps', 'active_energy', 'exercise_time', 'heart_rate',
    'resting_heart_rate', 'hrv', 'vo2_max', 'sleep', 'workout']

  const allMetrics: Record<string, Record<string, any>> = {}

  for (const type of types) {
    const rows = await db.getAllAsync(
      `SELECT date, value_json FROM health_metrics
       WHERE metric_type = ? AND date >= date('now', '-' || ? || ' days')
       ORDER BY date ASC`,
      type, days
    ) as Array<{ date: string; value_json: string }>

    for (const row of rows) {
      if (!allMetrics[row.date]) allMetrics[row.date] = {}
      try { allMetrics[row.date][type] = JSON.parse(row.value_json) } catch {}
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

      const workouts: WorkoutRecord[] = []
      if (data.workout?.workouts) {
        for (const w of data.workout.workouts) {
          const rawDur = w.duration || 0
          const duration = rawDur > 200 ? rawDur / 60 : rawDur
          let distance = 0
          if (typeof w.distance === 'object' && w.distance !== null) {
            distance = (w.distance.qty ?? w.distance.value ?? 0) * 0.621371
          } else {
            distance = w.distance || 0
          }
          const stepCount = Array.isArray(w.stepCount)
            ? Math.round(w.stepCount.reduce((s: number, e: any) => s + ((e?.qty as number) || 0), 0))
            : (w.stepCount || 0)
          const calories = w.calories ?? w.activeEnergyBurned ?? w.totalEnergy ?? w.activeEnergy ?? 0
          const avgHR = w.avgHR || w.heartRateData?.avg || w.heartRateAvg || 0
          const maxHR = w.maxHR || w.heartRateData?.max || w.heartRateMax || 0

          workouts.push({
            name: w.name || 'Unknown', duration: Math.round(duration),
            calories: Math.round(calories), distance: parseFloat(distance.toFixed(2)),
            stepCount, avgHR, maxHR, start: w.start || w.startDate || '', end: w.end || w.endDate || '',
          })
        }
      }

      return { date, steps, activeCalories, exerciseMinutes, hrAvg, hrMax, hrMin, restingHr, hrv, vo2Max, sleepHours, deepSleepPct, workouts }
    })
}

function estimateMaxHR(data: DailyActivityRecord[]): number {
  const maxObserved = Math.max(...data.map(d => d.hrMax).filter(v => v > 0), 0)
  if (maxObserved > 0) return Math.round(maxObserved * 1.05)
  return DEFAULT_MAX_HR
}

function estimateRestHR(data: DailyActivityRecord[]): number {
  const resting = data.filter(d => d.restingHr > 0).map(d => d.restingHr)
  if (resting.length > 0) return Math.round(resting.reduce((s, v) => s + v, 0) / resting.length)
  const minHRs = data.filter(d => d.hrMin > 30).map(d => d.hrMin)
  if (minHRs.length > 0) return Math.round(minHRs.reduce((s, v) => s + v, 0) / minHRs.length)
  return DEFAULT_REST_HR
}

function estimateWorkoutIntensity(name: string): number {
  const lower = name.toLowerCase()
  if (lower.includes('run') || lower.includes('hiit') || lower.includes('sprint')) return 0.75
  if (lower.includes('swim')) return 0.70
  if (lower.includes('cycling') || lower.includes('bike') || lower.includes('ride')) return 0.70
  if (lower.includes('strength') || lower.includes('weight') || lower.includes('functional')) return 0.60
  if (lower.includes('walk')) return 0.40
  if (lower.includes('yoga') || lower.includes('stretch') || lower.includes('pilates')) return 0.35
  return 0.55
}

function calculateDailyTRIMP(day: DailyActivityRecord, maxHR: number, restHR: number): number {
  let totalTrimp = 0
  for (const w of day.workouts) {
    if (w.avgHR > 0 && w.duration > 0) {
      const hrr = Math.max(0, Math.min(1, (w.avgHR - restHR) / (maxHR - restHR)))
      totalTrimp += w.duration * hrr * TRIMP_MALE_A * Math.exp(TRIMP_MALE_B * hrr)
    } else if (w.duration > 0) {
      const hrr = estimateWorkoutIntensity(w.name)
      totalTrimp += w.duration * hrr * TRIMP_MALE_A * Math.exp(TRIMP_MALE_B * hrr)
    }
  }
  if (day.workouts.length === 0 && day.exerciseMinutes > 0) {
    const avgHR = day.hrAvg > 0 ? day.hrAvg : 80
    const hrr = Math.max(0, Math.min(1, (avgHR - restHR) / (maxHR - restHR)))
    totalTrimp += day.exerciseMinutes * hrr * TRIMP_MALE_A * Math.exp(TRIMP_MALE_B * hrr)
  }
  if (day.steps > 5000 && totalTrimp === 0) {
    const walkMin = Math.min(day.steps / 100, 60)
    const walkHRR = 0.3
    totalTrimp += walkMin * walkHRR * TRIMP_MALE_A * Math.exp(TRIMP_MALE_B * walkHRR) * 0.3
  }
  return parseFloat(totalTrimp.toFixed(1))
}

function estimateDailyEPOC(day: DailyActivityRecord, maxHR: number): number {
  let epoc = 0
  for (const w of day.workouts) {
    const hr = w.avgHR > 0 ? w.avgHR : maxHR * estimateWorkoutIntensity(w.name)
    const pctMax = hr / maxHR
    epoc += w.duration * (pctMax < 0.65 ? 0.5 : pctMax < 0.80 ? 1.5 : 3.5)
  }
  if (day.workouts.length === 0 && day.exerciseMinutes > 0) {
    const avgPctMax = day.hrAvg > 0 ? day.hrAvg / maxHR : 0.60
    epoc += day.exerciseMinutes * (avgPctMax < 0.65 ? 0.5 : avgPctMax < 0.80 ? 1.5 : 3.5)
  }
  return parseFloat(epoc.toFixed(1))
}

// --- Public API ---

export async function calculateTrainingLoad(days: number = 90): Promise<TrainingLoadResult> {
  const data = await loadActivityData(days)
  const maxHR = estimateMaxHR(data)
  const restHR = estimateRestHR(data)

  const dailyLoads: Array<{ date: string; trimp: number; epoc: number }> = []
  const history: TrainingLoadResult['history'] = []
  let ctl = 0, atl = 0
  const ctlDecay = 1 - 1 / CTL_TAU, ctlGain = 1 / CTL_TAU
  const atlDecay = 1 - 1 / ATL_TAU, atlGain = 1 / ATL_TAU

  for (const day of data) {
    const trimp = calculateDailyTRIMP(day, maxHR, restHR)
    const epoc = estimateDailyEPOC(day, maxHR)
    dailyLoads.push({ date: day.date, trimp, epoc })
    ctl = ctl * ctlDecay + trimp * ctlGain
    atl = atl * atlDecay + trimp * atlGain
    history.push({ date: day.date, trimp, ctl: +ctl.toFixed(1), atl: +atl.toFixed(1), tsb: +(ctl - atl).toFixed(1) })
  }

  const tsb = ctl - atl
  const vo2values = data.filter(d => d.vo2Max > 0).map(d => d.vo2Max)
  const vo2Improving = vo2values.length >= 2 && vo2values[vo2values.length - 1] > vo2values[0]
  const recentDays = data.slice(-14)
  const activeDays = recentDays.filter(d => d.exerciseMinutes >= 15).length

  let status: TrainingLoadResult['trainingStatus'], label: string
  if (ctl < 5 && activeDays < 3) { status = 'detraining'; label = 'Detraining — fitness declining due to inactivity' }
  else if (tsb > 15 && ctl > 10) { status = 'peaking'; label = 'Peaking — well-rested with strong fitness base' }
  else if (tsb < -20) { status = 'overreaching'; label = 'Overreaching — high fatigue, recovery needed' }
  else if (tsb > 0 && tsb <= 15) { status = 'recovery'; label = 'Recovery — freshening up, fatigue dissipating' }
  else if (vo2Improving || (ctl > 10 && tsb >= -15 && tsb <= 5)) { status = 'productive'; label = 'Productive — fitness improving from balanced training' }
  else { status = 'maintaining'; label = 'Maintaining — consistent training, stable fitness' }

  return { dailyLoads, ctl: +ctl.toFixed(1), atl: +atl.toFixed(1), tsb: +tsb.toFixed(1), trainingStatus: status, trainingStatusLabel: label, history }
}

export async function calculateRecovery(days: number = 30): Promise<RecoveryAnalysis> {
  const data = await loadActivityData(days)
  if (data.length < 3) {
    return {
      recoveryScore: 50, recoveryStatus: 'fair', estimatedRecoveryHours: 24, readinessToTrain: true,
      factors: [], sleepRecommendation: { baseNeed: 8, trainingAdjustment: 0, totalRecommended: 8, reasoning: 'Not enough data.' },
    }
  }

  const factors: RecoveryFactor[] = []
  const maxHR = estimateMaxHR(data)

  // HRV Factor
  const hrvValues = data.filter(d => d.hrv > 0).map(d => d.hrv)
  if (hrvValues.length >= 5) {
    const mean = hrvValues.reduce((s, v) => s + v, 0) / hrvValues.length
    const std = Math.sqrt(hrvValues.reduce((s, v) => s + (v - mean) ** 2, 0) / hrvValues.length)
    const latest = hrvValues[hrvValues.length - 1]
    const zScore = std > 0 ? (latest - mean) / std : 0
    const score = Math.min(100, Math.max(0, 50 + zScore * 20))
    factors.push({
      name: 'HRV Recovery', score: Math.round(score), weight: RECOVERY_WEIGHTS.hrv,
      observation: zScore > 0.5 ? `HRV ${latest}ms above baseline (${Math.round(mean)}ms) — good recovery.`
        : zScore < -0.5 ? `HRV ${latest}ms below baseline (${Math.round(mean)}ms) — system under stress.`
        : `HRV ${latest}ms near baseline (${Math.round(mean)}ms) — normal.`,
    })
  }

  // Resting HR Factor
  const rhrValues = data.filter(d => d.restingHr > 0).map(d => d.restingHr)
  if (rhrValues.length >= 3) {
    const mean = rhrValues.reduce((s, v) => s + v, 0) / rhrValues.length
    const latest = rhrValues[rhrValues.length - 1]
    const diff = latest - mean
    const score = Math.min(100, Math.max(0, 70 - diff * 8))
    factors.push({
      name: 'Resting Heart Rate', score: Math.round(score), weight: RECOVERY_WEIGHTS.restingHr,
      observation: diff > 3 ? `RHR ${latest}bpm elevated (+${Math.round(diff)} above baseline).`
        : diff < -2 ? `RHR ${latest}bpm below baseline — excellent recovery.`
        : `RHR ${latest}bpm near baseline (${Math.round(mean)}bpm).`,
    })
  }

  // Sleep Factor
  const recentSleep = data.slice(-7).filter(d => d.sleepHours > 0)
  if (recentSleep.length >= 3) {
    const avgSleep = recentSleep.reduce((s, d) => s + d.sleepHours, 0) / recentSleep.length
    const avgDeep = recentSleep.reduce((s, d) => s + d.deepSleepPct, 0) / recentSleep.length
    let score = 50
    if (avgSleep >= 7 && avgSleep <= 9) score += 25; else if (avgSleep >= 6) score += 10; else score -= 20
    if (avgDeep >= 15) score += 15; else if (avgDeep >= 10) score += 5
    const lastNight = recentSleep[recentSleep.length - 1]
    if (lastNight.sleepHours >= 7) score += 10; else if (lastNight.sleepHours < 5) score -= 15
    score = Math.min(100, Math.max(0, score))
    factors.push({
      name: 'Sleep Quality', score: Math.round(score), weight: RECOVERY_WEIGHTS.sleepQuality,
      observation: avgSleep >= 7 ? `Averaging ${avgSleep.toFixed(1)}h sleep — meeting recovery needs.`
        : `Only ${avgSleep.toFixed(1)}h sleep — below optimal 7-9h.`,
    })
  }

  // Training Load Factor
  const trainingLoad = await calculateTrainingLoad(days)
  const acwr = trainingLoad.ctl > 0 ? trainingLoad.atl / trainingLoad.ctl : 1
  let loadScore = acwr >= 0.8 && acwr <= 1.3 ? 80 : acwr < 0.8 ? 60 : acwr > 1.5 ? 20 : 40
  if (trainingLoad.tsb > 10) loadScore += 15; else if (trainingLoad.tsb < -15) loadScore -= 15
  loadScore = Math.min(100, Math.max(0, loadScore))
  factors.push({
    name: 'Training Load', score: Math.round(loadScore), weight: RECOVERY_WEIGHTS.trainingLoad,
    observation: acwr > 1.5 ? `ACWR ${acwr.toFixed(2)} — danger zone, reduce intensity.`
      : acwr >= 0.8 && acwr <= 1.3 ? `ACWR ${acwr.toFixed(2)} — sweet spot.`
      : acwr < 0.5 ? `ACWR ${acwr.toFixed(2)} — low volume relative to fitness.`
      : `ACWR ${acwr.toFixed(2)} — moderately elevated.`,
  })

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0)
  const recoveryScore = totalWeight > 0 ? Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight) : 50
  const recoveryStatus: RecoveryAnalysis['recoveryStatus'] =
    recoveryScore >= 80 ? 'optimal' : recoveryScore >= 65 ? 'good' : recoveryScore >= 45 ? 'fair' : recoveryScore >= 25 ? 'poor' : 'critical'

  const lastTrimp = trainingLoad.dailyLoads.length > 0 ? trainingLoad.dailyLoads[trainingLoad.dailyLoads.length - 1].trimp : 0
  const estimatedRecoveryHours = Math.min(72, Math.round(12 + (lastTrimp / 5) + (recoveryScore < 50 ? 12 : 0)))

  // Sleep recommendation
  const last7 = trainingLoad.dailyLoads.slice(-7)
  const weeklyTrimp = last7.reduce((s, d) => s + d.trimp, 0)
  const cappedAdj = Math.min(2, parseFloat((weeklyTrimp / 50 * 0.25).toFixed(1)))
  const totalRec = parseFloat((7.5 + cappedAdj).toFixed(1))
  const avgSl = recentSleep.length > 0 ? recentSleep.reduce((s, d) => s + d.sleepHours, 0) / recentSleep.length : 0
  let reasoning = weeklyTrimp > 200 ? `High training load (${Math.round(weeklyTrimp)} TRIMP). Athletes need 8-10h during heavy training.`
    : weeklyTrimp > 100 ? `Moderate load (${Math.round(weeklyTrimp)} TRIMP). Extra ${(cappedAdj * 60).toFixed(0)}min sleep supports recovery.`
    : `Light load (${Math.round(weeklyTrimp)} TRIMP). 7.5-8h sleep should suffice.`
  if (avgSl > 0 && avgSl < totalRec - 0.5) reasoning += ` Currently ${avgSl.toFixed(1)}h — ${((totalRec - avgSl) * 60).toFixed(0)}min short.`

  return {
    recoveryScore, recoveryStatus, estimatedRecoveryHours,
    readinessToTrain: recoveryScore >= 45 && trainingLoad.tsb > -25,
    factors,
    sleepRecommendation: { baseNeed: 7.5, trainingAdjustment: cappedAdj, totalRecommended: totalRec, reasoning },
  }
}

export async function buildFitnessProfile(days: number = 90): Promise<FitnessProfile> {
  const data = await loadActivityData(days)

  const vo2Values = data.filter(d => d.vo2Max > 0).map(d => d.vo2Max)
  const vo2Max = vo2Values.length > 0 ? vo2Values[vo2Values.length - 1] : null
  let vo2Trend: FitnessProfile['vo2Trend'] = null
  if (vo2Values.length >= 2) {
    vo2Trend = vo2Values[vo2Values.length - 1] > vo2Values[0] + 0.5 ? 'improving'
      : vo2Values[vo2Values.length - 1] < vo2Values[0] - 0.5 ? 'declining' : 'stable'
  }
  const vo2Category = vo2Max ? VO2_CATEGORIES.find(c => vo2Max <= c.max)?.label || 'Unknown' : 'Unknown'

  const rhrValues = data.filter(d => d.restingHr > 0).map(d => d.restingHr)
  const restingHr = rhrValues.length > 0 ? Math.round(rhrValues.reduce((s, v) => s + v, 0) / rhrValues.length) : null
  let rhrTrend: FitnessProfile['rhrTrend'] = null
  if (rhrValues.length >= 3) {
    const first = rhrValues.slice(0, Math.floor(rhrValues.length / 2))
    const second = rhrValues.slice(Math.floor(rhrValues.length / 2))
    const a1 = first.reduce((s, v) => s + v, 0) / first.length
    const a2 = second.reduce((s, v) => s + v, 0) / second.length
    rhrTrend = a2 < a1 - 1 ? 'improving' : a2 > a1 + 1 ? 'worsening' : 'stable'
  }
  const rhrCategory = restingHr ? RHR_CATEGORIES.find(c => restingHr <= c.max)?.label || 'Unknown' : 'Unknown'

  const hrvValues = data.filter(d => d.hrv > 0).map(d => d.hrv)
  const hrvBaseline = hrvValues.length >= 7 ? Math.round(hrvValues.reduce((s, v) => s + v, 0) / hrvValues.length) : null
  const hrvCurrent = hrvValues.length > 0 ? hrvValues[hrvValues.length - 1] : null
  let hrvTrend: FitnessProfile['hrvTrend'] = null
  if (hrvValues.length >= 7) {
    const recent = hrvValues.slice(-7)
    const older = hrvValues.slice(0, -7)
    if (older.length >= 3) {
      const ar = recent.reduce((s, v) => s + v, 0) / recent.length
      const ao = older.reduce((s, v) => s + v, 0) / older.length
      hrvTrend = ar > ao + 3 ? 'improving' : ar < ao - 3 ? 'declining' : 'stable'
    }
  }

  const last7 = data.slice(-7)
  const weeklyExerciseMinutes = Math.round(last7.reduce((s, d) => s + d.exerciseMinutes, 0))
  const weeklyActiveCalories = Math.round(last7.reduce((s, d) => s + d.activeCalories, 0))
  const last30 = data.slice(-30)
  const exerciseConsistencyPct = last30.length > 0
    ? Math.round((last30.filter(d => d.exerciseMinutes >= 20).length / last30.length) * 100) : 0

  let score = 0, components = 0
  if (vo2Max) { score += Math.min(100, Math.max(0, (vo2Max - 20) * (100 / 40))); components++ }
  if (restingHr) { score += Math.min(100, Math.max(0, (80 - restingHr) * (100 / 40))); components++ }
  if (hrvBaseline) { score += Math.min(100, Math.max(0, (hrvBaseline - 20) * (100 / 60))); components++ }
  score += Math.min(100, exerciseConsistencyPct); components++
  const fitnessScore = components > 0 ? Math.round(score / components) : 0
  const fitnessLevel = fitnessScore >= 85 ? 'Elite' : fitnessScore >= 70 ? 'Advanced' : fitnessScore >= 50 ? 'Intermediate' : fitnessScore >= 30 ? 'Developing' : 'Beginner'

  return {
    vo2Max, vo2Trend, vo2Category, restingHr, rhrTrend, rhrCategory,
    hrvBaseline, hrvCurrent, hrvTrend, weeklyExerciseMinutes, weeklyActiveCalories,
    exerciseConsistencyPct, fitnessScore, fitnessLevel,
  }
}

export async function getFullFitnessAnalysis(days: number = 90): Promise<FitnessAnalysisResult> {
  const [trainingLoad, recovery, profile] = await Promise.all([
    calculateTrainingLoad(days),
    calculateRecovery(Math.min(days, 30)),
    buildFitnessProfile(days),
  ])

  const insights: string[] = []
  insights.push(`Training: ${trainingLoad.trainingStatusLabel} (CTL: ${trainingLoad.ctl}, ATL: ${trainingLoad.atl}, Form: ${trainingLoad.tsb > 0 ? '+' : ''}${trainingLoad.tsb}).`)
  if (recovery.recoveryScore < 45) {
    insights.push(`Recovery alert: ${recovery.recoveryScore}/100 (${recovery.recoveryStatus}). Consider rest. ${recovery.sleepRecommendation.reasoning}`)
  } else if (recovery.recoveryScore >= 75) {
    insights.push(`Recovery strong (${recovery.recoveryScore}/100). Ready for productive training.`)
  }
  if (profile.vo2Max) {
    insights.push(`VO2 max ${profile.vo2Max} mL/kg/min (${profile.vo2Category}). ${profile.vo2Trend === 'improving' ? 'Aerobic fitness improving.' : profile.vo2Trend === 'declining' ? 'VO2 declining — increase aerobic work.' : 'Stable — vary intensity for adaptation.'}`)
  }
  if (recovery.sleepRecommendation.trainingAdjustment > 0.3) {
    insights.push(`Sleep need: ${recovery.sleepRecommendation.totalRecommended}h (base + training adjustment).`)
  }

  return { trainingLoad, recovery, profile, insights }
}
