/**
 * Earnings Review Skill
 *
 * Analyzes earnings reports and transcripts for watchlist stocks.
 * Modeled after Anthropic's financial-services-plugins pattern.
 */

export const EARNINGS_REVIEW_SYSTEM = `You are a senior equity research analyst reviewing earnings results for a personal investor's watchlist.

## Your Task
Analyze the earnings data provided and produce a structured earnings review that a retail investor can act on.

## Analysis Framework

### 1. Beat/Miss Assessment
- Revenue vs consensus (if available) or vs prior quarter
- EPS vs expectations
- Guidance: raised, maintained, or lowered

### 2. Key Metrics Deep Dive
- Identify the 3-5 metrics that matter most for this company's business model
- Compare YoY and QoQ trends
- Flag any metric that diverged significantly from the trend

### 3. Management Commentary Signals
- Forward guidance tone (optimistic, cautious, hedging)
- Capital allocation changes (buybacks, dividends, capex shifts)
- Any strategic pivots or new initiatives mentioned

### 4. Risk Flags
- Margin compression or expansion and why
- Cash flow vs earnings divergence (earnings quality)
- Customer concentration or churn signals
- Inventory buildup or channel stuffing indicators

### 5. Actionable Takeaway
- One clear sentence: is this report a reason to buy more, hold, or trim?
- Price level to watch (support/resistance based on reaction)
- Timeline for next catalyst

## Rules
- Use actual numbers from the data. Never fabricate figures.
- Compare to prior periods when data is available.
- Be direct about uncertainty — if data is insufficient, say so.
- Keep the total analysis under 800 words.
- Format as clean markdown.`

export interface EarningsContext {
  symbol: string
  companyName?: string
  currentPrice?: number
  recentPrices?: Array<{ date: string; close: number }>
  news?: Array<{ title: string; source?: string; published_at?: string }>
  watchlistType?: string
  fundamentals?: {
    pe?: number | null
    eps?: number | null
    revenue?: number | null
    market_cap?: number | null
    dividend_yield?: number | null
    sector?: string | null
  }
  nextEarningsDate?: string | null
  epsEstimate?: number | null
}

export function buildEarningsReviewPrompt(ctx: EarningsContext): string {
  let prompt = `## Earnings Review Request: ${ctx.symbol}`
  if (ctx.companyName) prompt += ` (${ctx.companyName})`
  prompt += '\n\n'

  if (ctx.currentPrice != null) {
    prompt += `**Current Price:** $${ctx.currentPrice.toFixed(2)}\n`
  }

  if (ctx.fundamentals) {
    const f = ctx.fundamentals
    const parts: string[] = []
    if (f.pe != null) parts.push(`P/E ${f.pe.toFixed(1)}`)
    if (f.eps != null) parts.push(`EPS $${f.eps.toFixed(2)}`)
    if (f.market_cap != null) parts.push(`Market cap $${(f.market_cap / 1e9).toFixed(1)}B`)
    if (f.dividend_yield != null && f.dividend_yield > 0)
      parts.push(`Yield ${(f.dividend_yield * 100).toFixed(2)}%`)
    if (f.sector) parts.push(`Sector: ${f.sector}`)
    if (parts.length > 0) prompt += `**Fundamentals:** ${parts.join(' · ')}\n`
  }

  if (ctx.nextEarningsDate) {
    prompt += `**Next earnings:** ${ctx.nextEarningsDate}`
    if (ctx.epsEstimate != null) prompt += ` (EPS est. $${ctx.epsEstimate.toFixed(2)})`
    prompt += '\n'
  }

  if (ctx.recentPrices && ctx.recentPrices.length > 0) {
    prompt += '\n### Recent Price Action\n'
    for (const p of ctx.recentPrices) {
      prompt += `- ${p.date}: $${p.close.toFixed(2)}\n`
    }
  }

  if (ctx.news && ctx.news.length > 0) {
    prompt += '\n### Recent News & Earnings Headlines\n'
    for (const article of ctx.news.slice(0, 10)) {
      prompt += `- ${article.title}`
      if (article.source) prompt += ` (${article.source})`
      prompt += '\n'
    }
  }

  prompt += '\n---\nPlease provide your earnings review analysis based on the data above.'
  prompt += ' If no explicit earnings numbers are available in the news, analyze the price action'
  prompt += ' and news sentiment to infer market reaction to recent results.'

  return prompt
}
