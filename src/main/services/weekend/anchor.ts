/**
 * Pure, dependency-free helpers for anchoring a weekend day to a user-named location.
 * Kept separate from weekend-planner.service so they can be unit-tested without pulling
 * in the DB / electron-store / AI import chain.
 */

const ANCHOR_TRAILING_WORD = /\s+(area|neighborhood|district|vicinity)$/i
const STREET_TYPE_WORD =
  /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|pl|place|pkwy|parkway|way|ter|terrace|hwy|highway|sq|square)\b/i
// Capitalized words that commonly follow "at/by/near" but are not places.
const NON_PLACE_PHRASE = /^(the|a|an|noon|midnight|lunch|dinner|breakfast|brunch|home|then)\b/i

/**
 * Pull a geocodable anchor out of the user's free-text notes — an address like
 * "851 W Irving Park" or a phrase like "around Thai Fest". Returns '' when nothing
 * location-like is present (so we skip distance grounding rather than geocode garbage).
 *
 * Deliberately conservative: a wrong anchor would compute distances from the wrong point
 * and drop good saved places, so we only accept a street address that carries a
 * directional or street-type word, or a "near/around X" phrase that names a proper noun.
 * "$50 budget", "20 people", "table for 4", and "dinner at 7" must all yield ''.
 */
export function extractAnchorQuery(text?: string): string {
  if (!text) return ''
  const t = text.replace(/\s+/g, ' ').trim()

  // Street-address shape: number + optional directional + 1-3 street-name words (letters
  // only, so a sentence period like "park area. eat" ends the match).
  const addr = t.match(
    /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3}/,
  )
  if (addr) {
    let candidate = addr[0].trim()
    const num = candidate.split(/\s+/)[0]
    const isMoney = new RegExp(`\\$\\s*${num}\\b`).test(t)
    const suffix = candidate.match(STREET_TYPE_WORD)
    if (suffix) {
      // Truncate after the street-type word so trailing prose ("then walk") is dropped.
      candidate = candidate.slice(0, candidate.indexOf(suffix[0]) + suffix[0].length)
    } else {
      candidate = candidate.replace(ANCHOR_TRAILING_WORD, '').trim()
    }
    const hasDirectional = /\b[NSEW]\.?(?=\s)/i.test(candidate)
    if (!isMoney && (hasDirectional || suffix)) return candidate
  }

  // Otherwise a "around/near/at X" phrase — a run of consecutive capitalized/proper-noun
  // words (stops at the first lowercase filler word like "please" or "then").
  const near = t.match(
    /\b(?:around|near|next to|close to|over by|right by|at|by)\s+([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*){0,3})/,
  )
  if (near) {
    const phrase = near[1].replace(ANCHOR_TRAILING_WORD, '').trim()
    if (!NON_PLACE_PHRASE.test(phrase)) return phrase
  }
  return ''
}

/**
 * How far a saved place may sit from the day's anchor before we drop it. When the user
 * isn't driving, a saved favorite a few miles away is useless, so the radius is tight.
 */
export function anchorRadiusMiles(transportMode?: string): number {
  const m = (transportMode || 'driving').toLowerCase()
  if (m.includes('driv') || m.includes('car')) return 8
  if (m.includes('walk') || m.includes('foot') || m.includes('bik') || m.includes('cycl')) return 1.5
  return 3 // transit / rideshare only
}
