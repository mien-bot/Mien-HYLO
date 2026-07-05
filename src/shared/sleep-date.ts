export interface SleepLikeEntry {
  sleepEnd?: string | null
  end?: string | null
  endDate?: string | null
  sleepStart?: string | null
  start?: string | null
  startDate?: string | null
  date?: string | null
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function localDateOf(timestamp: string | Date): string | null {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp)
  if (isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function wakeDateFor(entry: SleepLikeEntry): string | null {
  const endRaw = entry.sleepEnd || entry.end || entry.endDate
  if (endRaw) {
    const d = new Date(endRaw)
    if (!isNaN(d.getTime())) return localDateOf(d)
  }
  const startRaw = entry.sleepStart || entry.start || entry.startDate || entry.date
  if (startRaw) {
    const start = new Date(startRaw)
    if (!isNaN(start.getTime())) {
      // No end timestamp — assume a 6h minimum sleep and use that wake date.
      const fallback = new Date(start.getTime() + 6 * 60 * 60 * 1000)
      return localDateOf(fallback)
    }
  }
  return null
}
