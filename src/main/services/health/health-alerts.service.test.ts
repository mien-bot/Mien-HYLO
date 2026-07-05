import { describe, expect, it, vi } from 'vitest'
import { calculateTrainingLoadRatioFromRows } from './health-alerts.service'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
}))

vi.mock('../../db/database', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../lib/settings', () => ({
  getAppSettings: vi.fn(() => ({})),
}))

function workoutRow(date: string, duration: number): { date: string; value_json: string } {
  return {
    date,
    value_json: JSON.stringify({
      workouts: [{ duration, calories: 0 }],
    }),
  }
}

describe('calculateTrainingLoadRatioFromRows', () => {
  it('uses inactive days as zero load in the 28-day chronic baseline', () => {
    const rows = [
      workoutRow('2026-05-05', 120),
      workoutRow('2026-05-10', 120),
      workoutRow('2026-05-20', 120),
      workoutRow('2026-05-26', 120),
      workoutRow('2026-05-27', 120),
      workoutRow('2026-05-28', 120),
      workoutRow('2026-05-29', 120),
    ]

    const ratio = calculateTrainingLoadRatioFromRows(rows, new Date('2026-05-31T12:00:00.000Z'))

    expect(ratio).toBeCloseTo((480 / 7) / (840 / 28), 6)
    expect(ratio).toBeGreaterThan(1.5)
  })
})
