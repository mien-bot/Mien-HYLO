import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl, Alert } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'
import { fullSyncFromRelay } from '../services/health-sync.service'
import { generateBriefing, BRIEFING_LABELS, type BriefingType } from '../services/briefing-generator.service'

interface BriefingRow {
  id: number
  type: string
  date: string
  content: string
  created_at: string
}

const TYPE_LABEL: Record<string, string> = {
  morning_finance: 'Finance',
  health_weekly: 'Health',
  daily_schedule: 'Schedule',
  morning_sleep: 'Sleep',
}

function typeColor(type: string): string {
  switch (type) {
    case 'morning_finance': return colors.accent.green
    case 'health_weekly': return colors.accent.red
    case 'morning_sleep': return colors.accent.purple
    case 'daily_schedule': return colors.accent.blue
    default: return colors.text.muted
  }
}

const GENERATABLE_TYPES: BriefingType[] = ['morning_finance', 'health_weekly', 'morning_sleep']

export default function BriefingsScreen() {
  const insets = useSafeAreaInsets()
  const [briefings, setBriefings] = useState<BriefingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<BriefingRow | null>(null)
  const [generating, setGenerating] = useState<BriefingType | null>(null)

  const load = useCallback(async () => {
    try {
      const db = await getDb()
      const rows = (await db.getAllAsync(
        `SELECT id, type, date, content, created_at FROM briefings
         ORDER BY datetime(created_at) DESC LIMIT 50`
      )) as BriefingRow[]
      setBriefings(rows)
      if (rows.length > 0 && !selected) setSelected(rows[0])
    } catch (err) {
      console.error('Failed to load briefings:', err)
    }
    setLoading(false)
  }, [selected])

  useEffect(() => { load() }, [load])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await fullSyncFromRelay()
      await load()
    } catch (err) {
      console.error('Refresh failed:', err)
    }
    setRefreshing(false)
  }

  const handleGenerate = async (type: BriefingType) => {
    if (generating) return
    setGenerating(type)
    try {
      await generateBriefing(type)
      await load()
    } catch (err: any) {
      Alert.alert('Generate Failed', err?.message || String(err))
    } finally {
      setGenerating(null)
    }
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <NoodleSpinner color={colors.accent.blue} size={32} />
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.xl }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent.blue} />}
    >
      <Text style={styles.title}>Briefings</Text>

      <View style={styles.generateRow}>
        {GENERATABLE_TYPES.map((t) => {
          const isGenerating = generating === t
          const accent = t === 'morning_finance' ? colors.accent.green : t === 'health_weekly' ? colors.accent.red : colors.accent.purple
          return (
            <TouchableOpacity
              key={t}
              onPress={() => handleGenerate(t)}
              disabled={generating !== null}
              style={[styles.generateBtn, { borderColor: accent, opacity: generating && !isGenerating ? 0.4 : 1 }]}
            >
              {isGenerating ? (
                <NoodleSpinner color={accent} size={16} />
              ) : (
                <Ionicons name="sparkles-outline" size={14} color={accent} />
              )}
              <Text style={[styles.generateBtnText, { color: accent }]}>
                {isGenerating ? 'Generating…' : `Generate ${BRIEFING_LABELS[t].replace(' Briefing', '').replace(' Report', '')}`}
              </Text>
            </TouchableOpacity>
          )
        })}
      </View>

      {briefings.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="document-text-outline" size={32} color={colors.text.muted} />
          <Text style={styles.emptyText}>No briefings synced yet. Pull to refresh.</Text>
        </View>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {briefings.map(b => {
              const isActive = selected?.id === b.id
              return (
                <TouchableOpacity
                  key={b.id}
                  onPress={() => setSelected(b)}
                  style={[
                    styles.chip,
                    isActive && styles.chipActive,
                    { borderColor: typeColor(b.type) },
                  ]}
                >
                  <Text style={[styles.chipLabel, { color: typeColor(b.type) }]}>
                    {TYPE_LABEL[b.type] || b.type}
                  </Text>
                  <Text style={[styles.chipDate, isActive && styles.chipDateActive]}>
                    {formatDate(b.date)}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </ScrollView>

          {selected && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={[styles.cardType, { color: typeColor(selected.type) }]}>
                  {TYPE_LABEL[selected.type] || selected.type}
                </Text>
                <Text style={styles.cardDate}>{formatDate(selected.date)}</Text>
              </View>
              <Text style={styles.cardBody}>{selected.content}</Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  )
}

function formatDate(s: string): string {
  if (!s) return ''
  try {
    const d = new Date(s + 'T00:00:00')
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch {
    return s
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, paddingHorizontal: spacing.md },
  center: { alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.sm },
  generateRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  generateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: 14,
    backgroundColor: colors.bg.secondary,
  },
  generateBtnText: { fontSize: 11, fontWeight: '600' },
  empty: { alignItems: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyText: { color: colors.text.muted, fontSize: 13 },
  chipRow: { marginBottom: spacing.md, marginHorizontal: -spacing.md, paddingHorizontal: spacing.md },
  chip: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    marginRight: spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: colors.bg.tertiary,
    alignItems: 'center',
  },
  chipActive: { backgroundColor: colors.bg.secondary, borderWidth: 1.5 },
  chipLabel: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase' },
  chipDate: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  chipDateActive: { color: colors.text.primary },
  card: {
    backgroundColor: colors.bg.secondary,
    borderRadius: 14,
    padding: spacing.md,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  cardType: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardDate: { fontSize: 11, color: colors.text.muted },
  cardBody: { fontSize: 14, color: colors.text.secondary, lineHeight: 22 },
})
