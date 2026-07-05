const cache = new Map<string, { lat: number; lng: number }>()

/**
 * Resolve a free-text location to coordinates using the Google Places API (New)
 * `places:searchText` endpoint — the SAME API the desktop weekend map uses.
 *
 * We intentionally do NOT use the legacy Geocoding API (`/maps/api/geocode/json`):
 * it is a separate API that must be enabled independently, and on this project's
 * key it is not, so every request came back REQUEST_DENIED and the map showed
 * no pins. Places (New) is already enabled (the desktop map relies on it).
 */
export async function geocodeLocation(
  locationName: string,
  apiKey: string,
  city?: string
): Promise<{ lat: number; lng: number } | null> {
  if (!locationName || !apiKey) return null

  const cacheKey = `${locationName.toLowerCase().trim()}|${(city || '').toLowerCase()}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)!

  // Append the city for context unless the query already names a state/region.
  const hasRegion = /\b[A-Z]{2}\b|,\s*[A-Za-z ]+$/.test(locationName)
  const textQuery = city && !hasRegion ? `${locationName} ${city}` : locationName

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.location',
      },
      body: JSON.stringify({ textQuery, maxResultCount: 1 }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[geocoding] Places HTTP ${res.status} for "${textQuery}": ${text.slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    const loc = data.places?.[0]?.location
    if (typeof loc?.latitude !== 'number' || typeof loc?.longitude !== 'number') {
      console.warn(`[geocoding] No Places result for "${textQuery}"`)
      return null
    }

    const coords = { lat: loc.latitude, lng: loc.longitude }
    cache.set(cacheKey, coords)
    return coords
  } catch (err) {
    console.warn(`[geocoding] Places request failed for "${textQuery}":`, err)
    return null
  }
}
