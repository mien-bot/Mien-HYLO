import * as SQLite from 'expo-sqlite'

let db: SQLite.SQLiteDatabase | null = null

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!db) {
    db = await SQLite.openDatabaseAsync('mien.db')
    await runMigrations(db)
  }
  return db
}

async function runMigrations(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('stock', 'crypto', 'etf')),
      name TEXT,
      added_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      source TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      UNIQUE(symbol, date, source)
    );

    CREATE TABLE IF NOT EXISTS health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_type TEXT NOT NULL,
      date TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source TEXT DEFAULT 'apple_health',
      imported_at TEXT DEFAULT (datetime('now')),
      UNIQUE(metric_type, date)
    );

    CREATE TABLE IF NOT EXISTS briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_prompt TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      conversation_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      pinned INTEGER NOT NULL DEFAULT 0,
      source_conversation_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekend_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      weekend_date TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      events_json TEXT,
      ai_rationale TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(weekend_date)
    );

    CREATE TABLE IF NOT EXISTS weekend_event_cache (
      event_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      event_date TEXT,
      time TEXT,
      venue TEXT,
      address TEXT,
      city TEXT,
      type TEXT,
      price_range TEXT,
      url TEXT,
      image_url TEXT,
      description TEXT,
      source TEXT,
      query TEXT,
      category TEXT,
      saved_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS news_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      source TEXT,
      published_at TEXT,
      related_symbols TEXT DEFAULT '[]',
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      ai_rationale TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date)
    );

    CREATE TABLE IF NOT EXISTS saved_restaurants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      address TEXT,
      price_level INTEGER,
      rating REAL,
      cuisine TEXT,
      lat REAL,
      lng REAL,
      notes TEXT,
      booking_advance TEXT,
      saved_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS restaurant_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      rating REAL,
      notes TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(place_id, visit_date, created_at)
    );

    -- Read-only mirrors of desktop tables (v1.2 parity)
    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL NOT NULL,
      acquired_at TEXT,
      notes TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL,
      threshold REAL NOT NULL,
      note TEXT,
      active INTEGER DEFAULT 1,
      one_shot INTEGER DEFAULT 1,
      last_fired_at TEXT,
      last_value REAL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS health_alerts (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      threshold REAL NOT NULL,
      note TEXT,
      active INTEGER DEFAULT 1,
      one_shot INTEGER DEFAULT 0,
      last_fired_at TEXT,
      last_value REAL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS fundamentals (
      symbol TEXT PRIMARY KEY,
      pe REAL,
      pb REAL,
      eps REAL,
      revenue REAL,
      market_cap REAL,
      dividend_yield REAL,
      sector TEXT,
      fetched_at TEXT
    );
  `)

  // Add new columns to saved_restaurants (safe to re-run, ALTER TABLE errors silently on existing columns)
  const newCols = [
    'venue_type TEXT DEFAULT "restaurant"',
    'cuisine_category TEXT',
    'spice_level TEXT',
    'reservation_link TEXT',
    'peak_times TEXT',
    'description TEXT',
    'visited INTEGER DEFAULT 0',
    'visit_date TEXT',
    'personal_rating REAL',
    'booking_advance_days INTEGER',
    'busy_days_matrix TEXT',
    'last_researched_at TEXT',
    'updated_at TEXT',
  ]
  for (const col of newCols) {
    try { await database.execAsync(`ALTER TABLE saved_restaurants ADD COLUMN ${col}`) } catch {}
  }
  await database.execAsync(`UPDATE saved_restaurants SET updated_at = COALESCE(updated_at, saved_at, datetime('now')) WHERE updated_at IS NULL`)
  try { await database.execAsync(`ALTER TABLE restaurant_visits ADD COLUMN deleted_at TEXT`) } catch {}
  try { await database.execAsync(`ALTER TABLE news_articles ADD COLUMN summary TEXT`) } catch {}
  try { await database.execAsync(`ALTER TABLE news_articles ADD COLUMN content_context TEXT`) } catch {}
  try { await database.execAsync(`ALTER TABLE news_articles ADD COLUMN transcript_status TEXT`) } catch {}
  try { await database.execAsync(`ALTER TABLE news_articles ADD COLUMN transcript_source TEXT`) } catch {}
  try { await database.execAsync(`ALTER TABLE news_articles ADD COLUMN transcript_fetched_at TEXT`) } catch {}

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS migrations (
      key TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `)

  await dedupeRestaurantVisits(database)
  await database.execAsync(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_visits_place_date
    ON restaurant_visits(place_id, visit_date);
  `)

  await dedupeBriefings(database)
  await database.execAsync(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_briefings_type_date
    ON briefings(type, date);
  `)

  await rebinSleepToWakeDate(database)

  console.log('Mobile database initialized')
}

async function dedupeBriefings(database: SQLite.SQLiteDatabase): Promise<void> {
  const key = 'briefings-dedupe-type-date-v1'
  const done = await database.getFirstAsync(`SELECT 1 FROM migrations WHERE key = ?`, key)
  if (done) return

  // Keep most recent created_at per (type, date), delete the rest.
  const result = await database.runAsync(
    `DELETE FROM briefings WHERE id NOT IN (
       SELECT id FROM briefings b1
       WHERE NOT EXISTS (
         SELECT 1 FROM briefings b2
         WHERE b2.type = b1.type AND b2.date = b1.date
           AND (b2.created_at > b1.created_at
                OR (b2.created_at = b1.created_at AND b2.id > b1.id))
       )
     )`
  )
  await database.runAsync(`INSERT OR REPLACE INTO migrations (key) VALUES (?)`, key)
  if (result.changes > 0) {
    console.log(`[Mobile DB] Removed ${result.changes} duplicate briefing rows`)
  }
}

async function dedupeRestaurantVisits(database: SQLite.SQLiteDatabase): Promise<void> {
  const key = 'restaurant-visits-dedupe-place-date-v1'
  const done = await database.getFirstAsync(`SELECT 1 FROM migrations WHERE key = ?`, key)
  if (done) return

  const groups = await database.getAllAsync(
    `SELECT place_id, visit_date
     FROM restaurant_visits
     GROUP BY place_id, visit_date
     HAVING COUNT(*) > 1`
  ) as Array<{ place_id: string; visit_date: string }>

  for (const group of groups) {
    const visits = await database.getAllAsync(
      `SELECT id FROM restaurant_visits
       WHERE place_id = ? AND visit_date = ?
       ORDER BY CASE WHEN notes IS NOT NULL AND notes != '' THEN 0 ELSE 1 END,
                created_at DESC,
                id DESC`,
      group.place_id,
      group.visit_date
    ) as Array<{ id: number }>

    for (const visit of visits.slice(1)) {
      await database.runAsync(`DELETE FROM restaurant_visits WHERE id = ?`, visit.id)
    }

    await database.runAsync(
      `UPDATE saved_restaurants
       SET personal_rating = (
           SELECT CASE WHEN COUNT(rating) > 0 THEN ROUND(AVG(rating), 1) ELSE NULL END
           FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL
         ),
         visited = CASE WHEN EXISTS (SELECT 1 FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL) THEN 1 ELSE 0 END,
         visit_date = (
           SELECT visit_date FROM restaurant_visits
           WHERE place_id = ? AND deleted_at IS NULL
           ORDER BY visit_date DESC
           LIMIT 1
         )
       WHERE place_id = ?`,
      group.place_id,
      group.place_id,
      group.place_id,
      group.place_id
    )
  }

  await database.runAsync(`INSERT OR REPLACE INTO migrations (key) VALUES (?)`, key)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function localDateOf(ts: string | undefined | null): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function wakeDateFor(val: any): string | null {
  const endRaw = val?.sleepEnd || val?.end || val?.endDate
  if (endRaw) return localDateOf(endRaw)
  const startRaw = val?.sleepStart || val?.start || val?.startDate
  if (startRaw) {
    const start = new Date(startRaw)
    if (!isNaN(start.getTime())) {
      return localDateOf(new Date(start.getTime() + 6 * 60 * 60 * 1000).toISOString())
    }
  }
  return null
}

async function rebinSleepToWakeDate(database: SQLite.SQLiteDatabase): Promise<void> {
  const key = 'sleep-wake-date-v1'
  const done = await database.getFirstAsync(`SELECT 1 as ok FROM migrations WHERE key = ?`, key)
  if (done) return

  const rows = await database.getAllAsync(
    `SELECT id, date, value_json FROM health_metrics WHERE metric_type = 'sleep'`
  ) as Array<{ id: number; date: string; value_json: string }>

  let moved = 0
  for (const row of rows) {
    let val: any
    try { val = JSON.parse(row.value_json) } catch { continue }
    const newDate = wakeDateFor(val)
    if (!newDate || newDate === row.date) continue

    const existing = await database.getFirstAsync(
      `SELECT id, value_json FROM health_metrics WHERE metric_type = 'sleep' AND date = ?`,
      newDate
    ) as { id: number; value_json: string } | null
    if (existing && existing.id !== row.id) {
      let existingVal: any
      try { existingVal = JSON.parse(existing.value_json) } catch { existingVal = {} }
      const newAsleep = Number(val.totalAsleep) || Number(val.asleep) || 0
      const exAsleep = Number(existingVal.totalAsleep) || Number(existingVal.asleep) || 0
      if (exAsleep >= newAsleep) {
        await database.runAsync(`DELETE FROM health_metrics WHERE id = ?`, row.id)
        continue
      } else {
        await database.runAsync(`DELETE FROM health_metrics WHERE id = ?`, existing.id)
      }
    }
    await database.runAsync(`UPDATE health_metrics SET date = ? WHERE id = ?`, newDate, row.id)
    moved++
  }

  await database.runAsync(`INSERT OR REPLACE INTO migrations (key) VALUES (?)`, key)
  console.log(`Mobile sleep wake-date migration: re-binned ${moved} of ${rows.length} sleep rows`)
}
