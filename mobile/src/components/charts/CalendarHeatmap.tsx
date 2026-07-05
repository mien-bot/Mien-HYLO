import React, { useMemo } from 'react'
import { View } from 'react-native'
import Svg, { Rect, Text as SvgText } from 'react-native-svg'

export interface CalendarPoint {
  date: string
  value: number | null
}

export interface CalendarHeatmapProps {
  data: CalendarPoint[]
  valueRange?: [number, number]
  valueScale?: 'linear' | 'sleep-hours'
  colorRamp?: string[]
  cellSize?: number
  startWeekOn?: 0 | 1
  showMonthLabels?: boolean
  collapseEmptyWeeks?: boolean
}

const DEFAULT_RAMP = ['#7f0000', '#cc0000', '#ff453a', '#ff9f0a', '#30d158', '#0a84ff', '#0a2540']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function interpolateRamp(ramp: string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  const scaled = clamped * (ramp.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  if (i >= ramp.length - 1) return ramp[ramp.length - 1]
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(ramp[i])
  const m2 = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(ramp[i + 1])
  if (!m || !m2) return ramp[i]
  const r = Math.round(parseInt(m[1], 16) + (parseInt(m2[1], 16) - parseInt(m[1], 16)) * f)
  const g = Math.round(parseInt(m[2], 16) + (parseInt(m2[2], 16) - parseInt(m[2], 16)) * f)
  const b = Math.round(parseInt(m[3], 16) + (parseInt(m2[3], 16) - parseInt(m[3], 16)) * f)
  return `rgb(${r}, ${g}, ${b})`
}

export default function CalendarHeatmap({
  data,
  valueRange,
  valueScale = 'linear',
  colorRamp = DEFAULT_RAMP,
  cellSize = 12,
  startWeekOn = 1,
  showMonthLabels = true,
  collapseEmptyWeeks = false,
}: CalendarHeatmapProps) {
  const { positioned, weeks, monthLabels, range } = useMemo(() => {
    const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date))
    if (sorted.length === 0) {
      return { positioned: [], weeks: 0, monthLabels: [], range: [0, 1] as [number, number] }
    }
    // Use UTC to avoid DST causing off-by-one in day/column calculations
    const firstUtc = new Date(sorted[0].date + 'T00:00:00Z')
    const lastUtc = new Date(sorted[sorted.length - 1].date + 'T00:00:00Z')
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
    let positioned = rawPositioned

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
    let lastMonth = -1
    positioned.forEach((p) => {
      const d = new Date(p.date + 'T00:00:00')
      if (d.getMonth() !== lastMonth && d.getDate() <= 7) {
        monthLabels.push({ col: p.col, label: MONTHS[d.getMonth()] })
        lastMonth = d.getMonth()
      }
    })

    let r: [number, number] = valueRange || [0, 1]
    if (!valueRange) {
      const values = positioned.map((p) => p.value).filter((v): v is number => v != null)
      if (values.length > 0) r = [Math.min(...values), Math.max(...values)]
    }
    return { positioned, weeks, monthLabels, range: r }
  }, [data, startWeekOn, valueRange, collapseEmptyWeeks])

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
  const padLeft = 4
  const padTop = showMonthLabels ? 16 : 0
  const cell = cellSize - 2

  if (positioned.length === 0) {
    return <View style={{ height: 96, backgroundColor: '#2c2c2e', borderRadius: 6 }} />
  }

  const width = padLeft + weeks * cellSize + 2
  const height = padTop + 7 * cellSize + 2

  return (
    <Svg width={width} height={height}>
      {showMonthLabels &&
        monthLabels.map((m, i) => (
          <SvgText
            key={i}
            x={padLeft + m.col * cellSize}
            y={padTop - 4}
            fontSize={9}
            fill="#6e6e73"
          >
            {m.label}
          </SvgText>
        ))}
      {positioned.map((p) => {
        const t = p.value == null ? null : normalizeValue(p.value)
        const fill = t == null ? '#2c2c2e' : interpolateRamp(colorRamp, t)
        return (
          <Rect
            key={p.date}
            x={padLeft + p.col * cellSize}
            y={padTop + p.row * cellSize}
            width={cell}
            height={cell}
            fill={fill}
            rx={2}
          />
        )
      })}
    </Svg>
  )
}
