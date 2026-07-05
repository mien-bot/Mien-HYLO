/**
 * Claude AI service for React Native / iOS
 *
 * Supports two modes:
 *   1. Direct API — sends requests to api.anthropic.com with your API key
 *   2. Relay mode — sends requests to your Mien relay server (which handles auth)
 *
 * Set "relayUrl" in Settings to use relay mode (e.g. http://192.168.1.50:3456)
 * If relayUrl is set, no API key is needed on the phone.
 */
import { getDb } from '../lib/database'
import { getSecure, getSettings } from '../lib/storage'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const OPUS_MODEL = 'claude-opus-4-8'
const HAIKU_MODEL = 'claude-haiku-4-5'
const API_VERSION = '2023-06-01'

async function getModel(): Promise<string> {
  const settings = await getSettings()
  const opus = (settings as any).opusMode
  if (opus === true || opus === 'true') return OPUS_MODEL
  return settings.aiModel || DEFAULT_MODEL
}

/** Per-chat override ('sonnet'/'opus' or a raw claude-* id) wins; else global. */
async function resolveChatModel(override?: string): Promise<string> {
  if (override === 'opus') return OPUS_MODEL
  if (override === 'sonnet') return DEFAULT_MODEL
  if (override && override.startsWith('claude-')) return override
  return getModel()
}

async function isAutoMemoryEnabled(): Promise<boolean> {
  const settings = (await getSettings()) as any
  return settings.chatAutoMemory !== 'false' && settings.chatAutoMemory !== false
}

interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string
}

async function getEndpoint(): Promise<{ url: string; headers: Record<string, string> }> {
  const settings = await getSettings()
  const relayUrl = settings.relayUrl
  const apiKey = await getSecure('claudeApiKey')

  // Relay mode — no API key needed on the phone
  if (relayUrl) {
    const baseUrl = relayUrl.replace(/\/$/, '')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    // Add auth token if configured
    if (settings.relayToken) {
      headers['Authorization'] = `Bearer ${settings.relayToken}`
    }
    return { url: `${baseUrl}/v1/messages`, headers }
  }

  // Direct API mode — needs API key
  if (!apiKey) {
    throw new Error('No AI configured. Either set a Relay URL or add a Claude API key in Settings.')
  }

  return {
    url: ANTHROPIC_API_URL,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
  }
}

async function getDirectEndpoint(): Promise<{ url: string; headers: Record<string, string> } | null> {
  const apiKey = await getSecure('claudeApiKey')
  if (!apiKey) return null
  return {
    url: ANTHROPIC_API_URL,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
  }
}

/**
 * Send a non-streaming message
 */
async function callClaude(
  systemPrompt: string,
  messages: ClaudeMessage[],
  cacheConversation = false,
  modelOverride?: string,
): Promise<string> {
  const { url, headers } = await getEndpoint()
  const model = modelOverride || (await getModel())
  const body: any = {
    model,
    max_tokens: 4096,
    // Wrap system as a content block so cache_control attaches to it.
    // Silently no-ops if the rendered prefix is below the 2048-token minimum.
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages,
  }
  if (cacheConversation) {
    // Auto-place a breakpoint on the last cacheable message — incremental
    // conversation caching as turns accumulate.
    body.cache_control = { type: 'ephemeral' }
  }
  const payload = JSON.stringify(body)

  console.log('[AI] Calling:', url, 'model:', model)

  let res = await fetch(url, { method: 'POST', headers, body: payload })

  // Fallback to direct API key if relay returns auth error
  if ((res.status === 401 || res.status === 403) && url !== ANTHROPIC_API_URL) {
    console.log('[AI] Relay auth failed, trying direct API key...')
    const direct = await getDirectEndpoint()
    if (direct) {
      res = await fetch(direct.url, { method: 'POST', headers: direct.headers, body: payload })
    }
  }

  if (!res.ok) {
    const errBody = await res.text()
    if (res.status === 429) {
      console.warn('[AI] Rate limited by upstream provider')
      throw new Error('AI rate limit reached. Try again later.')
    }
    console.error('[AI] Error response:', res.status, errBody)
    throw new Error(`AI error ${res.status}: ${errBody}`)
  }

  const data = await res.json()

  if (data.error) {
    throw new Error(data.error.message)
  }

  return data.content
    .filter((block: any) => block.type === 'text' && block.text)
    .map((block: any) => block.text)
    .join('')
}

/**
 * Stream a message using SSE
 */
async function streamClaude(
  systemPrompt: string,
  messages: ClaudeMessage[],
  onChunk: (chunk: string) => void,
  cacheConversation = false,
  modelOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  const { url, headers } = await getEndpoint()

  // React Native's fetch often doesn't support ReadableStream.getReader()
  // Try streaming first, fall back to non-streaming if not supported
  let useStream = true
  try {
    // Quick check: if ReadableStream isn't available, skip streaming
    if (typeof ReadableStream === 'undefined') useStream = false
  } catch {
    useStream = false
  }

  const model = modelOverride || (await getModel())
  const body: any = {
    model,
    max_tokens: 4096,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages,
    stream: useStream,
  }
  if (cacheConversation) {
    body.cache_control = { type: 'ephemeral' }
  }
  const payload = JSON.stringify(body)

  let res = await fetch(url, { method: 'POST', headers, body: payload, signal })

  // Fallback to direct API key if relay returns auth error
  if ((res.status === 401 || res.status === 403) && url !== ANTHROPIC_API_URL) {
    console.log('[AI] Relay auth failed (stream), trying direct API key...')
    const direct = await getDirectEndpoint()
    if (direct) {
      res = await fetch(direct.url, { method: 'POST', headers: direct.headers, body: payload, signal })
    }
  }

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`AI error ${res.status}: ${errBody}`)
  }

  // Non-streaming fallback: parse the full JSON response
  const reader = useStream ? res.body?.getReader() : null
  if (!reader) {
    const text = await res.text()
    try {
      const data = JSON.parse(text)
      const result = data.content
        ?.filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('') || ''
      onChunk(result)
      return result
    } catch {
      // If the response was SSE (stream was sent despite our request), parse it manually
      let fullResponse = ''
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') continue
        try {
          const event = JSON.parse(payload)
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            fullResponse += event.delta.text
          }
        } catch {}
      }
      if (fullResponse) {
        onChunk(fullResponse)
        return fullResponse
      }
      throw new Error('Failed to parse AI response')
    }
  }

  const decoder = new TextDecoder()
  let fullResponse = ''
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue

        try {
          const event = JSON.parse(data)
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text
            fullResponse += text
            onChunk(text)
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } catch (err) {
    // If the user stopped generation, keep whatever streamed so far.
    if (signal?.aborted) {
      try {
        await reader.cancel()
      } catch {}
      return fullResponse
    }
    throw err
  }

  return fullResponse
}

/**
 * Build context string from local DB (watchlist + health) for richer chat
 */
async function buildContextString(): Promise<string> {
  const db = await getDb()
  const parts: string[] = []

  try {
    const memoryBlock = await buildMemoryBlock()
    if (memoryBlock) {
      parts.push(
        `What you remember about the user (durable facts across conversations — use naturally, don't restate unprompted):\n${memoryBlock}`,
      )
    }
  } catch {}

  try {
    // Portfolio context: watchlist symbols + latest prices
    const watchlist = await db.getAllAsync(
      'SELECT symbol, type, name FROM watchlist ORDER BY added_at DESC LIMIT 15'
    ) as Array<{ symbol: string; type: string; name: string | null }>

    if (watchlist.length > 0) {
      const priceRows = await db.getAllAsync(
        `SELECT symbol, close, date FROM price_history
         WHERE date = (SELECT MAX(date) FROM price_history)
         ORDER BY symbol`
      ) as Array<{ symbol: string; close: number; date: string }>

      const priceMap: Record<string, number> = {}
      for (const row of priceRows) {
        priceMap[row.symbol] = row.close
      }

      const lines = watchlist.map(w => {
        const price = priceMap[w.symbol]
        return `- ${w.symbol} (${w.type})${w.name ? ` "${w.name}"` : ''}${price ? ` — last $${price.toFixed(2)}` : ''}`
      })
      parts.push(`User's watchlist:\n${lines.join('\n')}`)
    }

    // Health context: last 3 days of metrics
    const healthRows = await db.getAllAsync(
      `SELECT metric_type, date, value_json FROM health_metrics
       WHERE date >= date('now', '-3 days')
       ORDER BY date DESC`
    ) as Array<{ metric_type: string; date: string; value_json: string }>

    if (healthRows.length > 0) {
      const lines = healthRows.map(h => {
        try {
          const v = JSON.parse(h.value_json)
          switch (h.metric_type) {
            case 'sleep': {
              const hrs = ((v.totalAsleep || v.asleep || v.qty || 0) / 60).toFixed(1)
              return `- ${h.date} Sleep: ${hrs}h (deep ${v.deep || 0}m, REM ${v.rem || 0}m, core ${v.core || 0}m)`
            }
            case 'heart_rate':
              return `- ${h.date} HR: ${v.qty || v.value || '?'} bpm`
            case 'hrv':
              return `- ${h.date} HRV: ${v.qty || v.value || '?'} ms`
            case 'steps':
              return `- ${h.date} Steps: ${(v.qty || v.value || 0).toLocaleString()}`
            default:
              return `- ${h.date} ${h.metric_type}: ${JSON.stringify(v)}`
          }
        } catch {
          return `- ${h.date} ${h.metric_type}: (parse error)`
        }
      })
      parts.push(`Recent health data:\n${lines.join('\n')}`)
    }
  } catch (err) {
    console.error('[AI] Error building context:', err)
  }

  return parts.length > 0
    ? `\n\nContext about the user (use if relevant):\n${parts.join('\n\n')}`
    : ''
}

/**
 * Chat with conversation history
 */
export async function chat(
  message: string,
  systemPrompt: string,
  conversationId: string = 'default',
  onChunk?: (chunk: string) => void,
  modelOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  const db = await getDb()

  await db.runAsync(
    'INSERT INTO chat_messages (role, content, conversation_id) VALUES (?, ?, ?)',
    'user', message, conversationId
  )
  await ensureConversation(conversationId)

  const model = await resolveChatModel(modelOverride)
  return runChatTurn(db, enrich(systemPrompt), conversationId, model, onChunk, signal)
}

/**
 * Re-run the last turn: drop the most recent assistant message, then stream a
 * fresh reply from the same history (the trailing user message is preserved).
 */
export async function regenerateLastResponse(
  systemPrompt: string,
  conversationId: string = 'default',
  onChunk?: (chunk: string) => void,
  modelOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  const db = await getDb()
  const last = await db.getFirstAsync(
    `SELECT id, role FROM chat_messages WHERE conversation_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    conversationId,
  ) as { id: number; role: string } | null
  if (last && last.role === 'assistant') {
    await db.runAsync('DELETE FROM chat_messages WHERE id = ?', last.id)
  }
  const model = await resolveChatModel(modelOverride)
  return runChatTurn(db, enrich(systemPrompt), conversationId, model, onChunk, signal)
}

// Lazily appended portfolio/health/memory context for the system prompt.
async function enrich(systemPrompt: string): Promise<string> {
  return systemPrompt + (await buildContextString())
}

// Shared streaming/non-streaming turn. Assumes the new user message (if any)
// is already persisted. Saves the assistant reply + fires background jobs.
async function runChatTurn(
  db: Awaited<ReturnType<typeof getDb>>,
  systemPromptPromise: string | Promise<string>,
  conversationId: string,
  model: string,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const enrichedPrompt = await systemPromptPromise

  const history = await db.getAllAsync(
    `SELECT role, content FROM chat_messages
     WHERE conversation_id = ? AND role != 'system'
     ORDER BY created_at DESC LIMIT 200`,
    conversationId
  ) as Array<{ role: string; content: string }>

  const messages: ClaudeMessage[] = history.reverse().map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content
  }))

  let fullResponse = ''
  let aborted = false
  try {
    if (onChunk) {
      fullResponse = await streamClaude(enrichedPrompt, messages, onChunk, true, model, signal)
    } else {
      fullResponse = await callClaude(enrichedPrompt, messages, true, model)
    }
  } catch (err: any) {
    if (signal?.aborted) {
      aborted = true
    } else {
      fullResponse = fullResponse || `Error: ${err.message || 'Unknown error'}`
      console.error('AI error:', err)
    }
  }

  // Skip persistence + background jobs entirely if the user stopped before any
  // text arrived (avoids an empty assistant bubble).
  if (!fullResponse && aborted) return ''

  await db.runAsync(
    'INSERT INTO chat_messages (role, content, conversation_id) VALUES (?, ?, ?)',
    'assistant', fullResponse, conversationId
  )
  await touchConversation(conversationId)

  // Background jobs — best effort, don't block the caller.
  void maybeGenerateTitle(conversationId)
  if (await isAutoMemoryEnabled()) void extractMemoryFromConversation(conversationId)

  return fullResponse
}

// ---------------------------------------------------------------------------
// Conversation metadata (title / pin / delete)
// ---------------------------------------------------------------------------

export interface ConversationRow {
  conversation_id: string
  title: string
  last_message_at: string
  message_count: number
  pinned: number
}

export async function ensureConversation(conversationId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `INSERT INTO conversations (conversation_id) VALUES (?) ON CONFLICT(conversation_id) DO NOTHING`,
    conversationId,
  )
}

async function touchConversation(conversationId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `UPDATE conversations SET updated_at = datetime('now') WHERE conversation_id = ?`,
    conversationId,
  )
}

export async function listConversations(): Promise<ConversationRow[]> {
  const db = await getDb()
  return (await db.getAllAsync(
    `SELECT
       m.conversation_id AS conversation_id,
       COALESCE(c.title, MIN(CASE WHEN m.role = 'user' THEN m.content END)) AS title,
       MAX(m.created_at) AS last_message_at,
       COUNT(*) AS message_count,
       COALESCE(c.pinned, 0) AS pinned
     FROM chat_messages m
     LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
     WHERE COALESCE(c.archived, 0) = 0
     GROUP BY m.conversation_id
     ORDER BY COALESCE(c.pinned, 0) DESC, MAX(m.created_at) DESC`,
  )) as ConversationRow[]
}

export async function renameConversation(conversationId: string, title: string): Promise<void> {
  await ensureConversation(conversationId)
  const db = await getDb()
  await db.runAsync(
    `UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
    title.trim().slice(0, 100),
    conversationId,
  )
}

export async function setConversationPinned(
  conversationId: string,
  pinned: boolean,
): Promise<void> {
  await ensureConversation(conversationId)
  const db = await getDb()
  await db.runAsync(
    `UPDATE conversations SET pinned = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
    pinned ? 1 : 0,
    conversationId,
  )
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM chat_messages WHERE conversation_id = ?', conversationId)
  await db.runAsync('DELETE FROM conversations WHERE conversation_id = ?', conversationId)
}

export async function deleteMessagesFrom(
  conversationId: string,
  messageId: number,
): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    'DELETE FROM chat_messages WHERE conversation_id = ? AND id >= ?',
    conversationId,
    messageId,
  )
}

// ---------------------------------------------------------------------------
// Durable cross-conversation memory
// ---------------------------------------------------------------------------

export interface MemoryRow {
  id: number
  content: string
  category: string
  pinned: number
  created_at: string
  updated_at: string
}

export async function listMemories(): Promise<MemoryRow[]> {
  const db = await getDb()
  return (await db.getAllAsync(
    `SELECT id, content, category, pinned, created_at, updated_at FROM chat_memory
     ORDER BY pinned DESC, updated_at DESC`,
  )) as MemoryRow[]
}

export async function addMemory(content: string, category = 'general'): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    'INSERT INTO chat_memory (content, category) VALUES (?, ?)',
    content.trim(),
    category,
  )
}

export async function updateMemory(id: number, content: string): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `UPDATE chat_memory SET content = ?, updated_at = datetime('now') WHERE id = ?`,
    content.trim(),
    id,
  )
}

export async function deleteMemory(id: number): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM chat_memory WHERE id = ?', id)
}

export async function clearMemories(): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM chat_memory')
}

async function buildMemoryBlock(): Promise<string> {
  const memories = await listMemories()
  if (memories.length === 0) return ''
  return memories.map((m) => `- ${m.content}`).join('\n')
}

const MEMORY_EXTRACTION_SYSTEM = `You maintain a long-term memory of durable facts about a single user, so a personal assistant can have better future conversations.

You are given the user's EXISTING MEMORIES and the latest exchange from a conversation. Decide what (if anything) should change.

Remember ONLY durable, user-specific facts worth recalling weeks later: stable preferences, goals, positions/holdings they say they own, recurring routines, personal context, constraints, and how they want the assistant to respond.

DO NOT remember: one-off questions, transient market/price numbers, anything already captured, general knowledge, or the assistant's own statements.

Respond with ONLY a JSON object (no prose, no code fences) in this exact shape:
{"add": ["new fact"], "update": [{"id": 12, "content": "revised fact"}], "delete": [3]}

Use [] for any empty list. If nothing should change, respond with {"add":[],"update":[],"delete":[]}.`

function parseMemoryOps(raw: string): {
  add: string[]
  update: Array<{ id: number; content: string }>
  delete: number[]
} | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const obj = JSON.parse(match[0])
    return {
      add: Array.isArray(obj.add) ? obj.add.filter((x: any) => typeof x === 'string') : [],
      update: Array.isArray(obj.update)
        ? obj.update.filter((x: any) => x && typeof x.id === 'number' && typeof x.content === 'string')
        : [],
      delete: Array.isArray(obj.delete) ? obj.delete.filter((x: any) => typeof x === 'number') : [],
    }
  } catch {
    return null
  }
}

export async function extractMemoryFromConversation(conversationId: string): Promise<void> {
  try {
    const db = await getDb()
    const recent = (await db.getAllAsync(
      `SELECT role, content FROM chat_messages WHERE conversation_id = ? AND role != 'system'
       ORDER BY created_at DESC LIMIT 6`,
      conversationId,
    )) as Array<{ role: string; content: string }>
    if (recent.length === 0) return

    const transcript = recent
      .reverse()
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`)
      .join('\n')

    const existing = await listMemories()
    const existingBlock =
      existing.length > 0 ? existing.map((m) => `[${m.id}] ${m.content}`).join('\n') : '(none yet)'

    const raw = await callClaude(
      MEMORY_EXTRACTION_SYSTEM,
      [{ role: 'user', content: `EXISTING MEMORIES:\n${existingBlock}\n\nLATEST EXCHANGE:\n${transcript}` }],
      false,
      HAIKU_MODEL,
    )

    const ops = parseMemoryOps(raw)
    if (!ops) return

    const existingIds = new Set(existing.map((m) => m.id))
    for (const id of ops.delete) if (existingIds.has(id)) await deleteMemory(id)
    for (const u of ops.update) if (existingIds.has(u.id) && u.content.trim()) await updateMemory(u.id, u.content)
    const seen = new Set(existing.map((m) => m.content.toLowerCase().trim()))
    for (const add of ops.add) {
      const c = add.trim()
      if (c && !seen.has(c.toLowerCase())) {
        await addMemory(c)
        seen.add(c.toLowerCase())
      }
    }
  } catch (err) {
    console.error('[AI] memory extraction failed:', err)
  }
}

async function maybeGenerateTitle(conversationId: string): Promise<void> {
  try {
    const db = await getDb()
    const conv = (await db.getFirstAsync(
      'SELECT title FROM conversations WHERE conversation_id = ?',
      conversationId,
    )) as { title: string | null } | null
    if (conv?.title) return

    const msgs = (await db.getAllAsync(
      `SELECT role, content FROM chat_messages WHERE conversation_id = ? AND role != 'system'
       ORDER BY created_at ASC LIMIT 4`,
      conversationId,
    )) as Array<{ role: string; content: string }>
    if (!msgs.some((m) => m.role === 'user') || !msgs.some((m) => m.role === 'assistant')) return

    const transcript = msgs
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
      .join('\n')
    const raw = await callClaude(
      'You generate ultra-short chat titles. Reply with ONLY the title: 2-6 words, Title Case, no surrounding quotes, no trailing punctuation.',
      [{ role: 'user', content: `Title this conversation:\n\n${transcript}` }],
      false,
      HAIKU_MODEL,
    )
    const clean = raw.trim().replace(/^["']|["']$/g, '').replace(/[.]+$/, '').slice(0, 60)
    if (clean) {
      await ensureConversation(conversationId)
      await db.runAsync(
        `UPDATE conversations SET title = ? WHERE conversation_id = ? AND title IS NULL`,
        clean,
        conversationId,
      )
    }
  } catch (err) {
    console.error('[AI] title generation failed:', err)
  }
}

/**
 * One-shot analysis (no conversation history)
 */
export async function generateAnalysis(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  return callClaude(systemPrompt, [{ role: 'user', content: userPrompt }])
}

/**
 * One-shot analysis with server-side web search enabled. Lets Claude ground
 * answers in current info (e.g. trending / newly-opened places). Routes through
 * the relay or direct API the same way as callClaude, with the same auth fallback.
 */
export async function generateAnalysisWebSearch(
  systemPrompt: string,
  userPrompt: string,
  maxSearches = 5,
): Promise<string> {
  const { url, headers } = await getEndpoint()
  const model = await getModel()
  const body: any = {
    model,
    max_tokens: 4096,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }],
  }
  const payload = JSON.stringify(body)

  let res = await fetch(url, { method: 'POST', headers, body: payload })
  if ((res.status === 401 || res.status === 403) && url !== ANTHROPIC_API_URL) {
    const direct = await getDirectEndpoint()
    if (direct) {
      res = await fetch(direct.url, { method: 'POST', headers: direct.headers, body: payload })
    }
  }
  if (!res.ok) {
    const errBody = await res.text()
    if (res.status === 429) throw new Error('AI rate limit reached. Try again later.')
    throw new Error(`AI error ${res.status}: ${errBody}`)
  }
  const data = await res.json()
  if (data.error) throw new Error(data.error.message)
  return (data.content || [])
    .filter((block: any) => block.type === 'text' && block.text)
    .map((block: any) => block.text)
    .join('')
}
