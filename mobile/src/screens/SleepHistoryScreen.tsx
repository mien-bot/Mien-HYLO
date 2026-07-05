/**
 * Sleep History — view past nights, trend chart, and a scrollable log.
 * Mirrors the desktop Sleep Detail page.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { parseSleepSessions, type SleepSession } from '../services/sleep-analysis.service'
import { safeDiv, safePct } from '../utils/safe-math'

const RANGES = [
  { label: '7D', days: 7 },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
]

function formatDate(s: string): string {
  try {
    const d = new Date(s + 'T12:00:00')
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch { return s }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function SleepHistoryScreen({ navigation }: { navigation: any }) {
  const insets = useSafeAreaInsets()
  const [days, setDays] = useState<number>(30)
  const [sessions, setSessions] = useState<SleepSession[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const data = await parseSleepSessions(days)
      setSessions(data)
    } catch (err) {
      console.error('Sleep history load error:', err)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [days])

  const filtered = useMemo(() => sessions.filter(s => s.totalAsleep > 0), [sessions])
  const stats = useMemo(() => {
    if (filtered.length === 0) return null
    const avgHours = filtered.reduce((sum, s) => sum + s.totalAsleep / 60, 0) / filtered.length
    const totalDeep = filtered.reduce((sum, s) => sum + s.deepSleep, 0)
    const totalRem = filtered.reduce((sum, s) => sum + s.remSleep, 0)
    const totalAsleep = filtered.reduce((sum, s) => sum + s.totalAsleep, 0)
    const totalInBed = filtered.reduce((sum, s) => sum + s.totalInBed, 0)
    return {
      nights: filtered.length,
      avgHours,
      deepPct: safePct(totalDeep, totalAsleep),
      remPct: safePct(totalRem, totalAsleep),
      efficiency: safePct(totalAsleep, totalInBed),
    }
  }, [filtered])

  const maxHours = useMemo(() => {
    if (filtered.length === 0) return 10
    return Math.max(...filtered.map(s => s.totalAsleep / 60), 8) + 1
  }, [filtered])

  // Right-most bar = most recent night. Display oldest-first for the chart.
  const chartData = useMemo(() => [...filtered].reverse(), [filtered])
  const goalLine = 8 // hours

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>Sleep History</Text>
        <TouchableOpacity onPress={load} style={styles.backBtn}>
          <Ionicons name="refresh" size={20} color={colors.text.primary} />
        </TouchableOpacity>
      </View>

      {/* Range selector */}
      <View style={styles.rangeRow}>
        {RANGES.map(r => (
          <TouchableOpacity
            key={r.days}
            onPress={() => setDays(r.days)}
            style={[styles.rangeBtn, days === r.days && styles.rangeBtnActive]}
          >
            <Text style={[styles.rangeText, days === r.days && styles.rangeTextActive]}>{r.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <NoodleSpinner color={colors.accent.purple} size={32} />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No sleep data in the last {days} days. Sync from Desktop or run Health Auto Export.
          </Text>
        </View>
      ) : (
        <>
          {/* Stats summary */}
          {stats && (
            <View style={styles.statsRow}>
              <StatBox label="Nights" value={String(stats.nights)} color={colors.accent.purple} />
              <StatBox label="Avg" value={`${stats.avgHours.toFixed(1)}h`} color={colors.accent.blue} />
              <StatBox label="Deep" value={`${stats.deepPct.toFixed(0)}%`} color="#6366f1" />
              <StatBox label="REM" value={`${stats.remPct.toFixed(0)}%`} color="#a78bfa" />
            </View>
          )}

          {/* Bar chart */}
          <View style={styles.card}>
            <View style={styles.chartHeader}>
              <Text style={styles.cardLabel}>Sleep Duration</Text>
              <Text style={styles.chartLegend}>
                <Text style={{ color: '#7c3aed' }}>● </Text>9h+
                <Text style={{ color: '#1d4ed8' }}>  ● </Text>8–9h
                <Text style={{ color: '#3b82f6' }}>  ● </Text>7–8h
                <Text style={{ color: '#64748b' }}>  ● </Text>6–7h
                <Text style={{ color: '#f59e0b' }}>  ● </Text>5–6h
                <Text style={{ color: '#dc2626' }}>  ● </Text>4–5h
                <Text style={{ color: '#7f1d1d' }}>  ● </Text>≤4h
              </Text>
            </View>
            <View style={styles.chart}>
              {/* Goal line */}
              <View style={[styles.goalLine, { bottom: (goalLine / maxHours) * 120 }]}>
                <Text style={styles.goalLabel}>{goalLine}h</Text>
              </View>
              {chartData.map((s, i) => {
                const hours = s.totalAsleep / 60
                const h = (hours / maxHours) * 120
                const bg = hours >= 9 ? '#7c3aed'
                  : hours >= 8 ? '#1d4ed8'
                  : hours >= 7 ? '#3b82f6'
                  : hours >= 6 ? '#64748b'
                  : hours >= 5 ? '#f59e0b'
                  : hours > 4 ? '#dc2626'
                  : '#7f1d1d'
                return (
                  <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
                    <View style={{ width: '70%', height: h, backgroundColor: bg, borderRadius: 2 }} />
                  </View>
                )
              })}
            </View>
            <View style={styles.chartXAxis}>
              <Text style={styles.chartLabel}>{formatDate(chartData[0]?.date || '')}</Text>
              <Text style={styles.chartLabel}>{formatDate(chartData[chartData.length - 1]?.date || '')}</Text>
            </View>
          </View>

          {/* Nightly log */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Nightly Log</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ minWidth: 340 }}>
                <View style={styles.logHeader}>
                  <Text style={[styles.logHeaderCell, { width: 70 }]}>Date</Text>
                  <Text style={[styles.logHeaderCell, { width: 50, textAlign: 'right' }]}>Hours</Text>
                  <Text style={[styles.logHeaderCell, { width: 44, textAlign: 'right' }]}>Eff%</Text>
                  <Text style={[styles.logHeaderCell, { width: 66, textAlign: 'right' }]}>Bed</Text>
                  <Text style={[styles.logHeaderCell, { width: 66, textAlign: 'right' }]}>Wake</Text>
                </View>
                {filtered.map((s, i) => {
                  const hours = s.totalAsleep / 60
                  const eff = safePct(s.totalAsleep, s.totalInBed)
                  return (
                    <View key={i} style={styles.logRow}>
                      <Text style={[styles.logCell, { width: 70, color: colors.text.primary }]}>{formatDate(s.date)}</Text>
                      <Text style={[styles.logCell, { width: 50, textAlign: 'right', color: hours >= 9 ? '#7c3aed' : hours >= 8 ? '#1d4ed8' : hours >= 7 ? '#3b82f6' : hours >= 6 ? '#64748b' : hours >= 5 ? '#f59e0b' : hours > 4 ? '#dc2626' : '#7f1d1d' }]}>
                        {hours.toFixed(1)}
                      </Text>
                      <Text style={[styles.logCell, { width: 44, textAlign: 'right' }]}>
                        {eff > 0 ? eff.toFixed(0) : '—'}
                      </Text>
                      <Text style={[styles.logCell, { width: 66, textAlign: 'right' }]}>{formatTime(s.sleepStart)}</Text>
                      <Text style={[styles.logCell, { width: 66, textAlign: 'right' }]}>{formatTime(s.sleepEnd)}</Text>
                    </View>
                  )
                })}
              </View>
            </ScrollView>
          </View>
        </>
      )}
    </ScrollView>
  )
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={[styles.statBox, { borderLeftColor: color }]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, paddingHorizontal: spacing.lg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  title: { fontSize: 22, fontWeight: '700', color: colors.text.primary, flex: 1, marginLeft: spacing.sm },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg.tertiary,
    borderRadius: 8,
  },
  rangeRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md },
  rangeBtn: {
    flex: 1,
    paddingVertical: 8,
    backgroundColor: colors.bg.tertiary,
    borderRadius: 8,
    alignItems: 'center',
  },
  rangeBtnActive: { backgroundColor: colors.accent.purple + '33' },
  rangeText: { fontSize: 12, fontWeight: '500', color: colors.text.muted },
  rangeTextActive: { color: colors.accent.purple, fontWeight: '700' },
  center: { padding: spacing.xl, alignItems: 'center' },
  card: {
    backgroundColor: colors.bg.card,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardLabel: { fontSize: 13, fontWeight: '600', color: colors.text.secondary, marginBottom: spacing.sm },
  emptyText: { fontSize: 14, color: colors.text.muted, textAlign: 'center' },
  statsRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md },
  statBox: {
    flex: 1,
    backgroundColor: colors.bg.card,
    borderLeftWidth: 3,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 8,
  },
  statValue: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  statLabel: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  chartLegend: { fontSize: 10, color: colors.text.muted },
  chart: {
    flexDirection: 'row',
    height: 120,
    alignItems: 'flex-end',
    gap: 1,
    paddingTop: 12,
    position: 'relative',
  },
  goalLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.text.muted + '44',
    zIndex: 1,
  },
  goalLabel: {
    position: 'absolute',
    right: 0,
    top: -10,
    fontSize: 9,
    color: colors.text.muted,
  },
  chartXAxis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  chartLabel: { fontSize: 10, color: colors.text.muted },
  logHeader: {
    flexDirection: 'row',
    paddingBottom: spacing.xs,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  logHeaderCell: { fontSize: 10, fontWeight: '600', color: colors.text.muted, textTransform: 'uppercase' },
  logRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  logCell: { fontSize: 13, color: colors.text.secondary },
})
