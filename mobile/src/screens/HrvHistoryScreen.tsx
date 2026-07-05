/**
 * HRV History — view past heart-rate-variability readings with a trend line.
 * HRV is stored as metric_type='hrv' with { qty | value | Avg } in value_json.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'

const RANGES = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
]

interface HrvRow {
  date: string
  value: number
  min?: number
  max?: number
}

function formatDate(s: string): string {
  try {
    const d = new Date(s + 'T12:00:00')
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch { return s }
}

export default function HrvHistoryScreen({ navigation }: { navigation: any }) {
  const insets = useSafeAreaInsets()
  const [days, setDays] = useState<number>(30)
  const [rows, setRows] = useState<HrvRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const db = await getDb()
      const raw = await db.getAllAsync(
        `SELECT date, value_json FROM health_metrics
         WHERE metric_type = 'hrv' AND date >= date('now', '-' || ? || ' days')
         ORDER BY date DESC`,
        days
      ) as Array<{ date: string; value_json: string }>
      const parsed: HrvRow[] = raw.map(r => {
        let v: any
        try { v = JSON.parse(r.value_json) } catch { v = {} }
        const value = Number(v.qty ?? v.value ?? v.Avg ?? 0)
        const min = v.min ? Math.round(Number(v.min) * 10) / 10 : undefined
        const max = v.max ? Math.round(Number(v.max) * 10) / 10 : undefined
        return { date: r.date, value, min, max }
      }).filter(r => r.value > 0 && r.value <= 300)
      setRows(parsed)
    } catch (err) {
      console.error('HRV history load error:', err)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [days])

  const stats = useMemo(() => {
    if (rows.length === 0) return null
    const values = rows.map(r => r.value)
    const avg = values.reduce((s, v) => s + v, 0) / values.length
    const max = Math.max(...values)
    const min = Math.min(...values)
    const recentN = Math.min(7, values.length)
    const recent = values.slice(0, recentN).reduce((s, v) => s + v, 0) / recentN
    const trend = recent - avg
    return { avg, max, min, recent, trend, count: values.length }
  }, [rows])

  const chartData = useMemo(() => [...rows].reverse(), [rows]) // oldest left
  const chartMax = useMemo(() => {
    if (chartData.length === 0) return 100
    return Math.max(...chartData.map(d => d.value)) * 1.15
  }, [chartData])

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>HRV History</Text>
        <TouchableOpacity onPress={load} style={styles.backBtn}>
          <Ionicons name="refresh" size={20} color={colors.text.primary} />
        </TouchableOpacity>
      </View>

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
          <NoodleSpinner color={colors.accent.cyan} size={32} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No HRV readings in the last {days} days. Apple Watch records HRV automatically — sync from desktop or open the Health app to backfill.
          </Text>
        </View>
      ) : (
        <>
          {stats && (
            <>
              <View style={styles.statsRow}>
                <StatBox label="Avg" value={`${stats.avg.toFixed(0)}`} unit="ms" color={colors.accent.cyan} />
                <StatBox label="Recent (7d)" value={`${stats.recent.toFixed(0)}`} unit="ms"
                  color={stats.trend >= 0 ? colors.accent.green : colors.accent.amber} />
                <StatBox label="Range" value={`${stats.min.toFixed(0)}–${stats.max.toFixed(0)}`} unit="ms" color={colors.accent.purple} />
              </View>

              <View style={[styles.card, { paddingVertical: spacing.sm }]}>
                <View style={styles.trendRow}>
                  <Ionicons
                    name={stats.trend > 2 ? 'trending-up' : stats.trend < -2 ? 'trending-down' : 'remove'}
                    size={18}
                    color={stats.trend > 2 ? colors.accent.green : stats.trend < -2 ? colors.accent.red : colors.accent.amber}
                  />
                  <Text style={styles.trendText}>
                    Last 7 days {stats.trend >= 0 ? '+' : ''}{stats.trend.toFixed(1)}ms vs {days}-day average
                  </Text>
                </View>
              </View>
            </>
          )}

          {/* Mini line chart */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Daily HRV</Text>
            <View style={styles.chart}>
              {chartData.map((d, i) => {
                const h = (d.value / chartMax) * 120
                return (
                  <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
                    <View style={{ width: '70%', height: h, backgroundColor: colors.accent.cyan, borderRadius: 2 }} />
                  </View>
                )
              })}
            </View>
            <View style={styles.chartXAxis}>
              <Text style={styles.chartLabel}>{formatDate(chartData[0]?.date || '')}</Text>
              <Text style={styles.chartLabel}>{formatDate(chartData[chartData.length - 1]?.date || '')}</Text>
            </View>
          </View>

          {/* Daily Log */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Daily Log ({rows.length})</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ minWidth: 340 }}>
                <View style={[styles.logRow, { borderBottomColor: colors.border }]}>
                  <Text style={[styles.logHeaderCell, { width: 80 }]}>Date</Text>
                  <Text style={[styles.logHeaderCell, { width: 64, textAlign: 'right' }]}>HRV (avg)</Text>
                  <Text style={[styles.logHeaderCell, { width: 52, textAlign: 'right' }]}>Min</Text>
                  <Text style={[styles.logHeaderCell, { width: 52, textAlign: 'right' }]}>Max</Text>
                  <Text style={[styles.logHeaderCell, { width: 68, textAlign: 'right' }]}>vs Baseline</Text>
                </View>
                {rows.map((r, i) => {
                  const diff = stats ? r.value - stats.avg : 0
                  return (
                    <View key={i} style={styles.logRow}>
                      <Text style={[styles.logCell, { width: 80, color: colors.text.primary }]}>{formatDate(r.date)}</Text>
                      <Text style={[styles.logCell, { width: 64, textAlign: 'right', color: colors.accent.cyan, fontWeight: '600' }]}>
                        {r.value.toFixed(0)}ms
                      </Text>
                      <Text style={[styles.logCell, { width: 52, textAlign: 'right' }]}>
                        {r.min != null ? r.min.toFixed(0) : '—'}
                      </Text>
                      <Text style={[styles.logCell, { width: 52, textAlign: 'right' }]}>
                        {r.max != null ? r.max.toFixed(0) : '—'}
                      </Text>
                      <Text style={[styles.logCell, { width: 68, textAlign: 'right', color: diff >= 0 ? colors.accent.green : colors.accent.red }]}>
                        {diff >= 0 ? '+' : ''}{diff.toFixed(1)}
                      </Text>
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

function StatBox({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <View style={[styles.statBox, { borderLeftColor: color }]}>
      <Text style={styles.statValue}>
        {value}<Text style={styles.statUnit}> {unit}</Text>
      </Text>
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
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg.tertiary, borderRadius: 8,
  },
  rangeRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md },
  rangeBtn: {
    flex: 1, paddingVertical: 8,
    backgroundColor: colors.bg.tertiary, borderRadius: 8, alignItems: 'center',
  },
  rangeBtnActive: { backgroundColor: colors.accent.cyan + '33' },
  rangeText: { fontSize: 12, fontWeight: '500', color: colors.text.muted },
  rangeTextActive: { color: colors.accent.cyan, fontWeight: '700' },
  center: { padding: spacing.xl, alignItems: 'center' },
  card: { backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.lg, marginBottom: spacing.md },
  cardLabel: { fontSize: 13, fontWeight: '600', color: colors.text.secondary, marginBottom: spacing.sm },
  emptyText: { fontSize: 14, color: colors.text.muted, textAlign: 'center', lineHeight: 20 },
  statsRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md },
  statBox: {
    flex: 1, backgroundColor: colors.bg.card,
    borderLeftWidth: 3, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: 8,
  },
  statValue: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  statUnit: { fontSize: 11, color: colors.text.muted, fontWeight: '400' },
  statLabel: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  trendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  trendText: { fontSize: 13, color: colors.text.secondary },
  chart: { flexDirection: 'row', height: 120, alignItems: 'flex-end', gap: 1, paddingTop: 12 },
  chartXAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  chartLabel: { fontSize: 10, color: colors.text.muted },
  logRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  logHeaderCell: { fontSize: 10, fontWeight: '600', color: colors.text.muted, textTransform: 'uppercase' },
  logCell: { fontSize: 13, color: colors.text.secondary },
})
