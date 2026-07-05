import { generateAnalysisStreaming } from '../ai.service'
import { getDb } from '../../db/database'
import { getFullFitnessAnalysis } from './fitness-analysis'
import { getSportFromName, type Sport } from './hr-zones.service'
import { getWorkoutDetail, type ActivityDetail } from './workout-detail.service'

interface HistoryWorkout {
  date: string
  name: string
  durationMin: number
  distanceMi: number
  avgHr: number
  maxHr: number
  paceMinPerMi: number | null
  elevationFt: number
  stravaId?: number | string
}

interface MetricPoint {
  date: string
  value: number
}

interface WorkoutSplit {
  index: number
  distanceMi: number
  durationSec: number
  paceMinPerMi: number | null
  elevationFt: number
}

function durationToMinutes(value: unknown): number {
  const raw = Number(value || 0)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw > 200 ? raw / 60 : raw
}

function paceFromWorkout(workout: Record<string, unknown>, durationMin: number): number | null {
  const avgSpeed = Number(workout.avgSpeed || 0)
  if (avgSpeed > 0) {
    const pace = 26.8224 / avgSpeed
    return pace > 3 && pace < 30 ? pace : null
  }
  const distance = Number(workout.distance || 0)
  if (distance > 0 && durationMin > 0) return durationMin / distance
  return null
}

function summarizeNumber(values: number[]): {
  count: number
  avg: number | null
  min: number | null
  max: number | null
} {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0)
  if (clean.length === 0) return { count: 0, avg: null, min: null, max: null }
  const sum = clean.reduce((a, b) => a + b, 0)
  return {
    count: clean.length,
    avg: Number((sum / clean.length).toFixed(2)),
    min: Number(Math.min(...clean).toFixed(2)),
    max: Number(Math.max(...clean).toFixed(2)),
  }
}

function summarizeSamples(values: number[]): {
  count: number
  avg: number | null
  min: number | null
  max: number | null
  start: number | null
  end: number | null
} {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0)
  const summary = summarizeNumber(clean)
  return {
    ...summary,
    start: clean.length > 0 ? Number(clean[0].toFixed(2)) : null,
    end: clean.length > 0 ? Number(clean[clean.length - 1].toFixed(2)) : null,
  }
}

function trend(values: MetricPoint[]): 'improving' | 'stable' | 'declining' | 'insufficient' {
  if (values.length < 4) return 'insufficient'
  const sorted = [...values].sort((a, b) => a.date.localeCompare(b.date))
  const midpoint = Math.floor(sorted.length / 2)
  const first = summarizeNumber(sorted.slice(0, midpoint).map((p) => p.value)).avg
  const second = summarizeNumber(sorted.slice(midpoint).map((p) => p.value)).avg
  if (first == null || second == null || first === 0) return 'insufficient'
  const pct = ((second - first) / first) * 100
  if (Math.abs(pct) < 2) return 'stable'
  return pct > 0 ? 'improving' : 'declining'
}

function getRecentVo2(days = 365): MetricPoint[] {
  const rows = getDb()
    .prepare(
      `SELECT date, value_json
       FROM health_metrics
       WHERE metric_type = 'vo2_max'
         AND date >= date('now', '-' || ? || ' days')
       ORDER BY date ASC`,
    )
    .all(days) as Array<{ date: string; value_json: string }>

  const points: MetricPoint[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value_json)
      const value =
        typeof parsed === 'number'
          ? parsed
          : Number(parsed?.qty ?? parsed?.value ?? parsed?.vo2Max ?? parsed?.vo2_max ?? 0)
      if (value > 0) points.push({ date: row.date, value })
    } catch {}
  }
  return points
}

function getRecentSportHistory(sport: Sport, days = 180, excludeKey?: string): HistoryWorkout[] {
  const rows = getDb()
    .prepare(
      `SELECT date, value_json
       FROM health_metrics
       WHERE metric_type = 'workout'
         AND date >= date('now', '-' || ? || ' days')
       ORDER BY date DESC`,
    )
    .all(days) as Array<{ date: string; value_json: string }>

  const history: HistoryWorkout[] = []
  for (const row of rows) {
    let parsed: any
    try {
      parsed = JSON.parse(row.value_json)
    } catch {
      continue
    }
    const workouts = Array.isArray(parsed?.workouts) ? parsed.workouts : []
    for (let i = 0; i < workouts.length; i++) {
      const workout = workouts[i]
      if (getSportFromName(workout?.name || workout?.sportType || workout?.type) !== sport) {
        continue
      }
      const stravaKey = workout?.stravaId ? `strava-${workout.stravaId}` : null
      const haeKey = `hae-${row.date}-${i}`
      if (excludeKey && (stravaKey === excludeKey || haeKey === excludeKey)) continue

      const durationMin = durationToMinutes(workout?.duration)
      const distanceMi = Number(workout?.distance || 0)
      history.push({
        date: row.date,
        name: String(workout?.name || 'Workout'),
        durationMin: Number(durationMin.toFixed(1)),
        distanceMi: Number(distanceMi.toFixed(2)),
        avgHr: Math.round(Number(workout?.avgHR || 0)),
        maxHr: Math.round(Number(workout?.maxHR || 0)),
        paceMinPerMi: paceFromWorkout(workout, durationMin),
        elevationFt: Math.round(Number(workout?.elevationGain || 0) * 3.28084),
        stravaId: workout?.stravaId,
      })
    }
  }
  return history
}

function parseSplits(workout: Record<string, any>): WorkoutSplit[] {
  const raw = Array.isArray(workout.splitsStandard)
    ? workout.splitsStandard
    : Array.isArray(workout.splitsMetric)
      ? workout.splitsMetric
      : []
  return raw.slice(0, 12).map((split: any, index: number) => {
    const distanceMeters = Number(split.distance || 0)
    const distanceMi = distanceMeters * 0.000621371
    const durationSec = Number(split.movingTime || split.elapsedTime || 0)
    const paceMinPerMi = distanceMi > 0 && durationSec > 0 ? durationSec / 60 / distanceMi : null
    return {
      index: Number(split.split || index + 1),
      distanceMi: Number(distanceMi.toFixed(2)),
      durationSec: Math.round(durationSec),
      paceMinPerMi: paceMinPerMi ? Number(paceMinPerMi.toFixed(2)) : null,
      elevationFt: Math.round(Number(split.elevationDifference || 0) * 3.28084),
    }
  })
}

function buildReportContext(detail: ActivityDetail): Record<string, unknown> {
  const workout = detail.workout
  const durationMin = durationToMinutes(workout.duration)
  const distanceMi = Number(workout.distance || 0)
  const paceMinPerMi =
    detail.sport === 'run' && distanceMi > 0 && durationMin > 0 ? durationMin / distanceMi : null
  const streamSamples = detail.streams.sampled || []
  const hrSamples = streamSamples.map((p) => p.hr).filter((v): v is number => typeof v === 'number')
  const paceSamples = streamSamples
    .map((p) => p.paceMinPerMi)
    .filter((v): v is number => typeof v === 'number')
  const history = getRecentSportHistory(detail.sport, 180, detail.key)
  const vo2 = getRecentVo2(365)
  const fitness = getFullFitnessAnalysis(180)
  const recentRuns = history.slice(0, 12).map((item) => ({
    date: item.date,
    durationMin: item.durationMin,
    distanceMi: item.distanceMi,
    paceMinPerMi: item.paceMinPerMi ? Number(item.paceMinPerMi.toFixed(2)) : null,
    avgHr: item.avgHr || null,
    maxHr: item.maxHr || null,
    elevationFt: item.elevationFt,
  }))

  return {
    activity: {
      key: detail.key,
      date: detail.date,
      name: workout.name || workout.sportType || 'Workout',
      source: workout.source || null,
      device: workout.deviceName || null,
      durationMin: Number(durationMin.toFixed(1)),
      distanceMi: Number(distanceMi.toFixed(2)),
      paceMinPerMi: paceMinPerMi ? Number(paceMinPerMi.toFixed(2)) : null,
      avgHr: Number(workout.avgHR || 0),
      maxHr: Number(workout.maxHR || 0),
      calories: Number(workout.calories || 0),
      elevationFt: Math.round(Number(workout.elevationGain || 0) * 3.28084),
      cadence: Number(workout.avgCadence || 0),
      avgWatts: Number(workout.avgWatts || 0),
      normalizedPower: Number(workout.normalizedPower || 0),
      sufferScore: Number(workout.sufferScore || 0),
    },
    heartRate: {
      model: detail.hr.model,
      maxHr: detail.hr.maxHr,
      restingHr: detail.hr.restingHr,
      lthr: detail.hr.lthr,
      source: detail.hr.source,
      timeInZones: detail.hr.distribution.map((zone) => ({
        zone: zone.zone,
        bpm: `${zone.minBpm}-${zone.maxBpm === 999 ? 'max' : zone.maxBpm}`,
        minutes: Number((zone.seconds / 60).toFixed(1)),
        pct: zone.pct,
      })),
      streamSampleSummary: summarizeSamples(hrSamples),
    },
    pace: {
      streamSampleSummary: summarizeSamples(paceSamples),
      splits: parseSplits(workout),
      bestEfforts: Array.isArray(workout.bestEfforts)
        ? workout.bestEfforts.slice(0, 8).map((effort: any) => ({
            name: effort.name,
            distanceMeters: Number(effort.distance || 0),
            movingTimeSec: Number(effort.movingTime || 0),
            prRank: effort.prRank ?? null,
          }))
        : [],
    },
    personalHistory: {
      windowDays: 180,
      sport: detail.sport,
      workoutCount: history.length,
      duration: summarizeNumber(history.map((w) => w.durationMin)),
      distance: summarizeNumber(history.map((w) => w.distanceMi)),
      avgHr: summarizeNumber(history.map((w) => w.avgHr)),
      pace: summarizeNumber(history.map((w) => w.paceMinPerMi || 0)),
      recentWorkouts: recentRuns,
      comparison90d: detail.comparison,
    },
    vo2Max: {
      recentPoints: vo2.slice(-12),
      latest: vo2.at(-1) || null,
      count365d: vo2.length,
      trend: trend(vo2),
    },
    fitnessAnalysis: {
      trainingLoad: {
        ctl: fitness.trainingLoad.ctl,
        atl: fitness.trainingLoad.atl,
        tsb: fitness.trainingLoad.tsb,
        trainingStatus: fitness.trainingLoad.trainingStatus,
        trainingStatusLabel: fitness.trainingLoad.trainingStatusLabel,
        recentDailyLoads: fitness.trainingLoad.dailyLoads.slice(-14),
      },
      recovery: {
        recoveryScore: fitness.recovery.recoveryScore,
        recoveryStatus: fitness.recovery.recoveryStatus,
        estimatedRecoveryHours: fitness.recovery.estimatedRecoveryHours,
        readinessToTrain: fitness.recovery.readinessToTrain,
        factors: fitness.recovery.factors,
        sleepRecommendation: fitness.recovery.sleepRecommendation,
      },
      profile: fitness.profile,
      insights: fitness.insights,
    },
    dataQuality: {
      hasSecondBySecondStreams: detail.streams.hasData,
      streamSeconds: detail.streams.seconds.length,
      hrZoneSource: detail.hr.source,
      historyWorkoutCount: history.length,
      vo2PointCount: vo2.length,
    },
  }
}

export async function generateWorkoutAiReport(key: string): Promise<string> {
  const detail = getWorkoutDetail(key)
  if (!detail) throw new Error('Workout not found')

  const systemPrompt = `You are an exercise physiologist and running analyst inside a local personal health dashboard.

Create a scientific, individualized workout report from the provided local data. Be precise, quantified, and cautious.

Methodology to apply:
- Interpret heart rate using the provided personal zone model, resting HR, max HR, LTHR when present, and time-in-zone distribution.
- Evaluate pace and duration together: a shorter/faster run and a longer/slower aerobic run are different training signals.
- Compare the activity with the user's own recent same-sport history before making performance claims.
- Use training-load concepts from TRIMP, chronic/acute load, CTL/ATL/TSB, and recovery readiness when available.
- Treat wearable VO2 max as an estimate, not a lab measurement. Discuss whether it is plausible based on running pace, HR response, trend stability, and enough recent outdoor run data.
- Note that Apple Watch heart-rate data is generally useful for trends but can vary during movement, sweat, sensor fit, cadence lock, and intervals. Energy expenditure and VO2 max estimates are less certain than raw pace, duration, and GPS distance.
- Do not diagnose disease, prescribe medical treatment, or overstate certainty.

Output plain text in these sections:
1. Bottom line
2. Heart-rate physiology
3. Pace, duration, and efficiency
4. Fitness history and training-load context
5. VO2 max confidence
6. Data-quality notes
7. Next training move

Keep the report under 900 words. Use concrete numbers from the data. If a data source is missing, say what conclusion cannot be supported.`

  const userPrompt = `Generate a comprehensive exercise-science report for this workout.

Local workout and fitness context JSON:
${JSON.stringify(buildReportContext(detail), null, 2)}`

  return await generateAnalysisStreaming(
    systemPrompt,
    userPrompt,
    { maxTokens: 3000 },
    'workout-ai-report',
  )
}
