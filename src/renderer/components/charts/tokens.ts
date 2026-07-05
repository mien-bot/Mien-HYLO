export type PaletteName = 'default' | 'colorblind-deuter' | 'colorblind-protan' | 'highcontrast'

export interface ChartPalette {
  positive: string
  negative: string
  neutral: string
  accent: string
  warn: string
  cool: string
  warm: string
  muted: string
  background: string
  cardBackground: string
  separator: string
  text: string
  textSecondary: string
  textMuted: string
  heatRamp: string[]
  zoneGood: string
  zoneOk: string
  zoneBad: string
}

const palettes: Record<PaletteName, ChartPalette> = {
  default: {
    positive: 'var(--accent-green)',
    negative: 'var(--accent-red)',
    neutral: 'var(--accent-blue)',
    accent: 'var(--accent-purple)',
    warn: 'var(--accent-amber)',
    cool: 'var(--accent-cyan)',
    warm: 'var(--accent-orange)',
    muted: 'var(--text-muted)',
    background: 'var(--bg-primary)',
    cardBackground: 'var(--bg-card)',
    separator: 'var(--separator)',
    text: 'var(--text-primary)',
    textSecondary: 'var(--text-secondary)',
    textMuted: 'var(--text-muted)',
    heatRamp: ['#0a2540', '#0a84ff', '#64d2ff', '#30d158', '#ffd60a', '#ff9f0a', '#ff453a'],
    zoneGood: 'var(--accent-green)',
    zoneOk: 'var(--accent-amber)',
    zoneBad: 'var(--accent-red)',
  },
  'colorblind-deuter': {
    positive: '#0072B2',
    negative: '#D55E00',
    neutral: '#56B4E9',
    accent: '#CC79A7',
    warn: '#F0E442',
    cool: '#009E73',
    warm: '#E69F00',
    muted: 'var(--text-muted)',
    background: 'var(--bg-primary)',
    cardBackground: 'var(--bg-card)',
    separator: 'var(--separator)',
    text: 'var(--text-primary)',
    textSecondary: 'var(--text-secondary)',
    textMuted: 'var(--text-muted)',
    heatRamp: ['#000033', '#0072B2', '#56B4E9', '#F0E442', '#E69F00', '#D55E00', '#CC79A7'],
    zoneGood: '#0072B2',
    zoneOk: '#F0E442',
    zoneBad: '#D55E00',
  },
  'colorblind-protan': {
    positive: '#0072B2',
    negative: '#E69F00',
    neutral: '#56B4E9',
    accent: '#999999',
    warn: '#F0E442',
    cool: '#009E73',
    warm: '#CC79A7',
    muted: 'var(--text-muted)',
    background: 'var(--bg-primary)',
    cardBackground: 'var(--bg-card)',
    separator: 'var(--separator)',
    text: 'var(--text-primary)',
    textSecondary: 'var(--text-secondary)',
    textMuted: 'var(--text-muted)',
    heatRamp: ['#000033', '#56B4E9', '#0072B2', '#F0E442', '#E69F00', '#CC79A7', '#999999'],
    zoneGood: '#0072B2',
    zoneOk: '#F0E442',
    zoneBad: '#E69F00',
  },
  highcontrast: {
    positive: '#00ff88',
    negative: '#ff3344',
    neutral: '#00ccff',
    accent: '#ff66ff',
    warn: '#ffaa00',
    cool: '#00ffff',
    warm: '#ff8800',
    muted: '#999999',
    background: '#000000',
    cardBackground: '#0a0a0a',
    separator: '#ffffff',
    text: '#ffffff',
    textSecondary: '#dddddd',
    textMuted: '#999999',
    heatRamp: ['#000000', '#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff8800', '#ff0000'],
    zoneGood: '#00ff88',
    zoneOk: '#ffaa00',
    zoneBad: '#ff3344',
  },
}

export function getPalette(name: PaletteName = 'default'): ChartPalette {
  return palettes[name] || palettes.default
}

export function paletteFromAttribute(): PaletteName {
  if (typeof document === 'undefined') return 'default'
  const attr = document.documentElement.getAttribute('data-palette') as PaletteName | null
  return attr && palettes[attr] ? attr : 'default'
}

export const tooltipStyle = {
  background: '#1a1a1a',
  border: '1px solid #2a2a2a',
  borderRadius: '8px',
  fontSize: '12px',
  color: '#e5e5e5',
  padding: '8px 10px',
}

export function interpolateRamp(ramp: string[], t: number): string {
  if (ramp.length === 0) return '#000'
  const clamped = Math.max(0, Math.min(1, t))
  const scaled = clamped * (ramp.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  if (i >= ramp.length - 1) return ramp[ramp.length - 1]
  return mixHex(ramp[i], ramp[i + 1], f)
}

function mixHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a)
  const pb = hexToRgb(b)
  if (!pa || !pb) return a
  const r = Math.round(pa.r + (pb.r - pa.r) * t)
  const g = Math.round(pa.g + (pb.g - pa.g) * t)
  const bl = Math.round(pa.b + (pb.b - pa.b) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return null
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}
