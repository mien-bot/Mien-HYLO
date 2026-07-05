import { describe, expect, it, vi } from 'vitest'

// Mock the heavy/native + electron-bound modules so importing sync.service
// doesn't pull in better-sqlite3 or electron. We only exercise the pure
// timestamp helper here.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
}))
vi.mock('../db/database', () => ({
  getDb: vi.fn(),
  applySleepOutlierExclusions: vi.fn(),
}))
vi.mock('../lib/settings', () => ({
  getAppSettings: vi.fn(() => ({})),
}))
vi.mock('./health/health-export.service', () => ({
  broadcastSleepArrived: vi.fn(),
  runMorningSleepBriefingIfDue: vi.fn(),
}))

import { toSqliteUtcTimestamp } from './sync.service'

describe('toSqliteUtcTimestamp', () => {
  it('round-trips a SQLite UTC timestamp unchanged (no timezone shift)', () => {
    // SQLite datetime('now') format — UTC, no zone marker. Must NOT be
    // reinterpreted as local time (which would shift it by the local offset).
    expect(toSqliteUtcTimestamp('2026-06-01 22:08:51')).toBe('2026-06-01 22:08:51')
  })

  it('is idempotent (double-apply does not drift)', () => {
    const once = toSqliteUtcTimestamp('2026-06-01 22:08:51')!
    expect(toSqliteUtcTimestamp(once)).toBe('2026-06-01 22:08:51')
  })

  it('normalizes ISO (...Z) input to the SQLite UTC form', () => {
    expect(toSqliteUtcTimestamp('2026-06-01T22:08:51.123Z')).toBe('2026-06-01 22:08:51')
  })

  it('returns null for unparseable input', () => {
    expect(toSqliteUtcTimestamp('not-a-date')).toBeNull()
  })
})
