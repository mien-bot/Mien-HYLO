import { useEffect, useState } from 'react'
import type { ScoreRingProps } from './types'
import { prefersReducedMotion } from '../../lib/theme'

export default function ScoreRing({
  score,
  label,
  color = 'var(--accent-blue)',
  size = 64,
  thickness = 3,
  subtext,
  max = 100,
}: ScoreRingProps) {
  const safeScore = Math.max(0, Math.min(max, score))
  const radius = (size - thickness * 2) / 2
  const circumference = 2 * Math.PI * radius
  const [mounted, setMounted] = useState(() => prefersReducedMotion())
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  const offset = mounted ? circumference - (safeScore / max) * circumference : circumference
  const display = Number.isFinite(score) ? Math.round(score) : 0

  const fontSize = size >= 96 ? 28 : size >= 64 ? 18 : 14
  const labelSize = size >= 96 ? 12 : 10

  return (
    <div className="relative inline-flex flex-col items-center" style={{ width: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--separator)"
            strokeWidth={thickness}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(0.22, 1, 0.36, 1)' }}
          />
        </svg>
        <div
          className="font-display absolute inset-0 flex items-center justify-center font-extrabold"
          style={{ color: 'var(--text-primary)', fontSize }}
        >
          {display}
        </div>
      </div>
      {(label || subtext) && (
        <div className="mt-1 flex flex-col items-center">
          {label && (
            <span
              style={{
                color: 'var(--text-muted)',
                fontSize: labelSize,
                lineHeight: 1.2,
              }}
            >
              {label}
            </span>
          )}
          {subtext && (
            <span
              style={{
                color: 'var(--text-secondary)',
                fontSize: labelSize - 1,
              }}
            >
              {subtext}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
