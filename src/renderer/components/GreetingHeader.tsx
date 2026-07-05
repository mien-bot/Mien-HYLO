import { useMemo } from 'react'
import { useDisplayName } from '../hooks/useDisplayName'

interface GreetingHeaderProps {
  /** Optional headline stat shown under the greeting (e.g. "Recovery 82 · ready"). */
  subtitle?: string
  /** Fallback title when no display name is set (defaults to "Dashboard"). */
  fallback?: string
}

function timeOfDay(hour: number): { label: string; emoji: string } {
  if (hour < 5) return { label: 'Still up', emoji: '🌙' }
  if (hour < 12) return { label: 'Good morning', emoji: '🌤️' }
  if (hour < 17) return { label: 'Good afternoon', emoji: '🍜' }
  if (hour < 22) return { label: 'Good evening', emoji: '🍜' }
  return { label: 'Late night', emoji: '🌙' }
}

/**
 * Cozy, time-of-day-aware greeting with a little ambient steam. Uses the display
 * font and the configured display name. Steam is gated to playful motion via the
 * .ambient-steam class (hidden under calm / reduced-motion in globals.css).
 */
export default function GreetingHeader({ subtitle, fallback = 'Dashboard' }: GreetingHeaderProps) {
  const name = useDisplayName()
  const { label, emoji } = useMemo(() => timeOfDay(new Date().getHours()), [])

  const greeting = name ? `${label}, ${name}` : fallback

  return (
    <div className="relative">
      {/* ambient steam rising off the greeting */}
      <div className="ambient-steam pointer-events-none absolute -top-1 left-1 opacity-70">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="absolute block rounded-full"
            style={{
              left: i * 7,
              bottom: 0,
              width: 3,
              height: 8,
              background:
                'linear-gradient(to top, var(--glow-accent), transparent)',
              animation: `steam-drift 2.6s ease-in-out ${i * 0.5}s infinite`,
            }}
          />
        ))}
      </div>
      <h2
        className="font-display text-2xl font-extrabold tracking-tight"
        style={{ color: 'var(--text-primary)' }}
      >
        {greeting} <span style={{ fontWeight: 400 }}>{emoji}</span>
      </h2>
      {subtitle && (
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {subtitle}
        </p>
      )}
    </div>
  )
}
