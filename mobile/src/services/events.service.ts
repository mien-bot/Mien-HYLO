/**
 * Ticketmaster Discovery API — fetches local events for planning
 */
import { getSettings } from '../lib/storage'
import { getDb } from '../lib/database'

export interface Event {
  name: string
  date: string
  time: string
  venue: string
  url: string
  category: string
  genre: string | null
  priceRange: string | null
  imageUrl: string | null
  description: string | null
}

export type EventCategoryId =
  | 'all'
  | 'music'
  | 'sports'
  | 'baseball'
  | 'shows'
  | 'comedy'
  | 'arts'
  | 'family'
  | 'festivals'

export interface EventSearchResult {
  events: Event[]
  page: number
  totalPages: number
  totalElements: number
}

function eventCacheKey(event: Event): string {
  if (event.url) return `url:${event.url}`
  return [
    event.name || '',
    event.date || '',
    event.time || '',
    event.venue || '',
  ].join('|').toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim()
}

async function saveEventSearchResults(events: Event[], meta: { source: string; query?: string; category?: string }) {
  if (events.length === 0) return
  try {
    const db = await getDb()
    for (const event of events) {
      if (!event.name) continue
      await db.runAsync(
        `INSERT INTO weekend_event_cache (
          event_key, name, event_date, time, venue, address, city, type,
          price_range, url, image_url, description, source, query, category, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(event_key) DO UPDATE SET
          name = excluded.name,
          event_date = excluded.event_date,
          time = excluded.time,
          venue = excluded.venue,
          type = excluded.type,
          price_range = excluded.price_range,
          url = excluded.url,
          image_url = excluded.image_url,
          description = excluded.description,
          source = excluded.source,
          query = excluded.query,
          category = excluded.category,
          updated_at = datetime('now')`,
        eventCacheKey(event),
        event.name,
        event.date || '',
        event.time || '',
        event.venue || '',
        '',
        '',
        event.category || 'Event',
        event.priceRange || '',
        event.url || '',
        event.imageUrl || null,
        event.description || '',
        meta.source,
        meta.query || '',
        meta.category || ''
      )
    }
  } catch {}
}

const DEFAULT_PAGE_SIZE = 20

const CATEGORY_PARAMS: Record<Exclude<EventCategoryId, 'all'>, { classificationName?: string; keyword?: string }> = {
  music: { classificationName: 'Music' },
  sports: { classificationName: 'Sports' },
  baseball: { classificationName: 'Baseball' },
  shows: { classificationName: 'Theatre' },
  comedy: { classificationName: 'Comedy' },
  arts: { classificationName: 'Arts & Theatre' },
  family: { classificationName: 'Family' },
  festivals: { keyword: 'festival' },
}

/**
 * Fetch events near the user's city for a date range
 */
export async function fetchWeekendEvents(
  startDate: string,
  endDate: string
): Promise<Event[]> {
  const settings = await getSettings()
  const apiKey = settings.ticketmasterKey
  if (!apiKey) return []

  const city = settings.weekendCity || 'Chicago'

  try {
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?` +
      `apikey=${apiKey}` +
      `&city=${encodeURIComponent(city)}` +
      `&startDateTime=${startDate}T00:00:00Z` +
      `&endDateTime=${endDate}T23:59:59Z` +
      `&size=10` +
      `&sort=date,asc`

    const res = await fetch(url)
    if (!res.ok) return []

    const data = await res.json()
    const events = parseEvents(data)
    await saveEventSearchResults(events, { source: 'ticketmaster', query: '', category: 'weekend' })
    return events
  } catch {
    return []
  }
}

/**
 * Search events by keyword (artist/band name, genre, etc.)
 */
export async function searchEvents(
  keyword: string,
  options?: {
    category?: EventCategoryId
    musicGenre?: string
    startDate?: string
    endDate?: string
    page?: number
  }
): Promise<EventSearchResult> {
  return queryEvents({
    keyword,
    category: options?.category,
    musicGenre: options?.musicGenre,
    startDate: options?.startDate,
    endDate: options?.endDate,
    page: options?.page,
  })
}

/**
 * Browse upcoming Chicago-area events across all event types.
 */
export async function browseEvents(options: {
  category?: EventCategoryId
  musicGenre?: string
  startDate?: string
  endDate?: string
  page?: number
} = {}): Promise<EventSearchResult> {
  return queryEvents(options)
}

/**
 * Browse upcoming music events (kept for older callers).
 */
export async function browseMusic(genre?: string): Promise<Event[]> {
  const result = await browseEvents({ category: 'music', musicGenre: genre })
  return result.events
}

async function queryEvents(options: {
  keyword?: string
  category?: EventCategoryId
  musicGenre?: string
  startDate?: string
  endDate?: string
  page?: number
} = {}): Promise<EventSearchResult> {
  const settings = await getSettings()
  const apiKey = settings.ticketmasterKey
  if (!apiKey) return emptyResult(options.page)

  const city = settings.weekendCity || 'Chicago'
  const category = options.category || 'all'
  const now = new Date().toISOString().split('.')[0] + 'Z'

  try {
    const params = new URLSearchParams({
      apikey: apiKey,
      city,
      size: String(DEFAULT_PAGE_SIZE),
      page: String(options.page || 0),
      sort: 'date,asc',
    })

    const keywordParts = [
      options.keyword?.trim(),
      category !== 'all' ? CATEGORY_PARAMS[category]?.keyword : undefined,
      category === 'music' && options.musicGenre && options.musicGenre !== 'All'
        ? options.musicGenre
        : undefined,
    ].filter(Boolean)

    if (keywordParts.length > 0) {
      params.set('keyword', keywordParts.join(' '))
    }

    const classificationName = category !== 'all' ? CATEGORY_PARAMS[category]?.classificationName : undefined
    if (classificationName) {
      params.set('classificationName', classificationName)
    }

    if (options.startDate) {
      params.set('startDateTime', `${options.startDate}T00:00:00Z`)
    } else {
      params.set('startDateTime', now)
    }
    if (options.endDate) {
      params.set('endDateTime', `${options.endDate}T23:59:59Z`)
    }

    const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`
    const res = await fetch(url)
    if (!res.ok) return emptyResult(options.page)

    const data = await res.json()
    const events = parseEvents(data)
    await saveEventSearchResults(events, {
      source: 'ticketmaster',
      query: options.keyword || '',
      category: category,
    })
    return {
      events,
      page: data?.page?.number || options.page || 0,
      totalPages: data?.page?.totalPages || 0,
      totalElements: data?.page?.totalElements || 0,
    }
  } catch {
    return emptyResult(options.page)
  }
}

function emptyResult(page: number = 0): EventSearchResult {
  return {
    events: [],
    page,
    totalPages: 0,
    totalElements: 0,
  }
}

function normalizeEventText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function parseEventTimeMins(time: string): number | null {
  const match = (time || '').match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function eventBaseKey(event: Event): string {
  return [
    normalizeEventText(event.name),
    normalizeEventText(event.venue),
    event.date,
  ].join('|')
}

function isNearDuplicateEvent(a: Event, b: Event): boolean {
  // Same name + venue + date = same event (different time slots) → dedup
  if (eventBaseKey(a) === eventBaseKey(b)) return true

  // Fuzzy: same venue + date, one name contains the other
  if (normalizeEventText(a.venue) === normalizeEventText(b.venue) && a.date === b.date) {
    const aN = normalizeEventText(a.name)
    const bN = normalizeEventText(b.name)
    if (aN && bN && (aN.includes(bN) || bN.includes(aN))) return true
  }

  return false
}

function eventScore(event: Event): number {
  return [
    event.imageUrl,
    event.url,
    event.priceRange,
    event.description,
    event.genre,
  ].filter(Boolean).length
}

export function dedupeEvents(events: Event[]): Event[] {
  const deduped: Event[] = []

  for (const event of events) {
    const duplicateIndex = deduped.findIndex(existing => isNearDuplicateEvent(existing, event))
    if (duplicateIndex === -1) {
      deduped.push(event)
      continue
    }

    if (eventScore(event) > eventScore(deduped[duplicateIndex])) {
      deduped[duplicateIndex] = event
    }
  }

  return deduped
}

export async function getCachedEvents(limit: number = 50): Promise<Event[]> {
  try {
    const db = await getDb()
    const rows = await db.getAllAsync(
      `SELECT name, event_date, time, venue, type, price_range, url, image_url, description
       FROM weekend_event_cache
       ORDER BY updated_at DESC
       LIMIT ?`,
      limit
    ) as Array<any>
    return rows.map((r) => ({
      name: r.name,
      date: r.event_date || '',
      time: r.time || '',
      venue: r.venue || 'TBD',
      url: r.url || '',
      category: r.type || 'Event',
      genre: null,
      priceRange: r.price_range || null,
      imageUrl: r.image_url || null,
      description: r.description || null,
    }))
  } catch {
    return []
  }
}

function parseEvents(data: any): Event[] {
  const events = data?._embedded?.events || []
  return dedupeEvents(events.map((e: any) => ({
    name: e.name,
    date: e.dates?.start?.localDate || '',
    time: e.dates?.start?.localTime || '',
    venue: e._embedded?.venues?.[0]?.name || 'TBD',
    url: e.url || '',
    category: e.classifications?.[0]?.segment?.name || 'Event',
    genre: e.classifications?.[0]?.genre?.name || null,
    priceRange: e.priceRanges?.[0]
      ? `$${e.priceRanges[0].min} - $${e.priceRanges[0].max}`
      : null,
    imageUrl: e.images?.[0]?.url || null,
    description: e.info || e.pleaseNote || null,
  })))
}
