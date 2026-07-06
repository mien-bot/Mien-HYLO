import https from 'https'
import { getAppSettings } from '../../lib/settings'

export interface LocalEvent {
  id: string
  name: string
  type: string // 'concert' | 'sports' | 'arts' | 'festival' | 'food' | 'outdoor' | 'other'
  date: string // ISO date
  time: string // HH:MM or 'TBD'
  venue: string
  address: string
  city: string
  priceRange: string // e.g. '$25-75' or 'Free'
  url: string
  imageUrl: string | null
  description: string
  distance: string | null // estimated from home, filled in later
  lat?: number | null
  lng?: number | null
}

/**
 * Fetch events from Ticketmaster Discovery API (free tier: 5000 req/day)
 * https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
 */
export async function fetchTicketmasterEvents(
  options: {
    city?: string
    latlong?: string
    radius?: number
    startDate?: string
    endDate?: string
    size?: number
  } = {},
): Promise<LocalEvent[]> {
  const settings = getAppSettings()
  const apiKey = settings?.ticketmasterApiKey
  if (!apiKey) return []

  const city = options.city || settings?.weekendCity || 'Chicago'
  const radius = options.radius || parseInt(settings?.weekendRadius ?? '', 10) || 30
  const size = options.size || 30

  // Default to upcoming weekend
  const { start, end } =
    options.startDate && options.endDate
      ? { start: options.startDate, end: options.endDate }
      : getNextWeekendRange()

  const params = new URLSearchParams({
    apikey: apiKey,
    city,
    radius: radius.toString(),
    unit: 'miles',
    startDateTime: `${start}T00:00:00Z`,
    endDateTime: `${end}T23:59:59Z`,
    size: size.toString(),
    sort: 'date,asc',
  })

  if (options.latlong) {
    params.set('latlong', options.latlong)
    params.delete('city')
  }

  const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params}`

  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const events = json._embedded?.events || []
          resolve(
            dedupeLocalEvents(
              events
                .map(parseTicketmasterEvent)
                .map((e: LocalEvent) => validateEventCoords(e, city, radius)),
            ),
          )
        } catch {
          console.error('Ticketmaster parse error')
          resolve([])
        }
      })
    })
    req.on('error', (err) => {
      console.error('Ticketmaster fetch error:', err.message)
      resolve([])
    })
    req.setTimeout(10_000, () => {
      console.error('Ticketmaster fetch error: request timed out')
      req.destroy()
      resolve([])
    })
  })
}

function parseTicketmasterEvent(event: any): LocalEvent {
  const venue = event._embedded?.venues?.[0] || {}
  const dates = event.dates?.start || {}
  const prices = event.priceRanges?.[0]

  let priceRange = 'See listing'
  if (prices) {
    priceRange = prices.min === prices.max ? `$${prices.min}` : `$${prices.min}-${prices.max}`
  }

  const classSegment = event.classifications?.[0]?.segment?.name?.toLowerCase() || ''
  let type = 'other'
  if (classSegment.includes('music')) type = 'concert'
  else if (classSegment.includes('sport')) type = 'sports'
  else if (classSegment.includes('art') || classSegment.includes('theatre')) type = 'arts'
  else if (classSegment.includes('food') || classSegment.includes('drink')) type = 'food'
  else if (classSegment.includes('festival')) type = 'festival'

  return {
    id: event.id || '',
    name: event.name || 'Unnamed Event',
    type,
    date: dates.localDate || '',
    time: dates.localTime?.substring(0, 5) || 'TBD',
    venue: venue.name || 'TBA',
    address: [venue.address?.line1, venue.city?.name, venue.state?.stateCode]
      .filter(Boolean)
      .join(', '),
    city: venue.city?.name || '',
    priceRange,
    url: event.url || '',
    imageUrl: event.images?.[0]?.url || null,
    description: event.info || event.pleaseNote || '',
    distance: null,
    lat: venue.location?.latitude ? Number(venue.location.latitude) : null,
    lng: venue.location?.longitude ? Number(venue.location.longitude) : null,
  }
}

/** Known city centers for coordinate sanity checks */
const CITY_CENTERS: Record<string, { lat: number; lng: number }> = {
  chicago: { lat: 41.88, lng: -87.63 },
  'new york': { lat: 40.71, lng: -74.01 },
  'los angeles': { lat: 34.05, lng: -118.24 },
  'san francisco': { lat: 37.77, lng: -122.42 },
}

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959 // earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Validate that coordinates are within reasonable distance of the event's city */
function validateEventCoords(
  event: LocalEvent,
  searchCity: string,
  searchRadius: number,
): LocalEvent {
  if (event.lat == null || event.lng == null) return event
  const city = (event.city || searchCity || '').toLowerCase().trim()
  const center = CITY_CENTERS[city]
  if (!center) return event
  const dist = haversineMiles(event.lat, event.lng, center.lat, center.lng)
  // Allow 2x the search radius as tolerance (some venues are on the outskirts)
  if (dist > Math.max(searchRadius * 2, 100)) {
    return { ...event, lat: null, lng: null }
  }
  return event
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

/** Strip ticket type suffixes, city names, and common noise from event names for fuzzy dedup */
function stripEventNameNoise(name: string): string {
  return normalizeEventText(name)
    .replace(
      /\b(flex ticket|general admission|ga|vip|reserved|standing|seated|balcony|early entry|late show|early show)\b/gi,
      '',
    )
    .replace(/\b(chicago|new york|los angeles|san francisco|nyc|la|sf)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function eventBaseKey(event: LocalEvent): string {
  return [normalizeEventText(event.name), normalizeEventText(event.venue), event.date].join('|')
}

function isNearDuplicateEvent(a: LocalEvent, b: LocalEvent): boolean {
  // Same venue + same date → check name similarity
  if (normalizeEventText(a.venue) === normalizeEventText(b.venue) && a.date === b.date) {
    // Exact name match (different time slots of same event) → always dedup
    if (normalizeEventText(a.name) === normalizeEventText(b.name)) return true

    // Fuzzy match: one name contains the other (after stripping noise)
    const aStripped = stripEventNameNoise(a.name)
    const bStripped = stripEventNameNoise(b.name)
    if (
      aStripped &&
      bStripped &&
      (aStripped.includes(bStripped) || bStripped.includes(aStripped))
    ) {
      return true
    }
  }

  return false
}

function eventScore(event: LocalEvent): number {
  return [
    event.imageUrl,
    event.url,
    event.priceRange && event.priceRange !== 'See listing',
    event.description,
    event.address,
  ].filter(Boolean).length
}

export function dedupeLocalEvents(events: LocalEvent[]): LocalEvent[] {
  const deduped: LocalEvent[] = []

  for (const event of events) {
    const duplicateIndex = deduped.findIndex((existing) => isNearDuplicateEvent(existing, event))
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

/**
 * Fetch free Chicago-area activities from curated sources.
 * These are always-available spots that don't need an API key — sample seed
 * data for one city so the Weekend planner has something to show out of the
 * box. Fully superseded by your own `weekendCity` setting + a Google Places
 * key once configured; swap this list for your own city's landmarks if you
 * want the API-key-free fallback to match where you live.
 */
export function getCuratedChicagoSpots(): LocalEvent[] {
  const spots: Omit<LocalEvent, 'id' | 'date'>[] = [
    {
      name: 'Millennium Park & Cloud Gate',
      type: 'outdoor',
      time: '06:00',
      venue: 'Millennium Park',
      address: '201 E Randolph St, Chicago, IL',
      city: 'Chicago',
      priceRange: 'Free',
      url: 'https://www.chicago.gov/city/en/depts/dca/supp_info/millennium_park.html',
      imageUrl: null,
      description:
        'Iconic park with Cloud Gate (The Bean), Lurie Garden, Crown Fountain. Open daily 6am-11pm.',
      distance: null,
    },
    {
      name: 'Art Institute of Chicago',
      type: 'arts',
      time: '11:00',
      venue: 'Art Institute of Chicago',
      address: '111 S Michigan Ave, Chicago, IL',
      city: 'Chicago',
      priceRange: '$25-35',
      url: 'https://www.artic.edu',
      imageUrl: null,
      description:
        'World-class art museum with impressionist, modern, and contemporary collections. Free for IL residents on select days.',
      distance: null,
    },
    {
      name: 'Chicago Riverwalk',
      type: 'outdoor',
      time: '10:00',
      venue: 'Chicago Riverwalk',
      address: 'E Riverwalk S, Chicago, IL',
      city: 'Chicago',
      priceRange: 'Free',
      url: '',
      imageUrl: null,
      description:
        'Waterfront path with restaurants, kayak rentals, architecture boat tours, and city views.',
      distance: null,
    },
    {
      name: 'Navy Pier',
      type: 'outdoor',
      time: '10:00',
      venue: 'Navy Pier',
      address: '600 E Grand Ave, Chicago, IL',
      city: 'Chicago',
      priceRange: 'Free entry',
      url: 'https://navypier.org',
      imageUrl: null,
      description: 'Ferris wheel, restaurants, shops, and lake views. Free entry, rides extra.',
      distance: null,
    },
    {
      name: 'Museum of Science and Industry',
      type: 'arts',
      time: '09:30',
      venue: 'Museum of Science and Industry',
      address: '5700 S DuSable Lakeshore Dr, Chicago, IL',
      city: 'Chicago',
      priceRange: '$22-25',
      url: 'https://www.msichicago.org',
      imageUrl: null,
      description:
        'Largest science museum in the Western Hemisphere. U-505 submarine, coal mine, smart home exhibits.',
      distance: null,
    },
    {
      name: 'Lincoln Park Zoo',
      type: 'outdoor',
      time: '10:00',
      venue: 'Lincoln Park Zoo',
      address: '2001 N Clark St, Chicago, IL',
      city: 'Chicago',
      priceRange: 'Free',
      url: 'https://www.lpzoo.org',
      imageUrl: null,
      description: 'Free zoo with 200+ species. Great for families. Open daily.',
      distance: null,
    },
    {
      name: 'Fulton Market / West Loop Food Tour',
      type: 'food',
      time: '11:00',
      venue: 'Fulton Market District',
      address: 'W Fulton Market, Chicago, IL',
      city: 'Chicago',
      priceRange: 'Varies',
      url: '',
      imageUrl: null,
      description:
        "Chicago's hottest restaurant district. Girl & The Goat, Au Cheval, Time Out Market. Walk and eat.",
      distance: null,
    },
    {
      name: 'Field Museum',
      type: 'arts',
      time: '09:00',
      venue: 'Field Museum',
      address: '1400 S DuSable Lakeshore Dr, Chicago, IL',
      city: 'Chicago',
      priceRange: '$26-30',
      url: 'https://www.fieldmuseum.org',
      imageUrl: null,
      description: 'Natural history museum. SUE the T. rex, Egyptian mummies, Evolving Planet.',
      distance: null,
    },
    {
      name: 'Chicago Architecture Center Boat Tour',
      type: 'arts',
      time: '10:00',
      venue: 'CAC',
      address: '111 E Wacker Dr, Chicago, IL',
      city: 'Chicago',
      priceRange: '$47-52',
      url: 'https://www.architecture.org',
      imageUrl: null,
      description:
        'World-famous 90-min architecture river cruise. Best way to see Chicago skyline.',
      distance: null,
    },
    {
      name: 'Lakefront Trail Walk/Run/Bike',
      type: 'outdoor',
      time: '08:00',
      venue: 'Lakefront Trail',
      address: 'Chicago Lakefront',
      city: 'Chicago',
      priceRange: 'Free',
      url: '',
      imageUrl: null,
      description:
        '18-mile paved path along Lake Michigan. Great for running, biking, or walking with skyline views.',
      distance: null,
    },
    {
      name: 'Chinatown',
      type: 'food',
      time: '11:00',
      venue: 'Chinatown',
      address: 'W Cermak Rd & S Wentworth Ave, Chicago, IL',
      city: 'Chicago',
      priceRange: 'Varies',
      url: '',
      imageUrl: null,
      description:
        'Authentic dim sum, bakeries, bubble tea, and the Nine Dragon Wall. Lao Sze Chuan, MingHin.',
      distance: null,
    },
    {
      name: 'Wicker Park / Bucktown',
      type: 'other',
      time: '12:00',
      venue: 'Wicker Park',
      address: 'N Milwaukee Ave & W North Ave, Chicago, IL',
      city: 'Chicago',
      priceRange: 'Free to browse',
      url: '',
      imageUrl: null,
      description:
        'Trendy neighborhood for vintage shopping, coffee shops, street art, and nightlife.',
      distance: null,
    },
  ]

  const weekend = getNextWeekendRange()
  return spots.map((spot, i) => ({
    ...spot,
    id: `curated-${i}`,
    date: i % 2 === 0 ? weekend.start : weekend.end,
  }))
}

// --- Helpers ---

function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getNextWeekendRange(): { start: string; end: string } {
  const now = new Date()
  const day = now.getDay()
  // Days until Saturday: if today is Sun(0)->6, Mon(1)->5, ..., Sat(6)->0
  const daysUntilSat = day === 6 ? 0 : 6 - day
  const saturday = new Date(now)
  saturday.setDate(now.getDate() + daysUntilSat)
  const sunday = new Date(saturday)
  sunday.setDate(saturday.getDate() + 1)

  return {
    start: localDateStr(saturday),
    end: localDateStr(sunday),
  }
}

const CATEGORY_PARAMS: Record<string, { classificationName?: string; keyword?: string }> = {
  music: { classificationName: 'Music' },
  sports: { classificationName: 'Sports' },
  baseball: { classificationName: 'Baseball' },
  shows: { classificationName: 'Theatre' },
  comedy: { classificationName: 'Comedy' },
  arts: { classificationName: 'Arts & Theatre' },
  family: { classificationName: 'Family' },
  festivals: { keyword: 'festival' },
}

export interface EventSearchResult {
  events: LocalEvent[]
  page: number
  totalPages: number
  totalElements: number
}

/**
 * Search Ticketmaster events by keyword, date, and/or category with pagination.
 */
export async function searchTicketmasterEvents(
  options: {
    keyword?: string
    date?: string
    category?: string
    page?: number
    size?: number
  } = {},
): Promise<EventSearchResult> {
  const settings = getAppSettings()
  const apiKey = settings?.ticketmasterApiKey
  if (!apiKey) return { events: [], page: 0, totalPages: 0, totalElements: 0 }

  const city = settings?.weekendCity || 'Chicago'
  const radius = parseInt(settings?.weekendRadius ?? '', 10) || 30

  const params = new URLSearchParams({
    apikey: apiKey,
    city,
    radius: radius.toString(),
    unit: 'miles',
    size: String(options.size || 20),
    page: String(options.page || 0),
    sort: 'date,asc',
  })

  // Keyword + category keyword
  const keywordParts = [
    options.keyword?.trim(),
    options.category && options.category !== 'all'
      ? CATEGORY_PARAMS[options.category]?.keyword
      : undefined,
  ].filter(Boolean)
  if (keywordParts.length > 0) {
    params.set('keyword', keywordParts.join(' '))
  }

  // Classification filter
  const classificationName =
    options.category && options.category !== 'all'
      ? CATEGORY_PARAMS[options.category]?.classificationName
      : undefined
  if (classificationName) {
    params.set('classificationName', classificationName)
  }

  // Date filter: single day or default to today onwards
  if (options.date) {
    params.set('startDateTime', `${options.date}T00:00:00Z`)
    params.set('endDateTime', `${options.date}T23:59:59Z`)
  } else {
    params.set('startDateTime', new Date().toISOString().split('.')[0] + 'Z')
  }

  const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params}`

  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const events = json._embedded?.events || []
            const page = json?.page || {}
            resolve({
              events: dedupeLocalEvents(
                events
                .map(parseTicketmasterEvent)
                .map((e: LocalEvent) => validateEventCoords(e, city, radius)),
              ),
              page: page.number || options.page || 0,
              totalPages: page.totalPages || 0,
              totalElements: page.totalElements || 0,
            })
          } catch {
            resolve({ events: [], page: 0, totalPages: 0, totalElements: 0 })
          }
        })
      })
      .on('error', () => {
        resolve({ events: [], page: 0, totalPages: 0, totalElements: 0 })
      })
  })
}

export { getNextWeekendRange }
