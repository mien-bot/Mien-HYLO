/**
 * Portfolio service — manages user-entered holdings (positions) and computes
 * unrealized P&L, total return, and account-value time series from
 * stored price history.
 */

import { getDb } from '../../db/database'
import { getLatestPricesLive, getCachedPrices } from './index'
import * as fs from 'fs'
import { randomUUID } from 'crypto'

export interface HoldingRow {
  id: number
  symbol: string
  quantity: number
  cost_basis: number // per-share USD
  acquired_at: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
  deleted_at: string | null
  sync_id: string | null
}

export interface HoldingWithLive extends HoldingRow {
  current_price: number | null
  market_value: number | null
  unrealized_pl: number | null
  unrealized_pl_percent: number | null
  weight_percent: number | null
}

export interface PortfolioSummary {
  totalValue: number
  totalCost: number
  unrealizedPL: number
  unrealizedPLPercent: number
  dayChange: number
  dayChangePercent: number
  holdings: HoldingWithLive[]
}

export interface RobinhoodImportResult {
  importedSymbols: string[]
  existingSymbols: string[]
  skippedRows: number
  totalRows: number
  message: string
}

const HOLDINGS_COLUMNS =
  'id, symbol, quantity, cost_basis, acquired_at, notes, created_at, updated_at, deleted_at, sync_id'

export function listHoldings(): HoldingRow[] {
  ensureHoldingSyncIds()
  deduplicateHoldings()
  return getDb()
    .prepare(
      `SELECT ${HOLDINGS_COLUMNS} FROM holdings WHERE deleted_at IS NULL ORDER BY symbol ASC, acquired_at ASC`,
    )
    .all() as HoldingRow[]
}

/** Delete duplicate holdings rows (same symbol, quantity, cost_basis), keeping the oldest. */
function deduplicateHoldings(): void {
  const db = getDb()
  const dupes = db
    .prepare(
      `SELECT id FROM holdings
       WHERE deleted_at IS NULL
         AND id NOT IN (
           SELECT MIN(id) FROM holdings
           WHERE deleted_at IS NULL
           GROUP BY symbol, quantity, cost_basis
         )`,
    )
    .all() as Array<{ id: number }>
  if (dupes.length > 0) {
    const del = db.prepare('DELETE FROM holdings WHERE id = ?')
    for (const d of dupes) del.run(d.id)
    console.log(`[Portfolio] Deleted ${dupes.length} duplicate holding rows`)
  }
}

export function addHolding(input: {
  symbol: string
  quantity: number
  cost_basis: number
  acquired_at?: string | null
  notes?: string | null
}): number {
  const db = getDb()
  const sym = input.symbol.toUpperCase()

  // Prevent exact duplicates (same symbol, quantity, cost_basis)
  const existing = db
    .prepare(
      `SELECT id FROM holdings
       WHERE symbol = ? AND quantity = ? AND cost_basis = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .get(sym, input.quantity, input.cost_basis) as { id: number } | undefined

  if (existing) {
    return existing.id
  }

  const result = db
    .prepare(
      `
    INSERT INTO holdings (symbol, quantity, cost_basis, acquired_at, notes, sync_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `,
    )
    .run(
      sym,
      input.quantity,
      input.cost_basis,
      input.acquired_at || null,
      input.notes || null,
      randomUUID(),
    )
  return Number(result.lastInsertRowid)
}

export function updateHolding(id: number, patch: Partial<HoldingRow>): void {
  const db = getDb()
  const allowed = ['symbol', 'quantity', 'cost_basis', 'acquired_at', 'notes'] as const
  const fields: string[] = []
  const values: any[] = []
  for (const key of allowed) {
    if (key in patch && patch[key] !== undefined) {
      fields.push(`${key} = ?`)
      values.push(
        key === 'symbol' && typeof patch.symbol === 'string'
          ? patch.symbol.toUpperCase()
          : patch[key],
      )
    }
  }
  if (fields.length === 0) return
  fields.push(`updated_at = datetime('now')`, `deleted_at = NULL`)
  values.push(id)
  db.prepare(`UPDATE holdings SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function removeHolding(id: number): void {
  getDb()
    .prepare(
      "UPDATE holdings SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    )
    .run(id)
}

function ensureHoldingSyncIds(): void {
  const db = getDb()
  const rows = db
    .prepare("SELECT id FROM holdings WHERE sync_id IS NULL OR sync_id = ''")
    .all() as Array<{ id: number }>
  const stmt = db.prepare(
    "UPDATE holdings SET sync_id = ?, updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE id = ?",
  )
  for (const row of rows) stmt.run(randomUUID(), row.id)
}

export function importRobinhoodExport(filePath: string): RobinhoodImportResult {
  const text = fs.readFileSync(filePath, 'utf8')
  const rows = parseCsv(text)
  if (rows.length < 2) {
    return {
      importedSymbols: [],
      existingSymbols: [],
      skippedRows: 0,
      totalRows: 0,
      message: 'No rows found in the Robinhood export.',
    }
  }

  const headers = rows[0].map(normalizeHeader)
  const symbolIndex = findHeaderIndex(headers, ['symbol', 'ticker', 'tickersymbol', 'instrument'])
  if (symbolIndex < 0) {
    throw new Error('Could not find a Symbol, Ticker, or Instrument column in the export.')
  }

  const quantityIndex = findHeaderIndex(headers, ['quantity', 'qty', 'shares'])
  const symbols = new Set<string>()
  let skippedRows = 0

  for (const row of rows.slice(1)) {
    const rawSymbol = row[symbolIndex]
    const symbol = normalizeSymbol(rawSymbol)
    const quantity = quantityIndex >= 0 ? parseNumber(row[quantityIndex]) : null

    if (!symbol || (quantity != null && quantity <= 0)) {
      skippedRows++
      continue
    }
    symbols.add(symbol)
  }

  const db = getDb()
  const existing = new Set(
    (db.prepare('SELECT symbol FROM watchlist').all() as Array<{ symbol: string }>).map((row) =>
      row.symbol.toUpperCase(),
    ),
  )
  const importedSymbols: string[] = []
  const existingSymbols: string[] = []
  const insert = db.prepare('INSERT OR IGNORE INTO watchlist (symbol, type, name) VALUES (?, ?, ?)')

  const tx = db.transaction((inputSymbols: string[]) => {
    for (const symbol of inputSymbols) {
      if (existing.has(symbol)) {
        existingSymbols.push(symbol)
        continue
      }
      insert.run(symbol, inferAssetType(symbol), 'Imported from Robinhood')
      importedSymbols.push(symbol)
      existing.add(symbol)
    }
  })
  tx([...symbols].sort())

  return {
    importedSymbols,
    existingSymbols,
    skippedRows,
    totalRows: Math.max(0, rows.length - 1),
    message: `Imported ${importedSymbols.length} symbols and skipped monetary values, quantities, and cost basis.`,
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  const input = text.replace(/^\uFEFF/, '')

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cell.trim())
      cell = ''
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++
      row.push(cell.trim())
      cell = ''
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
    } else {
      cell += ch
    }
  }

  row.push(cell.trim())
  if (row.some((value) => value.length > 0)) rows.push(row)
  return rows
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  return headers.findIndex((header) => candidates.includes(header))
}

function normalizeSymbol(value: string | undefined): string | null {
  if (!value) return null
  const cleaned = value.trim().replace(/^\$/, '').toUpperCase()
  const match = cleaned.match(/^[A-Z][A-Z0-9.-]{0,9}$/)
  if (!match) return null
  return cleaned
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function inferAssetType(symbol: string): 'stock' | 'crypto' | 'etf' {
  const cryptoSymbols = new Set([
    'BTC',
    'ETH',
    'DOGE',
    'SOL',
    'ADA',
    'XRP',
    'LTC',
    'BCH',
    'AVAX',
    'SHIB',
    'LINK',
    'UNI',
  ])
  return cryptoSymbols.has(symbol.replace(/-USD$/, '')) ? 'crypto' : 'stock'
}

/**
 * Build a full portfolio summary with live prices.
 */
export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const rows = listHoldings()
  if (rows.length === 0) {
    return {
      totalValue: 0,
      totalCost: 0,
      unrealizedPL: 0,
      unrealizedPLPercent: 0,
      dayChange: 0,
      dayChangePercent: 0,
      holdings: [],
    }
  }

  // Use cached prices for instant load — live refresh happens in background via finance refresh
  const prices = getCachedPrices()
  const priceMap = new Map(prices.map((p) => [p.symbol, p]))

  let totalValue = 0
  let totalCost = 0
  let dayChange = 0

  const enriched: HoldingWithLive[] = rows.map((h) => {
    const live = priceMap.get(h.symbol)
    const cost = h.cost_basis * h.quantity
    totalCost += cost
    if (!live) {
      return {
        ...h,
        current_price: null,
        market_value: null,
        unrealized_pl: null,
        unrealized_pl_percent: null,
        weight_percent: null,
      }
    }
    const marketValue = live.price * h.quantity
    const pl = marketValue - cost
    totalValue += marketValue
    dayChange += (live.change ?? 0) * h.quantity
    return {
      ...h,
      current_price: live.price,
      market_value: marketValue,
      unrealized_pl: pl,
      unrealized_pl_percent: cost > 0 ? (pl / cost) * 100 : 0,
      weight_percent: null, // filled in below once totalValue known
    }
  })

  // Fill weights now that totalValue is known
  for (const h of enriched) {
    if (h.market_value != null && totalValue > 0) {
      h.weight_percent = (h.market_value / totalValue) * 100
    }
  }

  const unrealizedPL = totalValue - totalCost
  const unrealizedPLPercent = totalCost > 0 ? (unrealizedPL / totalCost) * 100 : 0
  const prevTotal = totalValue - dayChange
  const dayChangePercent = prevTotal > 0 ? (dayChange / prevTotal) * 100 : 0

  return {
    totalValue,
    totalCost,
    unrealizedPL,
    unrealizedPLPercent,
    dayChange,
    dayChangePercent,
    holdings: enriched,
  }
}

/**
 * Return daily total-account-value history over the last N days, using stored
 * price_history rows. Days where any holding is missing data are filled with
 * the most recent available close for that symbol (forward fill).
 */
export function getPortfolioValueHistory(
  days: number = 90,
): Array<{ date: string; value: number }> {
  const db = getDb()
  const rows = listHoldings()
  if (rows.length === 0) return []

  // Aggregate quantity per symbol (sum across lots)
  const qty = new Map<string, number>()
  for (const r of rows) {
    qty.set(r.symbol, (qty.get(r.symbol) ?? 0) + r.quantity)
  }

  // Get price history for each symbol in the date range
  const histMap = new Map<string, Map<string, number>>()
  const dateSet = new Set<string>()
  for (const sym of qty.keys()) {
    const prices = db
      .prepare(
        `
      SELECT date, close FROM price_history
      WHERE symbol = ? AND close IS NOT NULL
        AND date >= date('now', '-' || ? || ' days')
      ORDER BY date ASC
    `,
      )
      .all(sym, days) as Array<{ date: string; close: number }>
    const m = new Map<string, number>()
    for (const p of prices) {
      m.set(p.date, p.close)
      dateSet.add(p.date)
    }
    histMap.set(sym, m)
  }

  if (dateSet.size === 0) return []

  const sortedDates = [...dateSet].sort()
  const lastClose = new Map<string, number>()
  const out: Array<{ date: string; value: number }> = []

  for (const date of sortedDates) {
    let value = 0
    let coverage = 0
    for (const [sym, q] of qty) {
      const m = histMap.get(sym)!
      const c = m.get(date)
      if (c != null) {
        lastClose.set(sym, c)
        value += c * q
        coverage++
      } else {
        const prev = lastClose.get(sym)
        if (prev != null) {
          value += prev * q
          coverage++
        }
      }
    }
    // Only emit a row once we have at least partial coverage
    if (coverage > 0) out.push({ date, value })
  }

  return out
}
