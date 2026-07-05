import React from 'react'
import { View, Text } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { colors } from '../../lib/theme'

export interface ScoreRingProps {
  score: number
  label?: string
  color?: string
  size?: number
  thickness?: number
  subtext?: string
  max?: number
  textColor?: string
  trackColor?: string
}

export default function ScoreRing({
  score,
  label,
  color = colors.accent.blue,
  size = 64,
  thickness = 3,
  subtext,
  max = 100,
  textColor = colors.text.primary,
  trackColor = colors.border,
}: ScoreRingProps) {
  const safeScore = Math.max(0, Math.min(max, score))
  const radius = (size - thickness * 2) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (safeScore / max) * circumference
  const display = Number.isFinite(score) ? Math.round(score) : 0

  const fontSize = size >= 96 ? 28 : size >= 64 ? 18 : 14
  const labelSize = size >= 96 ? 12 : 10

  return (
    <View style={{ width: size, alignItems: 'center' }}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={trackColor}
            strokeWidth={thickness}
          />
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeDasharray={`${circumference},${circumference}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </Svg>
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: textColor, fontSize, fontWeight: '600' }}>{display}</Text>
        </View>
      </View>
      {(label || subtext) && (
        <View style={{ marginTop: 4, alignItems: 'center' }}>
          {label && (
            <Text style={{ color: colors.text.muted, fontSize: labelSize, lineHeight: labelSize * 1.2 }}>{label}</Text>
          )}
          {subtext && (
            <Text style={{ color: colors.text.secondary, fontSize: labelSize - 1 }}>{subtext}</Text>
          )}
        </View>
      )}
    </View>
  )
}
