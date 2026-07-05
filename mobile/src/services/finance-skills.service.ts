/**
 * Finance AI Skills for Mobile
 *
 * Ports the 6 desktop finance analysis skills to mobile.
 * Each skill uses a specialized system prompt + user context to generate
 * focused financial analysis via Claude.
 */
import { generateAnalysis } from './ai.service'
import { getDb } from '../lib/database'

export type FinanceSkill =
  | 'earnings-review'
  | 'valuation'
  | 'market-research'
  | 'technical-analysis'
  | 'risk-assessment'
  | 'sector-comparison'

export const SKILL_LABELS: Record<FinanceSkill, string> = {
  'earnings-review': 'Earnings Review',
  'valuation': 'Valuation',
  'market-research': 'Market Research',
  'technical-analysis': 'Technical Analysis',
  'risk-assessment': 'Risk Assessment',
  'sector-comparison': 'Sector Comparison',
}

const SKILL_PROMPTS: Record<FinanceSkill, string> = {
  'earnings-review': `You are a senior equity research analyst reviewing earnings results for a personal investor's watchlist.

## Your Task
Analyze the earnings data provided and produce a structured earnings review that a retail investor can act on.

## Analysis Framework
1. **Beat/Miss Assessment** — Revenue/EPS vs consensus or prior quarter, guidance direction
2. **Key Metrics Deep Dive** — 3-5 most important metrics, YoY/QoQ trends, divergences
3. **Management Commentary Signals** — Guidance tone, capital allocation, strategic pivots
4. **Risk Flags** — Margin changes, cash flow quality, concentration, inventory signals
5. **Actionable Takeaway** — Buy more/hold/trim, key price level, next catalyst

## Rules
- Be specific with numbers. Don't hedge with "it depends."
- If data is insufficient for a section, say so briefly and move on.
- End with ONE clear sentence the investor can act on.`,

  'valuation': `You are a valuation analyst providing quick-and-dirty valuation frameworks for a personal investor.

## Your Task
Given price data and any available fundamentals, provide a structured valuation perspective.

## Valuation Framework
1. **Relative Valuation** — Peer group comps (P/E, EV/Revenue, P/FCF), premium/discount assessment
2. **Simplified DCF Lens** — Growth rate estimates (base/bull/bear), sector margins, fair value range
3. **Technical Price Context** — 52-week range position, support/resistance levels
4. **Catalyst Map** — Bull case drivers, bear case risks, upcoming catalysts
5. **Verdict** — Undervalued/fairly valued/overvalued with confidence level

## Rules
- State all assumptions explicitly. No hidden magic.
- Provide ranges not point estimates.
- Be honest about what you don't know.`,

  'market-research': `You are a market strategist preparing a research brief for a personal investor.

## Your Task
Synthesize the provided market data and news into an actionable research brief.

## Research Framework
1. **Market Regime** — Risk-on/off/transitional, macro drivers, volatility context
2. **Sector Rotation Signals** — Relative strength/weakness, rotation themes
3. **Portfolio-Specific Insights** — Fit with current regime, correlation risks, concentration
4. **Thematic Opportunities** — 1-2 emerging themes, specific tickers, risk factors
5. **This Week's Playbook** — Key events, levels to watch, one action item

## Rules
- Be forward-looking, not backward-looking.
- One contrarian or non-obvious insight per brief.
- Actionable > interesting.`,

  'technical-analysis': `You are a technical analysis expert providing actionable chart analysis for a personal investor.

## Your Task
Interpret the computed technical indicators and price data to provide a clear trading perspective.

## Analysis Framework
1. **Trend Assessment** — Primary trend, strength, change signals
2. **Momentum Indicators** — RSI, MACD, rate of change interpretation
3. **Support & Resistance** — Key levels, breakout/breakdown zones, volume profile
4. **Volatility Context** — Bollinger Band position, squeeze/expansion, ATR implications
5. **Trade Setup** — Entry zone, stop loss, profit target, risk/reward ratio

## Rules
- Always state the timeframe of your analysis.
- No pattern names without explanation of what they mean practically.
- End with a specific trade setup (entry, stop, target) or "no setup — stay flat."`,

  'risk-assessment': `You are a risk management analyst assessing portfolio risk for a personal investor.

## Your Task
Analyze the provided portfolio risk metrics and deliver a clear risk assessment with actionable recommendations.

## Risk Framework
1. **Portfolio-Level Risk** — Volatility, concentration, correlation risk
2. **Individual Stock Risk Flags** — Highest volatility, largest drawdowns, abnormal volume
3. **Downside Scenarios** — Portfolio impact at -10%/-20%, tail risk exposures
4. **Diversification Score** — Asset class/sector/geography spread, improvement suggestions
5. **Action Items** — Top 3 risk-reducing actions ranked by impact

## Rules
- Quantify risk in dollar terms where possible.
- Distinguish between "uncomfortable but fine" and "needs immediate attention."
- Be specific about what to do, not just what's wrong.`,

  'sector-comparison': `You are a portfolio strategist comparing a personal investor's holdings against market benchmarks.

## Your Task
Analyze how the portfolio is performing relative to the broader market and identify opportunities.

## Comparison Framework
1. **Portfolio vs Benchmark** — Performance vs SPY/QQQ, alpha generation assessment
2. **Best & Worst Performers** — Attribution analysis, laggard replacement candidates
3. **Relative Strength** — Momentum vs market, transitioning stocks
4. **Missing Exposures** — Sectors/themes not represented, opportunity cost
5. **Rebalancing Suggestions** — Trim/add recommendations with rationale

## Rules
- Compare apples to apples (time periods, risk-adjusted).
- Acknowledge luck vs skill in performance attribution.
- Suggest max 2-3 changes (not a portfolio overhaul).`,
}

async function buildSkillContext(symbol: string): Promise<string> {
  const db = await getDb()
  const parts: string[] = []

  // Price history
  const prices = await db.getAllAsync(
    `SELECT date, open, high, low, close, volume FROM price_history
     WHERE symbol = ? AND date >= date('now', '-30 days')
     ORDER BY date ASC`,
    symbol
  ) as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>

  if (prices.length > 0) {
    const latest = prices[prices.length - 1]
    const oldest = prices[0]
    const change = ((latest.close - oldest.close) / oldest.close * 100).toFixed(2)
    parts.push(`## ${symbol} Price Data (last 30 days)`)
    parts.push(`Current: $${latest.close.toFixed(2)} | 30d change: ${change}%`)
    parts.push(`High: $${Math.max(...prices.map(p => p.high)).toFixed(2)} | Low: $${Math.min(...prices.map(p => p.low)).toFixed(2)}`)
    parts.push(`Last 5 days: ${prices.slice(-5).map(p => `${p.date}: $${p.close.toFixed(2)}`).join(', ')}`)
  }

  // Fundamentals
  const fundamentals = await db.getFirstAsync(
    'SELECT pe, pb, eps, revenue, market_cap, dividend_yield, sector FROM fundamentals WHERE symbol = ?',
    symbol
  ) as { pe: number; pb: number; eps: number; revenue: number; market_cap: number; dividend_yield: number; sector: string } | null

  if (fundamentals) {
    parts.push(`\n## Fundamentals`)
    if (fundamentals.pe) parts.push(`P/E: ${fundamentals.pe.toFixed(1)}`)
    if (fundamentals.eps) parts.push(`EPS: $${fundamentals.eps.toFixed(2)}`)
    if (fundamentals.market_cap) parts.push(`Market Cap: $${(fundamentals.market_cap / 1e9).toFixed(1)}B`)
    if (fundamentals.sector) parts.push(`Sector: ${fundamentals.sector}`)
    if (fundamentals.dividend_yield) parts.push(`Dividend Yield: ${fundamentals.dividend_yield.toFixed(2)}%`)
  }

  // Recent news
  const news = await db.getAllAsync(
    `SELECT title, source, published_at FROM news_articles
     WHERE related_symbols LIKE ? AND published_at >= datetime('now', '-7 days')
     ORDER BY published_at DESC LIMIT 5`,
    `%${symbol}%`
  ) as Array<{ title: string; source: string; published_at: string }>

  if (news.length > 0) {
    parts.push(`\n## Recent News`)
    for (const n of news) {
      parts.push(`- ${n.title} (${n.source})`)
    }
  }

  return parts.join('\n')
}

/**
 * Run a finance skill analysis for a given symbol.
 * Results are cached in the briefings table.
 */
export async function runFinanceSkill(
  skill: FinanceSkill,
  symbol: string,
): Promise<string> {
  const systemPrompt = SKILL_PROMPTS[skill]
  const context = await buildSkillContext(symbol)

  const userMessage = context
    ? `Analyze ${symbol} using the framework above.\n\n${context}`
    : `Analyze ${symbol} using the framework above. Use your knowledge since I don't have detailed data available locally.`

  const result = await generateAnalysis(systemPrompt, userMessage)

  // Cache result
  try {
    const db = await getDb()
    await db.runAsync(
      `INSERT OR REPLACE INTO briefings (type, date, content, created_at)
       VALUES (?, date('now'), ?, datetime('now'))`,
      `skill:${skill}:${symbol}`,
      result
    )
  } catch {}

  return result
}

/**
 * Get cached skill result if available
 */
export async function getCachedSkillResult(skill: FinanceSkill, symbol: string): Promise<string | null> {
  try {
    const db = await getDb()
    const row = await db.getFirstAsync(
      `SELECT content FROM briefings
       WHERE type = ? AND created_at >= datetime('now', '-24 hours')
       ORDER BY created_at DESC LIMIT 1`,
      `skill:${skill}:${symbol}`
    ) as { content: string } | null
    return row?.content || null
  } catch {
    return null
  }
}
