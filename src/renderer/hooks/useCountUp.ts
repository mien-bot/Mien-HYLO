import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/theme'

interface CountUpOptions {
  /** Animation duration in ms. */
  duration?: number
  /** Decimal places to render. */
  decimals?: number
}

/**
 * Animates a numeric value toward `target` with an ease-out curve, returning the
 * formatted in-flight number. Honors calm-mode / OS reduced-motion by snapping
 * straight to the target.
 */
export function useCountUp(target: number, { duration = 800, decimals = 0 }: CountUpOptions = {}): string {
  const [display, setDisplay] = useState(target)
  const fromRef = useRef(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!Number.isFinite(target)) {
      setDisplay(target)
      return
    }
    if (prefersReducedMotion()) {
      setDisplay(target)
      fromRef.current = target
      return
    }
    const from = fromRef.current
    const delta = target - from
    if (delta === 0) return
    const start = performance.now()

    const tick = (t: number) => {
      const elapsed = t - start
      const p = Math.min(1, elapsed / duration)
      const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
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
  }, [target, duration])

  return display.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
