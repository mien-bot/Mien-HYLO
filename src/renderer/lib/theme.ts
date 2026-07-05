// Theme engine for the renderer. Mirrors the lightweight attribute-based
// approach used by chartPalette.ts: presets are defined as [data-theme="…"]
// blocks in globals.css; we only flip attributes / inline custom values here.

export type ThemePreset = 'ramen' | 'midnight' | 'ocean' | 'matcha' | 'sakura'
export type MotionLevel = 'calm' | 'playful'

export const THEME_PRESETS: { id: ThemePreset; label: string; swatch: string }[] = [
  { id: 'ramen', label: 'Ramen', swatch: '#f97316' },
  { id: 'midnight', label: 'Midnight', swatch: '#818cf8' },
  { id: 'ocean', label: 'Ocean', swatch: '#0a84ff' },
  { id: 'matcha', label: 'Matcha', swatch: '#34c759' },
  { id: 'sakura', label: 'Sakura', swatch: '#ff7eb3' },
]

const ACCENT_VARS = ['--accent', '--accent-strong', '--accent-soft', '--accent-gradient', '--glow-accent', '--bg-glow', '--accent-blue'] as const

/** Apply a named theme preset (recolors via the [data-theme] block in CSS). */
export function applyTheme(preset: ThemePreset) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', preset)
}

/**
 * Apply a free-form custom accent color, overriding the preset's accent via
 * inline custom properties on <html>. Pass an empty string to clear the
 * override and fall back to the active preset.
 */
export function applyAccent(hex: string) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const clean = (hex || '').trim()
  if (!clean) {
    ACCENT_VARS.forEach((v) => root.style.removeProperty(v))
    return
  }
  const strong = shade(clean, -0.18)
  const soft = rgba(clean, 0.15)
  const lighter = shade(clean, 0.28)
  root.style.setProperty('--accent', clean)
  root.style.setProperty('--accent-strong', strong)
  root.style.setProperty('--accent-soft', soft)
  root.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${lighter} 0%, ${clean} 100%)`)
  root.style.setProperty('--glow-accent', rgba(clean, 0.3))
  root.style.setProperty('--bg-glow', rgba(clean, 0.07))
  // Re-point the de-facto primary token so existing UI recolors too.
  root.style.setProperty('--accent-blue', clean)
}

/** Apply the motion preference (gates decorative/ambient animation in CSS + JS). */
export function applyMotionLevel(level: MotionLevel) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-motion', level)
}

/** True when motion should be suppressed (calm mode or OS reduced-motion). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  const osReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const calm = document.documentElement.getAttribute('data-motion') === 'calm'
  return osReduced || calm
}

// ---- color helpers ----

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const m = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h)
  if (!m) return null
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

function rgba(hex: string, alpha: number): string {
  const c = hexToRgb(hex)
  if (!c) return hex
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`
}

/** Lighten (amount > 0) or darken (amount < 0) a hex color toward white/black. */
function shade(hex: string, amount: number): string {
  const c = hexToRgb(hex)
  if (!c) return hex
  const t = amount < 0 ? 0 : 255
  const p = Math.abs(amount)
  const mix = (ch: number) => Math.round((t - ch) * p + ch)
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(mix(c.r))}${toHex(mix(c.g))}${toHex(mix(c.b))}`
}
