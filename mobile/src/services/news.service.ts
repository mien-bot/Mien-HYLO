/**
 * News service — fetches finance news from relay server or Google News RSS
 * Stores articles locally for offline access.
 */

import { getDb } from '../lib/database'
import { getSettings } from '../lib/storage'

export interface NewsArticle {
  id?: number
  title: string
  url: string
  source: string
  published_at: string
  related_symbols: string
  summary?: string
  content_context?: string | null
  transcript_status?: string | null
  transcript_source?: string | null
  transcript_fetched_at?: string | null
}

/**
 * Fetch news from relay server (pre-computed by desktop)
 */
export async function fetchNewsFromRelay(): Promise<NewsArticle[]> {
  const settings = await getSettings()
  const relayUrl = settings.relayUrl?.replace(/\/$/, '')
  if (!relayUrl) return []

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (settings.relayToken) {
      headers['Authorization'] = `Bearer ${settings.relayToken}`
    }

    const res = await fetch(`${relayUrl}/finance/news`, { headers })
    if (!res.ok) return []

    const data = await res.json()
    const articles: NewsArticle[] = data.articles || []

    // Store locally
    const db = await getDb()
    for (const a of articles) {
      await db.runAsync(
        `INSERT INTO news_articles
         (title, url, source, published_at, related_symbols, summary, content_context, transcript_status, transcript_source, transcript_fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           summary = COALESCE(excluded.summary, news_articles.summary),
           content_context = COALESCE(excluded.content_context, news_articles.content_context),
           transcript_status = COALESCE(excluded.transcript_status, news_articles.transcript_status),
           transcript_source = COALESCE(excluded.transcript_source, news_articles.transcript_source),
           transcript_fetched_at = COALESCE(excluded.transcript_fetched_at, news_articles.transcript_fetched_at)`,
        a.title, a.url, a.source, a.published_at, a.related_symbols || '[]', a.summary || null,
        a.content_context || null, a.transcript_status || null, a.transcript_source || null,
        a.transcript_fetched_at || null
      )
    }

    return articles
  } catch {
    return []
  }
}

/**
 * Fetch news directly from Google News RSS (fallback when no relay)
 */
export async function fetchNewsFromRSS(symbols: string[] = []): Promise<NewsArticle[]> {
  const articles: NewsArticle[] = []
  const queries = ['stock market today', 'cryptocurrency news']

  // Add first 3 watchlist symbols
  for (const sym of symbols.slice(0, 3)) {
    queries.push(`${sym} stock`)
  }

  for (const query of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        }
      })
      if (!res.ok) continue

      const text = await res.text()

      // Simple XML parsing for RSS items
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) || []
      for (const item of items.slice(0, 5)) {
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/)
        const linkMatch = item.match(/<link>(.*?)<\/link>/)
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/)
        const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/)

        if (titleMatch && linkMatch) {
          const title = titleMatch[1].replace(/<[^>]+>/g, '').trim()
          // Extract source from title "Headline - Source Name"
          const sourceName = sourceMatch?.[1] || title.match(/ - ([^-]+)$/)?.[1] || 'Google News'

          // Check if related to any symbols
          const relatedSymbols = symbols.filter(s =>
            title.toUpperCase().includes(s.toUpperCase())
          )

          articles.push({
            title: title.replace(/ - [^-]+$/, '').trim(),
            url: linkMatch[1],
            source: sourceName.trim(),
            published_at: pubDateMatch?.[1] || new Date().toISOString(),
            related_symbols: JSON.stringify(relatedSymbols),
          })
        }
      }
    } catch {
      // Skip failed queries
    }
  }

  // Store articles locally
  if (articles.length > 0) {
    const db = await getDb()
    for (const a of articles) {
      await db.runAsync(
        `INSERT OR IGNORE INTO news_articles (title, url, source, published_at, related_symbols)
         VALUES (?, ?, ?, ?, ?)`,
        a.title, a.url, a.source, a.published_at, a.related_symbols
      )
    }
  }

  return articles
}

// --- YouTube Channel Defaults (same as desktop) ---

interface YouTubeChannel {
  name: string
  channelId: string
  handle?: string
}

const DEFAULT_YT_CHANNELS: YouTubeChannel[] = [
  { name: 'Meet Kevin', channelId: 'UCUvvj5lwue7PspotMDjk5UA', handle: 'meetkevin' },
  { name: 'Trading Fraternity', channelId: 'UCymzDnu-l3vZ1fxuqvRePOA', handle: 'Thetradingfraternity' },
  { name: 'Andrei Jikh', channelId: 'UCGy7SkBjcIAgTiwkXEtPnYg', handle: 'AndreiJikh' },
  { name: 'Financial Education', channelId: 'UCnMn36GT_H0X-w5_ckLtlgQ', handle: 'financialeducation' },
  { name: 'Graham Stephan', channelId: 'UCV6KDgJskWaEckne5aPA0aQ', handle: 'GrahamStephan' },
]

const YOUTUBE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  'Accept': 'application/atom+xml,application/xml,text/xml,text/html,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
}

const KNOWN_YT_CHANNEL_REPLACEMENTS: Record<string, Partial<YouTubeChannel>> = {
  UC0ItS3yMDYkMXMGRMHe5fOA: {
    channelId: 'UCymzDnu-l3vZ1fxuqvRePOA',
    handle: 'Thetradingfraternity',
  },
}

function decodeYouTubeText(value: string): string {
  return value
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function parseYouTubeEntries(xml: string): NewsArticle[] {
  const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || []
  const articles: NewsArticle[] = []
  for (const entry of entries.slice(0, 5)) {
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim()
    const link = entry.match(/<link[^>]*href="([^"]+)"/)?.[1]
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1]
    const description = entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]?.trim()

    if (!title || !link) continue
    articles.push({
      title: decodeYouTubeText(title),
      url: link,
      source: '',
      published_at: published ? new Date(published).toISOString() : new Date().toISOString(),
      related_symbols: '[]',
      content_context: description ? decodeYouTubeText(description).slice(0, 4000) : null,
    })
  }
  return articles
}

function parseYouTubePage(html: string): NewsArticle[] {
  const articles: NewsArticle[] = []
  const seen = new Set<string>()
  const regex = /"lockupMetadataViewModel":\{"title":\{"content":"((?:\\.|[^"\\])*)"[\s\S]{0,5000}?"contentId":"([A-Za-z0-9_-]{11})"/g
  let match

  while ((match = regex.exec(html)) !== null && articles.length < 5) {
    const title = decodeYouTubeText(match[1])
    const videoId = match[2]
    if (!title || seen.has(videoId)) continue
    seen.add(videoId)
    articles.push({
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      source: '',
      published_at: new Date().toISOString(),
      related_symbols: '[]',
    })
  }

  return articles
}

/**
 * Fetch latest YouTube videos from finance channels via RSS (no API key needed)
 */
export async function fetchYouTubeVideos(): Promise<NewsArticle[]> {
  const articles: NewsArticle[] = []
  const settings = await getSettings()
  const channelSetting = (settings as any).youtubeChannels as string | undefined

  // Parse user-configured channels or use defaults
  const channels = channelSetting
    ? channelSetting.split('\n').map((line): YouTubeChannel | null => {
        const [name, channelId, handle] = line.trim().split('|').map(s => s.trim())
        return name && channelId ? { name, channelId, handle: handle?.replace(/^@/, '') } : null
      }).filter((c): c is YouTubeChannel => c !== null)
    : DEFAULT_YT_CHANNELS

  for (const rawChannel of channels) {
    const replacement = KNOWN_YT_CHANNEL_REPLACEMENTS[rawChannel.channelId]
    const channel = replacement ? { ...rawChannel, ...replacement } : rawChannel
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
      let channelArticles: NewsArticle[] = []
      const res = await fetch(rssUrl, { headers: YOUTUBE_HEADERS })
      if (res.ok) {
        channelArticles = parseYouTubeEntries(await res.text())
      }

      if (channelArticles.length === 0) {
        const pagePaths = [
          channel.handle ? `@${channel.handle}/videos` : null,
          `channel/${channel.channelId}/videos`,
        ].filter((path): path is string => Boolean(path))

        for (const path of pagePaths) {
          const pageRes = await fetch(`https://www.youtube.com/${path}`, { headers: YOUTUBE_HEADERS })
          if (!pageRes.ok) continue
          channelArticles = parseYouTubePage(await pageRes.text())
          if (channelArticles.length > 0) break
        }
      }

      for (const article of channelArticles) {
        articles.push({
          ...article,
          source: `YouTube: ${channel.name}`,
        })
      }
    } catch {
      // Skip failed channels
    }
  }

  // Store locally
  if (articles.length > 0) {
    const db = await getDb()
    for (const a of articles) {
      await db.runAsync(
        `INSERT INTO news_articles (title, url, source, published_at, related_symbols, content_context)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           content_context = COALESCE(excluded.content_context, news_articles.content_context)`,
        a.title, a.url, a.source, a.published_at, a.related_symbols, a.content_context || null
      )
    }
  }

  return articles
}

/**
 * Get locally cached news articles
 */
export async function getLocalNews(limit: number = 20): Promise<NewsArticle[]> {
  const db = await getDb()
  return db.getAllAsync(
    `SELECT * FROM news_articles ORDER BY published_at DESC LIMIT ?`, limit
  ) as Promise<NewsArticle[]>
}

/**
 * Refresh news — fetches from relay, RSS, and YouTube in parallel.
 * Also cleans up articles older than 7 days to prevent stale accumulation.
 */
export async function refreshNews(watchlistSymbols: string[] = []): Promise<NewsArticle[]> {
  // Clean up old articles (>7 days) so stale news doesn't linger
  try {
    const db = await getDb()
    await db.runAsync(
      `DELETE FROM news_articles WHERE published_at < datetime('now', '-7 days')`
    )
  } catch {}

  // Fetch all sources in parallel
  const [relayArticles, rssArticles, ytArticles] = await Promise.all([
    fetchNewsFromRelay().catch(() => [] as NewsArticle[]),
    fetchNewsFromRSS(watchlistSymbols).catch(() => [] as NewsArticle[]),
    fetchYouTubeVideos().catch(() => [] as NewsArticle[]),
  ])

  let articles = [...relayArticles, ...rssArticles, ...ytArticles]

  if (articles.length === 0) {
    articles = await getLocalNews()
  }
  // Sort by published date
  return articles.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
}
