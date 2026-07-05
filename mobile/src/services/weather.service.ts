/**
 * Weather service — fetches Open-Meteo forecasts for planner context.
 * No API key required. Calls Open-Meteo geocoding + forecast APIs directly.
 */
import { getSettings } from '../lib/storage'

export interface PlannerWeatherDay {
  date: string
  label: string
  condition: string
  temperatureMinC: number | null
  temperatureMaxC: number | null
  precipitationProbabilityPct: number | null
  precipitationMm: number | null
  snowfallCm: number | null
  planningSummary: string
}

export interface PlannerWeatherPreview {
  location: string
  source: string
  days: PlannerWeatherDay[]
  unavailableReason?: string
}

const WEATHER_TIMEOUT_MS = 8000

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function localDateString(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function normalizeDates(dates?: string[]): string[] {
  const valid = (dates || [])
    .map((d) => String(d || '').trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  return Array.from(new Set(valid.length > 0 ? valid : [localDateString()])).sort()
}

async function resolveLocation(): Promise<string> {
  try {
    const settings = await getSettings()
    return (
      (settings.weekendCity ||
        settings.homeNeighborhood ||
        settings.homeLocation ||
        'Chicago') as string
    ).trim()
  } catch {
    return 'Chicago'
  }
}

function weatherCodeLabel(code: number | undefined): string {
  if (code == null) return 'Forecast'
  if (code === 0) return 'Sunny'
  if ([1, 2].includes(code)) return 'Mostly sunny'
  if (code === 3) return 'Gloomy'
  if ([45, 48].includes(code)) return 'Foggy'
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle'
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow'
  if ([95, 96, 99].includes(code)) return 'Storms'
  return 'Mixed'
}

function buildPlanningSummary(day: PlannerWeatherDay): string {
  const temp =
    day.temperatureMinC == null || day.temperatureMaxC == null
      ? ''
      : `${Math.round(day.temperatureMinC)}-${Math.round(day.temperatureMaxC)}C`
  const rain = day.precipitationProbabilityPct ?? 0
  const snow = day.snowfallCm ?? 0
  const parts = [day.condition]
  if (temp) parts.push(temp)
  if (snow > 0.2) {
    parts.push(`${snow.toFixed(1)} cm snow possible`)
    parts.push('favor indoor plans or winter-ready travel')
  } else if (rain >= 60 || (day.precipitationMm ?? 0) >= 2) {
    parts.push(`${rain}% rain risk`)
    parts.push('keep indoor backups')
  } else if (rain >= 30) {
    parts.push(`${rain}% rain risk`)
    parts.push('pack a light rain option')
  } else if (['Sunny', 'Mostly sunny'].includes(day.condition)) {
    parts.push('good for outdoor blocks')
  } else if (day.condition === 'Gloomy' || day.condition === 'Foggy') {
    parts.push('low-sun, cozy or indoor-friendly')
  }
  return parts.join(' - ')
}

interface GeocodeResult {
  results?: Array<{
    name: string
    latitude: number
    longitude: number
    admin1?: string
    country?: string
  }>
}

interface ForecastResult {
  daily?: {
    time?: string[]
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_sum?: number[]
    precipitation_probability_max?: number[]
    snowfall_sum?: number[]
  }
}

async function geocodeLocation(
  location: string,
): Promise<{ label: string; latitude: number; longitude: number } | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
  const data = await fetchJson<GeocodeResult>(url)
  const first = data?.results?.[0]
  if (!first || typeof first.latitude !== 'number' || typeof first.longitude !== 'number') {
    return null
  }
  const region = [first.admin1, first.country].filter(Boolean).join(', ')
  return {
    label: region ? `${first.name}, ${region}` : first.name,
    latitude: first.latitude,
    longitude: first.longitude,
  }
}

export async function getPlannerWeatherPreview(options?: {
  dates?: string[]
  location?: string
}): Promise<PlannerWeatherPreview> {
  const dates = normalizeDates(options?.dates)
  const location = options?.location?.trim() || (await resolveLocation())

  const geocoded = await geocodeLocation(location)
  if (!geocoded) {
    return {
      location,
      source: 'Open-Meteo',
      days: [],
      unavailableReason: `Could not resolve weather location "${location}".`,
    }
  }

  const startDate = dates[0]
  const endDate = dates[dates.length - 1]

  const params = new URLSearchParams({
    latitude: String(geocoded.latitude),
    longitude: String(geocoded.longitude),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'snowfall_sum',
    ].join(','),
    temperature_unit: 'celsius',
    precipitation_unit: 'mm',
    timezone: 'auto',
    start_date: startDate,
    end_date: endDate,
  })

  const forecast = await fetchJson<ForecastResult>(
    `https://api.open-meteo.com/v1/forecast?${params}`,
  )
  const daily = forecast?.daily
  if (!daily?.time?.length) {
    return {
      location: geocoded.label,
      source: 'Open-Meteo',
      days: [],
      unavailableReason: 'Weather forecast is unavailable right now.',
    }
  }

  const wanted = new Set(dates)
  const days = daily.time
    .map((date, i): PlannerWeatherDay | null => {
      if (!wanted.has(date)) return null
      const condition = weatherCodeLabel(daily.weather_code?.[i])
      const day: PlannerWeatherDay = {
        date,
        label: new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        }),
        condition,
        temperatureMinC: daily.temperature_2m_min?.[i] ?? null,
        temperatureMaxC: daily.temperature_2m_max?.[i] ?? null,
        precipitationProbabilityPct: daily.precipitation_probability_max?.[i] ?? null,
        precipitationMm: daily.precipitation_sum?.[i] ?? null,
        snowfallCm: daily.snowfall_sum?.[i] ?? null,
        planningSummary: '',
      }
      return { ...day, planningSummary: buildPlanningSummary(day) }
    })
    .filter((day): day is PlannerWeatherDay => Boolean(day))

  return { location: geocoded.label, source: 'Open-Meteo', days }
}

export function formatWeatherForPlanner(preview: PlannerWeatherPreview): string {
  if (preview.unavailableReason || preview.days.length === 0) {
    return `## Weather Preview\n- ${preview.unavailableReason || 'No weather preview available.'}\n\n`
  }
  let context = `## Weather Preview (${preview.location}, Celsius)\n`
  for (const day of preview.days) {
    context += `- ${day.label} (${day.date}): ${day.planningSummary}\n`
  }
  context +=
    'Use this forecast when deciding outdoor vs indoor timing, rain/snow backups, commute buffers, and exercise choices.\n\n'
  return context
}
