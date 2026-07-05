export function safeDiv(numerator: number | null | undefined, denominator: number | null | undefined, fallback = 0): number {
  const n = Number(numerator)
  const d = Number(denominator)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return fallback
  return n / d
}

export function safePct(numerator: number | null | undefined, denominator: number | null | undefined, fallback = 0): number {
  return safeDiv(numerator, denominator, fallback) * 100
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}
