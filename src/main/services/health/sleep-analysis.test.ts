import { describe, expect, it, vi } from 'vitest'
import {
  calculateSleepDebt,
  parseSleepSessions,
  predictCircadianRhythm,
  recommendWakeTime,
  scoreSleepQuality,
  type SleepSession,
} from './sleep-analysis'

const getDbMock = vi.hoisted(() => vi.fn())

vi.mock('../../db/database', () => ({
  getDb: () => getDbMock(),
}))

vi.mock('../../lib/settings', () => ({
  getAppSettings: vi.fn(() => ({})),
}))

function makeSession(overrides: Partial<SleepSession> = {}): SleepSession {
  return {
    date: '2026-05-01',
    totalInBed: 510,
    totalAsleep: 480,
    deepSleep: 90,
    remSleep: 110,
    coreSleep: 240,
    awakeTime: 15,
    sleepStart: '23:00',
    sleepEnd: '07:00',
    sleepLatency: 15,
    ...overrides,
  }
}

function metricSleepRow(date: string, totalAsleep: number): { date: string; value_json: string } {
  return {
    date,
    value_json: JSON.stringify({
      totalAsleep,
      totalInBed: totalAsleep + 20,
      deep: totalAsleep > 60 ? 90 : 0,
      rem: totalAsleep > 60 ? 100 : 0,
    }),
  }
}

describe('calculateSleepDebt', () => {
  it('calculates 14-night sleep debt using the documented exponential decay weights', () => {
    const sessions = Array.from({ length: 14 }, (_, index) =>
      makeSession({
        date: `2026-05-${String(14 - index).padStart(2, '0')}`,
        totalAsleep: index < 7 ? 360 : 480,
        deepSleep: index < 7 ? 30 : 120,
        remSleep: index < 7 ? 30 : 120,
      }),
    )

    // Pass an explicit need so this test exercises the weighting math
    // deterministically (the production default resolves need from the DB).
    const result = calculateSleepDebt(sessions, 8)

    const lastNightWeight = 0.15
    const remainingWeight = 0.85
    const totalDecay = Array.from({ length: 13 }, (_, index) => Math.pow(0.85, index)).reduce(
      (sum, value) => sum + value,
      0,
    )
    const weightedDebt = sessions.reduce((sum, session, index) => {
      const sleptHours = session.totalAsleep / 60
      const debt = Math.max(0, 8 - sleptHours)
      const weight =
        index === 0 ? lastNightWeight : (remainingWeight * Math.pow(0.85, index - 1)) / totalDecay
      return sum + debt * weight
    }, 0)

    expect(result.currentDebt).toBe(Number((weightedDebt * 14).toFixed(1)))
    expect(result.debtCategory).toBe('severe')
    expect(result.sleepNeedEstimate).toBe(8)
    expect(result.last14Nights).toHaveLength(14)
  })

  it('handles empty data and a single night without throwing', () => {
    expect(calculateSleepDebt([])).toMatchObject({
      currentDebt: 0,
      debtCategory: 'low',
      last14Nights: [],
    })

    const singleNight = calculateSleepDebt([makeSession({ totalAsleep: 420 })])

    expect(singleNight.currentDebt).toBe(0.1)
    expect(singleNight.last14Nights).toHaveLength(1)
  })

  it('handles all-zero nights without throwing or producing NaN', () => {
    const result = calculateSleepDebt(
      Array.from({ length: 14 }, (_, index) =>
        makeSession({
          date: `2026-05-${String(index + 1).padStart(2, '0')}`,
          totalAsleep: 0,
        }),
      ),
    )

    // With no usable durations, need falls back to the default and debt is a
    // large-but-finite number rather than NaN.
    expect(Number.isFinite(result.currentDebt)).toBe(true)
    expect(result.debtCategory).toBe('severe')
  })
})

describe('parseSleepSessions', () => {
  it('continues past short fragments until it returns the requested valid nights', () => {
    const rows = [
      metricSleepRow('2026-05-14', 480),
      metricSleepRow('2026-05-13', 25),
      metricSleepRow('2026-05-12', 30),
      metricSleepRow('2026-05-11', 470),
      metricSleepRow('2026-05-10', 460),
    ]
    getDbMock.mockReturnValue({
      prepare: () => ({
        all: (limit: number, offset: number) => rows.slice(offset, offset + limit),
      }),
    })

    const sessions = parseSleepSessions(3)

    expect(sessions.map((session) => session.date)).toEqual([
      '2026-05-14',
      '2026-05-11',
      '2026-05-10',
    ])
  })
})

describe('scoreSleepQuality', () => {
  it('scores known stage, efficiency, consistency, and composite values', () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      makeSession({ date: `2026-05-0${index + 1}` }),
    )

    const result = scoreSleepQuality(sessions[0], sessions)

    expect(result.deepSleepScore).toBe(100)
    expect(result.remScore).toBe(95)
    expect(result.coreSleepScore).toBe(100)
    expect(result.wasoScore).toBe(95)
    expect(result.efficiencyScore).toBe(96)
    expect(result.consistencyScore).toBe(95)
    expect(result.cycleCompletion).toBe(5.3)
    expect(result.overall).toBe(96)
  })

  it('keeps every sub-score in the 0-100 range for zero-duration data', () => {
    const result = scoreSleepQuality(
      makeSession({
        totalInBed: 0,
        totalAsleep: 0,
        deepSleep: 0,
        remSleep: 0,
        coreSleep: 0,
        awakeTime: 0,
      }),
      [],
    )

    expect(result.overall).toBeGreaterThanOrEqual(0)
    expect(result.overall).toBeLessThanOrEqual(100)
    expect(result.deepSleepScore).toBeGreaterThanOrEqual(0)
    expect(result.remScore).toBeGreaterThanOrEqual(0)
    expect(result.efficiencyScore).toBeGreaterThanOrEqual(0)
  })
})

describe('predictCircadianRhythm', () => {
  it('derives the five energy phases from a known habitual sleep and wake pattern', () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      makeSession({
        date: `2026-05-0${index + 1}`,
        sleepStart: '23:00',
        sleepEnd: '07:00',
      }),
    )

    const result = predictCircadianRhythm(sessions)

    expect(result.melatoninWindowStart).toBe('21:00')
    expect(result.melatoninWindowEnd).toBe('22:00')
    expect(result.optimalBedtime).toBe('21:15')
    expect(result.energyPhases.map((phase) => [phase.name, phase.start, phase.end])).toEqual([
      ['Sleep Inertia', '07:00', '08:30'],
      ['Morning Peak', '08:30', '12:00'],
      ['Afternoon Dip', '12:00', '15:00'],
      ['Evening Peak', '15:00', '19:00'],
      ['Wind Down', '19:00', '23:00'],
    ])
  })
})

describe('recommendWakeTime', () => {
  it('aligns wake recommendations to 90-minute sleep cycles', () => {
    const result = recommendWakeTime('23:00', 15)

    expect(result.optimalWakeTime).toBe('06:45')
    expect(result.alternativeWakeTimes).toEqual(['05:15', '08:15'])
    expect(result.reasoning).toContain('5 complete 90-min cycles')
  })
})
