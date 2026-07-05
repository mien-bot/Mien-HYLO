import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'
import { fullSyncFromRelay } from '../services/health-sync.service'

interface FinanceAlert {
  id: number
  symbol: string
  type: string
  threshold: number
  note: string | null
  active: number
  last_fired_at: string | null
  last_value: number | null
}

interface HealthAlert {
  id: number
  type: string
  threshold: number
  note: string | null
  active: number
  last_fired_at: string | null
  last_value: number | null
}

const FINANCE_LABEL: Record<string, string> = {
  price_above: 'Price ≥',
  price_below: 'Price ≤',
  rsi_above: 'RSI ≥',
  rsi_below: 'RSI ≤',
  ma_cross_above: '20/50 SMA ↑',
  ma_cross_below: '20/50 SMA ↓',
}

const HEALTH_LABEL: Record<string, string> = {
  hrv_below: 'HRV ≤',
  recovery_below: 'Recovery ≤',
  sleep_debt_above: 'Sleep debt ≥',
  training_load_above: 'Training load ≥',
}

const HEALTH_UNIT: Record<string, string> = {
  hrv_below: 'ms',
  recovery_below: '',
  sleep_debt_above: 'h',
  training_load_above: '',
}

export default function AlertsScreen() {
  const insets = useSafeAreaInsets()
  const [finance, setFinance] = useState<FinanceAlert[]>([])
  const [health, setHealth] = useState<HealthAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const db = await getDb()
      const fa = (await db.getAllAsync(
        `SELECT id, symbol, type, threshold, note, active, last_fired_at, last_value
         FROM alerts ORDER BY active DESC, created_at DESC`
      )) as FinanceAlert[]
      const ha = (await db.getAllAsync(
        `SELECT id, type, threshold, note, active, last_fired_at, last_value
         FROM health_alerts ORDER BY active DESC, created_at DESC`
      )) as HealthAlert[]
      setFinance(fa)
      setHealth(ha)
    } catch (err) {
      console.error('Failed to load alerts:', err)
    }
    setLoading(false)
  }, [])

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
      <Text style={styles.title}>Alerts</Text>
      <Text style={styles.hint}>
        Read-only mirror of desktop alerts. Create or edit on desktop.
      </Text>

      <Section title="Finance" empty={finance.length === 0}>
        {finance.map(a => (
          <AlertRow
            key={`f-${a.id}`}
            label={`${a.symbol} · ${FINANCE_LABEL[a.type] || a.type} ${formatNum(a.threshold)}`}
            note={a.note}
            active={!!a.active}
            firedAt={a.last_fired_at}
            value={a.last_value}
          />
        ))}
      </Section>

      <Section title="Health" empty={health.length === 0}>
        {health.map(a => (
          <AlertRow
            key={`h-${a.id}`}
            label={`${HEALTH_LABEL[a.type] || a.type} ${formatNum(a.threshold)}${HEALTH_UNIT[a.type] || ''}`}
            note={a.note}
            active={!!a.active}
            firedAt={a.last_fired_at}
            value={a.last_value}
          />
        ))}
      </Section>
    </ScrollView>
  )
}

function Section({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {empty ? (
        <Text style={styles.emptyText}>No {title.toLowerCase()} alerts.</Text>
      ) : (
        <View style={styles.list}>{children}</View>
      )}
    </View>
  )
}

function AlertRow({ label, note, active, firedAt, value }: {
  label: string
  note: string | null
  active: boolean
  firedAt: string | null
  value: number | null
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons
          name={active ? 'notifications' : 'notifications-off-outline'}
          size={16}
          color={active ? colors.accent.amber : colors.text.muted}
        />
      </View>
      <View style={styles.rowMain}>
        <Text style={[styles.rowLabel, !active && styles.rowLabelDim]}>{label}</Text>
        {note && <Text style={styles.rowNote}>{note}</Text>}
        {firedAt && (
          <Text style={styles.rowFired}>
            fired {formatFired(firedAt)}{value != null ? ` @ ${formatNum(value)}` : ''}
          </Text>
        )}
      </View>
    </View>
  )
}

function formatNum(n: number | null): string {
  if (n == null) return '—'
  if (Math.abs(n) >= 1000) return n.toFixed(0)
  if (Math.abs(n) >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function formatFired(s: string): string {
  try {
    return new Date(s + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return s }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, paddingHorizontal: spacing.md },
  center: { alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.xs },
  hint: { fontSize: 12, color: colors.text.muted, marginBottom: spacing.md },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5,
    color: colors.text.muted, marginBottom: spacing.sm,
  },
  list: { backgroundColor: colors.bg.secondary, borderRadius: 12, overflow: 'hidden' },
  emptyText: { fontSize: 12, color: colors.text.muted, padding: spacing.sm },
  row: {
    flexDirection: 'row',
    padding: spacing.sm,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  rowIcon: { width: 20, alignItems: 'center', paddingTop: 2 },
  rowMain: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 14, color: colors.text.primary, fontWeight: '500' },
  rowLabelDim: { color: colors.text.muted },
  rowNote: { fontSize: 12, color: colors.text.muted },
  rowFired: { fontSize: 11, color: colors.accent.amber },
})
