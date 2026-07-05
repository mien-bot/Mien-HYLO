import type { SparklineRowProps } from './types'

/**
 * Pure-SVG sparkline — no recharts dependency, so it can ship in eagerly
 * loaded surfaces (Dashboard hero, KPI cards) without dragging in the
 * chart bundle.
 */
export default function SparklineRow({
  data,
  height = 28,
  width = '100%',
  strokeColor = 'var(--accent-blue)',
  fillBelow = false,
  showDots = false,
}: SparklineRowProps) {
  if (!data || data.length < 2) {
    return (
      <div
        style={{
          height,
          width,
          background: 'var(--bg-tertiary)',
          borderRadius: 4,
          opacity: 0.4,
        }}
      />
    )
  }

  const w = 100
  const h = 28
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pad = 2
  const innerH = h - pad * 2
  const step = data.length > 1 ? w / (data.length - 1) : 0

  const points = data.map((v, i) => {
    const x = i * step
    const y = pad + innerH - ((v - min) / range) * innerH
    return { x, y }
  })

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ')

  const fillD = fillBelow
    ? `${pathD} L ${points[points.length - 1].x.toFixed(2)} ${h} L 0 ${h} Z`
    : null

  return (
    <div style={{ width, height }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height="100%">
        {fillD && <path d={fillD} fill={strokeColor} fillOpacity={0.15} />}
        <path
          d={pathD}
          fill="none"
          stroke={strokeColor}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {showDots &&
          points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={1.2} fill={strokeColor} />)}
      </svg>
    </div>
  )
}
