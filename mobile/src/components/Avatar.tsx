import React from 'react'
import { View, Text, Image } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useTheme } from '../lib/ThemeContext'
import { fonts } from '../lib/theme'

interface AvatarProps {
  name?: string
  size?: number
  src?: string
}

function initialsFrom(name?: string): string {
  const trimmed = (name || '').trim()
  if (!trimmed) return '🍜'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Circular avatar: a monogram (or noodle glyph) over the active accent gradient. */
export default function Avatar({ name, size = 40, src }: AvatarProps) {
  const { gradient } = useTheme()
  const label = initialsFrom(name)
  const isGlyph = label === '🍜'

  if (src) {
    return (
      <Image
        source={{ uri: src }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    )
  }

  return (
    <LinearGradient
      colors={gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: '#fff',
          fontFamily: isGlyph ? undefined : fonts.display,
          fontSize: isGlyph ? size * 0.5 : size * 0.42,
          fontWeight: '800',
        }}
      >
        {label}
      </Text>
    </LinearGradient>
  )
}
