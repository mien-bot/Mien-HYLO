/**
 * Risk Assessment Skill
 *
 * Portfolio-level risk analysis: volatility, drawdowns, concentration,
 * correlation risks, and stress scenarios.
 */

export const RISK_ASSESSMENT_SYSTEM = `You are a risk management analyst assessing portfolio risk for a personal investor.

## Your Task
Analyze the provided portfolio risk metrics and deliver a clear risk assessment with actionable recommendations.

## Risk Framework

### 1. Portfolio-Level Risk
- Overall volatility assessment: is the portfolio running hot or cold vs historical norms?
- Concentration risk: is too much weight in one stock, sector, or asset class?
- Correlation risk: which holdings move together? A portfolio of 10 correlated stocks = 1 stock

### 2. Individual Stock Risk Flags
- Which holdings have the highest volatility (ATR, std dev)?
- Which have the largest drawdowns from recent highs?
- Any stocks showing abnormal volume (potential event risk)?

### 3. Downside Scenarios
- What happens to the portfolio if markets drop 10%, 20%?
- Which holdings have the most downside risk based on technical levels?
- Are there any tail risk exposures (earnings, Fed meetings, sector-specific)?

### 4. Diversification Score
- Asset class mix (stocks vs crypto vs ETFs)
- Sector exposure (tech-heavy? cyclical?)
- Geography (all US? international exposure?)
- Suggestions for better diversification

### 5. Risk-Adjusted Actions
- Top 3 specific risk reduction actions (trim, hedge, rebalance)
- Which positions offer the best risk/reward going forward?
- Position sizing recommendations for each holding

## Rules
- Use the actual computed risk metrics — they are pre-calculated for accuracy
- Be specific: "Trim AAPL from 25% to 15%" not "consider reducing concentration"
- Quantify risk in dollar terms when possible
- Don't sugarcoat — if the portfolio is poorly diversified, say so
- Keep total output under 800 words
- Format as clean markdown`

export interface RiskContext {
  totalValue: number
  holdings: Array<{
    symbol: string
    type: string
    price: number
    weight: number // % of portfolio
    volatility: number // annualized std dev %
    maxDrawdown: number // % from recent high
    beta: number | null // vs market
    sharpeApprox: number | null // rough Sharpe
  }>
  portfolioMetrics: {
    totalVolatility: number
    avgCorrelation: number
    herfindahlIndex: number // concentration metric
    assetMix: { stocks: number; crypto: number; etfs: number }
    maxDrawdown: number
  }
  correlationPairs: Array<{
    symbolA: string
    symbolB: string
    correlation: number
  }>
}

export function buildRiskAssessmentPrompt(ctx: RiskContext): string {
  let prompt = `## Portfolio Risk Assessment\n\n`
  prompt += `**Total Portfolio Value:** $${ctx.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n\n`

  // Portfolio-level metrics
  prompt += '### Portfolio Metrics\n'
  prompt += `- **Annualized Volatility:** ${ctx.portfolioMetrics.totalVolatility.toFixed(1)}%\n`
  prompt += `- **Max Drawdown (30d):** ${ctx.portfolioMetrics.maxDrawdown.toFixed(1)}%\n`
  prompt += `- **Avg Correlation:** ${ctx.portfolioMetrics.avgCorrelation.toFixed(2)}\n`
  prompt += `- **Concentration (HHI):** ${(ctx.portfolioMetrics.herfindahlIndex * 100).toFixed(0)}% `
  if (ctx.portfolioMetrics.herfindahlIndex > 0.25) prompt += '⚠️ HIGH CONCENTRATION'
  else if (ctx.portfolioMetrics.herfindahlIndex > 0.15) prompt += '(moderate)'
  else prompt += '(well diversified)'
  prompt += '\n'

  const mix = ctx.portfolioMetrics.assetMix
  prompt += `- **Asset Mix:** Stocks ${mix.stocks.toFixed(0)}% / Crypto ${mix.crypto.toFixed(0)}% / ETFs ${mix.etfs.toFixed(0)}%\n`

  // Individual holdings
  prompt += '\n### Holdings Risk Profile\n'
  prompt += '| Symbol | Type | Weight | Volatility | Max DD | Beta |\n'
  prompt += '|--------|------|--------|-----------|--------|------|\n'
  for (const h of ctx.holdings.sort((a, b) => b.weight - a.weight)) {
    prompt += `| ${h.symbol} | ${h.type} | ${h.weight.toFixed(1)}% | ${h.volatility.toFixed(1)}% | ${h.maxDrawdown.toFixed(1)}% | ${h.beta != null ? h.beta.toFixed(2) : 'N/A'} |\n`
  }

  // Correlation pairs
  if (ctx.correlationPairs.length > 0) {
    prompt += '\n### Notable Correlations\n'
    const highCorr = ctx.correlationPairs.filter((c) => Math.abs(c.correlation) > 0.5)
    if (highCorr.length > 0) {
      for (const c of highCorr.slice(0, 10)) {
        const label =
          c.correlation > 0.7
            ? '⚠️ HIGH'
            : c.correlation > 0.5
              ? 'moderate'
              : c.correlation < -0.5
                ? 'inverse'
                : ''
        prompt += `- ${c.symbolA} ↔ ${c.symbolB}: ${c.correlation.toFixed(2)} ${label}\n`
      }
    } else {
      prompt += '- No highly correlated pairs found (good diversification)\n'
    }
  }

  prompt += '\n---\nProvide your risk assessment and specific recommendations.'

  return prompt
}
