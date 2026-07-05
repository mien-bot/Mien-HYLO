// Shared SVG geometry for every noodle-themed visual.
// Single source of truth — tweak here and BreadLogo, NoodleSpinner,
// NoodleIllustration all stay in sync.

export const NOODLE_VIEWBOX = '0 0 64 64'

export const CHOPSTICK_PATHS = [
  { x1: 27, y1: 13, x2: 40, y2: 23 },
  { x1: 31, y1: 11, x2: 42.5, y2: 22 },
]

// 5 dangling noodle strands from chopsticks — long, squiggly curves into the bowl
export const DANGLING_NOODLE_PATHS = [
  'M33 21 C31 24, 35 26, 33 28 C31 30, 34 32, 32 35',
  'M35 20.5 C33 23, 37 25, 35 27.5 C33 30, 36 32, 34 34.5',
  'M37 20 C35 22.5, 39 24.5, 37 27 C35 29.5, 38 31.5, 36 34',
  'M39 19.5 C37 22, 41 24, 39 26.5 C37 29, 40 31, 38 33.5',
  'M41 19 C39 21.5, 43 23.5, 41 26 C39 28.5, 42 30.5, 40 33',
]

export const DANGLING_NOODLE_PATHS_ALT = [
  'M33 21 C35 23.5, 31 26, 34 28.5 C36 30.5, 30 33, 33 35',
  'M35 20.5 C37 23, 33 25.5, 36 27.5 C38 30, 32 32, 35 34.5',
  'M37 20 C39 22, 35 24.5, 38 27 C40 29, 34 31.5, 37 34',
  'M39 19.5 C41 22, 37 24.5, 40 26.5 C42 29, 36 31, 39 33.5',
  'M41 19 C43 21.5, 39 24, 42 26 C44 28.5, 38 30.5, 41 33',
]

export const BOWL_RIM = { cx: 32, cy: 29.5, rx: 19, ry: 4 }
export const BOWL_BODY = 'M13 29.5 C13 29.5, 15 49, 32 49 C49 49, 51 29.5, 51 29.5'
export const BOWL_BASE = { x: 27, y: 48.5, width: 10, height: 3, rx: 0.5 }

// 5 noodle strands inside the bowl (was 2) — wavy lines filling the bowl
export const INSIDE_NOODLE_PATHS = [
  'M17 31 C20 34, 24 32, 28 34 C32 36, 36 33, 40 34 C43 35, 45 33, 47 34',
  'M18 33.5 C21 36, 25 34, 29 36.5 C33 39, 37 35.5, 41 37 C44 38, 46 36, 47 36.5',
  'M19 36 C22 38.5, 26 36.5, 30 38.5 C34 40.5, 38 38, 42 39.5',
  'M20 38.5 C23 41, 27 39, 31 41 C35 43, 39 40, 43 41.5',
  'M22 41 C25 43, 29 41, 33 43 C37 44.5, 40 42.5, 42 43',
]

export const INSIDE_NOODLE_PATHS_ALT = [
  'M17 31 C21 33, 24 35, 28 33 C32 31, 37 35, 40 33 C43 31, 46 34, 47 33',
  'M18 33.5 C22 35, 25 37.5, 29 35 C33 33, 38 37, 41 35.5 C44 34, 46 37, 47 35',
  'M19 36 C23 38, 26 40, 30 37 C34 35, 39 39, 42 38',
  'M20 38.5 C24 40, 27 42.5, 31 39.5 C35 37, 40 41, 43 40',
  'M22 41 C26 43, 29 40.5, 33 42 C37 43.5, 40 41, 42 42',
]

// Steam puff positions — 5 puffs (was 3) for a fuller steam effect
export const STEAM_PUFFS = [
  { cx: 24, cy: 19, rx: 1.3, ry: 2.0 },
  { cx: 28, cy: 17, rx: 1.6, ry: 2.3 },
  { cx: 32, cy: 16, rx: 1.8, ry: 2.4 },
  { cx: 36, cy: 17, rx: 1.6, ry: 2.3 },
  { cx: 40, cy: 19, rx: 1.3, ry: 2.0 },
]
