import https from 'https'
import { createHash } from 'crypto'
import { getDb } from '../../db/database'
import { getAppSettings } from '../../lib/settings'

export interface TravelInfo {
  distance: string // e.g. "15.2 mi"
  duration: string // e.g. "25 min"
}

export interface DistanceResult {
  driving: TravelInfo | null
  transit: TravelInfo | null
  walking: TravelInfo | null
}

export interface AgendaMapImage {
  dataUrl: string
  directionsUrl: string
  locations: ResolvedAgendaStop[]
}

export interface AgendaMapRoutes {
  saturday?: string[]
  sunday?: string[]
}

export interface AgendaMapImages {
  saturday: AgendaMapImage | null
  sunday: AgendaMapImage | null
}

export interface ResolvedAgendaStop {
  label: string
  query: string
  address: string
  placeId: string | null
  lat: number
  lng: number
  source: 'home' | 'saved' | 'google'
  confidence: number
}

interface SavedLocationRow {
  place_id: string
  name: string
  address: string | null
  lat: number | null
  lng: number | null
}

const MAX_ROUTE_STOPS = 10
const MAX_LOCATION_CHARS = 140
const MAP_CACHE_DAYS = 14
const MAP_RENDER_VERSION = 2
const CHICAGO_VIEWPORT = {
  minLat: 41.78,
  maxLat: 42.03,
  minLng: -87.78,
  maxLng: -87.55,
}

/**
 * Get travel distance/time from the user's home to a destination
 * using Google Distance Matrix API for driving, transit, and walking modes.
 */
export async function getDistanceFromHome(destination: string): Promise<DistanceResult> {
  const settings = getAppSettings()
  const apiKey = settings?.googlePlacesKey
  const origin = settings?.homeLocation

  if (!apiKey || !origin) {
    console.error('Distance service: missing Google API key or home location')
    return { driving: null, transit: null, walking: null }
  }

  const modes = ['driving', 'transit', 'walking'] as const

  const results = await Promise.all(
    modes.map((mode) => fetchDistanceMatrix(origin, destination, mode, apiKey)),
  )

  const [driving, transit, walking] = results

  // If walking distance > 5 miles, return null for walking
  const walkingResult = walking && parseDistanceMiles(walking.distance) > 5 ? null : walking

  return {
    driving,
    transit,
    walking: walkingResult,
  }
}

/**
 * Geocode a free-text anchor (an address like "851 W Irving Park" or a venue like
 * "Thai Fest") to coordinates using Google Places text search. Returns null when no
 * Google key is configured or the query can't be resolved. Used by the weekend planner
 * to ground saved-place proximity in real distance instead of the model's guesswork.
 */
export async function geocodeAnchor(
  query: string,
): Promise<{ label: string; lat: number; lng: number } | null> {
  const settings = getAppSettings()
  const apiKey = settings?.googlePlacesKey
  if (!apiKey || !query.trim()) return null
  const city = settings?.weekendCity || 'Chicago'
  const stop = await resolveWithGooglePlaces(query.trim(), city, apiKey)
  if (!stop) return null
  return { label: stop.label, lat: stop.lat, lng: stop.lng }
}

/** Straight-line (great-circle) distance in miles between two coordinates. */
export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 3958.8 // earth radius, miles
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const lat1 = toRad(aLat)
  const lat2 = toRad(bLat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function fetchDistanceMatrix(
  origin: string,
  destination: string,
  mode: string,
  apiKey: string,
): Promise<TravelInfo | null> {
  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    mode,
    units: 'imperial',
    key: apiKey,
  })

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params}`

  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const element = json.rows?.[0]?.elements?.[0]
          if (element?.status === 'OK') {
            resolve({
              distance: element.distance.text,
              duration: element.duration.text,
            })
          } else {
            console.error(`Distance Matrix (${mode}): element status ${element?.status}`)
            resolve(null)
          }
        } catch {
          console.error(`Distance Matrix (${mode}): parse error`)
          resolve(null)
        }
      })
    })
    req.on('error', (err) => {
      console.error(`Distance Matrix (${mode}) fetch error:`, err.message)
      resolve(null)
    })
    req.setTimeout(10_000, () => {
      console.error(`Distance Matrix (${mode}): request timed out`)
      req.destroy()
      resolve(null)
    })
  })
}

/**
 * Resolve a list of location names to coordinates.
 * Used by the renderer to plot route maps on Leaflet.
 */
export async function resolveRouteLocations(route: string[]): Promise<ResolvedAgendaStop[]> {
  const settings = getAppSettings()
  const apiKey = settings?.googlePlacesKey
  const homeLocation = settings?.homeLocation || ''
  const city = settings?.weekendCity || 'Chicago'
  if (!apiKey) return []
  const savedLocations = getSavedLocations()
  return resolveAgendaLocations(sanitizeRoute(route), homeLocation, city, apiKey, savedLocations)
}

/**
 * Render static geographic maps for generated weekend agenda routes.
 * Runs in the main process so the Google key is never exposed to renderer code.
 */
export async function getWeekendAgendaMapImages(routes: AgendaMapRoutes): Promise<AgendaMapImages> {
  const settings = getAppSettings()
  const apiKey = settings?.googlePlacesKey
  const homeLocation = settings?.homeLocation || ''

  if (!apiKey) {
    return { saturday: null, sunday: null }
  }

  const city = settings?.weekendCity || 'Chicago'
  const normalizedRoutes = {
    saturday: sanitizeRoute(Array.isArray(routes.saturday) ? routes.saturday : []),
    sunday: sanitizeRoute(Array.isArray(routes.sunday) ? routes.sunday : []),
  }
  const routeHash = hashRoutePayload({
    renderVersion: MAP_RENDER_VERSION,
    routes: normalizedRoutes,
    homeLocation,
    city,
  })
  const cached = getCachedMapImages(routeHash)
  if (cached) return cached

  const savedLocations = getSavedLocations()
  const [saturday, sunday] = await Promise.all([
    fetchStaticAgendaMap(normalizedRoutes.saturday, homeLocation, city, apiKey, savedLocations),
    fetchStaticAgendaMap(normalizedRoutes.sunday, homeLocation, city, apiKey, savedLocations),
  ])

  const result = { saturday, sunday }
  cacheMapImages(routeHash, result)

  return result
}

async function fetchStaticAgendaMap(
  route: string[],
  homeLocation: string,
  city: string,
  apiKey: string,
  savedLocations: SavedLocationRow[],
): Promise<AgendaMapImage | null> {
  const locations = await resolveAgendaLocations(route, homeLocation, city, apiKey, savedLocations)
  console.log('[agenda-map] Resolved', locations.length, 'of', route.length, 'route stops')
  if (locations.length === 0) return null

  const params = new URLSearchParams({
    size: '640x420',
    scale: '2',
    maptype: 'roadmap',
    key: apiKey,
  })
  if (city.toLowerCase().includes('chicago')) {
    params.append('visible', 'Chicago,IL')
  }

  locations.slice(0, 10).forEach((location, index) => {
    const label = String.fromCharCode(65 + index)
    params.append('markers', `size:mid|label:${label}|${location.lat},${location.lng}`)
  })

  if (locations.length > 1) {
    params.append(
      'path',
      `color:0x38bdf8ff|weight:4|${locations.map((loc) => `${loc.lat},${loc.lng}`).join('|')}`,
    )
  }

  const url = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`
  console.log('[agenda-map] Fetching static map for', locations.length, 'locations')
  const data = await fetchBinary(url)
  if (!data) {
    console.error(
      '[agenda-map] Static map fetch returned no data. You may need to enable the Maps Static API in Google Cloud Console.',
    )
    return buildFallbackAgendaMapImage(locations)
  }

  return {
    dataUrl: `data:image/png;base64,${data.toString('base64')}`,
    directionsUrl: buildDirectionsUrl(locations),
    locations,
  }
}

function normalizeAgendaLocations(route: string[], homeLocation: string): string[] {
  const seen = new Set<string>()
  const locations: string[] = []

  for (const raw of route) {
    const value = (raw || '').trim()
    if (!value) continue
    const resolved = value.toLowerCase() === 'home' ? homeLocation : value
    if (!resolved) continue

    const key = resolved.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    locations.push(resolved)
  }

  return locations
}

function sanitizeRoute(route: string[]): string[] {
  const seen = new Set<string>()
  const locations: string[] = []
  for (const raw of route) {
    const value =
      typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LOCATION_CHARS) : ''
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    locations.push(value)
  }

  return locations.slice(0, MAX_ROUTE_STOPS)
}

async function resolveAgendaLocations(
  route: string[],
  homeLocation: string,
  city: string,
  apiKey: string,
  savedLocations: SavedLocationRow[],
): Promise<ResolvedAgendaStop[]> {
  const resolved: ResolvedAgendaStop[] = []
  const seen = new Set<string>()

  for (const raw of route) {
    const isHome = raw.toLowerCase() === 'home'
    const query = isHome ? homeLocation : raw
    if (!query) continue

    const saved = isHome ? null : matchSavedLocation(query, savedLocations)
    const google = await resolveWithGooglePlaces(query, city, apiKey)
    const stop = isHome ? google : chooseBestResolvedStop(query, google, saved)
    if (!stop) continue

    const key = `${stop.lat.toFixed(5)},${stop.lng.toFixed(5)}`
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push(stop)
  }

  return resolved
}

function chooseBestResolvedStop(
  query: string,
  google: ResolvedAgendaStop | null,
  saved: ResolvedAgendaStop | null,
): ResolvedAgendaStop | null {
  if (!google) return saved
  if (!saved) return google

  const queryText = normalizeText(query)
  const googleText = normalizeText(`${google.label} ${google.address}`)
  const savedText = normalizeText(`${saved.label} ${saved.address}`)
  const queryHasAddress = hasStreetAddress(query)

  if (queryHasAddress && googleText.includes(extractStreetAddress(queryText))) return google
  if (google.placeId && saved.placeId && google.placeId === saved.placeId) return google
  if (saved.confidence >= 0.95 && savedText && queryText.includes(savedText)) return saved

  // Generated plan stops often include prose such as "Dinner at ...".
  // Prefer a fresh Google result over stale saved coordinates when both are plausible.
  return google
}

function getSavedLocations(): SavedLocationRow[] {
  try {
    return getDb()
      .prepare(
        `
      SELECT place_id, name, address, lat, lng
      FROM saved_restaurants
      WHERE lat IS NOT NULL AND lng IS NOT NULL AND ABS(lat) > 0.0001 AND ABS(lng) > 0.0001
    `,
      )
      .all() as SavedLocationRow[]
  } catch {
    return []
  }
}

function matchSavedLocation(query: string, rows: SavedLocationRow[]): ResolvedAgendaStop | null {
  const normalized = normalizeText(query)
  if (!normalized) return null

  let best: { row: SavedLocationRow; score: number } | null = null
  for (const row of rows) {
    const name = normalizeText(row.name)
    const address = normalizeText(row.address || '')
    let score = 0

    if (name && normalized === name) score = 1
    else if (name && (normalized.includes(name) || name.includes(normalized))) score = 0.88
    else if (address && normalized.includes(address)) score = 0.82
    else if (
      name &&
      address &&
      normalized.includes(name.split(' ')[0]) &&
      normalized.includes(address.split(' ')[0])
    )
      score = 0.7

    if (score > (best?.score || 0)) best = { row, score }
  }

  if (!best || best.score < 0.7 || best.row.lat == null || best.row.lng == null) return null
  return {
    label: best.row.name,
    query,
    address: best.row.address || best.row.name,
    placeId: best.row.place_id,
    lat: best.row.lat,
    lng: best.row.lng,
    source: 'saved',
    confidence: best.score,
  }
}

async function resolveWithGooglePlaces(
  query: string,
  city: string,
  apiKey: string,
): Promise<ResolvedAgendaStop | null> {
  const textQuery =
    query.toLowerCase() === 'home'
      ? query
      : /\b[A-Z]{2}\b|,\s*[A-Za-z ]+$/.test(query)
        ? query
        : `${query} ${city}`

  try {
    const data = await httpsPostJson(
      'https://places.googleapis.com/v1/places:searchText',
      JSON.stringify({ textQuery, maxResultCount: 1 }),
      {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
      },
    )
    const place = data.places?.[0]
    const lat = place?.location?.latitude
    const lng = place?.location?.longitude
    if (typeof lat !== 'number' || typeof lng !== 'number') return null

    return {
      label: place.displayName?.text || query,
      query,
      address: place.formattedAddress || query,
      placeId: place.id || null,
      lat,
      lng,
      source: 'google',
      confidence: 0.72,
    }
  } catch {
    return null
  }
}

function httpsPostJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 10_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error('Invalid JSON'))
          }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`Google Places request timed out after ${timeoutMs}ms`)),
    )
    req.write(body)
    req.end()
  })
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function hasStreetAddress(value: string): boolean {
  return /\b\d{2,6}\s+[a-z0-9.'-]+(?:\s+[a-z0-9.'-]+){0,5}\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|pl|place|pkwy|parkway|way)\b/i.test(
    value,
  )
}

function extractStreetAddress(normalizedValue: string): string {
  const match = normalizedValue.match(
    /\b\d{2,6}\s+[a-z0-9]+(?:\s+[a-z0-9]+){0,5}\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|pl|place|pkwy|parkway|way)\b/i,
  )
  return match?.[0] || ''
}

function hashRoutePayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function getCachedMapImages(routeHash: string): AgendaMapImages | null {
  try {
    const row = getDb()
      .prepare(
        `
      SELECT data_json FROM weekend_map_cache
      WHERE route_hash = ?
        AND created_at >= datetime('now', '-' || ? || ' days')
    `,
      )
      .get(routeHash, MAP_CACHE_DAYS) as { data_json: string } | undefined
    if (!row) return null
    return JSON.parse(row.data_json) as AgendaMapImages
  } catch {
    return null
  }
}

function cacheMapImages(routeHash: string, images: AgendaMapImages): void {
  try {
    getDb()
      .prepare(
        `
      INSERT OR REPLACE INTO weekend_map_cache (route_hash, data_json, created_at)
      VALUES (?, ?, datetime('now'))
    `,
      )
      .run(routeHash, JSON.stringify(images))
  } catch {}
}

function buildDirectionsUrl(locations: ResolvedAgendaStop[]): string {
  const formatStop = (stop: ResolvedAgendaStop) => `${stop.lat},${stop.lng}`
  const origin = locations[0] ? formatStop(locations[0]) : ''
  const destination = locations[locations.length - 1]
    ? formatStop(locations[locations.length - 1])
    : origin
  const waypoints = locations.slice(1, -1).map(formatStop)
  const params = new URLSearchParams({
    api: '1',
    origin,
    destination,
  })
  if (waypoints.length > 0) params.set('waypoints', waypoints.join('|'))
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

function buildFallbackAgendaMapImage(locations: ResolvedAgendaStop[]): AgendaMapImage {
  const width = 640
  const height = 420
  const padding = 46
  const lats = locations.map((loc) => loc.lat)
  const lngs = locations.map((loc) => loc.lng)
  const routeBounds = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  }
  const chicagoStopCount = locations.filter((loc) => isInChicagoViewport(loc.lat, loc.lng)).length
  const useChicagoViewport = chicagoStopCount >= Math.max(1, Math.ceil(locations.length * 0.6))
  const bounds = useChicagoViewport ? expandBoundsToFit(CHICAGO_VIEWPORT, routeBounds) : routeBounds
  const latSpan = Math.max(bounds.maxLat - bounds.minLat, 0.01)
  const lngSpan = Math.max(bounds.maxLng - bounds.minLng, 0.01)
  const plotWidth = width - padding * 2
  const plotHeight = height - padding * 2
  const points = locations.map((loc, index) => {
    const x = padding + ((loc.lng - bounds.minLng) / lngSpan) * plotWidth
    const y = height - padding - ((loc.lat - bounds.minLat) / latSpan) * plotHeight
    return { ...loc, index, x, y, markerLabel: String.fromCharCode(65 + index) }
  })
  const path = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
  const project = (lat: number, lng: number) => ({
    x: padding + ((lng - bounds.minLng) / lngSpan) * plotWidth,
    y: height - padding - ((lat - bounds.minLat) / latSpan) * plotHeight,
  })
  const streetSvg = useChicagoViewport
    ? buildChicagoBaseMapSvg(project)
    : buildGenericMapSvg(width, height)
  const markerSvg = points
    .map(
      (point) => `
    <g>
      <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="13" fill="#38bdf8" stroke="#07111f" stroke-width="3" />
      <text x="${point.x.toFixed(1)}" y="${(point.y + 4).toFixed(1)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#07111f">${escapeXml(point.markerLabel)}</text>
    </g>
  `,
    )
    .join('')
  const labelSvg = points
    .map((point) => {
      const x = point.x > width - 210 ? point.x - 198 : point.x + 18
      const y = Math.min(height - 26, Math.max(28, point.y - 12))
      return `
      <g>
        <rect x="${x.toFixed(1)}" y="${(y - 14).toFixed(1)}" width="178" height="20" rx="10" fill="rgba(7,17,31,0.78)" stroke="rgba(148,163,184,0.24)" />
        <text x="${(x + 9).toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="#d8e2f0">${escapeXml(point.markerLabel)}. ${escapeXml(shortMapLabel(point))}</text>
      </g>
    `
    })
    .join('')
  const routeShadowSvg =
    points.length > 1
      ? `<polyline points="${path}" fill="none" stroke="#07111f" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity="0.28" />`
      : ''
  const routeSvg =
    points.length > 1
      ? `<polyline points="${path}" fill="none" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9" />`
      : ''
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="640" height="420" fill="#0f172a" />
      ${streetSvg}
      <rect x="18" y="18" width="604" height="378" rx="18" fill="none" stroke="#334155" stroke-width="2" opacity="0.7" />
      ${routeShadowSvg}
      ${routeSvg}
      ${markerSvg}
      ${labelSvg}
      <text x="28" y="398" font-family="Arial, sans-serif" font-size="11" fill="#94a3b8">${useChicagoViewport ? 'Chicago route preview' : 'Route preview'} - Open Directions for the live Google route.</text>
    </svg>
  `

  return {
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    directionsUrl: buildDirectionsUrl(locations),
    locations,
  }
}

function isInChicagoViewport(lat: number, lng: number): boolean {
  return (
    lat >= CHICAGO_VIEWPORT.minLat &&
    lat <= CHICAGO_VIEWPORT.maxLat &&
    lng >= CHICAGO_VIEWPORT.minLng &&
    lng <= CHICAGO_VIEWPORT.maxLng
  )
}

function expandBoundsToFit(
  base: typeof CHICAGO_VIEWPORT,
  route: typeof CHICAGO_VIEWPORT,
): typeof CHICAGO_VIEWPORT {
  return {
    minLat: Math.min(base.minLat, route.minLat) - 0.01,
    maxLat: Math.max(base.maxLat, route.maxLat) + 0.01,
    minLng: Math.min(base.minLng, route.minLng) - 0.01,
    maxLng: Math.max(base.maxLng, route.maxLng) + 0.01,
  }
}

function buildChicagoBaseMapSvg(
  project: (lat: number, lng: number) => { x: number; y: number },
): string {
  const lakeX = project(41.9, -87.58).x
  const expressways = [
    [
      [42.02, -87.72],
      [41.94, -87.66],
      [41.86, -87.63],
      [41.79, -87.61],
    ],
    [
      [41.99, -87.77],
      [41.92, -87.72],
      [41.86, -87.67],
      [41.8, -87.64],
    ],
    [
      [41.78, -87.75],
      [41.84, -87.68],
      [41.88, -87.63],
      [41.9, -87.56],
    ],
  ]
  const eastWest = [
    { name: 'Foster', lat: 41.976 },
    { name: 'Fullerton', lat: 41.925 },
    { name: 'Chicago', lat: 41.896 },
    { name: 'Roosevelt', lat: 41.867 },
    { name: '55th', lat: 41.795 },
  ]
  const northSouth = [
    { name: 'Western', lng: -87.686 },
    { name: 'Ashland', lng: -87.667 },
    { name: 'Halsted', lng: -87.647 },
    { name: 'Lake Shore Dr', lng: -87.615 },
  ]
  const line = (coords: number[][], color: string, width: number, opacity: number) => {
    const d = coords
      .map(([lat, lng], index) => {
        const point = project(lat, lng)
        return `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
      })
      .join(' ')
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" />`
  }
  const streetLines = [
    ...eastWest.map((street) => {
      const y = project(street.lat, -87.66).y
      return `<path d="M 34 ${y.toFixed(1)} H ${Math.max(80, lakeX - 8).toFixed(1)}" stroke="#273549" stroke-width="1.3" opacity="0.78" />
        <text x="42" y="${(y - 4).toFixed(1)}" font-family="Arial, sans-serif" font-size="9" fill="#64748b">${street.name}</text>`
    }),
    ...northSouth.map((street) => {
      const x = project(41.9, street.lng).x
      return `<path d="M ${x.toFixed(1)} 34 V 386" stroke="#273549" stroke-width="1.3" opacity="0.78" />
        <text x="${(x + 4).toFixed(1)}" y="52" font-family="Arial, sans-serif" font-size="9" fill="#64748b" transform="rotate(90 ${(x + 4).toFixed(1)} 52)">${street.name}</text>`
    }),
  ].join('')
  const neighborhoodLabels = [
    { label: 'Lincoln Park', lat: 41.925, lng: -87.65 },
    { label: 'Logan Sq', lat: 41.923, lng: -87.708 },
    { label: 'West Loop', lat: 41.883, lng: -87.648 },
    { label: 'Loop', lat: 41.881, lng: -87.626 },
    { label: 'Hyde Park', lat: 41.795, lng: -87.594 },
  ]
    .map(({ label, lat, lng }) => {
      const point = project(lat, lng)
      return `<text x="${point.x.toFixed(1)}" y="${point.y.toFixed(1)}" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="#94a3b8" opacity="0.72">${label}</text>`
    })
    .join('')

  return `
    <rect x="${Math.max(0, lakeX).toFixed(1)}" y="0" width="${Math.max(0, 640 - lakeX).toFixed(1)}" height="420" fill="#0b3651" opacity="0.92" />
    <path d="M ${lakeX.toFixed(1)} 0 C ${(lakeX + 24).toFixed(1)} 78 ${(lakeX - 12).toFixed(1)} 150 ${(lakeX + 16).toFixed(1)} 214 C ${(lakeX + 36).toFixed(1)} 274 ${(lakeX - 4).toFixed(1)} 340 ${(lakeX + 18).toFixed(1)} 420" fill="none" stroke="#60a5fa" stroke-width="3" opacity="0.8" />
    <text x="${Math.min(590, lakeX + 32).toFixed(1)}" y="66" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#93c5fd" opacity="0.84">Lake Michigan</text>
    <path d="M0 90 H640 M0 180 H640 M0 270 H640 M0 360 H640 M120 0 V420 M240 0 V420 M360 0 V420 M480 0 V420 M600 0 V420" stroke="#1f2a3a" stroke-width="1" opacity="0.35" />
    ${streetLines}
    ${expressways.map((coords) => line(coords, '#f59e0b', 3, 0.42)).join('')}
    ${neighborhoodLabels}
  `
}

function buildGenericMapSvg(width: number, height: number): string {
  return `
    <path d="M0 90 H${width} M0 180 H${width} M0 270 H${width} M0 360 H${width} M120 0 V${height} M240 0 V${height} M360 0 V${height} M480 0 V${height} M600 0 V${height}" stroke="#263244" stroke-width="1" opacity="0.65" />
  `
}

function shortMapLabel(stop: ResolvedAgendaStop): string {
  const source = stop.label || stop.address || stop.query
  return source
    .replace(/,\s*Chicago,?\s*IL.*$/i, '')
    .replace(/,\s*Chicago.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 26)
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function fetchBinary(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => {
            console.error(
              `[agenda-map] HTTP ${res.statusCode} from ${url.split('?')[0]}:`,
              body.slice(0, 300),
            )
          })
          resolve(null)
          return
        }
        const contentType = String(res.headers['content-type'] || '')
        if (contentType && !contentType.startsWith('image/')) {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => {
            console.error(
              `[agenda-map] Non-image response from ${url.split('?')[0]}:`,
              body.slice(0, 300),
            )
            resolve(null)
          })
          return
        }

        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      .on('error', () => resolve(null))
    req.setTimeout(15_000, () => {
      console.error(`[agenda-map] request timed out: ${url.split('?')[0]}`)
      req.destroy()
      resolve(null)
    })
  })
}

/**
 * Parse a distance string like "15.2 mi" or "0.8 mi" into a numeric miles value.
 * Returns 0 if parsing fails.
 */
function parseDistanceMiles(distanceText: string): number {
  const match = distanceText.match(/([\d.]+)\s*mi/)
  if (match) return parseFloat(match[1])
  // Handle feet (e.g. "500 ft") — always under a mile
  const ftMatch = distanceText.match(/([\d.]+)\s*ft/)
  if (ftMatch) return parseFloat(ftMatch[1]) / 5280
  return 0
}
