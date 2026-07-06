import { getDb } from '../../db/database'
import { generateAnalysis, generateAnalysisStreaming } from '../ai.service'
import { buildSleepAnalysisContext } from '../health/sleep-analysis'
import {
  fetchTicketmasterEvents,
  searchTicketmasterEvents,
  dedupeLocalEvents,
  getCuratedChicagoSpots,
  getNextWeekendRange,
  type LocalEvent,
  type EventSearchResult,
} from './events.fetcher'
import {
  getSavedRestaurants,
  priceLevelLabel,
  DAYS_OF_WEEK,
  type SavedRestaurant,
  type BusyDaysMatrix,
} from './restaurants.service'
import { getAppSettings } from '../../lib/settings'
import { parseAiJson } from '../ai-json'
import { formatWeatherForPlanner, getPlannerWeatherPreview } from '../weather.service'
import { geocodeAnchor, haversineMiles } from './distance.service'
import { extractAnchorQuery, anchorRadiusMiles } from './anchor'

export type WeekendTheme =
  | 'foodie'
  | 'outdoors'
  | 'chill'
  | 'culture'
  | 'date_night'
  | 'hidden_gems'
  | 'social'

export type WeekendLocationStrategy = 'clustered' | 'two_zones' | 'open'
export type WeekendDiscoveryMode = 'balanced' | 'new_neighborhoods' | 'saved_favorites'

const THEME_GUIDANCE: Record<WeekendTheme, string> = {
  foodie:
    'Foodie crawl — build the day around food. Prioritize the saved restaurants below. Add 1-2 bars, food halls, dessert spots, or coffee stops between meals. Skip museums and tourist landmarks unless they happen to sit between meal stops.',
  outdoors:
    'Outdoorsy / active — lakefront, trails, parks, kayaking, biking, climbing gyms, neighborhood walks. Lean physical. Mention if outdoor plans need a weather check. Pair with casual food, not white-tablecloth dinners.',
  chill:
    'Chill / recovery — low-energy day. 2-3 unhurried activities per day with long buffers. Cafes, slow brunches, bookshops, parks, neighborhood walks. No early starts. Especially sleep-debt friendly.',
  culture:
    'Culture & art — museums, galleries, live music, theater, architecture walks, indie cinemas. Pair with a thoughtful meal nearby. Mix obvious picks with one lesser-known venue.',
  date_night:
    'Date night — romantic, intimate pacing. Anchor on a quality dinner (prefer saved restaurants), add a cocktail bar, plus one evening activity (live music, rooftop, jazz club, walk along the water, a small show). One activity per day, done well.',
  hidden_gems:
    'Hidden gems / local — explicitly non-touristy. Avoid the Chicago checklist: Cloud Gate (The Bean), Navy Pier, Art Institute, Museum of Science & Industry, Architecture Boat Tour, Field Museum, Lincoln Park Zoo, Riverwalk, Willis Tower, 360 Chicago. Suggest neighborhood-specific spots locals actually visit — dive bars, smaller galleries, ethnic enclaves, hidden parks, BYOB spots, hole-in-the-walls.',
  social:
    'Social / hangout — group-friendly. Beer gardens, patios, big-table restaurants, bowling/arcade bars, parks for hanging out, live music venues with room to talk. Casual, communal.',
}

const TOURISTY_BLACKLIST = [
  'Cloud Gate',
  'The Bean',
  'Navy Pier',
  'Art Institute',
  'Museum of Science and Industry',
  'Architecture Center Boat',
  'Architecture Boat Tour',
  'Field Museum',
  'Lincoln Park Zoo',
  'Chicago Riverwalk',
  'Willis Tower',
  '360 Chicago',
  'Millennium Park',
]

const DAY_ORDER = [
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
] as const

function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1)
}

function dateToDayKey(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()]
}

function resolvePlanDays(dates?: string[]): { days: string[]; dayDates: Record<string, string> } {
  if (!dates || dates.length === 0) {
    const weekend = getNextWeekendRange()
    return {
      days: ['saturday', 'sunday'],
      dayDates: { saturday: weekend.start, sunday: weekend.end },
    }
  }
  const sorted = [...dates].sort()
  const dayDates: Record<string, string> = {}
  for (const d of sorted) {
    dayDates[dateToDayKey(d)] = d
  }
  const days = (DAY_ORDER as readonly string[]).filter((d) => d in dayDates)
  return { days, dayDates }
}

function formatLocationStrategy(strategy?: WeekendLocationStrategy): string {
  switch (strategy || 'clustered') {
    case 'two_zones':
      return 'Two nearby zones: use at most two neighborhoods/areas and make the day a one-way progression between them.'
    case 'open':
      return 'Open route: longer travel is acceptable, but still avoid backtracking and keep meal stops near adjacent activities.'
    case 'clustered':
    default:
      return 'One neighborhood cluster: keep the day in one compact area. Choose meal stops within or immediately adjacent to that area.'
  }
}

function formatDiscoveryMode(mode?: WeekendDiscoveryMode): string {
  switch (mode || 'balanced') {
    case 'new_neighborhoods':
      return 'Discover new neighborhoods: prioritize fresh neighborhood-level venues and areas the user has not recently visited. Saved restaurants are optional backups, not the default.'
    case 'saved_favorites':
      return 'Saved favorites: prefer vetted saved restaurants and places, but only when they fit the day geography.'
    case 'balanced':
    default:
      return 'Balanced: mix one trusted saved place when it fits with fresh neighborhood-level discoveries.'
  }
}

/**
 * How the saved-restaurants block should be framed for a given discovery mode.
 * In "new neighborhoods" mode we still show the list (so the model can recognize a
 * place the user explicitly names) but make clear it must NOT be the default — this is
 * what keeps the planner from inserting a saved pick when the user asked for fresh
 * discovery near a specific anchor.
 */
function savedRestaurantsInstruction(mode?: WeekendDiscoveryMode): string {
  switch (mode || 'balanced') {
    case 'saved_favorites':
      return 'Prefer these for meal blocks. Pick the ones whose location fits the day geography, and use at least one when geography allows.'
    case 'new_neighborhoods':
      return 'Discovery mode is set to NEW neighborhoods — do NOT default to these. Use a saved place ONLY if the user explicitly named it, or if nothing fresh fits the day anchor. Otherwise leave them out and recommend new, specific spots near the anchor.'
    case 'balanced':
    default:
      return 'These are optional backups: use at most one, and only when it sits directly on the day route. Do not detour off the route to reach one.'
  }
}

/**
 * Build the "Saved Restaurants" context block. When the user names an anchor in their
 * notes, each saved place is annotated with its REAL straight-line distance from that
 * anchor, and (unless they're in saved-favorites mode) anything outside the transport
 * radius is dropped — this is what stops the model from presenting a saved café that's
 * actually 2+ miles away as "a few blocks south, right on the route".
 */
async function buildSavedRestaurantsContext(opts: {
  saved: SavedRestaurant[]
  discoveryMode?: WeekendDiscoveryMode
  transportMode: string
  anchorText: string
  header: string
  includeBookingBusy: boolean
}): Promise<string> {
  const list = opts.saved.slice(0, 20)
  if (list.length === 0) return ''

  let anchor: { label: string; lat: number; lng: number } | null = null
  if (opts.anchorText) {
    try {
      anchor = await geocodeAnchor(opts.anchorText)
    } catch {
      anchor = null
    }
  }

  const radius = anchorRadiusMiles(opts.transportMode)
  const mode = opts.discoveryMode || 'balanced'
  const dropFar = !!anchor && mode !== 'saved_favorites'

  const entries = list.map((r) => {
    const hasCoords = anchor && Math.abs(r.lat) > 0.0001 && Math.abs(r.lng) > 0.0001
    const miles = hasCoords ? haversineMiles(anchor!.lat, anchor!.lng, r.lat, r.lng) : null
    return { r, miles }
  })

  const shown = dropFar ? entries.filter((e) => e.miles == null || e.miles <= radius) : entries

  if (anchor && shown.length === 0) {
    return `## ${opts.header}\nNone of your saved places are within ~${radius} mi of ${anchor.label} (the day's anchor). Do NOT use a saved place — recommend fresh spots near the anchor instead.\n\n`
  }

  let out = `## ${opts.header}\n`
  for (const { r, miles } of shown) {
    const price = r.priceLevel ? priceLevelLabel(r.priceLevel) : ''
    const cuisine = r.cuisineCategory || r.cuisine || ''
    const notes = r.notes ? ` — ${r.notes}` : ''
    const dist =
      miles != null
        ? ` [~${miles.toFixed(1)} mi from ${anchor!.label}]`
        : anchor
          ? ` [distance from anchor unknown]`
          : ''
    out += `- **${r.name}** (${r.address})${price ? ` ${price}` : ''}${cuisine ? ` · ${cuisine}` : ''}${dist}${notes}\n`
    if (opts.includeBookingBusy) {
      const booking = formatBookingAdvance(r)
      const busy = formatBusyDays(r.busyDaysMatrix)
      if (booking) out += `  Booking: ${booking}\n`
      if (busy) out += `  Busy days: ${busy}\n`
    }
  }
  out += savedRestaurantsInstruction(mode)
  if (anchor) {
    out += ` Bracketed distances are the real straight-line distance from the day's anchor (${anchor.label}) — treat them as authoritative. NEVER describe a place as "close", "on the route", "a few blocks away", or "X min" if its bracketed distance contradicts that. If the user wants somewhere close to the anchor, only use a saved place within ~${radius} mi; otherwise recommend a fresh spot near the anchor.`
  }
  if (opts.includeBookingBusy) out += ' When a Booking lead time is listed, factor that into the rationale.'
  out += '\n\n'
  return out
}

/**
 * Geography constraints derived from how the user is actually getting around.
 * When driving is NOT one of the selected modes, hopping between distant areas is
 * either expensive (rideshare fares per hop) or slow and tiring (walking/transit),
 * so the day must stay tightly clustered. This intentionally OVERRIDES a loose
 * route-style preference (two_zones / open) when the two conflict.
 */
function transportGeographyRules(transportMode?: string): string {
  const m = (transportMode || 'driving').toLowerCase()
  const hasDriving = m.includes('driv') || m.includes('car')
  const hasRideshare =
    m.includes('ride') || m.includes('uber') || m.includes('lyft') || m.includes('taxi') || m.includes('cab')
  const hasTransit =
    m.includes('transit') || m.includes('train') || m.includes('bus') || m.includes('subway') ||
    m.includes('metro') || m.includes('cta') || m.includes('rail') || m.includes('"l"') || m.includes(' l ')
  const hasWalking = m.includes('walk') || m.includes('foot')
  const hasBiking = m.includes('bik') || m.includes('cycl')

  if (hasDriving) {
    return (
      '- Driving is available, so moderate travel between areas is acceptable — but still order all stops as ONE continuous route and never double back to an area you already left.'
    )
  }

  const lines: string[] = []
  lines.push(
    `- **Driving is NOT selected.** The user is getting around by ${transportMode}, so long or repeated hops between neighborhoods are ${
      hasRideshare ? 'expensive (every hop is another fare)' : 'slow and tiring'
    }. Treat tight clustering as a HARD constraint, not a soft preference — it overrides any route-style preference above if they conflict.`
  )
  if (hasWalking || hasBiking) {
    lines.push(
      `- Keep the ENTIRE day inside a single walkable${hasBiking ? '/bikeable' : ''} neighborhood. Every stop must be within roughly a 15-20 minute ${
        hasBiking ? 'bike ride' : 'walk'
      } of the one before it. Do not include any stop that realistically needs a car to reach.`
    )
  } else if (hasRideshare && !hasTransit) {
    lines.push(
      '- Minimize paid rides. Build the day around ONE compact area where stops are walkable from each other; use rideshare mainly to get to that area and back home, not to bounce between stops. Keep total rides to about 2-3 for the day.'
    )
  } else if (hasTransit) {
    lines.push(
      '- Keep the day to ONE neighborhood, or at most two areas joined by a single direct transit line (no multi-transfer trips). Cluster every stop near a transit stop on that line, in the order the line runs.'
    )
  } else {
    lines.push('- Keep the entire day in one compact area; every stop should be a short walk from the previous one.')
  }
  lines.push(
    '- Choose ONE neighborhood anchor first, then fit every activity AND meal inside it. If an appealing option falls outside the anchor, drop it rather than adding a trip out and back.'
  )
  return lines.join('\n')
}

export interface WeekendPlan {
  id: number
  weekend_date: string
  plan_json: string
  events_json: string
  ai_rationale: string | null
  created_at: string
}

export interface CachedWeekendEvent {
  event_key: string
  name: string
  event_date: string
  time: string
  venue: string
  address: string
  city: string
  type: string
  price_range: string
  url: string
  image_url: string | null
  description: string
  source: string
  query: string
  category: string
  saved_at: string
  updated_at: string
}

const WEEKEND_PLANNER_PROMPT = `You are a weekend activity planner for someone living in the Chicago area. You create fun, realistic weekend itineraries.

You will receive:
Transportation preference and extra planning notes may also be provided. Treat those as first-class constraints for this specific plan.
1. **Available events** — real events happening this weekend from Ticketmaster + curated Chicago spots
2. **Home location** — the user's neighborhood/address with commute context
3. **Sleep & energy data** — their current sleep debt and circadian energy levels
4. **Preferences** — any stated interests or constraints
5. **Themes** (optional) — agenda personalities to lean into
6. **Saved restaurants** (optional) — places the user has personally vetted and likes
7. **Recent picks to avoid** (optional) — places suggested in the last few weekends

8. **Geography strategy** (optional) - how tightly each day should be clustered
9. **Discovery mode** (optional) - whether to favor trusted saved places or fresh neighborhoods

Your job:
- Pick the best 4-8 activities for Saturday and Sunday combined
- Create a time-blocked itinerary for each day
- Factor in realistic travel times between locations (Chicago traffic, CTA, walking)
- Use the requested transportation mode when practical. If a leg needs a different mode, say so in the activity and agenda map.
- Account for the user's energy levels: if sleep debt is high, plan a more relaxed weekend
- Respect the user's wake-up times — don't schedule anything before they wake up. First activity should be 30-60 min after wake time.
- Respect budget constraints — if budget is "free", only suggest free activities
- Respect pace preference — "relaxed" means 2-3 activities/day with long breaks, "packed" means 5+ activities
- Suggest meal spots near activity locations (Chicago has amazing food — be specific with restaurant names)
- Include downtime — don't over-schedule
- Do NOT insert "return home to rest", "go home to recharge", or similar go-home-to-nap activities between outings. If energy is low, suggest lighter activities or longer breaks at a cafe instead. The only "Home" reference should be the start of the agendaMap route.
- Consider weather-appropriate activities (mention if outdoor plans need weather check)
- Mix types: don't do all museums or all outdoor — variety is good
- **Operating hours are critical.** Before scheduling any restaurant, café, store, or venue, verify it is likely open at that time. Most brunch spots open at 9-10 AM, many dinner restaurants don't open until 5 PM, retail shops are typically 10/11 AM–6/7 PM, and many places close earlier on Sundays or are closed Mondays. Never schedule a restaurant for a meal outside its plausible service hours. If you're unsure about hours, note it in the rationale (e.g. "confirm hours — some bakeries close by 3 PM").

**The user's explicit instructions for THIS plan override every default below:**
- If the user's "Extra Planning Comments" or "User Preferences" name a specific place, event, venue, or address to build the day around (e.g. "we're going to the Tide Festival at 851 W Irving Park"), treat THAT location as the day's fixed geographic anchor. Plan the entire day around it. Every other stop must sit within the travel range the user asked for (e.g. a short walk or one transit ride) of that anchor.
- When the user asks you to "find other things nearby", "search near X", or "look for attractions around here", that is an explicit request for FRESH discovery around the named anchor. Do NOT fall back on the home neighborhood, recently-used venues, or saved places unless they genuinely sit right next to the anchor. Name new, specific spots near the anchor instead.
- An explicit anchor and/or an explicit "find nearby / new" request override the home location, the saved-restaurant preference, the discovery default, AND any saved/recent context. The user's typed instruction is the highest-priority signal — honor it literally even if it contradicts everything else.

**Geography rules (critical — the user has explicitly complained about plans that hop back and forth):**
- Each day must have a clear geographic anchor. Prefer one neighborhood cluster for the whole day unless the user explicitly chooses a two-zone or open-route strategy.
- **Treat each day as a single continuous one-way path.** Before writing the schedule, list every candidate stop, group them by area, then order the day so you move through areas ONCE in a sensible geographic line (e.g. north→south or along a single corridor). Follow that order start to finish.
- **Never produce an A → B → A pattern.** Once you leave an area you may NOT return to it later the same day. If two stops are in the same area, schedule them back-to-back, not split by a trip elsewhere and back.
- No zig-zagging: do not send the user far for one stop (e.g. lunch) and then back near a previous area. Each leg should move forward along the route, not reverse it.
- Meal stops must be in the SAME area as the activity immediately before or after them. If a saved restaurant is far from the day's route, skip it or use it on a different day — do not detour for it.
- Honor the transport constraint in the "Geography Strategy" section below. When driving is not selected, the whole day should stay in one walkable/transit-friendly area regardless of any route-style preference.
- The agendaMap route must reflect this single-path clustering: list locations in travel order, with no repeated/returned-to areas, and (when driving) no more than two major neighborhood jumps in a day.

**Theme & freshness rules:**
- If "Themes" is provided, the itinerary MUST clearly reflect those themes. If multiple themes are picked, blend them; if none, pick a coherent personality on your own (don't default to museums + landmarks every time).
- Saved restaurants are governed by the **Discovery mode** section, not used by default. In "saved favorites" mode, prefer them for meals and use at least one when geography allows. In "balanced" mode, use at most one, and only when it sits directly on the day's route. In "new neighborhoods" mode, do NOT default to saved places — only use one if the user explicitly named it, or if nothing fresh fits; otherwise find new spots near the anchor. Never detour off the day's anchor to reach a saved place, and never use a saved place when the user explicitly asked for new/nearby discovery.
- If "Recent picks to avoid" is listed, do NOT suggest any of those activities or venues. Find fresh alternatives.
- If a saved restaurant has a "Booking" lead time (days), call it out in the activity's rationale when relevant — e.g. for a Saturday dinner pick with a 14-day booking window, note "book ASAP — typically requires ~14 days advance reservation". If booking lead time exceeds the time until the planned meal, flag it explicitly and suggest the user check availability or pick a backup.
- If a saved restaurant has "Busy days", prefer suggesting it on lower-busyness days when the user has flexibility. For Saturday dinner spots that are equally busy Fri/Sat, that's fine; for places listed as "Sun-Tue low, Fri-Sat very high", consider a Sunday brunch slot.
- If "Avoid touristy" is set, never suggest: Cloud Gate / The Bean, Navy Pier, Art Institute, Museum of Science & Industry, Architecture Boat Tour, Field Museum, Lincoln Park Zoo, Chicago Riverwalk, Willis Tower, 360 Chicago. Suggest neighborhood-level local spots instead — name specific bars, smaller galleries, ethnic-enclave restaurants, hidden parks, BYOB spots.
- Default lean: when in doubt, prefer specific neighborhood-level recommendations (Logan Square, Pilsen, West Loop, Avondale, Andersonville, Bridgeport, Humboldt Park, Uptown) over the obvious downtown checklist.

Output format:
- One section per day you are asked to plan (could be 2–5 days for long weekends / holidays)
- Each with time-blocked activities
- Format as a JSON object with a lowercase day-name key per day plus "agendaMap". Standard weekend: { "saturday": [...], "sunday": [...], "agendaMap": { "saturday": { "route": [...], "legs": [...] }, "sunday": { ... } } }. Long weekend example: { "friday": [...], "saturday": [...], "sunday": [...], "monday": [...], "agendaMap": { "friday": {...}, "saturday": {...}, "sunday": {...}, "monday": {...} } }
- Each activity: { "time": "HH:MM-HH:MM", "activity": "...", "location": "...", "transportation": "...", "travelTime": "...", "rationale": "...", "cost": "..." }
- The agendaMap powers a geographic map. Each day route should start at "Home" when home location is known, then list the day stops in order with precise venue names/addresses when possible. Each leg should be: { "from": "...", "to": "...", "transportation": "...", "travelTime": "...", "note": "..." }
- Wrap in a \`\`\`json code block
- Return only the JSON code block. Do not add notes outside the JSON.`

export interface WeekendParams {
  preferences?: string
  satWakeTime?: string // HH:MM
  sunWakeTime?: string // HH:MM
  energyLevel?: 'low' | 'medium' | 'high'
  budget?: 'free' | 'low' | 'medium' | 'high'
  pace?: 'relaxed' | 'moderate' | 'packed'
  themes?: WeekendTheme[]
  savedRestaurantIds?: number[] // subset to seed; undefined/empty = use all saved
  avoidTouristy?: boolean
  transportationMode?: string
  locationStrategy?: WeekendLocationStrategy
  discoveryMode?: WeekendDiscoveryMode
  extraDetails?: string
  dates?: string[] // specific dates to plan (YYYY-MM-DD), defaults to upcoming sat+sun
  wakeTimes?: Record<string, string> // wake time per day key, e.g. { saturday: '09:00', monday: '10:00' }
  perDay?: Record<string, {
    extraDetails?: string
    energyLevel?: 'low' | 'medium' | 'high'
    budget?: 'free' | 'low' | 'medium' | 'high'
    pace?: 'relaxed' | 'moderate' | 'packed'
    themes?: WeekendTheme[]
    transportationMode?: string
    locationStrategy?: WeekendLocationStrategy
    discoveryMode?: WeekendDiscoveryMode
    savedRestaurantIds?: number[]
  }>
}

/**
 * Generate the plan for a single day. Merges into any existing plan for the same weekend.
 */
export async function generateWeekendPlanForDay(
  day: string,
  paramsOrPrefs?: string | WeekendParams,
): Promise<string> {
  const params: WeekendParams =
    typeof paramsOrPrefs === 'string' ? { preferences: paramsOrPrefs } : paramsOrPrefs || {}

  // Force dates to only include the one day we're generating
  const { dayDates } = resolvePlanDays(params.dates)
  const targetDate = dayDates[day]
  if (!targetDate) throw new Error(`Day "${day}" not found in selected dates`)

  // Build single-day params, applying per-day overrides
  const dayOverrides = params.perDay?.[day]
  const singleDayParams: WeekendParams = {
    ...params,
    dates: [targetDate],
    wakeTimes: params.wakeTimes ? { [day]: params.wakeTimes[day] || '09:00' } : undefined,
    ...(dayOverrides?.energyLevel && { energyLevel: dayOverrides.energyLevel }),
    ...(dayOverrides?.budget && { budget: dayOverrides.budget }),
    ...(dayOverrides?.pace && { pace: dayOverrides.pace }),
    ...(dayOverrides?.themes && { themes: dayOverrides.themes }),
    ...(dayOverrides?.transportationMode && { transportationMode: dayOverrides.transportationMode }),
    ...(dayOverrides?.locationStrategy && { locationStrategy: dayOverrides.locationStrategy }),
    ...(dayOverrides?.discoveryMode && { discoveryMode: dayOverrides.discoveryMode }),
    ...(dayOverrides?.savedRestaurantIds && { savedRestaurantIds: dayOverrides.savedRestaurantIds }),
    ...(dayOverrides?.extraDetails && { extraDetails: dayOverrides.extraDetails }),
  }

  const db = getDb()
  const settings = getAppSettings()
  const { dayDates: singleDayDates } = resolvePlanDays([targetDate])
  const weekendDate = dayDates.saturday || Object.values(dayDates).sort()[0]

  const themes = singleDayParams.themes || []
  const avoidTouristy = singleDayParams.avoidTouristy ?? themes.includes('hidden_gems')
  const recentToAvoid = getRecentlySuggestedNames(weekendDate, 3)

  const [ticketmasterEvents, curatedSpotsRaw] = await Promise.all([
    fetchTicketmasterEvents({ startDate: targetDate, endDate: targetDate }),
    Promise.resolve(getCuratedChicagoSpots()),
  ])

  const curatedSpots = curatedSpotsRaw.filter((spot) => {
    if (
      avoidTouristy &&
      TOURISTY_BLACKLIST.some((t) => spot.name.toLowerCase().includes(t.toLowerCase()))
    )
      return false
    if (recentToAvoid.some((name) => spot.name.toLowerCase() === name.toLowerCase()))
      return false
    return true
  })

  const allEvents = dedupeLocalEvents([...ticketmasterEvents, ...curatedSpots])

  // Build context (same as generateWeekendPlan but for one day)
  let context = ''
  const homeLocation = settings?.homeLocation || ''
  const homeNeighborhood = settings?.homeNeighborhood || ''
  const commuteNotes = settings?.commuteNotes || ''
  const transportMode = singleDayParams.transportationMode || settings?.transportMode || 'driving'

  if (homeLocation || homeNeighborhood) {
    context += `## Home Location\n`
    if (homeNeighborhood) context += `- Neighborhood: ${homeNeighborhood}\n`
    if (homeLocation) context += `- Address: ${homeLocation}\n`
    if (commuteNotes) context += `- Commute notes: ${commuteNotes}\n`
    context += `- Primary transport: ${transportMode}\n\n`
  } else {
    context += `## Home Location\n- Not specified. Assume general Chicago suburbs, ~30 min to downtown.\n\n`
  }

  try {
    context += formatWeatherForPlanner(
      await getPlannerWeatherPreview({
        dates: [targetDate],
        location: settings?.weekendCity || homeNeighborhood || homeLocation || undefined,
      }),
    )
  } catch {
    context += `## Weather Preview\n- Weather preview unavailable. Do not assume outdoor conditions.\n\n`
  }

  if (allEvents.length > 0) {
    context += `## Available Events & Activities (${targetDate})\n\n`
    const byType = new Map<string, LocalEvent[]>()
    for (const ev of allEvents) {
      const existing = byType.get(ev.type) || []
      existing.push(ev)
      byType.set(ev.type, existing)
    }
    for (const [type, events] of byType) {
      context += `### ${type.charAt(0).toUpperCase() + type.slice(1)}\n`
      for (const ev of events.slice(0, 8)) {
        context += `- **${ev.name}** | ${ev.date} ${ev.time} | ${ev.venue}, ${ev.address} | ${ev.priceRange}`
        if (ev.description) context += ` | ${ev.description.substring(0, 100)}`
        context += '\n'
      }
      context += '\n'
    }
  }

  try {
    const sleepContext = buildSleepAnalysisContext()
    if (sleepContext && !sleepContext.includes('No sleep data')) {
      context += sleepContext + '\n\n'
    }
  } catch {}

  const wakeTime = singleDayParams.wakeTimes?.[day]
  if (wakeTime || singleDayParams.energyLevel || singleDayParams.budget || singleDayParams.pace) {
    context += `## Parameters\n`
    if (wakeTime) context += `- ${dayLabel(day)} wake-up time: ${wakeTime}\n`
    if (singleDayParams.energyLevel)
      context += `- Energy level: ${singleDayParams.energyLevel}\n`
    if (singleDayParams.budget) context += `- Budget: ${singleDayParams.budget}\n`
    if (singleDayParams.pace) context += `- Pace: ${singleDayParams.pace}\n`
    context += '\n'
  }

  if (transportMode) {
    context += `## Transportation Preference\n- Preferred mode: ${transportMode}\n\n`
  }

  context += `## Geography Strategy\n- ${formatLocationStrategy(singleDayParams.locationStrategy)}\n`
  context += `${transportGeographyRules(transportMode)}\n`
  context += `- Before choosing lunch/dinner, first choose the day's neighborhood anchor and keep food near that route. Order all stops as one continuous path and never return to an area you already left.\n\n`

  context += `## Discovery Mode\n- ${formatDiscoveryMode(singleDayParams.discoveryMode)}\n\n`

  if (singleDayParams.extraDetails?.trim()) {
    context += `## Extra Planning Comments From User\n${singleDayParams.extraDetails.trim()}\n\n`
  }

  if (themes.length > 0) {
    context += `## Themes\n`
    for (const t of themes) {
      const guidance = THEME_GUIDANCE[t]
      if (guidance) context += `- **${t.replace('_', ' ')}**: ${guidance}\n`
    }
    context += '\n'
  }

  if (avoidTouristy) {
    context += `## Avoid Touristy\nDo NOT suggest the standard Chicago tourist checklist. Suggest neighborhood-level local picks.\n\n`
  }

  try {
    const allSaved = getSavedRestaurants()
    const wanted =
      singleDayParams.savedRestaurantIds && singleDayParams.savedRestaurantIds.length > 0
        ? allSaved.filter((r) => singleDayParams.savedRestaurantIds!.includes(r.id))
        : allSaved
    const anchorText = extractAnchorQuery(
      [singleDayParams.extraDetails, singleDayParams.preferences].filter(Boolean).join(' '),
    )
    context += await buildSavedRestaurantsContext({
      saved: wanted,
      discoveryMode: singleDayParams.discoveryMode,
      transportMode: transportMode,
      anchorText,
      header: 'Saved Restaurants',
      includeBookingBusy: false,
    })
  } catch {}

  if (recentToAvoid.length > 0) {
    context += `## Recent Picks to Avoid\n`
    for (const name of recentToAvoid.slice(0, 30)) {
      context += `- ${name}\n`
    }
    context += '\n'
  }

  if (singleDayParams.preferences) {
    context += `## User Preferences\n${singleDayParams.preferences}\n\n`
  }

  const interests = settings?.weekendInterests || ''
  if (interests) context += `## Interests\n${interests}\n\n`

  // Also include existing plan for other days so the AI can avoid duplicates
  const existingRow = db
    .prepare('SELECT plan_json FROM weekend_plans WHERE weekend_date = ? AND deleted_at IS NULL')
    .get(weekendDate) as { plan_json: string } | undefined
  if (existingRow) {
    try {
      const existingPlan = JSON.parse(existingRow.plan_json)
      const otherDays = (DAY_ORDER as readonly string[]).filter(
        (d) => d !== day && Array.isArray(existingPlan[d]) && existingPlan[d].length > 0,
      )
      if (otherDays.length > 0) {
        context += `## Already Planned Days (avoid duplicating these activities)\n`
        for (const d of otherDays) {
          context += `### ${dayLabel(d)}\n`
          for (const act of existingPlan[d]) {
            context += `- ${act.time}: ${act.activity} @ ${act.location}\n`
          }
        }
        context += '\n'
      }
    } catch {}
  }

  const userPrompt = `Plan for: ${dayLabel(day)} (${targetDate}).

${context}

Generate the itinerary as a complete JSON object with key "${day}" and "agendaMap". Include travel times from my home and between activities. Return only the JSON code block.`

  const response = await generateAnalysisStreaming(
    WEEKEND_PLANNER_PROMPT,
    userPrompt,
    { maxTokens: 4000 },
    'weekend-planner:single-day',
  )

  const parsedPlan = parseAiJson<Record<string, unknown>>(response, { dayKeys: [day] })
  const planJson = parsedPlan.json

  // Merge into existing plan
  const dayPlan = parsedPlan.value
  let mergedPlan: any = {}

  if (existingRow) {
    try {
      mergedPlan = JSON.parse(existingRow.plan_json)
    } catch {}
  }

  // Set the day's activities
  mergedPlan[day] = dayPlan[day] || []
  // Merge agendaMap
  if (!mergedPlan.agendaMap) mergedPlan.agendaMap = {}
  const dayPlanAgendaMap = dayPlan.agendaMap as Record<string, unknown> | undefined
  if (dayPlanAgendaMap?.[day]) {
    mergedPlan.agendaMap[day] = dayPlanAgendaMap[day]
  }

  const mergedJson = JSON.stringify(mergedPlan)

  // Upsert into DB
  db.prepare(
    `INSERT INTO weekend_plans (weekend_date, plan_json, events_json, ai_rationale, updated_at, deleted_at)
    VALUES (?, ?, ?, NULL, datetime('now'), NULL)
    ON CONFLICT(weekend_date) DO UPDATE SET
      plan_json = excluded.plan_json,
      events_json = excluded.events_json,
      updated_at = excluded.updated_at,
      deleted_at = NULL`,
  ).run(weekendDate, mergedJson, JSON.stringify(allEvents.slice(0, 30)))

  return mergedJson
}

export async function generateWeekendPlan(paramsOrPrefs?: string | WeekendParams): Promise<string> {
  // Support both old string API and new params object
  const params: WeekendParams =
    typeof paramsOrPrefs === 'string' ? { preferences: paramsOrPrefs } : paramsOrPrefs || {}
  const db = getDb()
  const settings = getAppSettings()
  const weekend = getNextWeekendRange()
  const { days: planDays, dayDates } = resolvePlanDays(params.dates)
  const sortedDates = Object.values(dayDates).sort()
  const dateRange = { start: sortedDates[0], end: sortedDates[sortedDates.length - 1] }
  const weekendDate = dayDates.saturday || dateRange.start

  const themes = params.themes || []
  const avoidTouristy = params.avoidTouristy ?? themes.includes('hidden_gems')

  // Recent activities to avoid: last 3 weekend plans before the current one.
  const recentToAvoid = getRecentlySuggestedNames(weekendDate, 3)

  // Fetch events
  const [ticketmasterEvents, curatedSpotsRaw] = await Promise.all([
    fetchTicketmasterEvents({ startDate: dateRange.start, endDate: dateRange.end }),
    Promise.resolve(getCuratedChicagoSpots()),
  ])

  // Filter the curated fallback list: drop touristy spots when the user picked
  // hidden_gems / avoidTouristy, and drop anything that appeared in the last 3 weekends.
  const curatedSpots = curatedSpotsRaw.filter((spot) => {
    if (
      avoidTouristy &&
      TOURISTY_BLACKLIST.some((t) => spot.name.toLowerCase().includes(t.toLowerCase()))
    ) {
      return false
    }
    if (recentToAvoid.some((name) => spot.name.toLowerCase() === name.toLowerCase())) {
      return false
    }
    return true
  })

  const allEvents = dedupeLocalEvents([...ticketmasterEvents, ...curatedSpots])

  // Build context
  let context = ''

  // Home location context
  const homeLocation = settings?.homeLocation || ''
  const homeNeighborhood = settings?.homeNeighborhood || ''
  const commuteNotes = settings?.commuteNotes || ''
  const transportMode = params.transportationMode || settings?.transportMode || 'driving'

  if (homeLocation || homeNeighborhood) {
    context += `## Home Location\n`
    if (homeNeighborhood) context += `- Neighborhood: ${homeNeighborhood}\n`
    if (homeLocation) context += `- Address: ${homeLocation}\n`
    if (commuteNotes) context += `- Commute notes: ${commuteNotes}\n`
    context += `- Primary transport: ${transportMode}\n\n`
  } else {
    context += `## Home Location\n- Not specified. Assume general Chicago suburbs, ~30 min to downtown.\n\n`
  }

  try {
    context += formatWeatherForPlanner(
      await getPlannerWeatherPreview({
        dates: Object.values(dayDates),
        location: settings?.weekendCity || homeNeighborhood || homeLocation || undefined,
      }),
    )
  } catch {
    context += `## Weather Preview\n- Weather preview unavailable. Do not assume outdoor conditions.\n\n`
  }

  // Events
  if (allEvents.length > 0) {
    context += `## Available Events & Activities (${dateRange.start} to ${dateRange.end})\n\n`

    // Group by type
    const byType = new Map<string, LocalEvent[]>()
    for (const ev of allEvents) {
      const existing = byType.get(ev.type) || []
      existing.push(ev)
      byType.set(ev.type, existing)
    }

    for (const [type, events] of byType) {
      context += `### ${type.charAt(0).toUpperCase() + type.slice(1)}\n`
      for (const ev of events.slice(0, 8)) {
        context += `- **${ev.name}** | ${ev.date} ${ev.time} | ${ev.venue}, ${ev.address} | ${ev.priceRange}`
        if (ev.description) context += ` | ${ev.description.substring(0, 100)}`
        context += '\n'
      }
      context += '\n'
    }
  } else {
    context += `## Events\n- No events data available. Suggest popular Chicago weekend activities based on season.\n\n`
  }

  // Sleep & energy
  try {
    const sleepContext = buildSleepAnalysisContext()
    if (sleepContext && !sleepContext.includes('No sleep data')) {
      context += sleepContext + '\n\n'
    }
  } catch {}

  // Adjustable parameters
  const hasWakeTimes = params.wakeTimes && Object.keys(params.wakeTimes).length > 0
  if (
    hasWakeTimes ||
    params.satWakeTime ||
    params.sunWakeTime ||
    params.energyLevel ||
    params.budget ||
    params.pace
  ) {
    context += `## Weekend Parameters\n`
    if (hasWakeTimes) {
      for (const day of planDays) {
        const wt = params.wakeTimes![day]
        if (wt) context += `- ${dayLabel(day)} wake-up time: ${wt}\n`
      }
    } else {
      if (params.satWakeTime) context += `- Saturday wake-up time: ${params.satWakeTime}\n`
      if (params.sunWakeTime) context += `- Sunday wake-up time: ${params.sunWakeTime}\n`
    }
    if (params.energyLevel)
      context += `- Energy level: ${params.energyLevel} (plan activity intensity accordingly)\n`
    if (params.budget) {
      const budgetDesc: Record<string, string> = {
        free: 'Free activities only',
        low: 'Budget-friendly ($0-30 per activity)',
        medium: 'Moderate budget ($30-80 per activity)',
        high: 'No budget constraints',
      }
      context += `- Budget: ${budgetDesc[params.budget] || params.budget}\n`
    }
    if (params.pace) {
      const paceDesc: Record<string, string> = {
        relaxed: 'Relaxed pace — fewer activities, more downtime and buffer between events',
        moderate: 'Moderate pace — balanced mix of activities and rest',
        packed: 'Packed schedule — maximize activities, minimal downtime',
      }
      context += `- Pace: ${paceDesc[params.pace] || params.pace}\n`
    }
    context += '\n'
  }

  if (transportMode) {
    context += `## Transportation Preference\n`
    context += `- Preferred mode: ${transportMode}\n`
    context += `Use this as the default for route planning. If walking, transit, rideshare, biking, or driving is materially better for a specific leg, note the switch and why.\n\n`
  }

  context += `## Geography Strategy\n`
  context += `- ${formatLocationStrategy(params.locationStrategy)}\n`
  context += `${transportGeographyRules(transportMode)}\n`
  context += `- Before choosing lunch/dinner, first choose each day's neighborhood anchor and keep food near that route. Order all stops as one continuous path and never return to an area you already left.\n\n`

  context += `## Discovery Mode\n`
  context += `- ${formatDiscoveryMode(params.discoveryMode)}\n\n`

  if (params.extraDetails?.trim()) {
    context += `## Extra Planning Comments From User\n${params.extraDetails.trim()}\n\n`
  }

  // Per-day overrides
  if (params.perDay) {
    const budgetDesc: Record<string, string> = {
      free: 'Free activities only',
      low: 'Budget-friendly ($0-30 per activity)',
      medium: 'Moderate budget ($30-80 per activity)',
      high: 'No budget constraints',
    }
    const paceDesc: Record<string, string> = {
      relaxed: 'Relaxed pace — fewer activities, more downtime',
      moderate: 'Moderate pace — balanced mix',
      packed: 'Packed schedule — maximize activities',
    }
    for (const day of planDays) {
      const dayOv = params.perDay[day]
      if (!dayOv) continue
      const parts: string[] = []
      if (dayOv.energyLevel) parts.push(`Energy: ${dayOv.energyLevel}`)
      if (dayOv.budget) parts.push(`Budget: ${budgetDesc[dayOv.budget] || dayOv.budget}`)
      if (dayOv.pace) parts.push(`Pace: ${paceDesc[dayOv.pace] || dayOv.pace}`)
      if (dayOv.transportationMode) {
        parts.push(`Transport: ${dayOv.transportationMode}`)
        parts.push(transportGeographyRules(dayOv.transportationMode).replace(/^- /gm, '').replace(/\n/g, ' '))
      }
      if (dayOv.locationStrategy) parts.push(`Geography: ${formatLocationStrategy(dayOv.locationStrategy)}`)
      if (dayOv.discoveryMode) parts.push(`Discovery: ${formatDiscoveryMode(dayOv.discoveryMode)}`)
      if (dayOv.themes && dayOv.themes.length > 0) parts.push(`Themes: ${dayOv.themes.join(', ')}`)
      if (dayOv.extraDetails?.trim()) parts.push(`Notes: ${dayOv.extraDetails.trim()}`)
      if (parts.length > 0) {
        context += `## ${dayLabel(day)}-Specific Overrides\n`
        for (const p of parts) context += `- ${p}\n`
        context += `These override the global defaults for ${dayLabel(day)} only.\n\n`
      }
    }
  }

  // Themes
  if (themes.length > 0) {
    context += `## Themes (lean the itinerary into these personalities)\n`
    for (const t of themes) {
      const guidance = THEME_GUIDANCE[t]
      if (guidance) context += `- **${t.replace('_', ' ')}**: ${guidance}\n`
    }
    context += '\n'
  }

  if (avoidTouristy) {
    context += `## Avoid Touristy\nDo NOT suggest the standard Chicago tourist checklist (Cloud Gate, Navy Pier, Art Institute, Museum of Science & Industry, Architecture Boat Tour, Field Museum, Lincoln Park Zoo, Riverwalk, Willis Tower, 360 Chicago). Suggest neighborhood-level local picks with specific venue names.\n\n`
  }

  // Saved restaurants — let the AI prefer the user's vetted picks for meals
  try {
    const allSaved = getSavedRestaurants()
    const wanted =
      params.savedRestaurantIds && params.savedRestaurantIds.length > 0
        ? allSaved.filter((r) => params.savedRestaurantIds!.includes(r.id))
        : allSaved
    const anchorText = extractAnchorQuery(
      [params.extraDetails, params.preferences].filter(Boolean).join(' '),
    )
    context += await buildSavedRestaurantsContext({
      saved: wanted,
      discoveryMode: params.discoveryMode,
      transportMode: transportMode,
      anchorText,
      header: 'Saved Restaurants the User Has Vetted',
      includeBookingBusy: true,
    })
  } catch {}

  // Recent activities to avoid (from prior weekend plans)
  if (recentToAvoid.length > 0) {
    context += `## Recent Picks to Avoid\nThese were suggested in the last 3 weekends — pick something different this time:\n`
    for (const name of recentToAvoid.slice(0, 30)) {
      context += `- ${name}\n`
    }
    context += '\n'
  }

  // User preferences
  if (params.preferences) {
    context += `## User Preferences\n${params.preferences}\n\n`
  }

  // Weekend interests from settings
  const interests = settings?.weekendInterests || ''
  if (interests) {
    context += `## Interests\n${interests}\n\n`
  }

  const daysList = planDays.map((d) => `${dayLabel(d)} (${dayDates[d]})`).join(', ')
  const dayKeys = planDays.map((d) => `"${d}"`).join(', ')
  const userPrompt = `Plan for these days: ${daysList}.

${context}

Generate my itinerary as a complete JSON object with keys ${dayKeys} and "agendaMap". Include travel times from my home and between activities. Return only the JSON code block.`

  const response = await generateAnalysisStreaming(
    WEEKEND_PLANNER_PROMPT,
    userPrompt,
    { maxTokens: 12000 },
    'weekend-planner',
  )

  let planJson = response
  let rationale: string | null = null
  let parsed = false

  try {
    const parsedPlan = parseAiJson<Record<string, unknown>>(response, { dayKeys: DAY_ORDER })
    planJson = parsedPlan.json
    rationale = parsedPlan.recoveredFromTruncation
      ? 'Note: AI response was truncated. Some activities may be missing.'
      : parsedPlan.rationale
    parsed = true
    if (parsedPlan.recoveredFromTruncation) {
      const totalActs = DAY_ORDER.reduce(
        (sum, dayKey) => sum + (Array.isArray(parsedPlan.value[dayKey]) ? parsedPlan.value[dayKey].length : 0),
        0,
      )
      console.warn('[weekend-planner] Recovered truncated response with', totalActs, 'activities')
    }
  } catch {}

  // Fallback: stuff raw response into a viewable format
  if (!parsed) {
    console.error('[weekend-planner] Failed to parse JSON from response, length:', response.length)
    console.error('[weekend-planner] First 500 chars:', response.slice(0, 500))
    planJson = JSON.stringify({
      saturday: [
        {
          time: 'N/A',
          activity: 'Plan generation failed — see notes',
          location: '',
          travelTime: '',
          rationale: 'The AI response could not be parsed. Try regenerating the plan.',
          cost: '',
        },
      ],
      sunday: [],
    })
    rationale = response
  }

  // Store
  db.prepare(
    `
    INSERT INTO weekend_plans (weekend_date, plan_json, events_json, ai_rationale, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, datetime('now'), NULL)
    ON CONFLICT(weekend_date) DO UPDATE SET
      plan_json = excluded.plan_json,
      events_json = excluded.events_json,
      ai_rationale = excluded.ai_rationale,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `,
  ).run(weekendDate, planJson, JSON.stringify(allEvents.slice(0, 30)), rationale)

  return planJson
}

const STRICT_TWEAK_SYSTEM_PROMPT = `You are a weekend plan editor. The user has an existing weekend itinerary JSON and wants specific changes.

Rules:
- Apply ONLY the requested tweak.
- Preserve unchanged activities exactly, including times, names, locations, rationale, transportation, travelTime, and cost.
- Return a complete JSON object, not a partial patch.
- Keep the top-level shape: one array per day (e.g. "saturday", "sunday", plus any extra days like "friday", "monday") and an "agendaMap" with a route/legs entry per day. Preserve all days from the original plan.
- Each activity must include string fields: "time", "activity", "location", "transportation", "travelTime", "rationale", "cost".
- The agendaMap route for each day must start with "Home" when the original route did, then list that day's activity locations in order.
- Each agendaMap leg must connect adjacent route stops.
- Do NOT insert "return home to rest", "go home to recharge", or similar go-home-to-nap activities between outings. If energy is low, suggest lighter activities or longer breaks at a cafe instead.
- Do not include Markdown, comments, or notes outside the JSON.`

export async function tweakWeekendPlan(weekendDate: string, instruction: string, day?: string): Promise<string> {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM weekend_plans WHERE weekend_date = ? AND deleted_at IS NULL')
    .get(weekendDate) as WeekendPlan | null
  if (!row) throw new Error('No plan found for ' + weekendDate)

  // If tweaking a single day, extract only that day's data to send to the AI
  let planForAi = row.plan_json
  let fullPlan: Record<string, unknown> | null = null
  if (day) {
    try {
      fullPlan = JSON.parse(row.plan_json)
      const dayActivities = (fullPlan as Record<string, unknown>)[day]
      if (!dayActivities) throw new Error(`Day "${day}" not found in plan`)
      const agendaMap = (fullPlan as Record<string, unknown>).agendaMap as Record<string, unknown> | undefined
      const dayAgenda = agendaMap?.[day]
      const subset: Record<string, unknown> = { [day]: dayActivities }
      if (dayAgenda) subset.agendaMap = { [day]: dayAgenda }
      planForAi = JSON.stringify(subset, null, 2)
    } catch (e) {
      if ((e as Error).message.includes('not found in plan')) throw e
      // If parse fails, fall through to full plan
      fullPlan = null
    }
  }

  // Include saved places so the AI can reference them
  let savedContext = ''
  try {
    const allSaved = getSavedRestaurants()
    if (allSaved.length > 0) {
      savedContext = `\n\n## Saved Places (prefer these when adding/swapping activities)\n`
      for (const r of allSaved.slice(0, 30)) {
        const price = r.priceLevel ? priceLevelLabel(r.priceLevel) : ''
        const cuisine = r.cuisineCategory || r.cuisine || ''
        const type = r.venueType || 'restaurant'
        savedContext += `- **${r.name}** (${r.address || 'no address'}) [${type}]${price ? ` ${price}` : ''}${cuisine ? ` · ${cuisine}` : ''}${r.description ? ` — ${r.description}` : ''}\n`
      }
      savedContext += `\nWhen adding meals, dessert stops, coffee, or activities, pick from this list when a saved place is nearby the day's route. Use the address to judge proximity.\n`
    }
  } catch {}

  const settings = getAppSettings()
  const homeLocation = settings?.homeLocation || ''

  const dayNote = day ? ` You are editing ONLY ${dayLabel(day)}. Return only the ${day} array and its agendaMap entry.` : ''
  const userPrompt = `Here is the current weekend plan${day ? ` (${dayLabel(day)} only)` : ''}:

\`\`\`json
${planForAi}
\`\`\`
${savedContext}
${homeLocation ? `Home location: ${homeLocation}\n` : ''}
The user wants these changes: "${instruction}"${dayNote}

Apply the requested changes and return only the full modified plan JSON. Preserve all day keys from the original and keep the same format. Each activity: { "time", "activity", "location", "transportation", "travelTime", "rationale", "cost" }. Update agendaMap routes/legs to match any location changes.`

  const response = await generateAnalysisStreaming(
    STRICT_TWEAK_SYSTEM_PROMPT,
    userPrompt,
    { maxTokens: 8192 },
    'weekend-planner:tweak',
  )

  const parsedPlan = parseAiJson<Record<string, unknown>>(response, { dayKeys: DAY_ORDER })
  let planJson = parsedPlan.json
  const rationale = parsedPlan.rationale

  // If we tweaked a single day, merge back into the full plan
  if (day && fullPlan) {
    const tweaked = JSON.parse(planJson)
    ;(fullPlan as Record<string, unknown>)[day] = tweaked[day] || (fullPlan as Record<string, unknown>)[day]
    const tweakedAgenda = (tweaked.agendaMap as Record<string, unknown>)?.[day]
    if (tweakedAgenda) {
      const am = ((fullPlan as Record<string, unknown>).agendaMap || {}) as Record<string, unknown>
      am[day] = tweakedAgenda
      ;(fullPlan as Record<string, unknown>).agendaMap = am
    }
    planJson = JSON.stringify(fullPlan)
  }

  planJson = normalizeWeekendPlanJson(planJson, row.plan_json)

  // Update stored plan
  db.prepare(
    "UPDATE weekend_plans SET plan_json = ?, ai_rationale = ?, updated_at = datetime('now'), deleted_at = NULL WHERE weekend_date = ?",
  ).run(planJson, rationale || row.ai_rationale, weekendDate)

  return planJson
}

function normalizeWeekendPlanJson(planJson: string, previousPlanJson?: string): string {
  const parsed = JSON.parse(planJson)
  const previous = previousPlanJson ? safeParseWeekendPlan(previousPlanJson) : null
  const days = (DAY_ORDER as readonly string[]).filter((d) => Array.isArray(parsed[d]))

  const result: Record<string, any> = {}
  const agendaMap: Record<string, any> = {}
  for (const day of days) {
    result[day] = normalizeWeekendActivities(parsed[day], previous?.[day] || [])
    const prevStartsAtHome = previous?.agendaMap?.[day]?.route?.[0]?.toLowerCase?.() === 'home'
    agendaMap[day] = normalizeAgendaMapDay(parsed.agendaMap?.[day], result[day], prevStartsAtHome)
  }
  result.agendaMap = agendaMap

  return JSON.stringify(result)
}

function safeParseWeekendPlan(planJson: string): any | null {
  try {
    return JSON.parse(planJson)
  } catch {
    return null
  }
}

function normalizeWeekendActivities(value: unknown, fallback: any[]): any[] {
  const items = Array.isArray(value) ? value : fallback
  return items
    .map((item: any, index) => {
      const fallbackItem = fallback[index] || {}
      return {
        time: stringOrFallback(item?.time, fallbackItem.time),
        activity: stringOrFallback(item?.activity, fallbackItem.activity),
        location: stringOrFallback(item?.location, fallbackItem.location),
        transportation: stringOrFallback(item?.transportation, fallbackItem.transportation),
        travelTime: stringOrFallback(item?.travelTime, fallbackItem.travelTime),
        rationale: stringOrFallback(item?.rationale, fallbackItem.rationale),
        cost: stringOrFallback(item?.cost, fallbackItem.cost),
      }
    })
    .filter((activity) => activity.activity || activity.location)
}

function normalizeAgendaMapDay(
  dayMap: any,
  activities: any[],
  startsAtHome: boolean,
): { route: string[]; legs: any[] } {
  const routeFromActivities = activities
    .map((activity) => activity.location || activity.activity)
    .filter((stop): stop is string => Boolean(stop?.trim()))
  const rawRoute =
    Array.isArray(dayMap?.route) && dayMap.route.length > 0
      ? dayMap.route.map((stop: unknown) => String(stop || '').trim()).filter(Boolean)
      : routeFromActivities
  const route = dedupeRoute(
    startsAtHome && rawRoute[0]?.toLowerCase() !== 'home' ? ['Home', ...rawRoute] : rawRoute,
  )
  const legs = route.slice(1).map((to, index) => {
    const existing = Array.isArray(dayMap?.legs) ? dayMap.legs[index] : null
    const activity = activities[Math.min(index, activities.length - 1)] || {}
    return {
      from: route[index],
      to,
      transportation: stringOrFallback(existing?.transportation, activity.transportation),
      travelTime: stringOrFallback(existing?.travelTime, activity.travelTime),
      note: stringOrFallback(existing?.note, activity.rationale),
    }
  })
  return { route, legs }
}

function dedupeRoute(route: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const stop of route) {
    const key = stop.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(stop)
  }
  return result
}

function stringOrFallback(value: unknown, fallback: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return typeof fallback === 'string' ? fallback : ''
  return String(value)
}

export function getWeekendPlan(weekendDate?: string): WeekendPlan | null {
  const db = getDb()
  if (weekendDate) {
    return db
      .prepare('SELECT * FROM weekend_plans WHERE weekend_date = ? AND deleted_at IS NULL')
      .get(weekendDate) as WeekendPlan | null
  }
  // Get latest / current weekend
  const weekend = getNextWeekendRange()
  return (
    (db
      .prepare('SELECT * FROM weekend_plans WHERE weekend_date = ? AND deleted_at IS NULL')
      .get(weekend.start) as WeekendPlan | null) ||
    (db
      .prepare(
        'SELECT * FROM weekend_plans WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get() as WeekendPlan | null)
  )
}

export function getAllWeekendPlans(limit = 20): WeekendPlan[] {
  return getDb()
    .prepare(
      `SELECT id, weekend_date, plan_json, events_json, ai_rationale, created_at
     FROM weekend_plans WHERE deleted_at IS NULL ORDER BY weekend_date DESC LIMIT ?`,
    )
    .all(limit) as WeekendPlan[]
}

export function updateWeekendPlan(weekendDate: string, planJson: string): WeekendPlan | null {
  if (!weekendDate || !planJson) throw new Error('Missing weekend date or plan JSON')

  try {
    JSON.parse(planJson)
  } catch {
    throw new Error('Invalid weekend plan JSON')
  }

  const db = getDb()
  db.prepare(
    `
    UPDATE weekend_plans
    SET plan_json = ?,
        updated_at = datetime('now'),
        deleted_at = NULL
    WHERE weekend_date = ?
  `,
  ).run(planJson, weekendDate)

  return getWeekendPlan(weekendDate)
}

export async function fetchWeekendEvents(): Promise<LocalEvent[]> {
  const [ticketmaster, curated] = await Promise.all([
    fetchTicketmasterEvents(),
    Promise.resolve(getCuratedChicagoSpots()),
  ])
  return dedupeLocalEvents([...ticketmaster, ...curated])
}

export async function searchWeekendEvents(opts?: {
  keyword?: string
  date?: string
  category?: string
  page?: number
}): Promise<EventSearchResult> {
  const result = await searchTicketmasterEvents(opts || {})
  saveWeekendEventSearchResults(result.events, {
    source: 'ticketmaster',
    query: opts?.keyword || '',
    category: opts?.category || 'all',
  })
  return result
}

export async function webSearchEvents(
  query: string,
  date?: string,
): Promise<{
  events: Array<{
    name: string
    date: string
    time: string
    venue: string
    address: string
    url: string
    priceRange: string
    description: string
    type: string
  }>
  summary: string
}> {
  const settings = getAppSettings()
  const city = settings?.weekendCity || 'Chicago'

  const dateContext = date
    ? `on ${date} (${new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })})`
    : 'this coming weekend'

  const systemPrompt = `You are an event discovery assistant for ${city}. Search the web to find real events and activities. Return structured results.`

  const userPrompt = `Search the web for: "${query}" happening in ${city} ${dateContext}.

Find real, specific events with accurate details. Look for concerts, shows, pop-ups, festivals, markets, sports, comedy, food events, community events, etc.

Return a JSON object with:
- "events": array of objects with { "name", "date" (YYYY-MM-DD), "time" (HH:MM or "TBD"), "venue", "address", "url", "priceRange", "description" (1-2 sentences), "type" (concert/sports/arts/food/festival/comedy/outdoor/other) }
- "summary": a brief sentence about what you found

Wrap the JSON in a \`\`\`json code block. Include up to 10 events, prioritizing the most relevant and interesting ones.`

  const response = await generateAnalysis(
    systemPrompt,
    userPrompt,
    { webSearch: true },
    'web-event-search',
  )

  try {
    const parsed = parseAiJson<Record<string, unknown>>(response)
    const rawEvents = Array.isArray(parsed.value.events) ? parsed.value.events : []
    const events = rawEvents.map((raw) => {
      const event = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      return {
        name: typeof event.name === 'string' ? event.name : '',
        date: typeof event.date === 'string' ? event.date : date || '',
        time: typeof event.time === 'string' ? event.time : 'TBD',
        venue: typeof event.venue === 'string' ? event.venue : '',
        address: typeof event.address === 'string' ? event.address : '',
        url: typeof event.url === 'string' ? event.url : '',
        priceRange:
          typeof event.priceRange === 'string'
            ? event.priceRange
            : typeof event.price_range === 'string'
              ? event.price_range
              : '',
        description: typeof event.description === 'string' ? event.description : '',
        type: typeof event.type === 'string' ? event.type : 'other',
      }
    })
    saveWeekendEventSearchResults(
      events.map((e, i) => ({
        id: `web-${i}-${e.date || date || ''}-${e.name || ''}`,
        name: e.name,
        type: e.type,
        date: e.date,
        time: e.time,
        venue: e.venue,
        address: e.address,
        city,
        priceRange: e.priceRange,
        url: e.url,
        imageUrl: null,
        description: e.description,
        distance: null,
      })),
      { source: 'web', query, category: 'web' },
    )
    return {
      events,
      summary: typeof parsed.value.summary === 'string' ? parsed.value.summary : '',
    }
  } catch {
    return { events: [], summary: response.slice(0, 200) }
  }
}

function eventCacheKey(
  event: Pick<LocalEvent, 'name' | 'date' | 'time' | 'venue' | 'url'>,
): string {
  if (event.url) return `url:${event.url}`
  return [event.name || '', event.date || '', event.time || '', event.venue || '']
    .join('|')
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, ' ')
    .trim()
}

export function saveWeekendEventSearchResults(
  events: LocalEvent[],
  meta: { source: string; query?: string; category?: string },
): number {
  if (!events.length) return 0
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO weekend_event_cache (
      event_key, name, event_date, time, venue, address, city, type,
      price_range, url, image_url, description, source, query, category, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(event_key) DO UPDATE SET
      name = excluded.name,
      event_date = excluded.event_date,
      time = excluded.time,
      venue = excluded.venue,
      address = excluded.address,
      city = excluded.city,
      type = excluded.type,
      price_range = excluded.price_range,
      url = excluded.url,
      image_url = excluded.image_url,
      description = excluded.description,
      source = excluded.source,
      query = excluded.query,
      category = excluded.category,
      updated_at = datetime('now')
  `)
  let count = 0
  const tx = db.transaction(() => {
    for (const event of events) {
      if (!event.name) continue
      stmt.run(
        eventCacheKey(event),
        event.name,
        event.date || '',
        event.time || '',
        event.venue || '',
        event.address || '',
        event.city || '',
        event.type || 'other',
        event.priceRange || '',
        event.url || '',
        event.imageUrl || null,
        event.description || '',
        meta.source,
        meta.query || '',
        meta.category || '',
      )
      count++
    }
  })
  tx()
  return count
}

export function getCachedWeekendEvents(limit = 100): CachedWeekendEvent[] {
  return getDb()
    .prepare(
      `
    SELECT event_key, name, event_date, time, venue, address, city, type,
           price_range, url, image_url, description, source, query, category,
           saved_at, updated_at
    FROM weekend_event_cache
    ORDER BY updated_at DESC
    LIMIT ?
  `,
    )
    .all(limit) as CachedWeekendEvent[]
}

function formatBookingAdvance(r: SavedRestaurant): string | null {
  if (typeof r.bookingAdvanceDays === 'number') {
    if (r.bookingAdvanceDays <= 0) return 'walk-in / no reservation needed'
    return `~${r.bookingAdvanceDays} days ahead`
  }
  if (r.bookingAdvance) return r.bookingAdvance
  return null
}

function formatBusyDays(matrix: BusyDaysMatrix | null | undefined): string | null {
  if (!matrix) return null
  type Bucket = 'low' | 'med' | 'high'
  const groups: Record<Bucket, string[]> = { low: [], med: [], high: [] }
  for (const day of DAYS_OF_WEEK) {
    const entry = matrix[day]
    if (!entry) continue
    const bucket: Bucket = entry.level >= 0.7 ? 'high' : entry.level >= 0.4 ? 'med' : 'low'
    groups[bucket].push(day)
  }
  const parts: string[] = []
  if (groups.high.length) parts.push(`${groups.high.join('/')} high`)
  if (groups.med.length) parts.push(`${groups.med.join('/')} medium`)
  if (groups.low.length) parts.push(`${groups.low.join('/')} low`)
  return parts.length ? parts.join(', ') : null
}

/**
 * Pull activity/location names from the most recent N weekend plans before `beforeDate`.
 * Used to keep the planner from recycling the same venues every weekend.
 */
function getRecentlySuggestedNames(beforeDate: string, n: number): string[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT plan_json FROM weekend_plans
       WHERE weekend_date < ? AND deleted_at IS NULL
       ORDER BY weekend_date DESC LIMIT ?`,
      )
      .all(beforeDate, n) as Array<{ plan_json: string }>

    const names = new Set<string>()
    for (const row of rows) {
      try {
        const plan = JSON.parse(row.plan_json)
        const blocks: any[] = [...(plan?.saturday || []), ...(plan?.sunday || [])]
        for (const b of blocks) {
          if (typeof b?.activity === 'string' && b.activity.trim()) names.add(b.activity.trim())
          if (typeof b?.location === 'string' && b.location.trim()) names.add(b.location.trim())
        }
      } catch {}
    }
    return Array.from(names)
  } catch {
    return []
  }
}
