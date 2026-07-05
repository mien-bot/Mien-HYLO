import React from 'react'
import { View, Text } from 'react-native'

export interface TrendBadgeProps {
  data: number[]
  unit?: string
  higherIsBetter?: boolean
  window?: 'wk' | 'day'
}

function linearTrend(data: number[]): number {
  const n = data.length
  if (n < 2) return 0
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += data[i]
    sumXY += i * data[i]
    sumX2 += i * i
  }
  const denom = n * sumX2 - sumX * sumX
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom
}

export default function TrendBadge({
  data,
  unit = '',
  higherIsBetter = true,
  window = 'wk',
}: TrendBadgeProps) {
  if (!data || data.length < 3) return null
  const slope = linearTrend(data)
  const multiplier = window === 'wk' ? 7 : 1
  const change = parseFloat((slope * multiplier).toFixed(1))
  const threshold = window === 'wk' ? 0.1 : 0.05

  if (Math.abs(change) < threshold) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ color: '#6e6e73', fontSize: 12 }}>— Stable</Text>
      </View>
    )
  }

  const isGood = higherIsBetter ? change > 0 : change < 0
  const color = isGood ? '#30d158' : '#ff453a'
  const arrow = change > 0 ? '↑' : '↓'
  const prefix = change > 0 ? '+' : ''

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
      <Text style={{ color, fontSize: 12, fontWeight: '600' }}>
        {arrow} {prefix}{change}{unit}/{window}
      </Text>
    </View>
  )
}
