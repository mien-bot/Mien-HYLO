import { useEffect, useRef, useState } from 'react'
import { useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'

/**
 * Spring press-scale for buttons/cards. Returns a shared value to drive an
 * animated style plus onPressIn/onPressOut handlers.
 */
export function usePressScale(to = 0.96) {
  const scale = useSharedValue(1)
  const onPressIn = () => {
    scale.value = withSpring(to, { damping: 15, stiffness: 320 })
  }
  const onPressOut = () => {
    scale.value = withSpring(1, { damping: 12, stiffness: 260 })
  }
  return { scale, onPressIn, onPressOut }
}

/**
 * Animates a numeric value toward `target` with an ease-out curve, returning the
 * formatted in-flight number. Snaps immediately when `enabled` is false (calm mode).
 */
export function useCountUp(
  target: number,
  { duration = 800, decimals = 0, enabled = true }: { duration?: number; decimals?: number; enabled?: boolean } = {},
): string {
  const [display, setDisplay] = useState(target)
  const fromRef = useRef(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !Number.isFinite(target)) {
      setDisplay(target)
      fromRef.current = target
      return
    }
    const from = fromRef.current
    const delta = target - from
    if (delta === 0) return
    const start = Date.now()
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(from + delta * eased)
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      fromRef.current = target
    }
  }, [target, duration, enabled])

  return display.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

type HapticKind = 'light' | 'medium' | 'success' | 'selection'

/** Fire a haptic. Best-effort — silently no-ops if unsupported. */
export function haptic(kind: HapticKind = 'light') {
  try {
    if (kind === 'selection') {
      Haptics.selectionAsync()
    } else if (kind === 'success') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    } else {
      Haptics.impactAsync(
        kind === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
      )
    }
  } catch {}
}
