/**
 * Alerts service — user-defined price/technical triggers checked on a
 * recurring schedule. When an alert fires we:
 *   1) post an Electron desktop notification
 *   2) push an IPC event to the renderer so the UI can flash
 *   3) update last_fired_at (and last_value)
 *   4) optionally deactivate the alert if one_shot is set (default true)
 */

import { BrowserWindow, Notification } from 'electron'
import { getDb } from '../../db/database'
import { getLatestPricesLive } from './index'
import { sma, computeRSI } from './technical-indicators'
import { randomUUID } from 'crypto'

export type AlertType =
  | 'price_above'
  | 'price_below'
  | 'rsi_above'
  | 'rsi_below'
  | 'ma_cross_above'
  | 'ma_cross_below'

export interface AlertRow {
  id: number
  symbol: string
  type: AlertType
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

const ALERT_COLUMNS =
  'id, symbol, type, threshold, note, active, one_shot, last_fired_at, last_value, created_at, updated_at, deleted_at, sync_id'

export function listAlerts(): AlertRow[] {
  ensureAlertSyncIds()
  return getDb()
    .prepare(
      `SELECT ${ALERT_COLUMNS} FROM alerts WHERE deleted_at IS NULL ORDER BY active DESC, created_at DESC`,
    )
    .all() as AlertRow[]
}

export function listActiveAlerts(): AlertRow[] {
  ensureAlertSyncIds()
  return getDb()
    .prepare(
      `SELECT ${ALERT_COLUMNS} FROM alerts WHERE active = 1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    )
    .all() as AlertRow[]
}

export function createAlert(input: {
  symbol: string
  type: AlertType
  threshold: number
  note?: string | null
  one_shot?: boolean
}): number {
  const result = getDb()
    .prepare(
      `
    INSERT INTO alerts (symbol, type, threshold, note, one_shot, sync_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `,
    )
    .run(
      input.symbol.toUpperCase(),
      input.type,
      input.threshold,
      input.note ?? null,
      input.one_shot === false ? 0 : 1,
      randomUUID(),
    )
  return Number(result.lastInsertRowid)
}

export function toggleAlert(id: number, active: boolean): void {
  getDb()
    .prepare(
      "UPDATE alerts SET active = ?, updated_at = datetime('now'), deleted_at = NULL WHERE id = ?",
    )
    .run(active ? 1 : 0, id)
}

export function removeAlert(id: number): void {
  getDb()
    .prepare(
      "UPDATE alerts SET deleted_at = datetime('now'), updated_at = datetime('now'), active = 0 WHERE id = ?",
    )
    .run(id)
}

function ensureAlertSyncIds(): void {
  const db = getDb()
  const rows = db
    .prepare("SELECT id FROM alerts WHERE sync_id IS NULL OR sync_id = ''")
    .all() as Array<{ id: number }>
  const stmt = db.prepare(
    "UPDATE alerts SET sync_id = ?, updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE id = ?",
  )
  for (const row of rows) stmt.run(randomUUID(), row.id)
}

interface AlertHit {
  alert: AlertRow
  value: number
  message: string
}

function evaluate(
  alert: AlertRow,
  livePrice: number | null,
  rsi: number | null,
  sma20: number | null,
  sma50: number | null,
  prevSma20: number | null,
  prevSma50: number | null,
): AlertHit | null {
  const t = alert.threshold
  switch (alert.type) {
    case 'price_above':
      if (livePrice != null && livePrice >= t)
        return {
          alert,
          value: livePrice,
          message: `${alert.symbol} ↑ $${livePrice.toFixed(2)} crossed above $${t.toFixed(2)}`,
        }
      break
    case 'price_below':
      if (livePrice != null && livePrice <= t)
        return {
          alert,
          value: livePrice,
          message: `${alert.symbol} ↓ $${livePrice.toFixed(2)} crossed below $${t.toFixed(2)}`,
        }
      break
    case 'rsi_above':
      if (rsi != null && rsi >= t)
        return {
          alert,
          value: rsi,
          message: `${alert.symbol} RSI ${rsi.toFixed(1)} above ${t.toFixed(0)}`,
        }
      break
    case 'rsi_below':
      if (rsi != null && rsi <= t)
        return {
          alert,
          value: rsi,
          message: `${alert.symbol} RSI ${rsi.toFixed(1)} below ${t.toFixed(0)}`,
        }
      break
    case 'ma_cross_above':
      // Golden cross approximation: sma20 was below sma50 last check, now above
      if (
        sma20 != null &&
        sma50 != null &&
        prevSma20 != null &&
        prevSma50 != null &&
        prevSma20 <= prevSma50 &&
        sma20 > sma50
      ) {
        return {
          alert,
          value: sma20 - sma50,
          message: `${alert.symbol} 20-day SMA crossed above 50-day SMA (bullish)`,
        }
      }
      break
    case 'ma_cross_below':
      if (
        sma20 != null &&
        sma50 != null &&
        prevSma20 != null &&
        prevSma50 != null &&
        prevSma20 >= prevSma50 &&
        sma20 < sma50
      ) {
        return {
          alert,
          value: sma20 - sma50,
          message: `${alert.symbol} 20-day SMA crossed below 50-day SMA (bearish)`,
        }
      }
      break
  }
  return null
}

/**
 * Load the last `limit` closes for every requested symbol in a single
 * window-functioned query, returned as a symbol → ascending-closes map.
 * Keeps the alerts check O(1) queries regardless of how many symbols
 * have active alerts.
 */
function loadRecentCloses(symbols: string[], limit = 51): Map<string, number[]> {
  if (symbols.length === 0) return new Map()
  const placeholders = symbols.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `
    SELECT symbol, close FROM (
      SELECT symbol, close, date,
             ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
      FROM price_history
      WHERE symbol IN (${placeholders}) AND close IS NOT NULL
    )
    WHERE rn <= ?
    ORDER BY symbol ASC, date ASC
  `,
    )
    .all(...symbols, limit) as Array<{ symbol: string; close: number }>

  const map = new Map<string, number[]>()
  for (const r of rows) {
    let arr = map.get(r.symbol)
    if (!arr) {
      arr = []
      map.set(r.symbol, arr)
    }
    arr.push(r.close)
  }
  return map
}

/**
 * Check all active alerts. Returns list of hits.
 */
export async function checkAlerts(): Promise<AlertHit[]> {
  const alerts = listActiveAlerts()
  if (alerts.length === 0) return []

  const symbols = [...new Set(alerts.map((a) => a.symbol))]
  const livePrices = await getLatestPricesLive()
  const priceMap = new Map(livePrices.map((p) => [p.symbol, p.price]))

  // One DB round-trip for all symbols' recent closes; compute indicators in memory.
  const closesBySymbol = loadRecentCloses(symbols, 51)

  const indicators = new Map<
    string,
    { rsi: number | null; sma20: number | null; sma50: number | null }
  >()
  const prevSmaMap = new Map<string, { sma20: number | null; sma50: number | null }>()
  for (const sym of symbols) {
    const closes = closesBySymbol.get(sym) || []
    indicators.set(sym, {
      rsi: closes.length >= 15 ? computeRSI(closes, 14) : null,
      sma20: closes.length >= 20 ? sma(closes, 20) : null,
      sma50: closes.length >= 50 ? sma(closes, 50) : null,
    })
    // Previous-day SMAs derived from the same closes array (drop most recent).
    if (closes.length >= 51) {
      const prev = closes.slice(0, -1)
      prevSmaMap.set(sym, {
        sma20: sma(prev, 20),
        sma50: sma(prev, 50),
      })
    } else {
      prevSmaMap.set(sym, { sma20: null, sma50: null })
    }
  }

  const db = getDb()

  const hits: AlertHit[] = []
  const updateFired = db.prepare(
    `UPDATE alerts SET last_fired_at = datetime('now'), last_value = ?, active = CASE WHEN one_shot = 1 THEN 0 ELSE active END, updated_at = datetime('now') WHERE id = ?`,
  )

  for (const alert of alerts) {
    const live = priceMap.get(alert.symbol) ?? null
    const ind = indicators.get(alert.symbol) || { rsi: null, sma20: null, sma50: null }
    const prev = prevSmaMap.get(alert.symbol) || { sma20: null, sma50: null }

    const hit = evaluate(alert, live, ind.rsi, ind.sma20, ind.sma50, prev.sma20, prev.sma50)
    if (!hit) continue

    hits.push(hit)
    updateFired.run(hit.value, alert.id)

    // Desktop notification
    if (Notification.isSupported()) {
      const fullBody = alert.note ? `${hit.message}\n${alert.note}` : hit.message
      new Notification({ title: 'Mien Alert', body: fullBody }).show()
    }
  }

  if (hits.length > 0) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(
        'alerts:fired',
        hits.map((h) => ({
          id: h.alert.id,
          symbol: h.alert.symbol,
          type: h.alert.type,
          message: h.message,
          value: h.value,
        })),
      )
    }
  }

  return hits
}
