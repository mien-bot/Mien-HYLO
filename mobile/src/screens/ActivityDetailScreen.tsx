import React from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform, Linking } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../lib/theme'

interface WeekendActivity {
  time: string
  activity: string
  location: string
  travelTime: string
  rationale: string
  cost: string
}

export default function ActivityDetailScreen({ route, navigation }: any) {
  const { activity, dayLabel, dayColor } = route.params as {
    activity: WeekendActivity
    dayLabel: string
    dayColor: string
  }
  const insets = useSafeAreaInsets()

  const openInMaps = () => {
    if (!activity.location) return
    const q = encodeURIComponent(activity.location)
    const url = Platform.OS === 'ios'
      ? `maps:0,0?q=${q}`
      : `geo:0,0?q=${q}`
    Linking.openURL(url).catch(() => {
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`)
    })
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.accent.blue} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.dayBadge, { backgroundColor: dayColor + '22' }]}>
          <Text style={[styles.dayBadgeText, { color: dayColor }]}>{dayLabel}</Text>
        </View>

        <Text style={styles.title}>{activity.activity}</Text>

        {activity.time ? (
          <View style={styles.infoRow}>
            <Ionicons name="time-outline" size={18} color={colors.accent.blue} />
            <Text style={styles.infoText}>{activity.time}</Text>
          </View>
        ) : null}

        {activity.location ? (
          <TouchableOpacity style={styles.infoRow} onPress={openInMaps}>
            <Ionicons name="location-outline" size={18} color={colors.accent.red} />
            <Text style={[styles.infoText, { color: colors.accent.blue, textDecorationLine: 'underline' }]}>
              {activity.location}
            </Text>
          </TouchableOpacity>
        ) : null}

        {activity.travelTime ? (
          <View style={styles.infoRow}>
            <Ionicons name="car-outline" size={18} color={colors.accent.cyan} />
            <Text style={styles.infoText}>{activity.travelTime}</Text>
          </View>
        ) : null}

        {activity.cost ? (
          <View style={styles.infoRow}>
            <Ionicons name="cash-outline" size={18} color={colors.accent.green} />
            <Text style={styles.infoText}>{activity.cost}</Text>
          </View>
        ) : null}

        {activity.rationale ? (
          <View style={styles.rationaleCard}>
            <Text style={styles.rationaleLabel}>Why this?</Text>
            <Text style={styles.rationaleText}>{activity.rationale}</Text>
          </View>
        ) : null}

        {activity.location ? (
          <TouchableOpacity style={styles.mapsBtn} onPress={openInMaps}>
            <Ionicons name="navigate-outline" size={18} color="#fff" />
            <Text style={styles.mapsBtnText}>Open in Maps</Text>
          </TouchableOpacity>
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
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  dayBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
    marginBottom: spacing.md,
  },
  dayBadgeText: {
    fontSize: 13,
    fontWeight: '700',
  },
  title: {
    ...typography.largeTitle,
    color: colors.text.primary,
    marginBottom: spacing.lg,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
    paddingVertical: spacing.xs,
  },
  infoText: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },
  rationaleCard: {
    backgroundColor: colors.bg.card,
    borderRadius: 12,
    padding: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  rationaleLabel: {
    ...typography.caption,
    color: colors.text.muted,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rationaleText: {
    ...typography.body,
    color: colors.text.secondary,
    lineHeight: 22,
  },
  mapsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accent.blue,
    borderRadius: 12,
    paddingVertical: 14,
  },
  mapsBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
})
