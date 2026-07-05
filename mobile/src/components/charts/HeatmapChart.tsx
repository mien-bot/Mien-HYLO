import React from 'react'
import { View } from 'react-native'
import Svg, { Rect, Text as SvgText } from 'react-native-svg'

export interface HeatmapCell {
  value: number | null
  label?: string
}

export interface HeatmapChartProps {
  data: HeatmapCell[][]
  xLabels: string[]
  yLabels: string[]
  valueRange?: [number, number]
  colorRamp?: string[]
  cellSize?: number
  showValues?: boolean
}

const DEFAULT_RAMP = ['#0a2540', '#0a84ff', '#64d2ff', '#30d158', '#ffd60a', '#ff9f0a', '#ff453a']

function hexToRgb(hex: string) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return null
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

function mixHex(a: string, b: string, t: number) {
  const pa = hexToRgb(a)
  const pb = hexToRgb(b)
  if (!pa || !pb) return a
  const r = Math.round(pa.r + (pb.r - pa.r) * t)
  const g = Math.round(pa.g + (pb.g - pa.g) * t)
  const bl = Math.round(pa.b + (pb.b - pa.b) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

function interpolateRamp(ramp: string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  const scaled = clamped * (ramp.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  if (i >= ramp.length - 1) return ramp[ramp.length - 1]
  return mixHex(ramp[i], ramp[i + 1], f)
}

export default function HeatmapChart({
  data,
  xLabels,
  yLabels,
  valueRange,
  colorRamp = DEFAULT_RAMP,
  cellSize = 28,
  showValues = false,
}: HeatmapChartProps) {
  const flat = data.flat().map((c) => c.value).filter((v): v is number => v != null)
  const [minVal, maxVal] = valueRange ?? (flat.length === 0 ? [0, 1] : [Math.min(...flat), Math.max(...flat)])
  const range = maxVal - minVal || 1
  const yLabelWidth = 64
  const xLabelHeight = 22

  if (data.length === 0) {
    return <View style={{ height: 120, backgroundColor: '#2c2c2e', borderRadius: 6 }} />
  }

  const width = yLabelWidth + xLabels.length * cellSize
  const height = xLabelHeight + yLabels.length * cellSize

  return (
    <Svg width={width} height={height}>
      {xLabels.map((label, i) => (
        <SvgText
          key={`x-${i}`}
          x={yLabelWidth + i * cellSize + cellSize / 2}
          y={xLabelHeight - 6}
          textAnchor="middle"
          fontSize={10}
          fill="#6e6e73"
        >
          {label}
        </SvgText>
      ))}
      {yLabels.map((label, j) => (
        <SvgText
          key={`y-${j}`}
          x={yLabelWidth - 6}
          y={xLabelHeight + j * cellSize + cellSize / 2 + 3}
          textAnchor="end"
          fontSize={10}
          fill="#6e6e73"
        >
          {label}
        </SvgText>
      ))}
      {data.map((row, j) =>
        row.map((cell, i) => {
          const norm = cell.value == null ? null : (cell.value - minVal) / range
          const fill = norm == null ? '#2c2c2e' : interpolateRamp(colorRamp, norm)
          return (
            <React.Fragment key={`${i}-${j}`}>
              <Rect
                x={yLabelWidth + i * cellSize + 1}
                y={xLabelHeight + j * cellSize + 1}
                width={cellSize - 2}
                height={cellSize - 2}
                fill={fill}
                rx={3}
              />
              {showValues && cell.value != null && (
                <SvgText
                  x={yLabelWidth + i * cellSize + cellSize / 2}
                  y={xLabelHeight + j * cellSize + cellSize / 2 + 3}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#fff"
                >
                  {cell.label ?? cell.value.toFixed(1)}
                </SvgText>
              )}
            </React.Fragment>
          )
        })
      )}
    </Svg>
  )
}
