import {
  getNotionClient,
  getNotionDbIds,
  getNotionDateProperties,
  resolveNotionDataSourceId,
} from './notion.client'
import { getDb } from '../../db/database'
import {
  getDbSchema,
  mapToDbSchema,
  type NotionPropertyMap,
  type NotionPropertyMeta,
} from './notion-schema'
import type { NotionTask, TodayTaskItem } from '../../../shared/types/ipc.types'

// --- Pull tasks from Notion ---

export async function syncTasks(): Promise<NotionTask[]> {
  const { tasksDbId } = getNotionDbIds()
  if (!tasksDbId) {
    throw new Error('Notion Tasks database ID not configured. Add it in Settings.')
  }

  const notion = getNotionClient()
  const tasksDataSourceId = await resolveNotionDataSourceId(tasksDbId)
  const schema = await getDbSchema(tasksDbId)
  const statusProp = findSchemaProperty(schema, ['status', 'state'], ['status', 'select'])
  const dueProp = findSchemaProperty(schema, ['due', 'due date', 'date', 'when'], ['date'])

  const queryBase: any = {
    data_source_id: tasksDataSourceId,
    page_size: 50,
  }
  if (dueProp) {
    queryBase.sorts = [{ property: dueProp.name, direction: 'ascending' }]
  }

  const pages: any[] = []
  let cursor: string | undefined
  do {
    const response = await notion.dataSources.query({
      ...queryBase,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    pages.push(...response.results)
    cursor = response.has_more ? response.next_cursor || undefined : undefined
  } while (cursor)

  const tasks: NotionTask[] = pages.map((page: any) => {
    const props = page.properties

    // Extract title — handle different property name conventions
    const titleProp =
      Object.values(props).find((p: any) => p?.type === 'title') ||
      props.Name ||
      props.Title ||
      props.Task ||
      props.title
    const title = extractTitle(titleProp)

    // Extract status
    const pageStatusProp = statusProp ? props[statusProp.name] : props.Status || props.status
    const status = extractStatus(pageStatusProp)

    // Extract due date
    const pageDueProp = dueProp
      ? props[dueProp.name]
      : props.Due || props['Due Date'] || props['Due date'] || props.Date
    const due_date = extractDate(pageDueProp)

    // Extract priority
    const priorityProp = props.Priority || props.priority
    const priority = extractSelect(priorityProp)

    return {
      id: page.id,
      title,
      status,
      due_date,
      priority,
    }
  })
  const openTasks = tasks.filter((task) => !isCompletedStatus(task.status))

  const db = getDb()
  const upsertTask = db.prepare(`
    INSERT OR REPLACE INTO notion_tasks (id, title, status, due_date, priority, synced_at)
    VALUES (@id, @title, @status, @due_date, @priority, datetime('now'))
  `)
  const cacheTasks = db.transaction((rows: NotionTask[]) => {
    db.prepare('DELETE FROM notion_tasks').run()
    for (const task of rows) upsertTask.run(task)
  })
  cacheTasks(tasks)

  // Log sync
  db.prepare(
    `
    INSERT INTO notion_sync_log (database_id, direction, last_synced_at, status)
    VALUES (?, 'pull', datetime('now'), 'success')
  `,
  ).run(tasksDataSourceId)

  console.log(`Synced ${openTasks.length} open tasks from Notion`)
  return openTasks
}

export function getTodayTaskItems(date?: string): TodayTaskItem[] {
  const db = getDb()
  const today = date || localDateString()
  const rows = db
    .prepare(
      `
    SELECT id, title, status, due_date, priority
    FROM notion_tasks
    WHERE substr(due_date, 1, 10) = ?
      AND lower(COALESCE(status, '')) NOT IN ('done', 'complete', 'completed')
    ORDER BY
      CASE
        WHEN due_date IS NULL OR TRIM(due_date) = '' THEN 1
        ELSE 0
      END,
      substr(COALESCE(due_date, ''), 1, 10),
      COALESCE(priority, ''),
      title
  `,
    )
    .all(today) as NotionTask[]

  const notionItems: TodayTaskItem[] = rows.map((task) => ({
    ...task,
    due_date: task.due_date ? String(task.due_date).slice(0, 10) : today,
    source: 'notion',
  }))

  return [...notionItems, ...getWeekendPlanItemsForDate(today)]
}

function getWeekendPlanItemsForDate(date: string): TodayTaskItem[] {
  const db = getDb()
  const plans = db
    .prepare(
      `
    SELECT id, weekend_date, plan_json
    FROM weekend_plans
    WHERE weekend_date = ?
       OR date(weekend_date, '+1 day') = ?
    ORDER BY weekend_date DESC
  `,
    )
    .all(date, date) as Array<{ id: number; weekend_date: string; plan_json: string }>

  const items: TodayTaskItem[] = []
  for (const stored of plans) {
    let plan: { saturday?: WeekendActivity[]; sunday?: WeekendActivity[] }
    try {
      plan = JSON.parse(stored.plan_json)
    } catch {
      continue
    }

    const dayKey = stored.weekend_date === date ? 'saturday' : 'sunday'
    const activities = dayKey === 'saturday' ? plan.saturday || [] : plan.sunday || []
    activities.forEach((activity, index) => {
      items.push({
        id: `weekend:${stored.id}:${dayKey}:${index}`,
        title: activity.activity || 'Weekend activity',
        status: 'Planned',
        due_date: date,
        priority: null,
        source: 'weekend',
        time: activity.time || null,
        detail: activity.rationale || null,
        location: activity.location || null,
      })
    })
  }

  return items.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
}

function localDateString(): string {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// --- Push briefing to Notion ---

export async function pushBriefingToNotion(briefingId: number): Promise<string> {
  const { briefingsDbId } = getNotionDbIds()
  if (!briefingsDbId) {
    throw new Error('Notion Briefings database ID not configured. Add it in Settings.')
  }

  const db = getDb()
  const briefing = db.prepare('SELECT * FROM briefings WHERE id = ?').get(briefingId) as
    | { id: number; type: string; date: string; content: string }
    | undefined
  if (!briefing) {
    throw new Error(`Briefing ${briefingId} not found`)
  }

  const notion = getNotionClient()
  const briefingsDataSourceId = await resolveNotionDataSourceId(briefingsDbId)

  // Create a page in the briefings database
  const typeLabels: Record<string, string> = {
    morning_finance: 'Finance Briefing',
    health_weekly: 'Health Insights',
    daily_schedule: 'Daily Schedule',
  }
  const typeLabel = typeLabels[briefing.type] || briefing.type

  const schema = await getDbSchema(briefingsDbId)
  const { briefings: dateProperty } = getNotionDateProperties()
  const page = await notion.pages.create({
    parent: { data_source_id: briefingsDataSourceId },
    properties: mapToDbSchema(
      schema,
      {
        title: `${typeLabel} — ${briefing.date}`,
        date: briefing.date,
        type: typeLabel,
      },
      { dateProperty: dateProperty || undefined },
    ),
    children: contentToBlocks(briefing.content),
  })

  // Log sync
  db.prepare(
    `
    INSERT INTO notion_sync_log (database_id, direction, last_synced_at, status)
    VALUES (?, 'push', datetime('now'), 'success')
  `,
  ).run(briefingsDataSourceId)

  console.log(`Pushed briefing ${briefingId} to Notion: ${page.id}`)
  return page.id
}

// --- Pull briefings back from Notion ---

const TYPE_LABEL_TO_KEY: Record<string, string> = {
  'finance briefing': 'morning_finance',
  'health insights': 'health_weekly',
  'daily schedule': 'daily_schedule',
  'morning sleep report': 'morning_sleep',
  'sleep briefing': 'morning_sleep',
}

function richTextToString(richText: any[]): string {
  if (!Array.isArray(richText)) return ''
  return richText.map((r: any) => r.plain_text || '').join('')
}

function blocksToMarkdown(blocks: any[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    const t = block?.type
    if (!t) continue
    const rt = block[t]?.rich_text ?? []
    const text = richTextToString(rt)
    switch (t) {
      case 'heading_1':
        lines.push(`# ${text}`)
        break
      case 'heading_2':
        lines.push(`## ${text}`)
        break
      case 'heading_3':
        lines.push(`### ${text}`)
        break
      case 'bulleted_list_item':
        lines.push(`- ${text}`)
        break
      case 'numbered_list_item':
        lines.push(`1. ${text}`)
        break
      case 'paragraph':
      case 'quote':
      case 'callout':
        if (text) lines.push(text)
        break
    }
  }
  return lines.join('\n')
}

function inferType(title: string, typeProp: string | null): string {
  const candidates = [typeProp, title].filter(Boolean) as string[]
  for (const c of candidates) {
    const lower = c.toLowerCase()
    for (const [label, key] of Object.entries(TYPE_LABEL_TO_KEY)) {
      if (lower.includes(label)) return key
    }
  }
  return 'morning_finance'
}

/**
 * Pull recent briefings from the configured Notion briefings DB and upsert
 * them into the local briefings table. Conflict resolution: Notion wins
 * (last write to local row keyed on type+date).
 */
export async function pullBriefingsFromNotion(
  daysBack: number = 14,
): Promise<{ pulled: number; created: number; updated: number }> {
  const { briefingsDbId } = getNotionDbIds()
  if (!briefingsDbId) {
    throw new Error('Notion Briefings database ID not configured.')
  }
  const notion = getNotionClient()
  const briefingsDataSourceId = await resolveNotionDataSourceId(briefingsDbId)
  const { briefings: dateProperty } = getNotionDateProperties()

  // Schema-aware date property selection
  const schema = await getDbSchema(briefingsDbId)
  const dateProp = dateProperty || Object.keys(schema).find((k) => schema[k]?.type === 'date')
  if (!dateProp) {
    throw new Error('No date property found on Notion Briefings DB')
  }

  const sinceIso = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const response = await notion.dataSources.query({
    data_source_id: briefingsDataSourceId,
    filter: {
      property: dateProp,
      date: { on_or_after: sinceIso },
    },
    page_size: 50,
  })

  const db = getDb()
  const findExisting = db.prepare('SELECT id FROM briefings WHERE type = ? AND date = ?')
  const updateStmt = db.prepare('UPDATE briefings SET content = ? WHERE id = ?')
  const insertStmt = db.prepare(
    `INSERT INTO briefings (type, date, content) VALUES (?, ?, ?)
     ON CONFLICT(type, date) DO UPDATE SET content = excluded.content`,
  )

  let created = 0
  let updated = 0
  let pulled = 0

  for (const page of response.results as Array<Record<string, any>>) {
    const props: Record<string, any> = page.properties || {}

    // Title (any title-typed property)
    const titleKey = Object.keys(props).find((k) => props[k]?.type === 'title')
    const title = titleKey ? richTextToString(props[titleKey]?.title) : ''

    // Date
    const dateVal = props[dateProp]?.date?.start as string | undefined
    if (!dateVal) continue
    const localDate = dateVal.slice(0, 10)

    // Type (from a "Type" select if present, fall back to title-derived)
    const typeKey = Object.keys(props).find((k) => /^type$/i.test(k))
    const typeRaw = typeKey
      ? props[typeKey]?.select?.name || props[typeKey]?.status?.name || null
      : null
    const type = inferType(title, typeRaw)

    // Fetch page blocks (markdown body)
    let content = ''
    try {
      const blocksRes = await notion.blocks.children.list({ block_id: page.id, page_size: 100 })
      content = blocksToMarkdown(blocksRes.results as Array<Record<string, unknown>>)
    } catch (err) {
      console.warn('[notion-pull] failed to read blocks for page', page.id, (err as Error)?.message)
      continue
    }
    if (!content.trim()) continue

    const existing = findExisting.get(type, localDate) as { id: number } | undefined
    if (existing) {
      updateStmt.run(content, existing.id)
      updated++
    } else {
      insertStmt.run(type, localDate, content)
      created++
    }
    pulled++
  }

  db.prepare(
    `
    INSERT INTO notion_sync_log (database_id, direction, last_synced_at, status)
    VALUES (?, 'pull', datetime('now'), 'success')
  `,
  ).run(briefingsDataSourceId)

  console.log(`[notion-pull] briefings: pulled ${pulled} (${created} new, ${updated} updated)`)
  return { pulled, created, updated }
}

// --- List available Notion databases ---

export async function listNotionDatabases(): Promise<{ id: string; title: string }[]> {
  const notion = getNotionClient()

  const response = await notion.search({
    filter: { property: 'object', value: 'data_source' },
    page_size: 50,
  })

  return response.results.map((db: any) => ({
    id: db.id,
    title: db.title?.map((t: any) => t.plain_text).join('') || 'Untitled',
  }))
}

// --- Push weekend plan activities to Notion calendar ---

interface WeekendActivity {
  time: string
  activity: string
  location: string
  transportation?: string
  travelTime: string
  rationale: string
  cost: string
}

export async function pushWeekendToNotion(
  planJson: string,
  weekendDate: string,
  databaseId?: string,
): Promise<{ created: number; pageIds: string[] }> {
  const calendarDbId = databaseId || getNotionDbIds().calendarDbId
  if (!calendarDbId) {
    throw new Error('No Notion database selected. Pick a database or configure one in Settings.')
  }

  const notion = getNotionClient()
  const calendarDataSourceId = await resolveNotionDataSourceId(calendarDbId)
  let plan: { saturday?: WeekendActivity[]; sunday?: WeekendActivity[] }

  try {
    plan = JSON.parse(planJson)
  } catch {
    throw new Error('Invalid weekend plan JSON')
  }

  const pageIds: string[] = []

  // Calculate Sunday date from Saturday
  const satDate = weekendDate
  const sunDateObj = new Date(weekendDate + 'T12:00:00')
  sunDateObj.setDate(sunDateObj.getDate() + 1)
  const sunDate = sunDateObj.toISOString().split('T')[0]

  const schema = await getDbSchema(calendarDbId)
  const { calendar: dateProperty } = getNotionDateProperties()

  const createActivity = async (activity: WeekendActivity, date: string, dayLabel: string) => {
    // Parse time range like "10:00-12:00" or "10:00 AM - 12:00 PM"
    const timeMatch = activity.time.match(
      /(\d{1,2}:\d{2})\s*(?:AM|PM)?\s*-\s*(\d{1,2}:\d{2})\s*(?:AM|PM)?/i,
    )
    const startTime = timeMatch ? timeMatch[1] : null
    const endTime = timeMatch ? timeMatch[2] : null

    // Build date payload — use datetime if we have times, date-only otherwise
    const datePayload: { start: string; end?: string } = { start: date }
    if (startTime) {
      datePayload.start = `${date}T${padTime(startTime)}:00`
      if (endTime) datePayload.end = `${date}T${padTime(endTime)}:00`
    }

    const descParts: string[] = []
    if (activity.location) descParts.push(`Location: ${activity.location}`)
    if (activity.transportation) descParts.push(`Transportation: ${activity.transportation}`)
    if (activity.travelTime) descParts.push(`Travel: ${activity.travelTime}`)
    if (activity.cost) descParts.push(`Cost: ${activity.cost}`)
    if (activity.rationale) descParts.push(`\n${activity.rationale}`)
    const description = descParts.join('\n')

    const page = await notion.pages.create({
      parent: { data_source_id: calendarDataSourceId },
      properties: mapToDbSchema(
        schema,
        {
          title: activity.activity,
          date: datePayload,
          type: dayLabel,
          description,
        },
        { dateProperty: dateProperty || undefined },
      ),
      children:
        descParts.length > 0
          ? [
              {
                object: 'block' as const,
                type: 'paragraph' as const,
                paragraph: {
                  rich_text: [{ type: 'text' as const, text: { content: description } }],
                },
              },
            ]
          : [],
    })

    pageIds.push(page.id)
  }

  // Push Saturday activities
  if (plan.saturday) {
    for (const activity of plan.saturday) {
      await createActivity(activity, satDate, 'Saturday')
    }
  }

  // Push Sunday activities
  if (plan.sunday) {
    for (const activity of plan.sunday) {
      await createActivity(activity, sunDate, 'Sunday')
    }
  }

  // Log sync
  const db = getDb()
  db.prepare(
    `
    INSERT INTO notion_sync_log (database_id, direction, last_synced_at, status)
    VALUES (?, 'push', datetime('now'), 'success')
  `,
  ).run(calendarDataSourceId)

  console.log(`Pushed ${pageIds.length} weekend activities to Notion calendar`)
  return { created: pageIds.length, pageIds }
}

// --- Push daily schedule to Notion calendar ---

interface ScheduleBlock {
  time: string
  activity: string
  rationale: string
}

function buildDateRangePayload(
  date: string,
  startTime: string,
  endTime?: string,
): { start: string; end?: string } {
  const start = padTime(startTime)
  const payload: { start: string; end?: string } = { start: `${date}T${start}:00` }

  if (endTime) {
    const end = padTime(endTime)
    let endDate = date
    if (timeToMinutes(end) <= timeToMinutes(start)) {
      endDate = addDays(date, 1)
    }
    payload.end = `${endDate}T${end}:00`
  }

  return payload
}

export async function pushScheduleToNotion(
  scheduleJson: string,
  date: string,
  databaseId?: string,
): Promise<{ created: number; pageIds: string[] }> {
  const calendarDbId = databaseId || getNotionDbIds().calendarDbId
  if (!calendarDbId) {
    throw new Error(
      'No Notion calendar database configured. Pick a database or configure one in Settings.',
    )
  }

  const notion = getNotionClient()
  const calendarDataSourceId = await resolveNotionDataSourceId(calendarDbId)
  let blocks: ScheduleBlock[]

  try {
    blocks = JSON.parse(scheduleJson)
  } catch {
    throw new Error('Invalid schedule JSON')
  }

  const pageIds: string[] = []
  const schema = await getDbSchema(calendarDbId)
  const { calendar: dateProperty } = getNotionDateProperties()

  for (const block of blocks) {
    // Parse time range like "07:00-08:00"
    const timeMatch = block.time.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/)
    const datePayload: { start: string; end?: string } = { start: date }
    if (timeMatch) {
      Object.assign(datePayload, buildDateRangePayload(date, timeMatch[1], timeMatch[2]))
    }

    const page = await notion.pages.create({
      parent: { data_source_id: calendarDataSourceId },
      properties: mapToDbSchema(
        schema,
        {
          title: block.activity,
          date: datePayload,
          description: block.rationale,
        },
        { dateProperty: dateProperty || undefined },
      ),
      children: block.rationale
        ? [
            {
              object: 'block' as const,
              type: 'paragraph' as const,
              paragraph: {
                rich_text: [{ type: 'text' as const, text: { content: block.rationale } }],
              },
            },
          ]
        : [],
    })

    pageIds.push(page.id)
  }

  // Log sync
  const db = getDb()
  db.prepare(
    `
    INSERT INTO notion_sync_log (database_id, direction, last_synced_at, status)
    VALUES (?, 'push', datetime('now'), 'success')
  `,
  ).run(calendarDataSourceId)

  console.log(`Pushed ${pageIds.length} schedule blocks to Notion calendar`)
  return { created: pageIds.length, pageIds }
}

/** Pad "9:00" to "09:00" */
function padTime(time: string): string {
  const [h, m] = time.split(':')
  return `${h.padStart(2, '0')}:${m}`
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':')
  return Number(h) * 60 + Number(m)
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// --- Helpers ---

function findSchemaProperty(
  schema: NotionPropertyMap,
  namePrefs: string[],
  typePrefs: string[],
): NotionPropertyMeta | null {
  for (const pref of namePrefs) {
    for (const prop of Object.values(schema)) {
      if (prop.name.toLowerCase() === pref && typePrefs.includes(prop.type)) return prop
    }
  }
  for (const pref of namePrefs) {
    for (const prop of Object.values(schema)) {
      if (prop.name.toLowerCase().includes(pref) && typePrefs.includes(prop.type)) return prop
    }
  }
  for (const prop of Object.values(schema)) {
    if (typePrefs.includes(prop.type)) return prop
  }
  return null
}

function extractTitle(prop: any): string {
  if (!prop) return 'Untitled'
  if (prop.type === 'title' && prop.title) {
    return prop.title.map((t: any) => t.plain_text).join('') || 'Untitled'
  }
  return 'Untitled'
}

function extractStatus(prop: any): string {
  if (!prop) return 'Unknown'
  if (prop.type === 'status' && prop.status) return prop.status.name
  if (prop.type === 'select' && prop.select) return prop.select.name
  if (prop.type === 'checkbox') return prop.checkbox ? 'Done' : 'Not started'
  return 'Unknown'
}

function isCompletedStatus(status: string | null | undefined): boolean {
  const normalized = String(status || '')
    .trim()
    .toLowerCase()
  return ['done', 'complete', 'completed', 'archived', 'cancelled', 'canceled'].includes(normalized)
}

function extractDate(prop: any): string | null {
  if (!prop) return null
  if (prop.type === 'date' && prop.date) return prop.date.start
  return null
}

function extractSelect(prop: any): string | null {
  if (!prop) return null
  if (prop.type === 'select' && prop.select) return prop.select.name
  if (prop.type === 'multi_select' && prop.multi_select?.length > 0) {
    return prop.multi_select[0].name
  }
  return null
}

// Convert markdown-ish content into Notion blocks
function contentToBlocks(content: string): any[] {
  const lines = content.split('\n')
  const blocks: any[] = []

  for (const line of lines) {
    if (!line.trim()) continue

    if (line.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: line.replace(/^## /, '') } }],
        },
      })
    } else if (line.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: {
          rich_text: [{ type: 'text', text: { content: line.replace(/^### /, '') } }],
        },
      })
    } else if (line.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [{ type: 'text', text: { content: line.replace(/^# /, '') } }],
        },
      })
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: line.replace(/^[-*] /, '') } }],
        },
      })
    } else if (/^\d+\. /.test(line)) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: {
          rich_text: [{ type: 'text', text: { content: line.replace(/^\d+\. /, '') } }],
        },
      })
    } else {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: line } }],
        },
      })
    }

    // Notion API limit: 100 blocks per request
    if (blocks.length >= 99) break
  }

  return blocks
}
