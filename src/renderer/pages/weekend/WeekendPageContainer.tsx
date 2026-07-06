import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import type { DragEvent, FormEvent } from 'react'
import {
  MapPin,
  Sparkles,
  Calendar,
  Clock,
  DollarSign,
  Navigation,
  Music,
  Trophy,
  Palette,
  UtensilsCrossed,
  TreePine,
  Star,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  RefreshCw,
  Send,
  Check,
  Square,
  CheckSquare,
  Zap,
  Wallet,
  Gauge,
  Sun,
  Moon,
  SlidersHorizontal,
  Heart,
  Search,
  X,
  ExternalLink,
  CalendarClock,
  Plus,
  Wine,
  Cake,
  Coffee as CoffeeIcon,
  Flame,
  Pencil,
  Sparkle,
  TrendingUp,
  Landmark,
  ShoppingBag,
  Building2,
  Car,
  Save,
  Image,
  Maximize2,
  Minimize2,
  GripVertical,
} from 'lucide-react'
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Marker,
  Popup,
  Circle,
  Polyline,
  useMap,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import NoodleSpinner from '../../components/anim/NoodleSpinner'
import NoodleIllustration from '../../components/anim/NoodleIllustration'
import WeatherPreviewCard from '../../components/WeatherPreviewCard'
import type { PlannerWeatherPreview } from '../../../shared/types/ipc.types'

// --- Types ---

interface WeekendActivity {
  time: string
  activity: string
  location: string
  transportation?: string
  travelTime: string
  rationale: string
  cost: string
}

interface AgendaMapLeg {
  from: string
  to: string
  transportation?: string
  travelTime?: string
  note?: string
}

interface AgendaMapDay {
  route?: string[]
  legs?: AgendaMapLeg[]
}

interface WeekendPlanData {
  thursday?: WeekendActivity[]
  friday?: WeekendActivity[]
  saturday?: WeekendActivity[]
  sunday?: WeekendActivity[]
  monday?: WeekendActivity[]
  tuesday?: WeekendActivity[]
  wednesday?: WeekendActivity[]
  agendaMap?: Record<string, AgendaMapDay>
  [key: string]: WeekendActivity[] | Record<string, AgendaMapDay> | undefined
}

interface LocalEvent {
  id: string
  name: string
  type: string
  date: string
  time: string
  venue: string
  address: string
  priceRange: string
  url: string
  description: string
  city?: string
  imageUrl?: string | null
  distance?: string | null
  lat?: number | null
  lng?: number | null
}

interface StoredPlan {
  id: number
  weekend_date: string
  plan_json: string
  events_json: string
  ai_rationale: string | null
  created_at: string
}

interface CachedWeekendEvent {
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
}

type WeekendTheme =
  | 'foodie'
  | 'outdoors'
  | 'chill'
  | 'culture'
  | 'date_night'
  | 'hidden_gems'
  | 'social'

type WeekendLocationStrategy = 'clustered' | 'two_zones' | 'open'
type WeekendDiscoveryMode = 'balanced' | 'new_neighborhoods' | 'saved_favorites'

const THEME_OPTIONS: Array<{ id: WeekendTheme; label: string; emoji: string }> = [
  { id: 'foodie', label: 'Foodie', emoji: '🍜' },
  { id: 'outdoors', label: 'Outdoorsy', emoji: '🌳' },
  { id: 'chill', label: 'Chill', emoji: '☕' },
  { id: 'culture', label: 'Culture', emoji: '🎭' },
  { id: 'date_night', label: 'Date night', emoji: '🍷' },
  { id: 'hidden_gems', label: 'Hidden gems', emoji: '🗝️' },
  { id: 'social', label: 'Social', emoji: '🍻' },
]

const EVENT_FOCUS_OPTIONS = [
  'Date night',
  'Solo friendly',
  'Free or cheap',
  'Food pop-ups',
  'Live music',
  'Hidden gems',
  'High energy',
  'Low key',
]

function eventIdentity(event: LocalEvent): string {
  // Normalize name to catch minor variations (trim, collapse whitespace, lowercase)
  const name = event.name.trim().replace(/\s+/g, ' ').toLowerCase()
  const venue = (event.venue || '').trim().replace(/\s+/g, ' ').toLowerCase()
  const date = event.date || ''
  // Dedup by name+date+venue, ignoring time (same event with multiple time slots = 1 entry)
  return `${name}|${date}|${venue}`
}

/** Strip ticket types, city names, and noise for fuzzy dedup */
function stripEventNoise(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(
      /\b(flex ticket|general admission|ga|vip|reserved|standing|seated|balcony|early entry|late show|early show)\b/g,
      '',
    )
    .replace(/\b(chicago|new york|los angeles|san francisco|nyc|la|sf)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isFuzzyDuplicate(a: LocalEvent, b: LocalEvent): boolean {
  if (a.date !== b.date) return false
  const aVenue = (a.venue || '').trim().toLowerCase()
  const bVenue = (b.venue || '').trim().toLowerCase()
  if (aVenue !== bVenue) return false
  const aName = stripEventNoise(a.name)
  const bName = stripEventNoise(b.name)
  return aName.length > 0 && bName.length > 0 && (aName.includes(bName) || bName.includes(aName))
}

function dedup(events: LocalEvent[]): LocalEvent[] {
  const result: LocalEvent[] = []
  const seenKeys = new Set<string>()
  for (const e of events) {
    const key = eventIdentity(e)
    if (seenKeys.has(key)) continue
    // Also check fuzzy duplicate against already-kept events
    if (result.some((kept) => isFuzzyDuplicate(kept, e))) continue
    seenKeys.add(key)
    result.push(e)
  }
  return result
}

function mergeLocalEvents(current: LocalEvent[], incoming: LocalEvent[]): LocalEvent[] {
  const seenKeys = new Set(current.map(eventIdentity))
  const merged = [...current]
  for (const event of incoming) {
    const key = eventIdentity(event)
    if (seenKeys.has(key)) continue
    if (merged.some((kept) => isFuzzyDuplicate(kept, event))) continue
    seenKeys.add(key)
    merged.push(event)
  }
  return merged
}

const TRANSPORTATION_OPTIONS = [
  { id: 'driving', label: 'Driving' },
  { id: 'transit', label: 'Transit' },
  { id: 'walking', label: 'Walking' },
  { id: 'biking', label: 'Biking' },
  { id: 'rideshare', label: 'Rideshare' },
] as const

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

interface WeekendParams {
  preferences?: string
  satWakeTime?: string
  sunWakeTime?: string
  energyLevel?: 'low' | 'medium' | 'high'
  budget?: 'free' | 'low' | 'medium' | 'high'
  pace?: 'relaxed' | 'moderate' | 'packed'
  themes?: WeekendTheme[]
  savedRestaurantIds?: number[]
  avoidTouristy?: boolean
  transportationMode?: string
  locationStrategy?: WeekendLocationStrategy
  discoveryMode?: WeekendDiscoveryMode
  extraDetails?: string
  dates?: string[]
  wakeTimes?: Record<string, string>
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

const DAY_ORDER = [
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
] as const
const DAY_SHORT: Record<string, string> = {
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
  sunday: 'sun',
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
}
const DAY_COLORS: Record<string, string> = {
  thursday: '#f97316',
  friday: '#22c55e',
  saturday: '#22d3ee',
  sunday: '#a78bfa',
  monday: '#ef4444',
  tuesday: '#eab308',
  wednesday: '#ec4899',
}
const DAY_FILL_COLORS: Record<string, string> = {
  thursday: '#c2410c',
  friday: '#15803d',
  saturday: '#0e7490',
  sunday: '#6d28d9',
  monday: '#b91c1c',
  tuesday: '#a16207',
  wednesday: '#be185d',
}
const DAY_ACCENT_RGB: Record<string, string> = {
  thursday: '249,115,22',
  friday: '34,197,94',
  saturday: '121,192,255',
  sunday: '210,168,255',
  monday: '239,68,68',
  tuesday: '234,179,8',
  wednesday: '236,72,153',
}
const DAY_GLOW: Record<string, string> = {
  thursday: 'rgba(249,115,22,0.06)',
  friday: 'rgba(34,197,94,0.06)',
  saturday: 'rgba(88,166,255,0.06)',
  sunday: 'rgba(210,168,255,0.06)',
  monday: 'rgba(239,68,68,0.06)',
  tuesday: 'rgba(234,179,8,0.06)',
  wednesday: 'rgba(236,72,153,0.06)',
}

type PlanDayKey = (typeof DAY_ORDER)[number]

function getPlanActivities(
  plan: WeekendPlanData | null | undefined,
  day: string,
): WeekendActivity[] {
  const value = plan?.[day]
  return Array.isArray(value) ? value : []
}

function setPlanActivities(
  plan: WeekendPlanData,
  day: string,
  activities: WeekendActivity[],
): WeekendPlanData {
  return { ...plan, [day]: activities }
}

function getPlanDayKeys(plan: WeekendPlanData | null): string[] {
  if (!plan) return []
  return (DAY_ORDER as readonly string[]).filter((d) => getPlanActivities(plan, d).length > 0)
}

function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dateToDayKey(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()]
}

function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1)
}

interface Restaurant {
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
  primaryType?: string | null
}

type VenueType =
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
type SpiceLevel = 'none' | 'mild' | 'medium' | 'spicy' | 'very-spicy'

type DayOfWeek = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
const DAYS_OF_WEEK: DayOfWeek[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
type BusyDaysMatrix = Partial<Record<DayOfWeek, { level: number; peakHours: string | null }>>

interface RestaurantVisit {
  id: number
  placeId: string
  visitDate: string
  rating: number | null
  notes: string | null
  createdAt: string
}

interface SavedRestaurant {
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

type Tab = 'plan' | 'restaurants' | 'places' | 'map'

// --- Constants ---

const typeIcons: Record<string, React.ReactNode> = {
  concert: <Music size={14} />,
  sports: <Trophy size={14} />,
  arts: <Palette size={14} />,
  food: <UtensilsCrossed size={14} />,
  outdoor: <TreePine size={14} />,
  festival: <Star size={14} />,
  other: <MapPin size={14} />,
}

const typeColors: Record<string, string> = {
  concert: '#ff375f',
  sports: 'var(--accent-amber)',
  arts: 'var(--accent-purple)',
  food: '#ff9f0a',
  outdoor: 'var(--accent-green)',
  festival: 'var(--accent-cyan)',
  other: 'var(--text-muted)',
}

const PRICE_LABELS = ['', '$', '$$', '$$$', '$$$$']
function priceLabel(level: number | null): string {
  if (!level || level < 1 || level > 4) return ''
  return PRICE_LABELS[level]
}

const VENUE_TYPES: { id: VenueType; label: string; icon: React.ReactNode }[] = [
  { id: 'restaurant', label: 'Restaurant', icon: <UtensilsCrossed size={12} /> },
  { id: 'bar', label: 'Bar', icon: <Wine size={12} /> },
  { id: 'dessert', label: 'Dessert', icon: <Cake size={12} /> },
  { id: 'cafe', label: 'Cafe', icon: <CoffeeIcon size={12} /> },
  { id: 'attraction', label: 'Attraction', icon: <MapPin size={12} /> },
  { id: 'store', label: 'Store', icon: <ShoppingBag size={12} /> },
  { id: 'museum', label: 'Museum', icon: <Landmark size={12} /> },
  { id: 'sports', label: 'Sports', icon: <Trophy size={12} /> },
  { id: 'music', label: 'Music', icon: <Music size={12} /> },
  { id: 'stadium', label: 'Stadium', icon: <Building2 size={12} /> },
  { id: 'park', label: 'Park', icon: <TreePine size={12} /> },
  { id: 'theater', label: 'Theater', icon: <Palette size={12} /> },
  { id: 'other', label: 'Other', icon: <MapPin size={12} /> },
]

const FOOD_VENUE_TYPES: VenueType[] = ['restaurant', 'bar', 'dessert', 'cafe']
const PLACE_VENUE_TYPES: VenueType[] = [
  'attraction',
  'store',
  'museum',
  'sports',
  'music',
  'stadium',
  'park',
  'theater',
  'other',
]

const CUISINE_CATEGORIES = [
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

const SPICE_LEVELS: { id: SpiceLevel; label: string; color: string }[] = [
  { id: 'none', label: 'None', color: 'var(--text-muted)' },
  { id: 'mild', label: 'Mild', color: 'var(--accent-green)' },
  { id: 'medium', label: 'Medium', color: 'var(--accent-amber)' },
  { id: 'spicy', label: 'Spicy', color: '#ff9f0a' },
  { id: 'very-spicy', label: 'Very Spicy', color: 'var(--accent-red)' },
]

const venueTypeColor: Record<VenueType, string> = {
  restaurant: '#ff9f0a',
  bar: 'var(--accent-purple)',
  dessert: '#ff375f',
  cafe: 'var(--accent-amber)',
  attraction: 'var(--accent-cyan)',
  store: 'var(--accent-green)',
  museum: 'var(--accent-blue)',
  sports: 'var(--accent-amber)',
  music: '#ff375f',
  stadium: 'var(--accent-purple)',
  park: 'var(--accent-green)',
  theater: 'var(--accent-cyan)',
  other: 'var(--text-muted)',
}

const venueTypeGlyph: Record<VenueType, string> = {
  restaurant: '🍴',
  bar: '🍷',
  dessert: '🍰',
  cafe: '☕',
  attraction: '⌖',
  store: '▣',
  museum: '🏛',
  sports: '★',
  music: '♪',
  stadium: '▥',
  park: '♣',
  theater: '◈',
  other: '•',
}

function createVenueMarkerIcon(
  type: VenueType,
  options: { selected?: boolean; nearby?: boolean } = {},
): L.DivIcon {
  const color = venueTypeColor[type] || '#22d3ee'
  const glyph = venueTypeGlyph[type] || venueTypeGlyph.other
  const markerColor = options.selected ? '#38bdf8' : color
  const markerTextColor = options.selected ? '#06121f' : 'white'
  const size = options.selected ? 40 : options.nearby ? 26 : 30
  const fontSize = options.selected ? 19 : options.nearby ? 13 : 15
  const borderStyle = options.nearby ? 'dashed' : 'solid'
  const opacity = options.nearby ? 0.82 : 1
  const border = options.selected ? '3px solid white' : `2px ${borderStyle} rgba(255,255,255,0.86)`
  const shadow = options.selected
    ? '0 10px 26px rgba(0,0,0,0.48), 0 0 0 6px rgba(56,189,248,0.34), 0 0 30px rgba(56,189,248,0.78)'
    : '0 8px 20px rgba(0,0,0,0.38), 0 0 0 3px rgba(255,255,255,0.14)'

  return L.divIcon({
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
    html: `
      <div style="
        width:${size}px;
        height:${size}px;
        border-radius:999px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:${markerColor};
        color:${markerTextColor};
        border:${border};
        box-shadow:${shadow};
        font-size:${fontSize}px;
        font-weight:800;
        line-height:1;
        opacity:${opacity};
        transform:translateZ(0);
        position:relative;
      ">${glyph}</div>
    `,
  })
}

function inferNearbyVenueType(place: Restaurant): VenueType {
  const text =
    `${place.primaryType || ''} ${place.name || ''} ${place.cuisine?.join(' ') || ''}`.toLowerCase()
  if (/(dessert|ice cream|gelato|pastry|sweets|cake|donut|doughnut|bakery|bakeshop)/.test(text))
    return 'dessert'
  if (/(cafe|coffee|espresso)/.test(text)) return 'cafe'
  if (/(bar|pub|cocktail|wine|brewery|taproom)/.test(text)) return 'bar'
  if (/(shop|store|market|boutique|mall)/.test(text)) return 'store'
  if (/(museum|gallery|institute)/.test(text)) return 'museum'
  if (/(park|garden|trail|beach)/.test(text)) return 'park'
  if (/(theater|theatre|cinema|performance)/.test(text)) return 'theater'
  if (/(music|concert|jazz|venue)/.test(text)) return 'music'
  if (/(stadium|arena|field|ballpark)/.test(text)) return 'stadium'
  if (/(sport|game)/.test(text)) return 'sports'
  if (/(restaurant|meal|food)/.test(text)) return 'restaurant'
  return 'attraction'
}

function venueTypeLabel(type: VenueType): string {
  return VENUE_TYPES.find((v) => v.id === type)?.label || 'Place'
}

function parseClockToMinutes(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i)
  if (!match) return null
  let hours = Number(match[1])
  const minutes = Number(match[2])
  if (Number.isNaN(hours) || Number.isNaN(minutes) || minutes > 59) return null
  const meridiem = match[3]?.toUpperCase()
  if (meridiem === 'PM' && hours < 12) hours += 12
  if (meridiem === 'AM' && hours === 12) hours = 0
  if (hours > 23) return null
  return hours * 60 + minutes
}

function parseTimeRange(time: string): { start: number; end: number } | null {
  const parts = time.split(/\s*[-–—]\s*/)
  if (parts.length < 2) return null
  const start = parseClockToMinutes(parts[0])
  let end = parseClockToMinutes(parts[1])
  if (start === null || end === null) return null
  if (end <= start) end += 24 * 60
  return { start, end }
}

function formatMinutesAsClock(totalMinutes: number): string {
  const normalized = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60)
  const hours = Math.floor(normalized / 60)
  const minutes = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function refreshActivityTimes(activities: WeekendActivity[]): WeekendActivity[] {
  const ranges = activities.map((activity) => parseTimeRange(activity.time))
  let cursor = ranges.reduce<number | null>((earliest, range) => {
    if (!range) return earliest
    return earliest === null ? range.start : Math.min(earliest, range.start)
  }, null)
  return activities.map((activity, index) => {
    const range = ranges[index]
    if (!range) return activity
    const duration = Math.max(15, range.end - range.start)
    const start = cursor ?? range.start
    const end = start + duration
    cursor = end
    return { ...activity, time: `${formatMinutesAsClock(start)}-${formatMinutesAsClock(end)}` }
  })
}

// --- Sub-components ---

function ActivityCard({
  activity,
  index,
  checked,
  onToggle,
  onTimeChange,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dragging,
}: {
  activity: WeekendActivity
  index: number
  checked: boolean
  onToggle: () => void
  onTimeChange: (time: string) => void
  onRemove: () => void
  onDragStart: () => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  dragging: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(activity.time)

  const commitTime = () => {
    setEditing(false)
    if (draft.trim() && draft !== activity.time) onTimeChange(draft.trim())
  }

  return (
    <div
      className="flex gap-3 p-3 rounded-lg group"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        background: index % 2 === 0 ? 'var(--bg-tertiary)' : 'transparent',
        opacity: dragging ? 0.45 : 1,
        cursor: 'grab',
      }}
    >
      <GripVertical
        size={14}
        className="shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ color: 'var(--text-muted)' }}
      />
      <button
        onClick={onToggle}
        className="shrink-0 mt-0.5 transition-colors"
        style={{ color: checked ? 'var(--accent-cyan)' : 'var(--text-muted)' }}
      >
        {checked ? <CheckSquare size={16} /> : <Square size={16} />}
      </button>
      <div className="shrink-0 w-20 text-right">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTime}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTime()
              if (e.key === 'Escape') {
                setDraft(activity.time)
                setEditing(false)
              }
            }}
            className="w-full text-sm font-mono text-right px-1 py-0 rounded outline-none"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--accent-blue)',
              border: '1px solid var(--accent-blue)',
            }}
          />
        ) : (
          <span
            className="text-sm font-mono cursor-pointer hover:underline"
            style={{ color: 'var(--accent-blue)' }}
            onClick={() => {
              setDraft(activity.time)
              setEditing(true)
            }}
            title="Click to edit time"
          >
            {activity.time}
          </span>
        )}
      </div>
      <div className="w-px shrink-0" style={{ background: 'var(--separator)' }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const query = [activity.activity.split('—')[0].trim(), activity.location].filter(Boolean).join(' ')
              window.open(
                `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
                '_blank'
              )
            }}
            className="text-sm font-medium flex-1 min-w-0 hover:underline cursor-pointer"
            style={{ color: 'var(--text-primary)' }}
            title="Search in Google Maps"
          >
            {activity.activity}
          </a>
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (window.confirm(`Remove "${activity.activity}" from this day?`)) onRemove()
            }}
            className="p-1 rounded transition-colors opacity-0 group-hover:opacity-100 hover:bg-white/[0.05]"
            style={{ color: 'var(--text-muted)' }}
            title="Remove activity"
          >
            <X size={13} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
          {activity.location && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                window.open(
                  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(activity.location)}`,
                  '_blank'
                )
              }}
              className="flex items-center gap-1 text-xs hover:underline"
              style={{ color: 'var(--text-muted)' }}
              title="Open in Google Maps"
            >
              <MapPin size={10} /> {activity.location}
            </a>
          )}
          {activity.travelTime && (
            <span
              className="flex items-center gap-1 text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              <Navigation size={10} /> {activity.travelTime}
            </span>
          )}
          {activity.transportation && (
            <span
              className="flex items-center gap-1 text-xs capitalize"
              style={{ color: 'var(--text-muted)' }}
            >
              <Car size={10} /> {activity.transportation}
            </span>
          )}
          {activity.cost && (
            <span
              className="flex items-center gap-1 text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              <DollarSign size={10} /> {activity.cost}
            </span>
          )}
        </div>
        {activity.rationale && (
          <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {activity.rationale}
          </p>
        )}
      </div>
    </div>
  )
}

function EventChip({
  event,
  onClick,
  onRemove,
}: {
  event: LocalEvent
  onClick: () => void
  onRemove?: () => void
}) {
  const color = typeColors[event.type] || typeColors.other
  const icon = typeIcons[event.type] || typeIcons.other
  const [confirmRemove, setConfirmRemove] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirmRemove) {
      if (timerRef.current) clearTimeout(timerRef.current)
      setConfirmRemove(false)
      onRemove?.()
    } else {
      setConfirmRemove(true)
      timerRef.current = setTimeout(() => setConfirmRemove(false), 3000)
    }
  }

  return (
    <div
      className="group flex items-start gap-2 p-2.5 rounded-lg text-xs w-full text-left transition-colors hover:bg-white/[0.05] cursor-pointer relative"
      style={{ background: 'var(--bg-tertiary)' }}
      onClick={onClick}
    >
      <div className="shrink-0 mt-0.5" style={{ color }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate" style={{ color }}>
          {event.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5" style={{ color: 'var(--text-muted)' }}>
          <span>{event.time}</span>
          <span>·</span>
          <span className="truncate">{event.venue}</span>
          <span>·</span>
          <span>{event.priceRange}</span>
        </div>
      </div>
      {onRemove && (
        <button
          onClick={handleRemoveClick}
          className="shrink-0 transition-all p-0.5 rounded hover:bg-white/10"
          style={{
            color: confirmRemove ? 'white' : 'var(--text-muted)',
            background: confirmRemove ? 'var(--accent-red)' : 'transparent',
            opacity: confirmRemove ? 1 : undefined,
          }}
          title={confirmRemove ? 'Click again to confirm' : 'Remove event'}
        >
          {confirmRemove ? (
            <span className="px-1 text-[10px] font-medium">Remove?</span>
          ) : (
            <X size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </button>
      )}
    </div>
  )
}

function hasEventMapCoordinates(event: LocalEvent): boolean {
  return (
    Number.isFinite(event.lat) &&
    Number.isFinite(event.lng) &&
    Math.abs(event.lat || 0) > 0.0001 &&
    Math.abs(event.lng || 0) > 0.0001
  )
}

function normalizeLocationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function eventMapSearchQuery(event: LocalEvent): string {
  return [event.venue, event.address, event.city].filter(Boolean).join(' ')
}

function resolveEventCoordinates(
  event: LocalEvent,
  savedPlaces: SavedRestaurant[],
): { lat: number; lng: number; source: 'event' | 'saved' } | null {
  if (hasEventMapCoordinates(event)) {
    return { lat: event.lat as number, lng: event.lng as number, source: 'event' }
  }

  const eventVenue = normalizeLocationText(event.venue || '')
  const eventAddress = normalizeLocationText(event.address || '')
  if (!eventVenue && !eventAddress) return null

  const match = savedPlaces.find((place) => {
    if (!hasMapCoordinates(place)) return false
    const placeName = normalizeLocationText(place.name || '')
    const placeAddress = normalizeLocationText(place.address || '')
    return Boolean(
      (eventVenue && (placeName.includes(eventVenue) || eventVenue.includes(placeName))) ||
      (eventAddress &&
        placeAddress &&
        (placeAddress.includes(eventAddress) || eventAddress.includes(placeAddress))),
    )
  })

  return match ? { lat: match.lat, lng: match.lng, source: 'saved' } : null
}

function EventMapFitBounds({ points }: { points: Array<{ lat: number; lng: number }> }) {
  const map = useMap()
  useEffect(() => {
    setTimeout(() => map.invalidateSize(), 0)
    if (points.length === 0) return
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 13)
      return
    }
    const pad = 0.01
    map.fitBounds([
      [Math.min(...points.map((p) => p.lat)) - pad, Math.min(...points.map((p) => p.lng)) - pad],
      [Math.max(...points.map((p) => p.lat)) + pad, Math.max(...points.map((p) => p.lng)) + pad],
    ])
  }, [map, points])
  return null
}

function EventsMap({
  events,
  savedPlaces,
  onSelectEvent,
}: {
  events: LocalEvent[]
  savedPlaces: SavedRestaurant[]
  onSelectEvent: (event: LocalEvent) => void
}) {
  const points = useMemo(() => {
    return events
      .map((event) => {
        const coords = resolveEventCoordinates(event, savedPlaces)
        return coords ? { event, ...coords } : null
      })
      .filter(
        (
          point,
        ): point is { event: LocalEvent; lat: number; lng: number; source: 'event' | 'saved' } =>
          Boolean(point),
      )
  }, [events, savedPlaces])

  const center =
    points.length > 0
      ? ([
          points.reduce((sum, point) => sum + point.lat, 0) / points.length,
          points.reduce((sum, point) => sum + point.lng, 0) / points.length,
        ] as [number, number])
      : ([41.88, -87.63] as [number, number])
  const missingCount = events.length - points.length

  return (
    <div
      className="relative overflow-hidden rounded-lg h-full min-h-[420px]"
      style={{ border: '1px solid var(--separator)', background: 'var(--bg-tertiary)' }}
    >
      {points.length > 0 ? (
        <MapContainer
          center={center}
          zoom={12}
          scrollWheelZoom={true}
          style={{ height: '100%', width: '100%' }}
          attributionControl={false}
        >
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
          <EventMapFitBounds points={points} />
          {points.map(({ event, lat, lng, source }, index) => {
            const color = typeColors[event.type] || typeColors.other
            return (
              <CircleMarker
                key={`${event.id || event.name}-${index}`}
                center={[lat, lng]}
                radius={8}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: 0.78,
                  weight: source === 'saved' ? 1.5 : 2,
                  dashArray: source === 'saved' ? '4 3' : undefined,
                }}
                eventHandlers={{ click: () => onSelectEvent(event) }}
              >
                <Popup>
                  <div style={{ fontSize: 12, lineHeight: 1.5, minWidth: 190 }}>
                    <strong>{event.name}</strong>
                    <div style={{ fontSize: 10, opacity: 0.75 }}>
                      {event.time} - {event.venue}
                    </div>
                    {event.address && (
                      <div style={{ fontSize: 10, opacity: 0.7 }}>{event.address}</div>
                    )}
                    <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => onSelectEvent(event)}
                        style={{
                          fontSize: 10,
                          color: '#22d3ee',
                          background: 'transparent',
                          border: 0,
                          padding: 0,
                          cursor: 'pointer',
                        }}
                      >
                        Details
                      </button>
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(eventMapSearchQuery(event))}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 10, color: '#f59e0b', textDecoration: 'underline' }}
                      >
                        Maps
                      </a>
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            )
          })}
        </MapContainer>
      ) : (
        <div className="h-full min-h-[420px] flex items-center justify-center px-6 text-center">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No event coordinates yet. Open events in Maps from the list, or save venues as places to
            plot address-only results.
          </p>
        </div>
      )}
      {missingCount > 0 && points.length > 0 && (
        <div
          className="absolute left-3 bottom-3 px-2 py-1 rounded-md text-[10px]"
          style={{
            background: 'rgba(0,0,0,0.65)',
            color: 'rgba(255,255,255,0.75)',
            border: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          {missingCount} address-only event{missingCount === 1 ? '' : 's'} not plotted
        </div>
      )}
    </div>
  )
}

interface ResolvedStop {
  label: string
  query: string
  address: string
  placeId: string | null
  lat: number
  lng: number
  source: string
  confidence: number
}

function PlanRouteMap({
  stopsByDay,
  activitiesByDay,
}: {
  stopsByDay: Record<string, ResolvedStop[]>
  activitiesByDay: Record<string, WeekendActivity[]>
}) {
  const allPoints = Object.values(stopsByDay).flat()
  if (allPoints.length === 0) return null

  const center: [number, number] = [
    allPoints.reduce((s, p) => s + p.lat, 0) / allPoints.length,
    allPoints.reduce((s, p) => s + p.lng, 0) / allPoints.length,
  ]

  const days = (DAY_ORDER as readonly string[]).filter((d) => (stopsByDay[d] || []).length > 0)

  return (
    <div
      className="relative overflow-hidden rounded-lg"
      style={{
        height: 420,
        border: '1px solid var(--separator)',
        background: 'var(--bg-tertiary)',
      }}
    >
      <MapContainer
        center={center}
        zoom={12}
        scrollWheelZoom={true}
        style={{ height: '100%', width: '100%' }}
        attributionControl={false}
      >
        <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
        <EventMapFitBounds points={allPoints} />

        {days.map((day) => {
          const stops = stopsByDay[day] || []
          const activities = activitiesByDay[day] || []
          const color = DAY_COLORS[day] || '#22d3ee'
          const fillColor = DAY_FILL_COLORS[day] || '#0e7490'
          const short = DAY_SHORT[day] || day.slice(0, 3)
          const label = dayLabel(day).slice(0, 3)
          return (
            <span key={day}>
              {stops.length > 1 && (
                <Polyline
                  positions={stops.map((s) => [s.lat, s.lng] as [number, number])}
                  pathOptions={{ color, weight: 3, opacity: 0.6, dashArray: '8 6' }}
                />
              )}
              {stops.map((stop, i) => {
                const activity = activityForRouteStop(activities, stop, i)
                return (
                  <CircleMarker
                    key={`${short}-${i}`}
                    center={[stop.lat, stop.lng]}
                    radius={14}
                    pathOptions={{ color, fillColor, fillOpacity: 0.9, weight: 2 }}
                  >
                    <Popup>
                      <div style={{ fontSize: 12, lineHeight: 1.5, minWidth: 160 }}>
                        <strong>
                          {label} #{i + 1}:{' '}
                          {isHomeStop(stop) ? 'Home' : activity?.activity || stop.label}
                        </strong>
                        {activity?.time && (
                          <div style={{ fontSize: 10, opacity: 0.75 }}>{activity.time}</div>
                        )}
                        <div style={{ fontSize: 10, opacity: 0.7 }}>
                          {stop.address || stop.query}
                        </div>
                      </div>
                    </Popup>
                  </CircleMarker>
                )
              })}
            </span>
          )
        })}

        <PlanRouteMapLabels stopsByDay={stopsByDay} />
      </MapContainer>

      {/* Legend */}
      <div
        className="absolute top-3 right-3 flex flex-wrap items-center gap-3 px-2.5 py-1.5 rounded-md text-[10px]"
        style={{
          background: 'rgba(0,0,0,0.7)',
          color: 'rgba(255,255,255,0.85)',
          border: '1px solid rgba(255,255,255,0.12)',
        }}
      >
        {days.map((day) => (
          <span key={day} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ background: DAY_COLORS[day] }} />
            {dayLabel(day)}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Overlay numbered labels on route map markers via Leaflet pane */
function PlanRouteMapLabels({ stopsByDay }: { stopsByDay: Record<string, ResolvedStop[]> }) {
  const map = useMap()
  const [, setTick] = useState(0)
  useEffect(() => {
    const handler = () => setTick((t) => t + 1)
    map.on('zoomend moveend', handler)
    return () => {
      map.off('zoomend moveend', handler)
    }
  }, [map])

  const renderLabel = (stop: ResolvedStop, index: number, day: string) => {
    const pt = map.latLngToContainerPoint([stop.lat, stop.lng])
    return (
      <div
        key={`label-${day}-${index}`}
        className="absolute pointer-events-none"
        style={{
          left: pt.x - 7,
          top: pt.y - 7,
          width: 14,
          height: 14,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 9,
          fontWeight: 700,
          color: 'white',
          zIndex: 1000,
        }}
      >
        {index + 1}
      </div>
    )
  }

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 600 }}>
      {Object.entries(stopsByDay).map(([day, stops]) =>
        stops.map((s, i) => renderLabel(s, i, day)),
      )}
    </div>
  )
}

interface DistanceInfo {
  driving: { distance: string; duration: string } | null
  transit: { distance: string; duration: string } | null
  walking: { distance: string; duration: string } | null
}

function EventDetailModal({ event, onClose }: { event: LocalEvent; onClose: () => void }) {
  const color = typeColors[event.type] || typeColors.other
  const icon = typeIcons[event.type] || typeIcons.other
  const [distance, setDistance] = useState<DistanceInfo | null>(null)
  const [loadingDist, setLoadingDist] = useState(false)

  useEffect(() => {
    if (event.address || event.venue) {
      setLoadingDist(true)
      const dest = event.address || event.venue
      window.api
        .getDistanceFromHome(dest)
        .then((d: DistanceInfo | null) => setDistance(d))
        .catch((err) => console.warn('[Weekend] Failed to load distance from home:', err))
        .finally(() => setLoadingDist(false))
    }
  }, [event])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose} role="dialog" aria-modal="true" aria-label="Activity detail">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between p-4"
          style={{ borderBottom: '1px solid var(--separator)' }}
        >
          <div className="flex items-center gap-2">
            <div style={{ color }}>{icon}</div>
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              {event.name}
            </h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5">
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div
              className="flex items-center gap-2 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              <Calendar size={14} style={{ color: 'var(--accent-cyan)' }} />
              {event.date}
            </div>
            <div
              className="flex items-center gap-2 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              <Clock size={14} style={{ color: 'var(--accent-blue)' }} />
              {event.time}
            </div>
            <div
              className="flex items-center gap-2 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              <MapPin size={14} style={{ color: 'var(--accent-green)' }} />
              {event.venue}
            </div>
            <div
              className="flex items-center gap-2 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              <DollarSign size={14} style={{ color: 'var(--accent-amber)' }} />
              {event.priceRange}
            </div>
          </div>

          {event.address && (
            <div
              className="text-xs p-2.5 rounded-lg"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
            >
              <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
                Address:{' '}
              </span>
              {event.address}
            </div>
          )}

          {/* Distance from home */}
          {loadingDist && (
            <div
              className="flex items-center gap-2 text-xs p-2.5 rounded-lg"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
            >
              <RefreshCw size={11} className="animate-spin" /> Calculating distance from home...
            </div>
          )}
          {distance && (
            <div
              className="rounded-lg overflow-hidden"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <div className="px-2.5 py-1.5" style={{ borderBottom: '1px solid var(--separator)' }}>
                <p className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  Distance from home
                </p>
              </div>
              <div className="grid grid-cols-3 gap-px" style={{ background: 'var(--separator)' }}>
                {distance.driving && (
                  <div className="p-2.5 text-center" style={{ background: 'var(--bg-tertiary)' }}>
                    <p className="text-lg mb-0.5">🚗</p>
                    <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {distance.driving.duration}
                    </p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {distance.driving.distance}
                    </p>
                  </div>
                )}
                {distance.transit && (
                  <div className="p-2.5 text-center" style={{ background: 'var(--bg-tertiary)' }}>
                    <p className="text-lg mb-0.5">🚇</p>
                    <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {distance.transit.duration}
                    </p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {distance.transit.distance}
                    </p>
                  </div>
                )}
                {distance.walking && (
                  <div className="p-2.5 text-center" style={{ background: 'var(--bg-tertiary)' }}>
                    <p className="text-lg mb-0.5">🚶</p>
                    <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {distance.walking.duration}
                    </p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {distance.walking.distance}
                    </p>
                  </div>
                )}
              </div>
              {!distance.walking && distance.driving && (
                <p className="text-[10px] px-2.5 py-1.5" style={{ color: 'var(--text-muted)' }}>
                  Too far to walk ({distance.driving.distance})
                </p>
              )}
            </div>
          )}

          {event.description && (
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {event.description}
            </p>
          )}

          <div className="flex items-center gap-2 pt-2">
            {event.url && (
              <button
                onClick={() => window.open(event.url, '_blank')}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors"
                style={{ background: 'var(--accent-cyan)', color: 'white' }}
              >
                <ExternalLink size={12} /> View Listing
              </button>
            )}
            {event.address && (
              <button
                onClick={() =>
                  window.open(
                    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.venue + ' ' + event.address)}`,
                    '_blank',
                  )
                }
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                <MapPin size={12} /> Open in Maps
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function RestaurantCard({
  restaurant: r,
  onSave,
  onRemove,
}: {
  restaurant: Restaurant
  onSave: () => void
  onRemove: () => void
}) {
  return (
    <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {r.name}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {r.address}
          </p>
        </div>
        <button
          onClick={r.saved ? onRemove : onSave}
          className="shrink-0 p-1 transition-colors"
          title={r.saved ? 'Remove from saved' : 'Save restaurant'}
        >
          <Heart
            size={16}
            fill={r.saved ? '#ff375f' : 'none'}
            style={{ color: r.saved ? '#ff375f' : 'var(--text-muted)' }}
          />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {r.rating && (
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--accent-amber)', color: 'white' }}
          >
            {r.rating.toFixed(1)} ({r.totalRatings})
          </span>
        )}
        {r.priceLevel && (
          <span className="text-xs font-medium" style={{ color: 'var(--accent-green)' }}>
            {priceLabel(r.priceLevel)}
          </span>
        )}
        {r.openNow !== null && (
          <span
            className="text-xs"
            style={{ color: r.openNow ? 'var(--accent-green)' : 'var(--accent-red)' }}
          >
            {r.openNow ? 'Open now' : 'Closed'}
          </span>
        )}
        {r.bookingAdvance && (
          <span
            className="flex items-center gap-1 text-xs"
            style={{ color: 'var(--accent-purple)' }}
          >
            <CalendarClock size={10} /> Book: {r.bookingAdvance}
          </span>
        )}
      </div>

      {r.cuisine.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {r.cuisine.map((c) => (
            <span
              key={c}
              className="text-[10px] px-1.5 py-0.5 rounded capitalize"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
            >
              {c}
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2 mt-2">
        <button
          onClick={() =>
            window.open(
              `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' ' + r.address)}`,
              '_blank',
            )
          }
          className="text-[10px] flex items-center gap-1 transition-colors hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          <MapPin size={9} /> Maps
        </button>
        <button
          onClick={() =>
            window.open(`https://www.opentable.com/s?term=${encodeURIComponent(r.name)}`, '_blank')
          }
          className="text-[10px] flex items-center gap-1 transition-colors hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          <ExternalLink size={9} /> OpenTable
        </button>
        <button
          onClick={() =>
            window.open(
              `https://www.yelp.com/search?find_desc=${encodeURIComponent(r.name)}`,
              '_blank',
            )
          }
          className="text-[10px] flex items-center gap-1 transition-colors hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          <ExternalLink size={9} /> Yelp
        </button>
      </div>
    </div>
  )
}

function formatBookingAdvanceLabel(r: SavedRestaurant): string {
  if (typeof r.bookingAdvanceDays === 'number') {
    if (r.bookingAdvanceDays <= 0) return 'Walk-in'
    if (r.bookingAdvanceDays >= 14) {
      const weeks = Math.round(r.bookingAdvanceDays / 7)
      return `Book ~${weeks} wk${weeks > 1 ? 's' : ''} ahead`
    }
    return `Book ~${r.bookingAdvanceDays} day${r.bookingAdvanceDays > 1 ? 's' : ''} ahead`
  }
  return `Book: ${r.bookingAdvance}`
}

function BusyDaysHeatmap({ matrix }: { matrix: BusyDaysMatrix }) {
  const cellColor = (level: number): string => {
    if (level >= 0.85) return '#ff375f'
    if (level >= 0.65) return '#ff9f0a'
    if (level >= 0.4) return 'var(--accent-amber)'
    if (level >= 0.2) return 'var(--accent-green)'
    return 'var(--bg-secondary)'
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        Busy
      </span>
      <div className="flex gap-0.5">
        {DAYS_OF_WEEK.map((day) => {
          const entry = matrix[day]
          const label = day[0]
          if (!entry) {
            return (
              <div
                key={day}
                title={`${day}: unknown`}
                className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-medium"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
              >
                {label}
              </div>
            )
          }
          const pct = Math.round(entry.level * 100)
          const tooltip = entry.peakHours
            ? `${day}: ${pct}% busy · peak ${entry.peakHours}`
            : `${day}: ${pct}% busy`
          return (
            <div
              key={day}
              title={tooltip}
              className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-medium"
              style={{
                background: cellColor(entry.level),
                color: entry.level >= 0.4 ? 'white' : 'var(--text-secondary)',
              }}
            >
              {label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SavedRestaurantCard({
  restaurant: r,
  onRemove,
  onResearch,
  onRate,
  onEdit,
  onRemoveVisit,
  researching,
  isPlace = false,
}: {
  restaurant: SavedRestaurant
  onRemove: () => void
  onResearch: () => void
  onRate: (rating: number | null, visitDate: string, notes: string, visitId?: number) => void
  onEdit: () => void
  onRemoveVisit: (visitId: number) => void
  researching: boolean
  isPlace?: boolean
}) {
  const vtColor = venueTypeColor[r.venueType] || '#ff9f0a'
  const vtEntry = VENUE_TYPES.find((v) => v.id === r.venueType)
  const [hoverStar, setHoverStar] = useState(0)
  const [showVisitForm, setShowVisitForm] = useState(false)
  const [showVisits, setShowVisits] = useState(false)
  const [showAllVisits, setShowAllVisits] = useState(false)
  const today = localDateStr(new Date())
  const todaysVisit = r.visits.find((v) => v.visitDate === today)
  const [editingVisitId, setEditingVisitId] = useState<number | null>(null)
  const [selectedVisitId, setSelectedVisitId] = useState<number | null>(
    todaysVisit?.id ?? r.visits[0]?.id ?? null,
  )
  const [visitDate, setVisitDate] = useState(today)
  const [visitRating, setVisitRating] = useState<number | null>(todaysVisit?.rating ?? null)
  const [visitNotes, setVisitNotes] = useState(todaysVisit?.notes || '')
  const [visitSubmitStatus, setVisitSubmitStatus] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmVisitRemoveId, setConfirmVisitRemoveId] = useState<number | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmVisitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visitSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setVisitRating(todaysVisit?.rating ?? null)
    setVisitNotes(todaysVisit?.notes || '')
    if (!editingVisitId) setVisitDate(today)
  }, [todaysVisit?.id, todaysVisit?.rating, todaysVisit?.notes, today, editingVisitId])

  const activeVisit =
    editingVisitId != null
      ? r.visits.find((v) => v.id === editingVisitId)
      : r.visits.find((v) => v.visitDate === visitDate)
  const hasSavedVisitForDate = Boolean(activeVisit)
  const selectedVisit = r.visits.find((v) => v.id === selectedVisitId) ?? todaysVisit ?? r.visits[0]
  const visibleVisits = showAllVisits ? r.visits : r.visits.slice(0, 3)
  const hiddenVisitCount = Math.max(0, r.visits.length - visibleVisits.length)

  const editVisit = (visit: RestaurantVisit) => {
    setEditingVisitId(visit.id)
    setSelectedVisitId(visit.id)
    setVisitDate(visit.visitDate)
    setVisitRating(visit.rating)
    setVisitNotes(visit.notes || '')
    setShowVisitForm(true)
    setShowVisits(true)
  }

  const resetVisitForm = () => {
    setEditingVisitId(null)
    setVisitDate(today)
    setVisitRating(todaysVisit?.rating ?? null)
    setVisitNotes(todaysVisit?.notes || '')
    setHoverStar(0)
  }

  const startNewVisit = () => {
    resetVisitForm()
    setVisitSubmitStatus(null)
    setShowVisitForm(true)
  }

  const submitVisit = () => {
    if (!visitDate || visitRating == null) return
    onRate(visitRating, visitDate, visitNotes, activeVisit?.id)
    setShowVisitForm(false)
    setEditingVisitId(null)
    setHoverStar(0)
    setVisitSubmitStatus('Review submitted')
    if (visitSubmitTimer.current) clearTimeout(visitSubmitTimer.current)
    visitSubmitTimer.current = setTimeout(() => setVisitSubmitStatus(null), 3000)
  }

  const requestRemoveVisit = (visitId: number) => {
    if (confirmVisitRemoveId === visitId) {
      if (confirmVisitTimer.current) clearTimeout(confirmVisitTimer.current)
      setConfirmVisitRemoveId(null)
      onRemoveVisit(visitId)
      return
    }
    setConfirmVisitRemoveId(visitId)
    if (confirmVisitTimer.current) clearTimeout(confirmVisitTimer.current)
    confirmVisitTimer.current = setTimeout(() => setConfirmVisitRemoveId(null), 3000)
  }

  return (
    <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {r.name}
            </p>
            {vtEntry && (
              <span
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ background: vtColor, color: 'white' }}
              >
                {vtEntry.icon} {vtEntry.label}
              </span>
            )}
            {r.visits.length > 0 && (
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {r.visits.length} visit{r.visits.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {r.address && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {r.address}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onEdit}
            className="p-1 transition-colors"
            title="Edit"
            style={{ color: 'var(--text-muted)' }}
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={onResearch}
            disabled={researching}
            className="p-1 transition-colors"
            title="AI Research"
            style={{ color: researching ? 'var(--accent-amber)' : 'var(--text-muted)' }}
          >
            <Sparkle size={14} className={researching ? 'animate-spin' : ''} />
          </button>
          {confirmRemove ? (
            <button
              onClick={() => {
                if (confirmTimer.current) clearTimeout(confirmTimer.current)
                setConfirmRemove(false)
                onRemove()
              }}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-lg transition-colors"
              style={{ background: 'var(--accent-red)', color: 'white' }}
            >
              <X size={10} /> Unsave?
            </button>
          ) : (
            <button
              onClick={() => {
                setConfirmRemove(true)
                confirmTimer.current = setTimeout(() => setConfirmRemove(false), 3000)
              }}
              className="p-1"
            >
              <Heart size={14} fill="#ff375f" style={{ color: '#ff375f' }} />
            </button>
          )}
        </div>
      </div>

      {/* Ratings row: Google + My Average */}
      <div className="flex items-center gap-3 mt-2">
        {r.rating && (
          <div className="flex items-center gap-1">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Google
            </span>
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'var(--accent-amber)', color: 'white' }}
            >
              {r.rating.toFixed(1)}
            </span>
          </div>
        )}
        {r.averageRating != null && (
          <div className="flex items-center gap-1">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              My avg
            </span>
            <span
              className="text-xs px-1.5 py-0.5 rounded font-medium"
              style={{ background: '#ff9f0a', color: 'white' }}
            >
              {r.averageRating.toFixed(1)}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              ({r.visits.length})
            </span>
          </div>
        )}
        {todaysVisit && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ background: 'rgba(52,211,153,0.15)', color: 'var(--accent-green)' }}
          >
            Today logged
          </span>
        )}
        {visitSubmitStatus && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ background: 'rgba(52,211,153,0.15)', color: 'var(--accent-green)' }}
          >
            {visitSubmitStatus}
          </span>
        )}
      </div>

      {/* Per-day visit entry. Saving the same date edits that day's visit instead of creating duplicates. */}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={showVisitForm ? () => setShowVisitForm(false) : startNewVisit}
          className="text-[10px] px-2 py-1 rounded transition-colors"
          style={{
            background: showVisitForm ? 'var(--bg-secondary)' : '#ff9f0a',
            color: showVisitForm ? 'var(--text-muted)' : 'white',
          }}
        >
          {showVisitForm ? 'Hide visit form' : todaysVisit ? 'Edit today visit' : 'Log visit'}
        </button>
        {r.visits.length > 0 && (
          <button
            onClick={() => setShowVisits(!showVisits)}
            className="text-[10px] flex items-center gap-1 transition-colors hover:underline"
            style={{ color: 'var(--text-muted)' }}
          >
            {showVisits ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {showVisits ? 'Hide' : 'View'} past reviews
          </button>
        )}
      </div>

      {showVisitForm && (
        <div
          className="mt-2 p-2 rounded-lg space-y-2"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--separator)' }}
        >
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={visitDate}
              onChange={(e) => {
                const nextDate = e.target.value
                const existing = r.visits.find((v) => v.visitDate === nextDate)
                setVisitDate(nextDate)
                setEditingVisitId(existing?.id ?? null)
                setSelectedVisitId(existing?.id ?? selectedVisitId)
                setVisitRating(existing?.rating ?? null)
                setVisitNotes(existing?.notes || '')
              }}
              className="text-[10px] px-2 py-1 rounded outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--separator)',
                colorScheme: 'dark',
              }}
            />
            <div className="flex" onMouseLeave={() => setHoverStar(0)}>
              {[1, 2, 3, 4, 5].map((star) => {
                const filled = star <= (hoverStar || visitRating || 0)
                return (
                  <button
                    key={star}
                    onMouseEnter={() => setHoverStar(star)}
                    onClick={() => setVisitRating(star)}
                    className="p-0 transition-colors"
                    title={`${star}/5`}
                  >
                    <Star
                      size={14}
                      fill={filled ? '#ff9f0a' : 'none'}
                      style={{ color: filled ? '#ff9f0a' : 'var(--border)' }}
                    />
                  </button>
                )
              })}
            </div>
            <button
              onClick={submitVisit}
              disabled={!visitDate || visitRating == null}
              className="ml-auto text-[10px] px-2 py-1 rounded transition-colors disabled:opacity-40"
              style={{ background: '#ff9f0a', color: 'white' }}
            >
              {hasSavedVisitForDate ? 'Update visit' : 'Save visit'}
            </button>
            {(editingVisitId || todaysVisit) && (
              <button
                onClick={resetVisitForm}
                className="text-[10px] px-2 py-1 rounded"
                style={{ color: 'var(--text-muted)' }}
              >
                Reset
              </button>
            )}
          </div>
          <textarea
            value={visitNotes}
            onChange={(e) => setVisitNotes(e.target.value)}
            placeholder="What was good, what to order, who to bring..."
            className="w-full text-[11px] px-2 py-1.5 rounded outline-none resize-none"
            rows={2}
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--separator)',
            }}
          />
        </div>
      )}

      {showVisits && r.visits.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {visibleVisits.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelectedVisitId(v.id)}
              className="flex w-full items-center justify-between text-[10px] px-2 py-1 rounded text-left transition-colors"
              style={{
                background:
                  selectedVisit?.id === v.id ? 'rgba(59,130,246,0.14)' : 'var(--bg-secondary)',
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span style={{ color: 'var(--text-muted)' }}>{v.visitDate}</span>
                {v.rating != null && (
                  <span className="flex items-center gap-0.5">
                    <Star size={9} fill="#ff9f0a" style={{ color: '#ff9f0a' }} /> {v.rating}
                  </span>
                )}
                <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                  {v.notes || 'No review notes'}
                </span>
              </div>
              <ChevronRight size={10} style={{ color: 'var(--text-muted)' }} />
            </button>
          ))}
          {selectedVisit && (
            <div
              className="rounded-lg p-2 text-[11px] space-y-1.5"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--separator)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span style={{ color: 'var(--text-muted)' }}>{selectedVisit.visitDate}</span>
                  {selectedVisit.rating != null && (
                    <span className="flex items-center gap-1" style={{ color: '#ff9f0a' }}>
                      <Star size={11} fill="#ff9f0a" /> {selectedVisit.rating}/5
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => editVisit(selectedVisit)}
                    className="p-0.5 transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                    title="Edit visit"
                  >
                    <Pencil size={10} />
                  </button>
                  <button
                    onClick={() => requestRemoveVisit(selectedVisit.id)}
                    className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
                    style={{
                      background:
                        confirmVisitRemoveId === selectedVisit.id
                          ? 'var(--accent-red)'
                          : 'transparent',
                      color:
                        confirmVisitRemoveId === selectedVisit.id ? 'white' : 'var(--text-muted)',
                    }}
                    title="Remove visit"
                  >
                    {confirmVisitRemoveId === selectedVisit.id ? 'Confirm delete' : <X size={10} />}
                  </button>
                </div>
              </div>
              <p
                className="whitespace-pre-wrap leading-relaxed"
                style={{
                  color: selectedVisit.notes ? 'var(--text-secondary)' : 'var(--text-muted)',
                }}
              >
                {selectedVisit.notes || 'No review notes saved for this visit.'}
              </p>
            </div>
          )}
          {r.visits.length > 3 && (
            <button
              onClick={() => setShowAllVisits((current) => !current)}
              className="text-[10px] flex items-center gap-1 transition-colors hover:underline"
              style={{ color: 'var(--text-muted)' }}
            >
              {showAllVisits ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              {showAllVisits
                ? 'Show latest 3'
                : `Show ${hiddenVisitCount} more visit${hiddenVisitCount !== 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      )}

      {!isPlace && (
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          {r.priceLevel && (
            <span className="text-xs font-medium" style={{ color: 'var(--accent-green)' }}>
              {priceLabel(r.priceLevel)}
            </span>
          )}
          {r.cuisineCategory && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            >
              {r.cuisineCategory}
            </span>
          )}
          {r.spiceLevel && r.spiceLevel !== 'none' && (
            <span
              className="flex items-center gap-0.5 text-[10px]"
              style={{ color: SPICE_LEVELS.find((s) => s.id === r.spiceLevel)?.color }}
            >
              <Flame size={9} /> {SPICE_LEVELS.find((s) => s.id === r.spiceLevel)?.label}
            </span>
          )}
        </div>
      )}

      {!isPlace && (r.bookingAdvanceDays != null || r.bookingAdvance) && (
        <div className="flex flex-wrap items-center gap-3 mt-1.5">
          <span
            className="flex items-center gap-1 text-xs"
            style={{ color: 'var(--accent-purple)' }}
          >
            <CalendarClock size={10} /> {formatBookingAdvanceLabel(r)}
          </span>
          {r.peakTimes && !r.busyDaysMatrix && (
            <span
              className="flex items-center gap-1 text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              <Clock size={10} /> Peak: {r.peakTimes}
            </span>
          )}
        </div>
      )}

      {r.busyDaysMatrix && (
        <div className="mt-1.5">
          <BusyDaysHeatmap matrix={r.busyDaysMatrix} />
        </div>
      )}

      {r.description && (
        <p className="text-xs mt-1.5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {r.description}
        </p>
      )}

      {r.notes && (
        <p className="text-xs mt-1 italic" style={{ color: 'var(--text-muted)' }}>
          {r.notes}
        </p>
      )}

      <div className="flex gap-2 mt-2">
        <button
          onClick={() =>
            window.open(
              `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' ' + r.address)}`,
              '_blank',
            )
          }
          className="text-[10px] flex items-center gap-1 transition-colors hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          <MapPin size={9} /> Maps
        </button>
        {r.reservationLink ? (
          <button
            onClick={() => window.open(r.reservationLink!, '_blank')}
            className="text-[10px] flex items-center gap-1 transition-colors hover:underline"
            style={{ color: 'var(--accent-purple)' }}
          >
            <ExternalLink size={9} /> Reserve
          </button>
        ) : (
          <button
            onClick={() =>
              window.open(
                `https://www.opentable.com/s?term=${encodeURIComponent(r.name)}`,
                '_blank',
              )
            }
            className="text-[10px] flex items-center gap-1 transition-colors hover:underline"
            style={{ color: 'var(--text-muted)' }}
          >
            <ExternalLink size={9} /> OpenTable
          </button>
        )}
      </div>
    </div>
  )
}

function hasMapCoordinates(r: SavedRestaurant): boolean {
  return (
    Number.isFinite(r.lat) &&
    Number.isFinite(r.lng) &&
    Math.abs(r.lat) > 0.0001 &&
    Math.abs(r.lng) > 0.0001
  )
}

function TravelDistanceSummary({ destination, active }: { destination: string; active: boolean }) {
  const [distance, setDistance] = useState<DistanceInfo | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!active || !destination.trim() || distance || loading) return

    let cancelled = false
    setLoading(true)
    window.api
      .getDistanceFromHome(destination)
      .then((d: DistanceInfo | null) => {
        if (!cancelled) setDistance(d)
      })
      .catch(() => {
        if (!cancelled) setDistance(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [active, destination, distance, loading])

  if (!active) return null

  if (loading) {
    return (
      <div
        style={{
          marginTop: 8,
          padding: '6px 8px',
          borderRadius: 8,
          background: '#f3f4f6',
          color: '#6b7280',
          fontSize: 10,
        }}
      >
        Calculating travel time from home...
      </div>
    )
  }

  if (!distance) return null

  const items = [
    { key: 'driving', label: 'Drive', value: distance.driving },
    { key: 'transit', label: 'Transit', value: distance.transit },
    { key: 'walking', label: 'Walk', value: distance.walking },
  ].filter((item) => item.value)

  if (items.length === 0) return null

  return (
    <div style={{ marginTop: 8, borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
      <div
        style={{
          padding: '4px 7px',
          background: '#f9fafb',
          color: '#6b7280',
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        From home
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
          gap: 1,
          background: '#e5e7eb',
        }}
      >
        {items.map((item) => (
          <div
            key={item.key}
            style={{ background: 'white', padding: '6px 5px', textAlign: 'center' }}
          >
            <div style={{ fontSize: 10, color: '#6b7280' }}>{item.label}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#111827' }}>
              {item.value!.duration}
            </div>
            <div style={{ fontSize: 10, color: '#6b7280' }}>{item.value!.distance}</div>
          </div>
        ))}
      </div>
      {!distance.walking && distance.driving && (
        <div style={{ padding: '4px 7px', background: '#f9fafb', color: '#6b7280', fontSize: 10 }}>
          Too far to walk ({distance.driving.distance})
        </div>
      )}
    </div>
  )
}

function NearbyPopup({
  place,
  active,
  description,
  describing,
  onMoreInfo,
  onSave,
}: {
  place: Restaurant
  active: boolean
  description?: string
  describing: boolean
  onMoreInfo: () => void
  onSave: () => void
}) {
  const [saved, setSaved] = useState(false)
  const venueType = inferNearbyVenueType(place)
  const color = venueTypeColor[venueType] || '#ff9f0a'
  const destination = place.address || place.name
  return (
    <div style={{ fontSize: 12, lineHeight: 1.6, minWidth: 250, maxWidth: 290 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ flex: 1 }}>{place.name}</strong>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 9,
            padding: '1px 6px',
            borderRadius: 999,
            background: color,
            color: 'white',
          }}
        >
          <span>{venueTypeGlyph[venueType]}</span>
          {venueTypeLabel(venueType)}
        </span>
      </div>
      {place.address && <div style={{ fontSize: 10, opacity: 0.7 }}>{place.address}</div>}
      {place.rating && (
        <div style={{ fontSize: 10 }}>
          Rating: {place.rating} ★ ({place.totalRatings})
        </div>
      )}
      {place.priceLevel && (
        <div style={{ fontSize: 10 }}>Price: {PRICE_LABELS_SHORT[place.priceLevel]}</div>
      )}
      {place.openNow !== null && (
        <div style={{ fontSize: 10, color: place.openNow ? '#34d399' : '#f87171' }}>
          {place.openNow ? 'Open now' : 'Closed'}
        </div>
      )}
      <TravelDistanceSummary destination={destination} active={active} />
      {description && (
        <div
          style={{
            marginTop: 8,
            padding: '7px 8px',
            borderRadius: 8,
            background: '#f9fafb',
            color: '#374151',
            fontSize: 10,
            lineHeight: 1.45,
          }}
        >
          {description}
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={onMoreInfo}
          disabled={describing || Boolean(description)}
          style={{
            fontSize: 10,
            padding: '3px 10px',
            borderRadius: 6,
            background: description ? '#e5e7eb' : '#7c3aed',
            color: description ? '#6b7280' : 'white',
            border: 'none',
            cursor: describing || description ? 'default' : 'pointer',
          }}
        >
          {describing ? 'Loading...' : description ? 'Info loaded' : 'More info'}
        </button>
        {!saved ? (
          <button
            onClick={() => {
              onSave()
              setSaved(true)
            }}
            style={{
              fontSize: 10,
              padding: '3px 10px',
              borderRadius: 6,
              background: '#34d399',
              color: 'white',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            + Save Place
          </button>
        ) : (
          <span
            style={{
              fontSize: 10,
              padding: '3px 10px',
              borderRadius: 6,
              background: '#374151',
              color: '#9ca3af',
            }}
          >
            ✓ Saved
          </span>
        )}
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name + ' ' + place.address)}`}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 10,
            padding: '3px 10px',
            borderRadius: 6,
            background: '#1e293b',
            color: '#22d3ee',
            textDecoration: 'none',
            border: '1px solid #334155',
          }}
        >
          Open in Maps
        </a>
      </div>
    </div>
  )
}

function SavedPlacePopup({
  place,
  active,
  description,
  describing,
  onMoreInfo,
}: {
  place: SavedRestaurant
  active: boolean
  description?: string
  describing: boolean
  onMoreInfo: () => void
}) {
  const isFood = FOOD_VENUE_TYPES.includes(place.venueType)
  const destination = place.address || place.name
  const aiDescription = description || place.description || undefined

  return (
    <div style={{ fontSize: 12, lineHeight: 1.6, minWidth: 250, maxWidth: 290 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ flex: 1 }}>{place.name}</strong>
        <span
          style={{
            fontSize: 9,
            padding: '1px 5px',
            borderRadius: 8,
            background: isFood ? '#ff6b6b' : '#a78bfa',
            color: 'white',
          }}
        >
          {VENUE_TYPES.find((v) => v.id === place.venueType)?.label || (isFood ? 'Food' : 'Place')}
        </span>
      </div>
      {place.address && <div style={{ fontSize: 10, opacity: 0.7 }}>{place.address}</div>}
      {place.rating && <div style={{ fontSize: 10 }}>Rating: {place.rating} star</div>}
      {place.priceLevel && (
        <div style={{ fontSize: 10 }}>Price: {PRICE_LABELS_SHORT[place.priceLevel]}</div>
      )}
      <TravelDistanceSummary destination={destination} active={active} />
      {aiDescription && (
        <div
          style={{
            marginTop: 8,
            padding: '7px 8px',
            borderRadius: 8,
            background: '#f9fafb',
            color: '#374151',
            fontSize: 10,
            lineHeight: 1.45,
          }}
        >
          {aiDescription}
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={onMoreInfo}
          disabled={describing || Boolean(description)}
          style={{
            fontSize: 10,
            padding: '3px 10px',
            borderRadius: 6,
            background: description ? '#e5e7eb' : '#7c3aed',
            color: description ? '#6b7280' : 'white',
            border: 'none',
            cursor: describing || description ? 'default' : 'pointer',
          }}
        >
          {describing ? 'Loading...' : description ? 'Info loaded' : 'More info'}
        </button>
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name + ' ' + place.address)}`}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 10,
            padding: '3px 10px',
            borderRadius: 6,
            background: '#1e293b',
            color: '#22d3ee',
            textDecoration: 'none',
            border: '1px solid #334155',
          }}
        >
          Open in Maps
        </a>
      </div>
    </div>
  )
}

function MapFlyTo({
  center,
  zoom,
  version,
}: {
  center: [number, number]
  zoom: number
  version: number
}) {
  const map = useMap()
  useEffect(() => {
    if (version > 0) map.flyTo(center, zoom, { duration: 0.5 })
  }, [version]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

const RADIUS_OPTIONS = [
  { miles: 0.31, label: '500m' },
  { miles: 0.62, label: '1 km' },
  { miles: 1, label: '1 mi' },
  { miles: 2, label: '2 mi' },
  { miles: 3, label: '3 mi' },
]

const PRICE_LABELS_SHORT: Record<number, string> = { 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' }

function PlacesMap({
  places,
  selectedType,
  onSelectedTypeChange,
  onSavePlace,
}: {
  places: SavedRestaurant[]
  selectedType: VenueType | 'all'
  onSelectedTypeChange: (type: VenueType | 'all') => void
  onSavePlace: (r: Restaurant) => void
}) {
  const mappable = places.filter(hasMapCoordinates)
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'food' | 'places'>('all')
  const categoryFiltered = useMemo(() => {
    if (categoryFilter === 'food')
      return mappable.filter((p) => FOOD_VENUE_TYPES.includes(p.venueType))
    if (categoryFilter === 'places')
      return mappable.filter((p) => !FOOD_VENUE_TYPES.includes(p.venueType))
    return mappable
  }, [mappable, categoryFilter])
  const filtered =
    selectedType === 'all'
      ? categoryFiltered
      : categoryFiltered.filter((p) => p.venueType === selectedType)
  const missingCoords = places.length - mappable.length
  const typesInUse = VENUE_TYPES.filter((v) => categoryFiltered.some((p) => p.venueType === v.id))
  const savedIds = useMemo(() => new Set(places.map((p) => p.placeId)), [places])

  const foodCount = mappable.filter((p) => FOOD_VENUE_TYPES.includes(p.venueType)).length
  const placesCount = mappable.filter((p) => !FOOD_VENUE_TYPES.includes(p.venueType)).length

  const FOOD_PRIMARY_TYPES = new Set([
    'restaurant',
    'cafe',
    'bar',
    'bakery',
    'ice_cream_shop',
    'coffee_shop',
    'meal_takeaway',
    'meal_delivery',
    'food',
  ])
  const isNearbyFood = (r: Restaurant) => FOOD_PRIMARY_TYPES.has(r.primaryType || '')

  const [mapVersion, setMapVersion] = useState(0)
  const [flyTarget, setFlyTarget] = useState<{ center: [number, number]; zoom: number }>({
    center: [41.88, -87.63],
    zoom: 13,
  })
  const [selectedPlace, setSelectedPlace] = useState<SavedRestaurant | null>(null)
  const [selectedNearbyPlace, setSelectedNearbyPlace] = useState<Restaurant | null>(null)
  const [nearbyFilter, setNearbyFilter] = useState<'all' | 'food' | 'places'>('all')
  const [nearbyResults, setNearbyResults] = useState<Restaurant[]>([])
  const [nearbySearching, setNearbySearching] = useState(false)
  const [nearbyRadius, setNearbyRadius] = useState(1)
  const [nearbyCenter, setNearbyCenter] = useState<{ lat: number; lng: number } | null>(null)
  const [nearbyAddress, setNearbyAddress] = useState('')
  const [placeDescriptions, setPlaceDescriptions] = useState<Record<string, string>>({})
  const [describingPlace, setDescribingPlace] = useState<string | null>(null)

  const handleDescribe = async (place: {
    placeId: string
    name: string
    address?: string | null
    primaryType?: string | null
    venueType?: string | null
  }) => {
    const key = place.placeId
    if (placeDescriptions[key]) return
    setDescribingPlace(key)
    try {
      const desc = await window.api.describePlace(
        place.name,
        place.address || '',
        place.primaryType || place.venueType,
      )
      setPlaceDescriptions((prev) => ({ ...prev, [key]: desc }))
    } catch {
      setPlaceDescriptions((prev) => ({ ...prev, [key]: 'Could not load description.' }))
    }
    setDescribingPlace(null)
  }

  const filteredNearby = useMemo(() => {
    if (nearbyFilter === 'food') return nearbyResults.filter(isNearbyFood)
    if (nearbyFilter === 'places') return nearbyResults.filter((r) => !isNearbyFood(r))
    return nearbyResults
  }, [nearbyResults, nearbyFilter])

  const bounds = useMemo(() => {
    const allPoints = [
      ...filtered.map((p) => ({ lat: p.lat, lng: p.lng })),
      ...filteredNearby.map((r) => ({ lat: r.lat, lng: r.lng })),
    ]
    if (allPoints.length === 0) return null
    const pad = 0.008
    return [
      [
        Math.min(...allPoints.map((p) => p.lat)) - pad,
        Math.min(...allPoints.map((p) => p.lng)) - pad,
      ],
      [
        Math.max(...allPoints.map((p) => p.lat)) + pad,
        Math.max(...allPoints.map((p) => p.lng)) + pad,
      ],
    ] as [[number, number], [number, number]]
  }, [filtered, filteredNearby])

  const center = useMemo(() => {
    if (nearbyCenter) return [nearbyCenter.lat, nearbyCenter.lng] as [number, number]
    if (filtered.length === 0) return [41.88, -87.63] as [number, number]
    const avgLat = filtered.reduce((s, p) => s + p.lat, 0) / filtered.length
    const avgLng = filtered.reduce((s, p) => s + p.lng, 0) / filtered.length
    return [avgLat, avgLng] as [number, number]
  }, [filtered, nearbyCenter])

  // Map zoom level for a given radius in miles
  const zoomForRadius = (miles: number) => {
    if (miles <= 0.35) return 16
    if (miles <= 0.7) return 15
    if (miles <= 1.2) return 14
    if (miles <= 2.5) return 13
    return 12
  }

  const searchNearby = async (lat: number, lng: number, radius: number) => {
    setNearbySearching(true)
    setNearbyCenter({ lat, lng })
    setSelectedNearbyPlace(null)
    setFlyTarget({ center: [lat, lng], zoom: zoomForRadius(radius) })
    setMapVersion((v) => v + 1)
    try {
      const results = await window.api.searchNearbyPlaces({
        lat,
        lng,
        radiusMiles: radius,
      })
      setNearbyResults((results || []).filter((r: Restaurant) => !savedIds.has(r.placeId)))
    } catch {
      setNearbyResults([])
    }
    setNearbySearching(false)
  }

  const searchAroundAddress = async () => {
    if (!nearbyAddress.trim()) return
    setNearbySearching(true)
    try {
      const results = await window.api.searchRestaurants(nearbyAddress.trim())
      if (results && results.length > 0 && results[0].lat && results[0].lng) {
        await searchNearby(results[0].lat, results[0].lng, nearbyRadius)
      } else {
        setNearbyResults([])
        setNearbySearching(false)
      }
    } catch {
      setNearbyResults([])
      setNearbySearching(false)
    }
  }

  const searchAroundPlace = (p: SavedRestaurant) => {
    setNearbyAddress(p.address || p.name)
    searchNearby(p.lat, p.lng, nearbyRadius)
  }

  const panToLocation = (lat: number, lng: number, zoom = 16) => {
    setFlyTarget({ center: [lat, lng], zoom })
    setMapVersion((v) => v + 1)
  }

  const selectSavedPlace = (p: SavedRestaurant, focusMap = false) => {
    setSelectedNearbyPlace(null)
    setSelectedPlace(p)
    if (focusMap) {
      panToLocation(p.lat, p.lng)
    }
  }

  const selectNearbyPlace = (r: Restaurant, focusMap = false) => {
    setSelectedPlace(null)
    setSelectedNearbyPlace(r)
    if (focusMap) {
      panToLocation(r.lat, r.lng)
    }
  }

  const clearSelectedPlace = () => {
    setSelectedPlace(null)
    setSelectedNearbyPlace(null)
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            className="text-sm font-medium flex items-center gap-2"
            style={{ color: 'var(--accent-cyan)' }}
          >
            <MapPin size={14} /> Saved Places Map
          </h3>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Showing {filtered.length} of {mappable.length} saved locations with coordinates.
            {nearbyResults.length > 0 && <> + {nearbyResults.length} nearby suggestions.</>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {/* Category toggle */}
          <div className="flex gap-1">
            {[
              {
                id: 'all' as const,
                label: 'All',
                count: mappable.length,
                color: 'var(--accent-cyan)',
              },
              { id: 'food' as const, label: 'Restaurants', count: foodCount, color: '#ff6b6b' },
              { id: 'places' as const, label: 'Places', count: placesCount, color: '#a78bfa' },
            ].map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setCategoryFilter(c.id)
                  onSelectedTypeChange('all')
                }}
                className="text-[10px] px-2.5 py-1 rounded-full transition-colors"
                style={{
                  background: categoryFilter === c.id ? c.color : 'var(--bg-tertiary)',
                  color: categoryFilter === c.id ? 'white' : 'var(--text-muted)',
                }}
              >
                {c.label} ({c.count})
              </button>
            ))}
          </div>
          {/* Type filters */}
          <div className="flex flex-wrap justify-end gap-1">
            <button
              onClick={() => onSelectedTypeChange('all')}
              className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
              style={{
                background: selectedType === 'all' ? 'var(--accent-cyan)' : 'var(--bg-tertiary)',
                color: selectedType === 'all' ? 'white' : 'var(--text-muted)',
              }}
            >
              All types
            </button>
            {typesInUse.map((v) => (
              <button
                key={v.id}
                onClick={() => onSelectedTypeChange(selectedType === v.id ? 'all' : v.id)}
                className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition-colors"
                style={{
                  background: selectedType === v.id ? venueTypeColor[v.id] : 'var(--bg-tertiary)',
                  color: selectedType === v.id ? 'white' : 'var(--text-muted)',
                }}
              >
                {v.icon} {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Nearby Search Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={nearbyAddress}
          onChange={(e) => setNearbyAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && searchAroundAddress()}
          placeholder="Search around an address or place..."
          className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg text-xs outline-none"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          }}
        />
        <div className="flex gap-1">
          {RADIUS_OPTIONS.map((r) => (
            <button
              key={r.miles}
              onClick={() => {
                setNearbyRadius(r.miles)
                if (nearbyCenter) searchNearby(nearbyCenter.lat, nearbyCenter.lng, r.miles)
              }}
              className="text-[10px] px-2 py-1 rounded transition-colors"
              style={{
                background: nearbyRadius === r.miles ? 'var(--accent-cyan)' : 'var(--bg-tertiary)',
                color: nearbyRadius === r.miles ? 'white' : 'var(--text-muted)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          onClick={searchAroundAddress}
          disabled={nearbySearching || !nearbyAddress.trim()}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          style={{ background: '#ff9f0a', color: 'white' }}
        >
          {nearbySearching ? (
            <RefreshCw size={12} className="animate-spin" />
          ) : (
            <Search size={12} />
          )}
          Discover Nearby
        </button>
        {nearbyResults.length > 0 && (
          <button
            onClick={() => {
              setNearbyResults([])
              setNearbyCenter(null)
              setSelectedNearbyPlace(null)
            }}
            className="text-[10px] px-2 py-1 rounded transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div
          className="col-span-2 overflow-hidden rounded-lg"
          style={{ height: 560, border: '1px solid var(--separator)' }}
        >
          <MapContainer
            center={center}
            zoom={13}
            scrollWheelZoom={true}
            style={{ height: '100%', width: '100%' }}
            attributionControl={false}
          >
            <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
            <MapFlyTo center={flyTarget.center} zoom={flyTarget.zoom} version={mapVersion} />

            {/* Radius circle */}
            {nearbyCenter && (
              <Circle
                center={[nearbyCenter.lat, nearbyCenter.lng]}
                radius={nearbyRadius * 1609.34}
                pathOptions={{
                  color: '#ff9f0a',
                  fillColor: '#ff9f0a',
                  fillOpacity: 0.06,
                  weight: 1,
                  dashArray: '6 4',
                }}
              />
            )}

            {/* Saved places */}
            {filtered.map((rawPlace) => {
              const p = {
                ...rawPlace,
                description: rawPlace.description ?? '',
                priceLevel: rawPlace.priceLevel ?? 0,
              }
              const isFood = FOOD_VENUE_TYPES.includes(p.venueType)
              const selected = selectedPlace?.placeId === p.placeId
              return (
                <Marker
                  key={p.placeId}
                  position={[p.lat, p.lng]}
                  icon={createVenueMarkerIcon(p.venueType, { selected })}
                  zIndexOffset={selected ? 1000 : 0}
                  eventHandlers={{ click: () => selectSavedPlace(p) }}
                >
                  <Popup>
                    <SavedPlacePopup
                      place={p}
                      active={selected}
                      description={placeDescriptions[p.placeId]}
                      describing={describingPlace === p.placeId}
                      onMoreInfo={() => handleDescribe(p)}
                    />
                    {false && (
                      <div style={{ fontSize: 12, lineHeight: 1.6, minWidth: 180 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <strong>{p.name}</strong>
                          <span
                            style={{
                              fontSize: 9,
                              padding: '1px 5px',
                              borderRadius: 8,
                              background: isFood ? '#ff6b6b' : '#a78bfa',
                              color: 'white',
                            }}
                          >
                            {VENUE_TYPES.find((v) => v.id === p.venueType)?.label ||
                              (isFood ? 'Food' : 'Place')}
                          </span>
                        </div>
                        {p.address && <div style={{ fontSize: 10, opacity: 0.7 }}>{p.address}</div>}
                        {p.rating && <div style={{ fontSize: 10 }}>Rating: {p.rating} ★</div>}
                        {p.priceLevel && (
                          <div style={{ fontSize: 10 }}>
                            Price: {PRICE_LABELS_SHORT[p.priceLevel]}
                          </div>
                        )}
                        {p.description && (
                          <div style={{ fontSize: 10, marginTop: 4, opacity: 0.8 }}>
                            {p.description.slice(0, 120)}
                            {p.description.length > 120 ? '…' : ''}
                          </div>
                        )}
                        <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                          <a
                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + p.address)}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ fontSize: 10, color: '#22d3ee', textDecoration: 'underline' }}
                          >
                            Open in Maps
                          </a>
                        </div>
                      </div>
                    )}
                  </Popup>
                </Marker>
              )
            })}

            {/* Nearby suggestions */}
            {filteredNearby.map((r) => {
              const venueType = inferNearbyVenueType(r)
              const selected = selectedNearbyPlace?.placeId === r.placeId
              return (
                <Marker
                  key={`nearby-${r.placeId}`}
                  position={[r.lat, r.lng]}
                  icon={createVenueMarkerIcon(venueType, { nearby: true, selected })}
                  zIndexOffset={selected ? 1000 : 0}
                  eventHandlers={{ click: () => selectNearbyPlace(r) }}
                >
                  <Popup>
                    <NearbyPopup
                      place={r}
                      active={selected}
                      description={placeDescriptions[r.placeId]}
                      describing={describingPlace === r.placeId}
                      onMoreInfo={() => handleDescribe(r)}
                      onSave={() => {
                        onSavePlace(r)
                        setNearbyResults((prev) => prev.filter((p) => p.placeId !== r.placeId))
                      }}
                    />
                  </Popup>
                </Marker>
              )
            })}
          </MapContainer>
        </div>

        {/* Sidebar: selected place preview + list */}
        <div className="space-y-3 max-h-[560px] overflow-y-auto">
          {/* Selected place detail */}
          {selectedPlace && (
            <div
              className="p-3 rounded-lg space-y-2"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--accent-cyan)' }}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {selectedPlace.name}
                </p>
                <button
                  onClick={clearSelectedPlace}
                  className="shrink-0"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <X size={12} />
                </button>
              </div>
              {selectedPlace.address && (
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedPlace.address}
                </p>
              )}
              <div className="flex gap-3 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                {selectedPlace.rating && <span>{selectedPlace.rating} ★</span>}
                {selectedPlace.priceLevel && (
                  <span>{PRICE_LABELS_SHORT[selectedPlace.priceLevel]}</span>
                )}
                {selectedPlace.cuisine && <span>{selectedPlace.cuisine}</span>}
              </div>
              {selectedPlace.description && (
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedPlace.description}
                </p>
              )}
              {selectedPlace.notes && (
                <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                  {selectedPlace.notes}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() =>
                    window.open(
                      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedPlace.name + ' ' + selectedPlace.address)}`,
                      '_blank',
                    )
                  }
                  className="flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-colors hover:opacity-80"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-cyan)' }}
                >
                  <ExternalLink size={9} /> Open in Maps
                </button>
                <button
                  onClick={() => searchAroundPlace(selectedPlace)}
                  className="flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-colors hover:opacity-80"
                  style={{ background: 'var(--bg-tertiary)', color: '#ff9f0a' }}
                >
                  <Search size={9} /> Nearby
                </button>
              </div>
            </div>
          )}

          {/* Nearby results */}
          {nearbyResults.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium" style={{ color: '#ff9f0a' }}>
                  Nearby ({filteredNearby.length})
                </p>
                <div className="flex gap-1">
                  {[
                    { id: 'all' as const, label: 'All' },
                    { id: 'food' as const, label: 'Food' },
                    { id: 'places' as const, label: 'Places' },
                  ].map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setNearbyFilter(f.id)}
                      className="text-[9px] px-2 py-0.5 rounded-full transition-colors"
                      style={{
                        background: nearbyFilter === f.id ? '#ff9f0a' : 'var(--bg-tertiary)',
                        color: nearbyFilter === f.id ? 'white' : 'var(--text-muted)',
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              {filteredNearby.map((r) => {
                const venueType = inferNearbyVenueType(r)
                const color = venueTypeColor[venueType] || '#ff9f0a'
                const selected = selectedNearbyPlace?.placeId === r.placeId
                return (
                  <div
                    key={r.placeId}
                    className="p-2.5 rounded-lg cursor-pointer transition-colors hover:opacity-80"
                    style={{
                      background: selected ? 'var(--bg-secondary)' : 'var(--bg-tertiary)',
                      border: selected
                        ? '1px solid var(--accent-cyan)'
                        : '1px dashed rgba(255,159,10,0.3)',
                      borderLeft: `3px solid ${selected ? 'var(--accent-cyan)' : color}`,
                    }}
                    onClick={() => (selected ? clearSelectedPlace() : selectNearbyPlace(r, true))}
                  >
                    <div className="flex items-center gap-1.5">
                      <p
                        className="text-xs font-medium truncate flex-1"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {r.name}
                      </p>
                      <span
                        className="inline-flex items-center gap-1 text-[8px] px-1.5 py-0.5 rounded-full shrink-0"
                        style={{ background: color, color: 'white' }}
                      >
                        <span>{venueTypeGlyph[venueType]}</span>
                        {venueTypeLabel(venueType)}
                      </span>
                    </div>
                    {r.address && (
                      <p
                        className="text-[10px] mt-0.5 truncate"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {r.address}
                      </p>
                    )}
                    <div
                      className="flex gap-2 mt-0.5 text-[10px]"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {r.rating && (
                        <span>
                          {r.rating} ★ ({r.totalRatings})
                        </span>
                      )}
                      {r.priceLevel && <span>{PRICE_LABELS_SHORT[r.priceLevel]}</span>}
                      {r.openNow !== null && (
                        <span
                          style={{ color: r.openNow ? 'var(--accent-green)' : 'var(--accent-red)' }}
                        >
                          {r.openNow ? 'Open' : 'Closed'}
                        </span>
                      )}
                    </div>
                    {placeDescriptions[r.placeId] && (
                      <p
                        className="text-[10px] mt-1 leading-relaxed"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {placeDescriptions[r.placeId]}
                      </p>
                    )}
                    <div className="flex gap-2 mt-1.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onSavePlace(r)
                        }}
                        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-colors hover:opacity-80"
                        style={{ background: 'var(--accent-green)', color: 'white' }}
                      >
                        <Plus size={9} /> Save
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          window.open(
                            `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' ' + r.address)}`,
                            '_blank',
                          )
                        }}
                        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-colors hover:opacity-80"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                      >
                        <ExternalLink size={9} /> Maps
                      </button>
                      {!placeDescriptions[r.placeId] && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDescribe(r)
                          }}
                          disabled={describingPlace === r.placeId}
                          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-colors hover:opacity-80 disabled:opacity-50"
                          style={{
                            background: 'var(--bg-secondary)',
                            color: 'var(--accent-purple)',
                          }}
                        >
                          {describingPlace === r.placeId ? (
                            <RefreshCw size={9} className="animate-spin" />
                          ) : (
                            <Sparkles size={9} />
                          )}
                          {describingPlace === r.placeId ? 'Looking up...' : 'What is this?'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {/* Saved places list */}
          {filtered.length > 0 && (
            <>
              {nearbyResults.length > 0 && (
                <p className="text-[10px] font-medium pt-1" style={{ color: 'var(--accent-cyan)' }}>
                  Saved places
                </p>
              )}
              {filtered.map((p) => {
                const vt = VENUE_TYPES.find((v) => v.id === p.venueType)
                const isFood = FOOD_VENUE_TYPES.includes(p.venueType)
                return (
                  <div
                    key={p.placeId}
                    className="p-2.5 rounded-lg cursor-pointer transition-colors hover:opacity-80"
                    style={{
                      background:
                        selectedPlace?.placeId === p.placeId
                          ? 'var(--bg-secondary)'
                          : 'var(--bg-tertiary)',
                      border:
                        selectedPlace?.placeId === p.placeId
                          ? '1px solid var(--accent-cyan)'
                          : '1px solid transparent',
                      borderLeft: `3px solid ${isFood ? '#ff6b6b' : '#a78bfa'}`,
                    }}
                    onClick={() =>
                      selectedPlace?.placeId === p.placeId
                        ? clearSelectedPlace()
                        : selectSavedPlace(p, true)
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p
                          className="text-xs font-medium truncate"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {p.name}
                        </p>
                        {p.address && (
                          <p
                            className="text-[10px] mt-0.5 truncate"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {p.address}
                          </p>
                        )}
                      </div>
                      {vt && (
                        <span
                          className="shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
                          style={{ background: venueTypeColor[p.venueType], color: 'white' }}
                        >
                          {vt.icon}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {filtered.length === 0 && nearbyResults.length === 0 && (
            <p className="text-xs py-10 text-center" style={{ color: 'var(--text-muted)' }}>
              No saved locations with coordinates yet.
            </p>
          )}
        </div>
      </div>

      {missingCoords > 0 && (
        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {missingCoords} saved item{missingCoords === 1 ? '' : 's'} are address-only manual entries
          and are not plotted.
        </p>
      )}
    </div>
  )
}

function isTransitOrHomeStop(stop: string): boolean {
  const lower = stop.toLowerCase()
  return (
    lower.startsWith('en route') ||
    lower.startsWith('commute') ||
    /\(home\)\s*$/.test(lower) ||
    lower === 'home'
  )
}

function buildAgendaMapFromActivities(activities: WeekendActivity[]): AgendaMapDay {
  const stops = activities
    .map((activity) => activity.location || activity.activity)
    .filter((stop): stop is string => Boolean(stop?.trim()))
    .filter((stop) => !isTransitOrHomeStop(stop))
  const route = stops.length > 0 ? ['Home', ...stops] : []
  const legs = stops.map((stop, index) => ({
    from: index === 0 ? 'Home' : stops[index - 1],
    to: stop,
    transportation: activities[index]?.transportation,
    travelTime: activities[index]?.travelTime,
    note: activities[index]?.rationale,
  }))

  return { route, legs }
}

function withRefreshedAgendaMap(plan: WeekendPlanData): WeekendPlanData {
  const result = { ...plan }
  const agendaMap: Record<string, AgendaMapDay> = {}
  for (const day of DAY_ORDER) {
    const activities = getPlanActivities(plan, day)
    if (activities.length > 0) {
      result[day] = activities
      agendaMap[day] = buildAgendaMapFromActivities(activities)
    }
  }
  result.agendaMap = agendaMap
  return result
}

function addDaysToDateString(dateString: string | undefined, days: number): string {
  if (!dateString) return ''
  const date = new Date(`${dateString}T12:00:00`)
  if (Number.isNaN(date.getTime())) return dateString
  date.setDate(date.getDate() + days)
  return localDateStr(date)
}

function normalizeRouteStop(stop: unknown): string {
  return String(stop || '').trim()
}

function compactRouteStops(stops: string[]): string[] {
  const result: string[] = []
  for (const stop of stops.map(normalizeRouteStop).filter(Boolean)) {
    if (result[result.length - 1]?.toLowerCase() === stop.toLowerCase()) continue
    result.push(stop)
  }
  return result
}

function routeFromAgendaMap(plan: WeekendPlanData, day: string): string[] {
  const route = plan.agendaMap?.[day]?.route
  return Array.isArray(route) ? compactRouteStops(route) : []
}

function routeFromActivities(activities: WeekendActivity[]): string[] {
  const stops = activities
    .map((activity) => activity.location || activity.activity)
    .filter((stop): stop is string => Boolean(stop?.trim()))
    .filter((stop) => !isTransitOrHomeStop(stop))
  return stops.length > 0 ? ['Home', ...compactRouteStops(stops)] : []
}

function routeForDay(plan: WeekendPlanData, day: string): string[] {
  const agendaRoute = routeFromAgendaMap(plan, day)
  const activityRoute = routeFromActivities(getPlanActivities(plan, day))
  // Prefer agendaMap route, but fall back to activity-based route if agendaMap
  // has fewer stops (e.g., AI only generated ['Home'] or a partial route)
  if (agendaRoute.length >= activityRoute.length && agendaRoute.length > 0) return agendaRoute
  return activityRoute.length > 0 ? activityRoute : agendaRoute
}

function isHomeStop(stop: Pick<ResolvedStop, 'label' | 'query'>): boolean {
  const text = `${stop.label || ''} ${stop.query || ''}`.trim().toLowerCase()
  return text === 'home' || text.startsWith('home ') || text.includes(' home location')
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function activityForRouteStop(
  activities: WeekendActivity[],
  stop: ResolvedStop,
  index: number,
): WeekendActivity | undefined {
  if (isHomeStop(stop)) return undefined

  const query = normalizeForMatch(stop.query || stop.label || '')
  const address = normalizeForMatch(stop.address || '')
  const matched = activities.find((activity) => {
    const location = normalizeForMatch(activity.location || '')
    const title = normalizeForMatch(activity.activity || '')
    if (!location && !title) return false
    return (
      (location &&
        (query.includes(location) || location.includes(query) || address.includes(location))) ||
      (title && (query.includes(title) || title.includes(query)))
    )
  })
  if (matched) return matched

  const homeOffset = index > 0 ? 1 : 0
  return activities[index - homeOffset]
}

function ToggleChip({
  label,
  value,
  active,
  onClick,
  icon,
}: {
  label: string
  value: string
  active: boolean
  onClick: () => void
  icon?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
      style={{
        background: active ? 'var(--accent-cyan)' : 'var(--bg-tertiary)',
        color: active ? 'white' : 'var(--text-secondary)',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

// --- Day Place Picker ---

function DayPlacePicker({
  day,
  color,
  savedRestaurants,
  selectedIds,
  onSelectedChange,
  isOpen,
  onToggleOpen,
}: {
  day: string
  color: string
  savedRestaurants: SavedRestaurant[]
  selectedIds: Set<number>
  onSelectedChange: (ids: Set<number>) => void
  isOpen: boolean
  onToggleOpen: () => void
}) {
  const [search, setSearch] = useState('')
  const [cuisineFilter, setCuisineFilter] = useState('')
  const pickedCount = selectedIds.size

  const filtered = savedRestaurants.filter((r) => {
    if (cuisineFilter && (r.cuisineCategory || r.cuisine || r.venueType || '') !== cuisineFilter)
      return false
    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div>
      <button
        onClick={onToggleOpen}
        className="flex items-center gap-1.5 text-xs w-full transition-colors hover:opacity-80"
        style={{ color: 'var(--text-muted)' }}
      >
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <MapPin size={11} />
        Seed places for {dayLabel(day)}
        {pickedCount > 0 && (
          <span
            className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
            style={{ background: `${color}22`, color }}
          >
            {pickedCount}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                size={11}
                className="absolute left-2 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-muted)' }}
              />
              <input
                type="text"
                placeholder="Search saved places..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 rounded-md text-xs outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--separator)',
                }}
              />
            </div>
            <select
              value={cuisineFilter}
              onChange={(e) => setCuisineFilter(e.target.value)}
              className="px-2 py-1.5 rounded-md text-xs outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--separator)',
              }}
            >
              <option value="">All types</option>
              {[
                ...new Set(
                  savedRestaurants
                    .map((r) => r.cuisineCategory || r.cuisine || r.venueType || '')
                    .filter(Boolean),
                ),
              ]
                .sort()
                .map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
            </select>
            <div className="flex gap-1.5 text-[10px] whitespace-nowrap">
              <button
                onClick={() => onSelectedChange(new Set(filtered.map((r) => r.id)))}
                style={{ color }}
              >
                All
              </button>
              <button
                onClick={() => onSelectedChange(new Set())}
                style={{ color: 'var(--text-muted)' }}
              >
                Clear
              </button>
            </div>
          </div>
          <div
            className="max-h-36 overflow-y-auto rounded-lg p-1.5 space-y-0.5"
            style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--separator)',
            }}
          >
            {filtered.map((r) => {
              const checked = selectedIds.has(r.id)
              return (
                <label
                  key={r.id}
                  className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors hover:bg-white/[0.04]"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = new Set(selectedIds)
                      if (next.has(r.id)) next.delete(r.id)
                      else next.add(r.id)
                      onSelectedChange(next)
                    }}
                  />
                  <span
                    className="text-xs flex-1 truncate"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {r.name}
                  </span>
                  <span
                    className="text-[10px] truncate max-w-[40%]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {r.cuisineCategory || r.cuisine || r.venueType || ''}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Day Input Section (per-day params) ---

function DayInputSection({
  day,
  color,
  extraDetails,
  onExtraDetailsChange,
  wakeTime,
  onWakeTimeChange,
  themes,
  onThemesChange,
  energy,
  onEnergyChange,
  budget,
  onBudgetChange,
  pace,
  onPaceChange,
  transport,
  onTransportChange,
  locationStrategy,
  onLocationStrategyChange,
  discoveryMode,
  onDiscoveryModeChange,
  savedRestaurants,
  selectedSavedIds,
  onSelectedSavedIdsChange,
  showDayPlaces,
  onToggleDayPlaces,
  onGenerate,
  generating,
  hasActivities,
  viewingPast,
}: {
  day: string
  color: string
  extraDetails: string
  onExtraDetailsChange: (v: string) => void
  wakeTime: string
  onWakeTimeChange: (v: string) => void
  themes: Set<WeekendTheme>
  onThemesChange: (v: Set<WeekendTheme>) => void
  energy: 'low' | 'medium' | 'high'
  onEnergyChange: (v: 'low' | 'medium' | 'high') => void
  budget: 'free' | 'low' | 'medium' | 'high'
  onBudgetChange: (v: 'free' | 'low' | 'medium' | 'high') => void
  pace: 'relaxed' | 'moderate' | 'packed'
  onPaceChange: (v: 'relaxed' | 'moderate' | 'packed') => void
  transport: Set<string>
  onTransportChange: (v: Set<string>) => void
  locationStrategy: WeekendLocationStrategy
  onLocationStrategyChange: (v: WeekendLocationStrategy) => void
  discoveryMode: WeekendDiscoveryMode
  onDiscoveryModeChange: (v: WeekendDiscoveryMode) => void
  savedRestaurants: SavedRestaurant[]
  selectedSavedIds: Set<number>
  onSelectedSavedIdsChange: (ids: Set<number>) => void
  showDayPlaces: boolean
  onToggleDayPlaces: () => void
  onGenerate: () => void
  generating: boolean
  hasActivities: boolean
  viewingPast: boolean
}) {
  const [expanded, setExpanded] = useState(!hasActivities)

  return (
    <div
      className="rounded-lg p-3 space-y-3 mb-3"
      style={{ background: `${color}08`, border: `1px solid ${color}22` }}
    >
      <div className="flex items-center justify-between">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs font-medium"
          style={{ color }}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <SlidersHorizontal size={12} />
          {dayLabel(day)} Settings
        </button>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Sun size={11} style={{ color: 'var(--text-muted)' }} />
            <input
              type="time"
              value={wakeTime}
              onChange={(e) => onWakeTimeChange(e.target.value)}
              className="px-1.5 py-1 rounded text-xs outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--separator)',
                width: '5.5rem',
              }}
            />
          </div>
          {!viewingPast && (
            <button
              onClick={onGenerate}
              disabled={generating}
              className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors disabled:opacity-40"
              style={{ background: color, color: 'white' }}
            >
              <Sparkles size={11} />
              {generating ? 'Generating...' : hasActivities ? 'Regenerate' : `Generate ${dayLabel(day)}`}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-3">
          {/* Extra details */}
          <textarea
            value={extraDetails}
            onChange={(e) => onExtraDetailsChange(e.target.value)}
            placeholder={`Notes for ${dayLabel(day)}... e.g. dinner at 7, avoid downtown, group of 4`}
            rows={2}
            className="w-full px-3 py-2 rounded-lg text-xs outline-none resize-none"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--separator)',
            }}
          />

          {/* Themes */}
          <div>
            <label className="text-[10px] flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
              <Sparkle size={10} /> Themes
            </label>
            <div className="flex flex-wrap gap-1">
              {THEME_OPTIONS.map((t) => {
                const active = themes.has(t.id)
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      const next = new Set(themes)
                      if (next.has(t.id)) next.delete(t.id)
                      else next.add(t.id)
                      onThemesChange(next)
                    }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] transition-colors"
                    style={{
                      background: active ? color : 'var(--bg-tertiary)',
                      color: active ? 'white' : 'var(--text-secondary)',
                      border: active ? `1px solid ${color}` : '1px solid var(--separator)',
                    }}
                  >
                    <span>{t.emoji}</span>
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Energy / Budget / Pace row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
                <Zap size={10} /> Energy
              </label>
              <div className="flex gap-1">
                {(['low', 'medium', 'high'] as const).map((level) => (
                  <ToggleChip
                    key={level}
                    label={level === 'low' ? 'Low' : level === 'medium' ? 'Normal' : 'High'}
                    value={level}
                    active={energy === level}
                    onClick={() => onEnergyChange(level)}
                  />
                ))}
              </div>
            </div>
            <div>
              <label className="text-[10px] flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
                <DollarSign size={10} /> Budget
              </label>
              <div className="flex gap-1">
                {(['free', 'low', 'medium', 'high'] as const).map((level) => (
                  <ToggleChip
                    key={level}
                    label={level === 'free' ? 'Free' : level === 'low' ? '$' : level === 'medium' ? '$$' : '$$$'}
                    value={level}
                    active={budget === level}
                    onClick={() => onBudgetChange(level)}
                  />
                ))}
              </div>
            </div>
            <div>
              <label className="text-[10px] flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
                <Gauge size={10} /> Pace
              </label>
              <div className="flex gap-1">
                {(['relaxed', 'moderate', 'packed'] as const).map((level) => (
                  <ToggleChip
                    key={level}
                    label={level === 'relaxed' ? 'Chill' : level === 'moderate' ? 'Mod' : 'Full'}
                    value={level}
                    active={pace === level}
                    onClick={() => onPaceChange(level)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Transport */}
          <div>
            <label className="text-[10px] flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
              <Car size={10} /> Transport
            </label>
            <div className="flex flex-wrap gap-1">
              {TRANSPORTATION_OPTIONS.map((option) => (
                <ToggleChip
                  key={option.id}
                  label={option.label}
                  value={option.id}
                  active={transport.has(option.id)}
                  onClick={() => {
                    const next = new Set(transport)
                    if (next.has(option.id)) {
                      if (next.size > 1) next.delete(option.id)
                    } else next.add(option.id)
                    onTransportChange(next)
                  }}
                  icon={<Navigation size={9} />}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
                <MapPin size={10} /> Geography
              </label>
              <div className="flex flex-wrap gap-1">
                {LOCATION_STRATEGY_OPTIONS.map((option) => (
                  <ToggleChip
                    key={option.id}
                    label={option.label}
                    value={option.id}
                    active={locationStrategy === option.id}
                    onClick={() => onLocationStrategyChange(option.id)}
                  />
                ))}
              </div>
            </div>
            <div>
              <label className="text-[10px] flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
                <Sparkles size={10} /> Discovery
              </label>
              <div className="flex flex-wrap gap-1">
                {DISCOVERY_MODE_OPTIONS.map((option) => (
                  <ToggleChip
                    key={option.id}
                    label={option.label}
                    value={option.id}
                    active={discoveryMode === option.id}
                    onClick={() => onDiscoveryModeChange(option.id)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Place picker */}
          {savedRestaurants.length > 0 && (
            <DayPlacePicker
              day={day}
              color={color}
              savedRestaurants={savedRestaurants}
              selectedIds={selectedSavedIds}
              onSelectedChange={onSelectedSavedIdsChange}
              isOpen={showDayPlaces}
              onToggleOpen={onToggleDayPlaces}
            />
          )}
        </div>
      )}
    </div>
  )
}

// --- Main Page ---

export default function WeekendPage() {
  const [tab, setTab] = useState<Tab>('plan')
  const [plan, setPlan] = useState<WeekendPlanData | null>(null)
  const [storedPlan, setStoredPlan] = useState<StoredPlan | null>(null)
  const [events, setEvents] = useState<LocalEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [generatingDay, setGeneratingDay] = useState<string | null>(null)
  const [activePlanDay, setActivePlanDay] = useState<string | null>(null)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [weatherPreview, setWeatherPreview] = useState<PlannerWeatherPreview | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [tweakInputByDay, setTweakInputByDay] = useState<Record<string, string>>({})
  const [tweaking, setTweaking] = useState(false)
  const [tweakStatus, setTweakStatus] = useState<string | null>(null)
  const [tweakError, setTweakError] = useState<string | null>(null)
  const [preferences, setPreferences] = useState('')
  const [extraDetailsByDay, setExtraDetailsByDay] = useState<Record<string, string>>({})
  const [showEvents, setShowEvents] = useState(false)
  const [eventsFullPage, setEventsFullPage] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)
  const [pastPlans, setPastPlans] = useState<StoredPlan[]>([])
  const [showPastPlans, setShowPastPlans] = useState(false)
  const [viewingPastDate, setViewingPastDate] = useState<string | null>(null)
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventSearch, setEventSearch] = useState('')
  const [eventFocus, setEventFocus] = useState('')
  const [eventDetails, setEventDetails] = useState('')
  const [eventDate, setEventDate] = useState('')
  const [eventCategory, setEventCategory] = useState('all')
  const [eventPage, setEventPage] = useState(0)
  const [eventTotalPages, setEventTotalPages] = useState(0)
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false)
  const [webSearching, setWebSearching] = useState(false)
  const [webEvents, setWebEvents] = useState<LocalEvent[]>([])
  const [webSummary, setWebSummary] = useState('')
  const [webSearchInput, setWebSearchInput] = useState('')
  const [pushingToNotion, setPushingToNotion] = useState(false)
  const [notionPushed, setNotionPushed] = useState(false)
  const [notionDatabases, setNotionDatabases] = useState<{ id: string; title: string }[]>([])
  const [selectedDbId, setSelectedDbId] = useState<string>('')
  const [showDbPicker, setShowDbPicker] = useState(false)
  const [dbsLoading, setDbsLoading] = useState(false)
  const [savingPlan, setSavingPlan] = useState(false)
  const [savePlanStatus, setSavePlanStatus] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<LocalEvent | null>(null)

  // Schedule export ref
  const scheduleRef = useRef<HTMLDivElement>(null)
  const routeMapCaptureRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)

  // Route map state
  const [routeMapByDay, setRouteMapByDay] = useState<Record<string, ResolvedStop[]>>({})
  const [routeMapLoading, setRouteMapLoading] = useState(false)
  const [showRouteMap, setShowRouteMap] = useState(false)
  const [visibleRouteDays, setVisibleRouteDays] = useState<Set<string>>(new Set())

  // Date selection for multi-day planning
  const weekDates = useMemo(() => {
    const now = new Date()
    const dow = now.getDay()
    const daysUntilSat = dow === 6 ? 0 : 6 - dow
    const saturday = new Date(now)
    saturday.setDate(now.getDate() + daysUntilSat)
    const result: Array<{ date: string; dayName: string; dayKey: string; label: string }> = []
    for (let offset = -2; offset <= 4; offset++) {
      const d = new Date(saturday)
      d.setDate(saturday.getDate() + offset)
      result.push({
        date: localDateStr(d),
        dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
        dayKey: dateToDayKey(localDateStr(d)),
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      })
    }
    return result
  }, [])

  const [selectedDates, setSelectedDates] = useState<Set<string>>(() => {
    const satEntry = weekDates.find((d) => d.dayKey === 'saturday')
    const sunEntry = weekDates.find((d) => d.dayKey === 'sunday')
    return new Set([satEntry?.date, sunEntry?.date].filter(Boolean) as string[])
  })

  const selectedDateList = useMemo(() => Array.from(selectedDates).sort(), [selectedDates])

  useEffect(() => {
    if (selectedDateList.length === 0) return
    setWeatherLoading(true)
    window.api
      .getPlannerWeatherPreview(selectedDateList)
      .then(setWeatherPreview)
      .catch((err) =>
        setWeatherPreview({
          location: 'Unknown',
          source: 'Open-Meteo',
          days: [],
          unavailableReason: (err as Error)?.message || 'Weather preview unavailable.',
        }),
      )
      .finally(() => setWeatherLoading(false))
  }, [selectedDateList])

  // Adjustable parameters
  const [wakeTimes, setWakeTimes] = useState<Record<string, string>>({
    saturday: '09:00',
    sunday: '09:30',
  })
  const [energyByDay, setEnergyByDay] = useState<Record<string, 'low' | 'medium' | 'high'>>({})
  const [budgetByDay, setBudgetByDay] = useState<Record<string, 'free' | 'low' | 'medium' | 'high'>>({})
  const [paceByDay, setPaceByDay] = useState<Record<string, 'relaxed' | 'moderate' | 'packed'>>({})
  const [transportByDay, setTransportByDay] = useState<Record<string, Set<string>>>({})
  const [locationStrategyByDay, setLocationStrategyByDay] = useState<Record<string, WeekendLocationStrategy>>({})
  const [discoveryModeByDay, setDiscoveryModeByDay] = useState<Record<string, WeekendDiscoveryMode>>({})
  const [themesByDay, setThemesByDay] = useState<Record<string, Set<WeekendTheme>>>({})
  const [selectedSavedIdsByDay, setSelectedSavedIdsByDay] = useState<Record<string, Set<number>>>({})
  const [showDayPlaces, setShowDayPlaces] = useState<Record<string, boolean>>({})

  // Per-day accessor helpers with defaults
  const getEnergy = (day: string) => energyByDay[day] || 'medium'
  const getBudget = (day: string) => budgetByDay[day] || 'medium'
  const getPace = (day: string) => paceByDay[day] || 'moderate'
  const getTransport = (day: string) => transportByDay[day] || new Set(['driving'])
  const getLocationStrategy = (day: string) => locationStrategyByDay[day] || 'clustered'
  const getDiscoveryMode = (day: string) => discoveryModeByDay[day] || 'balanced'
  const getThemes = (day: string) => themesByDay[day] || new Set<WeekendTheme>()
  const getExtraDetails = (day: string) => extraDetailsByDay[day] || ''
  const getTweakInput = (day: string) => tweakInputByDay[day] || ''

  // Checked activities for selective Notion export
  const [checkedActivities, setCheckedActivities] = useState<Set<string>>(new Set())
  const [draggedActivity, setDraggedActivity] = useState<{ day: string; index: number } | null>(
    null,
  )

  // Restaurant state
  const [savedRestaurants, setSavedRestaurants] = useState<SavedRestaurant[]>([])
  const [searchResults, setSearchResults] = useState<Restaurant[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [suggestions, setSuggestions] = useState<
    { placeId: string; name: string; description: string }[]
  >([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const autocompleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [venueFilter, setVenueFilter] = useState<VenueType | 'all'>('all')
  const [placeTypeFilter, setPlaceTypeFilter] = useState<VenueType | 'all'>('all')
  const [mapTypeFilter, setMapTypeFilter] = useState<VenueType | 'all'>('all')
  const [cuisineFilter, setCuisineFilter] = useState<string>('all')
  const [savedSearchQuery, setSavedSearchQuery] = useState('')
  const [googleRatingFilter, setGoogleRatingFilter] = useState('all')
  const [personalRatingFilter, setPersonalRatingFilter] = useState('all')
  const [showAddForm, setShowAddForm] = useState(false)
  const [researchingId, setResearchingId] = useState<string | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState<{
    current: number
    total: number
    name: string
  } | null>(null)
  const [discoverQuery, setDiscoverQuery] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discoverResults, setDiscoverResults] = useState<any[] | null>(null)
  const [discoverRaw, setDiscoverRaw] = useState<string | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [addForm, setAddForm] = useState({
    name: '',
    address: '',
    venueType: 'restaurant' as VenueType,
    cuisineCategory: '',
    spiceLevel: '' as SpiceLevel | '',
    priceLevel: 0,
    bookingAdvance: '',
    notes: '',
  })
  const [addSearchResults, setAddSearchResults] = useState<Restaurant[]>([])
  const [addSearching, setAddSearching] = useState(false)
  const [addSelectedPlace, setAddSelectedPlace] = useState<Restaurant | null>(null)
  const [editingRestaurant, setEditingRestaurant] = useState<SavedRestaurant | null>(null)

  useEffect(() => {
    loadPlan()
    loadEvents()
    loadSavedRestaurants()
    loadPastPlans()
  }, [])

  useEffect(() => {
    window.api
      .getSettings('appSettings')
      .then((settings: any) => {
        if (settings?.transportMode) {
          setTransportByDay((prev) => {
            const next = { ...prev }
            for (const date of selectedDateList) {
              next[dateToDayKey(date)] = new Set([settings.transportMode])
            }
            return next
          })
        }
      })
      .catch((err) => console.warn('[Weekend] Failed to load transport settings:', err))
  }, [])

  useEffect(() => {
    setAddForm((f) => ({
      ...f,
      venueType:
        tab === 'places' && FOOD_VENUE_TYPES.includes(f.venueType)
          ? 'attraction'
          : tab === 'restaurants' && !FOOD_VENUE_TYPES.includes(f.venueType)
            ? 'restaurant'
            : f.venueType,
    }))
  }, [tab])

  // When plan changes, check all activities by default
  useEffect(() => {
    if (plan) {
      const allKeys = new Set<string>()
      for (const day of DAY_ORDER) {
        const short = DAY_SHORT[day]
        const activities = getPlanActivities(plan, day)
        activities.forEach((_: any, i: number) => allKeys.add(`${short}-${i}`))
      }
      setCheckedActivities(allKeys)
    }
  }, [plan])

  const loadPlan = async () => {
    setLoading(true)
    try {
      const stored = await window.api.getWeekendPlan()
      if (stored) {
        setStoredPlan(stored)
        try {
          setPlan(JSON.parse(stored.plan_json))
        } catch {}
        setNotes(stored.ai_rationale)
      }
      setViewingPastDate(null)
    } catch (err) {
      console.error('Failed to load weekend plan:', err)
    }
    setLoading(false)
  }

  const loadPastPlans = async () => {
    try {
      const list = (await window.api.listWeekendPlans(20)) as StoredPlan[]
      setPastPlans(list || [])
    } catch (err) {
      console.error('Failed to load past weekend plans:', err)
    }
  }

  const viewPastPlan = (p: StoredPlan) => {
    setStoredPlan(p)
    try {
      setPlan(JSON.parse(p.plan_json))
    } catch {
      setPlan(null)
    }
    setNotes(p.ai_rationale)
    setViewingPastDate(p.weekend_date)
    setShowPastPlans(false)
    setShowRouteMap(false)
    setRouteMapByDay({})
  }

  const loadEvents = async () => {
    setEventsLoading(true)
    try {
      const [result, cached] = await Promise.all([
        window.api.getWeekendEvents(),
        window.api.listCachedWeekendEvents?.(50).catch(() => []),
      ])
      const cachedEvents = ((cached || []) as CachedWeekendEvent[]).map((e) => ({
        id: e.event_key,
        name: e.name,
        type: e.type || e.category || 'other',
        date: e.event_date || '',
        time: e.time || 'TBD',
        venue: e.venue || '',
        address: e.address || '',
        city: e.city || '',
        priceRange: e.price_range || '',
        url: e.url || '',
        imageUrl: e.image_url || null,
        description: e.description || '',
        distance: null,
      }))
      setEvents(mergeLocalEvents(result || [], cachedEvents))
    } catch {}
    setEventsLoading(false)
  }

  const searchEvents = async (opts?: {
    page?: number
    append?: boolean
    keyword?: string
    date?: string
    category?: string
  }) => {
    const page = opts?.page ?? 0
    const append = opts?.append ?? false
    const keyword = opts?.keyword ?? buildEventSearchQuery()
    const date = opts?.date ?? eventDate
    const category = opts?.category ?? eventCategory
    if (append) setLoadingMoreEvents(true)
    else setEventsLoading(true)
    try {
      const result = await window.api.searchWeekendEvents({
        keyword: keyword || undefined,
        date: date || undefined,
        category: category !== 'all' ? category : undefined,
        page,
      })
      setEvents((prev) =>
        append ? mergeLocalEvents(prev, result.events || []) : dedup(result.events || []),
      )
      setEventPage(result.page || 0)
      setEventTotalPages(result.totalPages || 0)
    } catch {}
    if (append) setLoadingMoreEvents(false)
    else setEventsLoading(false)
  }

  const webSearchForEvents = async (suggestionQuery?: string) => {
    const query =
      suggestionQuery || webSearchInput.trim() || buildEventSearchQuery() || 'things to do'
    setWebSearching(true)
    setWebEvents([])
    setWebSummary('')
    try {
      const result = await window.api.webSearchEvents(query, eventDate || undefined)
      const mapped: LocalEvent[] = (result.events || []).map((e: any, i: number) => ({
        id: `web-${i}-${Date.now()}`,
        name: e.name,
        type: e.type || 'other',
        date: e.date || eventDate || '',
        time: e.time || 'TBD',
        venue: e.venue || '',
        address: e.address || '',
        city: '',
        priceRange: e.priceRange || '',
        url: e.url || '',
        imageUrl: null,
        description: e.description || '',
        distance: null,
      }))
      setWebEvents(mapped)
      setWebSummary(result.summary || '')
    } catch {}
    setWebSearching(false)
  }

  const loadSavedRestaurants = async () => {
    try {
      const saved = await window.api.getSavedRestaurants()
      setSavedRestaurants(saved || [])
    } catch {}
  }

  const buildGenerateParams = (forDay?: string): WeekendParams => {
    const dates = Array.from(selectedDates).sort()
    const dayKeys = dates.map((d) => dateToDayKey(d))

    // Build perDay overrides
    const perDay: Record<string, {
      extraDetails?: string
      energyLevel?: 'low' | 'medium' | 'high'
      budget?: 'free' | 'low' | 'medium' | 'high'
      pace?: 'relaxed' | 'moderate' | 'packed'
      themes?: WeekendTheme[]
      transportationMode?: string
      locationStrategy?: WeekendLocationStrategy
      discoveryMode?: WeekendDiscoveryMode
      savedRestaurantIds?: number[]
    }> = {}
    for (const dk of dayKeys) {
      const themes = Array.from(getThemes(dk))
      const transport = Array.from(getTransport(dk)).join(', ')
      const savedIds = selectedSavedIdsByDay[dk] ? Array.from(selectedSavedIdsByDay[dk]) : []
      perDay[dk] = {
        extraDetails: getExtraDetails(dk) || undefined,
        energyLevel: getEnergy(dk),
        budget: getBudget(dk),
        pace: getPace(dk),
        themes: themes.length > 0 ? themes : undefined,
        transportationMode: transport || undefined,
        locationStrategy: getLocationStrategy(dk),
        discoveryMode: getDiscoveryMode(dk),
        savedRestaurantIds: savedIds.length > 0 ? savedIds : undefined,
      }
    }

    // For single-day generation, use that day's settings as top-level defaults too
    const refDay = forDay || dayKeys[0]
    const refThemes = Array.from(getThemes(refDay))

    return {
      preferences: preferences || undefined,
      dates: dates.length > 0 ? dates : undefined,
      wakeTimes: Object.keys(wakeTimes).length > 0 ? wakeTimes : undefined,
      energyLevel: getEnergy(refDay),
      budget: getBudget(refDay),
      pace: getPace(refDay),
      transportationMode: Array.from(getTransport(refDay)).join(', '),
      locationStrategy: getLocationStrategy(refDay),
      discoveryMode: getDiscoveryMode(refDay),
      themes: refThemes.length > 0 ? refThemes : undefined,
      avoidTouristy: refThemes.includes('hidden_gems'),
      perDay,
    }
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setGenerateError(null)
    setShowRouteMap(false)
    setRouteMapByDay({})
    try {
      const stored = await window.api.generateWeekendPlan(buildGenerateParams())
      if (stored) {
        setStoredPlan(stored)
        try {
          setPlan(JSON.parse(stored.plan_json))
        } catch {}
        setNotes(stored.ai_rationale)
        setViewingPastDate(null)
      }
      loadPastPlans()
    } catch (err: any) {
      console.error('Failed to generate weekend plan:', err)
      setGenerateError(err?.message || 'Failed to generate plan. Check AI settings and try again.')
    }
    setGenerating(false)
  }

  const handleGenerateDay = async (day: string) => {
    setGeneratingDay(day)
    setGenerateError(null)
    setActivePlanDay(day)
    try {
      const stored = await window.api.generateWeekendPlanForDay(day, buildGenerateParams(day))
      if (stored) {
        setStoredPlan(stored)
        try {
          setPlan(JSON.parse(stored.plan_json))
        } catch {}
        setNotes(stored.ai_rationale)
        setViewingPastDate(null)
      }
      loadPastPlans()
    } catch (err: any) {
      console.error(`Failed to generate plan for ${day}:`, err)
      setGenerateError(err?.message || `Failed to generate ${dayLabel(day)} plan. Try again.`)
    }
    setGeneratingDay(null)
  }

  const handleTweak = async (day?: string) => {
    const input = day ? getTweakInput(day) : ''
    if (!input.trim() || !storedPlan || viewingPastDate) return
    setTweaking(true)
    setTweakStatus(null)
    setTweakError(null)
    try {
      const updated = await window.api.tweakWeekendPlan(storedPlan.weekend_date, input.trim(), day)
      if (updated) {
        setStoredPlan(updated)
        try {
          setPlan(JSON.parse(updated.plan_json))
        } catch {}
        setNotes(updated.ai_rationale)
        if (day) {
          setTweakInputByDay((prev) => ({ ...prev, [day]: '' }))
        }
        setTweakStatus('Plan updated')
        setTimeout(() => setTweakStatus(null), 3000)
      }
    } catch (err: any) {
      console.error('Failed to tweak plan:', err)
      setTweakError(err?.message || 'Failed to tweak plan. Check AI settings and try again.')
    }
    setTweaking(false)
  }


  const buildEventSearchQuery = () => {
    return [eventSearch.trim(), eventFocus, eventDetails.trim()].filter(Boolean).join(' ')
  }

  const toggleDay = (dayKey: string) => {
    const short = DAY_SHORT[dayKey] || dayKey.slice(0, 3)
    const activities = getPlanActivities(plan, dayKey)
    if (!activities.length) return
    const keys = activities.map((_: any, i: number) => `${short}-${i}`)
    setCheckedActivities((prev) => {
      const next = new Set(prev)
      const allChecked = keys.every((k: string) => next.has(k))
      if (allChecked) {
        keys.forEach((k: string) => next.delete(k))
      } else {
        keys.forEach((k: string) => next.add(k))
      }
      return next
    })
  }

  const isDayChecked = (dayKey: string) => {
    const short = DAY_SHORT[dayKey] || dayKey.slice(0, 3)
    const activities = getPlanActivities(plan, dayKey)
    if (!activities.length) return false
    return activities.every((_: any, i: number) => checkedActivities.has(`${short}-${i}`))
  }

  const isDayPartial = (dayKey: string) => {
    const short = DAY_SHORT[dayKey] || dayKey.slice(0, 3)
    const activities = getPlanActivities(plan, dayKey)
    if (!activities.length) return false
    const count = activities.filter((_: any, i: number) =>
      checkedActivities.has(`${short}-${i}`),
    ).length
    return count > 0 && count < activities.length
  }

  const toggleActivity = (key: string) => {
    setCheckedActivities((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleAll = () => {
    if (!plan) return
    const allKeys = new Set<string>()
    for (const day of DAY_ORDER) {
      const short = DAY_SHORT[day]
      const activities = getPlanActivities(plan, day)
      activities.forEach((_: any, i: number) => allKeys.add(`${short}-${i}`))
    }
    if (checkedActivities.size === allKeys.size) {
      setCheckedActivities(new Set())
    } else {
      setCheckedActivities(allKeys)
    }
  }

  const persistPlan = async (nextPlan: WeekendPlanData) => {
    if (!storedPlan || viewingPastDate) return
    const nextJson = JSON.stringify(nextPlan)
    setStoredPlan((prev) => (prev ? { ...prev, plan_json: nextJson } : prev))
    try {
      await window.api.updateWeekendPlan(storedPlan.weekend_date, nextJson)
      loadPastPlans()
    } catch (err) {
      console.error('Failed to persist weekend plan edit:', err)
    }
  }

  const updateActivityTime = (day: string, index: number, newTime: string) => {
    if (!plan) return
    const activities = [...getPlanActivities(plan, day)]
    activities[index] = { ...activities[index], time: newTime }
    const updated = { ...plan, [day]: activities }
    const nextPlan = withRefreshedAgendaMap(updated)
    setPlan(nextPlan)
    persistPlan(nextPlan)
  }

  const removeActivity = (day: string, index: number) => {
    if (!plan) return
    const activities = getPlanActivities(plan, day).filter(
      (_: any, i: number) => i !== index,
    )
    const updated = { ...plan, [day]: refreshActivityTimes(activities) }
    const nextPlan = withRefreshedAgendaMap(updated)
    setPlan(nextPlan)
    persistPlan(nextPlan)
  }

  const moveActivity = (fromDay: string, fromIndex: number, toDay: string, toIndex: number) => {
    if (!plan) return
    if (fromDay === toDay && fromIndex === toIndex) return
    const updated = { ...plan }
    const sourceActivities = [...getPlanActivities(updated, fromDay)]
    const [moved] = sourceActivities.splice(fromIndex, 1)
    if (!moved) return

    if (fromDay === toDay) {
      const boundedIndex = Math.max(0, Math.min(toIndex, sourceActivities.length))
      sourceActivities.splice(boundedIndex, 0, moved)
      ;(updated as Record<string, unknown>)[fromDay] = refreshActivityTimes(sourceActivities)
    } else {
      const targetActivities = [...getPlanActivities(updated, toDay)]
      const boundedIndex = Math.max(0, Math.min(toIndex, targetActivities.length))
      targetActivities.splice(boundedIndex, 0, moved)
      ;(updated as Record<string, unknown>)[fromDay] = refreshActivityTimes(sourceActivities)
      ;(updated as Record<string, unknown>)[toDay] = refreshActivityTimes(targetActivities)
    }

    const nextPlan = withRefreshedAgendaMap(updated)
    setPlan(nextPlan)
    persistPlan(nextPlan)
    setTimesRefreshedDay(toDay)
    setTimeout(() => setTimesRefreshedDay(null), 1500)
  }

  const [timesRefreshedDay, setTimesRefreshedDay] = useState<string | null>(null)
  const refreshDayTimes = (day: string) => {
    if (!plan) return
    const updated = {
      ...plan,
      [day]: refreshActivityTimes(getPlanActivities(plan, day)),
    }
    const nextPlan = withRefreshedAgendaMap(updated)
    setPlan(nextPlan)
    persistPlan(nextPlan)
    setTimesRefreshedDay(day)
    setTimeout(() => setTimesRefreshedDay(null), 1500)
  }

  const handleActivityDrop = (day: string, index: number, event?: DragEvent<HTMLElement>) => {
    event?.preventDefault()
    event?.stopPropagation()
    if (!draggedActivity) return
    moveActivity(draggedActivity.day, draggedActivity.index, day, index)
    setDraggedActivity(null)
  }

  const handleSavePlanToMobile = async () => {
    if (!storedPlan || !plan) return
    setSavingPlan(true)
    setSavePlanStatus(null)
    try {
      // Save current plan state to DB (skip if viewing a past plan — already saved)
      if (!viewingPastDate) {
        const planJson = JSON.stringify(plan)
        const updated = await window.api.updateWeekendPlan(storedPlan.weekend_date, planJson)
        if (updated) setStoredPlan(updated)
      }

      const result = await window.api.relaySyncAll()
      if (result?.success === false) {
        setSavePlanStatus(result.error || 'Saved locally. Relay sync failed.')
      } else {
        setSavePlanStatus('Saved to mobile sync')
        loadPastPlans()
      }
    } catch (err: any) {
      setSavePlanStatus(err?.message || 'Saved locally. Relay sync failed.')
    } finally {
      setSavingPlan(false)
      setTimeout(() => setSavePlanStatus(null), 4000)
    }
  }

  const checkedCount = checkedActivities.size
  const totalCount = DAY_ORDER.reduce(
    (sum, day) => sum + getPlanActivities(plan, day).length,
    0,
  )
  const allChecked = totalCount > 0 && checkedCount === totalCount

  const filteredPlanJson = useMemo(() => {
    if (!plan) return ''
    const filtered: any = { agendaMap: {} }
    for (const day of DAY_ORDER) {
      const short = DAY_SHORT[day]
      const activities = getPlanActivities(plan, day)
      const checked = activities.filter((_: any, i: number) =>
        checkedActivities.has(`${short}-${i}`),
      )
      if (checked.length > 0) {
        filtered[day] = checked
        filtered.agendaMap[day] = buildAgendaMapFromActivities(checked)
      }
    }
    return JSON.stringify(filtered)
  }, [plan, checkedActivities])

  const handleNotionClick = async () => {
    if (!storedPlan || checkedCount === 0) return
    // Use the saved default first; only show the picker if nothing is configured.
    let defaultDb = selectedDbId
    if (!defaultDb) {
      try {
        const settings = (await window.api.getSettings('appSettings')) as Record<string, unknown>
        if (typeof settings?.notionCalendarDbId === 'string') {
          defaultDb = settings.notionCalendarDbId
        }
      } catch {}
    }
    if (defaultDb) {
      if (defaultDb !== selectedDbId) setSelectedDbId(defaultDb)
      return handlePushToNotion(defaultDb)
    }
    setShowDbPicker(true)
    setDbsLoading(true)
    try {
      const dbs = await window.api.listNotionDatabases()
      setNotionDatabases(dbs || [])
    } catch (err) {
      console.error('Failed to list Notion databases:', err)
    }
    setDbsLoading(false)
  }

  const handlePushToNotion = async (dbId?: string) => {
    if (!storedPlan || checkedCount === 0) return
    const targetDb = dbId || selectedDbId || undefined
    setPushingToNotion(true)
    setShowDbPicker(false)
    if (dbId) {
      setSelectedDbId(dbId)
      // Persist as the new default for next time.
      try {
        const current =
          ((await window.api.getSettings('appSettings')) as Record<string, unknown>) || {}
        await window.api.setSettings('appSettings', {
          ...current,
          notionCalendarDbId: dbId,
        })
      } catch {}
    }
    try {
      await window.api.pushWeekendToNotion(filteredPlanJson, storedPlan.weekend_date, targetDb)
      setNotionPushed(true)
      setTimeout(() => setNotionPushed(false), 3000)
    } catch (err) {
      console.error('Failed to push to Notion:', err)
    }
    setPushingToNotion(false)
  }

  // --- Filtered restaurants ---
  const foodPlaces = useMemo(() => {
    return savedRestaurants.filter((r) => FOOD_VENUE_TYPES.includes(r.venueType))
  }, [savedRestaurants])

  const nonFoodPlaces = useMemo(() => {
    return savedRestaurants.filter((r) => !FOOD_VENUE_TYPES.includes(r.venueType))
  }, [savedRestaurants])

  const filteredRestaurants = useMemo(() => {
    const q = savedSearchQuery.trim().toLowerCase()
    return foodPlaces.filter((r) => {
      if (venueFilter !== 'all' && r.venueType !== venueFilter) return false
      if (cuisineFilter !== 'all' && r.cuisineCategory !== cuisineFilter) return false
      if (googleRatingFilter !== 'all' && (!r.rating || r.rating < Number(googleRatingFilter)))
        return false
      if (personalRatingFilter === 'rated' && r.averageRating == null) return false
      if (
        personalRatingFilter !== 'all' &&
        personalRatingFilter !== 'rated' &&
        (r.averageRating == null || r.averageRating < Number(personalRatingFilter))
      )
        return false
      if (
        q &&
        !r.name.toLowerCase().includes(q) &&
        !(r.address || '').toLowerCase().includes(q) &&
        !(r.cuisineCategory || '').toLowerCase().includes(q) &&
        !(r.cuisine || '').toLowerCase().includes(q)
      )
        return false
      return true
    })
  }, [foodPlaces, venueFilter, cuisineFilter, googleRatingFilter, personalRatingFilter, savedSearchQuery])

  const filteredNonFoodPlaces = useMemo(() => {
    const q = savedSearchQuery.trim().toLowerCase()
    return nonFoodPlaces.filter((r) => {
      if (placeTypeFilter !== 'all' && r.venueType !== placeTypeFilter) return false
      if (googleRatingFilter !== 'all' && (!r.rating || r.rating < Number(googleRatingFilter)))
        return false
      if (personalRatingFilter === 'rated' && r.averageRating == null) return false
      if (
        personalRatingFilter !== 'all' &&
        personalRatingFilter !== 'rated' &&
        (r.averageRating == null || r.averageRating < Number(personalRatingFilter))
      )
        return false
      if (
        q &&
        !r.name.toLowerCase().includes(q) &&
        !(r.address || '').toLowerCase().includes(q)
      )
        return false
      return true
    })
  }, [nonFoodPlaces, placeTypeFilter, googleRatingFilter, personalRatingFilter, savedSearchQuery])

  const availableCuisines = useMemo(() => {
    const cats = new Set(foodPlaces.map((r) => r.cuisineCategory).filter(Boolean) as string[])
    return Array.from(cats).sort()
  }, [foodPlaces])

  // --- Restaurant handlers ---
  const handleSearchInputChange = (value: string) => {
    setSearchQuery(value)
    if (autocompleteTimer.current) clearTimeout(autocompleteTimer.current)
    if (!value.trim() || value.trim().length < 2) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    autocompleteTimer.current = setTimeout(async () => {
      try {
        const results = await window.api.autocompleteRestaurants(
          value.trim(),
          tab === 'places' ? 'places' : 'food',
        )
        setSuggestions(results || [])
        setShowSuggestions((results || []).length > 0)
      } catch {
        setSuggestions([])
      }
    }, 250)
  }

  const handleSelectSuggestion = (suggestion: {
    placeId: string
    name: string
    description: string
  }) => {
    setSearchQuery(suggestion.name)
    setSuggestions([])
    setShowSuggestions(false)
    // Fetch the selected place directly by ID for an exact match
    ;(async () => {
      setSearching(true)
      try {
        const savedIds = new Set(savedRestaurants.map((s) => s.placeId))
        const place = await window.api.getPlaceById(suggestion.placeId)
        if (place) {
          setSearchResults([{ ...place, saved: savedIds.has(place.placeId) }])
        } else {
          // Fallback to text search
          const results = await window.api.searchRestaurants(suggestion.name)
          setSearchResults(
            (results || []).map((r: Restaurant) => ({ ...r, saved: savedIds.has(r.placeId) })),
          )
        }
      } catch {}
      setSearching(false)
    })()
  }

  const handleSearchRestaurants = async () => {
    if (!searchQuery.trim()) return
    setShowSuggestions(false)
    setSuggestions([])
    setSearching(true)
    try {
      const results = await window.api.searchRestaurants(searchQuery.trim())
      const savedIds = new Set(savedRestaurants.map((s) => s.placeId))
      setSearchResults(
        (results || []).map((r: Restaurant) => ({ ...r, saved: savedIds.has(r.placeId) })),
      )
    } catch {}
    setSearching(false)
  }

  const handleSaveRestaurant = async (r: Restaurant) => {
    try {
      await window.api.saveRestaurant(r)
      await window.api.updateRestaurant(r.placeId, { venueType: inferNearbyVenueType(r) })
      await loadSavedRestaurants()
      setSearchResults((prev) =>
        prev.map((sr) => (sr.placeId === r.placeId ? { ...sr, saved: true } : sr)),
      )
    } catch {}
  }

  const handleRemoveRestaurant = async (placeId: string) => {
    try {
      await window.api.removeSavedRestaurant(placeId)
      await loadSavedRestaurants()
      setSearchResults((prev) =>
        prev.map((sr) => (sr.placeId === placeId ? { ...sr, saved: false } : sr)),
      )
    } catch {}
  }

  const handleAddSearchPlace = async () => {
    const q = addForm.name.trim()
    if (!q) return
    setAddSearching(true)
    try {
      const results = await window.api.searchRestaurants(q)
      setAddSearchResults(results || [])
    } catch {}
    setAddSearching(false)
  }

  const handleSelectPlace = (r: Restaurant) => {
    setAddSelectedPlace(r)
    setAddForm((f) => ({
      ...f,
      name: r.name,
      address: r.address,
      priceLevel: r.priceLevel || 0,
      bookingAdvance: r.bookingAdvance || '',
      cuisineCategory:
        r.cuisine?.[0]?.replace(/^\w/, (c: string) => c.toUpperCase()) || f.cuisineCategory,
    }))
    setAddSearchResults([])
  }

  const handleAddManual = async () => {
    if (!addForm.name.trim()) return
    try {
      if (addSelectedPlace) {
        // Save from Google Places data (has real placeId, lat/lng, rating)
        await window.api.saveRestaurant(
          {
            ...addSelectedPlace,
            cuisine: addSelectedPlace.cuisine || [],
          },
          addForm.notes || undefined,
        )
        // Apply extra fields that saveRestaurant doesn't handle
        const updates: Record<string, any> = {}
        if (addForm.venueType) updates.venueType = addForm.venueType
        if (addForm.cuisineCategory) updates.cuisineCategory = addForm.cuisineCategory
        if (addForm.spiceLevel) updates.spiceLevel = addForm.spiceLevel
        if (addForm.priceLevel) updates.priceLevel = addForm.priceLevel
        if (addForm.bookingAdvance) updates.bookingAdvance = addForm.bookingAdvance
        if (addForm.notes) updates.notes = addForm.notes
        if (Object.keys(updates).length > 0) {
          await window.api.updateRestaurant(addSelectedPlace.placeId, updates)
        }
      } else {
        await window.api.addManualRestaurant({
          name: addForm.name.trim(),
          address: addForm.address.trim(),
          venueType: addForm.venueType,
          cuisineCategory: addForm.cuisineCategory || undefined,
          spiceLevel: addForm.spiceLevel || undefined,
          priceLevel: addForm.priceLevel || undefined,
          bookingAdvance: addForm.bookingAdvance || undefined,
          notes: addForm.notes || undefined,
        })
      }
      await loadSavedRestaurants()
      setAddForm({
        name: '',
        address: '',
        venueType: tab === 'places' ? 'attraction' : 'restaurant',
        cuisineCategory: '',
        spiceLevel: '',
        priceLevel: 0,
        bookingAdvance: '',
        notes: '',
      })
      setAddSelectedPlace(null)
      setAddSearchResults([])
      setShowAddForm(false)
    } catch {}
  }

  const handleResearch = async (placeId: string) => {
    setResearchingId(placeId)
    try {
      await window.api.researchRestaurant(placeId)
      await loadSavedRestaurants()
    } catch {}
    setResearchingId(null)
  }

  const handleRefreshAll = async (force = false) => {
    if (refreshingAll) return
    setRefreshingAll(true)
    setRefreshProgress({ current: 0, total: foodPlaces.length, name: '' })
    let unsub: (() => void) | undefined
    try {
      unsub = window.api.onRestaurantResearchProgress((p: any) => {
        setRefreshProgress({ current: p.current, total: p.total, name: p.name })
      })
      await window.api.researchAllRestaurants({ force })
      await loadSavedRestaurants()
    } catch (err) {
      console.error('Failed to refresh booking info:', err)
    }
    if (unsub) unsub()
    setRefreshProgress(null)
    setRefreshingAll(false)
  }

  const handleSaveVisit = async (
    placeId: string,
    rating: number | null,
    visitDate: string,
    notes: string,
    visitId?: number,
  ) => {
    try {
      if (visitId) {
        await window.api.updateVisit(visitId, { rating, visitDate, notes })
      } else {
        await window.api.addVisit(placeId, rating, visitDate, notes)
      }
      await loadSavedRestaurants()
    } catch {}
  }

  const handleRemoveVisit = async (visitId: number) => {
    try {
      await window.api.removeVisit(visitId)
      await loadSavedRestaurants()
    } catch {}
  }

  const handleSaveEdit = async (placeId: string, updates: any) => {
    try {
      await window.api.editRestaurant(placeId, updates)
      setEditingRestaurant(null)
      await loadSavedRestaurants()
    } catch {}
  }

  // Parse a discover response into result cards, falling back to raw text. Returns
  // true if anything (results or raw) was shown, false if the response was unusable.
  const applyDiscoverResult = (result: string): boolean => {
    const jsonMatch = result.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim())
        if (Array.isArray(parsed) && parsed.length > 0) {
          setDiscoverResults(parsed)
          return true
        }
      } catch {
        // fall through to raw text below
      }
    }
    if (result.trim()) {
      setDiscoverRaw(result)
      return true
    }
    return false
  }

  const handleDiscover = async () => {
    if (!discoverQuery.trim()) return
    setDiscovering(true)
    setDiscoverResults(null)
    setDiscoverRaw(null)
    setDiscoverError(null)
    try {
      const result = await window.api.discoverRestaurants(
        discoverQuery.trim(),
        tab === 'places' ? 'places' : 'food',
      )
      if (!applyDiscoverResult(String(result ?? ''))) {
        setDiscoverError('No suggestions came back. Try a different search.')
      }
    } catch (err: any) {
      setDiscoverError(err?.message || 'Discovery failed. Check your AI settings and try again.')
    }
    setDiscovering(false)
  }

  const handleDiscoverTrending = async () => {
    setDiscovering(true)
    setDiscoverResults(null)
    setDiscoverRaw(null)
    setDiscoverError(null)
    try {
      const result = await window.api.discoverTrendingPlaces(tab === 'places' ? 'places' : 'food')
      if (!applyDiscoverResult(String(result ?? ''))) {
        setDiscoverError('No fresh suggestions came back. Try again in a moment.')
      }
    } catch (err: any) {
      setDiscoverError(err?.message || 'Discovery failed. Check your AI settings and try again.')
    }
    setDiscovering(false)
  }

  const handleAddSuggestion = async (suggestion: any) => {
    try {
      await window.api.addManualRestaurant({
        name: suggestion.name,
        address: suggestion.address || '',
        venueType: suggestion.venueType || 'restaurant',
        cuisineCategory: suggestion.cuisineCategory || undefined,
        spiceLevel: suggestion.spiceLevel || undefined,
        priceLevel: suggestion.priceLevel || undefined,
        bookingAdvance: suggestion.bookingAdvance || undefined,
        peakTimes: suggestion.peakTimes || undefined,
        description: suggestion.description || undefined,
      })
      await loadSavedRestaurants()
      // Mark as added
      setDiscoverResults((prev) =>
        prev ? prev.map((s) => (s.name === suggestion.name ? { ...s, _added: true } : s)) : prev,
      )
    } catch {}
  }

  // --- Export schedule as image ---
  const drawMienLogo = (
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    size: number,
    color: string,
  ) => {
    const s = size / 64 // scale from 64x64 viewBox
    ctx.save()
    ctx.translate(cx - size / 2, cy - size / 2)
    ctx.strokeStyle = color
    ctx.fillStyle = 'none'
    ctx.lineCap = 'round'

    // Chopsticks
    ctx.lineWidth = 1.8 * s
    ctx.beginPath()
    ctx.moveTo(27 * s, 13 * s)
    ctx.lineTo(40 * s, 23 * s)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(31 * s, 11 * s)
    ctx.lineTo(42.5 * s, 22 * s)
    ctx.stroke()

    // Dangling noodles
    ctx.lineWidth = 1.4 * s
    const noodles = [
      [
        [33, 21],
        [32, 24],
        [34, 26],
        [32.5, 29],
      ],
      [
        [35, 20.5],
        [34, 23.5],
        [36, 25.5],
        [34.5, 28.5],
      ],
      [
        [37, 20],
        [36, 23],
        [38, 25],
        [36.5, 28],
      ],
    ]
    for (const n of noodles) {
      ctx.beginPath()
      ctx.moveTo(n[0][0] * s, n[0][1] * s)
      ctx.bezierCurveTo(
        n[1][0] * s,
        n[1][1] * s,
        n[2][0] * s,
        n[2][1] * s,
        n[3][0] * s,
        n[3][1] * s,
      )
      ctx.stroke()
    }

    // Bowl rim (ellipse)
    ctx.lineWidth = 1.8 * s
    ctx.beginPath()
    ctx.ellipse(32 * s, 29.5 * s, 19 * s, 4 * s, 0, 0, Math.PI * 2)
    ctx.stroke()

    // Bowl body
    ctx.beginPath()
    ctx.moveTo(13 * s, 29.5 * s)
    ctx.bezierCurveTo(13 * s, 29.5 * s, 15 * s, 49 * s, 32 * s, 49 * s)
    ctx.bezierCurveTo(49 * s, 49 * s, 51 * s, 29.5 * s, 51 * s, 29.5 * s)
    ctx.stroke()

    // Bowl base
    ctx.lineWidth = 1.5 * s
    ctx.beginPath()
    ctx.roundRect(27 * s, 48.5 * s, 10 * s, 3 * s, 0.5 * s)
    ctx.stroke()

    // Inside noodles
    ctx.lineWidth = 1.4 * s
    const insides = [
      [
        [17, 31],
        [20, 34],
        [24, 32],
        [28, 34],
        [32, 36],
        [36, 33],
        [40, 34],
        [43, 35],
        [45, 33],
        [47, 34],
      ],
      [
        [18, 33.5],
        [21, 36],
        [25, 34],
        [29, 36.5],
        [33, 39],
        [37, 35.5],
        [41, 37],
        [44, 38],
        [46, 36],
        [47, 36.5],
      ],
      [
        [19, 36],
        [22, 38.5],
        [26, 36.5],
        [30, 38.5],
        [34, 40.5],
        [38, 38],
        [42, 39.5],
      ],
    ]
    for (const pts of insides) {
      ctx.beginPath()
      ctx.moveTo(pts[0][0] * s, pts[0][1] * s)
      for (let i = 1; i < pts.length - 2; i += 3) {
        ctx.bezierCurveTo(
          pts[i][0] * s,
          pts[i][1] * s,
          pts[i + 1][0] * s,
          pts[i + 1][1] * s,
          pts[i + 2][0] * s,
          pts[i + 2][1] * s,
        )
      }
      ctx.stroke()
    }
    ctx.restore()
  }

  const generateRouteMap = useCallback(async () => {
    if (!plan) return
    setRouteMapLoading(true)
    try {
      const days = getPlanDayKeys(plan)
      const results: Record<string, ResolvedStop[]> = {}
      const visible = new Set<string>()

      await Promise.all(
        days.map(async (day) => {
          const route = routeForDay(plan, day)
          if (route.length > 0) {
            const resolved = await window.api.resolveRouteLocations(route)
            results[day] = resolved || []
            if ((resolved || []).length > 0) visible.add(day)
          }
        }),
      )

      setRouteMapByDay(results)
      setVisibleRouteDays(visible)
      setShowRouteMap(true)
    } catch (err) {
      console.error('Failed to generate route map:', err)
    } finally {
      setRouteMapLoading(false)
    }
  }, [plan])

  const exportRouteMapImage = useCallback(async () => {
    const exportDays = (DAY_ORDER as readonly string[]).filter(
      (d) => visibleRouteDays.has(d) && (routeMapByDay[d] || []).length > 0,
    )
    if (!plan || exportDays.length === 0) return
    setExporting(true)

    const scale = 2
    const mapW = 560
    const agendaW = 440
    const totalW = mapW + agendaW
    const pad = 32
    const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    const monoFont = '"SF Mono", "Cascadia Code", "Fira Code", monospace'

    const actsByDay: Record<string, WeekendActivity[]> = {}
    for (const day of exportDays) {
      const short = DAY_SHORT[day]
      actsByDay[day] = getPlanActivities(plan, day).filter((_: any, i: number) =>
        checkedActivities.has(`${short}-${i}`),
      )
    }
    const totalExportActs = Object.values(actsByDay).reduce((s, a) => s + a.length, 0)
    if (totalExportActs === 0) {
      setExporting(false)
      return
    }
    const mapRect = routeMapCaptureRef.current?.getBoundingClientRect()
    const mapScreenshot = mapRect
      ? await window.api
          .capturePage({
            x: mapRect.left,
            y: mapRect.top,
            width: mapRect.width,
            height: mapRect.height,
          })
          .catch((err) => {
            console.warn('[Weekend] Failed to capture route map:', err)
            return null
          })
      : null

    // Measure content height
    const measureCanvas = document.createElement('canvas')
    const mCtx = measureCanvas.getContext('2d')!

    const wrapText = (
      ctx: CanvasRenderingContext2D,
      text: string,
      maxW: number,
      maxLines = 3,
    ): string[] => {
      const words = (text || '').trim().split(/\s+/)
      if (words.length === 0) return []
      const lines: string[] = []
      let line = ''
      for (const word of words) {
        const next = line ? `${line} ${word}` : word
        if (ctx.measureText(next).width <= maxW) {
          line = next
          continue
        }
        if (line) {
          lines.push(line)
          if (lines.length >= maxLines) return lines
          line = ''
        }
        line = word
      }
      if (line && lines.length < maxLines) lines.push(line)
      return lines
    }

    // Calculate agenda height
    const dayHeaderH = 30
    const actItemH = 44
    const dayGap = 16
    let agendaH = pad
    for (const day of exportDays) {
      const acts = actsByDay[day] || []
      if (acts.length > 0) agendaH += dayHeaderH + acts.length * actItemH + dayGap
    }
    agendaH += 40 // footer

    const mapH = Math.max(agendaH, 500)
    const totalH = mapH

    const canvas = document.createElement('canvas')
    canvas.width = totalW * scale
    canvas.height = totalH * scale
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)

    // Background
    const bgGrad = ctx.createLinearGradient(0, 0, totalW, totalH)
    bgGrad.addColorStop(0, '#0a0e1a')
    bgGrad.addColorStop(0.5, '#0d1424')
    bgGrad.addColorStop(1, '#0f0a1e')
    ctx.fillStyle = bgGrad
    ctx.beginPath()
    ctx.roundRect(0, 0, totalW, totalH, 20)
    ctx.fill()

    const mapAreaH = mapH - pad * 2
    const drawCapturedMap = async (dataUrl: string | null) => {
      if (!dataUrl) return false
      return await new Promise<boolean>((resolve) => {
        const img = new window.Image()
        img.onload = () => {
          ctx.drawImage(img, pad, pad, mapW - pad * 2, mapAreaH)
          resolve(true)
        }
        img.onerror = () => resolve(false)
        img.src = dataUrl
      })
    }
    const didDrawMap = await drawCapturedMap(mapScreenshot)
    if (!didDrawMap) {
      ctx.fillStyle = '#202020'
      ctx.fillRect(pad, pad, mapW - pad * 2, mapAreaH)
      ctx.fillStyle = '#94a3b8'
      ctx.font = `12px ${font}`
      ctx.fillText(
        'Map screenshot unavailable. Keep the route map visible and try again.',
        pad + 20,
        pad + 32,
      )
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(pad, pad, mapW - pad * 2, mapAreaH, 10)
    ctx.stroke()
    let labelX = pad + 8
    for (const day of exportDays) {
      const label = dayLabel(day)
      const color = DAY_COLORS[day] || '#22d3ee'
      ctx.font = `bold 10px ${font}`
      const labelW = ctx.measureText(label).width + 16
      ctx.fillStyle = 'rgba(0,0,0,0.7)'
      ctx.beginPath()
      ctx.roundRect(labelX, pad + 8, labelW, 20, 6)
      ctx.fill()
      ctx.fillStyle = color
      ctx.fillText(label, labelX + 8, pad + 22)
      labelX += labelW + 8
    }

    // Draw agenda on right side
    const agendaX = mapW + 8
    const agendaContentW = agendaW - pad - 8
    let y = pad

    // Title
    ctx.fillStyle = '#e6edf3'
    ctx.font = `bold 16px ${font}`
    ctx.fillText('Weekend Plan', agendaX, y + 14)
    y += 28

    const dateStr = storedPlan?.weekend_date || ''
    if (dateStr) {
      ctx.fillStyle = '#7d8590'
      ctx.font = `11px ${font}`
      ctx.fillText(dateStr, agendaX, y + 4)
      y += 18
    }

    // Separator
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(agendaX, y, agendaContentW, 1)
    y += 12

    const renderDayAgenda = (label: string, acts: WeekendActivity[], accentColor: string) => {
      ctx.fillStyle = accentColor
      ctx.font = `bold 12px ${font}`
      ctx.fillText(`${label} · ${acts.length} activities`, agendaX, y + 10)
      y += dayHeaderH

      acts.forEach((act, i) => {
        // Number circle
        ctx.fillStyle = accentColor
        ctx.globalAlpha = 0.2
        ctx.beginPath()
        ctx.arc(agendaX + 8, y + 12, 10, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.fillStyle = accentColor
        ctx.font = `bold 9px ${font}`
        ctx.fillText(String(i + 1), agendaX + (i + 1 >= 10 ? 4 : 6), y + 15)

        // Time
        ctx.fillStyle = accentColor
        ctx.font = `600 10px ${monoFont}`
        ctx.fillText(act.time, agendaX + 24, y + 10)

        // Activity name
        mCtx.font = `600 11px ${font}`
        const nameLines = wrapText(mCtx, act.activity || 'Untitled', agendaContentW - 28, 2)
        ctx.fillStyle = '#e6edf3'
        ctx.font = `600 11px ${font}`
        nameLines.forEach((line, li) => ctx.fillText(line, agendaX + 24, y + 22 + li * 13))

        // Location
        if (act.location) {
          const locY = y + 22 + nameLines.length * 13
          ctx.fillStyle = '#585e68'
          ctx.font = `10px ${font}`
          ctx.fillText(
            act.location.length > 45 ? act.location.substring(0, 42) + '...' : act.location,
            agendaX + 24,
            locY,
          )
        }

        y += actItemH
      })
      y += dayGap
    }

    for (const day of exportDays) {
      const acts = actsByDay[day] || []
      if (acts.length > 0) renderDayAgenda(dayLabel(day), acts, DAY_COLORS[day] || '#22d3ee')
    }

    // Footer
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(agendaX, totalH - 36, agendaContentW, 1)
    ctx.fillStyle = '#30363d'
    ctx.font = `10px ${font}`
    ctx.fillText('Generated by Mien', agendaX, totalH - 18)
    drawMienLogo(ctx, totalW - pad - 10, totalH - 22, 16, '#484f58')

    // Download
    canvas.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `weekend-map-${storedPlan?.weekend_date || 'export'}.png`
        a.click()
        URL.revokeObjectURL(url)
      }
      setExporting(false)
    }, 'image/png')
  }, [plan, routeMapByDay, checkedActivities, storedPlan, visibleRouteDays])

  const exportScheduleImage = useCallback(async () => {
    if (!plan) return
    setExporting(true)

    const scale = 2
    const w = 900
    const pad = 48
    const cardPad = 28
    const dayHeaderH = 56
    const logoSize = 48
    const titleH = 110
    const footerH = 60
    const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    const monoFont = '"SF Mono", "Cascadia Code", "Fira Code", monospace'

    const planDayKeys = getPlanDayKeys(plan)

    const dateStr = storedPlan?.weekend_date || ''
    const dateParts = dateStr.split('-')
    const dateObj = dateStr
      ? new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]))
      : null

    const wrapCanvasText = (
      ctx: CanvasRenderingContext2D,
      text: string,
      maxWidth: number,
      maxLines = 8,
    ): string[] => {
      const source = (text || '').trim()
      if (!source) return []
      const lines: string[] = []
      const words = source.split(/\s+/)
      let line = ''

      const pushLongWord = (word: string) => {
        let chunk = ''
        for (const char of word) {
          const next = chunk + char
          if (ctx.measureText(next).width > maxWidth && chunk) {
            lines.push(chunk)
            chunk = char
            if (lines.length >= maxLines) return
          } else {
            chunk = next
          }
        }
        line = chunk
      }

      for (const word of words) {
        const next = line ? `${line} ${word}` : word
        if (ctx.measureText(next).width <= maxWidth) {
          line = next
          continue
        }
        if (line) {
          lines.push(line)
          if (lines.length >= maxLines) return lines
          line = ''
        }
        if (ctx.measureText(word).width > maxWidth) {
          pushLongWord(word)
          if (lines.length >= maxLines) return lines
        } else {
          line = word
        }
      }
      if (line && lines.length < maxLines) lines.push(line)
      return lines
    }

    const drawWrappedLines = (
      ctx: CanvasRenderingContext2D,
      lines: string[],
      x: number,
      y: number,
      lineHeight: number,
    ): number => {
      lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight))
      return lines.length * lineHeight
    }

    // Render one day as a standalone image
    const renderDayImage = (
      label: string,
      acts: WeekendActivity[],
      accentColor: string,
      accentRgb: string,
      glowColor: string,
    ): HTMLCanvasElement => {
      const contentW = w - pad * 2 - cardPad * 2 - 54
      const measureCanvas = document.createElement('canvas')
      const measureCtx = measureCanvas.getContext('2d')!
      const rows = acts.map((act) => {
        measureCtx.font = `600 15px ${font}`
        const titleLines = wrapCanvasText(
          measureCtx,
          act.activity || 'Untitled activity',
          contentW,
          5,
        )
        measureCtx.font = `12px ${font}`
        const metaText = [
          act.location ? `Place: ${act.location}` : '',
          act.cost ? `Cost: ${act.cost}` : '',
          act.travelTime ? `Travel time: ${act.travelTime}` : '',
          act.transportation ? `Mode: ${act.transportation}` : '',
        ]
          .filter(Boolean)
          .join(' | ')
        const metaLines = wrapCanvasText(measureCtx, metaText, contentW, 4)
        measureCtx.font = `11px ${font}`
        const rationaleLines = wrapCanvasText(measureCtx, act.rationale || '', contentW, 3)
        const height = Math.max(
          96,
          18 + 22 + titleLines.length * 19 + metaLines.length * 16 + rationaleLines.length * 14,
        )
        return { act, titleLines, metaLines, rationaleLines, height }
      })
      const activitiesH = rows.reduce((sum, row) => sum + row.height, 0)
      const canvas = document.createElement('canvas')
      const cardH = dayHeaderH + activitiesH + cardPad * 2
      const h = pad + titleH + cardH + footerH
      canvas.width = w * scale
      canvas.height = h * scale
      const ctx = canvas.getContext('2d')!
      ctx.scale(scale, scale)

      // Background
      const bgGrad = ctx.createLinearGradient(0, 0, w, h)
      bgGrad.addColorStop(0, '#0a0e1a')
      bgGrad.addColorStop(0.5, '#0d1424')
      bgGrad.addColorStop(1, '#0f0a1e')
      ctx.fillStyle = bgGrad
      ctx.beginPath()
      ctx.roundRect(0, 0, w, h, 24)
      ctx.fill()

      // Glow
      const g1 = ctx.createRadialGradient(w * 0.15, h * 0.25, 0, w * 0.15, h * 0.25, 200)
      g1.addColorStop(0, glowColor)
      g1.addColorStop(1, 'transparent')
      ctx.fillStyle = g1
      ctx.fillRect(0, 0, w * 0.5, h * 0.6)
      const g2 = ctx.createRadialGradient(w * 0.85, h * 0.75, 0, w * 0.85, h * 0.75, 220)
      g2.addColorStop(0, glowColor)
      g2.addColorStop(1, 'transparent')
      ctx.fillStyle = g2
      ctx.fillRect(w * 0.5, h * 0.4, w * 0.5, h * 0.6)

      // --- Title area with logo ---
      let y = pad

      // Logo (left side)
      drawMienLogo(
        ctx,
        pad + logoSize / 2,
        y + logoSize / 2 + 8,
        logoSize,
        `rgba(${accentRgb},0.7)`,
      )

      // Text next to logo
      const textX = pad + logoSize + 16
      ctx.fillStyle = `rgba(${accentRgb},0.5)`
      ctx.font = `600 11px ${font}`
      ctx.letterSpacing = '3px'
      ctx.fillText(label.toUpperCase(), textX, y + 18)
      ctx.letterSpacing = '0px'

      if (dateObj) {
        // Compute display date based on the day offset from Saturday
        const satIdx = DAY_ORDER.indexOf('saturday')
        const dayIdx = (DAY_ORDER as readonly string[]).indexOf(label.toLowerCase())
        const offset = dayIdx >= 0 ? dayIdx - satIdx : 0
        const displayDateObj = new Date(dateObj)
        displayDateObj.setDate(displayDateObj.getDate() + offset)
        const displayDate = displayDateObj.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
        ctx.fillStyle = '#e6edf3'
        ctx.font = `bold 26px ${font}`
        ctx.fillText(displayDate, textX, y + 50)
      } else {
        ctx.fillStyle = '#e6edf3'
        ctx.font = `bold 26px ${font}`
        ctx.fillText(`This ${label}`, textX, y + 50)
      }

      // Decorative line
      const lineGrad = ctx.createLinearGradient(pad, 0, w - pad, 0)
      lineGrad.addColorStop(0, `rgba(${accentRgb},0.4)`)
      lineGrad.addColorStop(0.5, `rgba(${accentRgb},0.2)`)
      lineGrad.addColorStop(1, `rgba(${accentRgb},0.05)`)
      ctx.fillStyle = lineGrad
      ctx.fillRect(pad, y + 80, w - pad * 2, 1.5)

      y += titleH

      // --- Day card ---
      const contentX = pad + cardPad + 24

      // Card background
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      ctx.beginPath()
      ctx.roundRect(pad, y, w - pad * 2, cardH, 16)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(pad, y, w - pad * 2, cardH, 16)
      ctx.stroke()

      // Day label + badge
      const labelX = pad + cardPad
      const labelY = y + cardPad + 20
      ctx.fillStyle = accentColor
      ctx.beginPath()
      ctx.arc(labelX + 6, labelY - 5, 5, 0, Math.PI * 2)
      ctx.fill()
      const dotGlow = ctx.createRadialGradient(
        labelX + 6,
        labelY - 5,
        0,
        labelX + 6,
        labelY - 5,
        20,
      )
      dotGlow.addColorStop(0, `rgba(${accentRgb},0.3)`)
      dotGlow.addColorStop(1, 'transparent')
      ctx.fillStyle = dotGlow
      ctx.fillRect(labelX - 14, labelY - 25, 40, 40)
      ctx.fillStyle = accentColor
      ctx.font = `bold 18px ${font}`
      ctx.fillText(label, labelX + 20, labelY)

      const badgeText = `${acts.length} activities`
      ctx.font = `11px ${font}`
      const badgeW = ctx.measureText(badgeText).width + 16
      ctx.font = `bold 18px ${font}`
      const labelW = ctx.measureText(label).width
      ctx.fillStyle = `rgba(${accentRgb},0.15)`
      ctx.font = `11px ${font}`
      ctx.beginPath()
      ctx.roundRect(labelX + 20 + labelW + 12, labelY - 12, badgeW, 20, 10)
      ctx.fill()
      ctx.fillStyle = accentColor
      ctx.fillText(badgeText, labelX + 20 + labelW + 20, labelY + 1)

      // Timeline line
      const timelineX = pad + cardPad + 8
      const tlStart = y + cardPad + dayHeaderH
      const tlEnd = tlStart + Math.max(0, activitiesH - (rows[rows.length - 1]?.height || 0)) + 10
      ctx.strokeStyle = `rgba(${accentRgb},0.15)`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(timelineX, tlStart)
      ctx.lineTo(timelineX, tlEnd)
      ctx.stroke()

      // Activities
      let offsetY = 0
      rows.forEach((row, i) => {
        const { act, titleLines, metaLines, rationaleLines, height } = row
        const actY = y + cardPad + dayHeaderH + offsetY
        let rowY = actY + 4
        ctx.fillStyle = i === 0 ? accentColor : `rgba(${accentRgb},0.5)`
        ctx.beginPath()
        ctx.arc(timelineX, actY + 10, i === 0 ? 5 : 3.5, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = accentColor
        ctx.font = `600 13px ${monoFont}`
        ctx.fillText(act.time, contentX, rowY + 12)
        rowY += 26

        ctx.fillStyle = '#e6edf3'
        ctx.font = `600 15px ${font}`
        rowY += drawWrappedLines(ctx, titleLines, contentX, rowY + 12, 19) + 8

        if (metaLines.length > 0) {
          ctx.fillStyle = '#7d8590'
          ctx.font = `12px ${font}`
          rowY += drawWrappedLines(ctx, metaLines, contentX, rowY + 10, 16) + 6
        }

        if (rationaleLines.length > 0) {
          ctx.fillStyle = '#585e68'
          ctx.font = `11px ${font}`
          rowY += drawWrappedLines(ctx, rationaleLines, contentX, rowY + 9, 14)
        }

        if (i < rows.length - 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.05)'
          ctx.fillRect(contentX, actY + height - 4, w - pad * 2 - cardPad * 2 - 30, 1)
        }
        offsetY += height
      })

      y += cardH

      // --- Footer ---
      y += 16
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.fillRect(pad, y, w - pad * 2, 1)
      y += 14
      ctx.fillStyle = '#30363d'
      ctx.font = `11px ${font}`
      ctx.fillText('Generated by Mien', pad, y)
      drawMienLogo(ctx, w - pad - 10, y - 4, 18, '#484f58')

      return canvas
    }

    // Filter to only checked activities per day
    const checkedByDay: Record<string, WeekendActivity[]> = {}
    for (const day of planDayKeys) {
      const short = DAY_SHORT[day]
      const checked = getPlanActivities(plan, day).filter((_: any, i: number) =>
        checkedActivities.has(`${short}-${i}`),
      )
      if (checked.length > 0) checkedByDay[day] = checked
    }

    const daysToExport = Object.keys(checkedByDay)
    if (daysToExport.length === 0) {
      setExporting(false)
      return
    }

    const downloadCanvas = (canvas: HTMLCanvasElement, filename: string) => {
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = filename
          a.click()
          URL.revokeObjectURL(url)
        }
      }, 'image/png')
    }

    const baseDateSlug = storedPlan?.weekend_date || 'export'
    const satIdx = DAY_ORDER.indexOf('saturday')

    let exportIdx = 0
    const exportNext = () => {
      if (exportIdx >= daysToExport.length) {
        setExporting(false)
        return
      }
      const day = daysToExport[exportIdx]
      const dayIdx = DAY_ORDER.indexOf(day as PlanDayKey)
      const offset = dayIdx >= 0 ? dayIdx - satIdx : 0
      let dateSlug = baseDateSlug
      if (dateObj) {
        const d = new Date(dateObj)
        d.setDate(d.getDate() + offset)
        dateSlug = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }
      const color = DAY_COLORS[day] || '#79c0ff'
      const rgb = DAY_ACCENT_RGB[day] || '121,192,255'
      const glow = DAY_GLOW[day] || 'rgba(88,166,255,0.06)'
      const canvas = renderDayImage(dayLabel(day), checkedByDay[day], color, rgb, glow)
      downloadCanvas(canvas, `${day}-${dateSlug}.png`)
      exportIdx++
      if (exportIdx < daysToExport.length) setTimeout(exportNext, 300)
      else setExporting(false)
    }
    exportNext()
  }, [plan, storedPlan, checkedActivities])

  const planDays = getPlanDayKeys(plan)
  // Day keys from selected dates (for tabs even before plan exists)
  const selectedDayKeys = useMemo(() => {
    const sorted = Array.from(selectedDates).sort()
    return (DAY_ORDER as readonly string[]).filter((d) =>
      sorted.some((date) => dateToDayKey(date) === d),
    )
  }, [selectedDates])
  // All day tabs: union of plan days and selected days
  const dayTabs = useMemo(() => {
    const all = new Set([...selectedDayKeys, ...planDays])
    return (DAY_ORDER as readonly string[]).filter((d) => all.has(d))
  }, [selectedDayKeys, planDays])
  // Default active day to first tab
  const effectiveActiveDay = activePlanDay && dayTabs.includes(activePlanDay) ? activePlanDay : dayTabs[0] || null
  const isPlacesTab = tab === 'places'
  const visibleSavedPlaces = isPlacesTab ? filteredNonFoodPlaces : filteredRestaurants
  const visibleSavedTotal = isPlacesTab ? nonFoodPlaces.length : foodPlaces.length
  const renderEventResults = (className = 'space-y-2 max-h-[50vh] overflow-y-auto') => (
    <div className={className}>
      {events.length > 0 ? (
        <>
          {events.map((ev, i) => (
            <EventChip
              key={ev.id || i}
              event={ev}
              onClick={() => setSelectedEvent(ev)}
              onRemove={() => setEvents((prev) => prev.filter((e) => e !== ev))}
            />
          ))}
          {eventTotalPages > 0 && eventPage + 1 < eventTotalPages && (
            <button
              onClick={() => searchEvents({ page: eventPage + 1, append: true })}
              disabled={loadingMoreEvents}
              className="text-xs w-full text-center py-2 rounded-lg transition-colors hover:bg-white/[0.05]"
              style={{ color: 'var(--accent-amber)' }}
            >
              {loadingMoreEvents ? 'Loading...' : 'Load more events'}
            </button>
          )}
        </>
      ) : (
        <p className="text-xs py-3 text-center" style={{ color: 'var(--text-muted)' }}>
          {eventsLoading
            ? 'Searching...'
            : 'No events found. Try a different search or add Ticketmaster API key in Settings.'}
        </p>
      )}
    </div>
  )

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            Weekend Planner
          </h2>
          <div
            className="flex rounded-lg overflow-hidden"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            {(['plan', 'restaurants', 'places', 'map'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  background: tab === t ? 'var(--accent-cyan)' : 'transparent',
                  color: tab === t ? 'white' : 'var(--text-muted)',
                }}
              >
                {t === 'plan'
                  ? 'Plan'
                  : t === 'restaurants'
                    ? `Restaurants${foodPlaces.length > 0 ? ` (${foodPlaces.length})` : ''}`
                    : t === 'places'
                      ? `Places${nonFoodPlaces.length > 0 ? ` (${nonFoodPlaces.length})` : ''}`
                      : 'Map'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'plan' && (
            <>
              {plan && (
                <button
                  onClick={exportScheduleImage}
                  disabled={exporting}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  title="Export schedule as image"
                >
                  <Image size={14} />
                  Export
                </button>
              )}
              <button
                onClick={loadEvents}
                disabled={eventsLoading}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                <RefreshCw size={14} className={eventsLoading ? 'animate-spin' : ''} />
                Events
              </button>
              {plan && (
                <div className="relative">
                  <button
                    onClick={handleNotionClick}
                    disabled={
                      pushingToNotion || notionPushed || checkedCount === 0 || !!viewingPastDate
                    }
                    className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                    style={{
                      background: notionPushed ? 'var(--accent-green)' : 'var(--bg-tertiary)',
                      color: notionPushed ? 'white' : 'var(--text-secondary)',
                    }}
                    title={
                      checkedCount === 0
                        ? 'Check activities to export'
                        : `Export ${checkedCount} activities to Notion`
                    }
                  >
                    {notionPushed ? (
                      <Check size={14} />
                    ) : (
                      <Send size={14} className={pushingToNotion ? 'animate-spin' : ''} />
                    )}
                    {notionPushed
                      ? 'Sent!'
                      : pushingToNotion
                        ? 'Sending...'
                        : `Notion (${checkedCount})`}
                  </button>
                  {showDbPicker && (
                    <div
                      className="absolute right-0 top-full mt-1 w-72 rounded-lg shadow-xl z-50 overflow-hidden"
                      style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--separator)',
                      }}
                    >
                      <div
                        className="px-3 py-2"
                        style={{ borderBottom: '1px solid var(--separator)' }}
                      >
                        <p
                          className="text-xs font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Pick a Notion database ({checkedCount} activities)
                        </p>
                      </div>
                      {dbsLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <NoodleSpinner size={40} color="var(--accent-cyan)" />
                        </div>
                      ) : notionDatabases.length === 0 ? (
                        <p className="text-xs py-3 px-3" style={{ color: 'var(--text-muted)' }}>
                          No databases found. Check your Notion API key.
                        </p>
                      ) : (
                        <div className="max-h-48 overflow-y-auto">
                          {notionDatabases.map((db) => (
                            <button
                              key={db.id}
                              onClick={() => handlePushToNotion(db.id)}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 transition-colors flex items-center gap-2"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              <Calendar size={12} style={{ color: 'var(--accent-cyan)' }} />
                              <span className="truncate">{db.title}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => setShowDbPicker(false)}
                        className="w-full text-xs py-2 transition-colors hover:bg-white/5"
                        style={{
                          color: 'var(--text-muted)',
                          borderTop: '1px solid var(--separator)',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
              <button
                onClick={handleGenerate}
                disabled={generating || generatingDay !== null}
                className="flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                style={{ background: 'var(--accent-cyan)', color: 'white' }}
              >
                <Sparkles size={14} className={generating ? 'animate-spin' : ''} />
                {generating ? 'Planning...' : 'Plan All Days'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Plan Tab */}
      {tab === 'plan' && (
        <>
          {/* Preferences + Parameters */}
          <div className="card">
            {/* Date Selector */}
            <div className="mb-3">
              <label
                className="text-xs flex items-center gap-1.5 mb-1.5"
                style={{ color: 'var(--text-muted)' }}
              >
                <CalendarClock size={12} /> Plan dates{' '}
                <span className="opacity-60">(click to add/remove days)</span>
              </label>
              <div className="flex gap-1.5">
                {weekDates.map(({ date, dayName, dayKey, label: dateLabel }) => {
                  const selected = selectedDates.has(date)
                  return (
                    <button
                      key={date}
                      onClick={() =>
                        setSelectedDates((prev) => {
                          const next = new Set(prev)
                          if (next.has(date)) {
                            if (next.size > 1) next.delete(date)
                          } else next.add(date)
                          return next
                        })
                      }
                      className="flex-1 flex flex-col items-center py-1.5 px-1 rounded-lg text-xs transition-all"
                      style={{
                        background: selected ? DAY_COLORS[dayKey] : 'var(--bg-tertiary)',
                        color: selected ? 'white' : 'var(--text-muted)',
                        border: `1px solid ${selected ? DAY_COLORS[dayKey] : 'var(--separator)'}`,
                        opacity: selected ? 1 : 0.6,
                      }}
                    >
                      <span className="font-medium">{dayName}</span>
                      <span className="text-[10px] opacity-80">{dateLabel}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="mb-3">
              <WeatherPreviewCard preview={weatherPreview} loading={weatherLoading} />
            </div>

            <label className="text-xs mb-2 block" style={{ color: 'var(--text-muted)' }}>
              What are you in the mood for? (optional)
            </label>
            <div className="flex gap-2">
              <input
                value={preferences}
                onChange={(e) => setPreferences(e.target.value)}
                placeholder="e.g. Something outdoors, maybe try a new restaurant, not too early"
                className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--separator)',
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
              />
              <button
                onClick={handleGenerate}
                disabled={generating || generatingDay !== null}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
                style={{ background: 'var(--accent-cyan)', color: 'white' }}
              >
                {generating ? 'Planning...' : 'Plan All Days'}
              </button>
            </div>
            {/* Quick prompt suggestions */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {[
                'Outdoors + new restaurant',
                'Lazy brunch & explore a neighborhood',
                'Live music night out',
                'Active day — running, biking, gym',
                'Date night with cocktails',
                'Food crawl through a new area',
                "Something I've never done before",
                'Cheap & fun, under $30 total',
                'Rainy day backup plan',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() =>
                    setPreferences((prev) =>
                      prev ? `${prev}, ${suggestion.toLowerCase()}` : suggestion.toLowerCase(),
                    )
                  }
                  className="text-[10px] px-2 py-0.5 rounded-full transition-colors hover:bg-white/[0.08]"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-muted)',
                    border: '1px solid var(--separator)',
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 space-y-4" ref={scheduleRef}>
              {generateError && (
                <div
                  className="flex items-center justify-between px-3 py-2 rounded-lg"
                  style={{
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid var(--accent-red)',
                  }}
                >
                  <span className="text-xs" style={{ color: 'var(--accent-red)' }}>
                    {generateError}
                  </span>
                  <button
                    onClick={() => setGenerateError(null)}
                    className="text-xs px-2 py-1 rounded transition-colors hover:bg-white/10"
                    style={{ color: 'var(--accent-red)' }}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {(loading || generating) && !plan && (
                <div className="card flex flex-col items-center justify-center py-16">
                  <NoodleSpinner
                    size={72}
                    color="var(--accent-cyan)"
                    label={generating ? 'Generating plan for all days...' : 'Loading…'}
                  />
                </div>
              )}

              {!loading && !generating && !plan && (
                <div className="space-y-4">
                  {/* Day tabs for per-day generation even without an existing plan */}
                  {dayTabs.length > 0 && (
                    <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--bg-tertiary)' }}>
                      {dayTabs.map((day) => {
                        const color = DAY_COLORS[day]
                        const isActive = effectiveActiveDay === day
                        const isGeneratingThis = generatingDay === day
                        return (
                          <button
                            key={day}
                            onClick={() => setActivePlanDay(day)}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-md text-xs font-medium transition-all"
                            style={{
                              background: isActive ? `${color}22` : 'transparent',
                              color: isActive ? color : 'var(--text-muted)',
                              border: isActive ? `1px solid ${color}44` : '1px solid transparent',
                            }}
                          >
                            {isGeneratingThis && <RefreshCw size={11} className="animate-spin" />}
                            {dayLabel(day)}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {generatingDay ? (
                    <div className="card flex flex-col items-center justify-center py-16">
                      <NoodleSpinner
                        size={72}
                        color={DAY_COLORS[generatingDay] || 'var(--accent-cyan)'}
                        label={`Planning ${dayLabel(generatingDay)}...`}
                      />
                    </div>
                  ) : (
                    <div className="card py-10">
                      <NoodleIllustration
                        size={96}
                        label="No weekend plan yet"
                        sublabel={effectiveActiveDay
                          ? `Click "Generate" to plan ${dayLabel(effectiveActiveDay)}, or "Plan All Days" to generate all days at once.`
                          : 'Click "Plan All Days" to generate an AI-powered itinerary.'}
                      />
                      {effectiveActiveDay && (
                        <div className="max-w-lg mx-auto mt-4">
                          <DayInputSection
                            day={effectiveActiveDay}
                            color={DAY_COLORS[effectiveActiveDay]}
                            extraDetails={getExtraDetails(effectiveActiveDay)}
                            onExtraDetailsChange={(v) => setExtraDetailsByDay((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            wakeTime={wakeTimes[effectiveActiveDay] || '09:00'}
                            onWakeTimeChange={(v) => setWakeTimes((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            themes={getThemes(effectiveActiveDay)}
                            onThemesChange={(v) => setThemesByDay((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            energy={getEnergy(effectiveActiveDay)}
                            onEnergyChange={(v) => setEnergyByDay((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            budget={getBudget(effectiveActiveDay)}
                            onBudgetChange={(v) => setBudgetByDay((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            pace={getPace(effectiveActiveDay)}
                            onPaceChange={(v) => setPaceByDay((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            transport={getTransport(effectiveActiveDay)}
                            onTransportChange={(v) => setTransportByDay((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            locationStrategy={getLocationStrategy(effectiveActiveDay)}
                            onLocationStrategyChange={(v) => setLocationStrategyByDay((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            discoveryMode={getDiscoveryMode(effectiveActiveDay)}
                            onDiscoveryModeChange={(v) => setDiscoveryModeByDay((prev) => ({ ...prev, [effectiveActiveDay]: v }))}
                            savedRestaurants={savedRestaurants}
                            selectedSavedIds={selectedSavedIdsByDay[effectiveActiveDay] || new Set<number>()}
                            onSelectedSavedIdsChange={(ids) => setSelectedSavedIdsByDay((prev) => ({ ...prev, [effectiveActiveDay]: ids }))}
                            showDayPlaces={showDayPlaces[effectiveActiveDay] || false}
                            onToggleDayPlaces={() => setShowDayPlaces((prev) => ({ ...prev, [effectiveActiveDay]: !prev[effectiveActiveDay] }))}
                            onGenerate={() => handleGenerateDay(effectiveActiveDay)}
                            generating={generatingDay === effectiveActiveDay}
                            hasActivities={false}
                            viewingPast={false}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {plan && (
                <>
                  {viewingPastDate && (
                    <div
                      className="flex items-center justify-between px-3 py-2 rounded-lg"
                      style={{
                        background: 'rgba(125,200,255,0.1)',
                        border: '1px solid var(--accent-cyan)',
                      }}
                    >
                      <span className="text-xs" style={{ color: 'var(--accent-cyan)' }}>
                        Viewing past plan — {viewingPastDate}
                      </span>
                      <button
                        onClick={loadPlan}
                        className="text-xs px-2 py-1 rounded transition-colors"
                        style={{ background: 'var(--accent-cyan)', color: 'white' }}
                      >
                        Back to this weekend
                      </button>
                    </div>
                  )}
                  <div className="flex items-center justify-between px-1">
                    <button
                      onClick={toggleAll}
                      className="flex items-center gap-1.5 text-xs transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {allChecked ? <CheckSquare size={14} /> : <Square size={14} />}
                      {allChecked ? 'Deselect all' : 'Select all'} ({checkedCount}/{totalCount})
                    </button>
                    <div className="flex items-center gap-2">
                      {savePlanStatus && (
                        <span
                          className="text-[10px]"
                          style={{
                            color: savePlanStatus.includes('failed')
                              ? 'var(--accent-red)'
                              : 'var(--accent-green)',
                          }}
                        >
                          {savePlanStatus}
                        </span>
                      )}
                      {checkedCount > 0 && checkedCount < totalCount && (
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {checkedCount} selected for Notion export
                        </span>
                      )}
                      {storedPlan && (
                        <button
                          onClick={handleSavePlanToMobile}
                          disabled={savingPlan}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                          style={{ background: 'var(--accent-green)', color: 'white' }}
                          title="Save this plan and sync all plans to mobile via relay"
                        >
                          {savingPlan ? (
                            <RefreshCw size={13} className="animate-spin" />
                          ) : (
                            <Save size={13} />
                          )}
                          {savingPlan ? 'Syncing...' : 'Save & Sync'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Day tabs */}
                  <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--bg-tertiary)' }}>
                    {dayTabs.map((day) => {
                      const color = DAY_COLORS[day]
                      const isActive = effectiveActiveDay === day
                      const hasActivities = getPlanActivities(plan, day).length > 0
                      const isGeneratingThis = generatingDay === day
                      return (
                        <button
                          key={day}
                          onClick={() => setActivePlanDay(day)}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-md text-xs font-medium transition-all"
                          style={{
                            background: isActive ? `${color}22` : 'transparent',
                            color: isActive ? color : 'var(--text-muted)',
                            border: isActive ? `1px solid ${color}44` : '1px solid transparent',
                          }}
                        >
                          {isGeneratingThis && <RefreshCw size={11} className="animate-spin" />}
                          {dayLabel(day)}
                          {hasActivities && (
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                          )}
                        </button>
                      )
                    })}
                  </div>

                  {/* Active day content */}
                  {effectiveActiveDay && (() => {
                    const day = effectiveActiveDay
                    const short = DAY_SHORT[day]
                    const color = DAY_COLORS[day]
                    const activities: WeekendActivity[] = getPlanActivities(plan, day)
                    const dayDateEntry = weekDates.find((wd) => wd.dayKey === day)
                    const isGeneratingThis = generatingDay === day
                    return (
                      <div className="card" key={day}>
                        <div className="flex items-center justify-between mb-3">
                          <h3
                            className="text-sm font-medium flex items-center gap-2"
                            style={{ color }}
                          >
                            <button
                              onClick={() => toggleDay(day)}
                              className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                              title={`Select/deselect all ${dayLabel(day)} activities`}
                            >
                              {isDayChecked(day) ? (
                                <CheckSquare size={14} style={{ color }} />
                              ) : isDayPartial(day) ? (
                                <CheckSquare size={14} style={{ opacity: 0.5, color }} />
                              ) : (
                                <Square size={14} style={{ color: 'var(--text-muted)' }} />
                              )}
                            </button>
                            <Calendar size={14} /> {dayLabel(day)}
                            {dayDateEntry && (
                              <span
                                className="text-[10px] font-normal"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                {dayDateEntry.date}
                              </span>
                            )}
                          </h3>
                          <div className="flex items-center gap-1.5">
                            {timesRefreshedDay === day && (
                              <span
                                className="text-[10px]"
                                style={{ color: 'var(--accent-green)' }}
                              >
                                Updated
                              </span>
                            )}
                            {activities.length > 0 && (
                              <button
                                onClick={() => refreshDayTimes(day)}
                                className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md transition-colors"
                                style={{
                                  background: 'var(--bg-tertiary)',
                                  color: 'var(--text-muted)',
                                }}
                                title="Recalculate times sequentially"
                              >
                                <RefreshCw size={12} />
                                Times
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Per-day input section */}
                        {!viewingPastDate && (
                          <DayInputSection
                            day={day}
                            color={color}
                            extraDetails={getExtraDetails(day)}
                            onExtraDetailsChange={(v) => setExtraDetailsByDay((prev) => ({ ...prev, [day]: v }))}
                            wakeTime={wakeTimes[day] || '09:00'}
                            onWakeTimeChange={(v) => setWakeTimes((prev) => ({ ...prev, [day]: v }))}
                            themes={getThemes(day)}
                            onThemesChange={(v) => setThemesByDay((prev) => ({ ...prev, [day]: v }))}
                            energy={getEnergy(day)}
                            onEnergyChange={(v) => setEnergyByDay((prev) => ({ ...prev, [day]: v }))}
                            budget={getBudget(day)}
                            onBudgetChange={(v) => setBudgetByDay((prev) => ({ ...prev, [day]: v }))}
                            pace={getPace(day)}
                            onPaceChange={(v) => setPaceByDay((prev) => ({ ...prev, [day]: v }))}
                            transport={getTransport(day)}
                            onTransportChange={(v) => setTransportByDay((prev) => ({ ...prev, [day]: v }))}
                            locationStrategy={getLocationStrategy(day)}
                            onLocationStrategyChange={(v) => setLocationStrategyByDay((prev) => ({ ...prev, [day]: v }))}
                            discoveryMode={getDiscoveryMode(day)}
                            onDiscoveryModeChange={(v) => setDiscoveryModeByDay((prev) => ({ ...prev, [day]: v }))}
                            savedRestaurants={savedRestaurants}
                            selectedSavedIds={selectedSavedIdsByDay[day] || new Set<number>()}
                            onSelectedSavedIdsChange={(ids) => setSelectedSavedIdsByDay((prev) => ({ ...prev, [day]: ids }))}
                            showDayPlaces={showDayPlaces[day] || false}
                            onToggleDayPlaces={() => setShowDayPlaces((prev) => ({ ...prev, [day]: !prev[day] }))}
                            onGenerate={() => handleGenerateDay(day)}
                            generating={isGeneratingThis}
                            hasActivities={activities.length > 0}
                            viewingPast={!!viewingPastDate}
                          />
                        )}

                        {isGeneratingThis ? (
                          <div className="flex flex-col items-center justify-center py-10">
                            <NoodleSpinner size={56} color={color} label={`Planning ${dayLabel(day)}...`} />
                          </div>
                        ) : activities.length > 0 ? (
                          <div
                            className="space-y-1"
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => handleActivityDrop(day, activities.length, event)}
                          >
                            {activities.map((act, i) => (
                              <ActivityCard
                                key={i}
                                activity={act}
                                index={i}
                                checked={checkedActivities.has(`${short}-${i}`)}
                                onToggle={() => toggleActivity(`${short}-${i}`)}
                                onTimeChange={(t) => updateActivityTime(day, i, t)}
                                onRemove={() => removeActivity(day, i)}
                                onDragStart={() => setDraggedActivity({ day, index: i })}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => handleActivityDrop(day, i, event)}
                                onDragEnd={() => setDraggedActivity(null)}
                                dragging={
                                  draggedActivity?.day === day && draggedActivity.index === i
                                }
                              />
                            ))}
                          </div>
                        ) : (
                          <div
                            className="text-sm py-4 text-center rounded-lg"
                            style={{
                              color: 'var(--text-muted)',
                              border: draggedActivity
                                ? '1px dashed var(--separator)'
                                : '1px solid transparent',
                            }}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => handleActivityDrop(day, 0, event)}
                          >
                            <p>No {dayLabel(day)} activities yet</p>
                          </div>
                        )}

                        {/* Per-day tweak */}
                        {storedPlan && !viewingPastDate && activities.length > 0 && (
                          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--separator)' }}>
                            <form
                              className="flex gap-2"
                              onSubmit={(event: FormEvent) => {
                                event.preventDefault()
                                handleTweak(day)
                              }}
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                              onDragStart={(event) => event.preventDefault()}
                            >
                              <input
                                type="text"
                                value={getTweakInput(day)}
                                onChange={(e) => setTweakInputByDay((prev) => ({ ...prev, [day]: e.target.value }))}
                                placeholder={`Tweak ${dayLabel(day)}... e.g. swap brunch, add dessert`}
                                className="flex-1 px-3 py-1.5 rounded-lg text-xs outline-none"
                                style={{
                                  background: 'var(--bg-tertiary)',
                                  color: 'var(--text-primary)',
                                  border: '1px solid var(--separator)',
                                }}
                                aria-label={`Custom tweak for ${dayLabel(day)}`}
                                autoComplete="off"
                                disabled={tweaking}
                              />
                              <button
                                type="submit"
                                disabled={tweaking || !getTweakInput(day).trim()}
                                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                                style={{ background: 'var(--accent-purple)', color: 'white' }}
                              >
                                {tweaking ? <RefreshCw size={11} className="animate-spin" /> : <Sparkle size={11} />}
                                Tweak
                              </button>
                            </form>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {[
                                'Add a coffee stop',
                                'Swap dinner for something cheaper',
                                'Start later',
                                'Add a dessert spot',
                                'Make it more relaxed',
                                'Replace outdoor activities (rain)',
                              ].map((suggestion) => (
                                <button
                                  type="button"
                                  key={suggestion}
                                  onClick={() => setTweakInputByDay((prev) => ({ ...prev, [day]: suggestion }))}
                                  className="text-[10px] px-2 py-0.5 rounded-full transition-colors hover:brightness-125"
                                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                                >
                                  {suggestion}
                                </button>
                              ))}
                            </div>
                            {(tweakStatus || tweakError) && (
                              <p className="mt-1.5 text-[10px]" style={{ color: tweakError ? 'var(--accent-orange)' : 'var(--accent-green)' }}>
                                {tweakError || tweakStatus}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* Route Map */}
                  {plan && (
                    <div className="card">
                      <div className="flex items-center justify-between mb-3">
                        <h3
                          className="text-sm font-medium flex items-center gap-2"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          <MapPin size={14} /> Route Map
                        </h3>
                        <div className="flex items-center gap-2">
                          {showRouteMap &&
                            Object.values(routeMapByDay).some((s) => s.length > 0) && (
                              <button
                                onClick={exportRouteMapImage}
                                disabled={exporting || visibleRouteDays.size === 0}
                                className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md transition-colors disabled:opacity-40"
                                style={{
                                  background: 'var(--bg-tertiary)',
                                  color: 'var(--text-muted)',
                                }}
                              >
                                <Image size={12} /> Export Map
                              </button>
                            )}
                          <button
                            onClick={generateRouteMap}
                            disabled={routeMapLoading}
                            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                            style={{
                              background: showRouteMap
                                ? 'var(--bg-tertiary)'
                                : 'var(--accent-cyan)',
                              color: showRouteMap ? 'var(--text-secondary)' : 'white',
                            }}
                          >
                            {routeMapLoading ? (
                              <RefreshCw size={12} className="animate-spin" />
                            ) : (
                              <Navigation size={12} />
                            )}
                            {showRouteMap ? 'Refresh' : 'Generate Map'}
                          </button>
                        </div>
                      </div>
                      {showRouteMap && Object.keys(routeMapByDay).length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                          {(DAY_ORDER as readonly string[])
                            .filter((d) => (routeMapByDay[d] || []).length > 0)
                            .map((day) => {
                              const active = visibleRouteDays.has(day)
                              const color = DAY_COLORS[day]
                              return (
                                <button
                                  key={day}
                                  onClick={() =>
                                    setVisibleRouteDays((prev) => {
                                      const next = new Set(prev)
                                      if (next.has(day)) next.delete(day)
                                      else next.add(day)
                                      return next
                                    })
                                  }
                                  className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full transition-colors"
                                  style={{
                                    background: active ? `${color}28` : 'var(--bg-tertiary)',
                                    color: active ? color : 'var(--text-muted)',
                                    border: `1px solid ${active ? `${color}59` : 'var(--separator)'}`,
                                  }}
                                >
                                  {active ? <Check size={11} /> : <Square size={11} />}
                                  {dayLabel(day)} plan
                                </button>
                              )
                            })}
                        </div>
                      )}
                      {showRouteMap ? (
                        visibleRouteDays.size > 0 ? (
                          <div ref={routeMapCaptureRef}>
                            <PlanRouteMap
                              stopsByDay={Object.fromEntries(
                                Array.from(visibleRouteDays).map((d) => [
                                  d,
                                  routeMapByDay[d] || [],
                                ]),
                              )}
                              activitiesByDay={Object.fromEntries(
                                Array.from(visibleRouteDays).map((d) => [
                                  d,
                                  getPlanActivities(plan, d),
                                ]),
                              )}
                            />
                          </div>
                        ) : (
                          <p
                            className="text-xs py-6 text-center"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            Turn on a day to show route stops.
                          </p>
                        )
                      ) : (
                        <p
                          className="text-xs py-6 text-center"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Generate a route map to see your weekend agenda plotted on a map with
                          numbered stops.
                        </p>
                      )}
                    </div>
                  )}

                  {notes && (
                    <div className="card">
                      <h3
                        className="text-sm font-medium mb-2 flex items-center gap-2"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <Star size={14} /> Notes
                      </h3>
                      <div
                        className="text-sm leading-relaxed whitespace-pre-wrap"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {notes}
                      </div>
                    </div>
                  )}

                </>
              )}
            </div>

            {/* Events sidebar */}
            <div className="space-y-4">
              <div
                className={`card !p-4 space-y-3 ${eventsFullPage ? 'fixed inset-4 z-40 overflow-y-auto' : ''}`}
                style={eventsFullPage ? { background: 'var(--bg-card)' } : undefined}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => setShowEvents(!showEvents)}
                    className="flex items-center justify-between flex-1 min-w-0 text-left"
                  >
                    <h3
                      className="text-sm font-medium flex items-center gap-2"
                      style={{ color: 'var(--accent-amber)' }}
                    >
                      <Star size={14} /> Events ({events.length})
                    </h3>
                    {showEvents ? (
                      <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} />
                    ) : (
                      <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setShowEvents(true)
                      setEventsFullPage((v) => !v)
                    }}
                    className="shrink-0 p-1.5 rounded-lg transition-colors hover:bg-white/[0.05]"
                    style={{ color: eventsFullPage ? 'var(--accent-amber)' : 'var(--text-muted)' }}
                    title={eventsFullPage ? 'Collapse events' : 'Full page events map'}
                  >
                    {eventsFullPage ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>
                </div>

                {showEvents && (
                  <>
                    {/* Search bar */}
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={eventSearch}
                        onChange={(e) => setEventSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') searchEvents()
                        }}
                        placeholder="Cubs, comedy, Kendrick..."
                        className="flex-1 text-xs px-2.5 py-1.5 rounded-lg outline-none"
                        style={{
                          background: 'var(--bg-tertiary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--separator)',
                        }}
                      />
                      <button
                        onClick={() => searchEvents()}
                        disabled={eventsLoading}
                        className="px-2 py-1.5 rounded-lg text-xs transition-colors"
                        style={{ background: 'var(--accent-amber)', color: 'white' }}
                      >
                        <Search size={12} />
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        What kind of events should Mien elaborate on?
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {EVENT_FOCUS_OPTIONS.map((focus) => (
                          <button
                            key={focus}
                            onClick={() => setEventFocus(eventFocus === focus ? '' : focus)}
                            className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
                            style={{
                              background:
                                eventFocus === focus ? 'var(--accent-cyan)' : 'var(--bg-tertiary)',
                              color: eventFocus === focus ? 'white' : 'var(--text-muted)',
                            }}
                          >
                            {focus}
                          </button>
                        ))}
                      </div>
                      <input
                        type="text"
                        value={eventDetails}
                        onChange={(e) => setEventDetails(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') searchEvents()
                        }}
                        placeholder="Optional: neighborhood, vibe, budget, artist, venue..."
                        className="w-full text-[11px] px-2.5 py-1.5 rounded-lg outline-none"
                        style={{
                          background: 'var(--bg-tertiary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--separator)',
                        }}
                      />
                    </div>

                    {/* Date strip */}
                    <div
                      className="flex gap-1 overflow-x-auto pb-1"
                      style={{ scrollbarWidth: 'none' }}
                    >
                      <button
                        onClick={() => {
                          setEventDate('')
                          searchEvents({ date: '' })
                        }}
                        className="shrink-0 text-[10px] px-2 py-1 rounded-lg transition-colors"
                        style={{
                          background: !eventDate ? 'var(--accent-cyan)' : 'var(--bg-tertiary)',
                          color: !eventDate ? 'white' : 'var(--text-muted)',
                        }}
                      >
                        Upcoming
                      </button>
                      {Array.from({ length: 14 }, (_, i) => {
                        const d = new Date()
                        d.setDate(d.getDate() + i)
                        const iso = localDateStr(d)
                        const dayName = d.toLocaleDateString('en-US', { weekday: 'short' })
                        const dateNum = d.getDate()
                        const isWeekend = d.getDay() === 0 || d.getDay() === 6
                        return (
                          <button
                            key={iso}
                            onClick={() => {
                              setEventDate(iso)
                              searchEvents({ date: iso })
                            }}
                            className="shrink-0 text-[10px] px-2 py-1 rounded-lg transition-colors text-center leading-tight"
                            style={{
                              background:
                                eventDate === iso ? 'var(--accent-cyan)' : 'var(--bg-tertiary)',
                              color:
                                eventDate === iso
                                  ? 'white'
                                  : isWeekend
                                    ? 'var(--accent-amber)'
                                    : 'var(--text-muted)',
                            }}
                          >
                            {dayName}
                            <br />
                            {dateNum}
                          </button>
                        )
                      })}
                      <input
                        type="date"
                        value={eventDate}
                        onChange={(e) => {
                          setEventDate(e.target.value)
                          searchEvents({ date: e.target.value })
                        }}
                        className="shrink-0 text-[10px] px-2 py-1 rounded-lg outline-none cursor-pointer"
                        style={{
                          background: 'var(--bg-tertiary)',
                          color: 'var(--text-muted)',
                          border: 'none',
                          width: '28px',
                          colorScheme: 'dark',
                        }}
                        title="Pick any date"
                      />
                    </div>

                    {/* Category chips */}
                    <div className="flex flex-wrap gap-1">
                      {[
                        { id: 'all', label: 'All' },
                        { id: 'music', label: 'Music' },
                        { id: 'sports', label: 'Sports' },
                        { id: 'shows', label: 'Shows' },
                        { id: 'comedy', label: 'Comedy' },
                        { id: 'arts', label: 'Arts' },
                        { id: 'family', label: 'Family' },
                        { id: 'festivals', label: 'Festivals' },
                      ].map((cat) => (
                        <button
                          key={cat.id}
                          onClick={() => {
                            setEventCategory(cat.id)
                            searchEvents({ category: cat.id })
                          }}
                          className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
                          style={{
                            background:
                              eventCategory === cat.id
                                ? 'var(--accent-amber)'
                                : 'var(--bg-tertiary)',
                            color: eventCategory === cat.id ? 'white' : 'var(--text-muted)',
                          }}
                        >
                          {cat.label}
                        </button>
                      ))}
                    </div>

                    {/* Results list + map */}
                    {eventsFullPage ? (
                      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.75fr)] gap-3 min-h-[58vh]">
                        <EventsMap
                          events={events}
                          savedPlaces={savedRestaurants}
                          onSelectEvent={setSelectedEvent}
                        />
                        {renderEventResults('space-y-2 max-h-[58vh] overflow-y-auto pr-1')}
                      </div>
                    ) : (
                      renderEventResults()
                    )}

                    {/* Web search */}
                    <div className="pt-2" style={{ borderTop: '1px solid var(--separator)' }}>
                      <div className="flex gap-1.5 mb-2">
                        <input
                          type="text"
                          value={webSearchInput}
                          onChange={(e) => setWebSearchInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') webSearchForEvents()
                          }}
                          placeholder="outdoor markets, jazz, art openings..."
                          className="flex-1 text-xs px-2.5 py-1.5 rounded-lg outline-none"
                          style={{
                            background: 'var(--bg-tertiary)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--separator)',
                          }}
                        />
                        <button
                          onClick={() => webSearchForEvents()}
                          disabled={webSearching}
                          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                          style={{ background: 'var(--accent-cyan)', color: 'white' }}
                        >
                          {webSearching ? (
                            <RefreshCw size={11} className="animate-spin" />
                          ) : (
                            <Search size={11} />
                          )}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1 mb-2">
                        {[
                          'Outdoor activities',
                          'Food festivals',
                          'Art & galleries',
                          'Jazz & blues',
                          'Open mic',
                          'Farmers market',
                          'Brewery tours',
                          'Theater',
                          'Pop-up shops',
                          'Dance classes',
                          'Trivia night',
                          'Rooftop bars',
                        ].map((s) => (
                          <button
                            key={s}
                            onClick={() => {
                              setWebSearchInput(s)
                              webSearchForEvents(s)
                            }}
                            disabled={webSearching}
                            className="text-[10px] px-2 py-0.5 rounded-full transition-colors hover:bg-white/10 disabled:opacity-50"
                            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                      {webSummary && (
                        <p className="text-[10px] mt-2 px-1" style={{ color: 'var(--text-muted)' }}>
                          {webSummary}
                        </p>
                      )}
                      {webEvents.length > 0 && (
                        <div className="mt-2 space-y-2">
                          {webEvents.map((ev, i) => (
                            <EventChip
                              key={ev.id || i}
                              event={ev}
                              onClick={() => setSelectedEvent(ev)}
                              onRemove={() => setWebEvents((prev) => prev.filter((e) => e !== ev))}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {!showEvents && events.length > 0 && (
                  <div className="space-y-2">
                    {events.slice(0, 5).map((ev, i) => (
                      <EventChip
                        key={ev.id || i}
                        event={ev}
                        onClick={() => setSelectedEvent(ev)}
                        onRemove={() => setEvents((prev) => prev.filter((e) => e !== ev))}
                      />
                    ))}
                    {events.length > 5 && (
                      <button
                        onClick={() => setShowEvents(true)}
                        className="text-xs w-full text-center py-1.5 rounded transition-colors hover:bg-white/[0.03]"
                        style={{ color: 'var(--accent-amber)' }}
                      >
                        Show {events.length - 5} more
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="card !p-4">
                <h3
                  className="text-sm font-medium mb-2 flex items-center gap-2"
                  style={{ color: 'var(--accent-green)' }}
                >
                  <MapPin size={14} /> Your Location
                </h3>
                <LocationInfo />
              </div>

              {foodPlaces.length > 0 && (
                <div className="card !p-4">
                  <h3
                    className="text-sm font-medium mb-2 flex items-center gap-2"
                    style={{ color: '#ff9f0a' }}
                  >
                    <UtensilsCrossed size={14} /> Saved Restaurants ({foodPlaces.length})
                  </h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {foodPlaces.slice(0, 3).map((r) => (
                      <div
                        key={r.placeId}
                        className="text-xs p-2 rounded"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <p style={{ color: 'var(--text-primary)' }}>{r.name}</p>
                        <div
                          className="flex items-center gap-2 mt-0.5"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {r.rating && <span>{r.rating.toFixed(1)}</span>}
                          {r.priceLevel && <span>{priceLabel(r.priceLevel)}</span>}
                          {r.bookingAdvance && <span>{r.bookingAdvance}</span>}
                        </div>
                      </div>
                    ))}
                    {foodPlaces.length > 3 && (
                      <button
                        onClick={() => setTab('restaurants')}
                        className="text-xs w-full text-center py-1 hover:underline"
                        style={{ color: '#ff9f0a' }}
                      >
                        View all {foodPlaces.length}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {nonFoodPlaces.length > 0 && (
                <div className="card !p-4">
                  <h3
                    className="text-sm font-medium mb-2 flex items-center gap-2"
                    style={{ color: 'var(--accent-cyan)' }}
                  >
                    <MapPin size={14} /> Saved Places ({nonFoodPlaces.length})
                  </h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {nonFoodPlaces.slice(0, 3).map((r) => (
                      <div
                        key={r.placeId}
                        className="text-xs p-2 rounded"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <p style={{ color: 'var(--text-primary)' }}>{r.name}</p>
                        <div
                          className="flex items-center gap-2 mt-0.5"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <span>
                            {VENUE_TYPES.find((v) => v.id === r.venueType)?.label || 'Place'}
                          </span>
                          {r.address && <span className="truncate">{r.address}</span>}
                        </div>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setTab('places')}
                        className="text-xs flex-1 text-center py-1 hover:underline"
                        style={{ color: 'var(--accent-cyan)' }}
                      >
                        View places
                      </button>
                      <button
                        onClick={() => setTab('map')}
                        className="text-xs flex-1 text-center py-1 hover:underline"
                        style={{ color: 'var(--accent-cyan)' }}
                      >
                        View map
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="card !p-4">
                <h3 className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
                  Event Types
                </h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {Object.entries(typeColors).map(([type, color]) => (
                    <div key={type} className="flex items-center gap-1.5 text-xs" style={{ color }}>
                      {typeIcons[type]}
                      <span className="capitalize">{type}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Past weekend plans — saved AI rationale + itineraries */}
          {pastPlans.filter((p) => p.weekend_date !== storedPlan?.weekend_date).length > 0 && (
            <div className="card">
              <button
                onClick={() => setShowPastPlans(!showPastPlans)}
                className="flex items-center justify-between w-full text-left"
              >
                <h3
                  className="text-sm font-medium flex items-center gap-2"
                  style={{ color: 'var(--accent-cyan)' }}
                >
                  <CalendarClock size={14} /> Past plans (
                  {pastPlans.filter((p) => p.weekend_date !== storedPlan?.weekend_date).length})
                </h3>
                {showPastPlans ? (
                  <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} />
                ) : (
                  <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
                )}
              </button>

              {showPastPlans && (
                <div className="mt-3 space-y-2">
                  {pastPlans
                    .filter((p) => p.weekend_date !== storedPlan?.weekend_date)
                    .map((p) => {
                      let activities = 0
                      try {
                        const parsed = JSON.parse(p.plan_json) as WeekendPlanData
                        activities = (parsed.saturday?.length || 0) + (parsed.sunday?.length || 0)
                      } catch {}
                      const rationale = (p.ai_rationale || '').trim()
                      const snippet =
                        rationale.length > 220 ? rationale.slice(0, 220) + '…' : rationale
                      return (
                        <div
                          key={p.id}
                          className="rounded-lg p-3"
                          style={{
                            background: 'var(--bg-tertiary)',
                            border: '1px solid var(--separator)',
                          }}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div
                                className="text-sm font-medium"
                                style={{ color: 'var(--text-primary)' }}
                              >
                                {p.weekend_date}
                              </div>
                              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                {activities} activit{activities === 1 ? 'y' : 'ies'} · saved{' '}
                                {p.created_at?.slice(0, 10)}
                              </div>
                              {snippet && (
                                <p
                                  className="text-xs mt-2 whitespace-pre-wrap"
                                  style={{ color: 'var(--text-secondary)' }}
                                >
                                  {snippet}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => viewPastPlan(p)}
                              className="text-xs px-2.5 py-1 rounded transition-colors shrink-0"
                              style={{ background: 'var(--accent-cyan)', color: 'white' }}
                            >
                              View
                            </button>
                          </div>
                        </div>
                      )
                    })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Restaurants and saved places tabs */}
      {(tab === 'restaurants' || tab === 'places') && (
        <div className="space-y-4">
          {/* Top bar: Add + Discover + Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => {
                setShowAddForm(!showAddForm)
                setAddForm((f) => ({
                  ...f,
                  venueType:
                    isPlacesTab && FOOD_VENUE_TYPES.includes(f.venueType)
                      ? 'attraction'
                      : !isPlacesTab && !FOOD_VENUE_TYPES.includes(f.venueType)
                        ? 'restaurant'
                        : f.venueType,
                }))
              }}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors"
              style={{
                background: showAddForm ? '#ff9f0a' : 'var(--bg-tertiary)',
                color: showAddForm ? 'white' : '#ff9f0a',
              }}
            >
              <Plus size={14} /> Add {isPlacesTab ? 'Place' : 'Restaurant'}
            </button>

            {(isPlacesTab ? nonFoodPlaces : foodPlaces).length > 0 && (
              <button
                onClick={() => handleRefreshAll(false)}
                disabled={refreshingAll}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-purple)' }}
                title={
                  isPlacesTab
                    ? 'Re-run AI research on saved places to refresh descriptions. Skips anything researched in the last 60 days.'
                    : 'Re-run AI research on saved restaurants to refresh booking lead times and busy-day patterns. Skips anything researched in the last 60 days.'
                }
              >
                <RefreshCw size={14} className={refreshingAll ? 'animate-spin' : ''} />
                {refreshingAll && refreshProgress
                  ? `Refreshing ${refreshProgress.current}/${refreshProgress.total}…`
                  : isPlacesTab
                    ? 'AI Research All'
                    : 'Refresh booking info'}
              </button>
            )}

            {/* Search saved places */}
            <div className="relative ml-auto" style={{ minWidth: 200 }}>
              <Search
                size={13}
                className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'var(--text-muted)' }}
              />
              <input
                value={savedSearchQuery}
                onChange={(e) => setSavedSearchQuery(e.target.value)}
                placeholder={isPlacesTab ? 'Search my places...' : 'Search my restaurants...'}
                className="w-full text-xs pl-7 pr-7 py-1.5 rounded-lg outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
              />
              {savedSearchQuery && (
                <button
                  onClick={() => setSavedSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                  title="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Venue type filter */}
            <div className="flex items-center gap-1 basis-full">
              <button
                onClick={() => (isPlacesTab ? setPlaceTypeFilter('all') : setVenueFilter('all'))}
                className="text-xs px-2.5 py-1 rounded-full transition-colors"
                style={{
                  background:
                    (isPlacesTab ? placeTypeFilter : venueFilter) === 'all'
                      ? 'var(--accent-amber)'
                      : 'var(--bg-tertiary)',
                  color:
                    (isPlacesTab ? placeTypeFilter : venueFilter) === 'all'
                      ? 'white'
                      : 'var(--text-muted)',
                }}
              >
                All ({isPlacesTab ? nonFoodPlaces.length : foodPlaces.length})
              </button>
              {VENUE_TYPES.filter((vt) =>
                isPlacesTab ? PLACE_VENUE_TYPES.includes(vt.id) : FOOD_VENUE_TYPES.includes(vt.id),
              ).map((vt) => {
                const count = (isPlacesTab ? nonFoodPlaces : foodPlaces).filter(
                  (r) => r.venueType === vt.id,
                ).length
                if (count === 0) return null
                const activeFilter = isPlacesTab ? placeTypeFilter : venueFilter
                return (
                  <button
                    key={vt.id}
                    onClick={() =>
                      isPlacesTab
                        ? setPlaceTypeFilter(placeTypeFilter === vt.id ? 'all' : vt.id)
                        : setVenueFilter(venueFilter === vt.id ? 'all' : vt.id)
                    }
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors"
                    style={{
                      background:
                        activeFilter === vt.id ? venueTypeColor[vt.id] : 'var(--bg-tertiary)',
                      color: activeFilter === vt.id ? 'white' : 'var(--text-muted)',
                    }}
                  >
                    {vt.icon} {vt.label} ({count})
                  </button>
                )
              })}
            </div>

            {/* Cuisine filter */}
            {!isPlacesTab && availableCuisines.length > 0 && (
              <select
                value={cuisineFilter}
                onChange={(e) => setCuisineFilter(e.target.value)}
                className="text-xs px-2 py-1 rounded-lg outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
              >
                <option value="all">All cuisines</option>
                {availableCuisines.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}

            <select
              value={googleRatingFilter}
              onChange={(e) => setGoogleRatingFilter(e.target.value)}
              className="text-xs px-2 py-1 rounded-lg outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
              title="Filter by Google rating"
            >
              <option value="all">Google rating</option>
              <option value="4.7">Google 4.7+</option>
              <option value="4.5">Google 4.5+</option>
              <option value="4.0">Google 4.0+</option>
            </select>

            <select
              value={personalRatingFilter}
              onChange={(e) => setPersonalRatingFilter(e.target.value)}
              className="text-xs px-2 py-1 rounded-lg outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
              title="Filter by your visit rating"
            >
              <option value="all">My rating</option>
              <option value="5">My 5 only</option>
              <option value="4">My 4+</option>
              <option value="3">My 3+</option>
              <option value="rated">Rated</option>
            </select>
          </div>

          {/* Manual add form */}
          {showAddForm && (
            <div className="card space-y-3">
              <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Add{' '}
                {isPlacesTab ? 'Attraction, Store, Museum, Stadium, or Venue' : 'Restaurant or Bar'}
              </h3>

              <div className="relative">
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                  Search Google Places *
                </label>
                <div className="flex gap-2">
                  <input
                    value={addForm.name}
                    onChange={(e) => {
                      setAddForm((f) => ({ ...f, name: e.target.value }))
                      if (addSelectedPlace) setAddSelectedPlace(null)
                    }}
                    placeholder={
                      isPlacesTab
                        ? 'Search venue, museum, store, stadium...'
                        : 'Search restaurant name...'
                    }
                    className="flex-1 px-3 py-1.5 rounded-lg text-sm outline-none"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border)',
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddSearchPlace()}
                  />
                  <button
                    onClick={handleAddSearchPlace}
                    disabled={addSearching || !addForm.name.trim()}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: '#ff9f0a',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {addSearching ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <Search size={12} />
                    )}
                  </button>
                </div>

                {/* Search results dropdown */}
                {addSearchResults.length > 0 && (
                  <div
                    className="absolute z-20 left-0 right-0 mt-1 rounded-lg overflow-hidden shadow-xl max-h-60 overflow-y-auto"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                  >
                    {addSearchResults.map((r) => (
                      <button
                        key={r.placeId}
                        onClick={() => handleSelectPlace(r)}
                        className="w-full text-left px-3 py-2 flex items-start gap-2 hover:brightness-125 transition-colors"
                        style={{ borderBottom: '1px solid var(--separator)' }}
                      >
                        <MapPin
                          size={12}
                          className="mt-0.5 shrink-0"
                          style={{ color: '#ff9f0a' }}
                        />
                        <div className="min-w-0">
                          <div
                            className="text-xs font-medium truncate"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {r.name}
                          </div>
                          <div
                            className="text-[10px] truncate"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {r.address}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {r.rating && (
                              <span className="text-[10px]" style={{ color: '#ff9f0a' }}>
                                {'\u2605'} {r.rating}
                              </span>
                            )}
                            {r.priceLevel && (
                              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                {'$'.repeat(r.priceLevel)}
                              </span>
                            )}
                            {r.cuisine.length > 0 && (
                              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                {r.cuisine.join(', ')}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                    <button
                      onClick={() => setAddSearchResults([])}
                      className="w-full text-center text-[10px] py-1.5"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Dismiss results
                    </button>
                  </div>
                )}

                {/* Selected place indicator */}
                {addSelectedPlace && (
                  <div
                    className="flex items-center gap-2 mt-1.5 px-2 py-1 rounded-lg text-xs"
                    style={{ background: 'rgba(255,159,10,0.1)', color: '#ff9f0a' }}
                  >
                    <Check size={12} />
                    <span className="truncate">
                      {addSelectedPlace.name} — {addSelectedPlace.address}
                    </span>
                    {addSelectedPlace.rating && (
                      <span>
                        {'\u2605'} {addSelectedPlace.rating}
                      </span>
                    )}
                    <button
                      onClick={() => {
                        setAddSelectedPlace(null)
                        setAddForm((f) => ({ ...f, name: '', address: '' }))
                      }}
                      className="ml-auto shrink-0"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                {/* Manual address fallback (only if no place selected) */}
                {!addSelectedPlace && addForm.name.trim() && (
                  <div className="mt-2">
                    <label
                      className="text-[10px] block mb-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Address (manual entry)
                    </label>
                    <input
                      value={addForm.address}
                      onChange={(e) => setAddForm((f) => ({ ...f, address: e.target.value }))}
                      placeholder="Enter address if not searching..."
                      className="w-full px-3 py-1.5 rounded-lg text-sm outline-none"
                      style={{
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                      }}
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <div>
                  <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                    Type
                  </label>
                  <div className="flex gap-1">
                    {VENUE_TYPES.filter((vt) =>
                      isPlacesTab
                        ? PLACE_VENUE_TYPES.includes(vt.id)
                        : FOOD_VENUE_TYPES.includes(vt.id),
                    ).map((vt) => (
                      <button
                        key={vt.id}
                        onClick={() => setAddForm((f) => ({ ...f, venueType: vt.id }))}
                        className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors"
                        style={{
                          background:
                            addForm.venueType === vt.id
                              ? venueTypeColor[vt.id]
                              : 'var(--bg-tertiary)',
                          color: addForm.venueType === vt.id ? 'white' : 'var(--text-muted)',
                        }}
                      >
                        {vt.icon} {vt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {!isPlacesTab && (
                  <div>
                    <label
                      className="text-[10px] block mb-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Price
                    </label>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4].map((p) => (
                        <button
                          key={p}
                          onClick={() =>
                            setAddForm((f) => ({ ...f, priceLevel: f.priceLevel === p ? 0 : p }))
                          }
                          className="text-xs px-2 py-1 rounded transition-colors"
                          style={{
                            background:
                              addForm.priceLevel === p
                                ? 'var(--accent-green)'
                                : 'var(--bg-tertiary)',
                            color: addForm.priceLevel === p ? 'white' : 'var(--text-muted)',
                          }}
                        >
                          {PRICE_LABELS[p]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {!isPlacesTab && (
                  <div>
                    <label
                      className="text-[10px] block mb-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Spice
                    </label>
                    <div className="flex gap-1">
                      {SPICE_LEVELS.map((s) => (
                        <button
                          key={s.id}
                          onClick={() =>
                            setAddForm((f) => ({
                              ...f,
                              spiceLevel: f.spiceLevel === s.id ? '' : s.id,
                            }))
                          }
                          className="text-[10px] px-2 py-1 rounded transition-colors"
                          style={{
                            background:
                              addForm.spiceLevel === s.id ? s.color : 'var(--bg-tertiary)',
                            color: addForm.spiceLevel === s.id ? 'white' : 'var(--text-muted)',
                          }}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className={`grid gap-3 ${isPlacesTab ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {!isPlacesTab && (
                  <div>
                    <label
                      className="text-[10px] block mb-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Cuisine
                    </label>
                    <select
                      value={addForm.cuisineCategory}
                      onChange={(e) =>
                        setAddForm((f) => ({ ...f, cuisineCategory: e.target.value }))
                      }
                      className="w-full px-2 py-1.5 rounded-lg text-xs outline-none"
                      style={{
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <option value="">Select cuisine</option>
                      {CUISINE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {!isPlacesTab && (
                  <div>
                    <label
                      className="text-[10px] block mb-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Book in advance
                    </label>
                    <input
                      value={addForm.bookingAdvance}
                      onChange={(e) =>
                        setAddForm((f) => ({ ...f, bookingAdvance: e.target.value }))
                      }
                      placeholder="e.g. 1-2 days"
                      className="w-full px-2 py-1.5 rounded-lg text-xs outline-none"
                      style={{
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                      }}
                    />
                  </div>
                )}
                <div>
                  <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                    Notes
                  </label>
                  <input
                    value={addForm.notes}
                    onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="Personal notes..."
                    className="w-full px-2 py-1.5 rounded-lg text-xs outline-none"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border)',
                    }}
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleAddManual}
                  disabled={!addForm.name.trim()}
                  className="flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                  style={{ background: '#ff9f0a', color: 'white' }}
                >
                  <Plus size={14} /> Add
                </button>
                <button
                  onClick={() => setShowAddForm(false)}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            {/* Left: Search + Discover */}
            <div className="space-y-4">
              <div className="card">
                <h3
                  className="text-sm font-medium mb-3 flex items-center gap-2"
                  style={{ color: '#ff9f0a' }}
                >
                  <Search size={14} /> Google Search
                </h3>
                <div className="relative">
                  <div className="flex gap-2">
                    <input
                      value={searchQuery}
                      onChange={(e) => handleSearchInputChange(e.target.value)}
                      onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                      placeholder={
                        isPlacesTab
                          ? 'e.g. museums, record stores, music venues...'
                          : 'e.g. Italian, sushi, cocktail bars...'
                      }
                      className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                      style={{
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--separator)',
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearchRestaurants()}
                    />
                    <button
                      onClick={handleSearchRestaurants}
                      disabled={searching}
                      className="px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
                      style={{ background: '#ff9f0a', color: 'white' }}
                    >
                      {searching ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : (
                        <Search size={14} />
                      )}
                    </button>
                  </div>
                  {showSuggestions && suggestions.length > 0 && (
                    <div
                      className="absolute left-0 right-0 mt-1 rounded-lg overflow-hidden shadow-lg z-50"
                      style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--separator)',
                      }}
                    >
                      {suggestions.map((s) => (
                        <button
                          key={s.placeId}
                          className="w-full text-left px-3 py-2 text-sm hover:brightness-125 transition-colors flex flex-col"
                          style={{
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                          }}
                          onMouseDown={() => handleSelectSuggestion(s)}
                        >
                          <span className="font-medium">{s.name}</span>
                          {s.description && (
                            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              {s.description}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {searchResults.length > 0 && (
                <div className="card">
                  <h3
                    className="text-sm font-medium mb-3"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Results ({searchResults.length})
                  </h3>
                  <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                    {searchResults.map((r) => (
                      <RestaurantCard
                        key={r.placeId}
                        restaurant={r}
                        onSave={() => handleSaveRestaurant(r)}
                        onRemove={() => handleRemoveRestaurant(r.placeId)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* AI Discover */}
              <div className="card">
                <div className="flex items-center justify-between mb-3">
                  <h3
                    className="text-sm font-medium flex items-center gap-2"
                    style={{ color: 'var(--accent-purple)' }}
                  >
                    <Sparkle size={14} /> AI Discover
                  </h3>
                  <button
                    onClick={handleDiscoverTrending}
                    disabled={discovering}
                    title="Search the web for trending & newly-opened spots you haven't saved yet"
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-40"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--accent-purple)',
                      border: '1px solid var(--accent-purple)',
                    }}
                  >
                    {discovering ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <TrendingUp size={12} />
                    )}
                    {isPlacesTab ? "What's new" : 'Trending & new'}
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    value={discoverQuery}
                    onChange={(e) => setDiscoverQuery(e.target.value)}
                    placeholder={
                      isPlacesTab
                        ? 'e.g. bookstores, vintage shops, museums, parks...'
                        : 'e.g. best date night spots, spicy food, rooftop bars...'
                    }
                    className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--separator)',
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && handleDiscover()}
                  />
                  <button
                    onClick={handleDiscover}
                    disabled={discovering}
                    className="px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
                    style={{ background: 'var(--accent-purple)', color: 'white' }}
                  >
                    {discovering ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <Sparkle size={14} />
                    )}
                  </button>
                </div>
                <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                  Type a vibe, or tap {isPlacesTab ? "“What's new”" : '“Trending & new”'} to
                  surface buzzy, recently-opened spots not already on your map.
                </p>
                {discoverError && (
                  <p className="text-xs mt-3" style={{ color: 'var(--accent-red)' }}>
                    {discoverError}
                  </p>
                )}
                {discoverResults && discoverResults.length > 0 && (
                  <div className="mt-3 space-y-2 max-h-[50vh] overflow-y-auto">
                    {discoverResults.map((s, i) => (
                      <div
                        key={i}
                        className="p-2.5 rounded-lg"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p
                                className="text-sm font-medium"
                                style={{ color: 'var(--text-primary)' }}
                              >
                                {s.name}
                              </p>
                              {s.venueType && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded-full"
                                  style={{
                                    background:
                                      venueTypeColor[s.venueType as VenueType] || '#ff9f0a',
                                    color: 'white',
                                  }}
                                >
                                  {s.venueType}
                                </span>
                              )}
                            </div>
                            {s.address && (
                              <p
                                className="text-[10px] mt-0.5"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                {s.address}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => handleAddSuggestion(s)}
                            disabled={s._added}
                            className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-colors disabled:opacity-40"
                            style={{
                              background: s._added ? 'var(--accent-green)' : 'var(--accent-purple)',
                              color: 'white',
                            }}
                          >
                            {s._added ? (
                              <>
                                <Check size={10} /> Added
                              </>
                            ) : (
                              <>
                                <Plus size={10} /> Add
                              </>
                            )}
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 mt-1.5">
                          {s.priceLevel && (
                            <span
                              className="text-xs font-medium"
                              style={{ color: 'var(--accent-green)' }}
                            >
                              {PRICE_LABELS[s.priceLevel]}
                            </span>
                          )}
                          {s.cuisineCategory && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-secondary)',
                              }}
                            >
                              {s.cuisineCategory}
                            </span>
                          )}
                          {s.bookingAdvance && (
                            <span
                              className="flex items-center gap-0.5 text-[10px]"
                              style={{ color: 'var(--accent-purple)' }}
                            >
                              <CalendarClock size={8} /> {s.bookingAdvance}
                            </span>
                          )}
                          {s.spiceLevel && s.spiceLevel !== 'none' && (
                            <span
                              className="flex items-center gap-0.5 text-[10px]"
                              style={{
                                color: SPICE_LEVELS.find((sp) => sp.id === s.spiceLevel)?.color,
                              }}
                            >
                              <Flame size={8} /> {s.spiceLevel}
                            </span>
                          )}
                        </div>
                        {s.description && (
                          <p
                            className="text-[10px] mt-1 leading-relaxed"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {s.description}
                          </p>
                        )}
                        {s.whyRecommended && (
                          <p
                            className="text-[10px] mt-1 italic"
                            style={{ color: 'var(--accent-purple)' }}
                          >
                            {s.whyRecommended}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {discoverRaw && (
                  <div
                    className="mt-3 text-xs leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {discoverRaw}
                  </div>
                )}
              </div>
            </div>

            {/* Right: Saved database (2 cols) */}
            <div className="col-span-2 space-y-4">
              <div className="card">
                <div className="flex items-center justify-between mb-3">
                  <h3
                    className="text-sm font-medium flex items-center gap-2"
                    style={{ color: 'var(--accent-amber)' }}
                  >
                    <Heart size={14} /> {isPlacesTab ? 'My Places' : 'My Restaurants'} (
                    {visibleSavedPlaces.length}
                    {visibleSavedPlaces.length !== visibleSavedTotal
                      ? ` / ${visibleSavedTotal}`
                      : ''}
                    )
                  </h3>
                </div>

                {visibleSavedPlaces.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2 max-h-[75vh] overflow-y-auto">
                    {visibleSavedPlaces.map((r) => (
                      <SavedRestaurantCard
                        key={r.placeId}
                        restaurant={r}
                        onRemove={() => handleRemoveRestaurant(r.placeId)}
                        onResearch={() => handleResearch(r.placeId)}
                        onRate={(rating, visitDate, notes, visitId) =>
                          handleSaveVisit(r.placeId, rating, visitDate, notes, visitId)
                        }
                        onEdit={() => setEditingRestaurant(r)}
                        onRemoveVisit={(visitId) => handleRemoveVisit(visitId)}
                        researching={researchingId === r.placeId}
                        isPlace={isPlacesTab}
                      />
                    ))}
                  </div>
                ) : visibleSavedTotal > 0 ? (
                  <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                    No results for current filters.
                  </p>
                ) : (
                  <p className="text-xs py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    {isPlacesTab
                      ? 'No saved places yet. Search Google Places or add a favorite manually.'
                      : 'No saved restaurants or bars yet. Add manually or search to save favorites.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Map Tab */}
      {tab === 'map' && (
        <div className="space-y-4">
          <PlacesMap
            places={savedRestaurants}
            selectedType={mapTypeFilter}
            onSelectedTypeChange={setMapTypeFilter}
            onSavePlace={handleSaveRestaurant}
          />
        </div>
      )}

      {/* Edit Restaurant Modal */}
      {editingRestaurant && (
        <EditRestaurantModal
          restaurant={editingRestaurant}
          onSave={(updates) => handleSaveEdit(editingRestaurant.placeId, updates)}
          onClose={() => setEditingRestaurant(null)}
        />
      )}

      {/* Event Detail Modal */}
      {selectedEvent && (
        <EventDetailModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  )
}

function EditRestaurantModal({
  restaurant: r,
  onSave,
  onClose,
}: {
  restaurant: SavedRestaurant
  onSave: (updates: any) => void
  onClose: () => void
}) {
  const [name, setName] = useState(r.name)
  const [address, setAddress] = useState(r.address || '')
  const [venueType, setVenueType] = useState<VenueType>(r.venueType)
  const [cuisineCategory, setCuisineCategory] = useState(r.cuisineCategory || '')
  const [spiceLevel, setSpiceLevel] = useState(r.spiceLevel || '')
  const [priceLevel, setPriceLevel] = useState(r.priceLevel || 0)
  const [reservationLink, setReservationLink] = useState(r.reservationLink || '')
  const [peakTimes, setPeakTimes] = useState(r.peakTimes || '')
  const [description, setDescription] = useState(r.description || '')
  const [notes, setNotes] = useState(r.notes || '')

  const handleSave = () => {
    onSave({
      name,
      address,
      venueType,
      cuisineCategory: cuisineCategory || undefined,
      spiceLevel: spiceLevel || undefined,
      priceLevel: priceLevel || undefined,
      reservationLink: reservationLink || undefined,
      peakTimes: peakTimes || undefined,
      description: description || undefined,
      notes: notes || undefined,
    })
  }

  const inputStyle = {
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-restaurant-title"
    >
      <div
        className="w-[480px] max-h-[85vh] overflow-y-auto rounded-xl p-5 space-y-3"
        style={{ background: 'var(--bg-primary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 id="edit-restaurant-title" className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Edit Restaurant
          </h3>
          <button onClick={onClose} className="p-1" style={{ color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5"
              style={inputStyle}
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Address
            </span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5"
              style={inputStyle}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                Type
              </span>
              <select
                value={venueType}
                onChange={(e) => setVenueType(e.target.value as VenueType)}
                className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5"
                style={inputStyle}
              >
                {VENUE_TYPES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                Cuisine
              </span>
              <input
                value={cuisineCategory}
                onChange={(e) => setCuisineCategory(e.target.value)}
                className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5"
                style={inputStyle}
                placeholder="e.g. Italian, Korean"
              />
            </label>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                Price
              </span>
              <select
                value={priceLevel}
                onChange={(e) => setPriceLevel(parseInt(e.target.value))}
                className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5"
                style={inputStyle}
              >
                <option value={0}>?</option>
                <option value={1}>$</option>
                <option value={2}>$$</option>
                <option value={3}>$$$</option>
                <option value={4}>$$$$</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                Spice
              </span>
              <select
                value={spiceLevel}
                onChange={(e) => setSpiceLevel(e.target.value)}
                className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5"
                style={inputStyle}
              >
                <option value="">None</option>
                {SPICE_LEVELS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                Peak times
              </span>
              <input
                value={peakTimes}
                onChange={(e) => setPeakTimes(e.target.value)}
                className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5"
                style={inputStyle}
                placeholder="Fri-Sat 7-9pm"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Reservation link
            </span>
            <input
              value={reservationLink}
              onChange={(e) => setReservationLink(e.target.value)}
              className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5"
              style={inputStyle}
              placeholder="https://..."
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5 resize-none"
              style={inputStyle}
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Notes
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full text-xs px-2 py-1.5 rounded-lg mt-0.5 resize-none"
              style={inputStyle}
              placeholder="Personal notes..."
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-lg"
            style={{ color: 'var(--text-muted)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="text-xs px-4 py-1.5 rounded-lg font-medium"
            style={{ background: 'var(--accent-blue)', color: 'white' }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function LocationInfo() {
  const [location, setLocation] = useState<{
    homeNeighborhood?: string
    homeLocation?: string
    commuteNotes?: string
    transportMode?: string
  }>({})

  useEffect(() => {
    window.api.getSettings('appSettings').then((settings: any) => {
      if (settings) {
        setLocation({
          homeNeighborhood: settings.homeNeighborhood,
          homeLocation: settings.homeLocation,
          commuteNotes: settings.commuteNotes,
          transportMode: settings.transportMode,
        })
      }
    })
  }, [])

  if (!location.homeNeighborhood && !location.homeLocation) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Set your home location in Settings.
      </p>
    )
  }

  return (
    <div className="space-y-1.5 text-xs">
      {location.homeNeighborhood && (
        <p style={{ color: 'var(--text-primary)' }}>{location.homeNeighborhood}</p>
      )}
      {location.homeLocation && (
        <p style={{ color: 'var(--text-muted)' }}>{location.homeLocation}</p>
      )}
      {location.commuteNotes && (
        <p style={{ color: 'var(--text-secondary)' }}>{location.commuteNotes}</p>
      )}
      {location.transportMode && (
        <p className="capitalize" style={{ color: 'var(--text-muted)' }}>
          Transport: {location.transportMode}
        </p>
      )}
    </div>
  )
}
