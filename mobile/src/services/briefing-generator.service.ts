/**
 * Briefing generation for mobile.
 *
 * Mirrors the desktop briefing-generator. Builds context from local SQLite
 * (watchlist + prices + news for finance; sleep + HR + HRV for health),
 * calls Claude via the existing AI service, and UPSERTs the result into
 * the briefings table keyed by (type, date) so re-runs replace rather
 * than stack.
 */
import { generateAnalysis } from './ai.service'
import { runFullAnalysis } from './sleep-analysis.service'
import { getDb } from '../lib/database'

export type BriefingType = 'morning_finance' | 'health_weekly' | 'morning_sleep'

export const BRIEFING_LABELS: Record<BriefingType, string> = {
  morning_finance: 'Finance Briefing',
  health_weekly: 'Health Briefing',
  morning_sleep: 'Sleep Report',
}

const FINANCE_SYSTEM = `You are a personal financial analyst for a single investor. Use the watchlist, recent prices, and news provided to give:
1. Market Summary — key movers and patterns from the data.
2. Stock Picks & Analysis — short outlook per asset with reasoning.
3. Risk Alerts — concerning patterns or news.
4. Actionable Suggestions — buy/sell/hold with reasoning and price levels.

Be direct, specific, and cite real numbers from the data. Format as markdown.`

const HEALTH_SYSTEM = `You are a personal health analyst with access to sleep stages, HR, HRV, and steps data plus a computed sleep analysis (Two-Process Model). Provide:
1. Sleep Debt Status — interpret rolling debt, how to pay it down.
2. Sleep Stage Analysis — deep + REM percentages.
3. Circadian Rhythm & Timing — melatonin window, optimal bed/wake.
4. Quality Breakdown — deep, REM, efficiency, consistency.
5. Recovery Status — HRV-based readiness.
6. Morning Routine — first 90 min after waking.
7. Evening Wind-Down — what to do in the melatonin window.

Cite actual data points. Format as clean markdown.`

const SLEEP_SYSTEM = `You are a personal sleep coach delivering a concise morning sleep report. Lead with a one-sentence verdict (Great / Average / Rough). Then cover briefly:
1. Last Night Summary — score, duration, stage breakdown.
2. Sleep Debt Update — current debt and recovery pace.
3. Recovery Status — HRV-based readiness.
4. Today's Energy Forecast — morning peak, afternoon dip, evening peak with times.
5. Quick Wins — caffeine cutoff, tonight's bedtime, one improvement.

Keep it under 300 words. Use real numbers and times. Skip sections without data.`

async function buildFinanceContext(): Promise<string> {
  const db = await getDb()

  const watchlist = (await db.getAllAsync(
    `SELECT symbol, type, name FROM watchlist ORDER BY added_at DESC LIMIT 20`,
  )) as Array<{ symbol: string; type: string; name: string | null }>

  const latestPrices = (await db.getAllAsync(
    `SELECT symbol, close, date FROM price_history
     WHERE date = (SELECT MAX(date) FROM price_history p2 WHERE p2.symbol = price_history.symbol)`,
  )) as Array<{ symbol: string; close: number; date: string }>
  const priceMap = new Map(latestPrices.map((p) => [p.symbol, p]))

  const history = (await db.getAllAsync(
    `SELECT symbol, date, close FROM price_history
     WHERE date >= date('now', '-7 days') AND close IS NOT NULL
     ORDER BY symbol, date`,
  )) as Array<{ symbol: string; date: string; close: number }>

  const news = (await db.getAllAsync(
    `SELECT title, source, published_at, related_symbols FROM news_articles
     WHERE fetched_at >= datetime('now', '-1 day')
     ORDER BY published_at DESC LIMIT 20`,
  )) as Array<{ title: string; source: string | null; published_at: string | null; related_symbols: string | null }>

  let prompt = '## Current Watchlist\n\n'
  for (const w of watchlist) {
    const p = priceMap.get(w.symbol)
    prompt += p
      ? `- **${w.symbol}** (${w.type}): $${p.close.toFixed(2)} as of ${p.date}\n`
      : `- **${w.symbol}** (${w.type}): no price data\n`
  }

  if (history.length > 0) {
    prompt += '\n## Recent Price History (last 7 days)\n\n'
    const bySymbol = new Map<string, Array<{ date: string; close: number }>>()
    for (const h of history) {
      if (!bySymbol.has(h.symbol)) bySymbol.set(h.symbol, [])
      bySymbol.get(h.symbol)!.push(h)
    }
    for (const [symbol, rows] of bySymbol) {
      const prices = rows.map((r) => `${r.date}: $${r.close.toFixed(2)}`).join(', ')
      prompt += `- **${symbol}**: ${prices}\n`
    }
  }

  if (news.length > 0) {
    prompt += '\n## Recent News\n\n'
    for (const n of news) {
      const tags = n.related_symbols ? ` [${n.related_symbols}]` : ''
      prompt += `- ${n.title}${tags}\n`
    }
  }

  return prompt + '\n---\nProvide your analysis based on the data above.'
}

async function buildHealthContext(): Promise<string> {
  const db = await getDb()

  const sleep = (await db.getAllAsync(
    `SELECT date, value_json FROM health_metrics
     WHERE metric_type = 'sleep' ORDER BY date DESC LIMIT 7`,
  )) as Array<{ date: string; value_json: string }>

  const hr = (await db.getAllAsync(
    `SELECT date, value_json FROM health_metrics
     WHERE metric_type = 'heart_rate' ORDER BY date DESC LIMIT 7`,
  )) as Array<{ date: string; value_json: string }>

  const hrv = (await db.getAllAsync(
    `SELECT date, value_json FROM health_metrics
     WHERE metric_type = 'hrv' ORDER BY date DESC LIMIT 7`,
  )) as Array<{ date: string; value_json: string }>

  const steps = (await db.getAllAsync(
    `SELECT date, value_json FROM health_metrics
     WHERE metric_type = 'steps' ORDER BY date DESC LIMIT 7`,
  )) as Array<{ date: string; value_json: string }>

  let analysisBlock = ''
  try {
    const a = await runFullAnalysis()
    if (a) {
      const lines: string[] = ['## Sleep Analysis (computed)', '']
      lines.push(`- Sleep debt: ${a.debt.currentDebt.toFixed(1)}h (${a.debt.debtCategory})`)
      lines.push(`- Sleep need estimate: ${a.debt.sleepNeedEstimate.toFixed(1)}h/night`)
      lines.push(`- Optimal bedtime: ${a.circadian.optimalBedtime} · wake: ${a.circadian.optimalWakeTime}`)
      lines.push(`- Melatonin window: ${a.circadian.melatoninWindowStart}–${a.circadian.melatoninWindowEnd}`)
      if (a.quality) {
        lines.push(
          `- Quality scores — deep ${a.quality.deepSleepScore}, REM ${a.quality.remScore}, ` +
            `efficiency ${a.quality.efficiencyScore}, consistency ${a.quality.consistencyScore}`,
        )
      }
      if (a.hrvRecovery) {
        lines.push(
          `- HRV recovery: ${a.hrvRecovery.score} (${a.hrvRecovery.status}, z=${a.hrvRecovery.zScore.toFixed(2)})`,
        )
      }
      const lastNight = a.debt.last14Nights[0]
      if (lastNight) {
        lines.push(
          `- Last night: slept ${lastNight.slept.toFixed(1)}h vs need ${lastNight.need.toFixed(1)}h (delta ${lastNight.delta >= 0 ? '+' : ''}${lastNight.delta.toFixed(1)}h)`,
        )
      }
      analysisBlock = lines.join('\n') + '\n\n'
    }
  } catch {}

  let prompt = analysisBlock
  if (sleep.length > 0) {
    prompt += '## Sleep Data (recent 7 days)\n\n'
    for (const s of sleep) prompt += `- ${s.date}: ${s.value_json}\n`
  }
  if (hr.length > 0) {
    prompt += '\n## Heart Rate\n\n'
    for (const h of hr) prompt += `- ${h.date}: ${h.value_json}\n`
  }
  if (hrv.length > 0) {
    prompt += '\n## HRV\n\n'
    for (const h of hrv) prompt += `- ${h.date}: ${h.value_json}\n`
  }
  if (steps.length > 0) {
    prompt += '\n## Steps\n\n'
    for (const s of steps) prompt += `- ${s.date}: ${s.value_json}\n`
  }

  if (!prompt) {
    return 'No health data available yet. Provide general health optimization advice.'
  }
  return prompt + '\n---\nProvide your analysis based on the data above.'
}

export async function generateBriefing(type: BriefingType): Promise<string> {
  let system: string
  let user: string

  switch (type) {
    case 'morning_finance':
      system = FINANCE_SYSTEM
      user = await buildFinanceContext()
      break
    case 'health_weekly':
      system = HEALTH_SYSTEM
      user = await buildHealthContext()
      break
    case 'morning_sleep':
      system = SLEEP_SYSTEM
      user = await buildHealthContext()
      break
  }

  const content = await generateAnalysis(system, user)
  const today = new Date().toISOString().split('T')[0]

  const db = await getDb()
  await db.runAsync(
    `INSERT INTO briefings (type, date, content, raw_prompt, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(type, date) DO UPDATE SET
       content = excluded.content,
       raw_prompt = excluded.raw_prompt,
       created_at = excluded.created_at`,
    type,
    today,
    content,
    user.slice(0, 2000),
  )

  return content
}
