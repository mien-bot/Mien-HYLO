/**
 * Export the local SQLite content as plain Markdown files for backup,
 * Obsidian sync, or sharing. Each table writes into its own subfolder.
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/database'

interface ExportResult {
  ok: boolean
  folder: string
  files: number
  bytes: number
  byTable: Record<string, number>
  error?: string
}

function sanitize(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function frontmatter(fields: Record<string, string | number | null | undefined>): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue
    const str = String(v).replace(/"/g, '\\"').replace(/\n/g, ' ')
    lines.push(`${k}: "${str}"`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

function writeFile(folder: string, name: string, content: string): number {
  fs.mkdirSync(folder, { recursive: true })
  const full = path.join(folder, name)
  fs.writeFileSync(full, content, 'utf8')
  return Buffer.byteLength(content, 'utf8')
}

export async function exportMarkdown(folderPath: string): Promise<ExportResult> {
  if (!folderPath) {
    return { ok: false, folder: '', files: 0, bytes: 0, byTable: {}, error: 'No folder selected' }
  }

  const db = getDb()
  const root = path.resolve(folderPath)
  fs.mkdirSync(root, { recursive: true })

  const byTable: Record<string, number> = {}
  let files = 0
  let bytes = 0

  // Briefings
  try {
    const briefings = db
      .prepare('SELECT id, type, date, content, created_at FROM briefings ORDER BY created_at DESC')
      .all() as Array<{
      id: number
      type: string
      date: string
      content: string
      created_at: string
    }>
    const folder = path.join(root, 'briefings')
    for (const b of briefings) {
      const name = `${b.date}-${sanitize(b.type)}.md`
      const body =
        frontmatter({ id: b.id, type: b.type, date: b.date, created_at: b.created_at }) +
        b.content +
        '\n'
      bytes += writeFile(folder, name, body)
      files++
    }
    byTable.briefings = briefings.length
  } catch (err) {
    console.error('Briefing export failed:', err)
  }

  // Weekend plans
  try {
    const plans = db
      .prepare(
        'SELECT id, weekend_date, plan_json, ai_rationale, created_at FROM weekend_plans ORDER BY weekend_date DESC',
      )
      .all() as Array<{
      id: number
      weekend_date: string
      plan_json: string
      ai_rationale: string | null
      created_at: string
    }>
    const folder = path.join(root, 'weekend-plans')
    for (const p of plans) {
      const name = `${p.weekend_date}.md`
      const head = frontmatter({ id: p.id, weekend_date: p.weekend_date, created_at: p.created_at })
      let activities = ''
      try {
        const parsed = JSON.parse(p.plan_json)
        const renderDay = (day: string, items: any[] = []) => {
          if (items.length === 0) return ''
          return (
            `\n## ${day}\n\n` +
            items
              .map(
                (a: any) =>
                  `- **${a.time || '—'}** ${a.activity || ''}${a.location ? ` — ${a.location}` : ''}${a.cost ? ` (${a.cost})` : ''}${a.rationale ? `\n  - ${a.rationale}` : ''}`,
              )
              .join('\n') +
            '\n'
          )
        }
        activities =
          renderDay('Saturday', parsed.saturday || []) + renderDay('Sunday', parsed.sunday || [])
      } catch {
        activities = '\n```json\n' + p.plan_json + '\n```\n'
      }
      const notes = p.ai_rationale ? `\n## Notes\n\n${p.ai_rationale}\n` : ''
      const body = head + `# Weekend of ${p.weekend_date}\n` + activities + notes
      bytes += writeFile(folder, name, body)
      files++
    }
    byTable.weekend_plans = plans.length
  } catch (err) {
    console.error('Weekend plans export failed:', err)
  }

  // Daily schedules
  try {
    const schedules = db
      .prepare(
        'SELECT id, date, schedule_json, ai_rationale, created_at FROM daily_schedule ORDER BY date DESC',
      )
      .all() as Array<{
      id: number
      date: string
      schedule_json: string
      ai_rationale: string | null
      created_at: string
    }>
    const folder = path.join(root, 'daily-schedules')
    for (const s of schedules) {
      const name = `${s.date}.md`
      const head = frontmatter({ id: s.id, date: s.date, created_at: s.created_at })
      let blocks = ''
      try {
        const arr = JSON.parse(s.schedule_json)
        if (Array.isArray(arr)) {
          blocks = arr
            .map(
              (b: any) =>
                `- **${b.time || '—'}** ${b.activity || ''}${b.rationale ? `\n  - ${b.rationale}` : ''}`,
            )
            .join('\n')
        }
      } catch {
        blocks = '```json\n' + s.schedule_json + '\n```'
      }
      const notes = s.ai_rationale ? `\n## Notes\n\n${s.ai_rationale}\n` : ''
      const body = head + `# Schedule for ${s.date}\n\n` + blocks + '\n' + notes
      bytes += writeFile(folder, name, body)
      files++
    }
    byTable.daily_schedule = schedules.length
  } catch (err) {
    console.error('Daily schedule export failed:', err)
  }

  // Saved restaurants
  try {
    const restaurants = db
      .prepare(
        `SELECT id, place_id, name, address, price_level, rating, cuisine, lat, lng, notes,
              venue_type, cuisine_category, description, personal_rating, visited, visit_date
       FROM saved_restaurants ORDER BY name ASC`,
      )
      .all() as Array<any>
    const folder = path.join(root, 'restaurants')
    for (const r of restaurants) {
      const name = `${sanitize(r.name)}-${r.place_id.slice(0, 8)}.md`
      const head = frontmatter({
        name: r.name,
        address: r.address,
        cuisine: r.cuisine || r.cuisine_category,
        price: r.price_level,
        rating: r.rating,
        personal_rating: r.personal_rating,
        visited: r.visited,
        visit_date: r.visit_date,
        venue_type: r.venue_type,
      })
      const body =
        head +
        `# ${r.name}\n\n` +
        (r.description ? `${r.description}\n\n` : '') +
        (r.notes ? `## Notes\n\n${r.notes}\n` : '')
      bytes += writeFile(folder, name, body)
      files++
    }
    byTable.saved_restaurants = restaurants.length
  } catch (err) {
    console.error('Restaurants export failed:', err)
  }

  // Chat messages — group by conversation
  try {
    const chats = db
      .prepare(
        `SELECT conversation_id, role, content, created_at FROM chat_messages ORDER BY conversation_id, created_at ASC`,
      )
      .all() as Array<{
      conversation_id: string
      role: string
      content: string
      created_at: string
    }>
    const grouped: Record<string, typeof chats> = {}
    for (const m of chats) {
      if (!grouped[m.conversation_id]) grouped[m.conversation_id] = []
      grouped[m.conversation_id].push(m)
    }
    const folder = path.join(root, 'chats')
    for (const [conv, msgs] of Object.entries(grouped)) {
      const first = msgs.find((m) => m.role === 'user')?.content || ''
      const title = sanitize(first.slice(0, 60)) || conv.slice(0, 12)
      const name = `${msgs[0].created_at.slice(0, 10)}-${title || conv}.md`
      const head = frontmatter({
        conversation_id: conv,
        started: msgs[0].created_at,
        ended: msgs[msgs.length - 1].created_at,
        message_count: msgs.length,
      })
      const body =
        head +
        msgs.map((m) => `**${m.role}** _(${m.created_at})_\n\n${m.content}\n`).join('\n---\n\n')
      bytes += writeFile(folder, name, body)
      files++
    }
    byTable.chat_messages = chats.length
  } catch (err) {
    console.error('Chat export failed:', err)
  }

  // Write an index README so a fresh folder is browseable
  const indexLines = [
    '# Mien export',
    '',
    `Exported on ${new Date().toISOString()}.`,
    '',
    '## Contents',
    '',
    ...Object.entries(byTable).map(([t, n]) => `- **${t}** — ${n} records`),
    '',
    `Total: ${files} files, ${(bytes / 1024).toFixed(1)} KB.`,
  ]
  bytes += writeFile(root, 'README.md', indexLines.join('\n') + '\n')
  files++

  return { ok: true, folder: root, files, bytes, byTable }
}
