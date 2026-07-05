import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateRecovery, calculateTrainingLoad } from './fitness-analysis'

const getDbMock = vi.fn()

vi.mock('../../db/database', () => ({
  getDb: () => getDbMock(),
}))

vi.mock('./strava.service', () => ({
  syncStravaStreams: vi.fn(),
}))

vi.mock('../../lib/settings', () => ({
  getAppSettings: vi.fn(() => ({})),
  getSetting: vi.fn((_key: string, fallback: unknown) => fallback),
}))

interface MetricRow {
  date: string
  value_json: string
}

type MetricRowsByType = Record<string, MetricRow[]>

function setMetricRows(rowsByType: MetricRowsByType): void {
  getDbMock.mockReturnValue({
    prepare: () => ({
      all: (metricType: string) => rowsByType[metricType] ?? [],
    }),
  })
}

function isoDay(day: number): string {
  return `2026-04-${String(day).padStart(2, '0')}`
}

function metricRow(date: string, value: Record<string, unknown>): MetricRow {
  return { date, value_json: JSON.stringify(value) }
}

function trainingRows(
  trimpPattern: Array<{ days: number; avgHR: number; duration: number; maxHR?: number }>,
): MetricRowsByType {
  const rowsByType: MetricRowsByType = {
    workout: [],
    resting_heart_rate: [],
    exercise_time: [],
    heart_rate: [],
    hrv: [],
    sleep: [],
  }

  let day = 1
  for (const block of trimpPattern) {
    for (let i = 0; i < block.days; i++) {
      const date = isoDay(day)
      rowsByType.workout.push(
        metricRow(date, {
          workouts: [
            {
              name: 'Run',
              duration: block.duration,
              avgHR: block.avgHR,
              maxHR: block.maxHR ?? 180,
            },
          ],
        }),
      )
      rowsByType.resting_heart_rate.push(metricRow(date, { qty: 60 }))
      rowsByType.exercise_time.push(metricRow(date, { qty: block.duration }))
      rowsByType.heart_rate.push(metricRow(date, { Avg: block.avgHR, Max: block.maxHR ?? 180 }))
      rowsByType.hrv.push(metricRow(date, { qty: 60 }))
      rowsByType.sleep.push(metricRow(date, { totalAsleep: 480, deep: 90 }))
      day += 1
    }
  }

  return rowsByType
}

function constantTrainingRows(days: number, avgHR = 150, duration = 60): MetricRowsByType {
  return trainingRows([{ days, avgHR, duration }])
}

function expectedTrimp(duration: number, avgHR: number, restHR = 60, maxHR = 180): number {
  const hrr = (avgHR - restHR) / (maxHR - restHR)
  return Number((duration * hrr * 0.64 * Math.exp(1.92 * hrr)).toFixed(1))
}

function expectedLoad(trimpValues: number[]): { ctl: number; atl: number; tsb: number } {
  let ctl = 0
  let atl = 0

  for (const trimp of trimpValues) {
    ctl = ctl * (1 - 1 / 42) + trimp * (1 / 42)
    atl = atl * (1 - 1 / 7) + trimp * (1 / 7)
  }

  return {
    ctl: Number(ctl.toFixed(1)),
    atl: Number(atl.toFixed(1)),
    tsb: Number((ctl - atl).toFixed(1)),
  }
}

describe('calculateTrainingLoad', () => {
  beforeEach(() => {
    getDbMock.mockReset()
  })

  it('calculates daily TRIMP with the Banister formula through exported training load', () => {
    setMetricRows(constantTrainingRows(1, 150, 60))

    const result = calculateTrainingLoad(1)

    expect(result.dailyLoads[0].trimp).toBe(expectedTrimp(60, 150))
  })

  it('calculates CTL, ATL, and TSB over 50 days using 42-day and 7-day time constants', () => {
    const rows = constantTrainingRows(50, 150, 60)
    setMetricRows(rows)

    const result = calculateTrainingLoad(50)
    const dailyTrimp = expectedTrimp(60, 150)
    const expected = expectedLoad(Array.from({ length: 50 }, () => dailyTrimp))

    expect(result.ctl).toBe(expected.ctl)
    expect(result.atl).toBe(expected.atl)
    expect(result.tsb).toBe(expected.tsb)
    expect(result.history).toHaveLength(50)
  })

  it('handles no data, a single day, and zero-TRIMP days', () => {
    setMetricRows({})
    expect(calculateTrainingLoad(90)).toMatchObject({
      dailyLoads: [],
      ctl: 0,
      atl: 0,
      tsb: 0,
      trainingStatus: 'detraining',
    })

    setMetricRows(constantTrainingRows(1, 150, 60))
    expect(calculateTrainingLoad(1).dailyLoads).toHaveLength(1)

    setMetricRows(constantTrainingRows(3, 60, 0))
    const zeroLoad = calculateTrainingLoad(3)
    expect(zeroLoad.dailyLoads.map((day) => day.trimp)).toEqual([0, 0, 0])
    expect(zeroLoad.ctl).toBe(0)
    expect(zeroLoad.atl).toBe(0)
  })

  it('classifies representative training status thresholds through exported results', () => {
    setMetricRows({})
    expect(calculateTrainingLoad(90).trainingStatus).toBe('detraining')

    setMetricRows(trainingRows([{ days: 50, avgHR: 150, duration: 20 }]))
    expect(calculateTrainingLoad(50).trainingStatus).toBe('productive')

    setMetricRows(
      trainingRows([
        { days: 40, avgHR: 165, duration: 120 },
        { days: 10, avgHR: 60, duration: 0 },
      ]),
    )
    expect(calculateTrainingLoad(50).trainingStatus).toBe('peaking')

    setMetricRows(
      trainingRows([
        { days: 40, avgHR: 120, duration: 30 },
        { days: 10, avgHR: 175, duration: 180 },
      ]),
    )
    expect(calculateTrainingLoad(50).trainingStatus).toBe('overreaching')
  })
})

describe('calculateRecovery', () => {
  beforeEach(() => {
    getDbMock.mockReset()
  })

  it('flags ACWR above 1.5 as injury risk in the training load factor', () => {
    setMetricRows(
      trainingRows([
        { days: 40, avgHR: 120, duration: 30 },
        { days: 10, avgHR: 175, duration: 180 },
      ]),
    )

    const result = calculateRecovery(50)
    const loadFactor = result.factors.find((factor) => factor.name === 'Training Load Balance')

    expect(loadFactor?.score).toBeLessThanOrEqual(20)
    expect(loadFactor?.observation).toContain('danger zone')
    expect(result.readinessToTrain).toBe(false)
  })

  it('calculates the weighted recovery composite from HRV, resting HR, sleep, and training load', () => {
    const rows = trainingRows([{ days: 7, avgHR: 150, duration: 60 }])
    rows.hrv = [50, 52, 54, 56, 70, 72, 80].map((hrv, index) =>
      metricRow(isoDay(index + 1), { qty: hrv }),
    )
    rows.resting_heart_rate = [62, 61, 60, 60, 59, 58, 57].map((rhr, index) =>
      metricRow(isoDay(index + 1), { qty: rhr }),
    )
    rows.sleep = Array.from({ length: 7 }, (_, index) =>
      metricRow(isoDay(index + 1), { totalAsleep: 480, deep: 90 }),
    )
    setMetricRows(rows)

    const result = calculateRecovery(7)
    const expectedComposite = Math.round(
      result.factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) /
        result.factors.reduce((sum, factor) => sum + factor.weight, 0),
    )

    expect(result.factors.map((factor) => factor.name)).toEqual([
      'HRV Recovery',
      'Resting Heart Rate',
      'Sleep Quality',
      'Training Load Balance',
    ])
    expect(result.recoveryScore).toBe(expectedComposite)
    expect(result.recoveryStatus).toBe('good')
  })

  it('returns the documented fallback for fewer than three days of data', () => {
    setMetricRows(constantTrainingRows(1, 150, 60))

    expect(calculateRecovery(1)).toMatchObject({
      recoveryScore: 50,
      recoveryStatus: 'fair',
      estimatedRecoveryHours: 24,
      readinessToTrain: true,
      factors: [],
    })
  })
})
