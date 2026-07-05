/**
 * Health Trends Service — fetches monthly aggregate trends from relay
 * for historical analysis of sleep, HRV, steps, heart rate, etc.
 */
import { getSettings } from '../lib/storage'

export interface MonthlyDataPoint {
  month: string        // YYYY-MM
  avg: number
  count: number
  // Sleep-specific
  avgDeep?: number
  avgRem?: number
  avgCore?: number
  avgInBed?: number
  avgEfficiency?: number
}

export interface TrendsSummary {
  totalMonths: number
  totalDataPoints: number
  metricTypes: string[]
  sleepTrendDirection?: 'improving' | 'declining' | 'stable'
  recentAvgSleep?: number
  oldestAvgSleep?: number
}

export interface HealthTrends {
  trends: Record<string, MonthlyDataPoint[]>
  summary: TrendsSummary
}

export async function fetchHealthTrends(months: number = 36): Promise<HealthTrends | null> {
  const settings = await getSettings()
  const relayUrl = settings.relayUrl?.replace(/\/$/, '')
  if (!relayUrl) return null

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.relayToken) {
    headers['Authorization'] = `Bearer ${settings.relayToken}`
  }

  try {
    const res = await fetch(`${relayUrl}/health/trends?months=${months}`, { headers })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Compute insights from trend data
 */
export function computeTrendInsights(trends: HealthTrends): TrendInsight[] {
  const insights: TrendInsight[] = []
  const sleep = trends.trends.sleep || []
  const hrv = trends.trends.hrv || []
  const steps = trends.trends.steps || []
  const rhr = trends.trends.resting_heart_rate || []

  if (sleep.length >= 3) {
    // Sleep duration trend
    const recent = sleep.slice(-3)
    const recentAvg = recent.reduce((s, m) => s + m.avg, 0) / recent.length
    const recentAvgHrs = recentAvg / 60

    if (sleep.length >= 6) {
      const older = sleep.slice(-6, -3)
      const olderAvg = older.reduce((s, m) => s + m.avg, 0) / older.length
      const olderAvgHrs = olderAvg / 60
      const diff = recentAvgHrs - olderAvgHrs

      if (Math.abs(diff) >= 0.2) {
        insights.push({
          type: 'sleep_duration',
          direction: diff > 0 ? 'up' : 'down',
          title: diff > 0 ? 'Sleep Duration Improving' : 'Sleep Duration Declining',
          detail: `Recent 3 months: ${recentAvgHrs.toFixed(1)}h avg vs prior 3 months: ${olderAvgHrs.toFixed(1)}h (${diff > 0 ? '+' : ''}${diff.toFixed(1)}h)`,
          severity: diff > 0 ? 'good' : recentAvgHrs < 6.5 ? 'bad' : 'neutral',
        })
      }
    }

    // Deep sleep trend
    const recentDeep = recent.filter(m => m.avgDeep).map(m => m.avgDeep!)
    if (recentDeep.length > 0 && sleep.length >= 6) {
      const recentDeepAvg = recentDeep.reduce((a, b) => a + b, 0) / recentDeep.length
      const older = sleep.slice(-6, -3).filter(m => m.avgDeep).map(m => m.avgDeep!)
      if (older.length > 0) {
        const olderDeepAvg = older.reduce((a, b) => a + b, 0) / older.length
        const deepDiff = recentDeepAvg - olderDeepAvg
        if (Math.abs(deepDiff) >= 5) {
          insights.push({
            type: 'deep_sleep',
            direction: deepDiff > 0 ? 'up' : 'down',
            title: deepDiff > 0 ? 'Deep Sleep Increasing' : 'Deep Sleep Decreasing',
            detail: `Recent: ${Math.round(recentDeepAvg)}min avg vs prior: ${Math.round(olderDeepAvg)}min (${deepDiff > 0 ? '+' : ''}${Math.round(deepDiff)}min)`,
            severity: deepDiff > 0 ? 'good' : 'bad',
          })
        }
      }
    }

    // Best and worst months
    const sorted = [...sleep].sort((a, b) => b.avg - a.avg)
    if (sorted.length >= 4) {
      insights.push({
        type: 'best_month',
        direction: 'up',
        title: 'Best Sleep Month',
        detail: `${formatMonth(sorted[0].month)}: ${(sorted[0].avg / 60).toFixed(1)}h avg (${sorted[0].count} nights)`,
        severity: 'good',
      })
      const worst = sorted[sorted.length - 1]
      insights.push({
        type: 'worst_month',
        direction: 'down',
        title: 'Worst Sleep Month',
        detail: `${formatMonth(worst.month)}: ${(worst.avg / 60).toFixed(1)}h avg (${worst.count} nights)`,
        severity: 'bad',
      })
    }
  }

  // HRV trend
  if (hrv.length >= 6) {
    const recentHrv = hrv.slice(-3)
    const olderHrv = hrv.slice(-6, -3)
    const recentAvg = recentHrv.reduce((s, m) => s + m.avg, 0) / recentHrv.length
    const olderAvg = olderHrv.reduce((s, m) => s + m.avg, 0) / olderHrv.length
    const diff = recentAvg - olderAvg

    if (Math.abs(diff) >= 3) {
      insights.push({
        type: 'hrv',
        direction: diff > 0 ? 'up' : 'down',
        title: diff > 0 ? 'HRV Trending Up' : 'HRV Trending Down',
        detail: `Recent: ${Math.round(recentAvg)}ms vs prior: ${Math.round(olderAvg)}ms (${diff > 0 ? '+' : ''}${Math.round(diff)}ms)`,
        severity: diff > 0 ? 'good' : 'bad',
      })
    }
  }

  // Resting HR trend (lower is better)
  if (rhr.length >= 6) {
    const recentRhr = rhr.slice(-3)
    const olderRhr = rhr.slice(-6, -3)
    const recentAvg = recentRhr.reduce((s, m) => s + m.avg, 0) / recentRhr.length
    const olderAvg = olderRhr.reduce((s, m) => s + m.avg, 0) / olderRhr.length
    const diff = recentAvg - olderAvg

    if (Math.abs(diff) >= 2) {
      insights.push({
        type: 'resting_hr',
        direction: diff < 0 ? 'up' : 'down', // Lower RHR = better
        title: diff < 0 ? 'Resting HR Improving' : 'Resting HR Rising',
        detail: `Recent: ${Math.round(recentAvg)} bpm vs prior: ${Math.round(olderAvg)} bpm (${diff > 0 ? '+' : ''}${Math.round(diff)})`,
        severity: diff < 0 ? 'good' : 'bad',
      })
    }
  }

  // Steps trend
  if (steps.length >= 6) {
    const recentSteps = steps.slice(-3)
    const olderSteps = steps.slice(-6, -3)
    const recentAvg = recentSteps.reduce((s, m) => s + m.avg, 0) / recentSteps.length
    const olderAvg = olderSteps.reduce((s, m) => s + m.avg, 0) / olderSteps.length
    const diff = recentAvg - olderAvg

    if (Math.abs(diff) >= 500) {
      insights.push({
        type: 'steps',
        direction: diff > 0 ? 'up' : 'down',
        title: diff > 0 ? 'Activity Increasing' : 'Activity Decreasing',
        detail: `Recent: ${Math.round(recentAvg).toLocaleString()} steps/day vs prior: ${Math.round(olderAvg).toLocaleString()} (${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString()})`,
        severity: diff > 0 ? 'good' : 'neutral',
      })
    }
  }

  return insights
}

export interface TrendInsight {
  type: string
  direction: 'up' | 'down'
  title: string
  detail: string
  severity: 'good' | 'bad' | 'neutral'
}

function formatMonth(monthStr: string): string {
  const [year, month] = monthStr.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[parseInt(month) - 1]} ${year}`
}
