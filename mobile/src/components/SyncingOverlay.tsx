import React from 'react'
import { StyleSheet, Text, View, type ViewStyle } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import { colors, spacing, typography } from '../lib/theme'
import NoodleSpinner from './anim/NoodleSpinner'

interface Props {
  label?: string
  style?: ViewStyle
}

export default function SyncingOverlay({ label = 'Syncing data', style }: Props) {
  return (
    <Animated.View
      entering={FadeIn.duration(140)}
      exiting={FadeOut.duration(220)}
      style={[styles.overlay, style]}
      pointerEvents="none"
    >
      <View style={styles.panel}>
        <NoodleSpinner size={48} color={colors.text.primary} variant="inside" />
        <Text style={styles.label}>{label}</Text>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 900,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  panel: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    minWidth: 168,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderRadius: 16,
    backgroundColor: colors.bg.secondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    ...typography.callout,
    color: colors.text.secondary,
    fontWeight: '600',
  },
})
