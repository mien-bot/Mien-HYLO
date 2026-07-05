// Safe wrappers around Date parsing. `new Date()` does not throw on garbage
// input — it returns Invalid Date whose getTime()/getHours() return NaN and
// whose toLocaleTimeString() returns "Invalid Date". These helpers guard
// every consumer of sleepStart/sleepEnd which may arrive empty or malformed
// from HealthKit / Health Auto Export / relay sync.

// Health Auto Export emits "YYYY-MM-DD HH:MM:SS ±HHMM" (e.g. "2026-05-24 02:05:23 -0500").
// V8 parses this; Hermes/JSC return Invalid Date — coerce to ISO 8601 first.
function coerceDate(iso: string): Date {
  const d = new Date(iso)
  if (!isNaN(d.getTime())) return d
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/)
  if (m) return new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`)
  return d
}

export function safeDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = coerceDate(iso)
  return isNaN(d.getTime()) ? null : d
}

export function safeFormatTime(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback
  const d = coerceDate(iso)
  if (!isNaN(d.getTime())) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  // Fallback: if stored as HH:MM or HH:MM:SS (time-only string), extract the HH:MM portion
  if (/^\d{2}:\d{2}/.test(iso)) return iso.substring(0, 5)
  return fallback
}

// Returns hour-of-day as a decimal (e.g. 23.5 = 11:30 PM). Returns null for
// invalid input so callers can filter cleanly instead of propagating NaN.
export function safeHourOfDay(iso: string | null | undefined): number | null {
  const d = safeDate(iso)
  if (!d) return null
  return d.getHours() + d.getMinutes() / 60
}
