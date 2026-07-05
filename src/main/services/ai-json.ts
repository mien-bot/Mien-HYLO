export interface ParseAiJsonOptions {
  expectArray?: boolean
  dayKeys?: readonly string[]
}

export interface ParseAiJsonResult<T = unknown> {
  value: T
  json: string
  rationale: string | null
  recoveredFromTruncation: boolean
}

function stripTrailingCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, '$1')
}

function findBalancedJson(text: string, opener: '{' | '['): { json: string; start: number; end: number } | null {
  const closer = opener === '{' ? '}' : ']'
  const start = text.indexOf(opener)
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === opener) depth++
    if (ch === closer) {
      depth--
      if (depth === 0) return { json: text.slice(start, i + 1), start, end: i + 1 }
    }
  }

  return null
}

function matchesOptions(value: unknown, options: ParseAiJsonOptions): boolean {
  if (options.expectArray && !Array.isArray(value)) return false
  if (options.dayKeys?.length) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return options.dayKeys.some((day) => Array.isArray(record[day]))
  }
  return true
}

function tryParse<T>(
  candidate: string,
  source: string,
  start: number,
  end: number,
  options: ParseAiJsonOptions,
  recoveredFromTruncation = false,
): ParseAiJsonResult<T> | null {
  const json = stripTrailingCommas(candidate.trim())
  try {
    const value = JSON.parse(json) as T
    if (!matchesOptions(value, options)) return null
    const rationale = (source.slice(0, start) + source.slice(end)).trim() || null
    return { value, json, rationale, recoveredFromTruncation }
  } catch {
    return null
  }
}

function recoverTruncatedPlan<T>(
  response: string,
  options: ParseAiJsonOptions,
): ParseAiJsonResult<T> | null {
  if (!options.dayKeys?.length || !options.dayKeys.some((day) => response.includes(`"${day}"`))) {
    return null
  }

  const start = response.indexOf('{')
  if (start === -1) return null

  const candidate = response.slice(start)
  const costPattern = /"cost"\s*:\s*"[^"]*"\s*\}/g
  let lastMatch: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = costPattern.exec(candidate)) !== null) {
    lastMatch = match
  }
  if (!lastMatch) return null

  const truncated = candidate.slice(0, lastMatch.index + lastMatch[0].length)
  for (const suffix of [']}', '], "agendaMap": {}}', ']}}']) {
    const recovered = tryParse<T>(
      truncated + suffix,
      response,
      start,
      response.length,
      options,
      true,
    )
    if (recovered) return recovered
  }
  return null
}

export function parseAiJson<T = unknown>(
  response: string,
  options: ParseAiJsonOptions = {},
): ParseAiJsonResult<T> {
  const fenceMatches = response.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)
  for (const match of fenceMatches) {
    const candidate = match[1]
    const parsed = tryParse<T>(
      candidate,
      response,
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
      options,
    )
    if (parsed) return parsed
  }

  const opener = options.expectArray ? '[' : '{'
  const balanced = findBalancedJson(response, opener)
  if (balanced) {
    const parsed = tryParse<T>(balanced.json, response, balanced.start, balanced.end, options)
    if (parsed) return parsed
  }

  const raw = tryParse<T>(response, response, 0, response.length, options)
  if (raw) return raw

  const recovered = recoverTruncatedPlan<T>(response, options)
  if (recovered) return recovered

  throw new Error('Failed to parse JSON from AI response')
}
