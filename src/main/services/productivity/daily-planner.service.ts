import { getDb } from '../../db/database'
import { generateAnalysisStreaming } from '../ai.service'
import { DAILY_PLANNER_PROMPT } from '../../ai/prompts'
import { getLatestPricesLive } from '../finance'
import { buildSleepAnalysisContext } from '../health/sleep-analysis'
import { formatWeatherForPlanner, getPlannerWeatherPreview } from '../weather.service'

export interface WorkBlock {
  project: string
  details?: string
  duration: string // e.g. "1h", "30m", "1.5h"
}

export interface FixedBlock {
  start: string // HH:MM (24h), e.g. "18:00"
  end: string // HH:MM (24h), e.g. "21:00"
  label: string // e.g. "Work", "Dentist", "Class"
}

export interface SchedulePreferences {
  specialToday?: string // What's special about today
  afterWorkTasks?: string // Other tasks/errands after work
  workBlocks?: WorkBlock[] // Project work blocks to schedule after work
  fixedBlocks?: FixedBlock[] // Immovable time-locked commitments (work, meetings, appts)
  eveningMode?: string // exercise-then-work | straight-to-work | relax | hangout | sleep-early | custom
  customEvening?: string // If eveningMode is custom, what they want
  exerciseType?: string // run | gym | walk | yoga | etc
  exerciseEnabled?: boolean
  exerciseDuration?: string
  wakeTime?: string // Override wake time
  workStartTime?: string // When work starts (default 9:30 AM)
  workEndTime?: string // When work ends (default 6:00 PM)
  sleepTarget?: string // When to stop and sleep (default 2:00 AM)
}

// Default daily habits template - user's typical weekday routine
export const DEFAULT_DAILY_HABITS = [
  { time: '09:00-09:30', activity: 'Wake up & get ready', category: 'routine' },
  { time: '09:30-12:00', activity: 'Work — morning block', category: 'work' },
  { time: '12:00-13:00', activity: 'Lunch', category: 'break' },
  { time: '13:00-18:00', activity: 'Work — afternoon block', category: 'work' },
  { time: '18:00-18:20', activity: 'Commute home', category: 'routine' },
  { time: '18:30-19:30', activity: 'Exercise or free time', category: 'free' },
  { time: '19:30-20:00', activity: 'Dinner', category: 'routine' },
  { time: '20:00-01:00', activity: 'Projects / relax', category: 'free' },
  { time: '01:00-02:00', activity: 'Wind down & sleep', category: 'sleep' },
]

export async function generateDailySchedule(prefs?: SchedulePreferences): Promise<string> {
  const db = getDb()
  const today = new Date().toISOString().split('T')[0]

  // Gather context from all data sources
  const context = await buildPlannerContext()

  const systemPrompt = DAILY_PLANNER_PROMPT

  let prefsContext = ''
  if (prefs) {
    if (prefs.fixedBlocks && prefs.fixedBlocks.length > 0) {
      const sorted = [...prefs.fixedBlocks].sort((a, b) => a.start.localeCompare(b.start))
      prefsContext += '\n## LOCKED TIME BLOCKS — DO NOT MOVE\n'
      for (const b of sorted) {
        prefsContext += `- ${b.start}-${b.end} — ${b.label}\n`
      }
      prefsContext += `These appear in the final schedule verbatim with these exact times. Plan around them. Shrink, shift, or drop other activities to accommodate them.\n`
    }
    prefsContext += '\n## User Preferences for Today\n'
    if (prefs.specialToday) {
      prefsContext += `- What's special today: ${prefs.specialToday}\n`
    }
    if (prefs.workBlocks && prefs.workBlocks.length > 0) {
      prefsContext += `- Project work blocks to schedule:\n`
      for (const block of prefs.workBlocks) {
        const details = block.details ? ` - ${block.details}` : ''
        prefsContext += `  - ${block.project}: ${block.duration}${details}\n`
      }
      prefsContext += `  (Schedule these as dedicated focus blocks. Give each project its own time slot and include the user's project note in the activity name or rationale.)\n`
    }
    if (prefs.afterWorkTasks) {
      prefsContext += `- Other tasks/errands to fit in: ${prefs.afterWorkTasks}\n`
    }
    if (prefs.exerciseEnabled) {
      prefsContext += `- Exercise to fit in separately: ${prefs.exerciseType || 'Exercise'} for ${prefs.exerciseDuration || '1h'}\n`
    }
    if (prefs.eveningMode) {
      const modeLabels: Record<string, string> = {
        'project-work':
          'Prioritize the listed project blocks after work; dinner and breaks should fit around them',
        'exercise-then-work': `Exercise first (${prefs.exerciseType || 'run'}) — leave work, exercise ~1h, come home, eat (~30-40 min), then work on projects until late`,
        'straight-to-work': 'Come home, eat (~30-40 min), then straight into projects until late',
        relax: 'Come home, eat, relax — watch a movie or chill, sleep by midnight',
        hangout: 'Social evening — hanging out with friends/family',
        'sleep-early': 'Come home, eat, wind down early, maximize recovery',
        custom: prefs.customEvening || 'Custom evening plan',
      }
      prefsContext += `- Evening plan: ${modeLabels[prefs.eveningMode] || prefs.eveningMode}\n`
    }

    const workStart = prefs.workStartTime || '09:30'
    const workEnd = prefs.workEndTime || '18:00'
    const sleepBy = prefs.sleepTarget || '02:00'

    prefsContext += `- Work hours: ${workStart} to ${workEnd}\n`
    prefsContext += `- Sleep target: ${sleepBy}\n`
    if (prefs.wakeTime) {
      prefsContext += `- Wake time today: ${prefs.wakeTime}\n`
    }

    prefsContext += `
IMPORTANT: This is a WEEKDAY schedule.
- Work hours (${workStart} to ${workEnd}) are BLOCKED — keep as morning block + lunch + afternoon block. Do NOT break these up.
- Commute home takes ~20 min after work ends.
- Focus your optimization on the AFTER-WORK schedule:
  - If exercise is included, schedule it as its own block; do not treat exercise and project work as a single combined mode.
  - If project work is selected, schedule the project blocks with their requested durations and notes.
  - If relax mode: dinner, then relaxation activities, sleep earlier.
- Schedule each project as its own dedicated focus block with specific times.
- The user works late (until ${sleepBy}) — fill the evening productively based on their chosen mode.
- Be specific with times for every block.\n`
  }

  const userPrompt = `Today is ${today} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })}).

${context}
${prefsContext}

Generate my optimized daily schedule as a JSON array of time blocks. Each block should have: time (HH:MM-HH:MM), activity, and rationale.`

  const response = await generateAnalysisStreaming(
    systemPrompt,
    userPrompt,
    undefined,
    'daily-planner',
  )

  // Try to extract JSON from response
  let scheduleJson = response
  let rationale: string | null = null

  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/)
  if (jsonMatch) {
    scheduleJson = jsonMatch[1].trim()
    // Everything outside the JSON block is the rationale
    rationale = response.replace(/```json[\s\S]*?```/, '').trim() || null
  } else {
    // Try to find a raw JSON array
    const arrayMatch = response.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      scheduleJson = arrayMatch[0]
      rationale = response.replace(scheduleJson, '').trim() || null
    }
  }

  // Validate it's valid JSON
  let parsed: any = null
  try {
    parsed = JSON.parse(scheduleJson)
  } catch {
    // If parsing fails, store the whole response as the schedule
    parsed = [
      {
        time: 'N/A',
        activity: 'See full response below',
        rationale: response,
      },
    ]
    rationale = response
  }

  // Enforce locked blocks: splice them in if the AI omitted, renamed, or moved them
  if (prefs?.fixedBlocks && prefs.fixedBlocks.length > 0 && Array.isArray(parsed)) {
    parsed = enforceLockedBlocks(parsed, prefs.fixedBlocks)
  }

  scheduleJson = JSON.stringify(parsed)

  // Store the schedule
  db.prepare(
    `
    INSERT INTO daily_schedule (date, schedule_json, ai_rationale, updated_at, deleted_at)
    VALUES (?, ?, ?, datetime('now'), NULL)
    ON CONFLICT(date) DO UPDATE SET
      schedule_json = excluded.schedule_json,
      ai_rationale = excluded.ai_rationale,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `,
  ).run(today, scheduleJson, rationale)

  return scheduleJson
}

export function updateTodaySchedule(scheduleJson: string): any {
  let parsed: unknown
  try {
    parsed = JSON.parse(scheduleJson)
  } catch {
    throw new Error('Schedule edits must be valid JSON')
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Schedule edits must be a JSON array')
  }

  const cleaned = parsed.map((block, index) => {
    const item = block as { time?: unknown; activity?: unknown; rationale?: unknown }
    const time = String(item.time || '').trim()
    const activity = String(item.activity || '').trim()
    const rationale = item.rationale == null ? '' : String(item.rationale).trim()
    if (!time || !activity) {
      throw new Error(`Schedule block ${index + 1} needs a time and activity`)
    }
    return { time, activity, rationale }
  })

  const db = getDb()
  const today = new Date().toISOString().split('T')[0]
  db.prepare(
    `
    INSERT INTO daily_schedule (date, schedule_json, ai_rationale, updated_at, deleted_at)
    VALUES (?, ?, COALESCE((SELECT ai_rationale FROM daily_schedule WHERE date = ?), ?), datetime('now'), NULL)
    ON CONFLICT(date) DO UPDATE SET
      schedule_json = excluded.schedule_json,
      ai_rationale = excluded.ai_rationale,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `,
  ).run(today, JSON.stringify(cleaned), today, 'Edited by user')

  return db.prepare('SELECT * FROM daily_schedule WHERE date = ?').get(today) || null
}

/**
 * Parse "HH:MM" to minutes since midnight.
 */
function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return NaN
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

/**
 * Parse a schedule block's "time" field (e.g. "18:00-21:00") into start/end minutes.
 */
function parseBlockRange(time: string): { start: number; end: number } | null {
  const m = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/.exec(time.trim())
  if (!m) return null
  const start = toMinutes(m[1])
  const end = toMinutes(m[2])
  if (isNaN(start) || isNaN(end)) return null
  return { start, end }
}

/**
 * Guarantee every locked block appears in the schedule with the exact time/label.
 * Removes any AI block that overlaps a locked range, then inserts the locked blocks
 * in chronological order.
 */
function enforceLockedBlocks(
  schedule: Array<{ time: string; activity: string; rationale?: string }>,
  locked: FixedBlock[],
): Array<{ time: string; activity: string; rationale?: string }> {
  const lockedRanges = locked
    .map((b) => ({
      start: toMinutes(b.start),
      end: toMinutes(b.end),
      label: b.label,
      time: `${b.start}-${b.end}`,
    }))
    .filter((b) => !isNaN(b.start) && !isNaN(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start)

  if (lockedRanges.length === 0) return schedule

  // Drop AI blocks that overlap any locked range (true overlap, not just touching).
  const survivors = schedule.filter((block) => {
    const range = parseBlockRange(block.time)
    if (!range) return true
    return !lockedRanges.some((l) => range.start < l.end && range.end > l.start)
  })

  // Insert locked blocks.
  const lockedAsBlocks = lockedRanges.map((l) => ({
    time: l.time,
    activity: l.label,
    rationale: 'Locked time block (user-specified, immovable).',
  }))

  const combined = [...survivors, ...lockedAsBlocks]

  // Sort by start time. Blocks with unparseable times sink to the end in original order.
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

const DAILY_TWEAK_SYSTEM_PROMPT = `You are a daily schedule editor. The user has an existing daily schedule JSON array and wants specific changes.

Rules:
- Apply ONLY the requested tweak.
- Preserve unchanged blocks exactly, including times, activities, and rationale.
- Return a complete JSON array, not a partial patch.
- Each block must have string fields: "time" (HH:MM-HH:MM), "activity", "rationale".
- Keep blocks in chronological order.
- Do not include Markdown, comments, or notes outside the JSON.`

export async function tweakDailySchedule(date: string, instruction: string): Promise<string> {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM daily_schedule WHERE date = ? AND deleted_at IS NULL')
    .get(date) as Record<string, unknown>
  if (!row) throw new Error('No schedule found for ' + date)

  const userPrompt = `Here is the current daily schedule:

\`\`\`json
${row.schedule_json}
\`\`\`

The user wants these changes: "${instruction}"

Apply the requested changes and return only the full modified schedule as a JSON array. Each block: { "time": "HH:MM-HH:MM", "activity": "...", "rationale": "..." }.`

  const response = await generateAnalysisStreaming(
    DAILY_TWEAK_SYSTEM_PROMPT,
    userPrompt,
    { maxTokens: 4096 },
    'daily-planner:tweak',
  )

  // Parse JSON from response
  let scheduleJson: string | null = null
  let rationale: string | null = null

  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim())
      if (Array.isArray(parsed)) {
        scheduleJson = jsonMatch[1].trim()
        rationale = response.replace(/```(?:json)?[\s\S]*?```/, '').trim() || null
      }
    } catch {}
  }

  if (!scheduleJson) {
    const arrayMatch = response.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0])
        if (Array.isArray(parsed)) {
          scheduleJson = arrayMatch[0]
          rationale = response.replace(arrayMatch[0], '').trim() || null
        }
      } catch {}
    }
  }

  if (!scheduleJson) throw new Error('Failed to parse tweaked schedule from AI response')

  // Validate and clean blocks
  const parsed = JSON.parse(scheduleJson)
  const cleaned = parsed.map((block: any, i: number) => {
    const time = String(block.time || '').trim()
    const activity = String(block.activity || '').trim()
    const rat = block.rationale == null ? '' : String(block.rationale).trim()
    if (!time || !activity) throw new Error(`Tweaked block ${i + 1} needs a time and activity`)
    return { time, activity, rationale: rat }
  })

  scheduleJson = JSON.stringify(cleaned)

  // Update stored schedule
  db.prepare(
    `
    UPDATE daily_schedule SET
      schedule_json = ?,
      ai_rationale = ?,
      updated_at = datetime('now'),
      deleted_at = NULL
    WHERE date = ?
  `,
  ).run(scheduleJson, rationale || row.ai_rationale, date)

  return scheduleJson
}

async function buildPlannerContext(): Promise<string> {
  const db = getDb()
  let context = ''

  try {
    context += formatWeatherForPlanner(await getPlannerWeatherPreview())
  } catch {
    context += `## Weather Preview\n- Weather preview unavailable. Do not assume outdoor conditions.\n\n`
  }

  // Comprehensive sleep analysis with circadian energy predictions
  try {
    const sleepContext = buildSleepAnalysisContext()
    context += sleepContext + '\n'
  } catch {
    context += `## Sleep Data\n- No sleep data available. Assume average sleep.\n`
  }

  // HRV / recovery
  const lastHrv = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'hrv'
    ORDER BY date DESC LIMIT 1
  `,
    )
    .get() as Record<string, unknown>

  if (lastHrv) {
    try {
      const hrv = JSON.parse(lastHrv.value_json)
      const value = hrv.qty || hrv.value || 0
      context += `\n## Recovery (HRV)
- Latest HRV: ${value} ms (${lastHrv.date})
- ${value > 50 ? 'Good recovery — can handle demanding tasks' : 'Lower recovery — schedule more breaks'}
`
    } catch {}
  }

  // Heart rate
  const lastHr = db
    .prepare(
      `
    SELECT date, value_json FROM health_metrics
    WHERE metric_type = 'heart_rate'
    ORDER BY date DESC LIMIT 1
  `,
    )
    .get() as Record<string, unknown>

  if (lastHr) {
    try {
      const hr = JSON.parse(lastHr.value_json)
      const bpm = hr.qty || hr.value || 0
      context += `\n## Resting Heart Rate
- Latest: ${bpm} bpm (${lastHr.date})
`
    } catch {}
  }

  // Notion tasks (stored from last sync, or empty)
  // We don't re-sync here to avoid rate limits — use last synced data
  // The user can manually sync from Productivity page

  // Portfolio / market context
  try {
    const prices = await getLatestPricesLive()
    if (prices.length > 0) {
      context += `\n## Market Status
`
      for (const p of prices.slice(0, 10)) {
        context += `- ${p.symbol}: $${p.price.toFixed(2)} (${p.change >= 0 ? '+' : ''}${p.changePercent.toFixed(2)}%)\n`
      }
      context += `- US Market hours: 9:30 AM - 4:00 PM ET\n`
    }
  } catch {}

  // Recent briefing highlights
  const lastBriefing = db
    .prepare(
      `
    SELECT content FROM briefings
    WHERE type = 'morning_finance'
    ORDER BY created_at DESC LIMIT 1
  `,
    )
    .get() as Record<string, unknown>

  if (lastBriefing) {
    // Include first 500 chars of the briefing as context
    const preview = lastBriefing.content.substring(0, 500)
    context += `\n## Latest Finance Briefing (summary)
${preview}...
`
  }

  return context
}
