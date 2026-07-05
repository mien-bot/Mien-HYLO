/**
 * Productivity service — daily schedule generation and management
 */
import { getDb } from '../lib/database'
import { generateAnalysis } from './ai.service'

export interface FixedBlock {
  start: string   // HH:MM
  end: string     // HH:MM
  label: string
}

export interface SchedulePreferences {
  specialToday?: string
  afterWorkTasks?: string
  workBlocks?: { project: string; duration: string }[]
  fixedBlocks?: FixedBlock[]
  eveningMode?: string
  customEvening?: string
  exerciseType?: string
  workStartTime?: string
  workEndTime?: string
  sleepTarget?: string
}

export interface DailySchedule {
  id: number
  date: string
  schedule_json: string
  ai_rationale: string | null
  created_at: string
}

const DAILY_PLANNER_PROMPT = `You are a productivity optimizer creating a time-blocked daily schedule based on the user's preferences.

**HIGHEST PRIORITY RULE — LOCKED TIME BLOCKS:**
If the user supplies a "LOCKED TIME BLOCKS" section, those blocks are immovable hard constraints. Every locked block MUST appear in the final JSON schedule with its exact \`time\` range and an \`activity\` matching its label. Do NOT split, shift, shorten, omit, or rename them. Plan everything else around them.

This is a WEEKDAY schedule. Work hours are blocked — keep them as morning block + lunch + afternoon block.
Focus your optimization on the AFTER-WORK schedule: schedule each project as its own dedicated focus block, fit in errands/tasks, then the evening activity.

Output format:
- Time-blocked schedule from wake to sleep
- Each block: time range, activity, and brief rationale
- Format as a JSON array: { "time": "HH:MM-HH:MM", "activity": "...", "rationale": "..." }
- Wrap the JSON in a \`\`\`json code block`

export async function getTodaySchedule(): Promise<DailySchedule | null> {
  const db = await getDb()
  const today = new Date().toISOString().split('T')[0]
  const row = await db.getFirstAsync(
    'SELECT * FROM daily_schedule WHERE date = ?', today
  ) as any
  return row || null
}

export async function generateDailySchedule(prefs?: SchedulePreferences): Promise<DailySchedule | null> {
  const db = await getDb()
  const today = new Date().toISOString().split('T')[0]
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' })

  let prefsContext = ''
  if (prefs) {
    if (prefs.fixedBlocks && prefs.fixedBlocks.length > 0) {
      const sorted = [...prefs.fixedBlocks].sort((a, b) => a.start.localeCompare(b.start))
      prefsContext += '\n## LOCKED TIME BLOCKS — DO NOT MOVE\n'
      for (const b of sorted) prefsContext += `- ${b.start}-${b.end} — ${b.label}\n`
      prefsContext += `These appear in the final schedule verbatim. Plan around them.\n`
    }
    prefsContext += '\n## User Preferences for Today\n'
    if (prefs.specialToday) prefsContext += `- What's special today: ${prefs.specialToday}\n`
    if (prefs.workBlocks && prefs.workBlocks.length > 0) {
      prefsContext += `- After-work project blocks:\n`
      for (const b of prefs.workBlocks) prefsContext += `  - ${b.project}: ${b.duration}\n`
    }
    if (prefs.afterWorkTasks) prefsContext += `- Other tasks/errands: ${prefs.afterWorkTasks}\n`
    if (prefs.eveningMode) {
      const labels: Record<string, string> = {
        'exercise-then-work': `Exercise first (${prefs.exerciseType || 'run'}) — exercise ~1h, eat, then projects until late`,
        'straight-to-work': 'Eat, then straight into projects until late',
        'relax': 'Eat, relax — watch a movie or chill, sleep by midnight',
        'hangout': 'Social evening with friends/family',
        'sleep-early': 'Eat, wind down early, maximize recovery',
        'custom': prefs.customEvening || 'Custom plan',
      }
      prefsContext += `- Evening plan: ${labels[prefs.eveningMode] || prefs.eveningMode}\n`
    }
    const workStart = prefs.workStartTime || '09:30'
    const workEnd = prefs.workEndTime || '18:00'
    const sleepBy = prefs.sleepTarget || '02:00'
    prefsContext += `- Work hours: ${workStart} to ${workEnd}\n`
    prefsContext += `- Sleep target: ${sleepBy}\n`
    prefsContext += `\nKeep work hours blocked. Commute ~20 min. Schedule each project as its own block. Be specific with times.\n`
  }

  const userPrompt = `Today is ${today} (${dayName}).${prefsContext}\n\nGenerate my optimized daily schedule.`

  const response = await generateAnalysis(DAILY_PLANNER_PROMPT, userPrompt)

  let scheduleJson = response
  let rationale: string | null = null

  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/)
  if (jsonMatch) {
    scheduleJson = jsonMatch[1].trim()
    rationale = response.replace(/```json[\s\S]*?```/, '').trim() || null
  } else {
    const arrayMatch = response.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      scheduleJson = arrayMatch[0]
      rationale = response.replace(scheduleJson, '').trim() || null
    }
  }

  let parsed: any = null
  try {
    parsed = JSON.parse(scheduleJson)
  } catch {
    parsed = [{ time: 'N/A', activity: 'See rationale', rationale: response }]
    rationale = response
  }

  if (prefs?.fixedBlocks && prefs.fixedBlocks.length > 0 && Array.isArray(parsed)) {
    parsed = enforceLockedBlocks(parsed, prefs.fixedBlocks)
  }

  scheduleJson = JSON.stringify(parsed)

  await db.runAsync(
    `INSERT OR REPLACE INTO daily_schedule (date, schedule_json, ai_rationale) VALUES (?, ?, ?)`,
    today, scheduleJson, rationale
  )

  return getTodaySchedule()
}

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return NaN
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

function parseBlockRange(time: string): { start: number; end: number } | null {
  const m = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/.exec(time.trim())
  if (!m) return null
  const start = toMinutes(m[1])
  const end = toMinutes(m[2])
  if (isNaN(start) || isNaN(end)) return null
  return { start, end }
}

function enforceLockedBlocks(
  schedule: Array<{ time: string; activity: string; rationale?: string }>,
  locked: FixedBlock[]
): Array<{ time: string; activity: string; rationale?: string }> {
  const lockedRanges = locked
    .map(b => ({
      start: toMinutes(b.start),
      end: toMinutes(b.end),
      label: b.label,
      time: `${b.start}-${b.end}`,
    }))
    .filter(b => !isNaN(b.start) && !isNaN(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start)

  if (lockedRanges.length === 0) return schedule

  const survivors = schedule.filter(block => {
    const range = parseBlockRange(block.time)
    if (!range) return true
    return !lockedRanges.some(l => range.start < l.end && range.end > l.start)
  })

  const lockedAsBlocks = lockedRanges.map(l => ({
    time: l.time,
    activity: l.label,
    rationale: 'Locked time block (user-specified, immovable).',
  }))

  const combined = [...survivors, ...lockedAsBlocks]
  combined.sort((a, b) => {
    const ra = parseBlockRange(a.time)
    const rb = parseBlockRange(b.time)
    if (!ra && !rb) return 0
    if (!ra) return 1
    if (!rb) return -1
    return ra.start - rb.start
  })
  return combined
}
