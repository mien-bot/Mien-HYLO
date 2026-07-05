/**
 * Slash command registry for the Chat page. Each command runs an existing
 * skill / briefing / data lookup and returns a markdown result that gets
 * appended to the conversation as an assistant message.
 *
 * Commands bypass Claude streaming — they call the matching IPC directly.
 * For skill commands the IPC itself talks to Claude (and gets logged in
 * ai_activity_log), so cost still shows up in the AI Activity panel.
 */

export interface SlashCommand {
  name: string
  args: string
  description: string
  examples?: string[]
  run: (rawArgs: string) => Promise<string>
}

async function runFinanceSkill(skill: string, symbol?: string): Promise<string> {
  const result = await window.api.runFinanceSkill(skill, symbol)
  if (typeof result === 'string') return result
  if (result && typeof result.content === 'string') return result.content
  return JSON.stringify(result, null, 2)
}

async function runBriefing(type: string): Promise<string> {
  const result = await window.api.generateBriefing(type)
  return typeof result === 'string' ? result : JSON.stringify(result)
}

function requireSymbol(args: string, command: string): string {
  const sym = args.trim().split(/\s+/)[0]
  if (!sym) throw new Error(`${command} needs a symbol — try \`${command} AAPL\``)
  return sym.toUpperCase()
}

export const COMMANDS: SlashCommand[] = [
  {
    name: '/help',
    args: '',
    description: 'List every command available in chat',
    run: async () => {
      const lines = COMMANDS.map(
        (c) => `- **${c.name}${c.args ? ' ' + c.args : ''}** — ${c.description}`,
      )
      return `Available commands:\n\n${lines.join('\n')}\n\nTip: anything that doesn't start with \`/\` is a normal chat message.`
    },
  },
  {
    name: '/earnings',
    args: '<symbol>',
    description: 'Earnings review for a stock (latest beat/miss, guidance, key metrics)',
    examples: ['/earnings AAPL', '/earnings NVDA'],
    run: async (args) => runFinanceSkill('earnings-review', requireSymbol(args, '/earnings')),
  },
  {
    name: '/valuation',
    args: '<symbol>',
    description: 'Valuation analysis (DCF, comps, margins, growth)',
    examples: ['/valuation TSLA'],
    run: async (args) => runFinanceSkill('valuation', requireSymbol(args, '/valuation')),
  },
  {
    name: '/technicals',
    args: '<symbol>',
    description: 'Technical analysis (support/resistance, momentum, patterns)',
    examples: ['/technicals SPY'],
    run: async (args) => runFinanceSkill('technical-analysis', requireSymbol(args, '/technicals')),
  },
  {
    name: '/market',
    args: '',
    description: 'Market research — regime, sector rotation, watchlist takes',
    run: async () => runFinanceSkill('market-research'),
  },
  {
    name: '/risk',
    args: '',
    description: 'Portfolio risk assessment — concentration, correlation, tail risk',
    run: async () => runFinanceSkill('risk-assessment'),
  },
  {
    name: '/sector',
    args: '',
    description: 'Sector comparison — leadership, rotation signals',
    run: async () => runFinanceSkill('sector-comparison'),
  },
  {
    name: '/earnings-week',
    args: '',
    description:
      'Run an earnings-review skill for every watchlist symbol reporting in the next 7 days',
    run: async () => {
      const upcoming = (await window.api.getEarningsCalendar(7)) as Array<{
        symbol: string
        report_date: string
        eps_estimate: number | null
      }>
      if (!upcoming || upcoming.length === 0) {
        return 'No watchlist symbols report earnings in the next 7 days.\n\nTip: run **Fetch** on the Upcoming Earnings card to refresh the calendar.'
      }
      const sections: string[] = [
        `# Earnings This Week\n\nRunning earnings review for ${upcoming.length} symbol${upcoming.length === 1 ? '' : 's'}.\n`,
      ]
      for (const e of upcoming) {
        sections.push(
          `---\n\n## ${e.symbol} — ${e.report_date}${e.eps_estimate != null ? ` (est. EPS $${e.eps_estimate.toFixed(2)})` : ''}\n`,
        )
        try {
          const result = await runFinanceSkill('earnings-review', e.symbol)
          sections.push(result)
        } catch (err: any) {
          sections.push(`_Failed: ${err?.message || 'unknown error'}_`)
        }
      }
      return sections.join('\n')
    },
  },
  {
    name: '/finance',
    args: '',
    description: 'Generate the morning finance briefing',
    run: async () => runBriefing('morning_finance'),
  },
  {
    name: '/research',
    args: '',
    description: 'Generate the deep market research briefing (uses extended thinking)',
    run: async () => runBriefing('market_research'),
  },
  {
    name: '/health',
    args: '',
    description: 'Generate the weekly health briefing',
    run: async () => runBriefing('health_weekly'),
  },
  {
    name: '/sleep',
    args: '',
    description: 'Generate the morning sleep summary',
    run: async () => runBriefing('morning_sleep'),
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
