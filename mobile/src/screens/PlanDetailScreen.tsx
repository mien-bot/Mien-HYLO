import React, { useEffect, useState } from 'react'
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform, Alert
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { listDatabases, pushWeekendToNotion } from '../services/notion.service'
import { getSettings } from '../lib/storage'
import PlanMapView from '../components/PlanMapView'

interface WeekendActivity {
  time: string
  activity: string
  location: string
  travelTime: string
  rationale: string
  cost: string
}

export default function PlanDetailScreen({ route, navigation }: any) {
  const { plan: savedPlan } = route.params as {
    plan: { weekend_date: string; plan_json: string; ai_rationale: string | null }
  }
  const insets = useSafeAreaInsets()
  const [pushing, setPushing] = React.useState(false)
  const [showMap, setShowMap] = useState(false)
  const [googleApiKey, setGoogleApiKey] = useState('')
  const [city, setCity] = useState('')

  useEffect(() => {
    getSettings()
      .then(s => {
        setGoogleApiKey(s.googlePlacesKey || '')
        setCity(s.weekendCity || '')
      })
      .catch(err => console.warn('[PlanDetail] Failed to load Google Places key:', err))
  }, [])

  let parsed: { saturday?: WeekendActivity[]; sunday?: WeekendActivity[]; [key: string]: any } | null = null
  try { parsed = JSON.parse(savedPlan.plan_json) } catch {}

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr + 'T12:00:00')
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  }

  const handleNotion = async () => {
    setPushing(true)
    try {
      const dbs = await listDatabases()
      if (dbs.length === 0) {
        Alert.alert('No Databases', 'No Notion databases found.')
        setPushing(false)
        return
      }
      if (dbs.length === 1) {
        const count = await pushWeekendToNotion(dbs[0].id, savedPlan.plan_json, savedPlan.weekend_date)
        Alert.alert('Sent!', `${count} activities added to Notion.`)
      } else {
        Alert.alert('Pick Database', undefined, [
          ...dbs.slice(0, 5).map(db => ({
            text: db.title,
            onPress: async () => {
              const count = await pushWeekendToNotion(db.id, savedPlan.plan_json, savedPlan.weekend_date)
              Alert.alert('Sent!', `${count} activities added to Notion.`)
            }
          })),
          { text: 'Cancel', style: 'cancel' as const }
        ])
      }
    } catch (err: any) {
      Alert.alert('Error', err.message)
    }
    setPushing(false)
  }

  const dayEntries = parsed ? Object.entries(parsed).filter(
    ([_, v]) => Array.isArray(v) && v.length > 0
  ) : []

  const dayColors: Record<string, string> = {
    monday: colors.accent.blue,
    tuesday: colors.accent.purple,
    wednesday: colors.accent.green,
    thursday: colors.accent.amber,
    friday: colors.accent.cyan,
    saturday: colors.accent.cyan,
    sunday: colors.accent.purple,
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.accent.blue} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TouchableOpacity
            onPress={() => setShowMap(v => !v)}
            style={[styles.mapToggleBtn, showMap && styles.mapToggleBtnActive]}
          >
            <Ionicons
              name={showMap ? 'list-outline' : 'map-outline'}
              size={16}
              color={showMap ? '#fff' : colors.accent.blue}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleNotion} disabled={pushing} style={styles.notionBtn}>
            {pushing ? (
              <NoodleSpinner size={16} color="#fff" />
            ) : (
              <>
                <Ionicons name="send" size={14} color="#fff" />
                <Text style={styles.notionBtnText}>Notion</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{formatDate(savedPlan.weekend_date)}</Text>

        {showMap && (
          <PlanMapView
            activities={dayEntries.flatMap(([, acts]) => acts as WeekendActivity[])}
            apiKey={googleApiKey}
            city={city}
            height={320}
          />
        )}

        {dayEntries.map(([day, activities]) => (
          <View key={day} style={styles.dayCard}>
            <Text style={[styles.dayLabel, { color: dayColors[day.toLowerCase()] || colors.accent.blue }]}>
              {day.charAt(0).toUpperCase() + day.slice(1)}
            </Text>
            {(activities as WeekendActivity[]).map((act, i) => (
              <TouchableOpacity
                key={i}
                style={styles.activityRow}
                onPress={() => navigation.navigate('ActivityDetail', {
                  activity: act,
                  dayLabel: day.charAt(0).toUpperCase() + day.slice(1),
                  dayColor: dayColors[day.toLowerCase()] || colors.accent.blue,
                })}
                activeOpacity={0.6}
              >
                <Text style={styles.activityTime}>{act.time}</Text>
                <View style={styles.activityBody}>
                  <Text style={styles.activityName}>{act.activity}</Text>
                  {act.location ? <Text style={styles.activityMeta}>{act.location}</Text> : null}
                  <View style={styles.activityTags}>
                    {act.travelTime ? <Text style={styles.tag}>{act.travelTime}</Text> : null}
                    {act.cost ? <Text style={styles.tag}>{act.cost}</Text> : null}
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.text.muted} />
              </TouchableOpacity>
            ))}
          </View>
        ))}

        {savedPlan.ai_rationale ? (
          <View style={styles.dayCard}>
            <Text style={[styles.dayLabel, { color: colors.text.secondary }]}>Notes</Text>
            <Text style={styles.notesText}>{savedPlan.ai_rationale}</Text>
          </View>
        ) : null}
      </ScrollView>
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
  },
  backText: {
    ...typography.body,
    color: colors.accent.blue,
  },
  notionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bg.tertiary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  notionBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  title: {
    ...typography.title,
    color: colors.text.primary,
    marginBottom: spacing.lg,
  },
  dayCard: {
    backgroundColor: colors.bg.card,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  dayLabel: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  activityTime: {
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: colors.accent.blue,
    width: 85,
    paddingTop: 2,
  },
  activityBody: {
    flex: 1,
  },
  activityName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 2,
  },
  activityMeta: {
    fontSize: 13,
    color: colors.text.muted,
    marginBottom: 4,
  },
  activityTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: 4,
  },
  tag: {
    fontSize: 11,
    color: colors.text.muted,
    backgroundColor: colors.bg.primary,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  notesText: {
    ...typography.body,
    color: colors.text.secondary,
    lineHeight: 22,
  },
  mapToggleBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.bg.tertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapToggleBtnActive: {
    backgroundColor: colors.accent.blue,
  },
})
