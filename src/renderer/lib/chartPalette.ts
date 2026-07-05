import type { PaletteName } from '../components/charts/tokens'

export function applyChartPalette(palette: PaletteName) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-palette', palette)
}

export function readStoredPalette(): PaletteName {
  if (typeof document === 'undefined') return 'default'
  const attr = document.documentElement.getAttribute('data-palette') as PaletteName | null
  return attr || 'default'
}
