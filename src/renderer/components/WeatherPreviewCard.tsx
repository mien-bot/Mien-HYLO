import { CloudRain, CloudSun, Snowflake, Thermometer } from 'lucide-react'
import type { PlannerWeatherPreview } from '../../shared/types/ipc.types'

function iconFor(condition: string, snowCm: number | null, rainPct: number | null) {
  if ((snowCm ?? 0) > 0.2 || /snow/i.test(condition)) return Snowflake
  if ((rainPct ?? 0) >= 30 || /rain|drizzle|storm/i.test(condition)) return CloudRain
  return CloudSun
}

export default function WeatherPreviewCard({
  preview,
  loading,
  compact = false,
}: {
  preview: PlannerWeatherPreview | null
  loading?: boolean
  compact?: boolean
}) {
  if (loading) {
    return (
      <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--bg-tertiary)' }}>
        <span style={{ color: 'var(--text-muted)' }}>Loading weather preview...</span>
      </div>
    )
  }

  if (!preview) return null

  if (preview.unavailableReason || preview.days.length === 0) {
    return (
      <div
        className="rounded-lg px-3 py-2 text-xs"
        style={{
          background: 'rgba(234,179,8,0.08)',
          border: '1px solid rgba(234,179,8,0.22)',
          color: 'var(--text-secondary)',
        }}
      >
        {preview.unavailableReason || 'Weather preview unavailable.'}
      </div>
    )
  }

  return (
    <div
      className="rounded-lg p-3 space-y-2"
      style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <CloudSun size={14} style={{ color: 'var(--accent-cyan)' }} />
          <div className="min-w-0">
            <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
              Weather preview
            </p>
            <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
              {preview.location} - Celsius
            </p>
          </div>
        </div>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {preview.source}
        </span>
      </div>

      <div className={compact ? 'space-y-1.5' : 'grid grid-cols-2 gap-2'}>
        {preview.days.map((day) => {
          const Icon = iconFor(day.condition, day.snowfallCm, day.precipitationProbabilityPct)
          return (
            <div
              key={day.date}
              className="rounded-lg px-2.5 py-2"
              style={{ background: 'var(--bg-secondary)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  {day.label}
                </span>
                <Icon size={13} style={{ color: 'var(--accent-blue)' }} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
                <span style={{ color: 'var(--text-secondary)' }}>{day.condition}</span>
                <span className="flex items-center gap-0.5" style={{ color: 'var(--text-muted)' }}>
                  <Thermometer size={10} />
                  {day.temperatureMinC == null || day.temperatureMaxC == null
                    ? 'Temp n/a'
                    : `${Math.round(day.temperatureMinC)}-${Math.round(day.temperatureMaxC)}C`}
                </span>
                {day.precipitationProbabilityPct != null && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    Rain {day.precipitationProbabilityPct}%
                  </span>
                )}
                {(day.snowfallCm ?? 0) > 0.2 && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    Snow {day.snowfallCm?.toFixed(1)} cm
                  </span>
                )}
              </div>
              {!compact && (
                <p className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  {day.planningSummary}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
