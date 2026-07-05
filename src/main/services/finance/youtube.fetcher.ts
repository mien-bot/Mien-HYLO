import { getDb } from '../../db/database'
import { fetchJson, fetchText } from '../../lib/fetch-with-retry'

export interface YouTubeChannel {
  name: string
  channelId: string
  handle?: string
}

export interface YouTubeFetchResult {
  fetched: number
  inserted: number
  failed: number
}

// Default finance-focused channels
export const DEFAULT_CHANNELS: YouTubeChannel[] = [
  { name: 'Meet Kevin', channelId: 'UCUvvj5lwue7PspotMDjk5UA', handle: 'meetkevin' },
  {
    name: 'Trading Fraternity',
    channelId: 'UCymzDnu-l3vZ1fxuqvRePOA',
    handle: 'Thetradingfraternity',
  },
  { name: 'Andrei Jikh', channelId: 'UCGy7SkBjcIAgTiwkXEtPnYg', handle: 'AndreiJikh' },
  {
    name: 'Financial Education',
    channelId: 'UCnMn36GT_H0X-w5_ckLtlgQ',
    handle: 'financialeducation',
  },
  { name: 'Graham Stephan', channelId: 'UCV6KDgJskWaEckne5aPA0aQ', handle: 'GrahamStephan' },
]

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const YOUTUBE_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/atom+xml,application/xml,text/xml,text/html,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
}
const KNOWN_CHANNEL_ID_REPLACEMENTS: Record<string, Partial<YouTubeChannel>> = {
  UC0ItS3yMDYkMXMGRMHe5fOA: {
    channelId: 'UCymzDnu-l3vZ1fxuqvRePOA',
    handle: 'Thetradingfraternity',
  },
}

interface VideoEntry {
  title: string
  url: string
  published: string | null
  description: string
}

interface YouTubeCaptionTrack {
  baseUrl?: string
  languageCode?: string
  kind?: string
  name?: {
    simpleText?: string
    runs?: Array<{ text?: string }>
  }
}

interface YouTubePlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YouTubeCaptionTrack[]
    }
  }
}

function parseAtomFeed(xml: string): VideoEntry[] {
  const entries: VideoEntry[] = []
  // Match each <entry>...</entry>
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1]
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || ''
    const link = block.match(/<link[^>]*href="([^"]+)"/)?.[1] || ''
    const published = block.match(/<published>([^<]+)<\/published>/)?.[1] || null
    const description =
      block.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]?.trim() || ''

    if (title && link) {
      entries.push({ title, url: link, published, description })
    }
  }
  return entries
}

function decodeText(value: string): string {
  return value
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function decodeHtmlText(value: string): string {
  return decodeText(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([\dA-Fa-f]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

function parseChannelPage(html: string): VideoEntry[] {
  const entries: VideoEntry[] = []
  const seen = new Set<string>()
  const lockupRegex =
    /"lockupMetadataViewModel":\{"title":\{"content":"((?:\\.|[^"\\])*)"[\s\S]{0,5000}?"contentId":"([A-Za-z0-9_-]{11})"/g
  let match

  while ((match = lockupRegex.exec(html)) !== null) {
    const title = decodeText(match[1])
    const videoId = match[2]
    if (!title || seen.has(videoId)) continue
    seen.add(videoId)
    entries.push({
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      published: new Date().toISOString(),
      description: '',
    })
  }

  return entries
}

async function fetchVideosForChannel(channel: YouTubeChannel): Promise<VideoEntry[]> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`
  const xml = await fetchText(rssUrl, {
    headers: YOUTUBE_HEADERS,
    label: `youtube ${channel.name}`,
  })
  if (xml) {
    const entries = parseAtomFeed(xml)
    if (entries.length > 0) return entries
  }

  const pagePaths = [
    channel.handle ? `@${channel.handle}/videos` : null,
    `channel/${channel.channelId}/videos`,
  ].filter((path): path is string => Boolean(path))

  for (const path of pagePaths) {
    const html = await fetchText(`https://www.youtube.com/${path}`, {
      headers: YOUTUBE_HEADERS,
      label: `youtube page ${channel.name}`,
    })
    if (!html) continue
    const entries = parseChannelPage(html)
    if (entries.length > 0) return entries
  }

  return []
}

export function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.replace(/^\//, '').split('/')[0] || null
    }
    if (parsed.searchParams.get('v')) return parsed.searchParams.get('v')
    const shortsMatch = parsed.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/)
    if (shortsMatch) return shortsMatch[1]
  } catch {
    const match = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/)
    return match?.[1] ?? null
  }
  return null
}

function extractBalancedJson(source: string, start: number): string | null {
  const open = source.indexOf('{', start)
  if (open < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }

  return null
}

function extractPlayerResponse(html: string): YouTubePlayerResponse | null {
  const markers = ['ytInitialPlayerResponse =', 'var ytInitialPlayerResponse =']
  for (const marker of markers) {
    const index = html.indexOf(marker)
    if (index < 0) continue
    const json = extractBalancedJson(html, index + marker.length)
    if (!json) continue
    try {
      return JSON.parse(json) as YouTubePlayerResponse
    } catch {}
  }
  return null
}

// InnerTube ANDROID player endpoint. The watch-page HTML increasingly ships
// without caption tracks (bot walls / consent gates), but this endpoint still
// returns them reliably — the same approach yt-dlp / youtube-transcript-api use.
const INNERTUBE_CONTEXT = {
  client: { clientName: 'ANDROID', clientVersion: '20.10.38' },
}

function extractInnertubeApiKey(html: string): string | null {
  return html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1] ?? null
}

async function fetchInnertubeCaptionTracks(
  videoId: string,
  apiKey: string,
): Promise<YouTubeCaptionTrack[]> {
  const data = await fetchJson<YouTubePlayerResponse>(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
    {
      method: 'POST',
      body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId }),
      headers: { ...YOUTUBE_HEADERS, 'Content-Type': 'application/json' },
      label: `youtube innertube ${videoId}`,
      timeoutMs: 12_000,
      retries: 1,
    },
  )
  return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
}

function captionTrackName(track: YouTubeCaptionTrack): string {
  if (track.name?.simpleText) return track.name.simpleText
  return track.name?.runs?.map((run) => run.text || '').join('') || ''
}

function chooseCaptionTrack(tracks: YouTubeCaptionTrack[]): YouTubeCaptionTrack | null {
  const usable = tracks.filter((track) => Boolean(track.baseUrl))
  if (usable.length === 0) return null

  return (
    usable.find((track) => track.languageCode?.toLowerCase().startsWith('en') && !track.kind) ||
    usable.find((track) => track.languageCode?.toLowerCase().startsWith('en')) ||
    usable.find((track) => /english/i.test(captionTrackName(track))) ||
    usable[0]
  )
}

function withTranscriptFormat(baseUrl: string, format: 'json3' | 'srv3'): string {
  try {
    const parsed = new URL(baseUrl)
    parsed.searchParams.set('fmt', format)
    return parsed.toString()
  } catch {
    return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=${format}`
  }
}

function parseJson3Transcript(raw: string): string {
  const parsed = JSON.parse(raw) as {
    events?: Array<{ segs?: Array<{ utf8?: string }> }>
  }
  return (
    parsed.events
      ?.flatMap((event) => event.segs || [])
      .map((seg) => seg.utf8 || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim() || ''
  )
}

function parseXmlTranscript(raw: string): string {
  const parts: string[] = []
  const regex = /<text[^>]*>([\s\S]*?)<\/text>/g
  let match
  while ((match = regex.exec(raw)) !== null) {
    const text = decodeHtmlText(match[1].replace(/\n/g, ' '))
    if (text) parts.push(text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export async function fetchYouTubeCaptionTranscript(videoUrl: string): Promise<string | null> {
  const videoId = extractYouTubeVideoId(videoUrl)
  if (!videoId) return null

  const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: YOUTUBE_HEADERS,
    label: `youtube transcript page ${videoId}`,
    timeoutMs: 12_000,
    retries: 1,
  })
  if (!html) return null

  // Primary: caption tracks embedded in the watch page (ytInitialPlayerResponse).
  let tracks =
    extractPlayerResponse(html)?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []

  // Fallback: the embedded player response is often stripped of caption tracks.
  // Reuse the page's INNERTUBE_API_KEY to ask the ANDROID player endpoint, which
  // still serves them.
  if (tracks.length === 0) {
    const apiKey = extractInnertubeApiKey(html)
    if (apiKey) {
      tracks = await fetchInnertubeCaptionTracks(videoId, apiKey)
    }
  }

  const track = chooseCaptionTrack(tracks)
  if (!track?.baseUrl) return null

  const jsonTranscript = await fetchText(withTranscriptFormat(track.baseUrl, 'json3'), {
    headers: YOUTUBE_HEADERS,
    label: `youtube transcript ${videoId}`,
    timeoutMs: 12_000,
    retries: 1,
  })
  if (jsonTranscript) {
    try {
      const text = parseJson3Transcript(jsonTranscript)
      if (text) return text
    } catch {}
  }

  const xmlTranscript = await fetchText(withTranscriptFormat(track.baseUrl, 'srv3'), {
    headers: YOUTUBE_HEADERS,
    label: `youtube transcript fallback ${videoId}`,
    timeoutMs: 12_000,
    retries: 1,
  })
  return xmlTranscript ? parseXmlTranscript(xmlTranscript) || null : null
}

export async function fetchYouTubeTranscriptContext(
  videoUrl: string,
  existingContext?: string | null,
): Promise<string | null> {
  if (!/youtube\.com|youtu\.be/i.test(videoUrl)) return existingContext || null
  if (existingContext && /Transcript \(/i.test(existingContext)) return existingContext

  const transcript = await fetchYouTubeCaptionTranscript(videoUrl)
  if (!transcript) return existingContext || null

  const prefix = existingContext?.trim()
    ? `Video description / source context:\n${existingContext.trim()}\n\n`
    : ''
  return `${prefix}Transcript (YouTube captions):\n${transcript.slice(0, 24_000)}`
}

function normalizeChannel(channel: YouTubeChannel): YouTubeChannel {
  const replacement = KNOWN_CHANNEL_ID_REPLACEMENTS[channel.channelId]
  return replacement ? { ...channel, ...replacement } : channel
}

export async function fetchYouTubeVideos(channels?: YouTubeChannel[]): Promise<YouTubeFetchResult> {
  const db = getDb()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO news_articles (title, url, source, published_at, summary, content_context)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const updateMissingContext = db.prepare(`
    UPDATE news_articles
    SET content_context = ?
    WHERE url = ? AND (content_context IS NULL OR content_context = '')
  `)
  const channelList = channels && channels.length > 0 ? channels : DEFAULT_CHANNELS
  let totalFetched = 0
  let totalInserted = 0
  let failed = 0

  for (const rawChannel of channelList) {
    const channel = normalizeChannel(rawChannel)
    try {
      const videos = (await fetchVideosForChannel(channel)).slice(0, 10)
      totalFetched += videos.length
      if (videos.length === 0) {
        failed++
        continue
      }

      const insertMany = db.transaction(() => {
        for (const video of videos) {
          const pubDate = video.published ? new Date(video.published).toISOString() : null
          // Leave summary empty so the renderer generates a real AI summary on demand.
          // YouTube RSS descriptions are often sponsorships, coupon codes, or links.
          const summary = null
          const contentContext = video.description ? decodeText(video.description).slice(0, 4000) : null

          const result = insert.run(
            video.title,
            video.url,
            `YouTube: ${channel.name}`,
            pubDate,
            summary,
            contentContext,
          )
          if (result.changes > 0) {
            totalInserted++
          } else if (contentContext) {
            updateMissingContext.run(contentContext, video.url)
          }
        }
      })
      insertMany()
    } catch (err) {
      failed++
      console.error(`Failed to fetch YouTube videos for "${channel.name}":`, err)
    }
  }

  console.log(
    `Fetched ${totalFetched} YouTube videos (${totalInserted} new, ${failed} failed channels)`,
  )
  return { fetched: totalFetched, inserted: totalInserted, failed }
}

/** Parse user setting string into channel list. Format: "Name|ChannelId" or "Name|ChannelId|Handle" per line */
export function parseChannelsSetting(raw: string): YouTubeChannel[] {
  if (!raw || !raw.trim()) return DEFAULT_CHANNELS

  const channels: YouTubeChannel[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [name, channelId, handle] = trimmed.split('|').map((s) => s.trim())
    if (name && channelId) {
      channels.push({ name, channelId, handle: handle?.replace(/^@/, '') || undefined })
    }
  }
  return channels.length > 0 ? channels : DEFAULT_CHANNELS
}
