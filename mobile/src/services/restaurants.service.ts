/**
 * Restaurant service — Google Places API for restaurant discovery,
 * local DB for saved favorites, and booking deep links.
 */
import { getDb } from '../lib/database'
import { getSettings } from '../lib/storage'
import { Linking } from 'react-native'

export interface Restaurant {
  id: string
  name: string
  address: string
  priceLevel: number | null    // 1-4 ($-$$$$)
  rating: number | null        // 0-5
  totalRatings: number
  distance: string | null       // e.g. "2.3 mi"
  cuisine: string[]
  photoUrl: string | null
  placeId: string
  lat: number
  lng: number
  openNow: boolean | null
  bookingAdvance: string | null // AI-estimated booking lead time
  saved: boolean
}

export type DayOfWeek = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
export const DAYS_OF_WEEK: DayOfWeek[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export type BusyDaysMatrix = Partial<Record<DayOfWeek, { level: number; peakHours: string | null }>>

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
  venueType: string
  cuisineCategory: string | null
  spiceLevel: string | null
  reservationLink: string | null
  peakTimes: string | null
  description: string | null
  visited: boolean
  visitDate: string | null
  personalRating: number | null
  bookingAdvanceDays: number | null
  busyDaysMatrix: BusyDaysMatrix | null
  lastResearchedAt: string | null
  averageRating: number | null
  visits: RestaurantVisit[]
}

export interface RestaurantVisit {
  id: number
  placeId: string
  visitDate: string
  rating: number | null
  notes: string | null
  createdAt: string
}

const PRICE_LABELS = ['', '$', '$$', '$$$', '$$$$']

export function priceLevelLabel(level: number | null): string {
  if (!level || level < 1 || level > 4) return '?'
  return PRICE_LABELS[level]
}

export interface AutocompleteSuggestion {
  placeId: string
  name: string
  description: string
}

export async function autocompleteRestaurants(input: string): Promise<AutocompleteSuggestion[]> {
  const settings = await getSettings()
  const apiKey = settings.googlePlacesKey
  if (!apiKey || !input.trim()) return []

  const city = settings.weekendCity || 'Chicago'
  const params = new URLSearchParams({
    input: `${input} ${city}`,
    types: 'establishment',
    key: apiKey,
  })

  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.predictions || []).slice(0, 6).map((p: any) => ({
      placeId: p.place_id,
      name: p.structured_formatting?.main_text || p.description,
      description: p.structured_formatting?.secondary_text || '',
    }))
  } catch {
    return []
  }
}

/**
 * Search restaurants near a location using Google Places Nearby Search
 */
export async function searchRestaurants(
  query?: string,
  lat?: number,
  lng?: number,
): Promise<Restaurant[]> {
  const settings = await getSettings()
  const apiKey = settings.googlePlacesKey
  if (!apiKey) return []

  const city = settings.weekendCity || 'Chicago'

  // If no lat/lng provided, use Text Search with city
  if (!lat || !lng) {
    return searchByText(apiKey, query ? `${query} restaurants in ${city}` : `best restaurants in ${city}`)
  }

  // Nearby Search
  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: '8000', // 5 miles
    type: 'restaurant',
    key: apiKey,
  })
  if (query) params.set('keyword', query)

  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`
    )
    if (!res.ok) return []
    const data = await res.json()
    return mapPlacesResults(data.results || [], apiKey, lat, lng)
  } catch {
    return []
  }
}

async function searchByText(apiKey: string, query: string): Promise<Restaurant[]> {
  const params = new URLSearchParams({
    query,
    type: 'restaurant',
    key: apiKey,
  })

  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`
    )
    if (!res.ok) return []
    const data = await res.json()
    return mapPlacesResults(data.results || [], apiKey)
  } catch {
    return []
  }
}

function mapPlacesResults(
  results: any[],
  apiKey: string,
  originLat?: number,
  originLng?: number,
): Restaurant[] {
  return results.slice(0, 15).map((p: any) => {
    const lat = p.geometry?.location?.lat
    const lng = p.geometry?.location?.lng
    let distance: string | null = null
    if (originLat && originLng && lat && lng) {
      const mi = haversine(originLat, originLng, lat, lng)
      distance = `${mi.toFixed(1)} mi`
    }

    const types = (p.types || []) as string[]
    const cuisine = types
      .filter((t: string) => !['restaurant', 'food', 'point_of_interest', 'establishment'].includes(t))
      .map((t: string) => t.replace(/_/g, ' '))
      .slice(0, 3)

    const photoRef = p.photos?.[0]?.photo_reference
    const photoUrl = photoRef
      ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photoRef}&key=${apiKey}`
      : null

    return {
      id: p.place_id,
      name: p.name,
      address: p.vicinity || p.formatted_address || '',
      priceLevel: p.price_level ?? null,
      rating: p.rating ?? null,
      totalRatings: p.user_ratings_total || 0,
      distance,
      cuisine,
      photoUrl,
      placeId: p.place_id,
      lat: lat || 0,
      lng: lng || 0,
      openNow: p.opening_hours?.open_now ?? null,
      bookingAdvance: estimateBookingAdvance(p.rating, p.user_ratings_total, p.price_level),
      saved: false,
    }
  })
}

/**
 * Heuristic for how far in advance to book based on popularity/price
 */
function estimateBookingAdvance(
  rating: number | null,
  totalRatings: number | null,
  priceLevel: number | null,
): string {
  const r = rating || 0
  const count = totalRatings || 0
  const price = priceLevel || 0

  // Very popular + expensive = book far ahead
  if ((r >= 4.5 && count > 1000) || price >= 4) return '2-4 weeks'
  if ((r >= 4.3 && count > 500) || price >= 3) return '1-2 weeks'
  if (r >= 4.0 && count > 200) return '3-5 days'
  if (r >= 3.5) return '1-2 days'
  return 'Walk-in friendly'
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8 // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// --- Saved restaurants (local DB) ---

export async function getSavedRestaurants(): Promise<SavedRestaurant[]> {
  const db = await getDb()
  const rows = await db.getAllAsync(
    'SELECT * FROM saved_restaurants ORDER BY saved_at DESC'
  ) as SavedRestaurant[]
  const visitRows = await db.getAllAsync(
    'SELECT * FROM restaurant_visits WHERE deleted_at IS NULL ORDER BY visit_date DESC, created_at DESC'
  ) as any[]
  const visitsByPlace = new Map<string, RestaurantVisit[]>()
  for (const v of visitRows) {
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

  return rows.map((r: any) => {
    let busyDaysMatrix: BusyDaysMatrix | null = null
    if (r.busy_days_matrix) {
      try { busyDaysMatrix = JSON.parse(r.busy_days_matrix) } catch { busyDaysMatrix = null }
    }
    const visits = visitsByPlace.get(r.place_id || r.placeId) || []
    const ratedVisits = visits.filter(v => v.rating != null)
    const averageRating = ratedVisits.length > 0
      ? parseFloat((ratedVisits.reduce((sum, v) => sum + (v.rating || 0), 0) / ratedVisits.length).toFixed(1))
      : null
    return {
      id: r.id,
      placeId: r.place_id || r.placeId,
      name: r.name,
      address: r.address,
      priceLevel: r.price_level ?? r.priceLevel,
      rating: r.rating,
      cuisine: r.cuisine || '',
      lat: r.lat,
      lng: r.lng,
      notes: r.notes,
      bookingAdvance: r.booking_advance ?? r.bookingAdvance,
      savedAt: r.saved_at || r.savedAt,
      venueType: r.venue_type || 'restaurant',
      cuisineCategory: r.cuisine_category || null,
      spiceLevel: r.spice_level || null,
      reservationLink: r.reservation_link || null,
      peakTimes: r.peak_times || null,
      description: r.description || null,
      visited: r.visited === 1 || visits.length > 0,
      visitDate: r.visit_date || null,
      personalRating: r.personal_rating || averageRating,
      bookingAdvanceDays: r.booking_advance_days ?? null,
      busyDaysMatrix,
      lastResearchedAt: r.last_researched_at || null,
      averageRating,
      visits,
    }
  })
}

export async function saveRestaurant(r: Restaurant, notes?: string): Promise<void> {
  const db = await getDb()
  await db.runAsync(
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
    r.placeId, r.name, r.address, r.priceLevel, r.rating,
    r.cuisine.join(', '), r.lat, r.lng, notes || null, r.bookingAdvance
  )
}

export async function removeSavedRestaurant(placeId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM saved_restaurants WHERE place_id = ?', placeId)
}

export async function isSaved(placeId: string): Promise<boolean> {
  const db = await getDb()
  const row = await db.getFirstAsync(
    'SELECT 1 FROM saved_restaurants WHERE place_id = ?', placeId
  )
  return !!row
}

export async function addManualRestaurant(input: {
  name: string
  address?: string
  venueType?: string
  cuisineCategory?: string
  spiceLevel?: string
  priceLevel?: number
  reservationLink?: string
  peakTimes?: string
  bookingAdvance?: string
  notes?: string
  description?: string
}): Promise<void> {
  const db = await getDb()
  const placeId = 'manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  await db.runAsync(
    `INSERT INTO saved_restaurants (place_id, name, address, price_level, venue_type, cuisine_category, spice_level, reservation_link, peak_times, booking_advance, notes, description, lat, lng, cuisine, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, datetime('now'))`,
    placeId,
    input.name,
    input.address || '',
    input.priceLevel || null,
    input.venueType || 'restaurant',
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

export async function updateRestaurant(placeId: string, updates: Record<string, any>): Promise<void> {
  const db = await getDb()
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
  }

  for (const [key, value] of Object.entries(updates)) {
    const col = fieldMap[key]
    if (!col) continue
    const dbValue = key === 'visited' ? (value ? 1 : 0) : value
    await db.runAsync(`UPDATE saved_restaurants SET ${col} = ?, updated_at = datetime('now') WHERE place_id = ?`, dbValue, placeId)
  }
}

async function refreshVisitSummary(placeId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `UPDATE saved_restaurants
     SET personal_rating = (
         SELECT CASE WHEN COUNT(rating) > 0 THEN ROUND(AVG(rating), 1) ELSE NULL END
         FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL
       ),
       visited = CASE WHEN EXISTS (SELECT 1 FROM restaurant_visits WHERE place_id = ? AND deleted_at IS NULL) THEN 1 ELSE 0 END,
       visit_date = (
         SELECT visit_date FROM restaurant_visits
         WHERE place_id = ? AND deleted_at IS NULL
         ORDER BY visit_date DESC
         LIMIT 1
       )
     WHERE place_id = ?`,
    placeId,
    placeId,
    placeId,
    placeId
  )
}

export async function addVisit(placeId: string, rating: number | null, visitDate?: string, notes?: string): Promise<RestaurantVisit> {
  const db = await getDb()
  const date = visitDate || new Date().toISOString().split('T')[0]
  const now = new Date().toISOString()
  const existing = await db.getFirstAsync(
    'SELECT id FROM restaurant_visits WHERE place_id = ? AND visit_date = ? ORDER BY created_at DESC LIMIT 1',
    placeId,
    date
  ) as { id: number } | null

  let visitId: number
  if (existing) {
    await db.runAsync('UPDATE restaurant_visits SET rating = ?, notes = ?, deleted_at = NULL, created_at = ? WHERE id = ?', rating, notes || null, now, existing.id)
    visitId = existing.id
  } else {
    const result = await db.runAsync(
      'INSERT INTO restaurant_visits (place_id, visit_date, rating, notes, created_at) VALUES (?, ?, ?, ?, ?)',
      placeId,
      date,
      rating,
      notes || null,
      now
    )
    visitId = result.lastInsertRowId
  }

  await refreshVisitSummary(placeId)
  return { id: visitId, placeId, visitDate: date, rating, notes: notes || null, createdAt: now }
}

export async function updateVisit(visitId: number, updates: { rating?: number | null; visitDate?: string; notes?: string }): Promise<void> {
  const db = await getDb()
  const current = await db.getFirstAsync(
    'SELECT place_id, visit_date FROM restaurant_visits WHERE id = ?',
    visitId
  ) as { place_id: string; visit_date: string } | null
  if (!current) return
  const now = new Date().toISOString()

  if (updates.visitDate !== undefined && updates.visitDate !== current.visit_date) {
    const duplicate = await db.getFirstAsync(
      'SELECT id FROM restaurant_visits WHERE place_id = ? AND visit_date = ? AND id != ? ORDER BY created_at DESC LIMIT 1',
      current.place_id,
      updates.visitDate,
      visitId
    ) as { id: number } | null
    if (duplicate) {
      if (updates.rating !== undefined) await db.runAsync('UPDATE restaurant_visits SET rating = ?, deleted_at = NULL, created_at = ? WHERE id = ?', updates.rating, now, duplicate.id)
      if (updates.notes !== undefined) await db.runAsync('UPDATE restaurant_visits SET notes = ?, deleted_at = NULL, created_at = ? WHERE id = ?', updates.notes || null, now, duplicate.id)
      await db.runAsync('UPDATE restaurant_visits SET deleted_at = ?, created_at = ? WHERE id = ?', now, now, visitId)
      visitId = duplicate.id
    } else {
      await db.runAsync('UPDATE restaurant_visits SET visit_date = ?, deleted_at = NULL, created_at = ? WHERE id = ?', updates.visitDate, now, visitId)
    }
  }
  if (updates.rating !== undefined) await db.runAsync('UPDATE restaurant_visits SET rating = ?, deleted_at = NULL, created_at = ? WHERE id = ?', updates.rating, now, visitId)
  if (updates.notes !== undefined) await db.runAsync('UPDATE restaurant_visits SET notes = ?, deleted_at = NULL, created_at = ? WHERE id = ?', updates.notes || null, now, visitId)

  await refreshVisitSummary(current.place_id)
}

export async function removeVisit(visitId: number): Promise<void> {
  const db = await getDb()
  const visit = await db.getFirstAsync(
    'SELECT place_id FROM restaurant_visits WHERE id = ?',
    visitId
  ) as { place_id: string } | null
  const now = new Date().toISOString()
  await db.runAsync('UPDATE restaurant_visits SET deleted_at = ?, created_at = ? WHERE id = ?', now, now, visitId)
  if (visit) await refreshVisitSummary(visit.place_id)
}

export async function rateRestaurant(placeId: string, rating: number): Promise<void> {
  await addVisit(placeId, rating)
}

// --- Booking deep links ---

export function openBooking(restaurantName: string, city?: string): void {
  // Try OpenTable search — this opens the OpenTable app or website with search pre-filled
  const searchQuery = encodeURIComponent(`${restaurantName} ${city || ''}`.trim())
  const openTableUrl = `https://www.opentable.com/s?term=${searchQuery}`
  Linking.openURL(openTableUrl)
}

export function openResyBooking(restaurantName: string, city?: string): void {
  const c = (city || 'chicago').toLowerCase().replace(/\s+/g, '-')
  const slug = restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-')
  const resyUrl = `https://resy.com/cities/${c}/${slug}`
  Linking.openURL(resyUrl)
}

export function openGoogleMaps(name: string, lat: number, lng: number): void {
  const query = encodeURIComponent(name)
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=`)
}

export function openYelp(restaurantName: string, city?: string): void {
  const term = encodeURIComponent(restaurantName)
  const loc = encodeURIComponent(city || 'Chicago')
  Linking.openURL(`https://www.yelp.com/search?find_desc=${term}&find_loc=${loc}`)
}

/**
 * AI-powered restaurant research — fetches insights like busy days,
 * booking advance time, cuisine details via Claude (relay).
 */
export async function researchRestaurant(placeId: string, name: string, cuisine?: string): Promise<{
  description: string | null
  bookingAdvanceDays: number | null
  busyDaysMatrix: BusyDaysMatrix | null
  peakTimes: string | null
} | null> {
  const settings = await getSettings()
  const relayUrl = settings.relayUrl?.replace(/\/$/, '')
  if (!relayUrl) return null

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (settings.relayToken) headers['Authorization'] = `Bearer ${settings.relayToken}`

    // Use the relay's AI proxy to research the restaurant
    const { generateAnalysis } = await import('./ai.service')
    const prompt = `Research this restaurant and provide structured insights:

Restaurant: ${name}
${cuisine ? `Cuisine: ${cuisine}` : ''}

Provide:
1. Brief description (2-3 sentences about the vibe, specialty, and what makes it special)
2. Estimated booking advance needed (days): how far ahead should you book?
3. Busy days matrix: for each day of the week, rate busyness 1-5 and note peak hours
4. Peak dining times

Respond in this exact JSON format:
{
  "description": "...",
  "bookingAdvanceDays": 3,
  "busyDaysMatrix": { "Fri": { "level": 4, "peakHours": "7-9 PM" }, "Sat": { "level": 5, "peakHours": "7-10 PM" } },
  "peakTimes": "Friday-Saturday 7-9 PM"
}`

    const response = await generateAnalysis(
      'You are a restaurant researcher. Return ONLY valid JSON, no markdown or explanation.',
      prompt
    )

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])

    // Save research results to local DB
    const db = await getDb()
    await db.runAsync(
      `UPDATE saved_restaurants SET
        description = ?,
        booking_advance_days = ?,
        busy_days_matrix = ?,
        peak_times = ?,
        last_researched_at = datetime('now')
       WHERE place_id = ?`,
      parsed.description || null,
      parsed.bookingAdvanceDays || null,
      parsed.busyDaysMatrix ? JSON.stringify(parsed.busyDaysMatrix) : null,
      parsed.peakTimes || null,
      placeId
    )

    return {
      description: parsed.description || null,
      bookingAdvanceDays: parsed.bookingAdvanceDays || null,
      busyDaysMatrix: parsed.busyDaysMatrix || null,
      peakTimes: parsed.peakTimes || null,
    }
  } catch (err) {
    console.error('[Restaurants] Research failed:', err)
    return null
  }
}
