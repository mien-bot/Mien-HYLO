import { useMemo, useRef, useState } from 'react'
import type { CalendarHeatmapProps, CalendarPoint } from './types'
import { getPalette, interpolateRamp, paletteFromAttribute } from './tokens'

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface PositionedPoint extends CalendarPoint {
  col: number
  row: number
  date: string
}

export default function CalendarHeatmap({
  data,
  valueRange,
  valueScale = 'linear',
  colorRamp,
  cellSize = 12,
  startWeekOn = 1,
  collapseEmptyWeeks = false,
  showMonthLabels = true,
  showLegend = false,
  legendValueLabel,
  legendLessLabel = 'Less',
  legendMoreLabel = 'More',
  legendSwatchLabels,
  onClick,
}: CalendarHeatmapProps) {
  const [hover, setHover] = useState<PositionedPoint | null>(null)
  const hoverRef = useRef<{ top: number; left: number }>({ top: 0, left: 0 })
  const palette = getPalette(paletteFromAttribute())
  const ramp = colorRamp || palette.heatRamp

  const { positioned, weeks, monthLabels, yearLabels, yearSeparators, range } = useMemo(() => {
    const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date))
    if (sorted.length === 0) {
      return {
        positioned: [],
        weeks: 0,
        monthLabels: [],
        yearLabels: [],
        yearSeparators: [],
        range: [0, 1] as [number, number],
      }
    }
    // Use UTC to avoid DST causing off-by-one in day/column calculations
    const firstUtc = new Date(sorted[0].date + 'T00:00:00Z')
    const lastUtc = new Date(sorted[sorted.length - 1].date + 'T00:00:00Z')
    // getUTCDay for the local calendar day-of-week (date string is local)
    const first = new Date(sorted[0].date + 'T00:00:00')
    const firstDayOfWeek = (first.getDay() - startWeekOn + 7) % 7

    const rawPositioned = sorted.map((p) => {
      const dUtc = new Date(p.date + 'T00:00:00Z')
      const d = new Date(p.date + 'T00:00:00')
      const daysSinceStart = Math.round((dUtc.getTime() - firstUtc.getTime()) / 86400000)
      const col = Math.floor((daysSinceStart + firstDayOfWeek) / 7)
      const row = (d.getDay() - startWeekOn + 7) % 7
      return { ...p, col, row }
    })

    const totalDays = Math.round((lastUtc.getTime() - firstUtc.getTime()) / 86400000) + 1
    let weeks = Math.ceil((totalDays + firstDayOfWeek) / 7)
    let positioned: PositionedPoint[] = rawPositioned

    if (collapseEmptyWeeks) {
      const weekYears = new Map<number, number>()
      for (const p of rawPositioned) {
        if (!weekYears.has(p.col)) {
          weekYears.set(p.col, new Date(p.date + 'T00:00:00').getFullYear())
        }
      }

      const compressedCols = new Map<number, number>()
      let compressedCol = 0
      let previousYear: number | null = null
      for (const rawCol of Array.from(weekYears.keys()).sort((a, b) => a - b)) {
        const year = weekYears.get(rawCol) as number
        if (previousYear != null && year !== previousYear) {
          compressedCol += 2
        }
        compressedCols.set(rawCol, compressedCol)
        compressedCol += 1
        previousYear = year
      }

      positioned = rawPositioned.map((p) => ({ ...p, col: compressedCols.get(p.col) ?? p.col }))
      weeks = positioned.length > 0 ? Math.max(...positioned.map((p) => p.col)) + 1 : 0
    }

    const monthLabels: Array<{ col: number; label: string }> = []
    const yearBounds = new Map<number, { start: number; end: number }>()
    const yearSeparators: Array<{ col: number; year: number }> = []
    let lastMonth = -1
    let lastYear = -1
    let lastMonthLabelCol = -Infinity
    const minMonthLabelGapCols = cellSize <= 9 ? 8 : cellSize <= 11 ? 6 : 4
    positioned.forEach((p) => {
      const d = new Date(p.date + 'T00:00:00')
      const m = d.getMonth()
      const y = d.getFullYear()
      const bounds = yearBounds.get(y)
      if (bounds) {
        bounds.end = Math.max(bounds.end, p.col)
      } else {
        yearBounds.set(y, { start: p.col, end: p.col })
      }
      if (m !== lastMonth && d.getDate() <= 7) {
        if (p.col - lastMonthLabelCol >= minMonthLabelGapCols) {
          monthLabels.push({ col: p.col, label: MONTH_NAMES[m] })
          lastMonthLabelCol = p.col
        }
        lastMonth = m
      }
      if (y !== lastYear) {
        if (lastYear !== -1) {
          yearSeparators.push({ col: p.col, year: y })
        }
        lastYear = y
      }
    })

    const yearLabels = Array.from(yearBounds.entries()).map(([year, bounds]) => ({
      col: (bounds.start + bounds.end) / 2,
      year,
    }))

    let r: [number, number] = valueRange || [0, 1]
    if (!valueRange) {
      const values = positioned.map((p) => p.value).filter((v): v is number => v != null)
      if (values.length > 0) {
        r = [Math.min(...values), Math.max(...values)]
      }
    }

    return { positioned, weeks, monthLabels, yearLabels, yearSeparators, range: r }
  }, [data, startWeekOn, valueRange, cellSize, collapseEmptyWeeks])

  const [minVal, maxVal] = range
  const span = maxVal - minVal || 1
  const normalizeValue = (value: number): number => {
    if (valueScale === 'sleep-hours') {
      // 7-stop ramp: ≤4h / 4-5h / 5-6h / 6-7h / 7-8h / 8-9h / 9h+
      if (value <= 4) return 0
      if (value < 5) return (value - 4) / 6
      if (value < 6) return 1 / 6 + (value - 5) / 6
      if (value < 7) return 2 / 6 + (value - 6) / 6
      if (value < 8) return 3 / 6 + (value - 7) / 6
      if (value < 9) return 4 / 6 + (value - 8) / 6
      return Math.min(1, 5 / 6 + (value - 9) / 6)
    }
    return (value - minVal) / span
  }

  const padLeft = 18
  const padTop = showMonthLabels ? 30 : 0
  const gap = 2
  const cell = cellSize - gap

  const width = padLeft + weeks * cellSize + 2
  const height = padTop + 7 * cellSize + 2

  if (positioned.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md text-xs"
        style={{ height: 96, color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
      >
        No data
      </div>
    )
  }

  return (
    <div className="relative inline-block">
      <svg width={width} height={height}>
        {showMonthLabels &&
          yearLabels.map((y) => (
            <text
              key={y.year}
              x={padLeft + y.col * cellSize + cell / 2}
              y={10}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill="var(--text-secondary)"
            >
              {y.year}
            </text>
          ))}

        {showMonthLabels &&
          monthLabels.map((m, i) => (
            <text
              key={i}
              x={padLeft + m.col * cellSize}
              y={padTop - 4}
              fontSize={9}
              fill="var(--text-muted)"
            >
              {m.label}
            </text>
          ))}

        {Array.from({ length: 7 }, (_, dayIdx) => (
          <text
            key={dayIdx}
            x={padLeft - 6}
            y={padTop + dayIdx * cellSize + cell / 2 + 3}
            textAnchor="end"
            fontSize={7}
            fill="var(--text-muted)"
          >
            {WEEKDAYS[(dayIdx + startWeekOn) % 7].slice(0, 1)}
          </text>
        ))}

        {yearSeparators.map((ys) => (
          <line
            key={`yr-${ys.year}`}
            x1={padLeft + ys.col * cellSize - 1}
            y1={showMonthLabels ? 14 : padTop}
            x2={padLeft + ys.col * cellSize - 1}
            y2={padTop + 7 * cellSize}
            stroke="var(--text-muted)"
            strokeWidth={0.75}
            strokeDasharray="3,3"
            opacity={0.65}
          />
        ))}

        {positioned.map((p) => {
          const t = p.value == null ? null : normalizeValue(p.value)
          const fill = t == null ? 'var(--bg-tertiary)' : interpolateRamp(ramp, t)
          const isHover = hover?.date === p.date
          return (
            <rect
              key={p.date}
              x={padLeft + p.col * cellSize}
              y={padTop + p.row * cellSize}
              width={cell}
              height={cell}
              fill={fill}
              rx={2}
              stroke={isHover ? 'var(--text-primary)' : 'transparent'}
              strokeWidth={1}
              onMouseEnter={(e) => {
                const rect = (e.target as SVGRectElement).getBoundingClientRect()
                hoverRef.current = { top: rect.top, left: rect.left + rect.width / 2 }
                setHover(p)
              }}
              onMouseLeave={() => setHover(null)}
              onClick={() => onClick?.(p)}
              style={{ cursor: onClick ? 'pointer' : 'default' }}
            />
          )
        })}
      </svg>

      {showLegend && (
        <div
          className="flex items-center gap-1 mt-2"
          style={{ color: 'var(--text-muted)', fontSize: 10 }}
        >
          <span>{legendLessLabel}</span>
          {ramp.map((color, i) => (
            <div
              key={`${color}-${i}`}
              title={legendSwatchLabels?.[i]}
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                backgroundColor: color,
                cursor: legendSwatchLabels ? 'help' : undefined,
              }}
            />
          ))}
          <span>{legendMoreLabel}</span>
          {legendValueLabel && <span className="ml-2">{legendValueLabel}</span>}
        </div>
      )}

      {hover && (
        <div
          className="fixed pointer-events-none px-2 py-1 rounded text-xs whitespace-nowrap"
          style={{
            top: (hoverRef.current?.top ?? 0) - 32,
            left: hoverRef.current?.left ?? 0,
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            color: '#e5e5e5',
            zIndex: 50,
          }}
        >
          {hover.tooltip ?? `${hover.date}: ${hover.value ?? '—'}`}
        </div>
      )}
    </div>
  )
}
