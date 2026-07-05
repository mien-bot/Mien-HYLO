import Parser from 'rss-parser'
import { getDb } from '../../db/database'

const parser = new Parser({ timeout: 10_000 })

export async function fetchFinanceNews(symbols: string[]): Promise<number> {
  const db = getDb()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO news_articles (title, url, source, published_at, related_symbols, content_context)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const updateMissingContext = db.prepare(`
    UPDATE news_articles
    SET content_context = ?
    WHERE url = ? AND (content_context IS NULL OR content_context = '')
  `)

  let totalInserted = 0

  // Fetch general finance news
  const queries = [
    'stock market today',
    'cryptocurrency news',
    ...symbols.slice(0, 5).map((s) => `${s} stock`),
  ]

  for (const query of queries) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
      const feed = await parser.parseURL(rssUrl)

      const insertMany = db.transaction(() => {
        for (const item of feed.items.slice(0, 10)) {
          const title = item.title || ''
          const url = item.link || ''
          const source = item.creator || extractSource(title)
          const pubDate = item.pubDate ? new Date(item.pubDate).toISOString() : null
          const contentContext = item.contentSnippet || item.content || null

          // Find which symbols this article relates to
          const related = symbols.filter((s) => title.toUpperCase().includes(s.toUpperCase()))

          const result = insert.run(
            title,
            url,
            source,
            pubDate,
            related.length > 0 ? JSON.stringify(related) : null,
            contentContext,
          )
          if (result.changes > 0) totalInserted++
          else if (contentContext) updateMissingContext.run(contentContext, url)
        }
      })
      insertMany()
    } catch (err) {
      console.error(`Failed to fetch news for "${query}":`, err)
    }
  }

  console.log(`Fetched ${totalInserted} new articles`)
  return totalInserted
}

function extractSource(title: string): string {
  // Google News titles often end with " - Source Name"
  const match = title.match(/ - ([^-]+)$/)
  return match ? match[1].trim() : 'Google News'
}

/**
 * Flag news articles whose `published_at` is older than `daysOld` days (or
 * whose `fetched_at` is older than that if published_at is null) by setting
 * `archived_at` to now. Idempotent. Returns the number of rows updated.
 *
 * Archived rows stay in the DB (so existing AI prompt history and any
 * sentiment back-fills survive) but are hidden from the dashboard/news
 * panel queries.
 */
export function archiveStaleNews(daysOld: number = 7): number {
  const db = getDb()
  const cutoff = `datetime('now', '-${daysOld} days')`
  const result = db
    .prepare(
      `
    UPDATE news_articles
    SET archived_at = datetime('now')
    WHERE archived_at IS NULL
      AND saved_at IS NULL
      AND COALESCE(published_at, fetched_at) < ${cutoff}
  `,
    )
    .run()
  if (result.changes > 0) {
    console.log(`[news] Archived ${result.changes} articles older than ${daysOld} days`)
  }
  return result.changes
}

/**
 * Returns the count of currently-active (non-archived) news articles and
 * the count of archived ones. Useful for diagnostics when news feels stale.
 */
export function getNewsStats(): { active: number; archived: number; oldestActive: string | null } {
  const db = getDb()
  const active = (
    db.prepare(`SELECT COUNT(*) AS n FROM news_articles WHERE archived_at IS NULL`).get() as {
      n: number
    }
  ).n
  const archived = (
    db.prepare(`SELECT COUNT(*) AS n FROM news_articles WHERE archived_at IS NOT NULL`).get() as {
      n: number
    }
  ).n
  const oldest = db
    .prepare(
      `SELECT published_at FROM news_articles WHERE archived_at IS NULL ORDER BY published_at ASC LIMIT 1`,
    )
    .get() as { published_at: string | null } | undefined
  return { active, archived, oldestActive: oldest?.published_at ?? null }
}
