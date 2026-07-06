import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { BrowserWindow, Notification } from 'electron'
import store from '../lib/store'
import { getDb } from '../db/database'
import { refreshAllFinanceData } from './finance'
import { archiveStaleNews } from './finance/news.fetcher'
import { refreshAllFundamentals, fetchEarningsCalendar } from './finance/alphavantage.fetcher'
import { scoreUnscoredArticles } from './finance/news-sentiment.service'
import { checkAlerts } from './finance/alerts.service'
import { generateBriefing } from '../ai/briefing-generator'
import { syncWithRelay } from './sync.service'
import { pullBriefingsFromNotion } from './notion/notion.sync'
import { checkHealthAlerts } from './health/health-alerts.service'
import { parseSleepSessions, predictCircadianRhythm } from './health/sleep-analysis'
import { runMorningSleepBriefingIfDue } from './health/health-export.service'
import { getAppSettings } from '../lib/settings'

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ])
}

interface ScheduledJob {
  name: string
  task: ScheduledTask
  cronExpression: string
}

const jobs: ScheduledJob[] = []
const runningJobs = new Set<string>()

function beginJobLog(name: string): number | null {
  try {
    const r = getDb()
      .prepare(`INSERT INTO scheduler_activity_log (job_name, status) VALUES (?, 'running')`)
      .run(name)
    return Number(r.lastInsertRowid)
  } catch (err) {
    console.error('[Scheduler] beginJobLog failed:', err)
    return null
  }
}

function finishJobLog(
  id: number | null,
  status: 'ok' | 'error',
  errorText: string | null,
  durationMs: number,
): void {
  if (id == null) return
  try {
    getDb()
      .prepare(
        `UPDATE scheduler_activity_log
       SET finished_at = datetime('now'), status = ?, error_text = ?, duration_ms = ?
       WHERE id = ?`,
      )
      .run(status, errorText, durationMs, id)
  } catch (err) {
    console.error('[Scheduler] finishJobLog failed:', err)
  }
}

/**
 * Returns the timestamp of the last successful run for `name`, in epoch ms.
 * Falls back to the legacy `scheduler.lastRun.*` store key for installs that
 * haven't yet generated log rows after upgrade.
 */
function getLastSuccess(name: string): number {
  try {
    const row = getDb()
      .prepare(
        `SELECT started_at FROM scheduler_activity_log
       WHERE job_name = ? AND status = 'ok'
       ORDER BY started_at DESC LIMIT 1`,
      )
      .get(name) as { started_at: string } | undefined
    if (row) {
      // started_at is stored as 'YYYY-MM-DD HH:MM:SS' (UTC, SQLite default).
      const ms = new Date(row.started_at.replace(' ', 'T') + 'Z').getTime()
      if (Number.isFinite(ms)) return ms
    }
  } catch (err) {
    console.error('[Scheduler] getLastSuccess failed:', err)
  }
  return (store.get(`scheduler.lastRun.${name}`) as number) || 0
}

export function getSchedulerActivity(limit = 50): Array<{
  id: number
  job_name: string
  started_at: string
  finished_at: string | null
  status: string | null
  error_text: string | null
  duration_ms: number | null
}> {
  try {
    return getDb()
      .prepare(
        `SELECT id, job_name, started_at, finished_at, status, error_text, duration_ms
       FROM scheduler_activity_log
       ORDER BY started_at DESC
       LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number
      job_name: string
      started_at: string
      finished_at: string | null
      status: string | null
      error_text: string | null
      duration_ms: number | null
    }>
  } catch (err) {
    console.error('[Scheduler] getSchedulerActivity failed:', err)
    return []
  }
}

export function initScheduler(): void {
  // Check for missed jobs on startup
  checkMissedJobs()

  // Sync from relay immediately on startup so desktop has latest HAE data.
  // After the pull completes, check whether today's morning sleep briefing
  // still needs to be generated (covers days when the desktop wasn't running
  // at the 08:30 cron time).
  syncWithRelay()
    .then(() => runMorningSleepBriefingIfDue({ reason: 'startup' }))
    .catch((err) => {
      console.error('[Scheduler] initial relay sync failed:', err)
    })

  // Eagerly sweep stale news on boot so existing weeks-old articles are
  // archived before the user opens the dashboard.
  try {
    archiveStaleNews(7)
  } catch (err) {
    console.error('[Scheduler] initial archiveStaleNews failed:', err)
  }

  // Get user-configured morning time or default to 07:00
  const settings = getAppSettings()
  const morningTime = settings?.morningBriefingTime || '07:00'
  const [hour, minute] = morningTime.split(':').map(Number)

  // Morning briefing
  registerJob('morning-briefing', `${minute} ${hour} * * *`, async () => {
    console.log('[Scheduler] Running morning briefing...')
    await refreshAllFinanceData()
    const content = await withTimeout(
      generateBriefing('morning_finance'),
      90_000,
      'Morning briefing timed out',
    )
    showNotification('Morning Briefing Ready', truncate(content, 100))
    notifyRenderer('briefing:new', { type: 'morning_finance' })
  })

  // Market data refresh every 4 hours during market-adjacent hours.
  // Also sweeps stale news (>7 days) so the dashboard never shows
  // weeks-old headlines if a fetch silently fails for a stretch.
  registerJob('market-refresh', '0 */4 * * *', async () => {
    console.log('[Scheduler] Refreshing market data...')
    const archived = archiveStaleNews(7)
    const result = await refreshAllFinanceData()
    console.log(
      `[Scheduler] Market refresh: ${result.stocks} stocks, ${result.crypto} crypto, ${result.news} news (${archived} archived)`,
    )
    notifyRenderer('finance:updated')
  })

  // Evening health sync
  registerJob('evening-health', '30 22 * * *', async () => {
    console.log('[Scheduler] Running evening health sync...')
    const content = await withTimeout(
      generateBriefing('health_weekly'),
      90_000,
      'Health briefing timed out',
    )
    showNotification('Health Insights Updated', truncate(content, 100))
    notifyRenderer('briefing:new', { type: 'health_weekly' })
    // Re-evaluate health alerts after weekly briefing builds context.
    try {
      await checkHealthAlerts()
    } catch (err) {
      console.error('[Scheduler] health-alerts post-evening failed:', err)
    }
  })

  // Standalone health-alerts check at 07:30 catches the morning sleep refresh.
  registerJob('health-alerts-morning', '30 7 * * *', async () => {
    const hits = await checkHealthAlerts()
    if (hits.length > 0) console.log(`[Scheduler] morning health-alerts: ${hits.length} fired`)
  })

  // Relay sync every 30 minutes (desktop ↔ mobile health data)
  registerJob('relay-sync', '*/30 * * * *', async () => {
    await syncWithRelay()
  })

  // Morning sleep briefing fallback. Delegates to the shared idempotent
  // generator so health-arrival, relay-pull, startup, and this cron all use
  // the same "today's briefing exists?" check.
  const fallbackTime = settings?.morningSleepFallbackTime || '08:30'
  const [fbHour, fbMin] = fallbackTime.split(':').map(Number)
  registerJob('morning-sleep-fallback', `${fbMin} ${fbHour} * * *`, async () => {
    await withTimeout(
      runMorningSleepBriefingIfDue({ reason: 'cron-fallback' }),
      90_000,
      'Morning sleep briefing timed out',
    )
  })

  // Wind-down reminder (dynamic based on circadian analysis)
  scheduleWindDownReminder()

  // Daily fundamentals + earnings calendar (18:30 ET-ish after market close)
  registerJob('fundamentals-daily', '30 18 * * *', async () => {
    console.log('[Scheduler] Refreshing fundamentals + earnings calendar...')
    const fCount = await refreshAllFundamentals()
    const eCount = await fetchEarningsCalendar('3month')
    console.log(`[Scheduler] Fundamentals: ${fCount} symbols; Earnings: ${eCount} rows`)
  })

  // Alert checks every 5 minutes
  registerJob('alerts-check', '*/5 * * * *', async () => {
    const hits = await checkAlerts()
    if (hits.length > 0) {
      console.log(`[Scheduler] ${hits.length} alert(s) fired`)
    }
  })

  // Daily news sentiment scoring (runs after evening news fetch settles)
  registerJob('news-sentiment-daily', '15 19 * * *', async () => {
    console.log('[Scheduler] Scoring news sentiment...')
    const count = await scoreUnscoredArticles(200)
    console.log(`[Scheduler] News sentiment: ${count} articles scored`)
  })

  // Notion → local pull (briefings) at 06:00 daily, before morning brief reads context
  registerJob('notion-pull-briefings', '0 6 * * *', async () => {
    const settings = getAppSettings()
    if (!settings?.notionApiKey || !settings?.notionBriefingsDbId) {
      console.log('[Scheduler] notion-pull-briefings skipped — Notion not configured')
      return
    }
    const result = await pullBriefingsFromNotion(14)
    console.log(
      `[Scheduler] Notion pull briefings: ${result.pulled} (${result.created} new, ${result.updated} updated)`,
    )
  })

  // Weekly deep analysis on Sunday 9am
  registerJob('weekly-analysis', '0 9 * * 0', async () => {
    console.log('[Scheduler] Running weekly deep analysis...')
    await refreshAllFinanceData()
    await generateBriefing('morning_finance')
    await generateBriefing('health_weekly')
    showNotification('Weekly Analysis Complete', 'Finance and health reports are ready.')
    notifyRenderer('briefing:new', { type: 'weekly' })
  })

  console.log(`[Scheduler] Registered ${jobs.length} jobs`)
}

function registerJob(name: string, cronExpression: string, handler: () => Promise<void>): void {
  const wrapped = async () => {
    if (runningJobs.has(name)) {
      console.warn(`[Scheduler] ${name} skipped because the previous run is still active`)
      return
    }
    runningJobs.add(name)
    const logId = beginJobLog(name)
    const start = Date.now()
    try {
      await handler()
      finishJobLog(logId, 'ok', null, Date.now() - start)
      // Mirror to legacy store key for install-time migration compatibility.
      store.set(`scheduler.lastRun.${name}`, Date.now())
    } catch (err) {
      const msg = (err as Error)?.message || String(err)
      console.error(`[Scheduler] ${name} failed:`, msg)
      finishJobLog(logId, 'error', msg, Date.now() - start)
    } finally {
      runningJobs.delete(name)
    }
  }
  const task = cron.schedule(cronExpression, wrapped, {
    name,
    noOverlap: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  jobs.push({ name, task, cronExpression })
}

function checkMissedJobs(): void {
  const now = Date.now()
  const missedThreshold = 2 * 60 * 60 * 1000 // 2 hours

  // Morning briefing — only if the scheduled time has passed today and the
  // last successful run was before today's target time.
  const settings = getAppSettings()
  const morningTime = settings?.morningBriefingTime || '07:00'
  const [hour, minute] = morningTime.split(':').map(Number)
  const todayMorning = new Date()
  todayMorning.setHours(hour, minute, 0, 0)

  if (now > todayMorning.getTime() && getLastSuccess('morning-briefing') < todayMorning.getTime()) {
    const timeSinceMorning = now - todayMorning.getTime()
    if (timeSinceMorning < missedThreshold) {
      console.log('[Scheduler] Missed morning briefing — running now')
      setTimeout(async () => {
        const logId = beginJobLog('morning-briefing')
        const start = Date.now()
        try {
          await refreshAllFinanceData()
          await generateBriefing('morning_finance')
          showNotification('Morning Briefing (Delayed)', 'Your morning briefing is ready.')
          notifyRenderer('briefing:new', { type: 'morning_finance' })
          finishJobLog(logId, 'ok', null, Date.now() - start)
          store.set('scheduler.lastRun.morning-briefing', Date.now())
        } catch (err) {
          const msg = (err as Error)?.message || String(err)
          console.error('[Scheduler] Missed morning briefing failed:', msg)
          finishJobLog(logId, 'error', msg, Date.now() - start)
        }
      }, 5000)
    }
  }

  // Market refresh — if older than 4h, run once on startup.
  if (now - getLastSuccess('market-refresh') > 4 * 60 * 60 * 1000) {
    console.log('[Scheduler] Market data stale — refreshing')
    setTimeout(async () => {
      const logId = beginJobLog('market-refresh')
      const start = Date.now()
      try {
        await refreshAllFinanceData()
        notifyRenderer('finance:updated')
        finishJobLog(logId, 'ok', null, Date.now() - start)
        store.set('scheduler.lastRun.market-refresh', Date.now())
      } catch (err) {
        const msg = (err as Error)?.message || String(err)
        console.error('[Scheduler] Stale market refresh failed:', msg)
        finishJobLog(logId, 'error', msg, Date.now() - start)
      }
    }, 3000)
  }

  // Fundamentals + earnings — if no run in the last 36h, refresh on startup.
  if (now - getLastSuccess('fundamentals-daily') > 36 * 60 * 60 * 1000) {
    console.log('[Scheduler] Fundamentals stale — refreshing')
    setTimeout(async () => {
      const logId = beginJobLog('fundamentals-daily')
      const start = Date.now()
      try {
        await refreshAllFundamentals()
        await fetchEarningsCalendar('3month')
        finishJobLog(logId, 'ok', null, Date.now() - start)
        store.set('scheduler.lastRun.fundamentals-daily', Date.now())
      } catch (err) {
        const msg = (err as Error)?.message || String(err)
        console.error('[Scheduler] Stale fundamentals refresh failed:', msg)
        finishJobLog(logId, 'error', msg, Date.now() - start)
      }
    }, 8000)
  }

  // News sentiment — if no run in the last 36h and we have unscored articles,
  // run after a delay (best-effort; alerts-check runs every 5min so it'll
  // self-heal regardless).
  if (now - getLastSuccess('news-sentiment-daily') > 36 * 60 * 60 * 1000) {
    console.log('[Scheduler] News sentiment stale — scoring')
    setTimeout(async () => {
      const logId = beginJobLog('news-sentiment-daily')
      const start = Date.now()
      try {
        await scoreUnscoredArticles(200)
        finishJobLog(logId, 'ok', null, Date.now() - start)
        store.set('scheduler.lastRun.news-sentiment-daily', Date.now())
      } catch (err) {
        const msg = (err as Error)?.message || String(err)
        console.error('[Scheduler] Stale news sentiment failed:', msg)
        finishJobLog(logId, 'error', msg, Date.now() - start)
      }
    }, 15000)
  }
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
}

function notifyRenderer(channel: string, data?: any): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(channel, data)
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '...'
}

function scheduleWindDownReminder(): void {
  const appSettings = getAppSettings()
  const existingIndex = jobs.findIndex((job) => job.name === 'wind-down-reminder')
  if (existingIndex >= 0) {
    jobs[existingIndex].task.stop()
    jobs.splice(existingIndex, 1)
  }

  if (appSettings?.enableWindDownReminder === 'false') return

  try {
    const sessions = parseSleepSessions(7)
    if (sessions.length < 3) return

    const circadian = predictCircadianRhythm(sessions)
    const leadMinutes = parseInt(appSettings?.windDownMinutesBefore || '120')

    // Parse melatonin window start and subtract lead time
    const [mHour, mMin] = circadian.melatoninWindowStart.split(':').map(Number)
    const windDownDate = new Date()
    windDownDate.setHours(mHour, mMin, 0, 0)

    registerJob('wind-down-reminder', `${mMin} ${mHour} * * *`, async () => {
      const currentSettings = getAppSettings()
      if (currentSettings?.enableWindDownReminder === 'false') return

      showNotification(
        'Wind Down Time',
        `Melatonin window opening. Dim lights, avoid screens. Recommended bedtime: ${circadian.optimalBedtime}`,
      )
      notifyRenderer('health:wind-down', {
        bedtime: circadian.optimalBedtime,
        melatoninWindow: circadian.melatoninWindowStart,
      })
    })
    console.log(`[Scheduler] Wind-down reminder set for ${circadian.melatoninWindowStart}`)
  } catch (err) {
    console.error('[Scheduler] Failed to schedule wind-down reminder:', err)
  }
}

export { scheduleWindDownReminder }

export function stopScheduler(): void {
  for (const job of jobs) {
    job.task.stop()
  }
  jobs.length = 0
  console.log('[Scheduler] All jobs stopped')
}

export function getSchedulerStatus(): Array<{
  name: string
  cron: string
  lastRun: number | null
}> {
  return jobs.map((j) => ({
    name: j.name,
    cron: j.cronExpression,
    lastRun: (store.get(`scheduler.lastRun.${j.name}`) as number) || null,
  }))
}
