import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import { wakeDateFor } from '@shared/sleep-date'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export function initDatabase(): Database.Database {
  if (db) return db
  const dbPath = path.join(app.getPath('userData'), 'mien.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
  return db
}

function runMigrations(database: Database.Database): void {
  // Inline migrations to avoid filesystem issues with bundled builds
  database.exec(`
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

    CREATE TABLE IF NOT EXISTS news_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      source TEXT,
      published_at TEXT,
      related_symbols TEXT,
      summary TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_type TEXT NOT NULL,
      date TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source TEXT DEFAULT 'health_auto_export',
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

    -- Conversation metadata (title/pin/archive). Rows are created lazily on
    -- first message; message stats are still derived from chat_messages.
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Image/PDF attachments for a chat message. Stored as base64 so the renderer
    -- can show thumbnails and runChatStream can rebuild Claude content blocks.
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL CHECK(kind IN ('image', 'document')),
      media_type TEXT NOT NULL,
      name TEXT,
      data_base64 TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_message
      ON chat_attachments(message_id);

    -- Durable cross-conversation facts the assistant remembers about the user.
    -- Injected into every chat's system prompt; editable from the Memory panel.
    CREATE TABLE IF NOT EXISTS chat_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      pinned INTEGER NOT NULL DEFAULT 0,
      source_conversation_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notion_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      database_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('pull', 'push')),
      last_cursor TEXT, -- NOTE: this column is unused (never read or written) but cannot be dropped in SQLite
      last_synced_at TEXT,
      status TEXT DEFAULT 'success'
    );

    CREATE TABLE IF NOT EXISTS notion_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT,
      due_date TEXT,
      priority TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      ai_rationale TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date)
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

    CREATE TABLE IF NOT EXISTS weekend_map_cache (
      route_hash TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
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

    -- Restaurants: add new columns (safe to re-run, ALTER TABLE IF NOT EXISTS via pragma)
    -- These use individual try/catch in JS below

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('price_above', 'price_below', 'rsi_above', 'rsi_below', 'ma_cross_above', 'ma_cross_below')),
      threshold REAL NOT NULL,
      note TEXT,
      active INTEGER DEFAULT 1,
      one_shot INTEGER DEFAULT 1,
      last_fired_at TEXT,
      last_value REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL NOT NULL,
      acquired_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS earnings_calendar (
      symbol TEXT NOT NULL,
      report_date TEXT NOT NULL,
      fiscal_period TEXT,
      eps_estimate REAL,
      eps_actual REAL,
      surprise_pct REAL,
      fetched_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (symbol, report_date)
    );

    CREATE TABLE IF NOT EXISTS ai_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      label TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cache_read_tokens INTEGER,
      cache_create_tokens INTEGER,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      error_msg TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      table_name TEXT PRIMARY KEY,
      last_pushed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS health_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      threshold REAL NOT NULL,
      note TEXT,
      active INTEGER DEFAULT 1,
      one_shot INTEGER DEFAULT 0,
      last_fired_at TEXT,
      last_value REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scheduler_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT CHECK(status IN ('running','ok','error')),
      error_text TEXT,
      duration_ms INTEGER
    );

    -- Performance indexes
    CREATE INDEX IF NOT EXISTS idx_price_history_symbol_date ON price_history(symbol, date);
    CREATE INDEX IF NOT EXISTS idx_health_metrics_type_date ON health_metrics(metric_type, date);
    CREATE INDEX IF NOT EXISTS idx_health_metrics_date ON health_metrics(date);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_memory_updated ON chat_memory(pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_briefings_type ON briefings(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_log_time ON ai_activity_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_earnings_date ON earnings_calendar(report_date);
    CREATE INDEX IF NOT EXISTS idx_holdings_symbol ON holdings(symbol);
    CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(active, symbol);
    CREATE INDEX IF NOT EXISTS idx_scheduler_log_job_started ON scheduler_activity_log(job_name, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_health_alerts_active ON health_alerts(active);
    CREATE INDEX IF NOT EXISTS idx_weekend_map_cache_created ON weekend_map_cache(created_at DESC);
  `)

  // Live price quote cache — instant load, background refresh
  database.exec(`
    CREATE TABLE IF NOT EXISTS price_cache (
      symbol TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT,
      price REAL,
      change REAL,
      change_percent REAL,
      volume REAL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `)

  // Add new news_articles columns for sentiment (heuristic and AI-scored)
  // and stale-article archival.
  const newsColumns: Array<[string, string]> = [
    ['sentiment', 'TEXT'], // 'positive' | 'negative' | 'neutral'
    ['sentiment_confidence', 'REAL'], // 0..1, present when AI-scored
    ['sentiment_source', 'TEXT'], // 'heuristic' | 'ai'
    ['archived_at', 'TEXT'], // datetime when article aged out of feeds
    ['saved_at', 'TEXT'], // datetime when user saved article for later
    ['content_context', 'TEXT'], // source/RSS description used as input for AI summaries
    ['transcript_status', 'TEXT'], // metadata_only | captions | yt_dlp_subtitles | partial_audio_transcript | full_audio_transcript | failed
    ['transcript_source', 'TEXT'], // youtube_captions | yt_dlp_subtitles | faster_whisper | whisper | none
    ['transcript_fetched_at', 'TEXT'], // datetime when transcript context was last attempted
  ]
  addColumnsIfMissing(database, 'news_articles', newsColumns)

  // Prompt-cache observability for ai_activity_log. Filled from
  // usage.cache_read_input_tokens / cache_creation_input_tokens; null on
  // requests that don't use caching or where the prefix is below the
  // model's minimum cacheable size.
  const aiLogColumns: Array<[string, string]> = [
    ['cache_read_tokens', 'INTEGER'],
    ['cache_create_tokens', 'INTEGER'],
  ]
  addColumnsIfMissing(database, 'ai_activity_log', aiLogColumns)

  const syncColumns: Array<[string, string]> = [
    ['sync_id', 'TEXT'],
    ['updated_at', 'TEXT'],
    ['deleted_at', 'TEXT'],
  ]
  addColumnsIfMissing(database, 'holdings', syncColumns)
  addColumnsIfMissing(database, 'alerts', syncColumns)
  addColumnsIfMissing(database, 'health_alerts', syncColumns)
  addColumnsIfMissing(database, 'daily_schedule', [
    ['updated_at', 'TEXT'],
    ['deleted_at', 'TEXT'],
  ])
  addColumnsIfMissing(database, 'weekend_plans', [
    ['updated_at', 'TEXT'],
    ['deleted_at', 'TEXT'],
  ])
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holdings_sync_id ON holdings(sync_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_sync_id ON alerts(sync_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_health_alerts_sync_id ON health_alerts(sync_id);
  `)

  // Add new restaurant columns (safe to re-run)
  const restaurantColumns: Array<[string, string]> = [
    ['venue_type', "TEXT DEFAULT 'restaurant'"], // restaurant | bar | dessert | cafe
    ['cuisine_category', 'TEXT'], // e.g. Italian, Chinese, Mexican, Mediterranean
    ['spice_level', 'TEXT'], // none | mild | medium | spicy | very-spicy
    ['reservation_link', 'TEXT'], // OpenTable or other booking URL
    ['peak_times', 'TEXT'], // e.g. "Fri-Sat 7-9pm"
    ['description', 'TEXT'], // AI-generated or manual description
    ['visited', 'INTEGER DEFAULT 0'], // 0 or 1
    ['visit_date', 'TEXT'], // last visit date
    ['personal_rating', 'REAL'], // user's own rating 1-5
    ['booking_advance_days', 'INTEGER'], // standardized days, e.g. 14, 30
    ['busy_days_matrix', 'TEXT'], // JSON: { Mon: { level, peakHours }, ... Sun }
    ['last_researched_at', 'TEXT'], // ISO timestamp; set when AI research succeeds
    ['updated_at', 'TEXT'], // version for cross-device merge conflict resolution
  ]
  addColumnsIfMissing(database, 'saved_restaurants', restaurantColumns)
  database.exec(
    `UPDATE saved_restaurants SET updated_at = COALESCE(updated_at, saved_at, datetime('now')) WHERE updated_at IS NULL`,
  )

  // Allow hiding outlier records from analysis without deleting them
  addColumnsIfMissing(database, 'health_metrics', [['excluded', 'INTEGER DEFAULT 0']])

  // Per-visit ratings for restaurants
  database.exec(`
    CREATE TABLE IF NOT EXISTS restaurant_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      rating REAL,
      notes TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (place_id) REFERENCES saved_restaurants(place_id) ON DELETE CASCADE
    );
  `)
  addColumnsIfMissing(database, 'restaurant_visits', [['deleted_at', 'TEXT']])

  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      key TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `)

  rebinSleepToWakeDate(database)
  applySleepOutlierExclusions(database)
  dedupeRestaurantVisits(database)
  dedupeBriefings(database)

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_visits_place_date
    ON restaurant_visits(place_id, visit_date);
  `)

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_briefings_type_date
    ON briefings(type, date);
  `)

  console.log('Database tables initialized')
}

function dedupeBriefings(database: Database.Database): void {
  const key = 'briefings-dedupe-type-date-v1'
  const done = database.prepare(`SELECT 1 FROM migrations WHERE key = ?`).get(key)
  if (done) return

  // Keep the most recent row per (type, date); delete the rest.
  // "Most recent" = latest created_at, with id as tiebreaker.
  const tx = database.transaction(() => {
    const result = database
      .prepare(
        `DELETE FROM briefings WHERE id NOT IN (
           SELECT id FROM briefings b1
           WHERE NOT EXISTS (
             SELECT 1 FROM briefings b2
             WHERE b2.type = b1.type AND b2.date = b1.date
               AND (b2.created_at > b1.created_at
                    OR (b2.created_at = b1.created_at AND b2.id > b1.id))
           )
         )`,
      )
      .run()
    database.prepare(`INSERT OR REPLACE INTO migrations (key) VALUES (?)`).run(key)
    if (result.changes > 0) {
      console.log(`[Database] Removed ${result.changes} duplicate briefing rows`)
    }
  })
  tx()
}

function dedupeRestaurantVisits(database: Database.Database): void {
  const key = 'restaurant-visits-dedupe-place-date-v1'
  const done = database.prepare(`SELECT 1 FROM migrations WHERE key = ?`).get(key)
  if (done) return

  const duplicateGroups = database
    .prepare(
      `
    SELECT place_id, visit_date
    FROM restaurant_visits
    GROUP BY place_id, visit_date
    HAVING COUNT(*) > 1
  `,
    )
    .all() as Array<{ place_id: string; visit_date: string }>

  const tx = database.transaction(() => {
    const listVisits = database.prepare(`
      SELECT id, rating, notes, created_at
      FROM restaurant_visits
      WHERE place_id = ? AND visit_date = ?
      ORDER BY
        CASE WHEN notes IS NOT NULL AND notes != '' THEN 0 ELSE 1 END,
        created_at DESC,
        id DESC
    `)
    const deleteVisit = database.prepare(`DELETE FROM restaurant_visits WHERE id = ?`)
    const updateRestaurant = database.prepare(`
      UPDATE saved_restaurants
      SET
        personal_rating = (
          SELECT CASE WHEN COUNT(rating) > 0 THEN ROUND(AVG(rating), 1) ELSE NULL END
          FROM restaurant_visits
          WHERE place_id = ? AND deleted_at IS NULL
        ),
        visited = CASE WHEN EXISTS (
          SELECT 1 FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL
        ) THEN 1 ELSE 0 END,
        visit_date = (
          SELECT visit_date
          FROM restaurant_visits
          WHERE place_id = ? AND deleted_at IS NULL
          ORDER BY visit_date DESC
          LIMIT 1
        )
      WHERE place_id = ?
    `)

    const affectedPlaces = new Set<string>()
    let deleted = 0
    for (const group of duplicateGroups) {
      const visits = listVisits.all(group.place_id, group.visit_date) as Array<{ id: number }>
      for (const visit of visits.slice(1)) {
        deleteVisit.run(visit.id)
        deleted += 1
      }
      affectedPlaces.add(group.place_id)
    }

    for (const placeId of affectedPlaces) {
      updateRestaurant.run(placeId, placeId, placeId, placeId)
    }

    database.prepare(`INSERT OR REPLACE INTO migrations (key) VALUES (?)`).run(key)
    if (deleted > 0) {
      console.log(`[Database] Removed ${deleted} duplicate restaurant visit rows`)
    }
  })

  tx()
}

function rebinSleepToWakeDate(database: Database.Database): void {
  const key = 'sleep-wake-date-v1'
  const done = database.prepare(`SELECT 1 FROM migrations WHERE key = ?`).get(key)
  if (done) return

  const rows = database
    .prepare(`SELECT id, date, value_json FROM health_metrics WHERE metric_type = 'sleep'`)
    .all() as Array<{ id: number; date: string; value_json: string }>

  const tx = database.transaction(() => {
    const select = database.prepare(
      `SELECT id, date, value_json FROM health_metrics WHERE metric_type = 'sleep' AND date = ?`,
    )
    const del = database.prepare(`DELETE FROM health_metrics WHERE id = ?`)
    const update = database.prepare(`UPDATE health_metrics SET date = ? WHERE id = ?`)

    let moved = 0
    for (const row of rows) {
      let val: any
      try {
        val = JSON.parse(row.value_json)
      } catch {
        continue
      }
      const newDate = wakeDateFor(val)
      if (!newDate || newDate === row.date) continue

      // Resolve collisions: keep the row with the larger totalAsleep.
      const existing = select.get(newDate) as
        | { id: number; date: string; value_json: string }
        | undefined
      if (existing && existing.id !== row.id) {
        let existingVal: any
        try {
          existingVal = JSON.parse(existing.value_json)
        } catch {
          existingVal = {}
        }
        const newAsleep = Number(val.totalAsleep) || Number(val.asleep) || 0
        const exAsleep = Number(existingVal.totalAsleep) || Number(existingVal.asleep) || 0
        if (exAsleep >= newAsleep) {
          del.run(row.id)
          continue
        } else {
          del.run(existing.id)
        }
      }
      update.run(newDate, row.id)
      moved++
    }

    database.prepare(`INSERT OR REPLACE INTO migrations (key) VALUES (?)`).run(key)
    console.log(`Sleep wake-date migration: re-binned ${moved} of ${rows.length} sleep rows`)
  })
  tx()

  // Deduplicate holdings: keep the oldest row (lowest id) per symbol+quantity+cost_basis,
  // soft-delete the rest.
  const dedupKey = 'dedup-holdings-v2'
  const dedupDone = database.prepare(`SELECT 1 FROM migrations WHERE key = ?`).get(dedupKey)
  if (!dedupDone) {
    const dupes = database
      .prepare(
        `SELECT id FROM holdings
         WHERE id NOT IN (
           SELECT MIN(id) FROM holdings
           GROUP BY symbol, quantity, cost_basis
         )`,
      )
      .all() as Array<{ id: number }>

    if (dupes.length > 0) {
      const del = database.prepare('DELETE FROM holdings WHERE id = ?')
      for (const d of dupes) del.run(d.id)
      console.log(`[Database] Deleted ${dupes.length} duplicate holding rows`)
    }

    database.prepare(`INSERT OR REPLACE INTO migrations (key) VALUES (?)`).run(dedupKey)
  }
}

/**
 * Flag sleep records that are clearly bogus (timezone artifacts, watch misrecords).
 * Criteria: duration > 16h, reported asleep > 16h, daytime-to-evening
 * (sleep 7am-5pm + wake after 4pm), or wake at 8pm+.
 *
 * This is intentionally idempotent instead of a one-shot migration. Relay pulls
 * and imports can re-upsert old rows with excluded=0, so startup and sync paths
 * need to re-apply the flag without deleting data.
 */
export function applySleepOutlierExclusions(database: Database.Database = getDb()): number {
  const rows = database
    .prepare(
      `SELECT id, value_json FROM health_metrics WHERE metric_type = 'sleep' AND excluded = 0`,
    )
    .all() as Array<{ id: number; value_json: string }>

  const markExcluded = database.prepare(`UPDATE health_metrics SET excluded = 1 WHERE id = ?`)
  let count = 0

  const tx = database.transaction(() => {
    for (const row of rows) {
      let data: any
      try {
        data = JSON.parse(row.value_json)
      } catch {
        continue
      }
      const start = data.sleepStart || data.startDate || ''
      const end = data.sleepEnd || data.endDate || ''
      if (!start || !end) continue

      let s: Date, e: Date
      try {
        s = new Date(start.replace(' -', '-').replace(' +', '+'))
        e = new Date(end.replace(' -', '-').replace(' +', '+'))
        if (isNaN(s.getTime()) || isNaN(e.getTime())) continue
      } catch {
        continue
      }

      const durationH = (e.getTime() - s.getTime()) / 3_600_000
      const asleepH =
        (Number(data.totalAsleep) || Number(data.asleep) || Number(data.qty) || 0) / 60
      const sleepHour = s.getHours()
      const wakeHour = e.getHours()

      const isTooLong = durationH > 16
      const isReportedTooLong = asleepH > 16
      const isDaytimeMisrecord = sleepHour >= 7 && sleepHour <= 17 && wakeHour >= 16
      const isLateWake = wakeHour >= 20

      if (isTooLong || isReportedTooLong || isDaytimeMisrecord || isLateWake) {
        markExcluded.run(row.id)
        count++
      }
    }
  })
  tx()

  if (count > 0) {
    console.log(`Sleep outlier exclusion: flagged ${count} records`)
  }
  return count
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

const VALID_TABLES = new Set([
  'watchlist',
  'price_history',
  'news_articles',
  'health_metrics',
  'briefings',
  'chat_messages',
  'conversations',
  'chat_memory',
  'notion_sync_log',
  'notion_tasks',
  'daily_schedule',
  'weekend_plans',
  'weekend_map_cache',
  'weekend_event_cache',
  'saved_restaurants',
  'alerts',
  'holdings',
  'fundamentals',
  'earnings_calendar',
  'ai_activity_log',
  'sync_checkpoints',
  'health_alerts',
  'scheduler_activity_log',
  'price_cache',
  'restaurant_visits',
  'migrations',
])

const VALID_COLUMN_TYPES = new Set([
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
  'NUMERIC',
  "TEXT DEFAULT ''",
  'INTEGER DEFAULT 0',
  'INTEGER DEFAULT 1',
  'REAL DEFAULT 0',
  'NUMERIC DEFAULT 0',
  "BLOB DEFAULT X''",
  "TEXT DEFAULT 'restaurant'",
])

function addColumnsIfMissing(
  database: Database.Database,
  table: string,
  columns: Array<[string, string]>,
): void {
  if (!VALID_TABLES.has(table)) {
    throw new Error(`Invalid table for migration: ${table}`)
  }

  for (const [col, type] of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(col)) {
      throw new Error(`Invalid column for migration: ${table}.${col}`)
    }
    if (!VALID_COLUMN_TYPES.has(type)) {
      throw new Error(`Invalid column type for migration: ${table}.${col} ${type}`)
    }
  }

  const existing = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  )
  for (const [col, type] of columns) {
    if (existing.has(col)) continue
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    } catch (err) {
      console.error(`[db] failed to add ${table}.${col}:`, err)
    }
  }
}
