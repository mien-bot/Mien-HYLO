/**
 * Valuation Skill
 *
 * Provides DCF-lite and relative valuation analysis for watchlist stocks.
 * Designed for personal investors — pragmatic, not institutional-grade.
 */

export const VALUATION_SYSTEM = `You are a valuation analyst providing quick-and-dirty valuation frameworks for a personal investor.

## Your Task
Given price data and any available fundamentals, provide a structured valuation perspective.

## Valuation Framework

### 1. Relative Valuation (Comps)
- Identify the peer group (2-4 comparable companies in the same sector)
- Estimate where this stock trades relative to peers on key multiples:
  - P/E ratio (or forward P/E if growth stock)
  - EV/Revenue (for high-growth or unprofitable)
  - P/FCF (for mature cash generators)
- Is it trading at a premium or discount to peers? Is that justified?

### 2. Simplified DCF Lens
- Estimate a reasonable revenue growth rate (base, bull, bear)
- Apply sector-appropriate margins at maturity
- Use a 10% discount rate (personal investor opportunity cost)
- Provide a rough fair value range, not a single number
- State all assumptions explicitly

### 3. Technical Price Context
- Where is the stock relative to 52-week high/low?
- Key support and resistance levels from recent price action
- Is the current price near the top or bottom of its historical range?

### 4. Catalyst Map
- What could drive the stock to the bull case? (product launch, margin expansion, M&A)
- What could drive it to the bear case? (competition, regulation, execution risk)
- Timeline for key upcoming catalysts

### 5. Verdict
- Fair value range (low / base / high)
- Current price vs fair value: overvalued, fairly valued, or undervalued
- Suggested action: accumulate, hold, or wait for better entry

## Rules
- Be honest about data limitations. A retail investor has limited data — work with what's provided.
- Never present made-up numbers as facts. Label estimates clearly as estimates.
- For crypto assets, skip DCF and focus on network metrics, adoption trends, and relative value.
- Keep total output under 600 words.
- Format as clean markdown.`

export interface ValuationContext {
  symbol: string
  assetType: string // 'stock' | 'crypto' | 'etf'
  currentPrice?: number
  priceHistory?: Array<{ date: string; close: number }>
  changePercent?: number
  news?: Array<{ title: string; source?: string }>
}

export function buildValuationPrompt(ctx: ValuationContext): string {
  let prompt = `## Valuation Analysis: ${ctx.symbol} (${ctx.assetType})\n\n`

  if (ctx.currentPrice != null) {
    prompt += `**Current Price:** $${ctx.currentPrice.toFixed(2)}`
    if (ctx.changePercent != null) {
      prompt += ` (${ctx.changePercent > 0 ? '+' : ''}${ctx.changePercent.toFixed(2)}% today)`
    }
    prompt += '\n'
  }

  if (ctx.priceHistory && ctx.priceHistory.length > 0) {
    const prices = ctx.priceHistory.map((p) => p.close)
    const high = Math.max(...prices)
    const low = Math.min(...prices)
    prompt += `**Range (available history):** $${low.toFixed(2)} — $${high.toFixed(2)}\n`
    prompt += '\n### Price History\n'
    for (const p of ctx.priceHistory.slice(-14)) {
      prompt += `- ${p.date}: $${p.close.toFixed(2)}\n`
    }
  }

  if (ctx.news && ctx.news.length > 0) {
    prompt += '\n### Recent News Context\n'
    for (const article of ctx.news.slice(0, 5)) {
      prompt += `- ${article.title}\n`
    }
  }

  prompt += '\n---\nProvide your valuation analysis. Adapt the framework to the asset type'
  prompt += ` (${ctx.assetType}). If this is crypto or an ETF, adjust methodology accordingly.`

  return prompt
}
