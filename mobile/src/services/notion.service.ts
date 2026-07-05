/**
 * Notion integration for mobile.
 * Uses the Notion API directly (no relay needed — just the integration token).
 */
import { getSettings } from '../lib/storage'

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2025-09-03'
const dataSourceIdCache = new Map<string, string>()

async function getHeaders(): Promise<Record<string, string>> {
  const settings = await getSettings()
  const token = settings.notionKey
  if (!token) throw new Error('Notion token not configured. Add it in Settings.')
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  }
}

// --- Schema introspection + property mapping ---

interface NotionPropertyMeta { id: string; name: string; type: string }
type NotionPropertyMap = Record<string, NotionPropertyMeta>

interface SchemaPayload {
  title?: string
  date?: string | { start: string; end?: string }
  type?: string
  description?: string
  status?: string
  tags?: string[]
  priority?: string
  url?: string
}

const schemaCache = new Map<string, { schema: NotionPropertyMap; fetchedAt: number }>()
const SCHEMA_TTL_MS = 5 * 60 * 1000

async function getDbSchema(databaseId: string): Promise<NotionPropertyMap> {
  const dataSourceId = await resolveDataSourceId(databaseId)
  const cached = schemaCache.get(dataSourceId)
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_TTL_MS) return cached.schema
  const headers = await getHeaders()
  const res = await fetch(`${NOTION_API}/data_sources/${dataSourceId}`, { headers })
  if (!res.ok) throw new Error(`Notion error ${res.status}: ${await res.text()}`)
  const dataSource = await res.json()
  const props = dataSource.properties || {}
  const schema: NotionPropertyMap = {}
  for (const name of Object.keys(props)) {
    schema[name] = { id: props[name].id, name, type: props[name].type }
  }
  schemaCache.set(dataSourceId, { schema, fetchedAt: Date.now() })
  return schema
}

async function resolveDataSourceId(id: string): Promise<string> {
  const trimmed = id?.trim()
  if (!trimmed) throw new Error('Notion database/data source ID is required.')
  const cached = dataSourceIdCache.get(trimmed)
  if (cached) return cached

  const headers = await getHeaders()
  const dataSourceRes = await fetch(`${NOTION_API}/data_sources/${trimmed}`, { headers })
  if (dataSourceRes.ok) {
    dataSourceIdCache.set(trimmed, trimmed)
    return trimmed
  }

  const dbRes = await fetch(`${NOTION_API}/databases/${trimmed}`, { headers })
  if (!dbRes.ok) throw new Error(`Notion error ${dataSourceRes.status}: ${await dataSourceRes.text()}`)
  const db = await dbRes.json()
  const dataSourceId = db.data_sources?.[0]?.id
  if (!dataSourceId) throw new Error('No data sources found for this Notion database.')
  dataSourceIdCache.set(trimmed, dataSourceId)
  dataSourceIdCache.set(dataSourceId, dataSourceId)
  return dataSourceId
}

const NAME_PREFS: Record<string, string[]> = {
  date: ['date', 'due', 'when', 'scheduled', 'day'],
  type: ['type', 'category', 'kind', 'label'],
  tags: ['tags', 'labels', 'categories'],
  priority: ['priority', 'importance'],
  url: ['url', 'link', 'reference'],
  description: ['description', 'notes', 'details', 'summary', 'body'],
  status: ['status', 'state'],
}
const TYPE_PREFS: Record<string, string[]> = {
  date: ['date'],
  type: ['select', 'multi_select'],
  tags: ['multi_select', 'select'],
  priority: ['select', 'status'],
  url: ['url', 'rich_text'],
  description: ['rich_text'],
  status: ['status', 'select'],
}

function findTitle(schema: NotionPropertyMap): NotionPropertyMeta | null {
  for (const k of Object.keys(schema)) if (schema[k].type === 'title') return schema[k]
  return null
}

function findFor(schema: NotionPropertyMap, key: string, used: Set<string>): NotionPropertyMeta | null {
  const names = NAME_PREFS[key] || []
  const types = TYPE_PREFS[key] || []
  for (const pref of names) {
    for (const n of Object.keys(schema)) {
      if (used.has(n)) continue
      if (n.toLowerCase() === pref && types.includes(schema[n].type)) return schema[n]
    }
  }
  for (const pref of names) {
    for (const n of Object.keys(schema)) {
      if (used.has(n)) continue
      if (n.toLowerCase().includes(pref) && types.includes(schema[n].type)) return schema[n]
    }
  }
  for (const n of Object.keys(schema)) {
    if (used.has(n)) continue
    if (types.includes(schema[n].type)) return schema[n]
  }
  return null
}

function valueFor(prop: NotionPropertyMeta, payloadValue: any): any | null {
  switch (prop.type) {
    case 'title':
      return { title: [{ type: 'text', text: { content: String(payloadValue ?? '').slice(0, 2000) } }] }
    case 'rich_text':
      return { rich_text: [{ type: 'text', text: { content: String(payloadValue ?? '').slice(0, 2000) } }] }
    case 'date': {
      if (!payloadValue) return null
      if (typeof payloadValue === 'string') return { date: { start: payloadValue } }
      if (payloadValue.start) {
        const out: any = { start: payloadValue.start }
        if (payloadValue.end) out.end = payloadValue.end
        return { date: out }
      }
      return null
    }
    case 'select':
      if (!payloadValue) return null
      return { select: { name: Array.isArray(payloadValue) ? String(payloadValue[0]) : String(payloadValue) } }
    case 'multi_select': {
      if (!payloadValue) return null
      const arr = Array.isArray(payloadValue) ? payloadValue : [payloadValue]
      return { multi_select: arr.filter(Boolean).map((v) => ({ name: String(v) })) }
    }
    case 'status':
      if (!payloadValue) return null
      return { status: { name: String(payloadValue) } }
    case 'url':
      if (!payloadValue) return null
      return { url: String(payloadValue) }
    default:
      return null
  }
}

interface MapOptions { dateProperty?: string }

function mapToDbSchema(schema: NotionPropertyMap, payload: SchemaPayload, options: MapOptions = {}): Record<string, any> {
  const properties: Record<string, any> = {}
  const used = new Set<string>()
  if (payload.title !== undefined) {
    const t = findTitle(schema)
    if (t) {
      const v = valueFor(t, payload.title)
      if (v) { properties[t.name] = v; used.add(t.name) }
    }
  }
  for (const key of ['date', 'type', 'status', 'priority', 'tags', 'url', 'description'] as const) {
    const v = (payload as any)[key]
    if (v === undefined || v === null || v === '') continue
    let prop: NotionPropertyMeta | null = null
    if (key === 'date' && options.dateProperty) {
      const override = schema[options.dateProperty]
      if (override && override.type === 'date') prop = override
    }
    if (!prop) prop = findFor(schema, key, used)
    if (!prop) continue
    const value = valueFor(prop, v)
    if (value) { properties[prop.name] = value; used.add(prop.name) }
  }
  return properties
}

export async function getDbProperties(databaseId: string): Promise<Array<{ name: string; type: string }>> {
  const schema = await getDbSchema(databaseId)
  return Object.values(schema).map((p) => ({ name: p.name, type: p.type }))
}

// --- Tasks ---

export interface NotionTask {
  id: string
  title: string
  status: string
  due_date: string | null
  priority: string | null
}

export async function fetchTasks(databaseId: string): Promise<NotionTask[]> {
  const headers = await getHeaders()
  const dataSourceId = await resolveDataSourceId(databaseId)
  const schema = await getDbSchema(dataSourceId)
  const statusProp = findFor(schema, 'status', new Set())
  const dueProp = findFor(schema, 'date', new Set())

  const body: any = { page_size: 50 }
  if (statusProp) {
    body.filter = {
      property: statusProp.name,
      [statusProp.type]: { does_not_equal: 'Done' },
    }
  }
  if (dueProp) {
    body.sorts = [{ property: dueProp.name, direction: 'ascending' }]
  }

  const res = await fetch(`${NOTION_API}/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Notion error ${res.status}: ${err}`)
  }

  const data = await res.json()

  return data.results.map((page: any) => {
    const props = page.properties
    return {
      id: page.id,
      title: extractTitle(props),
      status: extractStatusProp(statusProp ? props[statusProp.name] : (props.Status || props.status)),
      due_date: extractDateProp(dueProp ? props[dueProp.name] : (props.Due || props['Due Date'] || props['Due date'] || props.Date)),
      priority: extractSelect(props, 'Priority') || extractSelect(props, 'priority'),
    }
  })
}

// --- List databases ---

export interface NotionDatabase {
  id: string
  title: string
}

export async function listDatabases(): Promise<NotionDatabase[]> {
  const headers = await getHeaders()

  const res = await fetch(`${NOTION_API}/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filter: { property: 'object', value: 'data_source' },
      page_size: 50,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Notion error ${res.status}: ${err}`)
  }

  const data = await res.json()

  return data.results.map((db: any) => ({
    id: db.id,
    title: db.title?.map((t: any) => t.plain_text).join('') || 'Untitled',
  }))
}

// --- Push weekend plan ---

interface WeekendActivity {
  time: string
  activity: string
  location: string
  travelTime: string
  rationale: string
  cost: string
}

export async function pushWeekendToNotion(
  databaseId: string,
  planJson: string,
  weekendDate: string,
  options: { dateProperty?: string } = {}
): Promise<number> {
  const headers = await getHeaders()
  const dataSourceId = await resolveDataSourceId(databaseId)
  const schema = await getDbSchema(dataSourceId)
  // Fall back to the calendar date property configured in Settings.
  let dateProperty = options.dateProperty
  if (!dateProperty) {
    try {
      const s = await getSettings()
      if (s.notionCalendarDateProperty) dateProperty = s.notionCalendarDateProperty
    } catch {}
  }

  let plan: { saturday?: WeekendActivity[]; sunday?: WeekendActivity[] }
  try {
    plan = JSON.parse(planJson)
  } catch {
    throw new Error('Invalid weekend plan JSON')
  }

  const satDate = weekendDate
  const sunDateObj = new Date(weekendDate + 'T12:00:00')
  sunDateObj.setDate(sunDateObj.getDate() + 1)
  const sunDate = sunDateObj.toISOString().split('T')[0]

  let created = 0

  const pushActivity = async (activity: WeekendActivity, date: string, dayLabel: string) => {
    const timeMatch = activity.time.match(/(\d{1,2}:\d{2})\s*(?:AM|PM)?\s*-\s*(\d{1,2}:\d{2})\s*(?:AM|PM)?/i)
    const startTime = timeMatch ? timeMatch[1] : null
    const endTime = timeMatch ? timeMatch[2] : null

    const datePayload: { start: string; end?: string } = { start: date }
    if (startTime) {
      datePayload.start = `${date}T${padTime(startTime)}:00`
      if (endTime) datePayload.end = `${date}T${padTime(endTime)}:00`
    }

    const descParts: string[] = []
    if (activity.location) descParts.push(`Location: ${activity.location}`)
    if (activity.travelTime) descParts.push(`Travel: ${activity.travelTime}`)
    if (activity.cost) descParts.push(`Cost: ${activity.cost}`)
    if (activity.rationale) descParts.push(`\n${activity.rationale}`)
    const description = descParts.join('\n')

    const body: any = {
      parent: { data_source_id: dataSourceId },
      properties: mapToDbSchema(schema, {
        title: activity.activity,
        date: datePayload,
        type: dayLabel,
        description,
      }, { dateProperty }),
    }

    if (descParts.length > 0) {
      body.children = [{
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: description } }],
        },
      }]
    }

    const res = await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (res.ok) created++
  }

  if (plan.saturday) {
    for (const activity of plan.saturday) {
      await pushActivity(activity, satDate, 'Saturday')
    }
  }
  if (plan.sunday) {
    for (const activity of plan.sunday) {
      await pushActivity(activity, sunDate, 'Sunday')
    }
  }

  return created
}

// --- Push daily schedule ---

interface ScheduleBlock {
  time: string
  activity: string
  rationale?: string
}

function buildDateRangePayload(date: string, startTime: string, endTime?: string): { start: string; end?: string } {
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
  databaseId: string,
  scheduleJson: string,
  date: string,
  options: { dateProperty?: string } = {}
): Promise<number> {
  const headers = await getHeaders()
  const dataSourceId = await resolveDataSourceId(databaseId)
  const schema = await getDbSchema(dataSourceId)

  let dateProperty = options.dateProperty
  if (!dateProperty) {
    try {
      const s = await getSettings()
      if (s.notionCalendarDateProperty) dateProperty = s.notionCalendarDateProperty
    } catch {}
  }

  let blocks: ScheduleBlock[]
  try {
    blocks = JSON.parse(scheduleJson)
  } catch {
    throw new Error('Invalid schedule JSON')
  }
  if (!Array.isArray(blocks)) throw new Error('Schedule JSON must be an array')

  let created = 0
  for (const block of blocks) {
    const timeMatch = String(block.time || '').match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/)
    const datePayload: { start: string; end?: string } = { start: date }
    if (timeMatch) {
      Object.assign(datePayload, buildDateRangePayload(date, timeMatch[1], timeMatch[2]))
    }

    const body: any = {
      parent: { data_source_id: dataSourceId },
      properties: mapToDbSchema(schema, {
        title: block.activity || 'Schedule block',
        date: datePayload,
        type: 'Schedule',
        description: block.rationale || '',
      }, { dateProperty }),
    }

    if (block.rationale) {
      body.children = [{
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: block.rationale } }],
        },
      }]
    }

    const res = await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Notion error ${res.status}: ${await res.text()}`)
    created++
  }

  return created
}

// --- Push briefing ---

export async function pushBriefingToNotion(
  databaseId: string,
  content: string,
  type: string = 'AI Briefing',
  options: { dateProperty?: string } = {}
): Promise<boolean> {
  const headers = await getHeaders()
  const dataSourceId = await resolveDataSourceId(databaseId)
  const schema = await getDbSchema(dataSourceId)
  const today = new Date().toISOString().split('T')[0]

  let dateProperty = options.dateProperty
  if (!dateProperty) {
    try {
      const s = await getSettings()
      // Mobile doesn't keep a separate briefings DB in settings, so reuse the
      // calendar date property as a sensible default for briefing pushes too.
      if (s.notionCalendarDateProperty) dateProperty = s.notionCalendarDateProperty
    } catch {}
  }

  // Convert content to Notion blocks (max 100)
  const blocks = contentToBlocks(content)

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parent: { data_source_id: dataSourceId },
      properties: mapToDbSchema(schema, {
        title: `${type} — ${today}`,
        date: today,
        type,
      }, { dateProperty }),
      children: blocks,
    }),
  })

  return res.ok
}

// --- Helpers ---

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

function extractTitle(props: any): string {
  const titleProp = Object.values(props).find((p: any) => p?.type === 'title')
    || props.Name
    || props.Title
    || props.Task
    || props.title
  if (!titleProp || titleProp.type !== 'title') return 'Untitled'
  return titleProp.title?.map((t: any) => t.plain_text).join('') || 'Untitled'
}

function extractStatus(props: any): string {
  const prop = props.Status || props.status
  return extractStatusProp(prop)
}

function extractStatusProp(prop: any): string {
  if (!prop) return 'Unknown'
  if (prop.type === 'status' && prop.status) return prop.status.name
  if (prop.type === 'select' && prop.select) return prop.select.name
  if (prop.type === 'checkbox') return prop.checkbox ? 'Done' : 'Not started'
  return 'Unknown'
}

function extractDate(props: any): string | null {
  const prop = props.Due || props['Due Date'] || props['Due date'] || props.Date
  return extractDateProp(prop)
}

function extractDateProp(prop: any): string | null {
  if (!prop || prop.type !== 'date' || !prop.date) return null
  return prop.date.start
}

function extractSelect(props: any, key: string): string | null {
  const prop = props[key]
  if (!prop) return null
  if (prop.type === 'select' && prop.select) return prop.select.name
  return null
}

function contentToBlocks(content: string): any[] {
  const lines = content.split('\n')
  const blocks: any[] = []

  for (const line of lines) {
    if (!line.trim()) continue

    if (line.startsWith('## ')) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: {
        rich_text: [{ type: 'text', text: { content: line.replace(/^## /, '') } }],
      }})
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: {
        rich_text: [{ type: 'text', text: { content: line.replace(/^[-*] /, '') } }],
      }})
    } else {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: {
        rich_text: [{ type: 'text', text: { content: line } }],
      }})
    }

    if (blocks.length >= 99) break
  }

  return blocks
}
