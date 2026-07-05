import { fetchJson } from '../lib/fetch-with-retry'
import { getAppSettings } from '../lib/settings'
import type { PlannerWeatherDay, PlannerWeatherPreview } from '../../shared/types/ipc.types'

interface GeocodeResponse {
  results?: Array<{
    name: string
    latitude: number
    longitude: number
    admin1?: string
    country?: string
  }>
}

interface ForecastResponse {
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

function localDateString(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T12:00:00`)
  date.setDate(date.getDate() + days)
  return localDateString(date)
}

function normalizeDates(dates?: string[]): string[] {
  const valid = (dates || [])
    .map((date) => String(date || '').trim())
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
  return Array.from(new Set(valid.length > 0 ? valid : [localDateString()])).sort()
}

function resolveLocation(explicitLocation?: string): string {
  if (explicitLocation?.trim()) return explicitLocation.trim()
  const settings = getAppSettings()
  return (
    settings?.weekendCity ||
    settings?.homeNeighborhood ||
    settings?.homeLocation ||
    'Chicago'
  ).trim()
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

async function geocodeLocation(location: string): Promise<{
  label: string
  latitude: number
  longitude: number
} | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    location,
  )}&count=1&language=en&format=json`
  const data = await fetchJson<GeocodeResponse>(url, {
    timeoutMs: 8000,
    retries: 1,
    label: 'weather geocode',
  })
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
  const location = resolveLocation(options?.location)
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
  const forecastEnd = endDate < startDate ? addDays(startDate, 1) : endDate
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(geocoded.latitude))
  url.searchParams.set('longitude', String(geocoded.longitude))
  url.searchParams.set(
    'daily',
    [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'snowfall_sum',
    ].join(','),
  )
  url.searchParams.set('temperature_unit', 'celsius')
  url.searchParams.set('precipitation_unit', 'mm')
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('start_date', startDate)
  url.searchParams.set('end_date', forecastEnd)

  const forecast = await fetchJson<ForecastResponse>(url.toString(), {
    timeoutMs: 8000,
    retries: 1,
    label: 'weather forecast',
  })
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
    .map((date, index): PlannerWeatherDay | null => {
      if (!wanted.has(date)) return null
      const condition = weatherCodeLabel(daily.weather_code?.[index])
      const day: PlannerWeatherDay = {
        date,
        label: new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        }),
        condition,
        temperatureMinC: daily.temperature_2m_min?.[index] ?? null,
        temperatureMaxC: daily.temperature_2m_max?.[index] ?? null,
        precipitationProbabilityPct: daily.precipitation_probability_max?.[index] ?? null,
        precipitationMm: daily.precipitation_sum?.[index] ?? null,
        snowfallCm: daily.snowfall_sum?.[index] ?? null,
        planningSummary: '',
      }
      return { ...day, planningSummary: buildPlanningSummary(day) }
    })
    .filter((day): day is PlannerWeatherDay => Boolean(day))

  return {
    location: geocoded.label,
    source: 'Open-Meteo',
    days,
  }
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
