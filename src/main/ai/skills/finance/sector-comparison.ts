/**
 * Sector & Benchmark Comparison Skill
 *
 * Compares portfolio performance against market benchmarks (SPY, QQQ)
 * and analyzes sector allocation.
 */

export const SECTOR_COMPARISON_SYSTEM = `You are a portfolio strategist comparing a personal investor's holdings against market benchmarks.

## Your Task
Analyze how the portfolio is performing relative to the broader market and identify opportunities.

## Comparison Framework

### 1. Portfolio vs Benchmark
- How is the portfolio performing vs SPY/QQQ over the analyzed period?
- Is the portfolio outperforming or underperforming? By how much?
- Alpha generation: is the investor adding value vs a simple index fund?

### 2. Best & Worst Performers
- Which holdings are driving returns (positive attribution)?
- Which are dragging (negative attribution)?
- Would the portfolio be better off replacing laggards with index exposure?

### 3. Relative Strength Analysis
- Which holdings are showing momentum vs the market?
- Which are weakening relative to the market?
- Any stocks transitioning from strength to weakness (or vice versa)?

### 4. Missing Exposures
- What major sectors/themes is the portfolio missing?
- Is the portfolio too concentrated in one sector?
- Specific ETFs or stocks that would improve balance

### 5. Rebalancing Recommendations
- Top 3 actions to improve risk-adjusted returns
- Which positions to add to vs trim
- Any "dead money" that should be replaced

## Rules
- Compare actual numbers — the data is pre-computed
- Be direct about underperformance: "You'd have been better off in SPY" when true
- Suggest specific tickers and ETFs, not vague asset classes
- Keep total output under 700 words
- Format as clean markdown`

export interface SectorComparisonContext {
  portfolio: {
    holdings: Array<{
      symbol: string
      type: string
      price: number
      weight: number
      returnPeriod: number // % return over analysis period
    }>
    totalReturn: number // weighted portfolio return %
  }
  benchmarks: Array<{
    symbol: string
    name: string
    price: number
    returnPeriod: number // % return same period
  }>
  relativeStrength: Array<{
    symbol: string
    rsVsMarket: number // relative strength vs SPY (>1 = outperforming)
  }>
}

export function buildSectorComparisonPrompt(ctx: SectorComparisonContext): string {
  let prompt = '## Portfolio vs Market Comparison\n\n'

  // Portfolio overview
  prompt += `**Portfolio Return (period):** ${ctx.portfolio.totalReturn > 0 ? '+' : ''}${ctx.portfolio.totalReturn.toFixed(2)}%\n\n`

  // Benchmark comparison
  prompt += '### Benchmarks\n'
  for (const b of ctx.benchmarks) {
    const alpha = ctx.portfolio.totalReturn - b.returnPeriod
    prompt += `- **${b.symbol}** (${b.name}): ${b.returnPeriod > 0 ? '+' : ''}${b.returnPeriod.toFixed(2)}% → `
    prompt += `Portfolio ${alpha > 0 ? 'outperforming' : 'underperforming'} by ${Math.abs(alpha).toFixed(2)}%\n`
  }

  // Holdings performance
  prompt += '\n### Holdings Performance\n'
  const sorted = [...ctx.portfolio.holdings].sort((a, b) => b.returnPeriod - a.returnPeriod)
  prompt += '| Symbol | Type | Weight | Return | vs SPY |\n'
  prompt += '|--------|------|--------|--------|--------|\n'
  const spyReturn = ctx.benchmarks.find((b) => b.symbol === 'SPY')?.returnPeriod || 0
  for (const h of sorted) {
    const alpha = h.returnPeriod - spyReturn
    prompt += `| ${h.symbol} | ${h.type} | ${h.weight.toFixed(1)}% | ${h.returnPeriod > 0 ? '+' : ''}${h.returnPeriod.toFixed(2)}% | ${alpha > 0 ? '+' : ''}${alpha.toFixed(2)}% |\n`
  }

  // Relative strength
  if (ctx.relativeStrength.length > 0) {
    prompt += '\n### Relative Strength vs Market\n'
    for (const rs of ctx.relativeStrength) {
      const label = rs.rsVsMarket > 1.1 ? 'STRONG' : rs.rsVsMarket > 0.95 ? 'neutral' : 'WEAK'
      prompt += `- **${rs.symbol}:** RS=${rs.rsVsMarket.toFixed(2)} (${label})\n`
    }
  }

  prompt += '\n---\nProvide your comparison analysis and rebalancing recommendations.'

  return prompt
}
