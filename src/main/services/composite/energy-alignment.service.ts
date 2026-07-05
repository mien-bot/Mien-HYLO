/**
 * Energy alignment — overlays today's scheduled blocks against predicted
 * circadian energy phases. Tags each block as aligned / misaligned / neutral
 * so the Dashboard timeline can colour-code them.
 */

import { getDb } from '../../db/database'
import { parseSleepSessions, predictCircadianRhythm } from '../health/sleep-analysis'

export interface AlignedBlock {
  start: string
  end: string
  title: string
  type: string
  phase: string
  level: string
  alignment: 'aligned' | 'misaligned' | 'neutral'
  reason: string
}

function parseTime(t: string): number {
  const m = t.match(/(\d{1,2}):(\d{2})/)
  if (!m) return 0
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60
}

function timeInPhase(timeHr: number, startHr: number, endHr: number): boolean {
  if (endHr >= startHr) return timeHr >= startHr && timeHr <= endHr
  // wraps midnight
  return timeHr >= startHr || timeHr <= endHr
}

const HIGH_FOCUS_TYPES = ['deep', 'focus', 'work', 'creative', 'writing', 'coding']
const PHYSICAL_TYPES = ['workout', 'exercise', 'gym', 'run', 'training']
const LIGHT_TYPES = ['admin', 'email', 'review', 'meeting', 'break', 'lunch']

function classify(blockType: string): 'high-focus' | 'physical' | 'light' | 'other' {
  const t = blockType.toLowerCase()
  if (HIGH_FOCUS_TYPES.some((k) => t.includes(k))) return 'high-focus'
  if (PHYSICAL_TYPES.some((k) => t.includes(k))) return 'physical'
  if (LIGHT_TYPES.some((k) => t.includes(k))) return 'light'
  return 'other'
}

export function getEnergyAlignment(date?: string): AlignedBlock[] {
  const today = date || new Date().toISOString().slice(0, 10)
  const db = getDb()
  const row = db
    .prepare(
      `
    SELECT schedule_json FROM daily_schedule WHERE date = ? LIMIT 1
  `,
    )
    .get(today) as { schedule_json: string } | undefined
  if (!row) return []

  let blocks: any[] = []
  try {
    const parsed = JSON.parse(row.schedule_json)
    blocks = parsed.blocks || parsed.schedule || (Array.isArray(parsed) ? parsed : [])
  } catch {
    return []
  }

  const sessions = parseSleepSessions(14)
  if (sessions.length === 0) return []
  const rhythm = predictCircadianRhythm(sessions)
  const phases = rhythm.energyPhases.map((p) => ({
    name: p.name,
    level: p.level,
    start: parseTime(p.start),
    end: parseTime(p.end),
    description: p.description,
  }))

  return blocks
    .map((b: any): AlignedBlock | null => {
      const start = b.start || b.startTime || b.from || ''
      const end = b.end || b.endTime || b.to || ''
      const startHr = parseTime(start)
      if (!start || !end) return null

      const phase = phases.find((p) => timeInPhase(startHr, p.start, p.end))
      if (!phase) return null

      const type = classify(b.type || b.category || b.kind || '')
      let alignment: AlignedBlock['alignment'] = 'neutral'
      let reason = ''

      if (type === 'high-focus') {
        if (phase.level === 'peak') {
          alignment = 'aligned'
          reason = `Peak focus window — ideal for ${b.title || 'this task'}.`
        } else if (phase.level === 'dipping' || phase.level === 'low') {
          alignment = 'misaligned'
          reason = `${phase.name} — cognitive performance is below your baseline here.`
        } else {
          reason = `${phase.name} — workable but not peak.`
        }
      } else if (type === 'physical') {
        if (phase.level === 'peak' || phase.level === 'rising') {
          alignment = 'aligned'
          reason = `${phase.name} — body temperature and reaction time peak here.`
        } else if (phase.level === 'winding_down') {
          alignment = 'misaligned'
          reason = `Late workout may push back melatonin and hurt sleep onset.`
        } else {
          reason = `${phase.name} — acceptable training window.`
        }
      } else if (type === 'light') {
        if (phase.level === 'dipping' || phase.level === 'low') {
          alignment = 'aligned'
          reason = `Low-cognition tasks fit your ${phase.name.toLowerCase()} window.`
        } else if (phase.level === 'peak') {
          alignment = 'misaligned'
          reason = `Wasting peak time on routine work — swap with a deep-work block if you can.`
        } else {
          reason = `${phase.name}.`
        }
      } else {
        reason = phase.description || `${phase.name}.`
      }

      return {
        start,
        end,
        title: b.title || b.name || '',
        type: b.type || b.category || 'other',
        phase: phase.name,
        level: phase.level,
        alignment,
        reason,
      }
    })
    .filter((b): b is AlignedBlock => b !== null)
}
