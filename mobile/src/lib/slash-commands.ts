/**
 * Slash commands for the mobile Chat screen.
 *
 * Unlike desktop (which calls dedicated skill IPC handlers), mobile has no
 * server-side skills. Each command here expands into a templated user prompt
 * that runs through the normal streaming chat — portfolio + health context is
 * already injected into the system prompt by buildContextString(), so the model
 * answers with the user's real data.
 *
 * `/help` is handled locally (no Claude call); everything else returns a prompt
 * string via buildPrompt(args) that gets sent like any other message.
 */

export interface SlashCommand {
  name: string
  args: string
  description: string
  /** Build the prompt to send to Claude. `/help` returns '' (handled locally). */
  buildPrompt: (args: string) => string
}

function requireSymbol(args: string, command: string): string {
  const sym = args.trim().split(/\s+/)[0]
  if (!sym) throw new Error(`${command} needs a symbol — e.g. ${command} AAPL`)
  return sym.toUpperCase()
}

export const COMMANDS: SlashCommand[] = [
  {
    name: '/help',
    args: '',
    description: 'List every command available in chat',
    buildPrompt: () => '',
  },
  {
    name: '/earnings',
    args: '<symbol>',
    description: 'Earnings review — latest beat/miss, guidance, key metrics',
    buildPrompt: (args) => {
      const sym = requireSymbol(args, '/earnings')
      return `Give me an earnings review for ${sym}: most recent quarter's revenue and EPS vs estimates (beat/miss), forward guidance, key segment trends, and the one-line takeaway for an investor. Use web search for the latest figures if needed.`
    },
  },
  {
    name: '/valuation',
    args: '<symbol>',
    description: 'Valuation analysis — multiples, growth, margins',
    buildPrompt: (args) => {
      const sym = requireSymbol(args, '/valuation')
      return `Analyze the valuation of ${sym}: current P/E, P/S and other relevant multiples vs history and peers, revenue/earnings growth, margins, and whether it looks cheap, fair, or expensive. Use web search for current numbers if needed.`
    },
  },
  {
    name: '/technicals',
    args: '<symbol>',
    description: 'Technical analysis — support/resistance, momentum, trend',
    buildPrompt: (args) => {
      const sym = requireSymbol(args, '/technicals')
      return `Give me a technical analysis of ${sym}: current trend, key support and resistance levels, momentum (RSI/MACD), moving averages, and notable chart patterns. Use web search for the latest price action if needed.`
    },
  },
  {
    name: '/market',
    args: '',
    description: 'Market research — regime, sector rotation, watchlist takes',
    buildPrompt: () =>
      `Give me a concise market research briefing: current market regime, what sectors are leading/lagging, key macro catalysts this week, and quick takes on the symbols in my watchlist. Use web search for current data.`,
  },
  {
    name: '/risk',
    args: '',
    description: 'Portfolio risk — concentration, correlation, tail risk',
    buildPrompt: () =>
      `Assess the risk in my portfolio/watchlist: concentration, correlation between holdings, sector exposure, and the main tail risks I should be aware of. Be specific and actionable.`,
  },
  {
    name: '/sleep',
    args: '',
    description: 'Summarize my recent sleep and recovery',
    buildPrompt: () =>
      `Summarize my recent sleep and recovery using my health data: sleep duration and quality trend, HRV and resting heart rate signals, and one or two concrete recommendations for tonight.`,
  },
  {
    name: '/health',
    args: '',
    description: 'Weekly health check-in across sleep, HRV, activity',
    buildPrompt: () =>
      `Give me a weekly health check-in using my data: how my sleep, HRV, resting heart rate, and activity have trended, what stands out, and what to focus on this week.`,
  },
]

export function isSlashCommand(input: string): boolean {
  return /^\s*\//.test(input)
}

export function parseSlash(input: string): {
  command: SlashCommand | null
  raw: string
  args: string
} {
  const trimmed = input.trim()
  const match = trimmed.match(/^(\/\S+)\s*(.*)$/)
  if (!match) return { command: null, raw: trimmed, args: '' }
  const name = match[1].toLowerCase()
  const args = match[2] || ''
  const command = COMMANDS.find((c) => c.name === name) || null
  return { command, raw: trimmed, args }
}

/** Markdown text for the `/help` command, rendered locally as an assistant message. */
export function helpText(): string {
  const lines = COMMANDS.map(
    (c) => `- **${c.name}${c.args ? ' ' + c.args : ''}** — ${c.description}`,
  )
  return `**Commands**\n\n${lines.join('\n')}\n\nAnything that doesn't start with \`/\` is a normal message.`
}
