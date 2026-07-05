import { useMemo, useState } from 'react'
import type { HeatmapChartProps } from './types'
import { getPalette, interpolateRamp, paletteFromAttribute } from './tokens'

export default function HeatmapChart({
  data,
  xLabels,
  yLabels,
  valueRange,
  colorRamp,
  cellSize = 28,
  showValues = false,
  showLabels = true,
  rotateXLabels = false,
  onCellClick,
}: HeatmapChartProps) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)

  const palette = getPalette(paletteFromAttribute())
  const ramp = colorRamp || palette.heatRamp

  const [minVal, maxVal] = useMemo(() => {
    if (valueRange) return valueRange
    const flat = data
      .flat()
      .map((c) => c.value)
      .filter((v): v is number => v != null)
    if (flat.length === 0) return [0, 1] as [number, number]
    return [Math.min(...flat), Math.max(...flat)] as [number, number]
  }, [data, valueRange])

  const range = maxVal - minVal || 1
  const yLabelWidth = showLabels ? 64 : 0

  // Approximate rendered width of a label (px) at fontSize 10.
  const X_LABEL_FONT = 10
  const charPx = X_LABEL_FONT * 0.62
  const longestLabelPx = Math.max(0, ...xLabels.map((l) => l.length * charPx))

  // Horizontal labels that don't fit their cell get truncated with an ellipsis
  // (full text remains available via the cell tooltip).
  const maxCharsPerCell = Math.max(3, Math.floor((cellSize - 6) / charPx))
  const fitLabel = (label: string) =>
    !rotateXLabels && label.length > maxCharsPerCell
      ? label.slice(0, maxCharsPerCell - 1) + '…'
      : label

  // Rotated labels need vertical room scaled to the longest label.
  const xLabelHeight = showLabels
    ? rotateXLabels
      ? Math.min(96, Math.max(48, Math.round(longestLabelPx * 0.71) + 14))
      : 22
    : 0
  const gridWidth = xLabels.length * cellSize
  const gridHeight = yLabels.length * cellSize

  if (data.length === 0 || xLabels.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md text-xs"
        style={{ height: 120, color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
      >
        No data
      </div>
    )
  }

  return (
    <div className="relative inline-block">
      <svg width={yLabelWidth + gridWidth} height={xLabelHeight + gridHeight}>
        {showLabels &&
          xLabels.map((label, i) => (
            <text
              key={`x-${i}`}
              x={yLabelWidth + i * cellSize + cellSize / 2}
              y={xLabelHeight - 6}
              textAnchor={rotateXLabels ? 'end' : 'middle'}
              fontSize={X_LABEL_FONT}
              fill="var(--text-muted)"
              transform={
                rotateXLabels
                  ? `rotate(-45, ${yLabelWidth + i * cellSize + cellSize / 2}, ${xLabelHeight - 6})`
                  : undefined
              }
            >
              {fitLabel(label)}
            </text>
          ))}

        {showLabels &&
          yLabels.map((label, j) => (
            <text
              key={`y-${j}`}
              x={yLabelWidth - 6}
              y={xLabelHeight + j * cellSize + cellSize / 2 + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--text-muted)"
            >
              {label}
            </text>
          ))}

        {data.map((row, j) =>
          row.map((cell, i) => {
            const norm = cell.value == null ? null : (cell.value - minVal) / range
            const fill = norm == null ? 'var(--bg-tertiary)' : interpolateRamp(ramp, norm)
            const isHover = hover?.x === i && hover?.y === j
            return (
              <g key={`${i}-${j}`}>
                <rect
                  x={yLabelWidth + i * cellSize + 1}
                  y={xLabelHeight + j * cellSize + 1}
                  width={cellSize - 2}
                  height={cellSize - 2}
                  fill={fill}
                  rx={3}
                  stroke={isHover ? 'var(--text-primary)' : 'transparent'}
                  strokeWidth={1.5}
                  onMouseEnter={() => setHover({ x: i, y: j })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onCellClick?.(i, j, cell)}
                  style={{ cursor: onCellClick ? 'pointer' : 'default' }}
                />
                {showValues && cell.value != null && (
                  <text
                    x={yLabelWidth + i * cellSize + cellSize / 2}
                    y={xLabelHeight + j * cellSize + cellSize / 2 + 3}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#fff"
                    pointerEvents="none"
                  >
                    {cell.label ?? cell.value.toFixed(1)}
                  </text>
                )}
              </g>
            )
          }),
        )}
      </svg>

      {hover && data[hover.y]?.[hover.x] && (
        <div
          className="absolute pointer-events-none px-2 py-1 rounded text-xs whitespace-nowrap"
          style={{
            top: xLabelHeight + hover.y * cellSize - 28,
            left: yLabelWidth + hover.x * cellSize + cellSize / 2,
            transform: 'translateX(-50%)',
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            color: '#e5e5e5',
            zIndex: 10,
          }}
        >
          {data[hover.y][hover.x].tooltip ??
            `${yLabels[hover.y]} × ${xLabels[hover.x]}: ${data[hover.y][hover.x].value ?? '—'}`}
        </div>
      )}
    </div>
  )
}
