import { getDb } from '../lib/database'

const YOUTUBE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  Accept: 'text/html,application/json,text/xml,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
}

interface CaptionTrack {
  baseUrl?: string
  languageCode?: string
  kind?: string
  name?: {
    simpleText?: string
    runs?: Array<{ text?: string }>
  }
}

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[]
    }
  }
}

export function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.replace(/^\//, '').split('/')[0] || null
    }
    if (parsed.searchParams.get('v')) return parsed.searchParams.get('v')
    return parsed.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/)?.[1] || null
  } catch {
    return url.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/)?.[1] || null
  }
}

function decodeText(value: string): string {
  return value
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([\dA-Fa-f]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
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
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

function extractPlayerResponse(html: string): PlayerResponse | null {
  for (const marker of ['ytInitialPlayerResponse =', 'var ytInitialPlayerResponse =']) {
    const index = html.indexOf(marker)
    if (index < 0) continue
    const json = extractBalancedJson(html, index + marker.length)
    if (!json) continue
    try {
      return JSON.parse(json) as PlayerResponse
    } catch {}
  }
  return null
}

// InnerTube ANDROID player endpoint. The watch-page ytInitialPlayerResponse is
// increasingly stripped of caption tracks (bot walls / consent gates), but this
// endpoint still serves them — the same approach yt-dlp / youtube-transcript-api use.
const INNERTUBE_CONTEXT = {
  client: { clientName: 'ANDROID', clientVersion: '20.10.38' },
}

function extractInnertubeApiKey(html: string): string | null {
  return html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1] ?? null
}

async function fetchInnertubeCaptionTracks(
  videoId: string,
  apiKey: string,
): Promise<CaptionTrack[]> {
  try {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
      method: 'POST',
      headers: { ...YOUTUBE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId }),
    })
    if (!res.ok) return []
    const data = (await res.json()) as PlayerResponse
    return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
  } catch {
    return []
  }
}

function trackName(track: CaptionTrack): string {
  if (track.name?.simpleText) return track.name.simpleText
  return track.name?.runs?.map((run) => run.text || '').join('') || ''
}

function chooseCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const usable = tracks.filter((track) => Boolean(track.baseUrl))
  return (
    usable.find((track) => track.languageCode?.toLowerCase().startsWith('en') && !track.kind) ||
    usable.find((track) => track.languageCode?.toLowerCase().startsWith('en')) ||
    usable.find((track) => /english/i.test(trackName(track))) ||
    usable[0] ||
    null
  )
}

function withFormat(baseUrl: string, format: 'json3' | 'srv3'): string {
  try {
    const parsed = new URL(baseUrl)
    parsed.searchParams.set('fmt', format)
    return parsed.toString()
  } catch {
    return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=${format}`
  }
}

function parseJson3(raw: string): string {
  const parsed = JSON.parse(raw) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> }
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
    const text = decodeText(match[1].replace(/\n/g, ' '))
    if (text) parts.push(text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function hasTranscript(context?: string | null): boolean {
  return Boolean(context && /Transcript \(/i.test(context))
}

async function fetchCaptionTranscript(url: string): Promise<string | null> {
  const videoId = extractYouTubeVideoId(url)
  if (!videoId) return null

  const page = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: YOUTUBE_HEADERS,
  })
  if (!page.ok) return null

  const html = await page.text()
  let tracks =
    extractPlayerResponse(html)?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []

  // Fallback: the embedded player response is often stripped of caption tracks.
  // Reuse the page's INNERTUBE_API_KEY to ask the ANDROID player endpoint.
  if (tracks.length === 0) {
    const apiKey = extractInnertubeApiKey(html)
    if (apiKey) tracks = await fetchInnertubeCaptionTracks(videoId, apiKey)
  }

  const track = chooseCaptionTrack(tracks)
  if (!track?.baseUrl) return null

  const jsonRes = await fetch(withFormat(track.baseUrl, 'json3'), { headers: YOUTUBE_HEADERS })
  if (jsonRes.ok) {
    try {
      const text = parseJson3(await jsonRes.text())
      if (text) return text
    } catch {}
  }

  const xmlRes = await fetch(withFormat(track.baseUrl, 'srv3'), { headers: YOUTUBE_HEADERS })
  if (!xmlRes.ok) return null
  return parseXmlTranscript(await xmlRes.text()) || null
}

export async function getYouTubeContext(
  url: string,
  existingContext?: string | null,
): Promise<string | null> {
  if (!/youtube\.com|youtu\.be/i.test(url)) return existingContext || null
  if (hasTranscript(existingContext)) return existingContext || null

  let sourceContext = existingContext
  if (!sourceContext) {
    try {
      const db = await getDb()
      const row = await db.getFirstAsync(
        'SELECT content_context FROM news_articles WHERE url = ?',
        url,
      ) as { content_context?: string | null } | null
      sourceContext = row?.content_context || null
      if (hasTranscript(sourceContext)) return sourceContext
    } catch {}
  }

  try {
    const transcript = await fetchCaptionTranscript(url)
    if (!transcript) return sourceContext || null

    const fetchedAt = new Date().toISOString()
    const prefix = sourceContext?.trim()
      ? `Video description / source context:\n${sourceContext.trim()}\n\n`
      : ''
    const context = `${prefix}Transcript metadata: source=YouTube captions; fetched_at=${fetchedAt}\nTranscript (YouTube captions):\n${transcript.slice(0, 24_000)}`
    const db = await getDb()
    await db.runAsync(
      `UPDATE news_articles
       SET content_context = ?,
           transcript_status = ?,
           transcript_source = ?,
           transcript_fetched_at = ?
       WHERE url = ?`,
      context,
      'captions',
      'youtube_captions',
      fetchedAt,
      url,
    )
    return context
  } catch {
    return sourceContext || null
  }
}
