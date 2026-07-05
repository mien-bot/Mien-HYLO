/**
 * Exercise History — multi-tab fitness dashboard.
 * Tabs: Overview | Training Science | Activity Log
 *
 * Workouts stored as health_metrics rows: metric_type='workout',
 * value_json = { workouts: [{ name, duration, calories, distance, start, end }] }.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'
import { syncFromRelay } from '../services/health-sync.service'

const RANGES = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
]

type Tab = 'overview' | 'training' | 'log'

interface Workout {
  date: string
  name: string
  duration: number // minutes
  calories: number
  distance: number // miles
  start: string | null
  end: string | null
}

interface DailyLoad {
  date: string
  trimp: number // Training Impulse — approximated from duration × intensity
}

function formatDate(s: string): string {
  try {
    const d = new Date(s + 'T12:00:00')
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch { return s }
}

function activityIcon(name: string): keyof typeof Ionicons.glyphMap {
  const n = name.toLowerCase()
  if (n.includes('run')) return 'walk'
  if (n.includes('cycl') || n.includes('bike')) return 'bicycle'
  if (n.includes('swim')) return 'water'
  if (n.includes('walk')) return 'walk'
  if (n.includes('yoga') || n.includes('stretch')) return 'body'
  if (n.includes('strength') || n.includes('weight') || n.includes('lift')) return 'barbell'
  if (n.includes('hike')) return 'trail-sign'
  return 'fitness'
}

// Estimate TRIMP from duration + calories (simplified Banister model)
function estimateTrimp(workout: Workout): number {
  // Use calories if available (better proxy for intensity), otherwise duration-based
  if (workout.calories > 0) {
    return workout.calories / 5 // ~1 TRIMP per 5 kcal
  }
  // Duration-based estimate with activity type multiplier
  const n = workout.name.toLowerCase()
  let intensity = 1.0
  if (n.includes('run') || n.includes('hiit')) intensity = 1.5
  if (n.includes('cycl') || n.includes('swim')) intensity = 1.3
  if (n.includes('walk') || n.includes('yoga')) intensity = 0.6
  if (n.includes('strength') || n.includes('weight')) intensity = 1.2
  return workout.duration * intensity
}

// Exponentially weighted moving average for CTL/ATL
function ewma(dailyLoads: DailyLoad[], tau: number): number {
  if (dailyLoads.length === 0) return 0
  let value = 0
  const alpha = 1 - Math.exp(-1 / tau)
  for (const d of dailyLoads) {
    value = value * (1 - alpha) + d.trimp * alpha
  }
  return value
}

export default function ExerciseHistoryScreen({ navigation }: { navigation: any }) {
  const insets = useSafeAreaInsets()
  const [days, setDays] = useState<number>(90)
  const [workouts, setWorkouts] = useState<Workout[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  const handleSync = async () => {
    setSyncing(true)
    try {
      const result = await syncFromRelay(days)
      if (result.success) {
        await load()
        Alert.alert('Synced', `Pulled ${result.count || 0} health records from server`)
      } else {
        Alert.alert('Sync Failed', result.error || 'Unknown error')
      }
    } catch (err: any) {
      Alert.alert('Sync Failed', err.message || 'Connection error')
    }
    setSyncing(false)
  }

  const load = async () => {
    setLoading(true)
    try {
      const db = await getDb()
      const raw = await db.getAllAsync(
        `SELECT date, value_json FROM health_metrics
         WHERE metric_type = 'workout' AND date >= date('now', '-' || ? || ' days')
         ORDER BY date DESC`,
        days
      ) as Array<{ date: string; value_json: string }>
      const list: Workout[] = []
      for (const r of raw) {
        let v: any
        try { v = JSON.parse(r.value_json) } catch { continue }
        const arr = Array.isArray(v?.workouts) ? v.workouts : []
        for (const w of arr) {
          list.push({
            date: r.date,
            name: String(w.name || 'Workout'),
            duration: Number(w.duration) || 0,
            calories: Number(w.calories) || 0,
            distance: Number(w.distance) || 0,
            start: w.start || null,
            end: w.end || null,
          })
        }
      }
      setWorkouts(list)
    } catch (err) {
      console.error('Exercise history load error:', err)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [days])

  const stats = useMemo(() => {
    if (workouts.length === 0) return null
    const totalDur = workouts.reduce((s, w) => s + w.duration, 0)
    const totalCals = workouts.reduce((s, w) => s + w.calories, 0)
    const totalMi = workouts.reduce((s, w) => s + w.distance, 0)
    const uniqueDays = new Set(workouts.map(w => w.date)).size
    return {
      count: workouts.length,
      uniqueDays,
      totalDur,
      totalCals,
      totalMi,
      avgPerWeek: (workouts.length / days) * 7,
    }
  }, [workouts, days])

  // Group workouts by activity name for the breakdown card
  const byActivity = useMemo(() => {
    const map = new Map<string, { count: number; duration: number; calories: number }>()
    for (const w of workouts) {
      const cur = map.get(w.name) || { count: 0, duration: 0, calories: 0 }
      cur.count += 1
      cur.duration += w.duration
      cur.calories += w.calories
      map.set(w.name, cur)
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.duration - a.duration)
  }, [workouts])

  // Training science calculations (CTL, ATL, TSB, ACWR)
  const training = useMemo(() => {
    if (workouts.length === 0) return null

    // Build daily load array (sorted oldest first)
    const dailyMap = new Map<string, number>()
    for (const w of workouts) {
      const trimp = estimateTrimp(w)
      dailyMap.set(w.date, (dailyMap.get(w.date) || 0) + trimp)
    }

    // Fill in zero days
    const allDates: string[] = []
    const today = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      allDates.push(d.toISOString().split('T')[0])
    }

    const dailyLoads: DailyLoad[] = allDates.map(date => ({
      date,
      trimp: dailyMap.get(date) || 0,
    }))

    // CTL (Chronic Training Load) — 42-day time constant
    const ctl = ewma(dailyLoads, 42)
    // ATL (Acute Training Load) — 7-day time constant
    const atl = ewma(dailyLoads, 7)
    // TSB (Training Stress Balance) = CTL - ATL
    const tsb = ctl - atl
    // ACWR (Acute:Chronic Workload Ratio)
    const acwr = ctl > 0 ? atl / ctl : 0

    // Training status based on TSB and ACWR
    let status: string
    let statusColor: string
    if (ctl < 10) {
      status = 'Detraining'
      statusColor = colors.text.muted
    } else if (tsb > 15) {
      status = 'Peaking'
      statusColor = colors.accent.green
    } else if (tsb > 0) {
      status = 'Fresh'
      statusColor = colors.accent.blue
    } else if (tsb > -15) {
      status = 'Productive'
      statusColor = colors.accent.amber
    } else if (acwr > 1.5) {
      status = 'Overreaching'
      statusColor = colors.accent.red
    } else {
      status = 'Building'
      statusColor = colors.accent.purple
    }

    // ACWR risk zone
    let acwrRisk: string
    let acwrColor: string
    if (acwr < 0.8) {
      acwrRisk = 'Undertraining'
      acwrColor = colors.text.muted
    } else if (acwr <= 1.3) {
      acwrRisk = 'Sweet Spot'
      acwrColor = colors.accent.green
    } else if (acwr <= 1.5) {
      acwrRisk = 'Caution'
      acwrColor = colors.accent.amber
    } else {
      acwrRisk = 'High Risk'
      acwrColor = colors.accent.red
    }

    // Weekly load trend (last 4 weeks)
    const weeklyLoads: number[] = []
    for (let w = 0; w < 4; w++) {
      const start = dailyLoads.length - (w + 1) * 7
      const end = dailyLoads.length - w * 7
      const weekSlice = dailyLoads.slice(Math.max(0, start), end)
      weeklyLoads.unshift(weekSlice.reduce((s, d) => s + d.trimp, 0))
    }

    return { ctl, atl, tsb, acwr, status, statusColor, acwrRisk, acwrColor, weeklyLoads }
  }, [workouts, days])

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>Fitness</Text>
        <TouchableOpacity onPress={handleSync} disabled={syncing} style={[styles.backBtn, { opacity: syncing ? 0.5 : 1 }]}>
          <Ionicons name="cloud-download-outline" size={20} color="#fc4c02" />
        </TouchableOpacity>
        <TouchableOpacity onPress={load} style={styles.backBtn}>
          <Ionicons name="refresh" size={20} color={colors.text.primary} />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {([['overview', 'Overview'], ['training', 'Training'], ['log', 'Activity Log']] as [Tab, string][]).map(([key, label]) => (
          <TouchableOpacity
            key={key}
            style={[styles.tabBtn, activeTab === key && styles.tabBtnActive]}
            onPress={() => setActiveTab(key)}
          >
            <Text style={[styles.tabText, activeTab === key && styles.tabTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
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
        <View style={styles.center}><NoodleSpinner color={colors.accent.green} size={32} /></View>
      ) : workouts.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No workouts in the last {days} days. Tap the orange cloud icon to sync Strava workouts from your server.
          </Text>
        </View>
      ) : (
        <>
          {/* OVERVIEW TAB */}
          {activeTab === 'overview' && (
            <>
              {stats && (
                <View style={styles.statsRow}>
                  <StatBox label="Workouts" value={String(stats.count)} unit="" color={colors.accent.green} />
                  <StatBox label="Time" value={String(Math.round(stats.totalDur))} unit="min" color={colors.accent.blue} />
                  <StatBox label="Calories" value={String(Math.round(stats.totalCals))} unit="kcal" color={colors.accent.amber} />
                  <StatBox label="/Week" value={stats.avgPerWeek.toFixed(1)} unit="" color={colors.accent.purple} />
                </View>
              )}

              {byActivity.length > 1 && (
                <View style={styles.card}>
                  <Text style={styles.cardLabel}>Activity Breakdown</Text>
                  {byActivity.slice(0, 8).map((a, i) => (
                    <View key={i} style={styles.breakdownRow}>
                      <Ionicons name={activityIcon(a.name)} size={16} color={colors.accent.green} style={{ marginRight: spacing.sm }} />
                      <Text style={styles.breakdownName}>{a.name}</Text>
                      <Text style={styles.breakdownStat}>
                        {a.count}× · {Math.round(a.duration)}min · {Math.round(a.calories)}kcal
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Training status badge */}
              {training && (
                <View style={styles.card}>
                  <Text style={styles.cardLabel}>Training Status</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                    <View style={[styles.statusBadge, { backgroundColor: training.statusColor + '22' }]}>
                      <Text style={[styles.statusText, { color: training.statusColor }]}>{training.status}</Text>
                    </View>
                    <Text style={styles.tsbLabel}>Form: {training.tsb > 0 ? '+' : ''}{training.tsb.toFixed(0)}</Text>
                  </View>
                </View>
              )}
            </>
          )}

          {/* TRAINING SCIENCE TAB */}
          {activeTab === 'training' && training && (
            <>
              {/* CTL / ATL / TSB */}
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Training Load Model</Text>
                <Text style={styles.modelDesc}>Banister Impulse-Response (CTL τ=42d, ATL τ=7d)</Text>

                <View style={styles.loadRow}>
                  <View style={styles.loadItem}>
                    <Text style={styles.loadValue}>{training.ctl.toFixed(0)}</Text>
                    <Text style={styles.loadLabel}>Fitness (CTL)</Text>
                  </View>
                  <View style={styles.loadItem}>
                    <Text style={styles.loadValue}>{training.atl.toFixed(0)}</Text>
                    <Text style={styles.loadLabel}>Fatigue (ATL)</Text>
                  </View>
                  <View style={styles.loadItem}>
                    <Text style={[styles.loadValue, { color: training.tsb >= 0 ? colors.accent.green : colors.accent.red }]}>
                      {training.tsb > 0 ? '+' : ''}{training.tsb.toFixed(0)}
                    </Text>
                    <Text style={styles.loadLabel}>Form (TSB)</Text>
                  </View>
                </View>
              </View>

              {/* Training Status */}
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Status</Text>
                <View style={[styles.statusBadgeLg, { backgroundColor: training.statusColor + '22' }]}>
                  <Text style={[styles.statusTextLg, { color: training.statusColor }]}>{training.status}</Text>
                </View>
                <Text style={styles.statusExplain}>
                  {training.status === 'Detraining' && 'Training load is very low. Increase volume gradually.'}
                  {training.status === 'Peaking' && 'High fitness with low fatigue. Ideal for events or PRs.'}
                  {training.status === 'Fresh' && 'Good recovery. Ready for harder sessions.'}
                  {training.status === 'Productive' && 'Building fitness with manageable fatigue.'}
                  {training.status === 'Overreaching' && 'High acute load vs chronic. Risk of injury — schedule rest.'}
                  {training.status === 'Building' && 'Fatigue accumulating but within bounds. Good training block.'}
                </Text>
              </View>

              {/* ACWR */}
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Acute:Chronic Workload Ratio</Text>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
                  <Text style={[styles.acwrValue, { color: training.acwrColor }]}>
                    {training.acwr.toFixed(2)}
                  </Text>
                  <View style={[styles.statusBadge, { backgroundColor: training.acwrColor + '22' }]}>
                    <Text style={[styles.statusText, { color: training.acwrColor }]}>{training.acwrRisk}</Text>
                  </View>
                </View>
                <Text style={styles.acwrScale}>
                  {'<0.8 Undertraining  |  0.8-1.3 Sweet Spot  |  1.3-1.5 Caution  |  >1.5 Injury Risk'}
                </Text>
              </View>

              {/* Weekly Load Trend */}
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Weekly Load (last 4 weeks)</Text>
                <View style={styles.weeklyRow}>
                  {training.weeklyLoads.map((load, i) => {
                    const maxLoad = Math.max(...training.weeklyLoads, 1)
                    const height = Math.max(4, (load / maxLoad) * 60)
                    return (
                      <View key={i} style={styles.weeklyCol}>
                        <View style={[styles.weeklyBar, { height, backgroundColor: colors.accent.green + '88' }]} />
                        <Text style={styles.weeklyLabel}>{Math.round(load)}</Text>
                        <Text style={styles.weeklyWeek}>W{i + 1}</Text>
                      </View>
                    )
                  })}
                </View>
              </View>
            </>
          )}

          {/* ACTIVITY LOG TAB */}
          {activeTab === 'log' && (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>All Workouts ({workouts.length})</Text>
              {workouts.map((w, i) => (
                <View key={i} style={styles.workoutRow}>
                  <View style={styles.workoutIcon}>
                    <Ionicons name={activityIcon(w.name)} size={18} color={colors.accent.green} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.workoutName}>{w.name}</Text>
                    <Text style={styles.workoutMeta}>
                      {formatDate(w.date)}  ·  {w.duration}min{w.distance > 0 ? `  ·  ${w.distance.toFixed(1)}mi` : ''}{w.calories > 0 ? `  ·  ${w.calories}kcal` : ''}
                    </Text>
                  </View>
                  <Text style={styles.trimpBadge}>{estimateTrimp(w).toFixed(0)} TRIMP</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  )
}

function StatBox({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <View style={[styles.statBox, { borderLeftColor: color }]}>
      <Text style={styles.statValue}>
        {value}{unit ? <Text style={styles.statUnit}> {unit}</Text> : null}
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
  // Tabs
  tabRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md },
  tabBtn: {
    flex: 1, paddingVertical: 10,
    backgroundColor: colors.bg.tertiary, borderRadius: 10, alignItems: 'center',
  },
  tabBtnActive: { backgroundColor: colors.accent.green + '33' },
  tabText: { fontSize: 12, fontWeight: '500', color: colors.text.muted },
  tabTextActive: { color: colors.accent.green, fontWeight: '700' },
  // Range
  rangeRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md },
  rangeBtn: {
    flex: 1, paddingVertical: 8,
    backgroundColor: colors.bg.tertiary, borderRadius: 8, alignItems: 'center',
  },
  rangeBtnActive: { backgroundColor: colors.accent.green + '33' },
  rangeText: { fontSize: 12, fontWeight: '500', color: colors.text.muted },
  rangeTextActive: { color: colors.accent.green, fontWeight: '700' },
  center: { padding: spacing.xl, alignItems: 'center' },
  card: { backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.lg, marginBottom: spacing.md },
  cardLabel: { fontSize: 13, fontWeight: '600', color: colors.text.secondary, marginBottom: spacing.sm },
  emptyText: { fontSize: 14, color: colors.text.muted, textAlign: 'center', lineHeight: 20 },
  statsRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md, flexWrap: 'wrap' },
  statBox: {
    flex: 1, minWidth: '22%', backgroundColor: colors.bg.card,
    borderLeftWidth: 3, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: 8,
  },
  statValue: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  statUnit: { fontSize: 11, color: colors.text.muted, fontWeight: '400' },
  statLabel: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  breakdownName: { flex: 1, fontSize: 13, color: colors.text.primary },
  breakdownStat: { fontSize: 11, color: colors.text.muted },
  workoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  workoutIcon: {
    width: 36, height: 36,
    backgroundColor: colors.accent.green + '15',
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  workoutName: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
  workoutMeta: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  // Training science styles
  statusBadge: {
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12,
  },
  statusText: { fontSize: 12, fontWeight: '700' },
  statusBadgeLg: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12, alignSelf: 'flex-start',
  },
  statusTextLg: { fontSize: 16, fontWeight: '800' },
  statusExplain: { fontSize: 13, color: colors.text.muted, marginTop: spacing.sm, lineHeight: 18 },
  tsbLabel: { fontSize: 13, color: colors.text.muted },
  modelDesc: { fontSize: 11, color: colors.text.muted, marginBottom: spacing.md },
  loadRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: spacing.sm },
  loadItem: { alignItems: 'center' },
  loadValue: { fontSize: 24, fontWeight: '800', color: colors.text.primary },
  loadLabel: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  acwrValue: { fontSize: 28, fontWeight: '800' },
  acwrScale: { fontSize: 10, color: colors.text.muted, marginTop: spacing.sm },
  weeklyRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end', height: 80, marginTop: spacing.sm },
  weeklyCol: { alignItems: 'center', flex: 1 },
  weeklyBar: { width: 24, borderRadius: 4 },
  weeklyLabel: { fontSize: 10, color: colors.text.muted, marginTop: 4 },
  weeklyWeek: { fontSize: 10, color: colors.text.secondary, fontWeight: '600' },
  trimpBadge: { fontSize: 10, color: colors.accent.amber, fontWeight: '600' },
})
