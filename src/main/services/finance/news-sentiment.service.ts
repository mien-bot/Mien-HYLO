/**
 * Daily AI-batched news sentiment scoring via Haiku.
 *
 * Pulls unscored (or stale-heuristic) news_articles rows in batches, sends
 * each batch as a single Haiku call asking for one classification per
 * headline, and persists the result with sentiment_source = 'ai'.
 *
 * Cost is small (~200 input tokens + ~10 output tokens per headline);
 * a typical daily batch of 50-100 headlines is well under $0.10.
 */

import { getDb } from '../../db/database'
import { runHaiku } from '../ai.service'
import { getAppSettings } from '../../lib/settings'

const BATCH_SIZE = 25
const DEFAULT_DAILY_CAP = 100
const RECENT_DAYS = 14

function getDailyCap(): number {
  const settings = getAppSettings()
  const raw = settings?.newsSentimentDailyCap
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10)
  if (Number.isFinite(n) && n > 0 && n <= 1000) return n
  return DEFAULT_DAILY_CAP
}

const SYSTEM_PROMPT = `You classify financial news headlines by their likely impact on the related stock or asset.
Output exactly one line per headline in the same order as the input, in the format:
<index>|<sentiment>|<confidence>
where:
- index is the 1-based number of the headline
- sentiment is one of: positive, negative, neutral
- confidence is a number 0-1 (e.g., 0.85)

"Positive" = likely to push the stock up (good earnings, upgrades, contract wins, FDA approval, etc.).
"Negative" = likely to push the stock down (misses, lawsuits, downgrades, recalls, bankruptcy, etc.).
"Neutral" = procedural, mixed signal, or unrelated to price direction.

Do NOT include any other text — no explanations, no preamble.`

interface ScoredRow {
  index: number
  sentiment: 'positive' | 'negative' | 'neutral'
  confidence: number
}

function parseHaikuOutput(text: string): ScoredRow[] {
  const lines = text.trim().split('\n')
  const out: ScoredRow[] = []
  for (const line of lines) {
    const parts = line.split('|').map((s) => s.trim())
    if (parts.length < 3) continue
    const idx = parseInt(parts[0])
    const sentRaw = parts[1].toLowerCase()
    const conf = parseFloat(parts[2])
    if (!Number.isFinite(idx)) continue
    if (sentRaw !== 'positive' && sentRaw !== 'negative' && sentRaw !== 'neutral') continue
    out.push({
      index: idx,
      sentiment: sentRaw,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    })
  }
  return out
}

/**
 * Score a single batch of articles. Returns number of rows updated.
 */
async function scoreBatch(
  rows: Array<{ id: number; title: string; related_symbols: string | null }>,
): Promise<number> {
  if (rows.length === 0) return 0

  const userPrompt = rows
    .map((r, i) => {
      let symbols = ''
      if (r.related_symbols) {
        try {
          symbols = (JSON.parse(r.related_symbols) as string[]).join(', ')
        } catch (err) {
          console.warn(
            `[news-sentiment] malformed related_symbols for article id=${r.id}:`,
            (err as Error)?.message,
          )
        }
      }
      return `${i + 1}. ${symbols ? `[${symbols}] ` : ''}${r.title}`
    })
    .join('\n')

  const text = await runHaiku(
    SYSTEM_PROMPT,
    userPrompt,
    `news-sentiment-batch-${rows.length}`,
    'news-sentiment',
  )
  const scored = parseHaikuOutput(text)

  const db = getDb()
  const update = db.prepare(`
    UPDATE news_articles
    SET sentiment = ?, sentiment_confidence = ?, sentiment_source = 'ai'
    WHERE id = ?
  `)

  let updated = 0
  const tx = db.transaction(() => {
    for (const s of scored) {
      const row = rows[s.index - 1]
      if (!row) continue
      update.run(s.sentiment, s.confidence, row.id)
      updated++
    }
  })
  tx()
  return updated
}

/**
 * Score unscored articles. Bounded by:
 *   - explicit maxArticles arg (caller cap)
 *   - appSettings.newsSentimentDailyCap (user cap, default 100)
 *   - articles older than RECENT_DAYS are skipped (stale headlines are
 *     low-signal for current price action)
 * Watchlist-related articles are prioritized so the cap reaches the
 * most relevant headlines first.
 */
export async function scoreUnscoredArticles(maxArticles: number = 200): Promise<number> {
  const db = getDb()
  const userCap = getDailyCap()
  const cap = Math.min(maxArticles, userCap)
  if (cap <= 0) return 0

  // Prioritize: articles whose related_symbols overlap the watchlist first,
  // newest-first within each priority. ORDER BY a CASE expression lets us
  // run this in a single query.
  const watchSymbols = (
    db.prepare('SELECT symbol FROM watchlist').all() as Array<{ symbol: string }>
  ).map((r) => r.symbol)
  const watchClause =
    watchSymbols.length > 0 ? watchSymbols.map(() => `related_symbols LIKE ?`).join(' OR ') : '0'
  const watchParams = watchSymbols.map((s) => `%${s}%`)

  const rows = db
    .prepare(
      `
    SELECT id, title, related_symbols FROM news_articles
    WHERE (sentiment_source IS NULL OR sentiment_source != 'ai')
      AND title IS NOT NULL
      AND (published_at IS NULL OR published_at >= datetime('now', '-${RECENT_DAYS} days'))
    ORDER BY
      CASE WHEN (${watchClause}) THEN 0 ELSE 1 END ASC,
      published_at DESC
    LIMIT ?
  `,
    )
    .all(...watchParams, cap) as Array<{
    id: number
    title: string
    related_symbols: string | null
  }>

  if (rows.length === 0) return 0

  let total = 0
  let failures = 0
  const batchCount = Math.ceil(rows.length / BATCH_SIZE)
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    try {
      total += await scoreBatch(batch)
    } catch (err) {
      failures++
      console.error('[NewsSentiment] batch failed:', (err as Error)?.message || err)
      // Continue with next batch — partial progress is better than nothing.
    }
  }
  // If every batch failed, propagate the error so the scheduler reports it
  if (failures === batchCount && batchCount > 0) {
    throw new Error(`All ${batchCount} sentiment batches failed`)
  }
  return total
}

/**
 * Get a sentiment summary for a symbol's recent news.
 * Returns aggregate counts + an average -1..+1 score.
 */
export function getSymbolSentimentSummary(
  symbol: string,
  days: number = 7,
): {
  positive: number
  negative: number
  neutral: number
  score: number
} {
  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT sentiment, sentiment_confidence FROM news_articles
    WHERE related_symbols LIKE ?
      AND published_at >= datetime('now', '-' || ? || ' days')
      AND sentiment IS NOT NULL
  `,
    )
    .all(`%${symbol}%`, days) as Array<{ sentiment: string; sentiment_confidence: number | null }>

  let pos = 0,
    neg = 0,
    neu = 0,
    score = 0,
    n = 0
  for (const r of rows) {
    const c = r.sentiment_confidence ?? 0.5
    if (r.sentiment === 'positive') {
      pos++
      score += c
      n++
    } else if (r.sentiment === 'negative') {
      neg++
      score -= c
      n++
    } else if (r.sentiment === 'neutral') {
      neu++
      n++
    }
  }
  return {
    positive: pos,
    negative: neg,
    neutral: neu,
    score: n > 0 ? score / n : 0,
  }
}
