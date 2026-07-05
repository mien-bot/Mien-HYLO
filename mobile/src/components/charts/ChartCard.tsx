import React from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { colors } from '../../lib/theme'

export interface ChartCardProps {
  title: string
  subtitle?: string
  lastUpdated?: number | null
  onRefresh?: () => void | Promise<void>
  loading?: boolean
  children: React.ReactNode
}

function formatLastUpdated(ts: number | null | undefined): string {
  if (!ts) return ''
  const delta = Date.now() - ts
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

export default function ChartCard({
  title,
  subtitle,
  lastUpdated,
  onRefresh,
  loading,
  children,
}: ChartCardProps) {
  return (
    <View
      style={{
        backgroundColor: colors.bg.card,
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 12,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{ color: colors.text.primary, fontSize: 14, fontWeight: '600' }}
            numberOfLines={1}
          >
            {title}
          </Text>
          {subtitle && (
            <Text style={{ color: colors.text.muted, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>
        {onRefresh && (
          <Pressable
            onPress={() => void onRefresh()}
            disabled={loading}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: colors.bg.tertiary,
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 4,
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#6e6e73" />
            ) : (
              <Text style={{ color: colors.text.muted, fontSize: 11 }}>↻</Text>
            )}
            {lastUpdated ? (
              <Text style={{ color: colors.text.muted, fontSize: 10 }}>
                {formatLastUpdated(lastUpdated)}
              </Text>
            ) : null}
          </Pressable>
        )}
      </View>
      <View>{children}</View>
    </View>
  )
}
