import https from 'https'
import { getDb } from '../../db/database'
import { generateAnalysisStreaming } from '../ai.service'
import { parseAiJson } from '../ai-json'
import { getAppSettings } from '../../lib/settings'

export type VenueType =
  | 'restaurant'
  | 'bar'
  | 'dessert'
  | 'cafe'
  | 'attraction'
  | 'store'
  | 'museum'
  | 'sports'
  | 'music'
  | 'stadium'
  | 'park'
  | 'theater'
  | 'other'
export type SpiceLevel = 'none' | 'mild' | 'medium' | 'spicy' | 'very-spicy'

export type DayOfWeek = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
export const DAYS_OF_WEEK: DayOfWeek[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export type BusyDaysMatrix = Partial<Record<DayOfWeek, { level: number; peakHours: string | null }>>

export const CUISINE_CATEGORIES = [
  'American',
  'Italian',
  'Chinese',
  'Japanese',
  'Korean',
  'Thai',
  'Vietnamese',
  'Mexican',
  'Mediterranean',
  'Indian',
  'French',
  'Fusion',
  'Seafood',
  'Steakhouse',
  'BBQ',
  'Pizza',
  'Sushi',
  'Ramen',
  'Brunch',
  'Desserts',
  'Bakery',
  'Coffee',
  'Cocktails',
  'Wine Bar',
  'Brewery',
  'Fast Casual',
  'Fine Dining',
  'Street Food',
  'Vegan',
  'Other',
]

export interface Restaurant {
  id: string
  name: string
  address: string
  priceLevel: number | null
  rating: number | null
  totalRatings: number
  distance: string | null
  cuisine: string[]
  placeId: string
  lat: number
  lng: number
  openNow: boolean | null
  bookingAdvance: string | null
  saved: boolean
}

export interface SavedRestaurant {
  id: number
  placeId: string
  name: string
  address: string
  priceLevel: number | null
  rating: number | null
  cuisine: string
  lat: number
  lng: number
  notes: string | null
  bookingAdvance: string | null
  savedAt: string
  // New fields
  venueType: VenueType
  cuisineCategory: string | null
  spiceLevel: SpiceLevel | null
  reservationLink: string | null
  peakTimes: string | null
  description: string | null
  visited: boolean
  visitDate: string | null
  personalRating: number | null
  bookingAdvanceDays: number | null
  busyDaysMatrix: BusyDaysMatrix | null
  lastResearchedAt: string | null
  visits: RestaurantVisit[]
  averageRating: number | null
}

export interface RestaurantVisit {
  id: number
  placeId: string
  visitDate: string
  rating: number | null
  notes: string | null
  createdAt: string
}

export interface ManualRestaurantInput {
  name: string
  address?: string
  venueType: VenueType
  cuisineCategory?: string
  spiceLevel?: SpiceLevel
  priceLevel?: number
  reservationLink?: string
  peakTimes?: string
  bookingAdvance?: string
  notes?: string
  description?: string
}

const PRICE_LABELS = ['', '$', '$$', '$$$', '$$$$']

export function priceLevelLabel(level: number | null): string {
  if (!level || level < 1 || level > 4) return '?'
  return PRICE_LABELS[level]
}

function httpsGet(url: string, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
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
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Google Places request timed out after ${timeoutMs}ms`))
    })
  })
}

function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 10_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }
    const req = https.request(options, (res) => {
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
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Google Places request timed out after ${timeoutMs}ms`))
    })
    req.write(body)
    req.end()
  })
}

// Google Places API v1 (new) price level mapping
const NEW_PRICE_LEVEL_MAP: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
}

export interface AutocompleteSuggestion {
  placeId: string
  name: string
  description: string
}

export async function autocompleteRestaurants(
  input: string,
  mode: 'food' | 'places' = 'food',
): Promise<AutocompleteSuggestion[]> {
  const settings = getAppSettings()
  const apiKey = settings?.googlePlacesKey
  if (!apiKey || !input.trim()) {
    if (!apiKey) console.warn('[restaurants] Google Places API key not set for autocomplete')
    return []
  }

  const city = settings?.weekendCity || 'Chicago'

  try {
    const data = await httpsPost(
      'https://places.googleapis.com/v1/places:autocomplete',
      JSON.stringify({
        input: `${input} ${city}`,
        ...(mode === 'food'
          ? { includedPrimaryTypes: ['restaurant', 'bar', 'cafe', 'bakery', 'ice_cream_shop'] }
          : {}),
      }),
      {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
      },
    )
    if (data.error) {
      console.error(
        '[restaurants] Google Places autocomplete error:',
        data.error.message || JSON.stringify(data.error),
      )
    }
    return (data.suggestions || []).slice(0, 6).map((s: any) => {
      const pred = s.placePrediction || {}
      return {
        placeId: pred.placeId || '',
        name: pred.structuredFormat?.mainText?.text || pred.text?.text || '',
        description: pred.structuredFormat?.secondaryText?.text || '',
      }
    })
  } catch (err) {
    console.error('[restaurants] autocomplete error:', err)
    return []
  }
}

export async function searchRestaurants(query?: string): Promise<Restaurant[]> {
  const settings = getAppSettings()
  const apiKey = settings?.googlePlacesKey
  if (!apiKey) {
    console.warn('[restaurants] Google Places API key not set')
    return []
  }

  const city = settings?.weekendCity || 'Chicago'
  const textQuery = query ? `${query} in ${city}` : `best restaurants in ${city}`

  try {
    const data = await httpsPost(
      'https://places.googleapis.com/v1/places:searchText',
      JSON.stringify({
        textQuery,
        maxResultCount: 20,
      }),
      {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.priceLevel,places.rating,places.userRatingCount,places.location,places.currentOpeningHours',
      },
    )
    if (data.error) {
      console.error(
        '[restaurants] Google Places API error:',
        data.error.message || JSON.stringify(data.error),
      )
    }
    const places = data.places || []
    console.log(
      `[restaurants] searchText query="${textQuery}" returned ${places.length} results:`,
      places.map((p: any) => p.displayName?.text),
    )
    return mapNewPlacesResults(places)
  } catch (err) {
    console.error('[restaurants] searchRestaurants error:', err)
    return []
  }
}

export async function getPlaceById(placeId: string): Promise<Restaurant | null> {
  const settings = getAppSettings()
  const apiKey = settings?.googlePlacesKey
  if (!apiKey) return null

  try {
    const fields =
      'id,displayName,formattedAddress,priceLevel,rating,userRatingCount,location,currentOpeningHours'
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fields,
      },
    })
    if (!res.ok) return null
    const p = await res.json()
    const results = mapNewPlacesResults([p])
    return results[0] || null
  } catch (err) {
    console.error('[restaurants] getPlaceById error:', err)
    return null
  }
}

export async function searchNearbyPlaces(options: {
  lat: number
  lng: number
  radiusMiles?: number
  types?: string[]
}): Promise<Restaurant[]> {
  const settings = getAppSettings()
  const apiKey = settings?.googlePlacesKey
  if (!apiKey) {
    console.warn('[restaurants] Google Places API key not set for nearby search')
    return []
  }

  const radiusMeters = Math.round((options.radiusMiles || 5) * 1609.34)
  const includedTypes =
    options.types && options.types.length > 0
      ? options.types
      : [
          'restaurant',
          'cafe',
          'bar',
          'bakery',
          'ice_cream_shop',
          'coffee_shop',
          'book_store',
          'clothing_store',
          'grocery_store',
          'shopping_mall',
          'store',
          'museum',
          'art_gallery',
          'park',
          'tourist_attraction',
          'movie_theater',
          'night_club',
          'spa',
          'gym',
          'liquor_store',
          'florist',
          'home_goods_store',
          'pet_store',
          'market',
        ]

  try {
    const data = await httpsPost(
      'https://places.googleapis.com/v1/places:searchNearby',
      JSON.stringify({
        includedTypes,
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: { latitude: options.lat, longitude: options.lng },
            radius: radiusMeters,
          },
        },
      }),
      {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.priceLevel,places.rating,places.userRatingCount,places.location,places.currentOpeningHours,places.primaryType',
      },
    )
    if (data.error) {
      console.error(
        '[restaurants] Google Places nearby error:',
        data.error.message || JSON.stringify(data.error),
      )
      return []
    }
    return mapNewPlacesResults(data.places || [])
  } catch (err) {
    console.error('[restaurants] searchNearbyPlaces error:', err)
    return []
  }
}

function mapNewPlacesResults(places: any[]): Restaurant[] {
  return places.slice(0, 20).map((p: any) => {
    const lat = p.location?.latitude || 0
    const lng = p.location?.longitude || 0
    const priceLevel = p.priceLevel ? (NEW_PRICE_LEVEL_MAP[p.priceLevel] ?? null) : null

    return {
      id: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      priceLevel,
      rating: p.rating ?? null,
      totalRatings: p.userRatingCount || 0,
      distance: null,
      cuisine: [],
      placeId: p.id,
      lat,
      lng,
      openNow: p.currentOpeningHours?.openNow ?? null,
      bookingAdvance: estimateBookingAdvance(p.rating, p.userRatingCount, priceLevel),
      saved: false,
      primaryType: p.primaryType || null,
    }
  })
}

function estimateBookingAdvance(
  rating: number | null,
  totalRatings: number | null,
  priceLevel: number | null,
): string {
  const r = rating || 0
  const count = totalRatings || 0
  const price = priceLevel || 0

  if ((r >= 4.5 && count > 1000) || price >= 4) return '2-4 weeks'
  if ((r >= 4.3 && count > 500) || price >= 3) return '1-2 weeks'
  if (r >= 4.0 && count > 200) return '3-5 days'
  if (r >= 3.5) return '1-2 days'
  return 'Walk-in friendly'
}

// --- Saved restaurants (SQLite) ---

export function getSavedRestaurants(filter?: {
  venueType?: VenueType
  cuisineCategory?: string
}): SavedRestaurant[] {
  const db = getDb()
  let sql = 'SELECT * FROM saved_restaurants'
  const params: any[] = []
  const clauses: string[] = []

  if (filter?.venueType) {
    clauses.push('venue_type = ?')
    params.push(filter.venueType)
  }
  if (filter?.cuisineCategory) {
    clauses.push('cuisine_category = ?')
    params.push(filter.cuisineCategory)
  }
  if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ')
  sql += ' ORDER BY saved_at DESC'

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  const allVisits = db
    .prepare('SELECT * FROM restaurant_visits WHERE deleted_at IS NULL ORDER BY visit_date DESC')
    .all() as Array<Record<string, unknown>>
  const visitsByPlace = new Map<string, RestaurantVisit[]>()
  for (const v of allVisits) {
    const list = visitsByPlace.get(v.place_id) || []
    list.push({
      id: v.id,
      placeId: v.place_id,
      visitDate: v.visit_date,
      rating: v.rating,
      notes: v.notes,
      createdAt: v.created_at,
    })
    visitsByPlace.set(v.place_id, list)
  }
  return rows.map((r) => mapRow(r, visitsByPlace.get(r.place_id) || []))
}

function mapRow(r: any, visits?: RestaurantVisit[]): SavedRestaurant {
  let busyDaysMatrix: BusyDaysMatrix | null = null
  if (r.busy_days_matrix) {
    try {
      busyDaysMatrix = JSON.parse(r.busy_days_matrix)
    } catch {
      busyDaysMatrix = null
    }
  }
  const v = visits || []
  const ratedVisits = v.filter((vi) => vi.rating != null)
  const averageRating =
    ratedVisits.length > 0
      ? parseFloat(
          (ratedVisits.reduce((sum, vi) => sum + vi.rating!, 0) / ratedVisits.length).toFixed(1),
        )
      : r.personal_rating || null
  return {
    id: r.id,
    placeId: r.place_id,
    name: r.name,
    address: r.address,
    priceLevel: r.price_level,
    rating: r.rating,
    cuisine: r.cuisine || '',
    lat: r.lat,
    lng: r.lng,
    notes: r.notes,
    bookingAdvance: r.booking_advance,
    savedAt: r.saved_at,
    venueType: r.venue_type || 'restaurant',
    cuisineCategory: r.cuisine_category || null,
    spiceLevel: r.spice_level || null,
    reservationLink: r.reservation_link || null,
    peakTimes: r.peak_times || null,
    description: r.description || null,
    visited: r.visited === 1 || v.length > 0,
    visitDate: r.visit_date || null,
    personalRating: averageRating,
    bookingAdvanceDays: r.booking_advance_days ?? null,
    busyDaysMatrix,
    lastResearchedAt: r.last_researched_at || null,
    visits: v,
    averageRating,
  }
}

export function saveRestaurant(r: Restaurant, notes?: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO saved_restaurants (place_id, name, address, price_level, rating, cuisine, lat, lng, notes, booking_advance, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(place_id) DO UPDATE SET
       name = excluded.name,
       address = excluded.address,
       price_level = excluded.price_level,
       rating = excluded.rating,
       cuisine = excluded.cuisine,
       lat = excluded.lat,
       lng = excluded.lng,
       notes = COALESCE(excluded.notes, saved_restaurants.notes),
       booking_advance = excluded.booking_advance,
       updated_at = datetime('now')`,
  ).run(
    r.placeId,
    r.name,
    r.address,
    r.priceLevel,
    r.rating,
    r.cuisine.join(', '),
    r.lat,
    r.lng,
    notes || null,
    r.bookingAdvance,
  )
}

export function addManualRestaurant(input: ManualRestaurantInput): void {
  const db = getDb()
  const placeId = 'manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  db.prepare(
    `INSERT INTO saved_restaurants (place_id, name, address, price_level, venue_type, cuisine_category, spice_level, reservation_link, peak_times, booking_advance, notes, description, lat, lng, cuisine, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, datetime('now'))`,
  ).run(
    placeId,
    input.name,
    input.address || '',
    input.priceLevel || null,
    input.venueType,
    input.cuisineCategory || null,
    input.spiceLevel || null,
    input.reservationLink || null,
    input.peakTimes || null,
    input.bookingAdvance || null,
    input.notes || null,
    input.description || null,
    input.cuisineCategory || '',
  )
}

export function updateRestaurant(
  placeId: string,
  updates: Partial<{
    notes: string
    cuisineCategory: string
    spiceLevel: SpiceLevel
    venueType: VenueType
    reservationLink: string
    peakTimes: string
    bookingAdvance: string
    description: string
    visited: boolean
    visitDate: string
    personalRating: number
    priceLevel: number
    bookingAdvanceDays: number
    busyDaysMatrix: BusyDaysMatrix
    lastResearchedAt: string
  }>,
): void {
  const db = getDb()
  const fieldMap: Record<string, string> = {
    notes: 'notes',
    cuisineCategory: 'cuisine_category',
    spiceLevel: 'spice_level',
    venueType: 'venue_type',
    reservationLink: 'reservation_link',
    peakTimes: 'peak_times',
    bookingAdvance: 'booking_advance',
    description: 'description',
    visited: 'visited',
    visitDate: 'visit_date',
    personalRating: 'personal_rating',
    priceLevel: 'price_level',
    bookingAdvanceDays: 'booking_advance_days',
    busyDaysMatrix: 'busy_days_matrix',
    lastResearchedAt: 'last_researched_at',
  }

  for (const [key, value] of Object.entries(updates)) {
    const col = fieldMap[key]
    if (!col) continue
    let dbValue: any = value
    if (key === 'visited') dbValue = value ? 1 : 0
    else if (key === 'busyDaysMatrix') dbValue = value == null ? null : JSON.stringify(value)
    db.prepare(
      `UPDATE saved_restaurants SET ${col} = ?, updated_at = datetime('now') WHERE place_id = ?`,
    ).run(dbValue, placeId)
  }
}

export function removeSavedRestaurant(placeId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM saved_restaurants WHERE place_id = ?').run(placeId)
}

export function updateRestaurantNotes(placeId: string, notes: string): void {
  const db = getDb()
  db.prepare(
    "UPDATE saved_restaurants SET notes = ?, updated_at = datetime('now') WHERE place_id = ?",
  ).run(notes, placeId)
}

export function editRestaurantCore(
  placeId: string,
  updates: Partial<{
    name: string
    address: string
    cuisineCategory: string
    venueType: VenueType
    spiceLevel: SpiceLevel
    priceLevel: number
    reservationLink: string
    peakTimes: string
    bookingAdvance: string
    description: string
    notes: string
  }>,
): void {
  const db = getDb()
  const fieldMap: Record<string, string> = {
    name: 'name',
    address: 'address',
    cuisineCategory: 'cuisine_category',
    venueType: 'venue_type',
    spiceLevel: 'spice_level',
    priceLevel: 'price_level',
    reservationLink: 'reservation_link',
    peakTimes: 'peak_times',
    bookingAdvance: 'booking_advance',
    description: 'description',
    notes: 'notes',
  }
  for (const [key, value] of Object.entries(updates)) {
    const col = fieldMap[key]
    if (!col) continue
    db.prepare(
      `UPDATE saved_restaurants SET ${col} = ?, updated_at = datetime('now') WHERE place_id = ?`,
    ).run(value ?? null, placeId)
  }
}

// --- Visit tracking ---

export function addVisit(
  placeId: string,
  rating: number | null,
  visitDate?: string,
  notes?: string,
): RestaurantVisit {
  const db = getDb()
  const date = visitDate || new Date().toISOString().split('T')[0]
  const now = new Date().toISOString()
  const existing = db
    .prepare(
      'SELECT id FROM restaurant_visits WHERE place_id = ? AND visit_date = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(placeId, date) as { id: number } | undefined

  let visitId: number
  if (existing) {
    db.prepare(
      'UPDATE restaurant_visits SET rating = ?, notes = ?, deleted_at = NULL, created_at = ? WHERE id = ?',
    ).run(rating, notes || null, now, existing.id)
    visitId = existing.id
  } else {
    const result = db
      .prepare(
        'INSERT INTO restaurant_visits (place_id, visit_date, rating, notes, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(placeId, date, rating, notes || null, now)
    visitId = result.lastInsertRowid as number
  }

  // Mark as visited on the restaurant
  db.prepare(
    "UPDATE saved_restaurants SET visited = 1, visit_date = ?, updated_at = datetime('now') WHERE place_id = ?",
  ).run(date, placeId)

  // Update personal_rating to the average
  const visits = db
    .prepare(
      'SELECT rating FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL AND rating IS NOT NULL',
    )
    .all(placeId) as Array<Record<string, unknown>>
  if (visits.length > 0) {
    const avg = visits.reduce((s: number, v: any) => s + v.rating, 0) / visits.length
    db.prepare(
      "UPDATE saved_restaurants SET personal_rating = ?, updated_at = datetime('now') WHERE place_id = ?",
    ).run(parseFloat(avg.toFixed(1)), placeId)
  }

  return { id: visitId, placeId, visitDate: date, rating, notes: notes || null, createdAt: now }
}

export function updateVisit(
  visitId: number,
  updates: { rating?: number | null; notes?: string; visitDate?: string },
): void {
  const db = getDb()
  const current = db
    .prepare('SELECT place_id, visit_date FROM restaurant_visits WHERE id = ?')
    .get(visitId) as Record<string, unknown>
  if (!current) return
  const now = new Date().toISOString()

  if (updates.visitDate !== undefined && updates.visitDate !== current.visit_date) {
    const duplicate = db
      .prepare(
        'SELECT id FROM restaurant_visits WHERE place_id = ? AND visit_date = ? AND id != ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(current.place_id, updates.visitDate, visitId) as { id: number } | undefined
    if (duplicate) {
      if (updates.rating !== undefined)
        db.prepare(
          'UPDATE restaurant_visits SET rating = ?, deleted_at = NULL, created_at = ? WHERE id = ?',
        ).run(updates.rating, now, duplicate.id)
      if (updates.notes !== undefined)
        db.prepare(
          'UPDATE restaurant_visits SET notes = ?, deleted_at = NULL, created_at = ? WHERE id = ?',
        ).run(updates.notes || null, now, duplicate.id)
      db.prepare('UPDATE restaurant_visits SET deleted_at = ?, created_at = ? WHERE id = ?').run(
        now,
        now,
        visitId,
      )
      visitId = duplicate.id
    } else {
      db.prepare(
        'UPDATE restaurant_visits SET visit_date = ?, deleted_at = NULL, created_at = ? WHERE id = ?',
      ).run(updates.visitDate, now, visitId)
    }
  }

  if (updates.rating !== undefined)
    db.prepare(
      'UPDATE restaurant_visits SET rating = ?, deleted_at = NULL, created_at = ? WHERE id = ?',
    ).run(updates.rating, now, visitId)
  if (updates.notes !== undefined)
    db.prepare(
      'UPDATE restaurant_visits SET notes = ?, deleted_at = NULL, created_at = ? WHERE id = ?',
    ).run(updates.notes || null, now, visitId)

  // Recalculate average
  const visit =
    (db.prepare('SELECT place_id FROM restaurant_visits WHERE id = ?').get(visitId) as Record<
      string,
      unknown
    >) || current
  if (visit) {
    const visits = db
      .prepare(
        'SELECT rating FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL AND rating IS NOT NULL',
      )
      .all(visit.place_id) as Array<Record<string, unknown>>
    if (visits.length > 0) {
      const avg = visits.reduce((s: number, v: any) => s + v.rating, 0) / visits.length
      db.prepare(
        "UPDATE saved_restaurants SET personal_rating = ?, updated_at = datetime('now') WHERE place_id = ?",
      ).run(parseFloat(avg.toFixed(1)), visit.place_id)
    } else {
      db.prepare(
        "UPDATE saved_restaurants SET personal_rating = NULL, updated_at = datetime('now') WHERE place_id = ?",
      ).run(visit.place_id)
    }
    const latest = db
      .prepare(
        'SELECT visit_date FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL ORDER BY visit_date DESC LIMIT 1',
      )
      .get(visit.place_id) as Record<string, unknown>
    db.prepare(
      "UPDATE saved_restaurants SET visited = 1, visit_date = ?, updated_at = datetime('now') WHERE place_id = ?",
    ).run(latest?.visit_date || null, visit.place_id)
  }
}

export function removeVisit(visitId: number): void {
  const db = getDb()
  const visit = db
    .prepare('SELECT place_id FROM restaurant_visits WHERE id = ?')
    .get(visitId) as Record<string, unknown>
  const now = new Date().toISOString()
  db.prepare('UPDATE restaurant_visits SET deleted_at = ?, created_at = ? WHERE id = ?').run(
    now,
    now,
    visitId,
  )

  if (visit) {
    const remaining = db
      .prepare(
        'SELECT rating FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL AND rating IS NOT NULL',
      )
      .all(visit.place_id) as Array<Record<string, unknown>>
    if (remaining.length > 0) {
      const avg = remaining.reduce((s: number, v: any) => s + v.rating, 0) / remaining.length
      db.prepare(
        "UPDATE saved_restaurants SET personal_rating = ?, updated_at = datetime('now') WHERE place_id = ?",
      ).run(parseFloat(avg.toFixed(1)), visit.place_id)
    } else {
      db.prepare(
        "UPDATE saved_restaurants SET personal_rating = NULL, updated_at = datetime('now') WHERE place_id = ?",
      ).run(visit.place_id)
    }
    const anyVisits = db
      .prepare('SELECT 1 FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL LIMIT 1')
      .get(visit.place_id)
    if (!anyVisits) {
      db.prepare(
        "UPDATE saved_restaurants SET visited = 0, visit_date = NULL, updated_at = datetime('now') WHERE place_id = ?",
      ).run(visit.place_id)
    }
  }
}

export function getVisits(placeId: string): RestaurantVisit[] {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT * FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL ORDER BY visit_date DESC',
    )
    .all(placeId) as Array<Record<string, unknown>>
  return rows.map((v) => ({
    id: v.id,
    placeId: v.place_id,
    visitDate: v.visit_date,
    rating: v.rating,
    notes: v.notes,
    createdAt: v.created_at,
  }))
}

// --- Quick AI Describe (for unsaved nearby places) ---

const placeDescriptionCache = new Map<string, string>()

export async function describePlace(
  name: string,
  address: string,
  primaryType?: string | null,
): Promise<string> {
  const cacheKey = `${name}|${address}`.toLowerCase()
  const cached = placeDescriptionCache.get(cacheKey)
  if (cached) return cached

  // Check DB in case it's a saved place with a description
  const db = getDb()
  const row = db
    .prepare('SELECT description FROM saved_restaurants WHERE name = ? AND description IS NOT NULL')
    .get(name) as Record<string, unknown>
  if (row?.description) {
    placeDescriptionCache.set(cacheKey, row.description)
    return row.description
  }

  const settings = getAppSettings()
  const city = settings?.weekendCity || 'Chicago'

  let description = ''
  await generateAnalysisStreaming(
    "You are a local expert. Give a 1-2 sentence description of what this place is and what it's known for. Be specific and concise. Just the description text, no JSON or formatting.",
    `What is "${name}" at ${address || city}?${primaryType ? ` (Type: ${primaryType})` : ''}`,
    (chunk) => {
      description += chunk
    },
  )

  description = description.trim()
  if (description) placeDescriptionCache.set(cacheKey, description)
  return description
}

// --- AI Research ---

async function performRestaurantResearch(
  placeId: string,
): Promise<{ response: string; updated: boolean }> {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM saved_restaurants WHERE place_id = ?')
    .get(placeId) as Record<string, unknown>
  if (!row) throw new Error('Restaurant not found')

  const settings = getAppSettings()
  const city = settings?.weekendCity || 'Chicago'

  const FOOD_TYPES = ['restaurant', 'bar', 'dessert', 'cafe']
  const isPlace = !FOOD_TYPES.includes(row.venue_type || 'restaurant')

  const systemPrompt = isPlace
    ? `You are a local expert and place researcher. Research the given venue/place and provide detailed, accurate information. Be specific with real data — don't make up details you're not confident about.`
    : `You are a food critic and restaurant researcher. Research the given restaurant and provide detailed, accurate information. Be specific with real data — don't make up details you're not confident about.`

  const userPrompt = isPlace
    ? `Research this place/venue:
- Name: ${row.name}
- Address: ${row.address || 'Unknown'}
- City: ${city}
- Venue type: ${row.venue_type || 'Unknown'}

Provide a JSON response with these fields (use null for anything you're not confident about):
\`\`\`json
{
  "description": "2-3 sentence description of the place, what it's known for, and why it's worth visiting",
  "venueType": "attraction or store or museum or sports or music or stadium or park or theater or other",
  "peakTimes": "busiest times, e.g. 'Weekends 11am-3pm' or 'Fri-Sat evenings'",
  "busyDaysMatrix": {
    "Mon": { "level": 0.0-1.0, "peakHours": "e.g. '11am-3pm' or null" },
    "Tue": { "level": 0.0-1.0, "peakHours": "..." },
    "Wed": { "level": 0.0-1.0, "peakHours": "..." },
    "Thu": { "level": 0.0-1.0, "peakHours": "..." },
    "Fri": { "level": 0.0-1.0, "peakHours": "..." },
    "Sat": { "level": 0.0-1.0, "peakHours": "..." },
    "Sun": { "level": 0.0-1.0, "peakHours": "..." }
  }
}
\`\`\`

For "busyDaysMatrix", level is how crowded a typical week is on each day (0=empty, 1=packed). Reflect real patterns. If you can't tell, use null for the whole field.`
    : `Research this restaurant/bar:
- Name: ${row.name}
- Address: ${row.address || 'Unknown'}
- City: ${city}
- Current cuisine tags: ${row.cuisine || 'None'}
- Current price level: ${row.price_level ? PRICE_LABELS[row.price_level] : 'Unknown'}

Provide a JSON response with these fields (use null for anything you're not confident about):
\`\`\`json
{
  "description": "2-3 sentence description of the restaurant, vibe, and what it's known for",
  "cuisineCategory": "primary cuisine category (e.g. Italian, Chinese, Japanese, Korean, Thai, Mexican, Mediterranean, Indian, French, Fusion, Seafood, Steakhouse, BBQ, Sushi, Ramen, Desserts, Cocktails, Wine Bar, Brewery, etc.)",
  "venueType": "restaurant or bar or dessert or cafe",
  "spiceLevel": "none or mild or medium or spicy or very-spicy (null if not applicable)",
  "priceLevel": 1-4 (1=$, 2=$$, 3=$$$, 4=$$$$),
  "peakTimes": "busiest times, e.g. 'Fri-Sat 7-9pm' or 'Weekend brunch 10am-1pm'",
  "bookingAdvance": "how far in advance to book, e.g. '2-4 weeks' or 'Walk-in friendly'",
  "bookingAdvanceDays": typical number of days in advance that reservations open up or get fully booked (integer, e.g. 14, 30; use 0 for walk-in/no reservations needed; null if unknown),
  "busyDaysMatrix": {
    "Mon": { "level": 0.0-1.0, "peakHours": "e.g. '6-8pm' or null" },
    "Tue": { "level": 0.0-1.0, "peakHours": "..." },
    "Wed": { "level": 0.0-1.0, "peakHours": "..." },
    "Thu": { "level": 0.0-1.0, "peakHours": "..." },
    "Fri": { "level": 0.0-1.0, "peakHours": "..." },
    "Sat": { "level": 0.0-1.0, "peakHours": "..." },
    "Sun": { "level": 0.0-1.0, "peakHours": "..." }
  },
  "reservationLink": "OpenTable or Resy URL if known, otherwise null"
}
\`\`\`

For "busyDaysMatrix", level is how booked-up / crowded a typical week is on each day (0=empty, 1=fully booked). Reflect real patterns: many places spike Fri/Sat, brunch spots peak Sun, bars peak Thu-Sat. If you can't tell, use null for the whole busyDaysMatrix field. For "bookingAdvanceDays", be realistic — places like Alinea need ~30 days, mid-tier ~7-14, casual ~0-3.`

  const response = await generateAnalysisStreaming(
    systemPrompt,
    userPrompt,
    { webSearch: true },
    'restaurant:research',
  )

  const data = parseAiJson<Record<string, unknown>>(response).value
  const updates: Parameters<typeof updateRestaurant>[1] = {}

  if (typeof data.description === 'string' && data.description.trim()) {
    updates.description = data.description.trim()
  }
  if (typeof data.cuisineCategory === 'string' && data.cuisineCategory.trim()) {
    updates.cuisineCategory = data.cuisineCategory.trim()
  }
  if (typeof data.venueType === 'string' && data.venueType.trim()) {
    updates.venueType = data.venueType.trim() as VenueType
  }
  if (typeof data.spiceLevel === 'string' && data.spiceLevel.trim()) {
    updates.spiceLevel = data.spiceLevel.trim() as SpiceLevel
  }
  if (typeof data.priceLevel === 'number' && Number.isFinite(data.priceLevel)) {
    updates.priceLevel = data.priceLevel
  }
  if (typeof data.peakTimes === 'string' && data.peakTimes.trim()) {
    updates.peakTimes = data.peakTimes.trim()
  }
  if (typeof data.bookingAdvance === 'string' && data.bookingAdvance.trim()) {
    updates.bookingAdvance = data.bookingAdvance.trim()
  }
  if (typeof data.reservationLink === 'string' && data.reservationLink.trim()) {
    updates.reservationLink = data.reservationLink.trim()
  }
  if (typeof data.bookingAdvanceDays === 'number' && data.bookingAdvanceDays >= 0) {
    updates.bookingAdvanceDays = Math.round(data.bookingAdvanceDays)
  }
  const matrix = normalizeBusyDaysMatrix(data.busyDaysMatrix)
  if (matrix) updates.busyDaysMatrix = matrix

  const updated = Object.keys(updates).length > 0
  if (updated) {
    updates.lastResearchedAt = new Date().toISOString()
    updateRestaurant(placeId, updates)
  }

  return { response, updated }
}

export async function researchRestaurant(placeId: string): Promise<string> {
  const result = await performRestaurantResearch(placeId)
  return result.response
}

function normalizeBusyDaysMatrix(raw: unknown): BusyDaysMatrix | null {
  if (!raw || typeof raw !== 'object') return null
  const out: BusyDaysMatrix = {}
  let anyValid = false
  const rawRecord = raw as Record<string, unknown>
  for (const day of DAYS_OF_WEEK) {
    const entry = rawRecord[day]
    if (!entry || typeof entry !== 'object') continue
    const entryRecord = entry as Record<string, unknown>
    const lvl = Number(entryRecord.level)
    if (!Number.isFinite(lvl)) continue
    const clamped = Math.max(0, Math.min(1, lvl))
    const peakHours =
      typeof entryRecord.peakHours === 'string' && entryRecord.peakHours.trim()
        ? entryRecord.peakHours.trim()
        : null
    out[day] = { level: clamped, peakHours }
    anyValid = true
  }
  return anyValid ? out : null
}

export interface ResearchAllResult {
  updated: number
  skipped: number
  failed: number
  total: number
}

export interface ResearchAllProgress {
  current: number
  total: number
  name: string
  status: 'researching' | 'updated' | 'skipped' | 'failed'
}

export async function researchAllRestaurants(
  opts: { force?: boolean } = {},
  onProgress?: (p: ResearchAllProgress) => void,
): Promise<ResearchAllResult> {
  const force = opts.force === true
  const all = getSavedRestaurants().filter((r) =>
    ['restaurant', 'bar', 'dessert', 'cafe'].includes(r.venueType),
  )
  const result: ResearchAllResult = { updated: 0, skipped: 0, failed: 0, total: all.length }
  const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000
  const now = Date.now()

  for (let i = 0; i < all.length; i++) {
    const r = all[i]
    const cur = i + 1

    if (!force && r.lastResearchedAt) {
      const last = Date.parse(r.lastResearchedAt)
      if (Number.isFinite(last) && now - last < sixtyDaysMs) {
        result.skipped++
        onProgress?.({ current: cur, total: all.length, name: r.name, status: 'skipped' })
        continue
      }
    }

    onProgress?.({ current: cur, total: all.length, name: r.name, status: 'researching' })
    try {
      const research = await performRestaurantResearch(r.placeId)
      if (research.updated) {
        result.updated++
        onProgress?.({ current: cur, total: all.length, name: r.name, status: 'updated' })
      } else {
        result.skipped++
        onProgress?.({ current: cur, total: all.length, name: r.name, status: 'skipped' })
      }
    } catch {
      result.failed++
      onProgress?.({ current: cur, total: all.length, name: r.name, status: 'failed' })
    }

    if (i < all.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  return result
}

function discoverJsonTemplate(mode: 'food' | 'places'): string {
  return mode === 'places'
    ? `[
  {
    "name": "Place Name",
    "address": "Full address",
    "venueType": "attraction or store or museum or sports or music or stadium or park or theater or other",
    "description": "1-2 sentence description",
    "peakTimes": "busiest times",
    "whyRecommended": "Why this matches the request"
  }
]`
    : `[
  {
    "name": "Restaurant Name",
    "address": "Full address",
    "venueType": "restaurant or bar or dessert or cafe",
    "cuisineCategory": "Primary cuisine",
    "priceLevel": 1-4,
    "description": "1-2 sentence description",
    "spiceLevel": "none/mild/medium/spicy/very-spicy or null",
    "bookingAdvance": "e.g. '2-4 weeks' or 'Walk-in friendly'",
    "peakTimes": "busiest times",
    "whyRecommended": "Why this matches the request"
  }
]`
}

export async function discoverRestaurants(
  query: string,
  mode: 'food' | 'places' = 'food',
): Promise<string> {
  const settings = getAppSettings()
  const city = settings?.weekendCity || 'Chicago'

  // Get existing saved restaurants for context
  const saved = getSavedRestaurants()
  const savedNames = saved.map((r) => r.name).join(', ')

  const systemPrompt =
    mode === 'places'
      ? `You are a local expert for ${city}. Suggest interesting places, venues, shops, and attractions (museums, parks, stores, theaters, attractions, sports/music venues, etc.) based on the user's request. Never suggest restaurants, cafes, bars, dessert spots, or any food/dining establishments — those are out of scope.`
      : `You are a food critic and local dining expert for ${city}. Suggest dining establishments — restaurants and cafes (and bars/dessert spots) — based on the user's request. Never suggest non-dining places like museums, parks, shops, or attractions — those are out of scope.`

  const userPrompt = `The user is looking for: "${query}" in ${city}.

Already saved places: ${savedNames || 'None yet'}

Suggest 5-8 ${mode === 'places' ? 'places/venues' : 'restaurants/cafes'} that match. For each, provide:
\`\`\`json
${discoverJsonTemplate(mode)}
\`\`\`

Hard rules:
- Only suggest real, currently open establishments. Don't repeat already-saved places.
- ${
    mode === 'places'
      ? 'Do NOT include restaurants, cafes, bars, or any food/dining establishments. Only non-dining places.'
      : 'Do NOT include non-dining places (museums, parks, shops, attractions, venues). Only restaurants and cafes (bars/dessert spots are fine).'
  }`

  return await generateAnalysisStreaming(
    systemPrompt,
    userPrompt,
    { webSearch: true },
    'restaurant:discover',
  )
}

/**
 * Suggest trending / newly-opened spots not already saved, by searching the web.
 * Unlike discoverRestaurants this needs no query — it surfaces what's currently
 * buzzy or recently opened in the user's city, explicitly excluding saved places.
 */
export async function discoverTrendingPlaces(mode: 'food' | 'places' = 'food'): Promise<string> {
  const settings = getAppSettings()
  const city = settings?.weekendCity || 'Chicago'
  const neighborhood = settings?.homeNeighborhood?.trim()

  // Exclude everything already on the map (saved places of any type)
  const saved = getSavedRestaurants()
  const savedNames = saved.map((r) => r.name).join(', ')

  const localeContext = neighborhood
    ? `${city} (the user is based in/near ${neighborhood})`
    : city

  const systemPrompt =
    mode === 'places'
      ? `You are a plugged-in local culture editor for ${city}. You track new openings, pop-ups, and venues (museums, attractions, shops, theaters, parks, sports/music venues, etc.) that are getting buzz right now. Use web search to ground every suggestion in current, real information. Never suggest restaurants, cafes, bars, dessert spots, or any food/dining establishments — those are out of scope.`
      : `You are a plugged-in local food editor for ${city}. You track new restaurant and cafe openings and what's trending on dining lists, local press, and social media right now. Use web search to ground every suggestion in current, real information. Never suggest non-dining places like museums, parks, shops, or attractions — those are out of scope.`

  const kind = mode === 'places' ? 'places/venues' : 'restaurants/cafes'

  const userPrompt = `Find 5-8 ${kind} in ${localeContext} that are TRENDING or NEWLY OPENED right now.

Prioritize, in order:
1. Spots that opened within roughly the last 12 months.
2. Spots currently getting buzz — recent "best new" lists, local press, awards, or social media attention.
3. Hidden gems on the rise that aren't tourist traps.

Hard rules:
- Search the web to confirm each place is REAL, currently open, and actually recent/trending. Do not invent places.
- Do NOT suggest any place the user has already saved. Already saved (exclude all of these): ${savedNames || 'None yet'}
- Aim for variety across neighborhoods and styles, not 5 of the same thing.
- ${
    mode === 'places'
      ? 'Do NOT include restaurants, cafes, bars, or any food/dining establishments. Only non-dining places.'
      : 'Do NOT include non-dining places (museums, parks, shops, attractions, venues). Only restaurants and cafes (bars/dessert spots are fine).'
  }

For each suggestion, set "whyRecommended" to specifically explain what makes it trending or new (e.g. "Opened March 2026 from the team behind X" or "Topped Eater's best-new list this spring"). Respond with:
\`\`\`json
${discoverJsonTemplate(mode)}
\`\`\``

  return await generateAnalysisStreaming(
    systemPrompt,
    userPrompt,
    { webSearch: true },
    'restaurant:discoverTrending',
  )
}
