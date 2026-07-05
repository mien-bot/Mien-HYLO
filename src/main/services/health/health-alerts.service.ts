/**
 * Health alerts — user thresholds against sleep/HRV/recovery/training-load
 * derived metrics. Evaluated on the evening-health job and on
 * sleep-data-arrived. Mirrors the finance alerts service in shape but reads
 * health-side analytics instead of price data.
 */

import { BrowserWindow, Notification } from 'electron'
import { getDb } from '../../db/database'
import { randomUUID } from 'crypto'
import { SLEEP_DEBT_WINDOW_DAYS } from '@shared/constants'
import {
  parseSleepSessions,
  calculateSleepDebt,
  calculateHrvRecovery,
  calculateRecoveryReadiness,
} from './sleep-analysis'

export type HealthAlertType =
  | 'hrv_below'
  | 'recovery_below'
  | 'training_load_above'
  | 'sleep_debt_above'

export interface HealthAlertRow {
  id: number
  type: HealthAlertType
  threshold: number
  note: string | null
  active: number
  one_shot: number
  last_fired_at: string | null
  last_value: number | null
  created_at: string
  updated_at: string | null
  deleted_at: string | null
  sync_id: string | null
}

const COLUMNS =
  'id, type, threshold, note, active, one_shot, last_fired_at, last_value, created_at, updated_at, deleted_at, sync_id'

const HEALTH_ALERT_TYPES: HealthAlertType[] = [
  'hrv_below',
  'recovery_below',
  'training_load_above',
  'sleep_debt_above',
]

function isValidType(t: string): t is HealthAlertType {
  return (HEALTH_ALERT_TYPES as string[]).includes(t)
}

export function listHealthAlerts(): HealthAlertRow[] {
  ensureHealthAlertSyncIds()
  return getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM health_alerts WHERE deleted_at IS NULL ORDER BY active DESC, created_at DESC`,
    )
    .all() as HealthAlertRow[]
}

export function createHealthAlert(input: {
  type: string
  threshold: number
  note?: string | null
  one_shot?: boolean
}): number {
  if (!isValidType(input.type)) throw new Error(`Invalid health alert type: ${input.type}`)
  if (!Number.isFinite(input.threshold)) throw new Error('Threshold must be a number')

  const result = getDb()
    .prepare(
      `
    INSERT INTO health_alerts (type, threshold, note, one_shot, sync_id, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `,
    )
    .run(input.type, input.threshold, input.note ?? null, input.one_shot ? 1 : 0, randomUUID())
  return Number(result.lastInsertRowid)
}

export function toggleHealthAlert(id: number, active: boolean): void {
  getDb()
    .prepare(
      "UPDATE health_alerts SET active = ?, updated_at = datetime('now'), deleted_at = NULL WHERE id = ?",
    )
    .run(active ? 1 : 0, id)
}

export function removeHealthAlert(id: number): void {
  getDb()
    .prepare(
      "UPDATE health_alerts SET deleted_at = datetime('now'), updated_at = datetime('now'), active = 0 WHERE id = ?",
    )
    .run(id)
}

function ensureHealthAlertSyncIds(): void {
  const db = getDb()
  const rows = db
    .prepare("SELECT id FROM health_alerts WHERE sync_id IS NULL OR sync_id = ''")
    .all() as Array<{ id: number }>
  const stmt = db.prepare(
    "UPDATE health_alerts SET sync_id = ?, updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE id = ?",
  )
  for (const row of rows) stmt.run(randomUUID(), row.id)
}

interface HealthHit {
  alert: HealthAlertRow
  value: number
  message: string
}

type TrainingLoadRow = { date: string; value_json: string }

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

export function calculateTrainingLoadRatioFromRows(
  rows: TrainingLoadRow[],
  referenceDate = new Date(),
): number | null {
  if (rows.length === 0) return null

  const end = new Date(`${toIsoDate(referenceDate)}T00:00:00.000Z`)
  const windowDays = Array.from({ length: 28 }, (_, index) => toIsoDate(addDays(end, index - 27)))
  const byDay = new Map<string, number>(windowDays.map((day) => [day, 0]))

  // TRIMP-like: sum of duration_minutes per day (fallback to 1 per workout).
  for (const r of rows) {
    if (!byDay.has(r.date)) continue
    let v: any
    try {
      v = JSON.parse(r.value_json)
    } catch {
      continue
    }
    const workouts = Array.isArray(v?.workouts) ? v.workouts : Array.isArray(v) ? v : [v]
    let dayLoad = 0
    for (const w of workouts) {
      const dur = Number(w?.duration) || Number(w?.duration_minutes) || 30
      const cal = Number(w?.calories) || 0
      dayLoad += dur + cal * 0.1
    }
    byDay.set(r.date, (byDay.get(r.date) || 0) + dayLoad)
  }

  const acuteDays = windowDays.slice(-7)
  const acute = acuteDays.reduce((s, d) => s + (byDay.get(d) || 0), 0) / 7
  const chronic = windowDays.reduce((s, d) => s + (byDay.get(d) || 0), 0) / 28
  if (chronic === 0) return null
  return acute / chronic
}

function getCurrentTrainingLoadRatio(): number | null {
  // Acute / chronic load ratio from health_metrics 'workout' rows over the
  // last 28 days. Returns null if not enough data.
  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'workout' AND date >= date('now', '-28 days')
    ORDER BY date ASC
  `,
    )
    .all() as TrainingLoadRow[]

  return calculateTrainingLoadRatioFromRows(rows)
}

function evaluate(alert: HealthAlertRow): HealthHit | null {
  const t = alert.threshold
  switch (alert.type) {
    case 'hrv_below': {
      const hrv = calculateHrvRecovery()
      if (!hrv || !Number.isFinite(hrv.latestHrv)) return null
      // Threshold interpreted as absolute HRV (ms) — fire if current <= threshold.
      if (hrv.latestHrv <= t) {
        return {
          alert,
          value: hrv.latestHrv,
          message: `HRV ${hrv.latestHrv.toFixed(0)}ms is at or below your ${t.toFixed(0)}ms threshold`,
        }
      }
      return null
    }
    case 'recovery_below': {
      const r = calculateRecoveryReadiness()
      if (!r || !Number.isFinite(r.score)) return null
      if (r.score <= t) {
        return {
          alert,
          value: r.score,
          message: `Recovery readiness ${r.score.toFixed(0)} is at or below ${t.toFixed(0)}`,
        }
      }
      return null
    }
    case 'sleep_debt_above': {
      const sessions = parseSleepSessions(SLEEP_DEBT_WINDOW_DAYS)
      if (sessions.length < 3) return null
      const debt = calculateSleepDebt(sessions)
      if (debt.currentDebt >= t) {
        return {
          alert,
          value: debt.currentDebt,
          message: `Sleep debt ${debt.currentDebt.toFixed(1)}h has reached your ${t.toFixed(1)}h threshold`,
        }
      }
      return null
    }
    case 'training_load_above': {
      const ratio = getCurrentTrainingLoadRatio()
      if (ratio == null) return null
      if (ratio >= t) {
        return {
          alert,
          value: ratio,
          message: `Acute:Chronic training load ratio ${ratio.toFixed(2)} above your ${t.toFixed(2)} threshold (overreaching risk)`,
        }
      }
      return null
    }
  }
  return null
}

/**
 * Evaluate all active health alerts. Fires Electron notifications and
 * broadcasts an 'alerts:fired' IPC event so the UI can flash.
 */
export async function checkHealthAlerts(): Promise<HealthHit[]> {
  const alerts = listHealthAlerts().filter((a) => a.active === 1)
  if (alerts.length === 0) return []

  const hits: HealthHit[] = []
  const update = getDb().prepare(`
    UPDATE health_alerts
    SET last_fired_at = datetime('now'),
        last_value = ?,
        active = CASE WHEN one_shot = 1 THEN 0 ELSE active END,
        updated_at = datetime('now')
    WHERE id = ?
  `)

  for (const alert of alerts) {
    let hit: HealthHit | null = null
    try {
      hit = evaluate(alert)
    } catch (err) {
      console.error(`[health-alerts] eval failed for ${alert.type}:`, (err as Error)?.message)
      continue
    }
    if (!hit) continue
    hits.push(hit)
    update.run(hit.value, alert.id)

    if (Notification.isSupported()) {
      const body = alert.note ? `${hit.message}\n${alert.note}` : hit.message
      new Notification({ title: 'Mien Health Alert', body }).show()
    }
  }

  if (hits.length > 0) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(
        'alerts:fired',
        hits.map((h) => ({
          id: h.alert.id,
          symbol: 'HEALTH',
          type: h.alert.type,
          message: h.message,
          value: h.value,
        })),
      )
    }
  }

  return hits
}
