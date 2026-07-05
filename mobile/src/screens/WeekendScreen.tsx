import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, RefreshControl, Platform, Alert, Linking, Modal, KeyboardAvoidingView, Image, ActivityIndicator
} from 'react-native'
import WebView from 'react-native-webview'
import { cacheDirectory, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'
import { getSettings } from '../lib/storage'
import { generateAnalysis, generateAnalysisWebSearch } from '../services/ai.service'
import { getPlannerWeatherPreview, formatWeatherForPlanner, type PlannerWeatherPreview } from '../services/weather.service'
import WeatherPreviewCard from '../components/WeatherPreviewCard'
import { pushMobileDataToRelay } from '../services/health-sync.service'
import { fetchWeekendEvents, searchEvents, browseEvents, getCachedEvents, dedupeEvents, Event, type EventCategoryId } from '../services/events.service'
import { listDatabases, pushWeekendToNotion, type NotionDatabase } from '../services/notion.service'
import {
  searchRestaurants, autocompleteRestaurants, getSavedRestaurants, saveRestaurant, removeSavedRestaurant,
  addManualRestaurant, updateRestaurant, rateRestaurant, addVisit, updateVisit, removeVisit,
  openBooking, openResyBooking, openGoogleMaps, openYelp,
  priceLevelLabel, Restaurant, SavedRestaurant, DAYS_OF_WEEK, type RestaurantVisit,
  type AutocompleteSuggestion, type BusyDaysMatrix,
} from '../services/restaurants.service'

interface WeekendActivity {
  time: string
  activity: string
  location: string
  travelTime: string
  rationale: string
  cost: string
}

interface WeekendPlan {
  [key: string]: WeekendActivity[]
}

type Tab = 'plan' | 'events' | 'restaurants'

const EVENT_CATEGORIES: Array<{ id: EventCategoryId; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { id: 'all', label: 'All', icon: 'sparkles-outline' },
  { id: 'music', label: 'Music', icon: 'musical-notes-outline' },
  { id: 'shows', label: 'Shows', icon: 'ticket-outline' },
  { id: 'sports', label: 'Sports', icon: 'football-outline' },
  { id: 'baseball', label: 'Baseball', icon: 'baseball-outline' },
  { id: 'comedy', label: 'Comedy', icon: 'happy-outline' },
  { id: 'arts', label: 'Arts', icon: 'color-palette-outline' },
  { id: 'family', label: 'Family', icon: 'people-outline' },
  { id: 'festivals', label: 'Festivals', icon: 'calendar-outline' },
]

const MUSIC_GENRES = ['All', 'Rock', 'Hip-Hop', 'Electronic', 'Jazz', 'R&B', 'Pop', 'Country', 'Latin']

const EVENT_FOCUS_OPTIONS = ['Date night', 'Solo friendly', 'Free or cheap', 'Food pop-ups', 'Live music', 'Hidden gems', 'High energy', 'Low key']

type WeekendTheme = 'foodie' | 'outdoors' | 'chill' | 'culture' | 'date_night' | 'hidden_gems' | 'social'
type WeekendLocationStrategy = 'clustered' | 'two_zones' | 'open'
type WeekendDiscoveryMode = 'balanced' | 'new_neighborhoods' | 'saved_favorites'

const THEME_OPTIONS: Array<{ id: WeekendTheme; label: string; emoji: string }> = [
  { id: 'foodie',      label: 'Foodie',       emoji: '🍜' },
  { id: 'outdoors',    label: 'Outdoorsy',    emoji: '🌳' },
  { id: 'chill',       label: 'Chill',        emoji: '☕' },
  { id: 'culture',     label: 'Culture',      emoji: '🎭' },
  { id: 'date_night',  label: 'Date night',   emoji: '🍷' },
  { id: 'hidden_gems', label: 'Hidden gems',  emoji: '🗝️' },
  { id: 'social',      label: 'Social',       emoji: '🍻' },
]

const LOCATION_STRATEGY_OPTIONS: Array<{ id: WeekendLocationStrategy; label: string }> = [
  { id: 'clustered', label: 'One area' },
  { id: 'two_zones', label: 'Two zones' },
  { id: 'open', label: 'Open route' },
]

const DISCOVERY_MODE_OPTIONS: Array<{ id: WeekendDiscoveryMode; label: string }> = [
  { id: 'balanced', label: 'Balanced' },
  { id: 'new_neighborhoods', label: 'New areas' },
  { id: 'saved_favorites', label: 'Saved picks' },
]

const THEME_GUIDANCE: Record<WeekendTheme, string> = {
  foodie: 'Foodie crawl — build the day around food. Prioritize the saved restaurants below. Add 1-2 bars, food halls, dessert spots, or coffee stops between meals. Skip museums and tourist landmarks unless they sit between meal stops.',
  outdoors: 'Outdoorsy / active — lakefront, trails, parks, kayaking, biking, climbing gyms, neighborhood walks. Lean physical. Mention if outdoor plans need a weather check.',
  chill: 'Chill / recovery — low-energy day. 2-3 unhurried activities per day with long buffers. Cafes, slow brunches, bookshops, parks. No early starts.',
  culture: 'Culture & art — museums, galleries, live music, theater, architecture walks, indie cinemas. Mix obvious picks with one lesser-known venue.',
  date_night: 'Date night — romantic, intimate pacing. Anchor on a quality dinner (prefer saved restaurants), add a cocktail bar, plus one evening activity.',
  hidden_gems: 'Hidden gems / local — explicitly non-touristy. Avoid the standard city checklist (Cloud Gate, Navy Pier, Art Institute, Field Museum, etc.). Suggest neighborhood-specific spots locals actually visit.',
  social: 'Social / hangout — group-friendly. Beer gardens, patios, big-table restaurants, bowling/arcade bars, live music venues with room to talk.',
}


const VENUE_TYPES = ['All', 'Restaurant', 'Bar', 'Cafe', 'Dessert', 'Fast Food']
const CUISINE_CATEGORIES = [
  'American', 'Chinese', 'Japanese', 'Korean', 'Thai', 'Vietnamese', 'Indian',
  'Italian', 'Mexican', 'Mediterranean', 'French', 'Fusion', 'BBQ', 'Seafood',
  'Pizza', 'Brunch', 'Dessert', 'Coffee', 'Cocktails', 'Other'
]
const SPICE_LEVELS = ['None', 'Mild', 'Medium', 'Hot', 'Very Hot']
const PRICE_OPTIONS = [1, 2, 3, 4]

function venueTypeColor(type: string): string {
  switch (type?.toLowerCase()) {
    case 'bar': return colors.accent.purple
    case 'cafe': case 'coffee': return colors.accent.amber
    case 'dessert': return colors.accent.cyan
    case 'fast food': return colors.accent.red
    default: return colors.accent.green
  }
}

function getUpcomingDates(count: number = 14): { date: Date; label: string; dayName: string }[] {
  const dates = []
  const today = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() + i)
    dates.push({
      date: d,
      label: d.getDate().toString(),
      dayName: DAYS_OF_WEEK[d.getDay() === 0 ? 6 : d.getDay() - 1],
    })
  }
  return dates
}

function formatDateISO(d: Date): string {
  return d.toISOString().split('T')[0]
}

function getDayName(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase()
}

function buildPlannerPrompt(
  days: Date[],
  city: string,
  neighborhood: string | undefined,
  commuteNotes: string | undefined,
  savedRestaurants: SavedRestaurant[] | undefined,
  themes: WeekendTheme[],
  avoidTouristy: boolean,
  recentToAvoid: string[],
  locationStrategy: WeekendLocationStrategy,
  discoveryMode: WeekendDiscoveryMode,
  transportMode: string | undefined
): string {
  const dayNames = days.map(d => d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }))
  const locationContext = neighborhood
    ? `The user lives in the ${neighborhood} area of ${city}.`
    : `The user lives in the ${city} area.`
  const commuteContext = commuteNotes ? `\nCommute notes: ${commuteNotes}` : ''
  const restaurantContext = savedRestaurants && savedRestaurants.length > 0
    ? `\n\nSaved restaurants the user has vetted:\n${savedRestaurants.map(r =>
        `- ${r.name} (${r.address})${r.priceLevel ? ` ${priceLevelLabel(r.priceLevel)}` : ''}${r.notes ? ` — ${r.notes}` : ''}`
      ).join('\n')}\nPrefer these for meal blocks — use at least one when geography allows.`
    : ''
  const themeBlock = themes.length > 0
    ? `\n\nThemes (lean into these personalities):\n${themes.map(t => `- ${t.replace('_', ' ')}: ${THEME_GUIDANCE[t]}`).join('\n')}`
    : ''
  const avoidTouristyBlock = avoidTouristy
    ? `\n\nAvoid touristy: do NOT suggest the standard city checklist (Cloud Gate, Navy Pier, Art Institute, Museum of Science & Industry, Architecture Boat Tour, Field Museum, Lincoln Park Zoo, Riverwalk, Willis Tower, 360 Chicago). Suggest neighborhood-level local picks with specific venue names.`
    : ''
  const recentBlock = recentToAvoid.length > 0
    ? `\n\nRecent picks to avoid (already suggested in the last few weekends — pick different alternatives):\n${recentToAvoid.slice(0, 30).map(n => `- ${n}`).join('\n')}`
    : ''

  const geographyBlock = {
    clustered: 'Use one neighborhood cluster per day. Keep meals within or immediately adjacent to that cluster.',
    two_zones: 'Use at most two nearby zones per day, as a one-way progression. Do not bounce back to the first area.',
    open: 'Longer travel is acceptable, but still avoid backtracking and keep meals near adjacent activities.',
  }[locationStrategy]
  const discoveryBlock = {
    balanced: 'Mix one trusted saved place when it fits with fresh neighborhood-level discoveries.',
    new_neighborhoods: 'Prioritize fresh neighborhood-level venues and areas. Saved restaurants are optional backups, not the default.',
    saved_favorites: 'Prefer vetted saved restaurants and places, but only when they fit the day geography.',
  }[discoveryMode]

  // Transport-aware geography. When driving isn't the mode, hopping between areas
  // is slow/tiring (walking/transit/biking), so keep the whole day tightly clustered.
  const tm = (transportMode || 'driving').toLowerCase()
  const transportGeo = tm.includes('driv') || tm.includes('car')
    ? 'Driving is available, so moderate travel between areas is OK — but still follow one continuous route and never double back to an area you already left.'
    : `Driving is NOT selected (getting around by ${transportMode}). This is a HARD constraint and overrides the route style above: keep the ENTIRE day inside a single ${tm.includes('walk') ? 'walkable' : tm.includes('bik') || tm.includes('cycl') ? 'bikeable' : 'transit-friendly'} neighborhood where each stop is a short ${tm.includes('transit') ? 'transit ride' : 'walk'} from the previous one. Pick one neighborhood anchor and fit every activity and meal inside it; drop anything that needs a car.`

  const dayKeys = days.map(d => getDayName(d))

  return `You are an activity planner for someone living in ${city}. ${locationContext}${commuteContext}${restaurantContext}${themeBlock}${avoidTouristyBlock}${recentBlock}

Create a fun, realistic itinerary for: ${dayNames.join(', ')}.

Rules:
- Pick 3-6 activities per day
- Include realistic travel times for ${city}
- Geography: ${geographyBlock}
- Transport & clustering: ${transportGeo}
- Treat each day as a single one-way path: group stops by area, move through areas ONCE in geographic order, and NEVER return to an area you already left (no A → B → A hopping). Put same-area stops back-to-back.
- Meals must be in the same area as the activity right before or after them. If a saved restaurant is far from the route, skip it rather than detour.
- Discovery mode: ${discoveryBlock}
- Suggest specific restaurant names near activities
- If themes are set, the itinerary MUST clearly reflect them
- If saved restaurants are listed, prefer them for meals
- If recent picks are listed, do NOT repeat them — find fresh alternatives
- Mix activity types unless a theme says otherwise
- Include downtime

Output format: JSON object with keys: ${dayKeys.map(k => `"${k}"`).join(', ')}
Each key maps to an array of activities.
Each activity: { "time": "HH:MM-HH:MM", "activity": "...", "location": "...", "travelTime": "...", "rationale": "...", "cost": "..." }
Wrap in a \`\`\`json code block. Add a "Notes" section after.`
}

/**
 * Pull activity/location names from the most recent N weekend plans before a date.
 */
async function getRecentlySuggestedNamesMobile(beforeDate: string, n: number): Promise<string[]> {
  try {
    const db = await getDb()
    const rows = (await db.getAllAsync(
      `SELECT plan_json FROM weekend_plans WHERE weekend_date < ? ORDER BY weekend_date DESC LIMIT ?`,
      beforeDate, n
    )) as Array<{ plan_json: string }>
    const names = new Set<string>()
    for (const row of rows) {
      try {
        const plan = JSON.parse(row.plan_json)
        for (const key of Object.keys(plan || {})) {
          const blocks: any[] = plan[key]
          if (!Array.isArray(blocks)) continue
          for (const b of blocks) {
            if (typeof b?.activity === 'string' && b.activity.trim()) names.add(b.activity.trim())
            if (typeof b?.location === 'string' && b.location.trim()) names.add(b.location.trim())
          }
        }
      } catch {}
    }
    return Array.from(names)
  } catch {
    return []
  }
}

export default function WeekendScreen({ navigation }: any) {
  const [tab, setTab] = useState<Tab>('plan')
  const [plan, setPlan] = useState<WeekendPlan | null>(null)
  const [notes, setNotes] = useState<string | null>(null)
  const [preferences, setPreferences] = useState('')
  const [generating, setGenerating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [storedPlanJson, setStoredPlanJson] = useState<string | null>(null)
  const [storedDate, setStoredDate] = useState<string | null>(null)
  const [pushingNotion, setPushingNotion] = useState(false)
  const [notionSent, setNotionSent] = useState(false)

  // Date selection
  const upcomingDates = getUpcomingDates(14)
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set())

  // Theme + saved-restaurant seeding
  const [selectedThemes, setSelectedThemes] = useState<Set<WeekendTheme>>(new Set())
  const [selectedSavedIds, setSelectedSavedIds] = useState<Set<number>>(new Set())
  const [locationStrategy, setLocationStrategy] = useState<WeekendLocationStrategy>('clustered')
  const [discoveryMode, setDiscoveryMode] = useState<WeekendDiscoveryMode>('balanced')

  // Weather preview for selected dates
  const [weatherPreview, setWeatherPreview] = useState<PlannerWeatherPreview | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)

  // Events state
  const [events, setEvents] = useState<Event[]>([])
  const [eventSearch, setEventSearch] = useState('')
  const [eventFocus, setEventFocus] = useState('')
  const [eventDetails, setEventDetails] = useState('')
  const [selectedEventCategory, setSelectedEventCategory] = useState<EventCategoryId>('all')
  const [selectedMusicGenre, setSelectedMusicGenre] = useState('All')
  const [eventPage, setEventPage] = useState(0)
  const [eventTotalPages, setEventTotalPages] = useState(0)
  const [searchingEvents, setSearchingEvents] = useState(false)
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false)
  const [eventsLoaded, setEventsLoaded] = useState(false)
  const [eventDate, setEventDate] = useState<string | null>(null)

  // Restaurant state
  const [savedList, setSavedList] = useState<SavedRestaurant[]>([])
  const [searchResults, setSearchResults] = useState<Restaurant[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([])
  const autocompleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [venueFilter, setVenueFilter] = useState('All')
  const [cuisineFilter, setCuisineFilter] = useState('')
  const [restaurantView, setRestaurantView] = useState<'list' | 'map'>('list')
  // AI Discover (trending / newly-opened)
  const [discovering, setDiscovering] = useState(false)
  const [discoverResults, setDiscoverResults] = useState<any[] | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  // Manual add form
  const [newName, setNewName] = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [newVenueType, setNewVenueType] = useState('restaurant')
  const [newCuisine, setNewCuisine] = useState('')
  const [newSpice, setNewSpice] = useState('')
  const [newPrice, setNewPrice] = useState<number | null>(null)
  const [newNotes, setNewNotes] = useState('')

  useEffect(() => { loadSaved() }, [])

  const loadSaved = async () => {
    const saved = await getSavedRestaurants()
    setSavedList(saved)
  }

  const toggleDate = (dateStr: string) => {
    setSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(dateStr)) next.delete(dateStr)
      else next.add(dateStr)
      const dates = Array.from(next).sort()
      if (dates.length > 0) {
        setWeatherLoading(true)
        setWeatherPreview(null)
        getPlannerWeatherPreview({ dates })
          .then((p) => setWeatherPreview(p))
          .catch(() => {})
          .finally(() => setWeatherLoading(false))
      } else {
        setWeatherPreview(null)
      }
      return next
    })
  }

  const getSelectedDateObjects = (): Date[] => {
    return upcomingDates
      .filter(d => selectedDates.has(formatDateISO(d.date)))
      .map(d => d.date)
      .sort((a, b) => a.getTime() - b.getTime())
  }

  const handleGenerate = async () => {
    const selected = getSelectedDateObjects()
    if (selected.length === 0) {
      Alert.alert('Select Days', 'Pick at least one day to plan.')
      return
    }

    setGenerating(true)
    try {
      const settings = await getSettings()
      const city = settings.weekendCity || 'Chicago'
      const neighborhood = settings.homeNeighborhood || undefined
      const commuteNotes = settings.commuteNotes || undefined
      const themesArr = Array.from(selectedThemes)
      const avoidTouristy = themesArr.includes('hidden_gems')
      const seedList = selectedSavedIds.size > 0
        ? savedList.filter(r => selectedSavedIds.has(r.id))
        : savedList
      const startISO = formatDateISO(selected[0])
      const recentToAvoid = await getRecentlySuggestedNamesMobile(startISO, 3)
      const prompt = buildPlannerPrompt(
        selected, city, neighborhood, commuteNotes, seedList,
        themesArr, avoidTouristy, recentToAvoid, locationStrategy, discoveryMode,
        settings.transportMode
      )

      // Fetch events for context
      const startDate = formatDateISO(selected[0])
      const endDate = formatDateISO(selected[selected.length - 1])
      const contextEvents = await fetchWeekendEvents(startDate, endDate)

      const eventsContext = contextEvents.length > 0
        ? `\nReal events happening:\n${contextEvents.map(e => `- ${e.name} at ${e.venue} (${e.date} ${e.time})${e.priceRange ? ` ${e.priceRange}` : ''}`).join('\n')}`
        : ''

      const dayLabels = selected.map(d =>
        d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
      ).join(', ')

      const weatherContext = weatherPreview ? formatWeatherForPlanner(weatherPreview) : ''

      const userPrompt = `Plan for: ${dayLabels}
${preferences ? `\nPreferences: ${preferences}` : ''}${eventsContext}
${weatherContext ? `\n${weatherContext}` : ''}
\nGenerate my itinerary. Consider the real events above if relevant.`

      const response = await generateAnalysis(prompt, userPrompt)

      let planJson = ''
      let rationale: string | null = null

      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/)
      if (jsonMatch) {
        planJson = jsonMatch[1].trim()
        rationale = response.replace(/```json[\s\S]*?```/, '').trim() || null
      } else {
        const braceMatch = response.match(/\{[\s\S]*\}/)
        if (braceMatch) {
          planJson = braceMatch[0]
          rationale = response.replace(planJson, '').trim() || null
        } else {
          setNotes(response)
          setGenerating(false)
          return
        }
      }

      try {
        const parsed = JSON.parse(planJson)
        setPlan(parsed)
        setStoredPlanJson(planJson)
        setStoredDate(startDate)
        setNotes(rationale)

        const db = await getDb()
        await db.runAsync(
          'INSERT OR REPLACE INTO weekend_plans (weekend_date, plan_json, ai_rationale) VALUES (?, ?, ?)',
          startDate, planJson, rationale
        )
        // Push the new plan up so the desktop app picks it up on its next pull.
        pushMobileDataToRelay().catch(err => console.warn('[Weekend] Failed to push plan to relay:', err))
      } catch {
        setNotes(response)
      }
    } catch (err: any) {
      setNotes(`Error: ${err.message}`)
    }
    setGenerating(false)
  }

  const handleNotionPress = async () => {
    if (!storedPlanJson || !storedDate) return
    setPushingNotion(true)
    try {
      const dbs = await listDatabases()
      if (dbs.length === 0) {
        Alert.alert('No Databases', 'No Notion databases found.')
        setPushingNotion(false)
        return
      }
      if (dbs.length === 1) {
        const count = await pushWeekendToNotion(dbs[0].id, storedPlanJson, storedDate)
        setNotionSent(true)
        setTimeout(() => setNotionSent(false), 3000)
        Alert.alert('Sent!', `${count} activities added to Notion.`)
      } else {
        Alert.alert('Pick Database', undefined, [
          ...dbs.slice(0, 5).map(db => ({
            text: db.title,
            onPress: async () => {
              const count = await pushWeekendToNotion(db.id, storedPlanJson!, storedDate!)
              setNotionSent(true)
              setTimeout(() => setNotionSent(false), 3000)
              Alert.alert('Sent!', `${count} activities added to Notion.`)
            }
          })),
          { text: 'Cancel', style: 'cancel' as const }
        ])
      }
    } catch (err: any) {
      Alert.alert('Error', err.message)
    }
    setPushingNotion(false)
  }

  // Events
  const mergeEvents = (current: Event[], incoming: Event[]): Event[] => {
    return dedupeEvents([...current, ...incoming])
  }

  const loadEvents = async ({
    category = selectedEventCategory,
    musicGenre = selectedMusicGenre,
    page = 0,
    append = false,
    keyword = buildEventSearchQuery(),
    date = eventDate,
  }: {
    category?: EventCategoryId
    musicGenre?: string
    page?: number
    append?: boolean
    keyword?: string
    date?: string | null
  } = {}) => {
    if (append) setLoadingMoreEvents(true)
    else setSearchingEvents(true)

    try {
      const dateOpts = date ? { startDate: date, endDate: date } : {}
      const result = keyword
        ? await searchEvents(keyword, { category, musicGenre, page, ...dateOpts })
        : await browseEvents({ category, musicGenre, page, ...dateOpts })

      const cached = append ? [] : await getCachedEvents(50)
      const mergedResults = append ? result.events : dedupeEvents([...result.events, ...cached])
      setEvents(prev => append ? mergeEvents(prev, mergedResults) : mergedResults)
      setEventPage(result.page)
      setEventTotalPages(result.totalPages)
      setEventsLoaded(true)
      pushMobileDataToRelay().catch(err => console.warn('[Weekend] Failed to push events to relay:', err))
    } catch (err) {
      console.error('Load events error:', err)
    } finally {
      if (append) setLoadingMoreEvents(false)
      else setSearchingEvents(false)
    }
  }

  const buildEventSearchQuery = () => {
    return [eventSearch.trim(), eventFocus, eventDetails.trim()].filter(Boolean).join(' ')
  }

  const handleSelectEventCategory = (category: EventCategoryId) => {
    const nextMusicGenre = category === 'music' ? selectedMusicGenre : 'All'
    setSelectedEventCategory(category)
    setSelectedMusicGenre(nextMusicGenre)
    loadEvents({ category, musicGenre: nextMusicGenre, page: 0, keyword: buildEventSearchQuery() })
  }

  const handleSelectMusicGenre = (genre: string) => {
    setSelectedEventCategory('music')
    setSelectedMusicGenre(genre)
    loadEvents({ category: 'music', musicGenre: genre, page: 0, keyword: buildEventSearchQuery() })
  }

  const handleSearchEvents = async () => {
    if (!buildEventSearchQuery()) return
    await loadEvents({ page: 0 })
  }

  const handleRefreshEvents = async () => {
    await loadEvents({ page: 0 })
  }

  const handleLoadMoreEvents = async () => {
    if (loadingMoreEvents || searchingEvents) return
    if (eventTotalPages > 0 && eventPage + 1 >= eventTotalPages) return
    await loadEvents({ page: eventPage + 1, append: true })
  }

  // Restaurants
  const handleSearchInputChange = (value: string) => {
    setSearchQuery(value)
    if (autocompleteTimer.current) clearTimeout(autocompleteTimer.current)
    if (!value.trim() || value.trim().length < 2) {
      setSuggestions([])
      return
    }
    autocompleteTimer.current = setTimeout(async () => {
      try {
        const results = await autocompleteRestaurants(value.trim())
        setSuggestions(results || [])
      } catch {
        setSuggestions([])
      }
    }, 300)
  }

  const handleSelectSuggestion = async (s: AutocompleteSuggestion) => {
    setSearchQuery(s.name)
    setSuggestions([])
    setSearching(true)
    try {
      const results = await searchRestaurants(s.name)
      const savedIds = new Set(savedList.map(sr => sr.placeId))
      setSearchResults(results.map(r => ({ ...r, saved: savedIds.has(r.placeId) })))
    } catch (err) {
      console.error('Restaurant search error:', err)
    }
    setSearching(false)
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSuggestions([])
    setSearching(true)
    try {
      const results = await searchRestaurants(searchQuery.trim())
      const savedIds = new Set(savedList.map(s => s.placeId))
      setSearchResults(results.map(r => ({ ...r, saved: savedIds.has(r.placeId) })))
    } catch (err) {
      console.error('Restaurant search error:', err)
    }
    setSearching(false)
  }

  const handleSaveRestaurant = async (r: Restaurant) => {
    await saveRestaurant(r)
    await loadSaved()
    setSearchResults(prev => prev.map(sr =>
      sr.placeId === r.placeId ? { ...sr, saved: true } : sr
    ))
  }

  const handleRemoveRestaurant = async (placeId: string) => {
    Alert.alert('Remove Restaurant', 'Remove from saved list?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          await removeSavedRestaurant(placeId)
          await loadSaved()
          setSearchResults(prev => prev.map(sr =>
            sr.placeId === placeId ? { ...sr, saved: false } : sr
          ))
        }
      }
    ])
  }

  const handleAddManual = async () => {
    if (!newName.trim()) {
      Alert.alert('Required', 'Enter a restaurant name.')
      return
    }
    await addManualRestaurant({
      name: newName.trim(),
      address: newAddress.trim() || undefined,
      venueType: newVenueType || undefined,
      cuisineCategory: newCuisine || undefined,
      spiceLevel: newSpice || undefined,
      priceLevel: newPrice || undefined,
      notes: newNotes.trim() || undefined,
    })
    setNewName(''); setNewAddress(''); setNewVenueType('restaurant')
    setNewCuisine(''); setNewSpice(''); setNewPrice(null); setNewNotes('')
    setShowAddForm(false)
    await loadSaved()
  }

  const handleDiscoverTrending = async () => {
    setDiscovering(true)
    setDiscoverResults(null)
    setDiscoverError(null)
    try {
      const settings = await getSettings()
      const city = settings.weekendCity || 'Chicago'
      const neighborhood = settings.homeNeighborhood?.trim()
      const localeContext = neighborhood ? `${city} (the user is based in/near ${neighborhood})` : city
      const savedNames = savedList.map(r => r.name).join(', ')

      const systemPrompt = `You are a plugged-in local food editor for ${city}. You track new restaurant and bar openings and what's trending on dining lists, local press, and social media right now. Use web search to ground every suggestion in current, real information.`
      const userPrompt = `Find 5-8 restaurants/bars in ${localeContext} that are TRENDING or NEWLY OPENED right now.

Prioritize, in order:
1. Spots that opened within roughly the last 12 months.
2. Spots currently getting buzz — recent "best new" lists, local press, awards, or social media attention.
3. Hidden gems on the rise that aren't tourist traps.

Hard rules:
- Search the web to confirm each place is REAL, currently open, and actually recent/trending. Do not invent places.
- Do NOT suggest any place the user has already saved. Already saved (exclude all of these): ${savedNames || 'None yet'}
- Aim for variety across neighborhoods and styles, not 5 of the same thing.

For each suggestion, set "whyRecommended" to specifically explain what makes it trending or new. Respond with:
\`\`\`json
[
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
    "whyRecommended": "What makes it trending or new"
  }
]
\`\`\``

      const result = await generateAnalysisWebSearch(systemPrompt, userPrompt)
      const jsonMatch = result.match(/```json\s*([\s\S]*?)```/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1].trim())
        if (Array.isArray(parsed) && parsed.length > 0) {
          setDiscoverResults(parsed)
        } else {
          setDiscoverError('No fresh suggestions came back. Try again in a moment.')
        }
      } else {
        setDiscoverError('Could not parse suggestions. Try again.')
      }
    } catch (e: any) {
      setDiscoverError(e?.message || 'Discovery failed. Check your AI connection in Settings.')
    }
    setDiscovering(false)
  }

  const handleAddTrending = async (suggestion: any) => {
    try {
      await addManualRestaurant({
        name: suggestion.name,
        address: suggestion.address || undefined,
        venueType: suggestion.venueType || 'restaurant',
        cuisineCategory: suggestion.cuisineCategory || undefined,
        spiceLevel: suggestion.spiceLevel && suggestion.spiceLevel !== 'none' ? suggestion.spiceLevel : undefined,
        priceLevel: typeof suggestion.priceLevel === 'number' ? suggestion.priceLevel : undefined,
        bookingAdvance: suggestion.bookingAdvance || undefined,
        peakTimes: suggestion.peakTimes || undefined,
        description: suggestion.description || undefined,
      })
      await loadSaved()
      setDiscoverResults(prev =>
        prev ? prev.map(s => (s.name === suggestion.name ? { ...s, _added: true } : s)) : prev
      )
    } catch (e: any) {
      Alert.alert('Could not add', e?.message || 'Failed to save this place.')
    }
  }

  const handleRate = async (placeId: string, rating: number) => {
    await rateRestaurant(placeId, rating)
    await loadSaved()
  }

  const handleSaveVisit = async (placeId: string, rating: number | null, visitDate: string, notes: string, visitId?: number) => {
    if (visitId) {
      await updateVisit(visitId, { rating, visitDate, notes })
    } else {
      await addVisit(placeId, rating, visitDate, notes)
    }
    await loadSaved()
  }

  const handleRemoveVisit = async (visitId: number) => {
    Alert.alert('Delete visit?', 'This removes the rating and review notes for this visit.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await removeVisit(visitId)
          await loadSaved()
        },
      },
    ])
  }

  const [editingRestaurant, setEditingRestaurant] = useState<SavedRestaurant | null>(null)

  const handleSaveEdit = async (placeId: string, updates: Record<string, any>) => {
    await updateRestaurant(placeId, updates)
    setEditingRestaurant(null)
    await loadSaved()
  }

  const [exporting, setExporting] = useState(false)
  const [exportHtml, setExportHtml] = useState<string | null>(null)
  const webviewRef = useRef<WebView>(null)

  const buildExportHtml = useCallback((dayLabel: string, acts: WeekendActivity[], accentColor: string, accentRgb: string) => {
    const escaped = (s: string) => s.replace(/'/g, "\\'").replace(/\n/g, ' ')
    const actsJson = JSON.stringify(acts.map(a => ({
      time: a.time, activity: a.activity, location: a.location, cost: a.cost, travelTime: a.travelTime,
    })))
    return `<!DOCTYPE html><html><body style="margin:0;background:#000;"><canvas id="c"></canvas>
<script>
const acts = ${actsJson};
const label = '${escaped(dayLabel)}';
const accentColor = '${accentColor}';
const accentRgb = '${accentRgb}';
const dateStr = '${escaped(storedDate || '')}';

const scale = 2, w = 900, pad = 48, cardPad = 28, dayHeaderH = 56, actH = 96, logoSize = 48, titleH = 110, footerH = 60;
const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const monoFont = '"SF Mono", "Cascadia Code", "Fira Code", monospace';
const cardH = dayHeaderH + acts.length * actH + cardPad * 2;
const h = pad + titleH + cardH + footerH;
const canvas = document.getElementById('c');
canvas.width = w * scale; canvas.height = h * scale;
const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);

// Background
const bg = ctx.createLinearGradient(0,0,w,h);
bg.addColorStop(0,'#0a0e1a'); bg.addColorStop(0.5,'#0d1424'); bg.addColorStop(1,'#0f0a1e');
ctx.fillStyle=bg; ctx.beginPath(); ctx.roundRect(0,0,w,h,24); ctx.fill();

// Glow
const gc = 'rgba('+accentRgb+',0.06)';
const g1=ctx.createRadialGradient(w*0.15,h*0.25,0,w*0.15,h*0.25,200); g1.addColorStop(0,gc); g1.addColorStop(1,'transparent');
ctx.fillStyle=g1; ctx.fillRect(0,0,w*0.5,h*0.6);

// Draw logo
function drawLogo(cx,cy,sz,c){
  const s=sz/64; ctx.save(); ctx.translate(cx-sz/2,cy-sz/2); ctx.strokeStyle=c; ctx.lineCap='round';
  ctx.lineWidth=1.8*s; ctx.beginPath(); ctx.moveTo(27*s,13*s); ctx.lineTo(40*s,23*s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(31*s,11*s); ctx.lineTo(42.5*s,22*s); ctx.stroke();
  ctx.lineWidth=1.4*s;
  [[33,21,32,24,34,26,32.5,29],[35,20.5,34,23.5,36,25.5,34.5,28.5],[37,20,36,23,38,25,36.5,28]].forEach(n=>{
    ctx.beginPath(); ctx.moveTo(n[0]*s,n[1]*s); ctx.bezierCurveTo(n[2]*s,n[3]*s,n[4]*s,n[5]*s,n[6]*s,n[7]*s); ctx.stroke();
  });
  ctx.lineWidth=1.8*s; ctx.beginPath(); ctx.ellipse(32*s,29.5*s,19*s,4*s,0,0,Math.PI*2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(13*s,29.5*s); ctx.bezierCurveTo(13*s,29.5*s,15*s,49*s,32*s,49*s);
  ctx.bezierCurveTo(49*s,49*s,51*s,29.5*s,51*s,29.5*s); ctx.stroke();
  ctx.lineWidth=1.5*s; ctx.beginPath(); ctx.roundRect(27*s,48.5*s,10*s,3*s,0.5*s); ctx.stroke();
  ctx.lineWidth=1.4*s;
  [[17,31,20,34,24,32,28,34,32,36,36,33,40,34,43,35,45,33,47,34],
   [18,33.5,21,36,25,34,29,36.5,33,39,37,35.5,41,37,44,38,46,36,47,36.5],
   [19,36,22,38.5,26,36.5,30,38.5,34,40.5,38,38,42,39.5]].forEach(pts=>{
    ctx.beginPath(); ctx.moveTo(pts[0]*s,pts[1]*s);
    for(let i=2;i<pts.length-3;i+=6) ctx.bezierCurveTo(pts[i]*s,pts[i+1]*s,pts[i+2]*s,pts[i+3]*s,pts[i+4]*s,pts[i+5]*s);
    ctx.stroke();
  });
  ctx.restore();
}

let y = pad;
drawLogo(pad+logoSize/2, y+logoSize/2+8, logoSize, 'rgba('+accentRgb+',0.7)');

const textX = pad+logoSize+16;
ctx.fillStyle='rgba('+accentRgb+',0.5)'; ctx.font='600 11px '+font; ctx.letterSpacing='3px';
ctx.fillText(label.toUpperCase(), textX, y+18); ctx.letterSpacing='0px';

let displayDate = dateStr || 'This '+label;
if(dateStr){
  const dp=dateStr.split('-'); let d=new Date(+dp[0],+dp[1]-1,+dp[2]);
  if(label==='Sunday') d.setDate(d.getDate()+1);
  displayDate=d.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
}
ctx.fillStyle='#e6edf3'; ctx.font='bold 26px '+font; ctx.fillText(displayDate, textX, y+50);

const lg=ctx.createLinearGradient(pad,0,w-pad,0);
lg.addColorStop(0,'rgba('+accentRgb+',0.4)'); lg.addColorStop(0.5,'rgba('+accentRgb+',0.2)'); lg.addColorStop(1,'rgba('+accentRgb+',0.05)');
ctx.fillStyle=lg; ctx.fillRect(pad,y+80,w-pad*2,1.5);
y+=titleH;

const contentX=pad+cardPad+24;
ctx.fillStyle='rgba(255,255,255,0.03)'; ctx.beginPath(); ctx.roundRect(pad,y,w-pad*2,cardH,16); ctx.fill();
ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1; ctx.beginPath(); ctx.roundRect(pad,y,w-pad*2,cardH,16); ctx.stroke();

const lx=pad+cardPad, ly=y+cardPad+20;
ctx.fillStyle=accentColor; ctx.beginPath(); ctx.arc(lx+6,ly-5,5,0,Math.PI*2); ctx.fill();
const dg=ctx.createRadialGradient(lx+6,ly-5,0,lx+6,ly-5,20); dg.addColorStop(0,'rgba('+accentRgb+',0.3)'); dg.addColorStop(1,'transparent');
ctx.fillStyle=dg; ctx.fillRect(lx-14,ly-25,40,40);
ctx.fillStyle=accentColor; ctx.font='bold 18px '+font; ctx.fillText(label,lx+20,ly);

const bt=acts.length+' activities'; ctx.font='11px '+font; const bw=ctx.measureText(bt).width+16;
ctx.font='bold 18px '+font; const lw=ctx.measureText(label).width;
ctx.fillStyle='rgba('+accentRgb+',0.15)'; ctx.font='11px '+font;
ctx.beginPath(); ctx.roundRect(lx+20+lw+12,ly-12,bw,20,10); ctx.fill();
ctx.fillStyle=accentColor; ctx.fillText(bt,lx+20+lw+20,ly+1);

const tlx=pad+cardPad+8, tls=y+cardPad+dayHeaderH, tle=tls+(acts.length-1)*actH+10;
ctx.strokeStyle='rgba('+accentRgb+',0.15)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(tlx,tls); ctx.lineTo(tlx,tle); ctx.stroke();

acts.forEach((a,i)=>{
  const ay=y+cardPad+dayHeaderH+i*actH; let ry=ay+4;
  ctx.fillStyle=i===0?accentColor:'rgba('+accentRgb+',0.5)';
  ctx.beginPath(); ctx.arc(tlx,ay+10,i===0?5:3.5,0,Math.PI*2); ctx.fill();
  ctx.fillStyle=accentColor; ctx.font='600 13px '+monoFont; ctx.fillText(a.time,contentX,ry+12); ry+=26;
  ctx.fillStyle='#e6edf3'; ctx.font='600 15px '+font;
  let nm=a.activity; const mw=w-pad*2-cardPad*2-30;
  while(ctx.measureText(nm).width>mw&&nm.length>3) nm=nm.slice(0,-4)+'…';
  ctx.fillText(nm,contentX,ry+12); ry+=24;
  let mx=contentX;
  if(a.location){ctx.fillStyle='#7d8590';ctx.font='12px '+font;const t='📍 '+a.location;ctx.fillText(t,mx,ry+10);mx+=ctx.measureText(t).width+20}
  if(a.cost){ctx.fillStyle='#7d8590';ctx.font='12px '+font;const t='💰 '+a.cost;ctx.fillText(t,mx,ry+10);mx+=ctx.measureText(t).width+20}
  if(a.travelTime){ctx.fillStyle='#585e68';ctx.font='11px '+font;ctx.fillText('🚗 '+a.travelTime,mx,ry+10)}
  if(i<acts.length-1){ctx.fillStyle='rgba(255,255,255,0.05)';ctx.fillRect(contentX,ay+actH-4,w-pad*2-cardPad*2-30,1)}
});
y+=cardH; y+=16;
ctx.fillStyle='rgba(255,255,255,0.08)'; ctx.fillRect(pad,y,w-pad*2,1); y+=14;
ctx.fillStyle='#30363d'; ctx.font='11px '+font; ctx.fillText('Generated by Mien',pad,y);
drawLogo(w-pad-10,y-4,18,'#484f58');

window.ReactNativeWebView.postMessage(canvas.toDataURL('image/png'));
</script></body></html>`
  }, [storedDate])

  const handleExportDay = useCallback(async (dayLabel: string) => {
    if (!plan) return
    const acts = dayLabel === 'Saturday' ? (plan.saturday || []) : (plan.sunday || [])
    if (acts.length === 0) { Alert.alert('No activities', `No ${dayLabel} activities to export.`); return }
    const accentColor = dayLabel === 'Saturday' ? '#79c0ff' : '#d2a8ff'
    const accentRgb = dayLabel === 'Saturday' ? '121,192,255' : '210,168,255'
    const html = buildExportHtml(dayLabel, acts, accentColor, accentRgb)
    setExportHtml(html)
    setExporting(true)
  }, [plan, buildExportHtml])

  const handleWebViewMessage = useCallback(async (event: any) => {
    setExportHtml(null)
    try {
      const base64 = event.nativeEvent.data.replace(/^data:image\/png;base64,/, '')
      const dayLabel = exporting ? 'weekend' : 'weekend'
      const filename = `${cacheDirectory}mien-plan-${storedDate || 'export'}.png`
      await writeAsStringAsync(filename, base64, { encoding: EncodingType.Base64 })
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(filename, { mimeType: 'image/png' })
      } else {
        Alert.alert('Saved', `Image saved to ${filename}`)
      }
    } catch (err: any) {
      Alert.alert('Export failed', err.message || 'Unknown error')
    }
    setExporting(false)
  }, [storedDate, exporting])

  const filteredSaved = savedList.filter(r => {
    if (venueFilter !== 'All' && (r.venueType || 'restaurant').toLowerCase() !== venueFilter.toLowerCase()) return false
    if (cuisineFilter && r.cuisineCategory !== cuisineFilter) return false
    return true
  })

  const insets = useSafeAreaInsets()

  const dayColors: Record<string, string> = {
    monday: colors.accent.blue,
    tuesday: colors.accent.purple,
    wednesday: colors.accent.green,
    thursday: colors.accent.amber,
    friday: colors.accent.cyan,
    saturday: colors.accent.cyan,
    sunday: colors.accent.purple,
  }

  const planDays = plan ? Object.entries(plan).filter(
    ([_, v]) => Array.isArray(v) && v.length > 0
  ) : []

  return (
    <>
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl * 2 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => {
        setRefreshing(true)
        if (tab === 'events') await handleRefreshEvents()
        else await loadSaved()
        setRefreshing(false)
      }} tintColor={colors.accent.cyan} />}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.title}>Planner</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.savedBtn}
            onPress={() => navigation.navigate('SavedPlans')}
          >
            <Ionicons name="folder-outline" size={18} color={colors.accent.blue} />
            <Text style={styles.savedBtnText}>Saved</Text>
          </TouchableOpacity>
          {plan && tab === 'plan' && (
            <TouchableOpacity
              style={[styles.notionBtn, notionSent && { backgroundColor: colors.accent.green }]}
              onPress={handleNotionPress}
              disabled={pushingNotion || notionSent}
            >
              {pushingNotion ? (
                <NoodleSpinner size={18} color="#fff" />
              ) : (
                <>
                  <Ionicons name={notionSent ? 'checkmark' : 'send'} size={14} color="#fff" />
                  <Text style={styles.notionBtnText}>{notionSent ? 'Sent!' : 'Notion'}</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Tab bar */}
      <View style={styles.tabRow}>
        {(['plan', 'events', 'restaurants'] as Tab[]).map(t => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'plan' ? 'Plan' : t === 'events' ? 'Events' : `Restaurants & Bars${savedList.length > 0 ? ` (${savedList.length})` : ''}`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'plan' ? (
        <>
          {/* Date picker */}
          <View style={styles.card}>
            <Text style={styles.inputLabel}>Select days to plan</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dateStrip}>
              {upcomingDates.map((d) => {
                const dateStr = formatDateISO(d.date)
                const selected = selectedDates.has(dateStr)
                const isToday = formatDateISO(new Date()) === dateStr
                return (
                  <TouchableOpacity
                    key={dateStr}
                    style={[
                      styles.dateChip,
                      selected && styles.dateChipSelected,
                      isToday && !selected && styles.dateChipToday,
                    ]}
                    onPress={() => toggleDate(dateStr)}
                  >
                    <Text style={[styles.dateDayName, selected && styles.dateDayNameSelected]}>
                      {d.dayName}
                    </Text>
                    <Text style={[styles.dateLabel, selected && styles.dateLabelSelected]}>
                      {d.label}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
            {selectedDates.size > 0 && (
              <Text style={styles.selectedCount}>
                {selectedDates.size} day{selectedDates.size !== 1 ? 's' : ''} selected
              </Text>
            )}
          </View>

          {/* Theme chips */}
          <View style={styles.card}>
            <Text style={styles.inputLabel}>Themes (pick any — leave blank for surprise me)</Text>
            <View style={styles.themeRow}>
              {THEME_OPTIONS.map(t => {
                const active = selectedThemes.has(t.id)
                return (
                  <TouchableOpacity
                    key={t.id}
                    style={[styles.themeChip, active && styles.themeChipActive]}
                    onPress={() => setSelectedThemes(prev => {
                      const next = new Set(prev)
                      if (next.has(t.id)) next.delete(t.id)
                      else next.add(t.id)
                      return next
                    })}
                  >
                    <Text style={[styles.themeChipText, active && { color: '#fff' }]}>
                      {t.emoji} {t.label}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.inputLabel}>Route style</Text>
            <View style={styles.themeRow}>
              {LOCATION_STRATEGY_OPTIONS.map(option => {
                const active = locationStrategy === option.id
                return (
                  <TouchableOpacity
                    key={option.id}
                    style={[styles.themeChip, active && styles.themeChipActive]}
                    onPress={() => setLocationStrategy(option.id)}
                  >
                    <Text style={[styles.themeChipText, active && { color: '#fff' }]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </View>
            <Text style={[styles.inputLabel, { marginTop: spacing.md }]}>Discovery</Text>
            <View style={styles.themeRow}>
              {DISCOVERY_MODE_OPTIONS.map(option => {
                const active = discoveryMode === option.id
                return (
                  <TouchableOpacity
                    key={option.id}
                    style={[styles.themeChip, active && styles.themeChipActive]}
                    onPress={() => setDiscoveryMode(option.id)}
                  >
                    <Text style={[styles.themeChipText, active && { color: '#fff' }]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>

          {/* Saved restaurant seeding */}
          {savedList.length > 0 && (
            <View style={styles.card}>
              <View style={styles.savedSeedHeader}>
                <Text style={styles.inputLabel}>
                  Seed with saved restaurants ({selectedSavedIds.size > 0 ? `${selectedSavedIds.size} picked` : 'all saved'})
                </Text>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <TouchableOpacity onPress={() => setSelectedSavedIds(new Set(savedList.map(r => r.id)))}>
                    <Text style={{ fontSize: 11, color: colors.accent.cyan }}>All</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSelectedSavedIds(new Set())}>
                    <Text style={{ fontSize: 11, color: colors.text.muted }}>Clear</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={{ maxHeight: 180 }}>
                <ScrollView nestedScrollEnabled>
                  {savedList.map(r => {
                    const checked = selectedSavedIds.has(r.id)
                    return (
                      <TouchableOpacity
                        key={r.id}
                        style={styles.savedSeedRow}
                        onPress={() => setSelectedSavedIds(prev => {
                          const next = new Set(prev)
                          if (next.has(r.id)) next.delete(r.id)
                          else next.add(r.id)
                          return next
                        })}
                      >
                        <Ionicons
                          name={checked ? 'checkbox' : 'square-outline'}
                          size={18}
                          color={checked ? colors.accent.cyan : colors.text.muted}
                        />
                        <Text style={styles.savedSeedName} numberOfLines={1}>{r.name}</Text>
                        <Text style={styles.savedSeedMeta} numberOfLines={1}>
                          {r.cuisineCategory || r.cuisine || ''}
                        </Text>
                      </TouchableOpacity>
                    )
                  })}
                </ScrollView>
              </View>
            </View>
          )}

          <View style={styles.inputCard}>
            <Text style={styles.inputLabel}>What are you in the mood for?</Text>
            <TextInput
              style={styles.input}
              value={preferences}
              onChangeText={setPreferences}
              placeholder="e.g. outdoor activities, new restaurants, chill day"
              placeholderTextColor={colors.text.muted}
              multiline
            />
            {selectedDates.size > 0 && (
              <WeatherPreviewCard
                preview={weatherPreview}
                loading={weatherLoading}
                compact={selectedDates.size > 2}
              />
            )}
            <TouchableOpacity
              style={[styles.generateBtn, (generating || selectedDates.size === 0) && { opacity: 0.5 }]}
              onPress={handleGenerate}
              disabled={generating || selectedDates.size === 0}
            >
              {generating ? (
                <NoodleSpinner size={18} color="#fff" />
              ) : (
                <Text style={styles.generateText}>
                  Plan {selectedDates.size > 0 ? `${selectedDates.size} Day${selectedDates.size !== 1 ? 's' : ''}` : 'Days'}
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Plan results */}
          {planDays.map(([day, activities]) => (
            <View key={day} style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[styles.dayLabel, { color: dayColors[day.toLowerCase()] || colors.accent.blue, marginBottom: 0 }]}>
                  {day.charAt(0).toUpperCase() + day.slice(1)}
                </Text>
                <TouchableOpacity
                  onPress={() => handleExportDay(day.charAt(0).toUpperCase() + day.slice(1))}
                  disabled={exporting}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: (dayColors[day.toLowerCase()] || colors.accent.blue) + '15' }}
                >
                  <Ionicons name="share-outline" size={14} color={dayColors[day.toLowerCase()] || colors.accent.blue} />
                  <Text style={{ fontSize: 12, color: dayColors[day.toLowerCase()] || colors.accent.blue }}>Share</Text>
                </TouchableOpacity>
              </View>
              {(activities as WeekendActivity[]).map((act, i) => (
                <TouchableOpacity
                  key={i}
                  style={styles.activityRow}
                  onPress={() => navigation.navigate('ActivityDetail', {
                    activity: act,
                    dayLabel: day.charAt(0).toUpperCase() + day.slice(1),
                    dayColor: dayColors[day.toLowerCase()] || colors.accent.blue,
                  })}
                  activeOpacity={0.6}
                >
                  <Text style={styles.activityTime}>{act.time}</Text>
                  <View style={styles.activityBody}>
                    <Text style={styles.activityName}>{act.activity}</Text>
                    {act.location ? <Text style={styles.activityMeta}>{act.location}</Text> : null}
                    <View style={styles.activityTags}>
                      {act.travelTime ? <Text style={styles.tag}>{act.travelTime}</Text> : null}
                      {act.cost ? <Text style={styles.tag}>{act.cost}</Text> : null}
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.text.muted} />
                </TouchableOpacity>
              ))}
            </View>
          ))}

          {notes && (
            <View style={styles.card}>
              <Text style={[styles.dayLabel, { color: colors.text.secondary }]}>Notes</Text>
              <Text style={styles.notesText}>{notes}</Text>
            </View>
          )}

          {!plan && !generating && (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>
                Select days above and tap "Plan" to get an AI itinerary.
              </Text>
            </View>
          )}
        </>
      ) : tab === 'events' ? (
        <>
          {/* Events search */}
          <View style={styles.inputCard}>
            <View style={styles.eventsHeaderRow}>
              <Text style={[styles.inputLabel, { flex: 1, marginBottom: 0 }]}>Find things happening in Chicago</Text>
              <TouchableOpacity
                style={[styles.eventRefreshBtn, searchingEvents && { opacity: 0.5 }]}
                onPress={handleRefreshEvents}
                disabled={searchingEvents}
              >
                {searchingEvents ? (
                  <NoodleSpinner size={14} color={colors.accent.cyan} />
                ) : (
                  <Ionicons name="refresh" size={14} color={colors.accent.cyan} />
                )}
                <Text style={styles.eventRefreshText}>Refresh</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.searchRow}>
              <TextInput
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                value={eventSearch}
                onChangeText={setEventSearch}
                placeholder="e.g. Cubs, comedy, Kendrick Lamar"
                placeholderTextColor={colors.text.muted}
                onSubmitEditing={handleSearchEvents}
                returnKeyType="search"
              />
              <TouchableOpacity
                style={styles.searchBtn}
                onPress={handleSearchEvents}
                disabled={searchingEvents}
              >
                {searchingEvents ? (
                  <NoodleSpinner size={18} color="#fff" />
                ) : (
                  <Ionicons name="search" size={18} color="#fff" />
                )}
              </TouchableOpacity>
            </View>
            <Text style={[styles.inputLabel, { marginTop: spacing.sm, fontSize: 11 }]}>What type of events should Mien elaborate on?</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.genreStrip}>
              {EVENT_FOCUS_OPTIONS.map(focus => {
                const selected = eventFocus === focus
                return (
                  <TouchableOpacity
                    key={focus}
                    style={[styles.genreChip, selected && styles.genreChipActive]}
                    onPress={() => setEventFocus(selected ? '' : focus)}
                  >
                    <Text style={[styles.genreText, selected && styles.genreTextActive]}>{focus}</Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
            <TextInput
              style={[styles.input, { marginBottom: 0, marginTop: spacing.xs }]}
              value={eventDetails}
              onChangeText={setEventDetails}
              placeholder="Optional: neighborhood, vibe, budget, artist, venue..."
              placeholderTextColor={colors.text.muted}
              onSubmitEditing={handleSearchEvents}
              returnKeyType="search"
            />
          </View>

          {/* Date strip */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.genreStrip}>
            <TouchableOpacity
              style={[styles.eventTypeChip, !eventDate && styles.genreChipActive]}
              onPress={() => { setEventDate(null); loadEvents({ date: null, page: 0 }) }}
            >
              <Ionicons name="infinite-outline" size={14} color={!eventDate ? colors.accent.cyan : colors.text.muted} />
              <Text style={[styles.genreText, !eventDate && styles.genreTextActive]}>Any date</Text>
            </TouchableOpacity>
            {upcomingDates.map(d => {
              const dateStr = formatDateISO(d.date)
              const selected = eventDate === dateStr
              return (
                <TouchableOpacity
                  key={dateStr}
                  style={[styles.eventTypeChip, selected && styles.genreChipActive]}
                  onPress={() => { setEventDate(dateStr); loadEvents({ date: dateStr, page: 0 }) }}
                >
                  <Text style={[styles.genreText, selected && styles.genreTextActive]}>
                    {d.dayName} {d.label}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </ScrollView>

          {/* Event type chips */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.genreStrip}>
            {EVENT_CATEGORIES.map(category => (
              <TouchableOpacity
                key={category.id}
                style={[styles.eventTypeChip, selectedEventCategory === category.id && styles.genreChipActive]}
                onPress={() => handleSelectEventCategory(category.id)}
              >
                <Ionicons
                  name={category.icon}
                  size={14}
                  color={selectedEventCategory === category.id ? colors.accent.cyan : colors.text.muted}
                />
                <Text style={[styles.genreText, selectedEventCategory === category.id && styles.genreTextActive]}>
                  {category.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Music subgenre chips */}
          {selectedEventCategory === 'music' && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.genreStrip}>
              {MUSIC_GENRES.map(genre => (
                <TouchableOpacity
                  key={genre}
                  style={[styles.genreChip, selectedMusicGenre === genre && styles.genreChipActive]}
                  onPress={() => handleSelectMusicGenre(genre)}
                >
                  <Text style={[styles.genreText, selectedMusicGenre === genre && styles.genreTextActive]}>
                    {genre}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {!eventsLoaded && !searchingEvents && (
            <View style={styles.emptyCard}>
              <Ionicons name="calendar-outline" size={40} color={colors.text.muted} />
              <Text style={styles.emptyText}>
                Tap a category or refresh to browse concerts, shows, sports, festivals, and other upcoming Chicago events.
              </Text>
            </View>
          )}

          {searchingEvents && (
            <View style={{ marginTop: spacing.lg, alignItems: 'center' }}>
              <NoodleSpinner color={colors.accent.cyan} size={28} />
            </View>
          )}

          {events.length > 0 && (
            <View style={styles.card}>
              <Text style={[styles.dayLabel, { color: colors.accent.amber }]}>
                {events.length} Event{events.length !== 1 ? 's' : ''} Found
              </Text>
              {events.map((e, i) => (
                <TouchableOpacity
                  key={i}
                  style={styles.eventCard}
                  onPress={() => e.url ? Linking.openURL(e.url) : null}
                  activeOpacity={0.7}
                >
                  <View style={styles.eventHeader}>
                    <Text style={styles.eventName}>{e.name}</Text>
                    {e.genre && (
                      <Text style={styles.genreBadge}>{e.genre}</Text>
                    )}
                  </View>
                  <Text style={styles.eventMeta}>
                    {e.venue} — {e.date} {e.time ? `at ${e.time}` : ''}
                  </Text>
                  <View style={styles.eventTags}>
                    <Text style={styles.eventCategory}>{e.category}</Text>
                    {e.priceRange ? <Text style={styles.eventPrice}>{e.priceRange}</Text> : null}
                  </View>
                  {e.description ? (
                    <Text style={styles.eventDesc} numberOfLines={2}>{e.description}</Text>
                  ) : null}
                  <Text style={styles.eventLink}>View on Ticketmaster</Text>
                </TouchableOpacity>
              ))}
              {eventTotalPages > 0 && eventPage + 1 < eventTotalPages && (
                <TouchableOpacity
                  style={[styles.loadMoreEventsBtn, loadingMoreEvents && { opacity: 0.5 }]}
                  onPress={handleLoadMoreEvents}
                  disabled={loadingMoreEvents}
                >
                  {loadingMoreEvents ? (
                    <NoodleSpinner size={16} color={colors.accent.cyan} />
                  ) : (
                    <Ionicons name="add-circle-outline" size={16} color={colors.accent.cyan} />
                  )}
                  <Text style={styles.loadMoreEventsText}>Fetch more events</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {eventsLoaded && events.length === 0 && !searchingEvents && (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No events found. Try a different search or category.</Text>
            </View>
          )}
        </>
      ) : (
        <>
          {/* Restaurant search + add */}
          <View style={styles.inputCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm }}>
              <Text style={styles.inputLabel}>Restaurants & Bars</Text>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.accent.green, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
                onPress={() => setShowAddForm(!showAddForm)}
              >
                <Ionicons name={showAddForm ? 'close' : 'add'} size={14} color="#fff" />
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#fff' }}>{showAddForm ? 'Cancel' : 'Add'}</Text>
              </TouchableOpacity>
            </View>
            <View style={{ zIndex: 10 }}>
              <View style={styles.searchRow}>
                <TextInput
                  style={[styles.input, { flex: 1, marginBottom: 0 }]}
                  value={searchQuery}
                  onChangeText={handleSearchInputChange}
                  placeholder="Search restaurants..."
                  placeholderTextColor={colors.text.muted}
                  onSubmitEditing={handleSearch}
                  returnKeyType="search"
                />
                <TouchableOpacity
                  style={styles.searchBtn}
                  onPress={handleSearch}
                  disabled={searching}
                >
                  {searching ? (
                    <NoodleSpinner size={18} color="#fff" />
                  ) : (
                    <Ionicons name="search" size={18} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
              {suggestions.length > 0 && (
                <View style={{
                  backgroundColor: colors.bg.card,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: colors.border,
                  marginTop: 4,
                  overflow: 'hidden',
                }}>
                  {suggestions.map((s) => (
                    <TouchableOpacity
                      key={s.placeId}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.border,
                      }}
                      onPress={() => handleSelectSuggestion(s)}
                    >
                      <Text style={{ color: colors.text.primary, fontSize: 14, fontWeight: '500' }}>{s.name}</Text>
                      {s.description ? (
                        <Text style={{ color: colors.text.muted, fontSize: 12, marginTop: 2 }}>{s.description}</Text>
                      ) : null}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          </View>

          {/* Manual add form */}
          {showAddForm && (
            <View style={styles.card}>
              <Text style={[styles.dayLabel, { color: colors.accent.green }]}>Add Manually</Text>
              <TextInput
                style={[styles.input, { marginBottom: spacing.sm }]}
                value={newName}
                onChangeText={setNewName}
                placeholder="Restaurant name *"
                placeholderTextColor={colors.text.muted}
              />
              <TextInput
                style={[styles.input, { marginBottom: spacing.sm }]}
                value={newAddress}
                onChangeText={setNewAddress}
                placeholder="Address"
                placeholderTextColor={colors.text.muted}
              />
              <Text style={{ fontSize: 11, color: colors.text.muted, marginBottom: 4 }}>Type</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.sm }}>
                {VENUE_TYPES.filter(v => v !== 'All').map(v => (
                  <TouchableOpacity key={v}
                    style={[styles.genreChip, newVenueType === v.toLowerCase() && { backgroundColor: venueTypeColor(v) }]}
                    onPress={() => setNewVenueType(v.toLowerCase())}
                  >
                    <Text style={[styles.genreText, newVenueType === v.toLowerCase() && { color: '#fff' }]}>{v}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <Text style={{ fontSize: 11, color: colors.text.muted, marginBottom: 4 }}>Cuisine</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.sm }}>
                {CUISINE_CATEGORIES.map(c => (
                  <TouchableOpacity key={c}
                    style={[styles.genreChip, newCuisine === c && styles.genreChipActive]}
                    onPress={() => setNewCuisine(newCuisine === c ? '' : c)}
                  >
                    <Text style={[styles.genreText, newCuisine === c && styles.genreTextActive]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <Text style={{ fontSize: 11, color: colors.text.muted, marginBottom: 4 }}>Spice Level</Text>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: spacing.sm }}>
                {SPICE_LEVELS.map(sp => (
                  <TouchableOpacity key={sp}
                    style={[styles.genreChip, newSpice === sp && { backgroundColor: colors.accent.red }]}
                    onPress={() => setNewSpice(newSpice === sp ? '' : sp)}
                  >
                    <Text style={[styles.genreText, newSpice === sp && { color: '#fff' }]}>{sp}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={{ fontSize: 11, color: colors.text.muted, marginBottom: 4 }}>Price</Text>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: spacing.sm }}>
                {PRICE_OPTIONS.map(p => (
                  <TouchableOpacity key={p}
                    style={[styles.genreChip, newPrice === p && { backgroundColor: colors.accent.green }]}
                    onPress={() => setNewPrice(newPrice === p ? null : p)}
                  >
                    <Text style={[styles.genreText, newPrice === p && { color: '#fff' }]}>{'$'.repeat(p)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                style={[styles.input, { marginBottom: spacing.md }]}
                value={newNotes}
                onChangeText={setNewNotes}
                placeholder="Notes (optional)"
                placeholderTextColor={colors.text.muted}
              />
              <TouchableOpacity style={styles.generateBtn} onPress={handleAddManual}>
                <Text style={styles.generateText}>Save Restaurant</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Venue type filter */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.genreStrip}>
            {VENUE_TYPES.map(v => (
              <TouchableOpacity key={v}
                style={[styles.genreChip, venueFilter === v && styles.genreChipActive]}
                onPress={() => setVenueFilter(v)}
              >
                <Text style={[styles.genreText, venueFilter === v && styles.genreTextActive]}>{v}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* AI Discover — trending / newly-opened */}
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm }}>
              <Text style={[styles.dayLabel, { color: colors.accent.purple, marginBottom: 0 }]}>
                AI Discover
              </Text>
              <TouchableOpacity
                onPress={handleDiscoverTrending}
                disabled={discovering}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 5,
                  paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                  borderWidth: 1, borderColor: colors.accent.purple,
                  backgroundColor: colors.bg.tertiary, opacity: discovering ? 0.5 : 1,
                }}
              >
                {discovering
                  ? <ActivityIndicator size="small" color={colors.accent.purple} />
                  : <Ionicons name="trending-up" size={14} color={colors.accent.purple} />}
                <Text style={{ color: colors.accent.purple, fontSize: 12, fontWeight: '600' }}>
                  Trending & new
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 11, color: colors.text.muted }}>
              Searches the web for buzzy, recently-opened spots not already saved.
            </Text>

            {discoverError && (
              <Text style={{ fontSize: 12, color: colors.accent.red, marginTop: spacing.sm }}>
                {discoverError}
              </Text>
            )}

            {discoverResults && discoverResults.map((s, i) => (
              <View key={i} style={{ backgroundColor: colors.bg.tertiary, borderRadius: 10, padding: 12, marginTop: spacing.sm }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text.primary }}>{s.name}</Text>
                    {!!s.address && (
                      <Text style={{ fontSize: 11, color: colors.text.muted, marginTop: 2 }}>{s.address}</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => handleAddTrending(s)}
                    disabled={s._added}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 4,
                      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                      backgroundColor: s._added ? colors.accent.green : colors.accent.purple,
                    }}
                  >
                    <Ionicons name={s._added ? 'checkmark' : 'add'} size={13} color="#fff" />
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{s._added ? 'Added' : 'Add'}</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, alignItems: 'center' }}>
                  {typeof s.priceLevel === 'number' && s.priceLevel > 0 && (
                    <Text style={{ fontSize: 12, fontWeight: '600', color: colors.accent.green }}>{'$'.repeat(s.priceLevel)}</Text>
                  )}
                  {!!s.cuisineCategory && (
                    <Text style={{ fontSize: 10, color: colors.text.secondary, backgroundColor: colors.bg.secondary, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                      {s.cuisineCategory}
                    </Text>
                  )}
                  {!!s.bookingAdvance && (
                    <Text style={{ fontSize: 10, color: colors.accent.purple }}>{s.bookingAdvance}</Text>
                  )}
                </View>
                {!!s.description && (
                  <Text style={{ fontSize: 11, color: colors.text.secondary, marginTop: 6, lineHeight: 16 }}>{s.description}</Text>
                )}
                {!!s.whyRecommended && (
                  <Text style={{ fontSize: 11, color: colors.accent.purple, marginTop: 4, fontStyle: 'italic' }}>{s.whyRecommended}</Text>
                )}
              </View>
            ))}
          </View>

          {/* Search results */}
          {searchResults.length > 0 && (
            <View style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[styles.dayLabel, { color: colors.accent.cyan }]}>Results</Text>
                <TouchableOpacity
                  onPress={() => { setSearchResults([]); setSearchQuery('') }}
                  style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, backgroundColor: colors.bg.tertiary }}
                >
                  <Text style={{ color: colors.text.muted, fontSize: 12, fontWeight: '500' }}>Clear</Text>
                </TouchableOpacity>
              </View>
              {searchResults.map((r) => (
                <RestaurantCard
                  key={r.placeId}
                  restaurant={r}
                  onSave={() => handleSaveRestaurant(r)}
                  onRemove={() => handleRemoveRestaurant(r.placeId)}
                />
              ))}
            </View>
          )}

          {/* Saved restaurants */}
          {filteredSaved.length > 0 && (
            <View style={styles.card}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md }}>
                <Text style={[styles.dayLabel, { color: colors.accent.amber, marginBottom: 0 }]}>
                  Saved ({filteredSaved.length}{venueFilter !== 'All' ? ` ${venueFilter}` : ''})
                </Text>
                <View style={{ flexDirection: 'row', borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}>
                  <TouchableOpacity
                    onPress={() => setRestaurantView('list')}
                    style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: restaurantView === 'list' ? colors.accent.blue : 'transparent' }}
                  >
                    <Ionicons name="list-outline" size={16} color={restaurantView === 'list' ? '#fff' : colors.text.muted} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setRestaurantView('map')}
                    style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: restaurantView === 'map' ? colors.accent.blue : 'transparent' }}
                  >
                    <Ionicons name="map-outline" size={16} color={restaurantView === 'map' ? '#fff' : colors.text.muted} />
                  </TouchableOpacity>
                </View>
              </View>

              {restaurantView === 'map' ? (
                <StaticPlacesMap places={filteredSaved} />
              ) : (
                filteredSaved.map((r) => (
                  <SavedRestaurantCard
                    key={r.placeId}
                    restaurant={r}
                    onRemove={() => handleRemoveRestaurant(r.placeId)}
                    onRate={(rating) => handleRate(r.placeId, rating)}
                    onSaveVisit={(rating, visitDate, notes, visitId) => handleSaveVisit(r.placeId, rating, visitDate, notes, visitId)}
                    onRemoveVisit={handleRemoveVisit}
                    onEdit={() => setEditingRestaurant(r)}
                  />
                ))
              )}
            </View>
          )}

          {filteredSaved.length === 0 && searchResults.length === 0 && !searching && (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>
                {savedList.length > 0
                  ? 'No restaurants match the current filter.'
                  : 'Search for restaurants or tap "Add" to enter manually.\nSaved restaurants will be included in AI itineraries.'}
              </Text>
            </View>
          )}
        </>
      )}
    </ScrollView>

    {/* Edit Restaurant Modal */}
    {editingRestaurant && (
      <EditRestaurantModal
        restaurant={editingRestaurant}
        onSave={(updates) => handleSaveEdit(editingRestaurant.placeId, updates)}
        onClose={() => setEditingRestaurant(null)}
      />
    )}

    {/* Hidden WebView for Canvas image export */}
    {exportHtml && (
      <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}>
        <WebView
          ref={webviewRef}
          originWhitelist={['*']}
          source={{ html: exportHtml }}
          onMessage={handleWebViewMessage}
          javaScriptEnabled
        />
      </View>
    )}
    </>
  )
}

function EditRestaurantModal({ restaurant: r, onSave, onClose }: {
  restaurant: SavedRestaurant
  onSave: (updates: Record<string, any>) => void
  onClose: () => void
}) {
  const [notes, setNotes] = useState(r.notes || '')
  const [description, setDescription] = useState(r.description || '')
  const [cuisineCategory, setCuisineCategory] = useState(r.cuisineCategory || '')
  const [spiceLevel, setSpiceLevel] = useState(r.spiceLevel || '')
  const [venueType, setVenueType] = useState(r.venueType || 'restaurant')
  const [reservationLink, setReservationLink] = useState(r.reservationLink || '')
  const [peakTimes, setPeakTimes] = useState(r.peakTimes || '')
  const [priceLevel, setPriceLevel] = useState(r.priceLevel || 0)

  const VENUE_TYPES = ['restaurant', 'bar', 'dessert', 'cafe']
  const SPICE_LEVELS = ['', 'mild', 'medium', 'spicy', 'very-spicy']
  const PRICE_OPTIONS = [0, 1, 2, 3, 4]

  const handleSave = () => {
    onSave({ notes, description, cuisineCategory, spiceLevel: spiceLevel || null, venueType, reservationLink: reservationLink || null, peakTimes: peakTimes || null, priceLevel: priceLevel || null })
  }

  return (
    <Modal visible animationType="slide" transparent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.bg.primary, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.md, borderBottomWidth: 0.5, borderBottomColor: colors.border }}>
              <TouchableOpacity onPress={onClose}>
                <Text style={{ fontSize: 15, color: colors.text.muted }}>Cancel</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text.primary }}>{r.name}</Text>
              <TouchableOpacity onPress={handleSave}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: colors.accent.cyan }}>Save</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ padding: spacing.md }} keyboardShouldPersistTaps="handled">
              {/* Venue Type */}
              <Text style={editStyles.label}>Venue Type</Text>
              <View style={{ flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md, flexWrap: 'wrap' }}>
                {VENUE_TYPES.map(t => (
                  <TouchableOpacity key={t} onPress={() => setVenueType(t)}
                    style={[editStyles.chip, venueType === t && { backgroundColor: colors.accent.cyan + '30', borderColor: colors.accent.cyan }]}>
                    <Text style={[editStyles.chipText, venueType === t && { color: colors.accent.cyan }]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Cuisine */}
              <Text style={editStyles.label}>Cuisine</Text>
              <TextInput value={cuisineCategory} onChangeText={setCuisineCategory}
                placeholder="e.g. Italian, Korean, Mexican" placeholderTextColor={colors.text.muted}
                style={editStyles.input} />

              {/* Price Level */}
              <Text style={editStyles.label}>Price</Text>
              <View style={{ flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md }}>
                {PRICE_OPTIONS.map(p => (
                  <TouchableOpacity key={p} onPress={() => setPriceLevel(p)}
                    style={[editStyles.chip, priceLevel === p && { backgroundColor: colors.accent.amber + '30', borderColor: colors.accent.amber }]}>
                    <Text style={[editStyles.chipText, priceLevel === p && { color: colors.accent.amber }]}>{p === 0 ? '?' : '$'.repeat(p)}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Spice Level */}
              <Text style={editStyles.label}>Spice Level</Text>
              <View style={{ flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md, flexWrap: 'wrap' }}>
                {SPICE_LEVELS.map(s => (
                  <TouchableOpacity key={s} onPress={() => setSpiceLevel(s)}
                    style={[editStyles.chip, spiceLevel === s && { backgroundColor: colors.accent.red + '30', borderColor: colors.accent.red }]}>
                    <Text style={[editStyles.chipText, spiceLevel === s && { color: colors.accent.red }]}>{s || 'None'}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Description */}
              <Text style={editStyles.label}>Description</Text>
              <TextInput value={description} onChangeText={setDescription}
                placeholder="Short description..." placeholderTextColor={colors.text.muted}
                multiline numberOfLines={2} style={[editStyles.input, { minHeight: 60, textAlignVertical: 'top' }]} />

              {/* Notes */}
              <Text style={editStyles.label}>Personal Notes</Text>
              <TextInput value={notes} onChangeText={setNotes}
                placeholder="Your notes..." placeholderTextColor={colors.text.muted}
                multiline numberOfLines={3} style={[editStyles.input, { minHeight: 80, textAlignVertical: 'top' }]} />

              {/* Reservation Link */}
              <Text style={editStyles.label}>Reservation Link</Text>
              <TextInput value={reservationLink} onChangeText={setReservationLink}
                placeholder="https://..." placeholderTextColor={colors.text.muted}
                autoCapitalize="none" keyboardType="url" style={editStyles.input} />

              {/* Peak Times */}
              <Text style={editStyles.label}>Peak Times</Text>
              <TextInput value={peakTimes} onChangeText={setPeakTimes}
                placeholder="e.g. Fri-Sat 7-9pm" placeholderTextColor={colors.text.muted}
                style={editStyles.input} />

              <View style={{ height: 40 }} />
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const editStyles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: colors.text.secondary, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.bg.secondary, color: colors.text.primary, borderRadius: 8,
    padding: spacing.sm, fontSize: 14, marginBottom: spacing.md,
    borderWidth: 0.5, borderColor: colors.border,
  },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
    borderWidth: 1, borderColor: colors.border,
  },
  chipText: { fontSize: 13, color: colors.text.secondary, textTransform: 'capitalize' },
})

function RestaurantCard({ restaurant: r, onSave, onRemove }: {
  restaurant: Restaurant
  onSave: () => void
  onRemove: () => void
}) {
  const [showLinks, setShowLinks] = useState(false)

  return (
    <View style={styles.restaurantCard}>
      <View style={styles.restaurantHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.restaurantName}>{r.name}</Text>
          <Text style={styles.restaurantAddress}>{r.address}</Text>
        </View>
        <TouchableOpacity onPress={r.saved ? onRemove : onSave} style={styles.heartBtn}>
          <Ionicons
            name={r.saved ? 'heart' : 'heart-outline'}
            size={22}
            color={r.saved ? colors.accent.red : colors.text.muted}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.restaurantMeta}>
        {r.rating ? (
          <Text style={styles.ratingBadge}>{r.rating.toFixed(1)} ({r.totalRatings})</Text>
        ) : null}
        {r.priceLevel ? (
          <Text style={styles.priceBadge}>{priceLevelLabel(r.priceLevel)}</Text>
        ) : null}
        {r.distance ? (
          <Text style={styles.distanceBadge}>{r.distance}</Text>
        ) : null}
        {r.openNow !== null ? (
          <Text style={[styles.openBadge, { color: r.openNow ? colors.accent.green : colors.accent.red }]}>
            {r.openNow ? 'Open' : 'Closed'}
          </Text>
        ) : null}
      </View>

      {r.cuisine.length > 0 && (
        <View style={styles.cuisineRow}>
          {r.cuisine.map((c, i) => (
            <Text key={i} style={styles.cuisineTag}>{c}</Text>
          ))}
        </View>
      )}

      {r.bookingAdvance && (
        <View style={styles.bookingRow}>
          <Ionicons name="calendar-outline" size={14} color={colors.accent.purple} />
          <Text style={styles.bookingAdvance}>Book {r.bookingAdvance} in advance</Text>
        </View>
      )}

      <TouchableOpacity onPress={() => setShowLinks(!showLinks)} style={styles.bookingToggle}>
        <Text style={styles.bookingToggleText}>{showLinks ? 'Hide Links' : 'Book / Directions'}</Text>
      </TouchableOpacity>

      {showLinks && <BookingLinks name={r.name} lat={r.lat} lng={r.lng} />}
    </View>
  )
}

function formatBookingAdvanceLabel(r: SavedRestaurant): string {
  if (typeof r.bookingAdvanceDays === 'number') {
    if (r.bookingAdvanceDays <= 0) return 'Walk-in / no reservation needed'
    if (r.bookingAdvanceDays >= 14) {
      const weeks = Math.round(r.bookingAdvanceDays / 7)
      return `Book ~${weeks} week${weeks > 1 ? 's' : ''} ahead`
    }
    return `Book ~${r.bookingAdvanceDays} day${r.bookingAdvanceDays > 1 ? 's' : ''} ahead`
  }
  return `Book ${r.bookingAdvance} in advance`
}

function busyCellColor(level: number): string {
  if (level >= 0.85) return colors.accent.red
  if (level >= 0.65) return '#ff9f0a'
  if (level >= 0.40) return colors.accent.amber
  if (level >= 0.20) return colors.accent.green
  return colors.bg.secondary
}

function BusyDaysHeatmap({ matrix }: { matrix: BusyDaysMatrix }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.xs }}>
      <Text style={{ fontSize: 9, color: colors.text.muted, letterSpacing: 0.5 }}>BUSY</Text>
      <View style={{ flexDirection: 'row', gap: 2 }}>
        {DAYS_OF_WEEK.map(day => {
          const entry = matrix[day]
          if (!entry) {
            return (
              <View key={day} style={{
                width: 22, height: 22, borderRadius: 4, backgroundColor: colors.bg.tertiary,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Text style={{ fontSize: 9, color: colors.text.muted, fontWeight: '600' }}>{day[0]}</Text>
              </View>
            )
          }
          return (
            <View key={day} style={{
              width: 22, height: 22, borderRadius: 4, backgroundColor: busyCellColor(entry.level),
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Text style={{
                fontSize: 9,
                color: entry.level >= 0.4 ? '#fff' : colors.text.secondary,
                fontWeight: '600',
              }}>{day[0]}</Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

function SavedRestaurantCard({ restaurant: r, onRemove, onRate, onSaveVisit, onRemoveVisit, onEdit }: {
  restaurant: SavedRestaurant
  onRemove: () => void
  onRate: (rating: number) => void
  onSaveVisit?: (rating: number | null, visitDate: string, notes: string, visitId?: number) => void
  onRemoveVisit?: (visitId: number) => void
  onEdit?: () => void
}) {
  const [showLinks, setShowLinks] = useState(false)
  const [showVisitForm, setShowVisitForm] = useState(false)
  const [showVisits, setShowVisits] = useState(false)
  const [showAllVisits, setShowAllVisits] = useState(false)
  const today = new Date().toISOString().split('T')[0]
  const todaysVisit = r.visits?.find(v => v.visitDate === today)
  const [editingVisitId, setEditingVisitId] = useState<number | null>(null)
  const [selectedVisitId, setSelectedVisitId] = useState<number | null>(todaysVisit?.id ?? r.visits?.[0]?.id ?? null)
  const [visitDate, setVisitDate] = useState(today)
  const [visitRating, setVisitRating] = useState<number | null>(todaysVisit?.rating ?? null)
  const [visitNotes, setVisitNotes] = useState(todaysVisit?.notes || '')
  const vColor = venueTypeColor(r.venueType || 'restaurant')
  const visits = r.visits || []
  const activeVisit = editingVisitId != null
    ? visits.find(v => v.id === editingVisitId)
    : visits.find(v => v.visitDate === visitDate)
  const selectedVisit = visits.find(v => v.id === selectedVisitId) ?? todaysVisit ?? visits[0]
  const visibleVisits = showAllVisits ? visits : visits.slice(0, 3)
  const hiddenVisitCount = Math.max(0, visits.length - visibleVisits.length)

  useEffect(() => {
    setVisitRating(todaysVisit?.rating ?? null)
    setVisitNotes(todaysVisit?.notes || '')
    if (!editingVisitId) setVisitDate(today)
  }, [todaysVisit?.id, todaysVisit?.rating, todaysVisit?.notes, today, editingVisitId])

  const resetVisitForm = () => {
    setEditingVisitId(null)
    setVisitDate(today)
    setVisitRating(todaysVisit?.rating ?? null)
    setVisitNotes(todaysVisit?.notes || '')
  }

  const startVisitForm = () => {
    resetVisitForm()
    setShowVisitForm(true)
  }

  const editVisit = (visit: RestaurantVisit) => {
    setEditingVisitId(visit.id)
    setSelectedVisitId(visit.id)
    setVisitDate(visit.visitDate)
    setVisitRating(visit.rating)
    setVisitNotes(visit.notes || '')
    setShowVisitForm(true)
    setShowVisits(true)
  }

  return (
    <View style={styles.restaurantCard}>
      <View style={styles.restaurantHeader}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={styles.restaurantName}>{r.name}</Text>
            {r.venueType && r.venueType !== 'restaurant' && (
              <Text style={{ fontSize: 10, fontWeight: '600', color: '#fff', backgroundColor: vColor, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' }}>
                {r.venueType.charAt(0).toUpperCase() + r.venueType.slice(1)}
              </Text>
            )}
            {r.visited && (
              <Ionicons name="checkmark-circle" size={14} color={colors.accent.green} />
            )}
            {visits.length > 0 && (
              <Text style={{ fontSize: 10, color: colors.text.muted }}>
                {visits.length} visit{visits.length !== 1 ? 's' : ''}
              </Text>
            )}
          </View>
          <Text style={styles.restaurantAddress}>{r.address}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing.xs }}>
          {onEdit && (
            <TouchableOpacity onPress={onEdit} style={styles.heartBtn}>
              <Ionicons name="create-outline" size={20} color={colors.accent.cyan} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onRemove} style={styles.heartBtn}>
            <Ionicons name="heart" size={22} color={colors.accent.red} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.restaurantMeta}>
        {r.rating ? (
          <Text style={styles.ratingBadge}>{r.rating.toFixed(1)}</Text>
        ) : null}
        {r.priceLevel ? (
          <Text style={styles.priceBadge}>{priceLevelLabel(r.priceLevel)}</Text>
        ) : null}
        {r.cuisineCategory ? (
          <Text style={styles.cuisineTag}>{r.cuisineCategory}</Text>
        ) : r.cuisine ? (
          <Text style={styles.cuisineTag}>{r.cuisine}</Text>
        ) : null}
        {r.spiceLevel && r.spiceLevel !== 'None' ? (
          <Text style={{ fontSize: 11, color: colors.accent.red, backgroundColor: colors.accent.red + '18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, overflow: 'hidden' }}>
            {r.spiceLevel}
          </Text>
        ) : null}
      </View>

      {r.description ? (
        <Text style={{ fontSize: 12, color: colors.text.secondary, marginTop: spacing.xs, lineHeight: 18 }} numberOfLines={2}>
          {r.description}
        </Text>
      ) : null}

      {(r.bookingAdvanceDays != null || r.bookingAdvance || r.peakTimes) ? (
        <View style={{ marginTop: spacing.xs }}>
          {(r.bookingAdvanceDays != null || r.bookingAdvance) ? (
            <View style={styles.bookingRow}>
              <Ionicons name="calendar-outline" size={14} color={colors.accent.purple} />
              <Text style={styles.bookingAdvance}>{formatBookingAdvanceLabel(r)}</Text>
            </View>
          ) : null}
          {r.peakTimes && !r.busyDaysMatrix ? (
            <View style={[styles.bookingRow, { marginTop: 2 }]}>
              <Ionicons name="time-outline" size={14} color={colors.accent.amber} />
              <Text style={{ fontSize: 12, color: colors.accent.amber }}>Peak: {r.peakTimes}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {r.busyDaysMatrix ? (
        <BusyDaysHeatmap matrix={r.busyDaysMatrix} />
      ) : null}

      {/* Star rating */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: spacing.sm, flexWrap: 'wrap' }}>
        {r.averageRating != null ? (
          <Text style={{ fontSize: 11, color: colors.text.muted }}>My avg {r.averageRating.toFixed(1)}/5</Text>
        ) : null}
        {r.visitDate ? (
          <Text style={{ fontSize: 10, color: colors.text.muted }}>Visited {r.visitDate}</Text>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' }}>
        <TouchableOpacity
          onPress={showVisitForm ? () => setShowVisitForm(false) : startVisitForm}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 6,
            backgroundColor: showVisitForm ? colors.bg.secondary : colors.accent.amber,
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: '600', color: showVisitForm ? colors.text.muted : '#fff' }}>
            {showVisitForm ? 'Hide visit form' : todaysVisit ? 'Edit today visit' : 'Log visit'}
          </Text>
        </TouchableOpacity>
        {visits.length > 0 && (
          <TouchableOpacity onPress={() => setShowVisits(!showVisits)} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Ionicons name={showVisits ? 'chevron-up' : 'chevron-down'} size={13} color={colors.text.muted} />
            <Text style={{ fontSize: 11, color: colors.text.muted }}>{showVisits ? 'Hide' : 'View'} past reviews</Text>
          </TouchableOpacity>
        )}
      </View>

      {showVisitForm && (
        <View style={{ marginTop: spacing.sm, padding: spacing.sm, borderRadius: 8, backgroundColor: colors.bg.secondary, borderWidth: 0.5, borderColor: colors.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
            <TextInput
              value={visitDate}
              onChangeText={(nextDate) => {
                const existing = visits.find(v => v.visitDate === nextDate)
                setVisitDate(nextDate)
                setEditingVisitId(existing?.id ?? null)
                setSelectedVisitId(existing?.id ?? selectedVisitId)
                setVisitRating(existing?.rating ?? null)
                setVisitNotes(existing?.notes || '')
              }}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.text.muted}
              style={[editStyles.input, { width: 118, marginBottom: 0, paddingVertical: 6, fontSize: 12 }]}
            />
            <View style={{ flexDirection: 'row', gap: 2 }}>
              {[1, 2, 3, 4, 5].map(star => (
                <TouchableOpacity key={star} onPress={() => setVisitRating(star)}>
                  <Ionicons
                    name={visitRating && visitRating >= star ? 'star' : 'star-outline'}
                    size={20}
                    color={visitRating && visitRating >= star ? colors.accent.amber : colors.text.muted}
                  />
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              disabled={!visitDate || visitRating == null}
              onPress={() => onSaveVisit?.(visitRating, visitDate, visitNotes, activeVisit?.id)}
              style={{ marginLeft: 'auto', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.accent.amber, opacity: !visitDate || visitRating == null ? 0.4 : 1 }}
            >
              <Text style={{ fontSize: 11, fontWeight: '600', color: '#fff' }}>{activeVisit ? 'Update' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            value={visitNotes}
            onChangeText={setVisitNotes}
            placeholder="What was good, what to order, who to bring..."
            placeholderTextColor={colors.text.muted}
            multiline
            numberOfLines={3}
            style={[editStyles.input, { marginTop: spacing.sm, marginBottom: 0, minHeight: 72, textAlignVertical: 'top' }]}
          />
        </View>
      )}

      {showVisits && visits.length > 0 && (
        <View style={{ marginTop: spacing.sm, gap: 6 }}>
          {visibleVisits.map(v => (
            <TouchableOpacity
              key={v.id}
              onPress={() => setSelectedVisitId(v.id)}
              style={{
                padding: spacing.sm,
                borderRadius: 8,
                backgroundColor: selectedVisit?.id === v.id ? colors.accent.blue + '22' : colors.bg.secondary,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Text style={{ fontSize: 11, color: colors.text.muted }}>{v.visitDate}</Text>
                {v.rating != null && (
                  <Text style={{ fontSize: 11, color: colors.accent.amber }}>★ {v.rating}/5</Text>
                )}
                <Text style={{ flex: 1, fontSize: 11, color: colors.text.secondary }} numberOfLines={1}>
                  {v.notes || 'No review notes'}
                </Text>
                <Ionicons name="chevron-forward" size={13} color={colors.text.muted} />
              </View>
            </TouchableOpacity>
          ))}
          {selectedVisit && (
            <View style={{ padding: spacing.sm, borderRadius: 8, backgroundColor: colors.bg.secondary, borderWidth: 0.5, borderColor: colors.border }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Text style={{ fontSize: 11, color: colors.text.muted }}>{selectedVisit.visitDate}</Text>
                  {selectedVisit.rating != null && <Text style={{ fontSize: 11, color: colors.accent.amber }}>★ {selectedVisit.rating}/5</Text>}
                </View>
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <TouchableOpacity onPress={() => editVisit(selectedVisit)}>
                    <Ionicons name="create-outline" size={16} color={colors.text.muted} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => onRemoveVisit?.(selectedVisit.id)}>
                    <Ionicons name="trash-outline" size={16} color={colors.text.muted} />
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={{ fontSize: 12, color: selectedVisit.notes ? colors.text.secondary : colors.text.muted, lineHeight: 18, marginTop: spacing.xs }}>
                {selectedVisit.notes || 'No review notes saved for this visit.'}
              </Text>
            </View>
          )}
          {visits.length > 3 && (
            <TouchableOpacity onPress={() => setShowAllVisits(!showAllVisits)} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Ionicons name={showAllVisits ? 'chevron-up' : 'chevron-down'} size={13} color={colors.text.muted} />
              <Text style={{ fontSize: 11, color: colors.text.muted }}>
                {showAllVisits ? 'Show latest 3' : `Show ${hiddenVisitCount} more visit${hiddenVisitCount !== 1 ? 's' : ''}`}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {r.notes && (
        <Text style={styles.restaurantNotes}>{r.notes}</Text>
      )}

      <TouchableOpacity onPress={() => setShowLinks(!showLinks)} style={styles.bookingToggle}>
        <Text style={styles.bookingToggleText}>{showLinks ? 'Hide Links' : 'Book / Directions'}</Text>
      </TouchableOpacity>

      {showLinks && <BookingLinks name={r.name} lat={r.lat} lng={r.lng} reservationLink={r.reservationLink} />}
    </View>
  )
}

function BookingLinks({ name, lat, lng, reservationLink }: { name: string; lat: number; lng: number; reservationLink?: string | null }) {
  return (
    <View style={styles.linkRow}>
      {reservationLink ? (
        <LinkButton label="Reserve" onPress={() => Linking.openURL(reservationLink)} color={colors.accent.green} />
      ) : null}
      <LinkButton label="OpenTable" onPress={() => openBooking(name)} color={colors.accent.red} />
      <LinkButton label="Resy" onPress={() => openResyBooking(name)} color={colors.accent.amber} />
      <LinkButton label="Yelp" onPress={() => openYelp(name)} color={colors.accent.red} />
      <LinkButton label="Maps" onPress={() => openGoogleMaps(name, lat, lng)} color={colors.accent.blue} />
    </View>
  )
}

function LinkButton({ label, onPress, color }: { label: string; onPress: () => void; color: string }) {
  return (
    <TouchableOpacity style={[styles.linkBtn, { borderColor: color }]} onPress={onPress}>
      <Text style={[styles.linkBtnText, { color }]}>{label}</Text>
    </TouchableOpacity>
  )
}

function StaticPlacesMap({ places }: { places: SavedRestaurant[] }) {
  const [apiKey, setApiKey] = useState('')
  useEffect(() => {
    getSettings()
      .then(s => setApiKey(s.googlePlacesKey || ''))
      .catch(err => console.warn('[Weekend] Failed to load Google Places key:', err))
  }, [])
  const mappable = places.filter(r => r.lat && r.lng)
  if (!apiKey || mappable.length === 0) {
    return (
      <View style={{ height: 200, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg.tertiary, borderRadius: 10 }}>
        <Ionicons name="map-outline" size={24} color={colors.text.muted} />
        <Text style={{ color: colors.text.muted, fontSize: 12, marginTop: 6 }}>
          {!apiKey ? 'Set Google Places API key in Settings' : 'No places with coordinates'}
        </Text>
      </View>
    )
  }
  const darkStyles = [
    'feature:all|element:geometry|color:0x212121',
    'feature:all|element:labels.text.fill|color:0x757575',
    'feature:water|element:geometry|color:0x000000',
    'feature:road|element:geometry.fill|color:0x2c2c2c',
    'feature:road.highway|element:geometry|color:0x3c3c3c',
  ]
  let url = `https://maps.googleapis.com/maps/api/staticmap?size=640x340&scale=2&maptype=roadmap&key=${apiKey}`
  darkStyles.forEach(s => { url += `&style=${encodeURIComponent(s)}` })
  mappable.slice(0, 20).forEach(r => {
    url += `&markers=${encodeURIComponent(`size:small|color:0xfbbf24|${r.lat},${r.lng}`)}`
  })
  return (
    <View style={{ borderRadius: 10, overflow: 'hidden' }}>
      <Image source={{ uri: url }} style={{ width: '100%', height: 340 }} resizeMode="cover" />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
    paddingHorizontal: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text.primary,
  },
  headerActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  savedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.bg.tertiary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  savedBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.blue,
  },
  tabRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.bg.tertiary,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: colors.accent.cyan + '22',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text.muted,
  },
  tabTextActive: {
    color: colors.accent.cyan,
    fontWeight: '700',
  },
  // Date strip
  dateStrip: {
    marginBottom: spacing.sm,
  },
  dateChip: {
    width: 48,
    height: 60,
    borderRadius: 12,
    backgroundColor: colors.bg.tertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  dateChipSelected: {
    backgroundColor: colors.accent.blue,
  },
  dateChipToday: {
    borderWidth: 1,
    borderColor: colors.accent.blue,
  },
  dateDayName: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.text.muted,
    marginBottom: 2,
  },
  dateDayNameSelected: {
    color: '#fff',
  },
  dateLabel: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
  },
  dateLabelSelected: {
    color: '#fff',
  },
  selectedCount: {
    fontSize: 12,
    color: colors.accent.blue,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  inputCard: {
    backgroundColor: colors.bg.card,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.muted,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.bg.tertiary,
    borderRadius: 10,
    padding: spacing.md,
    fontSize: 15,
    color: colors.text.primary,
    marginBottom: spacing.md,
    minHeight: 44,
  },
  searchRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  searchBtn: {
    backgroundColor: colors.accent.cyan,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  searchBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  generateBtn: {
    backgroundColor: colors.accent.cyan,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  generateText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  card: {
    backgroundColor: colors.bg.card,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  themeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  themeChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.bg.tertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  themeChipActive: {
    backgroundColor: colors.accent.cyan,
    borderColor: colors.accent.cyan,
  },
  themeChipText: {
    fontSize: 12,
    color: colors.text.secondary,
  },
  savedSeedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  savedSeedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  savedSeedName: {
    flex: 1,
    fontSize: 13,
    color: colors.text.primary,
  },
  savedSeedMeta: {
    fontSize: 11,
    color: colors.text.muted,
    maxWidth: '40%',
  },
  dayLabel: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  activityTime: {
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: colors.accent.blue,
    width: 85,
    paddingTop: 2,
  },
  activityBody: {
    flex: 1,
  },
  activityName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 2,
  },
  activityMeta: {
    fontSize: 13,
    color: colors.text.muted,
    marginBottom: 4,
  },
  activityTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: 4,
  },
  tag: {
    fontSize: 11,
    color: colors.text.muted,
    backgroundColor: colors.bg.tertiary,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  activityRationale: {
    fontSize: 13,
    color: colors.text.secondary,
    lineHeight: 19,
  },
  emptyCard: {
    backgroundColor: colors.bg.card,
    borderRadius: 12,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.md,
  },
  emptyText: {
    fontSize: 15,
    color: colors.text.muted,
    textAlign: 'center',
    lineHeight: 22,
  },
  notesText: {
    fontSize: 15,
    color: colors.text.secondary,
    lineHeight: 22,
  },

  // Events
  eventsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  eventRefreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.bg.tertiary,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  eventRefreshText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.cyan,
  },
  genreStrip: {
    marginBottom: spacing.md,
  },
  eventTypeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.bg.tertiary,
    marginRight: spacing.sm,
  },
  genreChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.bg.tertiary,
    marginRight: spacing.sm,
  },
  genreChipActive: {
    backgroundColor: colors.accent.cyan + '22',
  },
  genreText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text.muted,
  },
  genreTextActive: {
    color: colors.accent.cyan,
    fontWeight: '700',
  },
  eventCard: {
    backgroundColor: colors.bg.tertiary,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  eventHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  eventName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
    flex: 1,
  },
  eventMeta: {
    fontSize: 13,
    color: colors.text.muted,
    marginTop: 4,
  },
  eventTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  eventCategory: {
    fontSize: 11,
    color: colors.accent.cyan,
    backgroundColor: colors.accent.cyan + '18',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  eventPrice: {
    fontSize: 11,
    color: colors.accent.green,
    backgroundColor: colors.accent.green + '18',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  eventDesc: {
    fontSize: 13,
    color: colors.text.secondary,
    marginTop: spacing.sm,
    lineHeight: 19,
  },
  eventLink: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.accent.blue,
    marginTop: spacing.sm,
  },
  genreBadge: {
    fontSize: 11,
    color: colors.accent.purple,
    backgroundColor: colors.accent.purple + '18',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  loadMoreEventsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.bg.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.accent.cyan + '44',
    paddingVertical: 12,
    marginTop: spacing.sm,
  },
  loadMoreEventsText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.cyan,
  },

  // Notion
  notionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.bg.tertiary, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  notionBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  // Restaurant styles
  restaurantCard: {
    backgroundColor: colors.bg.tertiary,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  restaurantHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  heartBtn: {
    padding: 4,
  },
  restaurantName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text.primary,
  },
  restaurantAddress: {
    fontSize: 13,
    color: colors.text.muted,
    marginTop: 2,
  },
  restaurantMeta: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  ratingBadge: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.amber,
    backgroundColor: colors.accent.amber + '18',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  priceBadge: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.green,
    backgroundColor: colors.accent.green + '18',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  distanceBadge: {
    fontSize: 12,
    color: colors.accent.blue,
    backgroundColor: colors.accent.blue + '18',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  openBadge: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  cuisineRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  cuisineTag: {
    fontSize: 11,
    color: colors.text.secondary,
    backgroundColor: colors.bg.card,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  bookingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
  },
  bookingAdvance: {
    fontSize: 13,
    color: colors.accent.purple,
    fontWeight: '500',
  },
  restaurantNotes: {
    fontSize: 13,
    color: colors.text.secondary,
    marginTop: spacing.xs,
    fontStyle: 'italic',
  },
  bookingToggle: {
    marginTop: spacing.sm,
    paddingVertical: 6,
  },
  bookingToggleText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.accent.cyan,
  },
  linkRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  linkBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  linkBtnText: {
    fontSize: 13,
    fontWeight: '500',
  },
})
