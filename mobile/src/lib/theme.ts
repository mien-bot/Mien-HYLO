export const colors = {
  bg: {
    primary: '#000000',
    secondary: '#1c1c1e',
    card: '#1c1c1e',
    tertiary: '#2c2c2e',
  },
  text: {
    primary: '#f5f5f7',
    secondary: '#a1a1a6',
    muted: '#6e6e73',
  },
  accent: {
    blue: '#0a84ff',
    green: '#30d158',
    red: '#ff453a',
    purple: '#bf5af2',
    amber: '#ff9f0a',
    cyan: '#64d2ff',
    orange: '#f97316',
  },
  border: 'rgba(255, 255, 255, 0.08)',
  separator: '#38383a',
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
}

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
}

/** Font family names registered via expo-font in App.tsx (Nunito display face). */
export const fonts = {
  display: 'Nunito_800ExtraBold',
  displaySemi: 'Nunito_700Bold',
  displayRegular: 'Nunito_400Regular',
}

export const typography = {
  largeTitle: { fontSize: 32, fontWeight: '700' as const, letterSpacing: 0.4 },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: 0.3 },
  headline: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 22 },
  callout: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, fontWeight: '500' as const },
  caption2: { fontSize: 11, fontWeight: '500' as const },
  // Cozy display variants (use Nunito). fontWeight is baked into the family.
  display: { fontFamily: fonts.display, fontSize: 28, letterSpacing: -0.3 },
  displayLarge: { fontFamily: fonts.display, fontSize: 34, letterSpacing: -0.4 },
}

/** Elevation presets — cards read as physical objects, not bordered rectangles. */
export const elevation = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  raised: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
}

export type ThemePreset = 'ramen' | 'midnight' | 'ocean' | 'matcha' | 'sakura'
export type MotionLevel = 'calm' | 'playful'

export interface PresetDef {
  id: ThemePreset
  label: string
  accent: string
  gradient: [string, string]
}

export const THEME_PRESETS: PresetDef[] = [
  { id: 'ramen', label: 'Ramen', accent: '#f97316', gradient: ['#ffb84d', '#f97316'] },
  { id: 'midnight', label: 'Midnight', accent: '#818cf8', gradient: ['#a5b4fc', '#6366f1'] },
  { id: 'ocean', label: 'Ocean', accent: '#0a84ff', gradient: ['#64d2ff', '#0a84ff'] },
  { id: 'matcha', label: 'Matcha', accent: '#34c759', gradient: ['#7ee787', '#34c759'] },
  { id: 'sakura', label: 'Sakura', accent: '#ff7eb3', gradient: ['#ffb3d1', '#ff7eb3'] },
]

export const DEFAULT_PRESET: ThemePreset = 'ramen'

/** Append an 8-bit alpha (0..1) to a #rrggbb hex → #rrggbbaa. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  return `${hex}${a}`
}

/** Lighten a hex toward white (amount 0..1). Used to build accent gradients. */
export function lighten(hex: string, amount: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.replace('#', ''))
  if (!m) return hex
  const ch = [m[1], m[2], m[3]].map((c) => {
    const n = parseInt(c, 16)
    return Math.round(n + (255 - n) * amount)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${ch.join('')}`
}
