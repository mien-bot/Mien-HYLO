import React, { useState, useEffect } from 'react'
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  Alert
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'
import { listDatabases, pushWeekendToNotion, type NotionDatabase } from '../services/notion.service'

interface SavedPlan {
  id: number
  weekend_date: string
  plan_json: string
  ai_rationale: string | null
  created_at: string
}

interface ParsedPlan {
  saturday?: Array<{ time: string; activity: string; location: string }>
  sunday?: Array<{ time: string; activity: string; location: string }>
  [key: string]: any
}

export default function SavedPlansScreen({ navigation }: any) {
  const [plans, setPlans] = useState<SavedPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [pushingId, setPushingId] = useState<number | null>(null)
  const insets = useSafeAreaInsets()

  useEffect(() => { loadPlans() }, [])

  const loadPlans = async () => {
    try {
      const db = await getDb()
      const rows = await db.getAllAsync(
        'SELECT * FROM weekend_plans ORDER BY weekend_date DESC'
      ) as SavedPlan[]
      setPlans(rows)
    } catch {}
    setLoading(false)
  }

  const handleDelete = (plan: SavedPlan) => {
    Alert.alert('Delete Plan', `Delete plan for ${formatDate(plan.weekend_date)}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          const db = await getDb()
          await db.runAsync('DELETE FROM weekend_plans WHERE id = ?', plan.id)
          setPlans(prev => prev.filter(p => p.id !== plan.id))
        }
      }
    ])
  }

  const handleNotion = async (plan: SavedPlan) => {
    setPushingId(plan.id)
    try {
      const dbs = await listDatabases()
      if (dbs.length === 0) {
        Alert.alert('No Databases', 'No Notion databases found. Check your token and permissions.')
        setPushingId(null)
        return
      }
      // If only one database, push directly
      if (dbs.length === 1) {
        const count = await pushWeekendToNotion(dbs[0].id, plan.plan_json, plan.weekend_date)
        Alert.alert('Sent!', `${count} activities added to Notion.`)
      } else {
        // Show picker
        Alert.alert(
          'Pick Database',
          undefined,
          [
            ...dbs.slice(0, 5).map(db => ({
              text: db.title,
              onPress: async () => {
                const count = await pushWeekendToNotion(db.id, plan.plan_json, plan.weekend_date)
                Alert.alert('Sent!', `${count} activities added to Notion.`)
              }
            })),
            { text: 'Cancel', style: 'cancel' as const }
          ]
        )
      }
    } catch (err: any) {
      Alert.alert('Error', err.message)
    }
    setPushingId(null)
  }

  const parsePlan = (json: string): ParsedPlan | null => {
    try { return JSON.parse(json) } catch { return null }
  }

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr + 'T12:00:00')
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  const getDayCount = (parsed: ParsedPlan): number => {
    return Object.keys(parsed).filter(k =>
      Array.isArray(parsed[k]) && parsed[k].length > 0
    ).length
  }

  const getActivityCount = (parsed: ParsedPlan): number => {
    return Object.values(parsed)
      .filter(v => Array.isArray(v))
      .reduce((sum, arr) => sum + arr.length, 0)
  }

  const renderPlan = ({ item }: { item: SavedPlan }) => {
    const parsed = parsePlan(item.plan_json)
    if (!parsed) return null

    const dayCount = getDayCount(parsed)
    const activityCount = getActivityCount(parsed)

    return (
      <TouchableOpacity
        style={styles.planCard}
        onPress={() => navigation.navigate('PlanDetail', { plan: item })}
        activeOpacity={0.7}
      >
        <View style={styles.planHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.planDate}>{formatDate(item.weekend_date)}</Text>
            <Text style={styles.planMeta}>
              {dayCount} day{dayCount !== 1 ? 's' : ''} — {activityCount} activities
            </Text>
          </View>
          <View style={styles.planActions}>
            <TouchableOpacity
              onPress={() => handleNotion(item)}
              disabled={pushingId === item.id}
              style={styles.actionBtn}
            >
              {pushingId === item.id ? (
                <NoodleSpinner size={18} color={colors.accent.cyan} />
              ) : (
                <Ionicons name="send-outline" size={18} color={colors.accent.cyan} />
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleDelete(item)} style={styles.actionBtn}>
              <Ionicons name="trash-outline" size={18} color={colors.accent.red} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Preview first 2 activities */}
        {parsed.saturday?.slice(0, 1).map((act, i) => (
          <Text key={`s${i}`} style={styles.previewText} numberOfLines={1}>
            {act.time} — {act.activity}
          </Text>
        ))}
        {parsed.sunday?.slice(0, 1).map((act, i) => (
          <Text key={`u${i}`} style={styles.previewText} numberOfLines={1}>
            {act.time} — {act.activity}
          </Text>
        ))}
        {activityCount > 2 && (
          <Text style={styles.moreText}>+{activityCount - 2} more</Text>
        )}
      </TouchableOpacity>
    )
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.accent.blue} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Saved Plans</Text>
        <View style={{ width: 60 }} />
      </View>

      {loading ? (
        <View style={{ marginTop: 40, alignItems: 'center' }}>
          <NoodleSpinner color={colors.accent.blue} size={32} />
        </View>
      ) : plans.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="calendar-outline" size={48} color={colors.text.muted} />
          <Text style={styles.emptyText}>No saved plans yet</Text>
        </View>
      ) : (
        <FlatList
          data={plans}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderPlan}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: 60,
  },
  backText: {
    ...typography.body,
    color: colors.accent.blue,
  },
  headerTitle: {
    ...typography.headline,
    color: colors.text.primary,
  },
  planCard: {
    backgroundColor: colors.bg.card,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  planDate: {
    ...typography.headline,
    color: colors.text.primary,
  },
  planMeta: {
    ...typography.caption,
    color: colors.text.muted,
    marginTop: 2,
  },
  planActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionBtn: {
    padding: 6,
  },
  previewText: {
    ...typography.callout,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  moreText: {
    ...typography.caption,
    color: colors.text.muted,
    marginTop: 2,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  emptyText: {
    ...typography.body,
    color: colors.text.muted,
  },
})
