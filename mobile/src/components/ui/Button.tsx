import React from 'react'
import { Text, Pressable, StyleSheet, ViewStyle, TextStyle } from 'react-native'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { colors, radius, spacing, fonts } from '../../lib/theme'
import { useTheme } from '../../lib/ThemeContext'
import { usePressScale, haptic } from '../../lib/motion'

type Variant = 'primary' | 'secondary' | 'ghost'

interface ButtonProps {
  label: string
  onPress: () => void
  variant?: Variant
  style?: ViewStyle
  textStyle?: TextStyle
  disabled?: boolean
}

/** Themed pill button with spring press-feedback + light haptic. */
export default function Button({ label, onPress, variant = 'primary', style, textStyle, disabled }: ButtonProps) {
  const { accent, accentSoft } = useTheme()
  const { scale, onPressIn, onPressOut } = usePressScale()
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))

  const bg =
    variant === 'primary' ? accent : variant === 'secondary' ? accentSoft : 'transparent'
  const fg = variant === 'primary' ? '#fff' : accent

  return (
    <Animated.View style={[animStyle, style]}>
      <Pressable
        onPress={() => {
          if (disabled) return
          haptic('light')
          onPress()
        }}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={disabled}
        style={[styles.base, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }]}
      >
        <Text style={[styles.label, { color: fg }, textStyle]}>{label}</Text>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontFamily: fonts.displaySemi,
    fontSize: 14,
    fontWeight: '700',
  },
})

// Re-export so callers can theme around the same neutral tokens.
export { colors }
