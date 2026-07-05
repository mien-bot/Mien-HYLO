import { Client } from '@notionhq/client'
import { getAppSettings } from '../../lib/settings'
let client: Client | null = null
let lastApiKey: string | null = null
const dataSourceIdCache = new Map<string, string>()
const NOTION_VERSION = '2025-09-03'

export function getNotionClient(): Client {
  const settings = getAppSettings()
  const apiKey = settings?.notionApiKey
  if (!apiKey) {
    throw new Error('Notion API key not configured. Add it in Settings.')
  }
  if (!client || lastApiKey !== apiKey) {
    client = new Client({ auth: apiKey, notionVersion: NOTION_VERSION })
    lastApiKey = apiKey
    dataSourceIdCache.clear()
  }
  return client
}

export async function resolveNotionDataSourceId(id: string): Promise<string> {
  const trimmed = id?.trim()
  if (!trimmed) throw new Error('Notion database/data source ID is required.')

  const cached = dataSourceIdCache.get(trimmed)
  if (cached) return cached

  const notion = getNotionClient()

  try {
    await notion.dataSources.retrieve({ data_source_id: trimmed })
    dataSourceIdCache.set(trimmed, trimmed)
    return trimmed
  } catch (dataSourceErr) {
    try {
      const db = (await notion.databases.retrieve({ database_id: trimmed })) as Record<
        string,
        unknown
      >
      const dataSourceId = db.data_sources?.[0]?.id
      if (!dataSourceId) {
        throw new Error('No data sources found for this Notion database.')
      }
      dataSourceIdCache.set(trimmed, dataSourceId)
      dataSourceIdCache.set(dataSourceId, dataSourceId)
      return dataSourceId
    } catch {
      throw dataSourceErr
    }
  }
}

export function getNotionDbIds(): {
  tasksDbId: string | null
  briefingsDbId: string | null
  calendarDbId: string | null
} {
  const settings = getAppSettings()
  return {
    tasksDbId: settings?.notionTasksDbId?.trim() || null,
    briefingsDbId: settings?.notionBriefingsDbId?.trim() || null,
    calendarDbId: settings?.notionCalendarDbId?.trim() || null,
  }
}

/** Per-role date property names — picked in Settings to control which date the
 *  Notion calendar view groups exported pages under. */
export function getNotionDateProperties(): { briefings: string | null; calendar: string | null } {
  const settings = getAppSettings()
  return {
    briefings: settings?.notionBriefingsDateProperty || null,
    calendar: settings?.notionCalendarDateProperty || null,
  }
}
