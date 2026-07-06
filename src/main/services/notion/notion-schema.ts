import { getNotionClient, resolveNotionDataSourceId } from './notion.client'

export interface NotionPropertyMeta {
  id: string
  name: string
  type: string
}

export type NotionPropertyMap = Record<string, NotionPropertyMeta>

interface CacheEntry {
  schema: NotionPropertyMap
  fetchedAt: number
}

const SCHEMA_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()

export function clearSchemaCache(): void {
  cache.clear()
}

export async function getDbSchema(databaseId: string): Promise<NotionPropertyMap> {
  const dataSourceId = await resolveNotionDataSourceId(databaseId)
  const cached = cache.get(dataSourceId)
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_TTL_MS) {
    return cached.schema
  }
  const notion = getNotionClient()
  const dataSource = (await notion.dataSources.retrieve({
    data_source_id: dataSourceId,
  })) as Record<string, unknown>
  const props = (dataSource.properties || {}) as Record<string, { id: string; type: string }>
  const schema: NotionPropertyMap = {}
  for (const name of Object.keys(props)) {
    const p = props[name]
    schema[name] = { id: p.id, name, type: p.type }
  }
  cache.set(dataSourceId, { schema, fetchedAt: Date.now() })
  return schema
}

export interface SchemaPayload {
  title?: string
  date?: string | { start: string; end?: string }
  type?: string
  tags?: string[]
  priority?: string
  url?: string
  description?: string
  status?: string
}

const NAME_PREFERENCES: Record<keyof SchemaPayload, string[]> = {
  title: [],
  date: ['date', 'due', 'when', 'scheduled', 'day'],
  type: ['type', 'category', 'kind', 'label'],
  tags: ['tags', 'labels', 'categories'],
  priority: ['priority', 'importance'],
  url: ['url', 'link', 'reference'],
  description: ['description', 'notes', 'details', 'summary', 'body'],
  status: ['status', 'state'],
}

const TYPE_PREFERENCES: Record<keyof SchemaPayload, string[]> = {
  title: ['title'],
  date: ['date'],
  type: ['select', 'multi_select'],
  tags: ['multi_select', 'select'],
  priority: ['select', 'status'],
  url: ['url', 'rich_text'],
  description: ['rich_text'],
  status: ['status', 'select'],
}

function findPropertyForKey(
  schema: NotionPropertyMap,
  key: keyof SchemaPayload,
  used: Set<string>,
): NotionPropertyMeta | null {
  const namePrefs = NAME_PREFERENCES[key]
  const typePrefs = TYPE_PREFERENCES[key]

  // 1. Exact name match with compatible type
  for (const pref of namePrefs) {
    for (const propName of Object.keys(schema)) {
      if (used.has(propName)) continue
      const p = schema[propName]
      if (propName.toLowerCase() === pref && typePrefs.includes(p.type)) {
        return p
      }
    }
  }
  // 2. Name contains preferred token + compatible type
  for (const pref of namePrefs) {
    for (const propName of Object.keys(schema)) {
      if (used.has(propName)) continue
      const p = schema[propName]
      if (propName.toLowerCase().includes(pref) && typePrefs.includes(p.type)) {
        return p
      }
    }
  }
  // 3. First property matching any preferred type
  for (const propName of Object.keys(schema)) {
    if (used.has(propName)) continue
    const p = schema[propName]
    if (typePrefs.includes(p.type)) {
      return p
    }
  }
  return null
}

function findTitle(schema: NotionPropertyMap): NotionPropertyMeta | null {
  for (const name of Object.keys(schema)) {
    if (schema[name].type === 'title') return schema[name]
  }
  return null
}

function asRichText(text: string): any[] {
  return [{ type: 'text', text: { content: text.slice(0, 2000) } }]
}

function buildValueFor(
  prop: NotionPropertyMeta,
  key: keyof SchemaPayload,
  payloadValue: any,
): any | null {
  switch (prop.type) {
    case 'title':
      return { title: asRichText(String(payloadValue ?? '')) }
    case 'rich_text':
      return { rich_text: asRichText(String(payloadValue ?? '')) }
    case 'date': {
      if (!payloadValue) return null
      if (typeof payloadValue === 'string') return { date: { start: payloadValue } }
      if (typeof payloadValue === 'object' && payloadValue.start) {
        const out: any = { start: payloadValue.start }
        if (payloadValue.end) out.end = payloadValue.end
        return { date: out }
      }
      return null
    }
    case 'select':
      if (!payloadValue) return null
      return {
        select: {
          name: Array.isArray(payloadValue) ? String(payloadValue[0]) : String(payloadValue),
        },
      }
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
    case 'number':
      if (typeof payloadValue !== 'number') return null
      return { number: payloadValue }
    case 'checkbox':
      return { checkbox: Boolean(payloadValue) }
    default:
      return null
  }
}

export interface MapOptions {
  /** Exact name of the date property to write to. Falls back to auto-detect if not in schema. */
  dateProperty?: string
}

/** Return the writable date-type properties of a Notion DB. */
export function listDateProperties(schema: NotionPropertyMap): NotionPropertyMeta[] {
  return Object.values(schema).filter((p) => p.type === 'date')
}

/**
 * Map a generic payload (title, date, type, etc.) to a Notion `properties`
 * object that matches the destination database's actual schema. Unknown or
 * missing destinations are skipped silently.
 *
 * `options.dateProperty` lets the caller pin which date property the calendar
 * view should pick up (e.g. "Due Date" vs "Date" vs "When"). If the named
 * property doesn't exist on the DB the helper falls back to auto-detection.
 */
export function mapToDbSchema(
  schema: NotionPropertyMap,
  payload: SchemaPayload,
  options: MapOptions = {},
): Record<string, any> {
  const properties: Record<string, any> = {}
  const used = new Set<string>()

  // Title: always the property of type 'title', regardless of its name.
  if (payload.title !== undefined) {
    const titleProp = findTitle(schema)
    if (titleProp) {
      const value = buildValueFor(titleProp, 'title', payload.title)
      if (value) {
        properties[titleProp.name] = value
        used.add(titleProp.name)
      }
    }
  }

  const orderedKeys: (keyof SchemaPayload)[] = [
    'date',
    'type',
    'status',
    'priority',
    'tags',
    'url',
    'description',
  ]
  for (const key of orderedKeys) {
    const payloadValue = payload[key]
    if (payloadValue === undefined || payloadValue === null || payloadValue === '') continue
    let prop: NotionPropertyMeta | null = null
    if (key === 'date' && options.dateProperty) {
      const override = schema[options.dateProperty]
      if (override && override.type === 'date') prop = override
    }
    if (!prop) prop = findPropertyForKey(schema, key, used)
    if (!prop) continue
    const value = buildValueFor(prop, key, payloadValue)
    if (value) {
      properties[prop.name] = value
      used.add(prop.name)
    }
  }

  return properties
}
