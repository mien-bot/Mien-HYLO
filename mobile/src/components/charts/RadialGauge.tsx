import React, { useId } from 'react'
import { View, Text } from 'react-native'
import Svg, { Path, Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg'
import { fonts, lighten } from '../../lib/theme'

export interface RadialGaugeProps {
  value: number
  min?: number
  max?: number
  label?: string
  unit?: string
  thresholds?: Array<{ at: number; color: string }>
  size?: number
  thickness?: number
  textColor?: string
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) }
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle)
  const end = polarToCartesian(cx, cy, r, startAngle)
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`
}

export default function RadialGauge({
  value,
  min = 0,
  max = 100,
  label,
  unit,
  thresholds,
  size = 160,
  thickness = 12,
  textColor = '#f5f5f7',
}: RadialGaugeProps) {
  const clamped = Math.max(min, Math.min(max, value))
  const range = max - min || 1
  const t = (clamped - min) / range

  const startAngle = -135
  const sweep = 270
  const endAngle = startAngle + sweep * t

  const cx = size / 2
  const cy = size / 2
  const r = (size - thickness * 2) / 2

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
      : '#0a84ff'

  const display = Number.isFinite(value)
    ? Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value).toString()
    : '—'

  const gradId = `gauge-${useId().replace(/:/g, '')}`

  return (
    <View style={{ width: size, alignItems: 'center' }}>
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={lighten(activeColor, 0.35)} />
            <Stop offset="1" stopColor={activeColor} />
          </LinearGradient>
        </Defs>
        {segments.length > 0 ? (
          segments.map((seg, i) => {
            const sa = startAngle + (sweep * (seg.from - min)) / range
            const ea = startAngle + (sweep * (seg.to - min)) / range
            return (
              <Path
                key={i}
                d={describeArc(cx, cy, r, sa, ea)}
                fill="none"
                stroke={seg.color}
                strokeOpacity={0.25}
                strokeWidth={thickness}
              />
            )
          })
        ) : (
          <Path
            d={describeArc(cx, cy, r, startAngle, startAngle + sweep)}
            fill="none"
            stroke="#38383a"
            strokeWidth={thickness}
            strokeLinecap="round"
          />
        )}
        {/* soft glow underlay */}
        <Path
          d={valuePath}
          fill="none"
          stroke={activeColor}
          strokeOpacity={0.25}
          strokeWidth={thickness + 6}
          strokeLinecap="round"
        />
        <Path
          d={valuePath}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        <SvgText
          x={cx}
          y={cy + (size >= 140 ? 4 : 2)}
          textAnchor="middle"
          fontSize={size >= 140 ? 28 : 20}
          fontFamily={fonts.display}
          fontWeight="800"
          fill={textColor}
        >
          {display}
        </SvgText>
        {unit && (
          <SvgText
            x={cx}
            y={cy + (size >= 140 ? 24 : 18)}
            textAnchor="middle"
            fontSize={size >= 140 ? 11 : 9}
            fill="#6e6e73"
          >
            {unit}
          </SvgText>
        )}
      </Svg>
      {label && <Text style={{ marginTop: 4, fontSize: 12, color: '#a1a1a6' }}>{label}</Text>}
    </View>
  )
}
