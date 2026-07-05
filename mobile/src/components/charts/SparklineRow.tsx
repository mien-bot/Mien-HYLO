import React from 'react'
import { View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { colors } from '../../lib/theme'

export interface SparklineRowProps {
  data: number[]
  height?: number
  width?: number
  strokeColor?: string
  fillBelow?: boolean
}

export default function SparklineRow({
  data,
  height = 28,
  width = 100,
  strokeColor = colors.accent.blue,
  fillBelow = false,
}: SparklineRowProps) {
  if (!data || data.length < 2) {
    return (
      <View
        style={{
          height,
          width,
          backgroundColor: colors.bg.tertiary,
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

  const points = data.map((v, i) => ({
    x: i * step,
    y: pad + innerH - ((v - min) / range) * innerH,
  }))

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
  const fillD = fillBelow
    ? `${pathD} L ${points[points.length - 1].x.toFixed(2)} ${h} L 0 ${h} Z`
    : null

  return (
    <View style={{ width, height }}>
      <Svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" preserveAspectRatio="none">
        {fillD && <Path d={fillD} fill={strokeColor} fillOpacity={0.15} />}
        <Path
          d={pathD}
          fill="none"
          stroke={strokeColor}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  )
}
