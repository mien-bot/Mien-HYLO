/**
 * Technical Analysis Skill
 *
 * Computes RSI, moving averages, MACD, Bollinger Bands, and volume trends
 * from stored OHLCV data, then sends to Claude for interpretation.
 */

export const TECHNICAL_ANALYSIS_SYSTEM = `You are a technical analysis expert providing actionable chart analysis for a personal investor.

## Your Task
Interpret the computed technical indicators and price data to provide a clear trading perspective.

## Analysis Framework

### 1. Trend Assessment
- Primary trend (bullish/bearish/sideways) based on moving averages and price structure
- Trend strength: is it accelerating, decelerating, or consolidating?
- Key trend change signals if present

### 2. Momentum Indicators
- RSI interpretation: overbought (>70), oversold (<30), or neutral, with divergence checks
- MACD signal: bullish/bearish crossover, histogram trend, zero-line position
- Rate of change: is momentum building or fading?

### 3. Support & Resistance
- From the provided levels: nearest support and resistance zones
- Key breakout/breakdown levels to watch
- Volume profile: are high-volume days confirming or diverging from price moves?

### 4. Volatility Context
- Bollinger Band width: is volatility expanding or contracting?
- Position within the bands: near upper (potential reversal/breakout), near lower (potential bounce/breakdown)
- Average True Range context: is the stock moving more or less than usual?

### 5. Trade Setup
- Clear bias: bullish, bearish, or neutral
- Entry zone (if bullish/bearish)
- Stop-loss level based on technical levels
- Target(s) based on resistance/support and measured moves
- Risk/reward ratio
- Timeframe: is this a short-term trade or position trade?

## Rules
- Use the actual computed numbers — they are pre-calculated for accuracy
- Never say "I can't see the chart" — you have all the indicator values
- Be direct: "Buy near $X with stop at $Y targeting $Z" is better than hedging
- Flag when technicals conflict (e.g., bullish RSI but bearish MACD)
- Keep total output under 700 words
- Format as clean markdown`

export interface TechnicalContext {
  symbol: string
  assetType: string
  currentPrice: number
  indicators: {
    rsi14: number | null
    sma20: number | null
    sma50: number | null
    ema12: number | null
    ema26: number | null
    macdLine: number | null
    macdSignal: number | null
    macdHistogram: number | null
    bollingerUpper: number | null
    bollingerMiddle: number | null
    bollingerLower: number | null
    atr14: number | null
    avgVolume20: number | null
    latestVolume: number | null
    volumeRatio: number | null
    priceChange5d: number | null
    priceChange20d: number | null
    high52w: number | null
    low52w: number | null
  }
  supportResistance: {
    supports: number[]
    resistances: number[]
  }
  priceHistory: Array<{
    date: string
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>
}

export function buildTechnicalAnalysisPrompt(ctx: TechnicalContext): string {
  const { indicators: ind } = ctx
  let prompt = `## Technical Analysis: ${ctx.symbol} (${ctx.assetType})\n\n`
  prompt += `**Current Price:** $${ctx.currentPrice.toFixed(2)}\n\n`

  prompt += '### Computed Indicators\n'
  if (ind.rsi14 != null)
    prompt += `- **RSI (14):** ${ind.rsi14.toFixed(1)} ${ind.rsi14 > 70 ? '⚠️ OVERBOUGHT' : ind.rsi14 < 30 ? '⚠️ OVERSOLD' : ''}\n`
  if (ind.sma20 != null)
    prompt += `- **SMA 20:** $${ind.sma20.toFixed(2)} (price ${ctx.currentPrice > ind.sma20 ? 'above' : 'below'})\n`
  if (ind.sma50 != null)
    prompt += `- **SMA 50:** $${ind.sma50.toFixed(2)} (price ${ctx.currentPrice > ind.sma50 ? 'above' : 'below'})\n`
  if (ind.sma20 != null && ind.sma50 != null) {
    prompt += `- **MA Cross:** ${ind.sma20 > ind.sma50 ? 'Golden cross (bullish)' : 'Death cross (bearish)'}\n`
  }
  if (ind.macdLine != null && ind.macdSignal != null) {
    prompt += `- **MACD:** Line=${ind.macdLine.toFixed(3)}, Signal=${ind.macdSignal.toFixed(3)}, Histogram=${ind.macdHistogram?.toFixed(3)}\n`
    prompt += `  - MACD ${ind.macdLine > ind.macdSignal ? 'above' : 'below'} signal line (${ind.macdLine > ind.macdSignal ? 'bullish' : 'bearish'})\n`
  }
  if (ind.bollingerUpper != null && ind.bollingerLower != null) {
    const bbWidth =
      ((ind.bollingerUpper - ind.bollingerLower) / (ind.bollingerMiddle || ctx.currentPrice)) * 100
    prompt += `- **Bollinger Bands:** Upper=$${ind.bollingerUpper.toFixed(2)}, Mid=$${ind.bollingerMiddle?.toFixed(2)}, Lower=$${ind.bollingerLower.toFixed(2)}\n`
    prompt += `  - Band width: ${bbWidth.toFixed(1)}% (${bbWidth < 5 ? 'tight — breakout likely' : bbWidth > 15 ? 'wide — high volatility' : 'normal'})\n`
    const bbPosition =
      (ctx.currentPrice - ind.bollingerLower) / (ind.bollingerUpper - ind.bollingerLower)
    prompt += `  - Price position: ${(bbPosition * 100).toFixed(0)}% (0%=lower band, 100%=upper band)\n`
  }
  if (ind.atr14 != null) {
    prompt += `- **ATR (14):** $${ind.atr14.toFixed(2)} (${((ind.atr14 / ctx.currentPrice) * 100).toFixed(1)}% of price)\n`
  }
  if (ind.avgVolume20 != null && ind.latestVolume != null) {
    prompt += `- **Volume:** ${formatBigNumber(ind.latestVolume)} (${ind.volumeRatio != null ? ind.volumeRatio.toFixed(1) + 'x' : '?'} avg)\n`
  }
  if (ind.priceChange5d != null)
    prompt += `- **5-day change:** ${ind.priceChange5d > 0 ? '+' : ''}${ind.priceChange5d.toFixed(2)}%\n`
  if (ind.priceChange20d != null)
    prompt += `- **20-day change:** ${ind.priceChange20d > 0 ? '+' : ''}${ind.priceChange20d.toFixed(2)}%\n`
  if (ind.high52w != null && ind.low52w != null) {
    const rangePos = ((ctx.currentPrice - ind.low52w) / (ind.high52w - ind.low52w)) * 100
    prompt += `- **52-week range:** $${ind.low52w.toFixed(2)} — $${ind.high52w.toFixed(2)} (currently at ${rangePos.toFixed(0)}%)\n`
  }

  if (ctx.supportResistance.supports.length > 0 || ctx.supportResistance.resistances.length > 0) {
    prompt += '\n### Support & Resistance Levels\n'
    if (ctx.supportResistance.supports.length > 0) {
      prompt += `- **Support:** ${ctx.supportResistance.supports.map((s) => `$${s.toFixed(2)}`).join(', ')}\n`
    }
    if (ctx.supportResistance.resistances.length > 0) {
      prompt += `- **Resistance:** ${ctx.supportResistance.resistances.map((r) => `$${r.toFixed(2)}`).join(', ')}\n`
    }
  }

  if (ctx.priceHistory.length > 0) {
    prompt += '\n### Recent OHLCV (last 10 days)\n'
    for (const p of ctx.priceHistory.slice(-10)) {
      prompt += `- ${p.date}: O=$${p.open.toFixed(2)} H=$${p.high.toFixed(2)} L=$${p.low.toFixed(2)} C=$${p.close.toFixed(2)} V=${formatBigNumber(p.volume)}\n`
    }
  }

  prompt += '\n---\nProvide your technical analysis and trade setup based on the indicators above.'

  return prompt
}

function formatBigNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(0)
}
