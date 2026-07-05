import React, { useEffect, useState } from 'react'
import { View, Text, Image, StyleSheet, ActivityIndicator, TouchableOpacity, Alert } from 'react-native'
import { downloadAsync } from 'expo-file-system/legacy'
import { cacheDirectory } from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '../lib/theme'
import { geocodeLocation } from '../services/geocoding.service'

interface Activity {
  time: string
  activity: string
  location: string
  [key: string]: any
}

interface ResolvedPin {
  lat: number
  lng: number
  label: string
}

interface Props {
  activities: Activity[]
  apiKey: string
  city?: string
  height?: number
  title?: string
}

const PIN_COLORS = ['0x38bdf8', '0x4ade80', '0xfbbf24', '0xa78bfa', '0x22d3ee', '0xfb923c']

const DARK_STYLES = [
  'feature:all|element:geometry|color:0x212121',
  'feature:all|element:labels.text.fill|color:0x757575',
  'feature:all|element:labels.text.stroke|color:0x212121',
  'feature:water|element:geometry|color:0x000000',
  'feature:road|element:geometry.fill|color:0x2c2c2c',
  'feature:road.arterial|element:geometry|color:0x373737',
  'feature:road.highway|element:geometry|color:0x3c3c3c',
  'feature:poi|element:labels.text.fill|color:0x757575',
]

function buildStaticMapUrl(pins: ResolvedPin[], apiKey: string, width = 640, height = 400): string {
  let url = `https://maps.googleapis.com/maps/api/staticmap?size=${width}x${height}&scale=2&maptype=roadmap&key=${apiKey}`
  DARK_STYLES.forEach(s => { url += `&style=${encodeURIComponent(s)}` })

  pins.slice(0, 10).forEach((pin, index) => {
    const letter = String.fromCharCode(65 + index)
    const color = PIN_COLORS[index % PIN_COLORS.length]
    url += `&markers=${encodeURIComponent(`size:mid|label:${letter}|color:${color}|${pin.lat},${pin.lng}`)}`
  })

  if (pins.length > 1) {
    const pathPoints = pins.map(p => `${p.lat},${p.lng}`).join('|')
    url += `&path=${encodeURIComponent(`color:0x38bdf8ff|weight:4|${pathPoints}`)}`
  }

  return url
}

export default function PlanMapView({ activities, apiKey, city, height = 300, title }: Props) {
  const [pins, setPins] = useState<ResolvedPin[]>([])
  const [loading, setLoading] = useState(true)
  const [mapUrl, setMapUrl] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    if (!activities.length || !apiKey) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setPins([])
    setMapUrl(null)
    setImageError(false)

    ;(async () => {
      const resolved: ResolvedPin[] = []
      for (const act of activities) {
        if (!act.location) continue
        const coords = await geocodeLocation(act.location, apiKey, city)
        if (cancelled) return
        if (coords) resolved.push({ lat: coords.lat, lng: coords.lng, label: act.activity })
      }
      if (!cancelled) {
        setPins(resolved)
        if (resolved.length > 0) {
          setMapUrl(buildStaticMapUrl(resolved, apiKey))
        }
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [activities, apiKey, city])

  const handleExport = async () => {
    if (!mapUrl) return
    setSharing(true)
    try {
      const filename = `plan-map-${Date.now()}.jpg`
      const fileUri = `${cacheDirectory}${filename}`
      const result = await downloadAsync(mapUrl, fileUri)
      if (result.status === 200) {
        await Sharing.shareAsync(result.uri, { mimeType: 'image/jpeg', dialogTitle: 'Share Plan Map' })
      } else {
        Alert.alert('Error', 'Failed to download map image')
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to export map')
    }
    setSharing(false)
  }

  if (!activities.length) return null

  return (
    <View style={[styles.container, { minHeight: height }]}>
      {title && (
        <View style={styles.titleRow}>
          <Ionicons name="map-outline" size={14} color={colors.accent.cyan} />
          <Text style={styles.titleText}>{title}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent.blue} />
          <Text style={styles.loadingText}>Locating activities...</Text>
        </View>
      ) : mapUrl && pins.length > 0 && !imageError ? (
        <View>
          <Image
            source={{ uri: mapUrl }}
            style={[styles.mapImage, { height }]}
            resizeMode="cover"
            onError={({ nativeEvent }) => {
              console.warn('[PlanMapView] Static map failed to load:', nativeEvent?.error)
              setImageError(true)
            }}
          />
          {/* Legend */}
          <View style={styles.legend}>
            {pins.slice(0, 10).map((pin, i) => (
              <Text key={i} style={styles.legendItem} numberOfLines={1}>
                {String.fromCharCode(65 + i)}. {pin.label}
              </Text>
            ))}
          </View>
          {/* Export button */}
          <TouchableOpacity onPress={handleExport} disabled={sharing} style={styles.exportBtn}>
            {sharing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="share-outline" size={14} color="#fff" />
                <Text style={styles.exportText}>Export</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.center}>
          <Ionicons name="map-outline" size={24} color={colors.text.muted} />
          <Text style={styles.loadingText}>
            {imageError
              ? 'Map unavailable — check that the Maps Static API is enabled for your Google key'
              : pins.length === 0
                ? 'No mappable locations found'
                : 'Map unavailable'}
          </Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 16,
    backgroundColor: colors.bg.card,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  titleText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.cyan,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 40,
  },
  mapImage: {
    width: '100%',
    borderRadius: 8,
  },
  legend: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 3,
  },
  legendItem: {
    fontSize: 11,
    color: colors.text.secondary,
  },
  exportBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(10,14,26,0.85)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  exportText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
  },
  loadingText: {
    fontSize: 13,
    color: colors.text.muted,
  },
})
