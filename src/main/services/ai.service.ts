/**
 * Claude AI service for Electron main process
 *
 * Uses the official @anthropic-ai/sdk with support for:
 *   - Direct API mode (API key)
 *   - Relay mode (proxy server)
 *   - Web search tool (live financial data)
 *   - Extended thinking (deeper analysis)
 *   - Code execution (financial modeling)
 *   - Automatic retries (SDK built-in)
 */
import { BrowserWindow } from 'electron'
import Anthropic from '../lib/anthropic'
import { getDb } from '../db/database'
import { getAppSettings } from '../lib/settings'
import { AGENT_TOOLS, TOOL_LABELS, executeAgentTool } from './ai-tools'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const OPUS_MODEL = 'claude-opus-4-8'
const HAIKU_MODEL = 'claude-haiku-4-5'

function getModel(): string {
  const settings = getAppSettings()
  const opus = settings?.opusMode
  const enabled = opus === true || opus === 'true'
  return enabled ? OPUS_MODEL : DEFAULT_MODEL
}

/**
 * Resolve the model for a chat turn. A per-chat override (`'sonnet'` /
 * `'opus'`, or a raw `claude-*` id) wins; otherwise fall back to the global
 * Opus-mode setting via getModel().
 */
function resolveChatModel(override?: string): string {
  if (override === 'opus') return OPUS_MODEL
  if (override === 'sonnet') return DEFAULT_MODEL
  if (override && override.startsWith('claude-')) return override
  return getModel()
}

/** Auto-memory extraction is on unless explicitly disabled in settings. */
function isAutoMemoryEnabled(): boolean {
  const v = getAppSettings()?.chatAutoMemory
  return v !== 'false' && (v as unknown) !== false
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }

interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeContentBlock[]
}

/** An image/PDF attachment the renderer sends with a user message. */
export interface ChatAttachmentInput {
  kind: 'image' | 'document'
  media_type: string
  name?: string
  /** Raw base64 (the `data:...;base64,` prefix is stripped on save). */
  data_base64: string
}

export interface ChatAttachmentRow {
  id: number
  message_id: number
  conversation_id: string
  kind: 'image' | 'document'
  media_type: string
  name: string | null
  data_base64: string
}

export interface ChatSearchResult {
  id: number
  conversation_id: string
  title: string
  role: string
  snippet: string
  created_at: string
}

export interface AnalysisOptions {
  webSearch?: boolean
  thinking?: boolean
  codeExecution?: boolean
  /** Optional per-call model override. Defaults to the configured global model. */
  model?: string
  /**
   * When true (default), wrap the system prompt in a content block with
   * `cache_control: {type: 'ephemeral'}` so repeated calls with the same
   * system + tools render from the prompt cache. Silently no-ops when the
   * prefix is below the model's minimum cacheable size (2048 tokens for
   * Sonnet 4.6, 4096 for Opus/Haiku) — no error, just no cache hit.
   */
  cacheSystem?: boolean
  maxTokens?: number
  /** Thinking depth + token spend when `thinking` is on. Defaults to 'high'. */
  effort?: 'low' | 'medium' | 'high' | 'max'
}

let cachedClient: InstanceType<typeof Anthropic> | null = null
let cachedSettingsKey = ''

function getClient(): InstanceType<typeof Anthropic> {
  const settings = getAppSettings()

  const relayUrl = settings?.relayUrl || ''
  const relayToken = settings?.relayToken || ''
  const apiKey = settings?.claudeApiKey || ''
  const settingsKey = `${relayUrl}|${relayToken}|${apiKey}`

  if (cachedClient && settingsKey === cachedSettingsKey) {
    return cachedClient
  }

  // Relay mode (preferred — avoids needing a direct API key)
  if (relayUrl) {
    const baseURL = relayUrl.replace(/\/$/, '')
    const headers: Record<string, string> = {
      // Cloudflare Tunnel blocks the SDK's default User-Agent
      'User-Agent': 'Mien/1.0',
    }
    if (relayToken) {
      headers['Authorization'] = `Bearer ${relayToken}`
    }
    cachedClient = new Anthropic({
      apiKey: 'relay-mode',
      baseURL,
      defaultHeaders: headers,
      maxRetries: 2,
      timeout: 120_000, // 2 min — relay streams can be slow
    })
    cachedSettingsKey = settingsKey
    return cachedClient
  }

  // Direct API mode (fallback)
  if (apiKey) {
    cachedClient = new Anthropic({
      apiKey,
      maxRetries: 2,
      timeout: 120_000,
    })
    cachedSettingsKey = settingsKey
    return cachedClient
  }

  throw new Error('No AI configured. Either set a Relay URL or add a Claude API key in Settings.')
}

function buildTools(options?: AnalysisOptions): any[] {
  const tools: any[] = []
  if (options?.webSearch) {
    // 20260209 adds automatic dynamic filtering (Claude filters results before
    // they hit context) on Opus 4.8 / Sonnet 4.6 — better accuracy, fewer tokens.
    tools.push({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 5,
    })
  }
  if (options?.codeExecution) {
    tools.push({
      type: 'code_execution_20260120',
      name: 'code_execution',
    })
  }
  return tools
}

function extractText(content: any[]): string {
  return content
    .filter((b: any) => b.type === 'text' && b.text)
    .map((b: any) => b.text)
    .join('')
}

function logAiCall(entry: {
  kind: string
  label?: string | null
  model: string
  tokens_in?: number | null
  tokens_out?: number | null
  cache_read_tokens?: number | null
  cache_create_tokens?: number | null
  duration_ms: number
  status: 'ok' | 'error'
  error_msg?: string | null
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_activity_log (kind, label, model, tokens_in, tokens_out, cache_read_tokens, cache_create_tokens, duration_ms, status, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.kind,
        entry.label ?? null,
        entry.model,
        entry.tokens_in ?? null,
        entry.tokens_out ?? null,
        entry.cache_read_tokens ?? null,
        entry.cache_create_tokens ?? null,
        entry.duration_ms,
        entry.status,
        entry.error_msg ?? null,
      )
  } catch (err) {
    console.error('Failed to log AI activity:', err)
  }
}

function readUsage(usage: any): {
  tokens_in: number | null
  tokens_out: number | null
  cache_read: number | null
  cache_create: number | null
} {
  return {
    tokens_in: usage?.input_tokens ?? null,
    tokens_out: usage?.output_tokens ?? null,
    cache_read: usage?.cache_read_input_tokens ?? null,
    cache_create: usage?.cache_creation_input_tokens ?? null,
  }
}

interface AiErrorLike {
  error?: { message?: string }
  message?: string
}

const MAX_ANALYSIS_PAUSE_TURNS = 5

interface ChatConversationRow {
  conversation_id: string
  title: string
  last_message_at: string
  message_count: number
  pinned: number
}

export interface ChatMemoryRow {
  id: number
  content: string
  category: string
  pinned: number
  created_at: string
  updated_at: string
}

function getErrorMessage(err: unknown): string {
  const error = err as AiErrorLike
  return error.error?.message ?? error.message ?? String(err)
}

/**
 * Cheap one-shot Haiku call for utility jobs (sentiment scoring, light
 * classification). No tools, no thinking. Logs to ai_activity_log under
 * the supplied kind/label.
 */
export async function runHaiku(
  systemPrompt: string,
  userPrompt: string,
  label: string,
  kind: string = 'haiku-utility',
): Promise<string> {
  const client = getClient()
  const start = Date.now()
  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const usage = readUsage(response.usage)
    logAiCall({
      kind,
      label,
      model: HAIKU_MODEL,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      cache_read_tokens: usage.cache_read,
      cache_create_tokens: usage.cache_create,
      duration_ms: Date.now() - start,
      status: 'ok',
    })
    return extractText(response.content)
  } catch (err) {
    const msg = getErrorMessage(err)
    logAiCall({
      kind,
      label,
      model: HAIKU_MODEL,
      duration_ms: Date.now() - start,
      status: 'error',
      error_msg: msg,
    })
    throw err
  }
}

/**
 * Build the request payload for analysis calls. Shared between the
 * non-streaming and streaming variants so they stay in sync.
 */
function buildAnalysisParams(
  systemPrompt: string,
  userPrompt: string,
  options: AnalysisOptions | undefined,
  model: string,
): Parameters<ReturnType<typeof getClient>['messages']['create']>[0] {
  const tools = buildTools(options)
  const cacheSystem = options?.cacheSystem !== false

  // Wrap system in a content-block array so we can attach cache_control. The
  // API silently won't cache if the rendered prefix (tools + system) is below
  // the model's minimum (2048 tokens on Sonnet 4.6 / 4096 on Opus & Haiku) —
  // we still set the marker because it's free for misses.
  const systemBlocks = cacheSystem
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt

  const params: Parameters<ReturnType<typeof getClient>['messages']['create']>[0] & {
    output_config?: { effort: string }
  } = {
    model,
    max_tokens: options?.maxTokens || (options?.thinking ? 16000 : 4096),
    system: systemBlocks,
    messages: [{ role: 'user', content: userPrompt }],
  }

  if (tools.length > 0) params.tools = tools
  if (options?.thinking) {
    // Adaptive thinking on Sonnet 4.6 / Opus 4.8: the model decides when and
    // how much to think; `effort` shapes thinking depth + overall token spend.
    params.thinking = { type: 'adaptive' }
    params.output_config = { effort: options?.effort ?? 'high' }
  }
  return params
}

export async function generateAnalysis(
  systemPrompt: string,
  userPrompt: string,
  options?: AnalysisOptions,
  label?: string,
): Promise<string> {
  const client = getClient()
  const model = options?.model ?? getModel()
  const params = buildAnalysisParams(systemPrompt, userPrompt, options, model)

  const start = Date.now()
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  let cacheRead: number | null = null
  let cacheCreate: number | null = null
  try {
    for (let turn = 0; turn <= MAX_ANALYSIS_PAUSE_TURNS; turn++) {
      const response = await client.messages.create(params)
      const usage = readUsage(response.usage)
      if (usage.tokens_in != null) tokensIn = (tokensIn ?? 0) + usage.tokens_in
      if (usage.tokens_out != null) tokensOut = (tokensOut ?? 0) + usage.tokens_out
      if (usage.cache_read != null) cacheRead = (cacheRead ?? 0) + usage.cache_read
      if (usage.cache_create != null) cacheCreate = (cacheCreate ?? 0) + usage.cache_create

      if (response.stop_reason === 'pause_turn') {
        params.messages = [...params.messages, { role: 'assistant', content: response.content }]
        continue
      }

      logAiCall({
        kind: 'analysis',
        label: label ?? null,
        model,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cache_read_tokens: cacheRead,
        cache_create_tokens: cacheCreate,
        duration_ms: Date.now() - start,
        status: 'ok',
      })
      return extractText(response.content)
    }
    throw new Error('AI analysis paused too many times before returning a final response')
  } catch (err) {
    const msg = getErrorMessage(err)
    logAiCall({
      kind: 'analysis',
      label: label ?? null,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cache_read_tokens: cacheRead,
      cache_create_tokens: cacheCreate,
      duration_ms: Date.now() - start,
      status: 'error',
      error_msg: msg,
    })
    throw err
  }
}

/**
 * Streaming variant of `generateAnalysis`. Forwards text deltas to the
 * renderer over a dedicated IPC channel (`ai:analysis-stream-chunk` /
 * `ai:analysis-stream-end`) so skill/planner pages can render the response
 * progressively. Resolves with the full text once the stream completes.
 */
export async function generateAnalysisStreaming(
  systemPrompt: string,
  userPrompt: string,
  options?: AnalysisOptions,
  label?: string,
): Promise<string> {
  const client = getClient()
  const model = options?.model ?? getModel()
  const params = buildAnalysisParams(systemPrompt, userPrompt, options, model)

  const mainWindow = BrowserWindow.getAllWindows()[0]
  const start = Date.now()
  let fullText = ''
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  let cacheRead: number | null = null
  let cacheCreate: number | null = null
  let errorMsg: string | null = null

  try {
    for (let turn = 0; turn <= MAX_ANALYSIS_PAUSE_TURNS; turn++) {
      const stream = client.messages.stream(
        params as Parameters<ReturnType<typeof getClient>['messages']['stream']>[0],
      )

      stream.on('text', (delta: string) => {
        fullText += delta
        mainWindow?.webContents.send('ai:analysis-stream-chunk', delta)
      })

      const response = (await stream.finalMessage()) as unknown as FinalMessageLike
      const u = readUsage(response.usage)
      if (u.tokens_in != null) tokensIn = (tokensIn ?? 0) + u.tokens_in
      if (u.tokens_out != null) tokensOut = (tokensOut ?? 0) + u.tokens_out
      if (u.cache_read != null) cacheRead = (cacheRead ?? 0) + u.cache_read
      if (u.cache_create != null) cacheCreate = (cacheCreate ?? 0) + u.cache_create

      if (response.stop_reason === 'pause_turn') {
        params.messages = [...params.messages, { role: 'assistant', content: response.content }]
        continue
      }
      break
    }
    if (params.messages.length > MAX_ANALYSIS_PAUSE_TURNS + 1) {
      errorMsg = 'AI analysis paused too many times before returning a final response'
    }
  } catch (err) {
    errorMsg = getErrorMessage(err)
    console.error('Analysis streaming error:', errorMsg)
  }

  logAiCall({
    kind: 'analysis',
    label: label ?? null,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cache_read_tokens: cacheRead,
    cache_create_tokens: cacheCreate,
    duration_ms: Date.now() - start,
    status: errorMsg ? 'error' : 'ok',
    error_msg: errorMsg,
  })

  // Signal completion. If the stream errored mid-flight — even after some text
  // streamed — flag it so the renderer can toast rather than silently treating
  // a truncated answer as complete (project convention: no silent swallowing).
  mainWindow?.webContents.send('ai:analysis-stream-end', errorMsg ? { error: errorMsg } : undefined)

  // A mid-stream failure is a hard failure for callers (e.g. briefings) that
  // persist the result: never let truncated text masquerade as a full response.
  if (errorMsg) {
    throw new Error(errorMsg)
  }
  return fullText
}

// ---------------------------------------------------------------------------
// Agent turn: cancellation + tool execution
// ---------------------------------------------------------------------------

/** In-flight chat turns, keyed by conversation, so the renderer can cancel. */
const activeChatTurns = new Map<string, AbortController>()

/**
 * Abort the in-flight chat turn for a conversation (Stop button / Esc).
 * Returns true if a turn was actually running.
 */
export function cancelChat(conversationId: string = 'default'): boolean {
  const controller = activeChatTurns.get(conversationId)
  if (controller) {
    controller.abort()
    return true
  }
  return false
}

/** Reject with a timeout error if `p` doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// Bounds that keep a turn from ever hanging:
const MAX_TOOL_ROUNDS = 8 // model ⇄ tools round-trips before we force a final answer
const TOOL_TIMEOUT_MS = 25_000 // per individual tool call
const TURN_BUDGET_MS = 180_000 // hard wall-clock cap for the whole turn

const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name))

// Tools advertised each turn: our custom read-only data tools + server-side web search.
const CHAT_TOOLS = [
  ...AGENT_TOOLS,
  { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
]

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input?: Record<string, unknown>
}
interface FinalMessageLike {
  content: Array<{ type: string; name?: string; id?: string; input?: unknown; text?: string }>
  stop_reason: string | null
  usage?: unknown
}
type AgentMessage = { role: 'user' | 'assistant'; content: unknown }

function withVolatileContext(messages: AgentMessage[], volatileContext?: string): AgentMessage[] {
  const trimmed = volatileContext?.trim()
  if (!trimmed) return messages

  const contextualized = [...messages]
  for (let i = contextualized.length - 1; i >= 0; i--) {
    const message = contextualized[i]
    if (message.role !== 'user') continue

    if (typeof message.content === 'string') {
      contextualized[i] = {
        ...message,
        content: `${trimmed}\n\n${message.content}`,
      }
      return contextualized
    }

    if (Array.isArray(message.content)) {
      contextualized[i] = {
        ...message,
        content: [{ type: 'text', text: trimmed }, ...message.content],
      }
      return contextualized
    }
  }

  return [{ role: 'user', content: trimmed }, ...contextualized]
}

/**
 * Core agent loop shared by new chats and regeneration. Assumes the caller has
 * already persisted any new user message. Streams the assistant reply to the
 * renderer, lets the model call read-only data tools (live prices, sleep,
 * fitness, news, portfolio) across multiple rounds, persists the final text,
 * logs usage, and fires post-turn background jobs without blocking.
 *
 * The whole turn is abortable (cancelChat) and bounded by per-tool timeouts, a
 * max round count, and a wall-clock budget — it can never hang indefinitely.
 */
async function runChatStream(
  systemPrompt: string,
  conversationId: string,
  model: string,
  volatileContext?: string,
): Promise<string> {
  const db = getDb()

  const history = db
    .prepare(
      `
    SELECT id, role, content FROM chat_messages
    WHERE conversation_id = ? AND role != 'system'
    ORDER BY created_at DESC
    LIMIT 200
  `,
    )
    .all(conversationId) as Array<{ id: number; role: string; content: string }>

  // Look up attachments per user message so they ride along as image/document
  // content blocks. Text-only turns stay plain strings to preserve prompt caching.
  const attachStmt = db.prepare(
    `SELECT kind, media_type, data_base64 FROM chat_attachments WHERE message_id = ? ORDER BY id ASC`,
  )

  const baseMessages: ClaudeMessage[] = history.reverse().map((m) => {
    if (m.role === 'user') {
      const atts = attachStmt.all(m.id) as Array<{
        kind: string
        media_type: string
        data_base64: string
      }>
      if (atts.length) {
        const blocks: ClaudeContentBlock[] = atts.map((a) =>
          a.kind === 'image'
            ? {
                type: 'image',
                source: { type: 'base64', media_type: a.media_type, data: a.data_base64 },
              }
            : {
                type: 'document',
                source: { type: 'base64', media_type: a.media_type, data: a.data_base64 },
              },
        )
        if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content })
        return { role: 'user', content: blocks }
      }
    }
    return { role: m.role as 'user' | 'assistant', content: m.content }
  })

  // Working transcript the agent loop appends to (assistant tool_use turns +
  // our tool_result turns). Seeded from the persisted history.
  const messages: AgentMessage[] = withVolatileContext(baseMessages, volatileContext)

  let fullResponse = ''
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  let cacheRead: number | null = null
  let cacheCreate: number | null = null
  const mainWindow = BrowserWindow.getAllWindows()[0]
  const start = Date.now()
  let errorMsg: string | null = null
  let aborted = false
  let needsFinalAnswer = false
  let exhaustedReason: 'tool rounds' | 'time budget' | null = null
  let tokenLimitHit = false

  // One controller per turn. A watchdog guarantees the turn ends even if the
  // model keeps requesting tools or the network stalls.
  const controller = new AbortController()
  activeChatTurns.set(conversationId, controller)
  const watchdog = setTimeout(() => controller.abort(), TURN_BUDGET_MS)

  try {
    const client = getClient()

    // System wrapped in a content block so cache_control attaches to it.
    // Render order is tools → system → messages: caching the system block
    // also caches the (stable) tools list above it.
    const systemBlocks = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ]

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (controller.signal.aborted) {
        aborted = true
        break
      }

      // Top-level cache_control auto-places a breakpoint on the last cacheable
      // message block. As the conversation grows the cached prefix grows with it.
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 16000,
          system: systemBlocks,
          messages,
          cache_control: { type: 'ephemeral' },
          tools: CHAT_TOOLS,
        } as Parameters<ReturnType<typeof getClient>['messages']['stream']>[0],
        { signal: controller.signal },
      )

      stream.on('text', (delta: string) => {
        fullResponse += delta
        mainWindow?.webContents.send('ai:stream-chunk', delta)
      })

      let finalMsg: FinalMessageLike
      try {
        finalMsg = (await stream.finalMessage()) as unknown as FinalMessageLike
      } catch (err) {
        if (controller.signal.aborted) {
          aborted = true
          break
        }
        throw err
      }

      // Accumulate usage across rounds.
      const u = readUsage(finalMsg.usage)
      if (u.tokens_in != null) tokensIn = (tokensIn ?? 0) + u.tokens_in
      if (u.tokens_out != null) tokensOut = (tokensOut ?? 0) + u.tokens_out
      if (u.cache_read != null) cacheRead = (cacheRead ?? 0) + u.cache_read
      if (u.cache_create != null) cacheCreate = (cacheCreate ?? 0) + u.cache_create

      // Echo the assistant turn (text + tool_use blocks) back into the transcript.
      messages.push({ role: 'assistant', content: finalMsg.content })

      const stopReason = finalMsg.stop_reason

      if (stopReason === 'tool_use') {
        needsFinalAnswer = true
        const toolUses = finalMsg.content.filter(
          (b): b is ToolUseBlock => b.type === 'tool_use' && AGENT_TOOL_NAMES.has(b.name ?? ''),
        )
        // No custom tools to run (only server-side web_search, already resolved).
        if (toolUses.length === 0) {
          needsFinalAnswer = false
          break
        }

        const toolResults: Array<{
          type: 'tool_result'
          tool_use_id: string
          content: string
          is_error: boolean
        }> = []

        for (const tu of toolUses) {
          if (controller.signal.aborted) {
            aborted = true
            break
          }
          const label = TOOL_LABELS[tu.name] || `running ${tu.name}`
          mainWindow?.webContents.send('ai:chat-tool', { phase: 'start', name: tu.name, label })
          let result
          try {
            result = await withTimeout(
              executeAgentTool(tu.name, tu.input ?? {}),
              TOOL_TIMEOUT_MS,
              tu.name,
            )
          } catch (err) {
            result = {
              content: err instanceof Error ? err.message : `${tu.name} failed`,
              isError: true,
            }
          }
          mainWindow?.webContents.send('ai:chat-tool', { phase: 'end', name: tu.name, label })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: result.content,
            is_error: result.isError,
          })
        }

        if (aborted) break
        messages.push({ role: 'user', content: toolResults })
        if (Date.now() - start > TURN_BUDGET_MS) {
          exhaustedReason = 'time budget'
          break
        }
        if (round === MAX_TOOL_ROUNDS - 1) {
          exhaustedReason = 'tool rounds'
          break
        }
        continue
      }

      if (stopReason === 'pause_turn') {
        // Server-side tool (web search) needs another round to continue.
        needsFinalAnswer = true
        if (round === MAX_TOOL_ROUNDS - 1) {
          exhaustedReason = 'tool rounds'
          break
        }
        continue
      }

      if (stopReason === 'max_tokens') {
        tokenLimitHit = true
      }
      needsFinalAnswer = false
      // end_turn / max_tokens / stop_sequence — the answer is complete.
      break
    }

    if (!controller.signal.aborted && needsFinalAnswer) {
      const reasonText =
        exhaustedReason === 'time budget'
          ? 'I ran out of time for tool calls.'
          : 'I reached the tool-step limit.'
      messages.push({
        role: 'user',
        content: `${reasonText} Give the best final answer now using only the information already gathered. If anything remains uncertain, say what is missing.`,
      })

      const stream = client.messages.stream(
        {
          model,
          max_tokens: 16000,
          system: systemBlocks,
          messages,
          tools: CHAT_TOOLS,
          tool_choice: { type: 'none' },
        } as Parameters<ReturnType<typeof getClient>['messages']['stream']>[0],
        { signal: controller.signal },
      )

      stream.on('text', (delta: string) => {
        fullResponse += delta
        mainWindow?.webContents.send('ai:stream-chunk', delta)
      })

      const finalMsg = (await stream.finalMessage()) as unknown as FinalMessageLike
      const u = readUsage(finalMsg.usage)
      if (u.tokens_in != null) tokensIn = (tokensIn ?? 0) + u.tokens_in
      if (u.tokens_out != null) tokensOut = (tokensOut ?? 0) + u.tokens_out
      if (u.cache_read != null) cacheRead = (cacheRead ?? 0) + u.cache_read
      if (u.cache_create != null) cacheCreate = (cacheCreate ?? 0) + u.cache_create
      if (finalMsg.stop_reason === 'max_tokens') {
        tokenLimitHit = true
      }
    }
  } catch (err) {
    errorMsg = getErrorMessage(err) || 'Unknown error communicating with AI'
    console.error('AI streaming error:', err)
  } finally {
    clearTimeout(watchdog)
    // Only clear the slot if it's still OURS. If the user cancelled and fired a
    // new turn for the same conversation, that newer turn has already replaced
    // this entry — deleting by key alone would orphan the live turn so its Stop
    // button could no longer find a controller to abort.
    if (activeChatTurns.get(conversationId) === controller) {
      activeChatTurns.delete(conversationId)
    }
  }

  logAiCall({
    kind: 'chat',
    label: conversationId,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cache_read_tokens: cacheRead,
    cache_create_tokens: cacheCreate,
    duration_ms: Date.now() - start,
    status: errorMsg ? 'error' : 'ok',
    error_msg: errorMsg,
  })

  if (aborted && fullResponse) {
    fullResponse += '\n\n_(stopped)_'
  }

  if (tokenLimitHit && fullResponse) {
    fullResponse += '\n\n_(stopped because the answer hit the output token limit)_'
  }

  if (fullResponse) {
    db.prepare('INSERT INTO chat_messages (role, content, conversation_id) VALUES (?, ?, ?)').run(
      'assistant',
      fullResponse,
      conversationId,
    )
    ensureConversation(conversationId)
    touchConversation(conversationId)
    // Fire-and-forget background jobs — must never block the user-facing turn.
    void maybeGenerateTitle(conversationId)
    if (isAutoMemoryEnabled()) void extractMemoryFromConversation(conversationId)
  }

  mainWindow?.webContents.send('ai:stream-end')

  if (errorMsg && !fullResponse) {
    throw new Error(errorMsg)
  }

  return fullResponse
}

export async function chatWithStreaming(
  message: string,
  systemPrompt: string,
  conversationId: string = 'default',
  modelOverride?: string,
  attachments?: ChatAttachmentInput[],
  volatileContext?: string,
): Promise<string> {
  const db = getDb()
  const info = db
    .prepare('INSERT INTO chat_messages (role, content, conversation_id) VALUES (?, ?, ?)')
    .run('user', message, conversationId)
  if (attachments && attachments.length) {
    saveAttachments(Number(info.lastInsertRowid), conversationId, attachments)
  }
  ensureConversation(conversationId)
  return runChatStream(systemPrompt, conversationId, resolveChatModel(modelOverride), volatileContext)
}

/** Persist a user message's attachments, stripping any data-URL prefix. */
function saveAttachments(
  messageId: number,
  conversationId: string,
  attachments: ChatAttachmentInput[],
): void {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO chat_attachments (message_id, conversation_id, kind, media_type, name, data_base64)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const a of attachments) {
    const data = a.data_base64.replace(/^data:[^;]+;base64,/, '')
    stmt.run(messageId, conversationId, a.kind, a.media_type, a.name ?? null, data)
  }
}

/** All attachments for a conversation, so the renderer can map them by message_id. */
export function getConversationAttachments(conversationId: string): ChatAttachmentRow[] {
  return getDb()
    .prepare(
      `SELECT id, message_id, conversation_id, kind, media_type, name, data_base64
       FROM chat_attachments WHERE conversation_id = ? ORDER BY id ASC`,
    )
    .all(conversationId) as ChatAttachmentRow[]
}

/**
 * Re-run the last turn: drop the most recent assistant message (if any) and
 * stream a fresh reply from the same history. The trailing user message is
 * preserved so the model answers the same question again.
 */
export async function regenerateLastResponse(
  systemPrompt: string,
  conversationId: string = 'default',
  modelOverride?: string,
  volatileContext?: string,
): Promise<string> {
  const db = getDb()
  const last = db
    .prepare(
      `SELECT id, role FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(conversationId) as { id: number; role: string } | undefined
  if (last && last.role === 'assistant') {
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(last.id)
  }
  return runChatStream(systemPrompt, conversationId, resolveChatModel(modelOverride), volatileContext)
}

/**
 * Delete a message and everything after it in a conversation. Used by
 * edit-and-resend: the renderer trims from the edited user message, then
 * sends the revised text as a new turn.
 */
export function deleteMessagesFrom(conversationId: string, messageId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM chat_attachments WHERE conversation_id = ? AND message_id >= ?').run(
    conversationId,
    messageId,
  )
  db.prepare('DELETE FROM chat_messages WHERE conversation_id = ? AND id >= ?').run(
    conversationId,
    messageId,
  )
}

// ---------------------------------------------------------------------------
// Conversation metadata (title / pin / archive / delete)
// ---------------------------------------------------------------------------

export function ensureConversation(conversationId: string): void {
  getDb()
    .prepare(
      `INSERT INTO conversations (conversation_id) VALUES (?) ON CONFLICT(conversation_id) DO NOTHING`,
    )
    .run(conversationId)
}

function touchConversation(conversationId: string): void {
  getDb()
    .prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE conversation_id = ?`)
    .run(conversationId)
}

export function renameConversation(conversationId: string, title: string): void {
  ensureConversation(conversationId)
  getDb()
    .prepare(
      `UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
    )
    .run(title.trim().slice(0, 100), conversationId)
}

export function setConversationPinned(conversationId: string, pinned: boolean): void {
  ensureConversation(conversationId)
  getDb()
    .prepare(
      `UPDATE conversations SET pinned = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
    )
    .run(pinned ? 1 : 0, conversationId)
}

export function setConversationArchived(conversationId: string, archived: boolean): void {
  ensureConversation(conversationId)
  getDb()
    .prepare(
      `UPDATE conversations SET archived = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
    )
    .run(archived ? 1 : 0, conversationId)
}

export function deleteConversation(conversationId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM chat_attachments WHERE conversation_id = ?').run(conversationId)
  db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(conversationId)
  db.prepare('DELETE FROM conversations WHERE conversation_id = ?').run(conversationId)
}

// ---------------------------------------------------------------------------
// Durable cross-conversation memory
// ---------------------------------------------------------------------------

export function listMemories(): ChatMemoryRow[] {
  return getDb()
    .prepare(
      `SELECT id, content, category, pinned, created_at, updated_at FROM chat_memory
       ORDER BY pinned DESC, updated_at DESC`,
    )
    .all() as ChatMemoryRow[]
}

export function addMemory(content: string, category: string = 'general'): ChatMemoryRow {
  const db = getDb()
  const info = db
    .prepare('INSERT INTO chat_memory (content, category) VALUES (?, ?)')
    .run(content.trim(), category)
  return db
    .prepare(
      `SELECT id, content, category, pinned, created_at, updated_at FROM chat_memory WHERE id = ?`,
    )
    .get(info.lastInsertRowid) as ChatMemoryRow
}

export function updateMemory(id: number, content: string, category?: string): void {
  const db = getDb()
  if (category != null) {
    db.prepare(
      `UPDATE chat_memory SET content = ?, category = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(content.trim(), category, id)
  } else {
    db.prepare(
      `UPDATE chat_memory SET content = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(content.trim(), id)
  }
}

export function deleteMemory(id: number): void {
  getDb().prepare('DELETE FROM chat_memory WHERE id = ?').run(id)
}

export function clearMemories(): void {
  getDb().prepare('DELETE FROM chat_memory').run()
}

/** Formatted bullet list of memories for injection into the chat system prompt. */
export function buildMemoryBlock(): string {
  const memories = listMemories()
  if (memories.length === 0) return ''
  return memories.map((m) => `- ${m.content}`).join('\n')
}

const MEMORY_EXTRACTION_SYSTEM = `You maintain a long-term memory of durable facts about a single user, so a personal assistant can have better future conversations.

You are given the user's EXISTING MEMORIES and the latest exchange from a conversation. Decide what (if anything) should change.

Remember ONLY durable, user-specific facts worth recalling weeks later: stable preferences, goals, positions/holdings they say they own, recurring routines, personal context, constraints, and how they want the assistant to respond.

DO NOT remember: one-off questions, transient market/price numbers, anything already captured, general knowledge, or the assistant's own statements.

Respond with ONLY a JSON object (no prose, no code fences) in this exact shape:
{"add": ["new fact"], "update": [{"id": 12, "content": "revised fact"}], "delete": [3]}

- "add": brand-new facts, each a short self-contained sentence. Use [] if none.
- "update": corrections to existing memories, by id. Use [] if none.
- "delete": ids of memories now wrong or obsolete. Use [] if none.

If nothing should change, respond with {"add":[],"update":[],"delete":[]}.`

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
      add: Array.isArray(obj.add) ? obj.add.filter((x: unknown) => typeof x === 'string') : [],
      update: Array.isArray(obj.update)
        ? obj.update.filter(
            (x: { id?: unknown; content?: unknown }) =>
              x && typeof x.id === 'number' && typeof x.content === 'string',
          )
        : [],
      delete: Array.isArray(obj.delete)
        ? obj.delete.filter((x: unknown) => typeof x === 'number')
        : [],
    }
  } catch {
    return null
  }
}

/**
 * Background memory extraction. Reviews the recent exchange against existing
 * memories via a cheap Haiku call and applies add/update/delete ops. Best
 * effort — any failure is swallowed so it never affects the chat itself.
 */
export async function extractMemoryFromConversation(conversationId: string): Promise<void> {
  try {
    const db = getDb()
    const recent = db
      .prepare(
        `SELECT role, content FROM chat_messages WHERE conversation_id = ? AND role != 'system'
         ORDER BY created_at DESC LIMIT 6`,
      )
      .all(conversationId) as Array<{ role: string; content: string }>
    if (recent.length === 0) return

    const transcript = recent
      .reverse()
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`)
      .join('\n')

    const existing = listMemories()
    const existingBlock =
      existing.length > 0 ? existing.map((m) => `[${m.id}] ${m.content}`).join('\n') : '(none yet)'

    const raw = await runHaiku(
      MEMORY_EXTRACTION_SYSTEM,
      `EXISTING MEMORIES:\n${existingBlock}\n\nLATEST EXCHANGE:\n${transcript}`,
      conversationId,
      'memory-extract',
    )

    const ops = parseMemoryOps(raw)
    if (!ops) return

    const existingIds = new Set(existing.map((m) => m.id))
    for (const id of ops.delete) {
      if (existingIds.has(id)) deleteMemory(id)
    }
    for (const u of ops.update) {
      if (existingIds.has(u.id) && u.content.trim()) updateMemory(u.id, u.content)
    }
    const seen = new Set(existing.map((m) => m.content.toLowerCase().trim()))
    for (const add of ops.add) {
      const c = add.trim()
      if (c && !seen.has(c.toLowerCase())) {
        db.prepare(
          'INSERT INTO chat_memory (content, source_conversation_id) VALUES (?, ?)',
        ).run(c, conversationId)
        seen.add(c.toLowerCase())
      }
    }
  } catch (err) {
    console.error('[chat] memory extraction failed:', err)
  }
}

/**
 * Generate a short title for an untitled conversation once it has at least one
 * full exchange. Best effort; fire-and-forget.
 */
async function maybeGenerateTitle(conversationId: string): Promise<void> {
  try {
    const db = getDb()
    const conv = db
      .prepare('SELECT title FROM conversations WHERE conversation_id = ?')
      .get(conversationId) as { title: string | null } | undefined
    if (conv?.title) return

    const msgs = db
      .prepare(
        `SELECT role, content FROM chat_messages WHERE conversation_id = ? AND role != 'system'
         ORDER BY created_at ASC LIMIT 4`,
      )
      .all(conversationId) as Array<{ role: string; content: string }>
    const hasUser = msgs.some((m) => m.role === 'user')
    const hasAssistant = msgs.some((m) => m.role === 'assistant')
    if (!hasUser || !hasAssistant) return

    const transcript = msgs
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
      .join('\n')
    const raw = await runHaiku(
      'You generate ultra-short chat titles. Reply with ONLY the title: 2-6 words, Title Case, no surrounding quotes, no trailing punctuation.',
      `Title this conversation:\n\n${transcript}`,
      conversationId,
      'chat-title',
    )
    const clean = raw
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/[.]+$/, '')
      .slice(0, 60)
    if (clean) {
      ensureConversation(conversationId)
      db.prepare(
        `UPDATE conversations SET title = ? WHERE conversation_id = ? AND title IS NULL`,
      ).run(clean, conversationId)
    }
  } catch (err) {
    console.error('[chat] title generation failed:', err)
  }
}

export function getChatHistory(conversationId: string = 'default') {
  const db = getDb()
  return db
    .prepare(
      `
    SELECT * FROM chat_messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `,
    )
    .all(conversationId)
}

export function clearChatHistory(conversationId: string = 'default') {
  const db = getDb()
  db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(conversationId)
}

export function listConversations(): {
  conversation_id: string
  title: string
  last_message_at: string
  message_count: number
  pinned: number
}[] {
  const db = getDb()
  return db
    .prepare(
      `
    SELECT
      m.conversation_id AS conversation_id,
      COALESCE(c.title, MIN(CASE WHEN m.role = 'user' THEN m.content END)) AS title,
      MAX(m.created_at) AS last_message_at,
      COUNT(*) AS message_count,
      COALESCE(c.pinned, 0) AS pinned
    FROM chat_messages m
    LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
    WHERE COALESCE(c.archived, 0) = 0
    GROUP BY m.conversation_id
    ORDER BY COALESCE(c.pinned, 0) DESC, MAX(m.created_at) DESC
  `,
    )
    .all() as ChatConversationRow[]
}

/** Archived conversations only — shown under a separate sidebar section. */
export function listArchivedConversations(): ChatConversationRow[] {
  const db = getDb()
  return db
    .prepare(
      `
    SELECT
      m.conversation_id AS conversation_id,
      COALESCE(c.title, MIN(CASE WHEN m.role = 'user' THEN m.content END)) AS title,
      MAX(m.created_at) AS last_message_at,
      COUNT(*) AS message_count,
      COALESCE(c.pinned, 0) AS pinned
    FROM chat_messages m
    JOIN conversations c ON c.conversation_id = m.conversation_id
    WHERE c.archived = 1
    GROUP BY m.conversation_id
    ORDER BY MAX(m.created_at) DESC
  `,
    )
    .all() as ChatConversationRow[]
}

/** Build a short snippet centered on the first match of `query` in `content`. */
function buildSnippet(content: string, query: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const idx = flat.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return flat.slice(0, 120)
  const start = Math.max(0, idx - 50)
  const end = Math.min(flat.length, idx + query.length + 70)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Full-text search across message content (LIKE — fine at personal scale). */
export function searchMessages(query: string): ChatSearchResult[] {
  const q = query.trim()
  if (!q) return []
  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
           COALESCE(c.title, '') AS title
    FROM chat_messages m
    LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
    WHERE m.role != 'system' AND m.content LIKE '%' || ? || '%'
    ORDER BY m.created_at DESC
    LIMIT 50
  `,
    )
    .all(q) as Array<{
    id: number
    conversation_id: string
    role: string
    content: string
    created_at: string
    title: string
  }>
  return rows.map((r) => ({
    id: r.id,
    conversation_id: r.conversation_id,
    title: r.title || 'Untitled',
    role: r.role,
    snippet: buildSnippet(r.content, q),
    created_at: r.created_at,
  }))
}

/** Render a conversation to Markdown for export. */
export function exportConversation(conversationId: string): { title: string; markdown: string } {
  const db = getDb()
  const meta = db
    .prepare('SELECT title FROM conversations WHERE conversation_id = ?')
    .get(conversationId) as { title?: string } | undefined
  const msgs = db
    .prepare(
      `SELECT role, content, created_at FROM chat_messages
       WHERE conversation_id = ? AND role != 'system' ORDER BY created_at ASC`,
    )
    .all(conversationId) as Array<{ role: string; content: string; created_at: string }>
  const title = meta?.title || 'Chat'
  const lines: string[] = [`# ${title}`, '']
  for (const m of msgs) {
    const who = m.role === 'user' ? 'You' : 'Mien'
    lines.push(`### ${who} · ${m.created_at}`, '', m.content, '')
  }
  return { title, markdown: lines.join('\n') }
}

export async function checkAIConnection(): Promise<{ ok: boolean; mode: string; error?: string }> {
  const settings = getAppSettings()
  const relayUrl = settings?.relayUrl

  // Relay mode (preferred)
  if (relayUrl) {
    try {
      const headers: Record<string, string> = {}
      if (settings?.relayToken) {
        headers['Authorization'] = `Bearer ${settings.relayToken}`
      }
      const res = await fetch(`${relayUrl.replace(/\/$/, '')}/health`, { headers })
      if (res.ok) {
        try {
          const client = getClient()
          await client.messages.create({
            model: getModel(),
            max_tokens: 8,
            messages: [{ role: 'user', content: 'Reply OK.' }],
          })
          return { ok: true, mode: 'relay' }
        } catch (err: any) {
          return {
            ok: false,
            mode: 'relay',
            error: `Relay is reachable, but AI auth failed: ${getErrorMessage(err)}`,
          }
        }
      }
      return { ok: false, mode: 'relay', error: `Relay returned ${res.status}` }
    } catch (err: any) {
      return { ok: false, mode: 'relay', error: err.message }
    }
  }

  return { ok: false, mode: 'none', error: 'No API key or relay configured' }
}
