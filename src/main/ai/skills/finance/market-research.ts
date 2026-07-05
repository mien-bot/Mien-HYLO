/**
 * Market Research Skill
 *
 * Generates sector/thematic research briefs for the morning briefing
 * and on-demand deep dives.
 */

export const MARKET_RESEARCH_SYSTEM = `You are a market strategist preparing a research brief for a personal investor.

## Your Task
Synthesize the provided market data and news into an actionable research brief.

## Research Framework

### 1. Market Regime
- Current market environment: risk-on, risk-off, or transitional
- Key macro drivers right now (rates, earnings season, geopolitics, liquidity)
- VIX/volatility context if inferrable from price action

### 2. Sector Rotation Signals
- Which sectors are showing relative strength vs the broad market?
- Which are lagging?
- Any rotation themes (growth→value, large→small, US→international)

### 3. Portfolio-Specific Insights
- For each asset in the watchlist: how does it fit the current regime?
- Correlation risks: are multiple holdings exposed to the same factor?
- Any concentration concerns

### 4. Thematic Opportunities
- 1-2 emerging themes visible in the news/data
- How the investor could get exposure (specific tickers if possible)
- Risk factors for each theme

### 5. This Week's Playbook
- Key events to watch (earnings, Fed, economic data)
- Levels to watch on major holdings
- One specific action item for the week

## Rules
- Reference actual data points (prices, changes, news headlines).
- Don't hedge everything — take a stance, but flag your confidence level.
- Prioritize what's actionable over what's interesting.
- Keep total output under 700 words.
- Format as clean markdown with clear headers.`

export interface MarketResearchContext {
  watchlist: Array<{
    symbol: string
    type: string
    price?: number
    change?: number
    changePercent?: number
  }>
  priceHistory?: Array<{ symbol: string; date: string; close: number }>
  news?: Array<{ title: string; source?: string; related_symbols?: string }>
}

export function buildMarketResearchPrompt(ctx: MarketResearchContext): string {
  let prompt = '## Portfolio & Market Data\n\n'

  prompt += '### Current Holdings\n'
  for (const item of ctx.watchlist) {
    if (item.price != null) {
      const change =
        item.changePercent != null
          ? ` (${item.changePercent > 0 ? '+' : ''}${item.changePercent.toFixed(2)}%)`
          : ''
      prompt += `- **${item.symbol}** [${item.type}]: $${item.price.toFixed(2)}${change}\n`
    } else {
      prompt += `- **${item.symbol}** [${item.type}]: awaiting data\n`
    }
  }

  if (ctx.priceHistory && ctx.priceHistory.length > 0) {
    prompt += '\n### 7-Day Price Trends\n'
    const bySymbol = new Map<string, Array<{ date: string; close: number }>>()
    for (const ph of ctx.priceHistory) {
      if (!bySymbol.has(ph.symbol)) bySymbol.set(ph.symbol, [])
      bySymbol.get(ph.symbol)!.push(ph)
    }
    for (const [symbol, history] of bySymbol) {
      const sorted = history.sort((a, b) => a.date.localeCompare(b.date))
      const first = sorted[0].close
      const last = sorted[sorted.length - 1].close
      const weekChange = (((last - first) / first) * 100).toFixed(2)
      prompt += `- **${symbol}**: $${first.toFixed(2)} → $${last.toFixed(2)} (${Number(weekChange) > 0 ? '+' : ''}${weekChange}% over ${sorted.length} days)\n`
    }
  }

  if (ctx.news && ctx.news.length > 0) {
    prompt += '\n### Market News Feed\n'
    for (const article of ctx.news.slice(0, 15)) {
      const symbols = article.related_symbols ? ` [${article.related_symbols}]` : ''
      prompt += `- ${article.title}${symbols}\n`
    }
  }

  prompt += '\n---\nProvide your market research brief based on the portfolio and data above.'

  return prompt
}
