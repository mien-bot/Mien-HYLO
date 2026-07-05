#!/usr/bin/env node
/**
 * Backfill historical sleep records from an AutoSleep CSV export.
 *
 * AutoSleep app → Settings → Export Sleep Data → Email or AirDrop CSV.
 * Posts every row to the relay's POST /health/autosleep endpoint, which
 * overwrites existing sleep records for matching dates.
 *
 * Usage:
 *   node scripts/backfill-autosleep.js <csv-path> <relay-url> [relay-token]
 *
 * Example:
 *   node scripts/backfill-autosleep.js ~/Downloads/AutoSleep.csv https://relay.example.com $(cat relay/relay.key)
 *   node scripts/backfill-autosleep.js ./autosleep.csv http://localhost:3456
 *
 * The script batches in chunks of 200 nights per POST and reports progress.
 * Existing sleep records for the same dates are overwritten (this is the
 * point — we're replacing watch-overcounted records with AutoSleep truth).
 */

const fs = require('fs')

function parseCsv(text) {
  // AutoSleep CSV uses quoted strings with embedded commas in date fields.
  // Simple parser handles "..." fields with comma escaping.
  const rows = []
  const lines = text.split(/\r?\n/).filter(l => l.length > 0)
  for (const line of lines) {
    const cells = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
        else inQuote = !inQuote
      } else if (ch === ',' && !inQuote) {
        cells.push(cur); cur = ''
      } else {
        cur += ch
      }
    }
    cells.push(cur)
    rows.push(cells)
  }
  return rows
}

function rowsToNights(rows) {
  const header = rows[0].map(h => h.trim())
  const idx = Object.fromEntries(header.map((h, i) => [h, i]))
  const get = (row, key) => row[idx[key]]
  const nights = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.length < header.length / 2) continue
    const asleep = get(row, 'asleep')
    if (!asleep || asleep === '00:00:00') continue
    const iso = get(row, 'ISO8601') // e.g. "2026-05-25T20:59:59-05:00" — wake date
    const date = iso ? iso.slice(0, 10) : null
    if (!date) continue
    nights.push({
      date,
      bedtime: get(row, 'bedtime') || undefined,
      waketime: get(row, 'waketime') || undefined,
      asleep,
      inBed: get(row, 'inBed') || undefined,
      awake: get(row, 'awake') || undefined,
      deep: get(row, 'deep') || undefined,
      quality: get(row, 'quality') || undefined,
      efficiency: parseFloat(get(row, 'efficiency')) || undefined,
      sleepBPM: parseFloat(get(row, 'sleepBPM')) || undefined,
      sleepHRV: parseFloat(get(row, 'sleepHRV')) || undefined,
    })
  }
  return nights
}

async function postBatch(url, token, batch) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(batch) })
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function main() {
  const [csvPath, relayUrl, relayToken] = process.argv.slice(2)
  if (!csvPath || !relayUrl) {
    console.error('Usage: node scripts/backfill-autosleep.js <csv-path> <relay-url> [relay-token]')
    process.exit(1)
  }
  const endpoint = relayUrl.replace(/\/$/, '') + '/health/autosleep'
  const csv = fs.readFileSync(csvPath, 'utf8')
  const rows = parseCsv(csv)
  const nights = rowsToNights(rows)
  console.log(`Parsed ${nights.length} nights from ${csvPath}`)
  console.log(`Date range: ${nights[0]?.date} → ${nights[nights.length - 1]?.date}`)
  console.log(`Posting to ${endpoint} in batches of 200...`)

  const BATCH = 200
  let totalAdded = 0
  let totalSkipped = 0
  for (let i = 0; i < nights.length; i += BATCH) {
    const chunk = nights.slice(i, i + BATCH)
    const result = await postBatch(endpoint, relayToken, chunk)
    totalAdded += result.added || 0
    totalSkipped += result.skipped || 0
    console.log(`  Batch ${i / BATCH + 1}: ${result.added} added, ${result.skipped} skipped (cum: ${totalAdded}/${nights.length})`)
  }
  console.log(`\nDone. ${totalAdded} nights stored, ${totalSkipped} skipped.`)
}

main().catch(err => { console.error(err); process.exit(1) })
