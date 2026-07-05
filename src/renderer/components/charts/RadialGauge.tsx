import { useEffect, useId, useState } from 'react'
import type { RadialGaugeProps } from './types'
import { prefersReducedMotion } from '../../lib/theme'

export default function RadialGauge({
  value,
  min = 0,
  max = 100,
  label,
  unit,
  thresholds,
  size = 160,
  thickness = 12,
}: RadialGaugeProps) {
  const clamped = Math.max(min, Math.min(max, value))
  const range = max - min
  const t = range === 0 ? 0 : (clamped - min) / range

  // Sweep-on-mount: start at zero, then animate to the real value via the
  // CSS `d` transition. Honors calm / reduced-motion by starting at the value.
  const [mounted, setMounted] = useState(() => prefersReducedMotion())
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  const tAnim = mounted ? t : 0

  const glowId = useId().replace(/:/g, '')

  const startAngle = -135
  const sweep = 270
  const endAngle = startAngle + sweep * tAnim

  const cx = size / 2
  const cy = size / 2
  const r = (size - thickness * 2) / 2

  const trackPath = describeArc(cx, cy, r, startAngle, startAngle + sweep)
  const valuePath = describeArc(cx, cy, r, startAngle, endAngle)

  const segments: Array<{ from: number; to: number; color: string }> = []
  if (thresholds && thresholds.length > 0) {
    const sorted = [...thresholds].sort((a, b) => a.at - b.at)
    let cursor = min
    for (const tr of sorted) {
      segments.push({ from: cursor, to: tr.at, color: tr.color })
      cursor = tr.at
    }
    segments.push({ from: cursor, to: max, color: sorted[sorted.length - 1].color })
  }

  const activeColor =
    thresholds && thresholds.length > 0
      ? thresholds.reduce((acc, tr) => (clamped >= tr.at ? tr.color : acc), thresholds[0].color)
      : 'var(--accent-blue)'

  const display = Number.isFinite(value)
    ? Math.abs(value) < 10
      ? value.toFixed(1)
      : Math.round(value).toString()
    : '—'

  return (
    <div className="relative inline-flex flex-col items-center" style={{ width: size }}>
      <svg width={size} height={size}>
        <defs>
          <filter id={`glow-${glowId}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={thickness * 0.35} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {segments.length > 0 ? (
          segments.map((seg, i) => {
            const sa = startAngle + (sweep * (seg.from - min)) / range
            const ea = startAngle + (sweep * (seg.to - min)) / range
            return (
              <path
                key={i}
                d={describeArc(cx, cy, r, sa, ea)}
                fill="none"
                stroke={seg.color}
                strokeOpacity={0.25}
                strokeWidth={thickness}
                strokeLinecap="butt"
              />
            )
          })
        ) : (
          <path
            d={trackPath}
            fill="none"
            stroke="var(--separator)"
            strokeWidth={thickness}
            strokeLinecap="round"
          />
        )}
        <path
          d={valuePath}
          fill="none"
          stroke={activeColor}
          strokeWidth={thickness}
          strokeLinecap="round"
          filter={`url(#glow-${glowId})`}
          style={{ transition: 'd 0.6s cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
        <text
          x={cx}
          y={cy + (size >= 140 ? 4 : 2)}
          textAnchor="middle"
          fontSize={size >= 140 ? 28 : 20}
          fontWeight={800}
          fontFamily="var(--font-display)"
          fill="var(--text-primary)"
        >
          {display}
        </text>
        {unit && (
          <text
            x={cx}
            y={cy + (size >= 140 ? 24 : 18)}
            textAnchor="middle"
            fontSize={size >= 140 ? 11 : 9}
            fill="var(--text-muted)"
          >
            {unit}
          </text>
        )}
      </svg>
      {label && (
        <span className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </span>
      )}
    </div>
  )
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180
  return {
    x: cx + r * Math.cos(angleRad),
    y: cy + r * Math.sin(angleRad),
  }
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle)
  const end = polarToCartesian(cx, cy, r, startAngle)
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1
  return ['M', start.x, start.y, 'A', r, r, 0, largeArc, 0, end.x, end.y].join(' ')
}
