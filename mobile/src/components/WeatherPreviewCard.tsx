import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '../lib/theme'
import type { PlannerWeatherPreview } from '../services/weather.service'

function iconFor(
  condition: string,
  snowCm: number | null,
  rainPct: number | null,
): keyof typeof Ionicons.glyphMap {
  if ((snowCm ?? 0) > 0.2 || /snow/i.test(condition)) return 'snow-outline'
  if ((rainPct ?? 0) >= 30 || /rain|drizzle|storm/i.test(condition)) return 'rainy-outline'
  return 'partly-sunny-outline'
}

interface Props {
  preview: PlannerWeatherPreview | null
  loading?: boolean
  compact?: boolean
}

export default function WeatherPreviewCard({ preview, loading, compact = false }: Props) {
  if (loading) {
    return (
      <View style={styles.loadingCard}>
        <Text style={styles.loadingText}>Loading weather preview…</Text>
      </View>
    )
  }

  if (!preview) return null

  if (preview.unavailableReason || preview.days.length === 0) {
    return (
      <View style={styles.unavailableCard}>
        <Text style={styles.unavailableText}>
          {preview.unavailableReason || 'Weather preview unavailable.'}
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="partly-sunny-outline" size={14} color={colors.accent.cyan} />
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Weather preview</Text>
            <Text style={styles.headerSub} numberOfLines={1}>
              {preview.location} · Celsius
            </Text>
          </View>
        </View>
        <Text style={styles.source}>{preview.source}</Text>
      </View>

      <View style={compact ? styles.daysCompact : styles.daysGrid}>
        {preview.days.map((day) => {
          const icon = iconFor(day.condition, day.snowfallCm, day.precipitationProbabilityPct)
          return (
            <View key={day.date} style={[styles.dayCard, compact && styles.dayCardCompact]}>
              <View style={styles.dayHeader}>
                <Text style={styles.dayLabel}>{day.label}</Text>
                <Ionicons name={icon} size={13} color={colors.accent.blue} />
              </View>
              <View style={styles.dayMeta}>
                <Text style={styles.condition}>{day.condition}</Text>
                <Text style={styles.metaItem}>
                  {day.temperatureMinC == null || day.temperatureMaxC == null
                    ? 'Temp n/a'
                    : `${Math.round(day.temperatureMinC)}-${Math.round(day.temperatureMaxC)}°C`}
                </Text>
                {day.precipitationProbabilityPct != null && (
                  <Text style={styles.metaItem}>Rain {day.precipitationProbabilityPct}%</Text>
                )}
                {(day.snowfallCm ?? 0) > 0.2 && (
                  <Text style={styles.metaItem}>Snow {day.snowfallCm?.toFixed(1)} cm</Text>
                )}
              </View>
              {!compact && day.planningSummary ? (
                <Text style={styles.summary}>{day.planningSummary}</Text>
              ) : null}
            </View>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  loadingCard: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.bg.tertiary,
    marginBottom: 8,
  },
  loadingText: {
    fontSize: 12,
    color: colors.text.muted,
  },
  unavailableCard: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(234,179,8,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(234,179,8,0.22)',
    marginBottom: 8,
  },
  unavailableText: {
    fontSize: 12,
    color: colors.text.secondary,
  },
  card: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.bg.tertiary,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.text.primary,
  },
  headerSub: {
    fontSize: 10,
    color: colors.text.muted,
  },
  source: {
    fontSize: 10,
    color: colors.text.muted,
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  daysCompact: {
    gap: 4,
  },
  dayCard: {
    flex: 1,
    minWidth: '45%',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.bg.secondary,
  },
  dayCardCompact: {
    minWidth: '100%',
    paddingVertical: 6,
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  dayLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.text.primary,
  },
  dayMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  condition: {
    fontSize: 10,
    color: colors.text.secondary,
  },
  metaItem: {
    fontSize: 10,
    color: colors.text.muted,
  },
  summary: {
    fontSize: 10,
    color: colors.text.muted,
    marginTop: 4,
    lineHeight: 14,
  },
})
