import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getSettings, saveSettings } from './storage'
import {
  THEME_PRESETS,
  DEFAULT_PRESET,
  lighten,
  withAlpha,
  type ThemePreset,
  type MotionLevel,
} from './theme'

export interface ThemeValue {
  accent: string
  accentSoft: string
  gradient: [string, string]
  preset: ThemePreset
  customAccent: string
  motionLevel: MotionLevel
  displayName: string
  /** True when decorative motion should be suppressed (calm mode). */
  reduceMotion: boolean
  setPreset: (p: ThemePreset) => void
  setCustomAccent: (hex: string) => void
  setMotionLevel: (m: MotionLevel) => void
  setDisplayName: (name: string) => void
}

function accentFor(preset: ThemePreset, custom: string): { accent: string; gradient: [string, string] } {
  if (custom) return { accent: custom, gradient: [lighten(custom, 0.3), custom] }
  const def = THEME_PRESETS.find((p) => p.id === preset) || THEME_PRESETS[0]
  return { accent: def.accent, gradient: def.gradient }
}

const ThemeContext = createContext<ThemeValue | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preset, setPresetState] = useState<ThemePreset>(DEFAULT_PRESET)
  const [customAccent, setCustomAccentState] = useState('')
  const [motionLevel, setMotionState] = useState<MotionLevel>('playful')
  const [displayName, setDisplayNameState] = useState('')

  useEffect(() => {
    getSettings()
      .then((s) => {
        if (s.themePreset) setPresetState(s.themePreset as ThemePreset)
        if (s.accentColor) setCustomAccentState(s.accentColor)
        if (s.motionLevel) setMotionState(s.motionLevel as MotionLevel)
        if (s.displayName) setDisplayNameState(s.displayName)
      })
      .catch(() => {})
  }, [])

  const persist = useCallback(async (patch: Record<string, string>) => {
    try {
      const current = await getSettings()
      await saveSettings({ ...current, ...patch })
    } catch {}
  }, [])

  const setPreset = useCallback(
    (p: ThemePreset) => {
      setPresetState(p)
      setCustomAccentState('')
      persist({ themePreset: p, accentColor: '' })
    },
    [persist],
  )
  const setCustomAccent = useCallback(
    (hex: string) => {
      setCustomAccentState(hex)
      persist({ accentColor: hex })
    },
    [persist],
  )
  const setMotionLevel = useCallback(
    (m: MotionLevel) => {
      setMotionState(m)
      persist({ motionLevel: m })
    },
    [persist],
  )
  const setDisplayName = useCallback(
    (name: string) => {
      setDisplayNameState(name)
      persist({ displayName: name })
    },
    [persist],
  )

  const value = useMemo<ThemeValue>(() => {
    const { accent, gradient } = accentFor(preset, customAccent)
    return {
      accent,
      accentSoft: withAlpha(accent, 0.16),
      gradient,
      preset,
      customAccent,
      motionLevel,
      displayName,
      reduceMotion: motionLevel === 'calm',
      setPreset,
      setCustomAccent,
      setMotionLevel,
      setDisplayName,
    }
  }, [preset, customAccent, motionLevel, displayName, setPreset, setCustomAccent, setMotionLevel, setDisplayName])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    // Safe fallback so components used outside the provider still render.
    const def = THEME_PRESETS[0]
    return {
      accent: def.accent,
      accentSoft: withAlpha(def.accent, 0.16),
      gradient: def.gradient,
      preset: DEFAULT_PRESET,
      customAccent: '',
      motionLevel: 'playful',
      displayName: '',
      reduceMotion: false,
      setPreset: () => {},
      setCustomAccent: () => {},
      setMotionLevel: () => {},
      setDisplayName: () => {},
    }
  }
  return ctx
}
