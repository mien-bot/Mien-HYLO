import { useState, useEffect, useMemo, useRef } from 'react'
import { Save, Check, Link2, Copy, RefreshCw, Search, ChevronDown, Unlink } from 'lucide-react'
import { ChartCard, RadialGauge, SparklineRow, TrendBadge } from '../../components/charts'
import { useAiCacheStats, useRelayStats, useSchedulerSuccessRate } from '../../hooks/useAggregations'
import { applyChartPalette } from '../../lib/chartPalette'
import { applyTheme, applyAccent, applyMotionLevel, THEME_PRESETS } from '../../lib/theme'
import type { ThemePreset, MotionLevel } from '../../lib/theme'
import type { PaletteName } from '../../components/charts/tokens'
import { DEFAULT_TRAINING_DAYS, HEALTH_SERVER_PORT } from '../../../shared/constants'

interface SettingsState {
  claudeApiKey: string
  alphaVantageKey: string
  relayUrl: string
  relayToken: string
  ticketmasterApiKey: string
  googlePlacesKey: string
  notionApiKey: string
  notionTasksDbId: string
  notionBriefingsDbId: string
  notionCalendarDbId: string
  notionBriefingsDateProperty: string
  notionCalendarDateProperty: string
  healthDataPath: string
  healthServerPort: string
  morningBriefingTime: string
  homeLocation: string
  homeNeighborhood: string
  commuteNotes: string
  transportMode: string
  weekendCity: string
  weekendRadius: string
  weekendInterests: string
  youtubeChannels: string
  userAge: string
  userWeight: string
  sleepGoalHours: string
  enableMorningSleepBriefing: string
  morningSleepFallbackTime: string
  enableWindDownReminder: string
  windDownMinutesBefore: string
  opusMode: string
  newsSentimentDailyCap: string
  chartDensity: 'compact' | 'comfortable' | 'spacious'
  chartPalette: PaletteName
  themePreset: ThemePreset
  accentColor: string
  motionLevel: MotionLevel
  displayName: string
  enableCrossDomainComposites: 'true' | 'false'
  showAdvancedTechnicals: 'true' | 'false'
  defaultRange: '7d' | '30d' | '90d' | '1y'
  stravaClientId: string
  stravaClientSecret: string
  lactateThresholdHR: string
  maxHrRun: string
  maxHrRide: string
  lthrRun: string
  lthrRide: string
  restingHr: string
  zoneModel: 'maxhr' | 'friel'
  ftp: string
  activityIgnorePatterns: string
  uiScale: string
}

const defaultSettings: SettingsState = {
  claudeApiKey: '',
  alphaVantageKey: '',
  relayUrl: '',
  relayToken: '',
  ticketmasterApiKey: '',
  googlePlacesKey: '',
  notionApiKey: '',
  notionTasksDbId: '',
  notionBriefingsDbId: '',
  notionCalendarDbId: '',
  notionBriefingsDateProperty: '',
  notionCalendarDateProperty: '',
  healthDataPath: '',
  healthServerPort: String(HEALTH_SERVER_PORT),
  morningBriefingTime: '07:00',
  homeLocation: '',
  homeNeighborhood: '',
  commuteNotes: '',
  transportMode: 'driving',
  weekendCity: '',
  weekendRadius: '30',
  weekendInterests: '',
  youtubeChannels:
    'Meet Kevin|UCUvvj5lwue7PspotMDjk5UA|meetkevin\nTrading Fraternity|UCymzDnu-l3vZ1fxuqvRePOA|Thetradingfraternity\nAndrei Jikh|UCGy7SkBjcIAgTiwkXEtPnYg|AndreiJikh\nFinancial Education|UCnMn36GT_H0X-w5_ckLtlgQ|financialeducation',
  userAge: '',
  userWeight: '',
  sleepGoalHours: '8.0',
  enableMorningSleepBriefing: 'true',
  morningSleepFallbackTime: '08:30',
  enableWindDownReminder: 'true',
  windDownMinutesBefore: '120',
  opusMode: 'false',
  newsSentimentDailyCap: '100',
  chartDensity: 'comfortable',
  chartPalette: 'default',
  themePreset: 'ramen',
  accentColor: '',
  motionLevel: 'playful',
  displayName: '',
  enableCrossDomainComposites: 'true',
  showAdvancedTechnicals: 'true',
  defaultRange: '30d',
  stravaClientId: '',
  stravaClientSecret: '',
  lactateThresholdHR: '',
  maxHrRun: '',
  maxHrRide: '',
  lthrRun: '',
  lthrRide: '',
  restingHr: '',
  zoneModel: 'friel',
  ftp: '',
  activityIgnorePatterns: '',
  uiScale: '1.0',
}

interface TunnelInfo {
  url: string | null
  source: 'file' | 'http' | null
  updatedAt: number | null
  watchedPath?: string | null
}

type TabId = 'connections' | 'notion' | 'health' | 'daily' | 'display' | 'activity'

const TABS: { id: TabId; label: string }[] = [
  { id: 'connections', label: 'Connections' },
  { id: 'notion', label: 'Notion' },
  { id: 'health', label: 'Health' },
  { id: 'daily', label: 'Daily' },
  { id: 'display', label: 'Display' },
  { id: 'activity', label: 'Updates & Activity' },
]

const TAB_STORAGE_KEY = 'mien.settings.activeTab'

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsState>(defaultSettings)
  const [saved, setSaved] = useState(false)
  const [tunnel, setTunnel] = useState<TunnelInfo>({ url: null, source: null, updatedAt: null })
  const [actualHealthPort, setActualHealthPort] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const stored =
      typeof window !== 'undefined' ? window.localStorage.getItem(TAB_STORAGE_KEY) : null
    return TABS.find((t) => t.id === stored)?.id ?? 'connections'
  })
  const lastSavedRef = useRef<SettingsState>(defaultSettings)

  useEffect(() => {
    window.api.getSettings('appSettings').then((val) => {
      const next = { ...defaultSettings, ...((val as Partial<SettingsState>) || {}) }
      setSettings(next)
      lastSavedRef.current = next
    })
    window.api.getTunnelUrl().then(setTunnel)
    const off = window.api.onTunnelUrl((data) => setTunnel(data as TunnelInfo))
    window.api
      .getHealthServerPort()
      .then((p) => setActualHealthPort(typeof p === 'number' ? p : null))
    return off
  }, [])

  useEffect(() => {
    window.localStorage.setItem(TAB_STORAGE_KEY, activeTab)
  }, [activeTab])

  const isDirty = useMemo(() => {
    return JSON.stringify(settings) !== JSON.stringify(lastSavedRef.current)
  }, [settings])

  const handleSave = async () => {
    await window.api.setSettings('appSettings', settings)
    lastSavedRef.current = settings
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  const update = (key: keyof SettingsState, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div
        className="sticky top-0 z-20 -mx-6 px-6 pt-1 pb-3 mb-5"
        style={{ background: 'var(--bg-primary)' }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            Settings
          </h2>
          <SaveButton onClick={handleSave} saved={saved} dirty={isDirty} />
        </div>
        <div className="flex gap-1 mt-3 overflow-x-auto">
          {TABS.map((tab) => {
            const active = tab.id === activeTab
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap"
                style={{
                  background: active ? 'var(--bg-tertiary)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                  border: '1px solid',
                  borderColor: active ? 'var(--separator)' : 'transparent',
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-5">
        {activeTab === 'connections' && (
          <ConnectionsTab
            settings={settings}
            tunnel={tunnel}
            update={update}
            onSave={handleSave}
            saved={saved}
            dirty={isDirty}
          />
        )}
        {activeTab === 'notion' && (
          <NotionTab
            settings={settings}
            update={update}
            onSave={handleSave}
            saved={saved}
            dirty={isDirty}
          />
        )}
        {activeTab === 'health' && (
          <HealthTab
            settings={settings}
            update={update}
            actualHealthPort={actualHealthPort}
            onSave={handleSave}
            saved={saved}
            dirty={isDirty}
          />
        )}
        {activeTab === 'daily' && (
          <DailyTab
            settings={settings}
            update={update}
            onSave={handleSave}
            saved={saved}
            dirty={isDirty}
          />
        )}
        {activeTab === 'display' && (
          <DisplayTab
            settings={settings}
            setSettings={setSettings}
            onSave={handleSave}
            saved={saved}
            dirty={isDirty}
          />
        )}
        {activeTab === 'activity' && <ActivityTab />}
      </div>
    </div>
  )
}

// ----- Tabs -----

function ConnectionsTab({
  settings,
  tunnel,
  update,
  onSave,
  saved,
  dirty,
}: {
  settings: SettingsState
  tunnel: TunnelInfo
  update: (key: keyof SettingsState, value: string) => void
  onSave: () => Promise<void>
  saved: boolean
  dirty: boolean
}) {
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [tunnelCopied, setTunnelCopied] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    if (dirty) await onSave()
    const r = await window.api.testRelayConnection()
    if (r.ok) {
      setTestResult({ ok: true, msg: `Connected · relay ${r.version} · ${r.provider}` })
    } else {
      setTestResult({ ok: false, msg: r.error || 'Failed' })
    }
    setTesting(false)
  }

  const pushAll = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      if (dirty) await onSave()
      await window.api.relaySyncAll()
      await window.api.relayPushSleepAnalysis()
      setSyncResult('Latest data synced.')
    } catch (err: any) {
      setSyncResult(`Error: ${err.message}`)
    }
    setSyncing(false)
    setTimeout(() => setSyncResult(null), 3500)
  }

  return (
    <>
      <Section title="Claude relay" onSave={onSave} saved={saved} dirty={dirty}>
        {tunnel.url && (
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
          >
            <Link2 size={12} style={{ color: 'var(--accent-blue)' }} />
            <code
              className="px-2 py-0.5 rounded flex-1 truncate"
              style={{ background: 'var(--bg-secondary)', color: 'var(--accent-blue)' }}
            >
              {tunnel.url}
            </code>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(tunnel.url!)
                setTunnelCopied(true)
                setTimeout(() => setTunnelCopied(false), 1500)
              }}
              className="flex items-center gap-1 px-2 py-1 rounded transition-colors"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
            >
              {tunnelCopied ? <Check size={12} /> : <Copy size={12} />}
              {tunnelCopied ? 'Copied' : 'Copy'}
            </button>
            {tunnel.url !== settings.relayUrl && (
              <button
                onClick={() => update('relayUrl', tunnel.url!)}
                className="px-2 py-1 rounded transition-colors"
                style={{ background: 'var(--accent-blue)', color: 'white' }}
              >
                Use
              </button>
            )}
          </div>
        )}
        <Field
          label="Relay URL"
          value={settings.relayUrl}
          onChange={(v) => update('relayUrl', v)}
          placeholder="http://192.168.1.50:3456"
        />
        <Field
          label="Relay token"
          value={settings.relayToken}
          onChange={(v) => update('relayToken', v)}
          placeholder="From relay.key"
          type="password"
        />
        <Select
          label="Model"
          value={settings.opusMode}
          onChange={(v) => update('opusMode', v)}
          options={[
            { value: 'false', label: 'Sonnet (faster, cheaper)' },
            { value: 'true', label: 'Opus (deeper reasoning)' },
          ]}
        />
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Sync now pulls recent relay data into this desktop app and pushes local desktop data
            back to the relay.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={testConnection}
              disabled={testing || !settings.relayUrl}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
            >
              <Link2 size={12} />
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button
              onClick={pushAll}
              disabled={syncing || !settings.relayUrl}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-green)' }}
            >
              <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing...' : 'Sync latest data'}
            </button>
          </div>
          {testResult && (
            <span
              className="text-xs"
              style={{ color: testResult.ok ? 'var(--accent-green)' : 'var(--accent-red)' }}
            >
              {testResult.ok ? '✓' : '✗'} {testResult.msg}
            </span>
          )}
          {syncResult && (
            <span
              className="text-xs"
              style={{
                color: syncResult.startsWith('Error') ? 'var(--accent-red)' : 'var(--accent-green)',
              }}
            >
              {syncResult}
            </span>
          )}
        </div>
      </Section>

      <Section title="API keys" onSave={onSave} saved={saved} dirty={dirty}>
        <Field
          label="Claude (direct mode)"
          value={settings.claudeApiKey}
          onChange={(v) => update('claudeApiKey', v)}
          placeholder="sk-ant-…"
          type="password"
        />
        <Field
          label="Alpha Vantage"
          value={settings.alphaVantageKey}
          onChange={(v) => update('alphaVantageKey', v)}
          placeholder="For deeper stock data"
          type="password"
        />
        <Field
          label="Ticketmaster"
          value={settings.ticketmasterApiKey}
          onChange={(v) => update('ticketmasterApiKey', v)}
          placeholder="For weekend events"
          type="password"
        />
        <Field
          label="Google Places"
          value={settings.googlePlacesKey}
          onChange={(v) => update('googlePlacesKey', v)}
          placeholder="For restaurant search"
          type="password"
        />
      </Section>

      <Section title="Software update">
        <AppUpdatePanel />
      </Section>
    </>
  )
}

function NotionTab({
  settings,
  update,
  onSave,
  saved,
  dirty,
}: {
  settings: SettingsState
  update: (key: keyof SettingsState, value: string) => void
  onSave: () => Promise<void>
  saved: boolean
  dirty: boolean
}) {
  const [notionDbs, setNotionDbs] = useState<{ id: string; title: string }[]>([])
  const [loadingDbs, setLoadingDbs] = useState(false)
  const [dbsError, setDbsError] = useState<string | null>(null)

  const loadNotionDbs = async () => {
    setLoadingDbs(true)
    setDbsError(null)
    try {
      if (dirty) await onSave()
      const dbs = await window.api.listNotionDatabases()
      setNotionDbs(dbs || [])
    } catch (err: any) {
      setDbsError(err?.message || 'Failed to list Notion databases')
    }
    setLoadingDbs(false)
  }

  return (
    <Section title="Notion" onSave={onSave} saved={saved} dirty={dirty}>
      <Field
        label="API key"
        value={settings.notionApiKey}
        onChange={(v) => update('notionApiKey', v)}
        placeholder="ntn_…"
        type="password"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {notionDbs.length > 0
            ? `${notionDbs.length} database${notionDbs.length === 1 ? '' : 's'} found`
            : 'Load databases from your integration'}
        </span>
        <button
          type="button"
          onClick={loadNotionDbs}
          disabled={loadingDbs || !settings.notionApiKey}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors disabled:opacity-40"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
        >
          <RefreshCw size={12} className={loadingDbs ? 'animate-spin' : ''} />
          {notionDbs.length > 0 ? 'Refresh' : 'Load databases'}
        </button>
      </div>
      {dbsError && (
        <div
          className="text-xs px-2 py-1.5 rounded"
          style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--accent-red)' }}
        >
          {dbsError}
        </div>
      )}
      <NotionDbPicker
        label="Tasks database"
        hint="Pulls your to-do items for the Productivity page daily task list"
        value={settings.notionTasksDbId}
        databases={notionDbs}
        onChange={(v) => update('notionTasksDbId', v)}
      />
      <NotionDbPicker
        label="Briefings database"
        hint="Stores AI-generated briefings (finance, sleep, market research)"
        value={settings.notionBriefingsDbId}
        databases={notionDbs}
        onChange={(v) => {
          update('notionBriefingsDbId', v)
          update('notionBriefingsDateProperty', '')
        }}
      />
      <NotionDatePropertyPicker
        label="Briefings date property"
        dbId={settings.notionBriefingsDbId}
        value={settings.notionBriefingsDateProperty}
        onChange={(v) => update('notionBriefingsDateProperty', v)}
      />
      <NotionDbPicker
        label="Calendar database"
        hint="Receives daily schedules and weekend plans as calendar entries"
        value={settings.notionCalendarDbId}
        databases={notionDbs}
        onChange={(v) => {
          update('notionCalendarDbId', v)
          update('notionCalendarDateProperty', '')
        }}
      />
      <NotionDatePropertyPicker
        label="Calendar date property"
        dbId={settings.notionCalendarDbId}
        value={settings.notionCalendarDateProperty}
        onChange={(v) => update('notionCalendarDateProperty', v)}
      />
      <NotionPullBriefingsButton
        disabled={!settings.notionApiKey || !settings.notionBriefingsDbId}
      />
    </Section>
  )
}

function HealthTab({
  settings,
  update,
  actualHealthPort,
  onSave,
  saved,
  dirty,
}: {
  settings: SettingsState
  update: (key: keyof SettingsState, value: string) => void
  actualHealthPort: number | null
  onSave: () => Promise<void>
  saved: boolean
  dirty: boolean
}) {
  const [historicalSleepSyncing, setHistoricalSleepSyncing] = useState(false)
  const [historicalSleepResult, setHistoricalSleepResult] = useState<string | null>(null)

  const pullHistoricalSleep = async () => {
    setHistoricalSleepSyncing(true)
    setHistoricalSleepResult(null)
    try {
      if (dirty) await onSave()
      const result = await window.api.relayPullHistoricalSleep(3650)
      if (result?.success) {
        const range =
          result.earliestDate && result.latestDate
            ? ` (${result.earliestDate} to ${result.latestDate})`
            : ''
        const skipped = result.skipped ? `, skipped ${result.skipped} short/invalid rows` : ''
        setHistoricalSleepResult(
          `Synced ${result.pulled} sleep records${range}. Relay returned ${result.received ?? result.pulled} records for the 10-year request${skipped}.`,
        )
      } else {
        setHistoricalSleepResult(`Error: ${result?.error || 'historical sleep sync failed.'}`)
      }
    } catch (err: any) {
      setHistoricalSleepResult(`Error: ${err.message}`)
    }
    setHistoricalSleepSyncing(false)
    setTimeout(() => setHistoricalSleepResult(null), 5000)
  }

  return (
    <>
      <Section title="Profile" onSave={onSave} saved={saved} dirty={dirty}>
        <div className="grid grid-cols-4 gap-3">
          <Field
            label="Age"
            value={settings.userAge}
            onChange={(v) => update('userAge', v)}
            placeholder="25"
          />
          <Field
            label="Weight (lbs)"
            value={settings.userWeight}
            onChange={(v) => update('userWeight', v)}
            placeholder="160"
          />
          <Field
            label="Sleep goal (hrs)"
            value={settings.sleepGoalHours}
            onChange={(v) => update('sleepGoalHours', v)}
            placeholder="8.0"
          />
          <Field
            label="Lactate threshold HR"
            value={settings.lactateThresholdHR}
            onChange={(v) => update('lactateThresholdHR', v)}
            placeholder="Auto (85% max)"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="FTP (watts)"
            value={settings.ftp}
            onChange={(v) => update('ftp', v)}
            placeholder="Functional Threshold Power"
          />
          <Field
            label="Ignore activities (regex, one per line)"
            value={settings.activityIgnorePatterns}
            onChange={(v) => update('activityIgnorePatterns', v)}
            placeholder="e.g. Commute|Walk"
          />
        </div>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          LTHR normalizes HRSS. FTP sets power zones (% of FTP). Ignore patterns filter activities
          from fitness trend by name.
        </p>
      </Section>

      <Section title="Sleep briefings & reminders" onSave={onSave} saved={saved} dirty={dirty}>
        <Select
          label="Morning sleep briefing"
          value={settings.enableMorningSleepBriefing}
          onChange={(v) => update('enableMorningSleepBriefing', v)}
          options={[
            { value: 'true', label: 'Auto-generate when sleep data arrives' },
            { value: 'false', label: 'Disabled' },
          ]}
        />
        <Select
          label="Wind-down reminder"
          value={settings.enableWindDownReminder}
          onChange={(v) => update('enableWindDownReminder', v)}
          options={[
            { value: 'true', label: 'Notify before melatonin window' },
            { value: 'false', label: 'Disabled' },
          ]}
        />
        <Advanced label="Advanced timing">
          <Field
            label="Fallback briefing time"
            value={settings.morningSleepFallbackTime}
            onChange={(v) => update('morningSleepFallbackTime', v)}
            placeholder="08:30"
          />
          <Field
            label="Wind-down lead (min)"
            value={settings.windDownMinutesBefore}
            onChange={(v) => update('windDownMinutesBefore', v)}
            placeholder="120"
          />
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Restart the app after changing reminder timing.
          </p>
        </Advanced>
      </Section>

      <StravaSection
        settings={settings}
        update={update}
        onSave={onSave}
        saved={saved}
        dirty={dirty}
      />

      <Section title="Health data sync" onSave={onSave} saved={saved} dirty={dirty}>
        <Field
          label="Health Auto Export folder"
          value={settings.healthDataPath}
          onChange={(v) => update('healthDataPath', v)}
          placeholder="C:/Users/you/health-data"
        />
        <Advanced label="Server port">
          <Field
            label="Port"
            value={settings.healthServerPort}
            onChange={(v) => update('healthServerPort', v)}
            placeholder={String(HEALTH_SERVER_PORT)}
          />
          {actualHealthPort !== null && String(actualHealthPort) !== settings.healthServerPort && (
            <div className="text-xs text-amber-400">
              Configured port unavailable — server is on {actualHealthPort}.
            </div>
          )}
        </Advanced>
        <div
          className="rounded-lg p-3 space-y-2"
          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Historical sleep backfill
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Requests sleep records from the relay for the last 10 years. The result depends on
                how much history the relay has received.
              </p>
            </div>
            <button
              type="button"
              onClick={pullHistoricalSleep}
              disabled={historicalSleepSyncing || !settings.relayUrl}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors disabled:opacity-50 shrink-0"
              style={{ background: 'var(--bg-secondary)', color: 'var(--accent-purple)' }}
            >
              <RefreshCw size={12} className={historicalSleepSyncing ? 'animate-spin' : ''} />
              {historicalSleepSyncing ? 'Syncing...' : 'Sync 10 years'}
            </button>
          </div>
          {historicalSleepResult && (
            <span
              className="text-xs"
              style={{
                color: historicalSleepResult.startsWith('Error')
                  ? 'var(--accent-red)'
                  : 'var(--accent-green)',
              }}
            >
              {historicalSleepResult}
            </span>
          )}
        </div>
      </Section>
    </>
  )
}

function DailyTab({
  settings,
  update,
  onSave,
  saved,
  dirty,
}: {
  settings: SettingsState
  update: (key: keyof SettingsState, value: string) => void
  onSave: () => void
  saved: boolean
  dirty: boolean
}) {
  return (
    <>
      <Section title="Schedule" onSave={onSave} saved={saved} dirty={dirty}>
        <Field
          label="Morning briefing time"
          value={settings.morningBriefingTime}
          onChange={(v) => update('morningBriefingTime', v)}
          placeholder="07:00"
        />
        <Advanced label="News sentiment cap">
          <Field
            label="Articles AI-scored per day"
            value={settings.newsSentimentDailyCap}
            onChange={(v) => update('newsSentimentDailyCap', v)}
            placeholder="100"
          />
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Watchlist symbols are prioritized. Restart after changing briefing time.
          </p>
        </Advanced>
      </Section>

      <Section title="Location" onSave={onSave} saved={saved} dirty={dirty}>
        <Field
          label="Home address"
          value={settings.homeLocation}
          onChange={(v) => update('homeLocation', v)}
          placeholder="123 Main St, Naperville, IL"
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Neighborhood"
            value={settings.homeNeighborhood}
            onChange={(v) => update('homeNeighborhood', v)}
            placeholder="Lincoln Park"
          />
          <Select
            label="Primary transport"
            value={settings.transportMode}
            onChange={(v) => update('transportMode', v)}
            options={[
              { value: 'driving', label: 'Driving' },
              { value: 'transit', label: 'Public transit' },
              { value: 'rideshare', label: 'Rideshare' },
              { value: 'biking', label: 'Biking' },
              { value: 'mixed', label: 'Mixed' },
            ]}
          />
        </div>
        <Advanced label="Commute notes">
          <Field
            label="Notes"
            value={settings.commuteNotes}
            onChange={(v) => update('commuteNotes', v)}
            placeholder="40 min to downtown by car"
          />
        </Advanced>
      </Section>

      <Section title="Weekend planning" onSave={onSave} saved={saved} dirty={dirty}>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="City"
            value={settings.weekendCity}
            onChange={(v) => update('weekendCity', v)}
            placeholder="Chicago"
          />
          <Field
            label="Radius (mi)"
            value={settings.weekendRadius}
            onChange={(v) => update('weekendRadius', v)}
            placeholder="30"
          />
        </div>
        <Textarea
          label="Interests"
          value={settings.weekendInterests}
          onChange={(v) => update('weekendInterests', v)}
          placeholder="new restaurants, outdoor activities, museums"
          rows={2}
        />
      </Section>

      <Section title="YouTube finance channels" onSave={onSave} saved={saved} dirty={dirty}>
        <Textarea
          label="One per line: Name|ChannelID"
          value={settings.youtubeChannels}
          onChange={(v) => update('youtubeChannels', v)}
          placeholder="Meet Kevin|UCUvvj5lwue7PspotMDjk5UA"
          rows={4}
          mono
        />
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Find a channel ID by viewing the page source and searching for "channelId". No API key
          needed.
        </p>
      </Section>
    </>
  )
}

function DisplayTab({
  settings,
  setSettings,
  onSave,
  saved,
  dirty,
}: {
  settings: SettingsState
  setSettings: React.Dispatch<React.SetStateAction<SettingsState>>
  onSave: () => Promise<void>
  saved: boolean
  dirty: boolean
}) {
  const update = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const handlePalette = (p: PaletteName) => {
    update('chartPalette', p)
    applyChartPalette(p)
  }

  const handleTheme = (t: ThemePreset) => {
    update('themePreset', t)
    applyTheme(t)
    // A preset re-establishes the accent; clear any custom override so it shows.
    update('accentColor', '')
    applyAccent('')
  }

  const handleAccent = (hex: string) => {
    update('accentColor', hex)
    applyAccent(hex)
  }

  const handleMotion = (m: MotionLevel) => {
    update('motionLevel', m)
    applyMotionLevel(m)
  }

  return (
    <>
      <Section title="Appearance" onSave={onSave} saved={saved} dirty={dirty}>
        <Field
          label="Display name (used in your greeting)"
          value={settings.displayName}
          onChange={(v) => update('displayName', v)}
          placeholder="Ian"
        />

        <div>
          <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
            Theme
          </p>
          <div className="flex flex-wrap gap-2">
            {THEME_PRESETS.map((t) => {
              const active = settings.themePreset === t.id && !settings.accentColor
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleTheme(t.id)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid',
                    borderColor: active ? t.swatch : 'var(--separator)',
                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    boxShadow: active ? `0 0 0 2px ${t.swatch}40` : 'none',
                  }}
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full"
                    style={{ background: t.swatch }}
                  />
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
            Custom accent {settings.accentColor ? '' : '(using theme default)'}
          </p>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={settings.accentColor || '#f97316'}
              onChange={(e) => handleAccent(e.target.value)}
              className="w-10 h-9 rounded-lg cursor-pointer bg-transparent"
              style={{ border: '1px solid var(--separator)' }}
              aria-label="Custom accent color"
            />
            {settings.accentColor && (
              <button
                type="button"
                onClick={() => handleAccent('')}
                className="text-xs px-2.5 py-1.5 rounded-lg transition-colors"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
              >
                Reset to theme
              </button>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
            Motion
          </p>
          <ToggleGroup
            options={[
              { value: 'playful', label: 'Playful' },
              { value: 'calm', label: 'Calm' },
            ]}
            value={settings.motionLevel}
            onChange={(v) => handleMotion(v as MotionLevel)}
          />
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
            Calm keeps functional transitions but removes ambient steam and entrance animations.
            Your system "reduce motion" setting is always respected.
          </p>
        </div>
      </Section>

      <Section title="Display" onSave={onSave} saved={saved} dirty={dirty}>
        <div>
          <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
            Chart density
          </p>
          <ToggleGroup
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'spacious', label: 'Spacious' },
            ]}
            value={settings.chartDensity}
            onChange={(v) => update('chartDensity', v as SettingsState['chartDensity'])}
          />
        </div>

        <div>
        <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
          Color palette
        </p>
        <ToggleGroup
          options={[
            { value: 'default', label: 'Default' },
            { value: 'colorblind-deuter', label: 'Deuter' },
            { value: 'colorblind-protan', label: 'Protan' },
            { value: 'highcontrast', label: 'High contrast' },
          ]}
          value={settings.chartPalette}
          onChange={(v) => handlePalette(v as PaletteName)}
        />
      </div>

      <div>
        <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
          Default range
        </p>
        <ToggleGroup
          options={[
            { value: '7d', label: '7D' },
            { value: '30d', label: '30D' },
            { value: '90d', label: '90D' },
            { value: '1y', label: '1Y' },
          ]}
          value={settings.defaultRange}
          onChange={(v) => update('defaultRange', v as SettingsState['defaultRange'])}
        />
      </div>

      <ToggleRow
        label="Cross-domain composites"
        description="Combine sleep, HRV, training load, market stress, and calendar load on the Dashboard."
        value={settings.enableCrossDomainComposites === 'true'}
        onChange={(v) => update('enableCrossDomainComposites', v ? 'true' : 'false')}
      />

      <ToggleRow
        label="Advanced technicals"
        description="MACD, Bollinger Bands, and full indicator subcharts on Finance."
        value={settings.showAdvancedTechnicals === 'true'}
        onChange={(v) => update('showAdvancedTechnicals', v ? 'true' : 'false')}
      />

      <div>
        <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
          UI scale — {Math.round(parseFloat(settings.uiScale || '1.0') * 100)}%
        </p>
        <div className="flex items-center gap-3">
          <button
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            onClick={() => {
              const v = Math.max(0.7, parseFloat(settings.uiScale || '1.0') - 0.05)
              const s = v.toFixed(2)
              update('uiScale', s)
              window.api.setZoomFactor(v)
            }}
          >
            −
          </button>
          <input
            type="range"
            min="0.7"
            max="1.6"
            step="0.05"
            value={settings.uiScale || '1.0'}
            onChange={(e) => {
              update('uiScale', e.target.value)
              window.api.setZoomFactor(parseFloat(e.target.value))
            }}
            className="flex-1"
            style={{ accentColor: 'var(--accent-cyan)' }}
          />
          <button
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            onClick={() => {
              const v = Math.min(1.6, parseFloat(settings.uiScale || '1.0') + 0.05)
              const s = v.toFixed(2)
              update('uiScale', s)
              window.api.setZoomFactor(v)
            }}
          >
            +
          </button>
          <button
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
            onClick={() => {
              update('uiScale', '1.00')
              window.api.setZoomFactor(1.0)
            }}
          >
            Reset
          </button>
        </div>
        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          Scales all text, images, and UI elements. Ctrl+= to zoom in, Ctrl+- to zoom out.
        </p>
      </div>
      </Section>
    </>
  )
}

function ActivityTab() {
  return (
    <>
      <Section title="Diagnostics">
        <DiagnosticsPanel />
      </Section>

      <Section title="Scheduler activity">
        <SchedulerActivityPanel />
      </Section>

      <Section title="AI activity">
        <AiActivityPanel />
      </Section>

      <Section title="Briefing prompt preview">
        <BriefingPromptPreview />
      </Section>

      <Section title="Export to Markdown">
        <MarkdownExportPanel />
      </Section>

      <Section title="Software update">
        <AppUpdatePanel />
      </Section>

      <Section title="About">
        <AboutPanel />
      </Section>
    </>
  )
}

function AboutPanel() {
  const [version, setVersion] = useState<string>('')
  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
  }, [])
  return (
    <>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        <strong style={{ color: 'var(--text-primary)' }}>Mien</strong> — Personal Intelligence
        Dashboard
      </p>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Version {version || '...'} — Data stored locally in SQLite.
      </p>
    </>
  )
}

// ----- Strava -----

function StravaSection({
  settings,
  update,
  onSave,
  saved,
  dirty,
}: {
  settings: SettingsState
  update: (key: keyof SettingsState, value: string) => void
  onSave: () => Promise<void>
  saved: boolean
  dirty: boolean
}) {
  const [status, setStatus] = useState<{ connected: boolean; athlete?: string } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    window.api.stravaStatus().then(setStatus)
  }, [])

  const connect = async () => {
    setConnecting(true)
    setResult(null)
    if (dirty) await onSave()
    const res = await window.api.stravaConnect()
    if (res.success) {
      setStatus({ connected: true, athlete: res.athlete })
      setResult(`Connected as ${res.athlete}`)
    } else {
      setResult(`Error: ${res.error}`)
    }
    setConnecting(false)
    setTimeout(() => setResult(null), 5000)
  }

  const disconnect = async () => {
    await window.api.stravaDisconnect()
    setStatus({ connected: false })
    setResult('Disconnected from Strava')
    setTimeout(() => setResult(null), 3000)
  }

  const sync = async (all = false) => {
    setSyncing(true)
    setResult(null)
    const res = all ? await window.api.stravaSyncAll() : await window.api.stravaSync(DEFAULT_TRAINING_DAYS)
    if (res.error) {
      setResult(`Error: ${res.error}`)
    } else {
      const detail =
        typeof res.enriched === 'number'
          ? `; streams: ${res.enriched}${res.reusedDetailed ? ` new, ${res.reusedDetailed} kept` : ''}; activity details: ${res.activityDetailsFetched ?? 0}`
          : ''
      const pulled =
        typeof res.pulledWorkouts === 'number'
          ? `; pulled ${res.pulledWorkouts} workout days, ${res.pulledStreams ?? 0} streams`
          : ''
      setResult(`Synced ${res.total} activities across ${res.synced} days${detail}${pulled}`)
    }
    setSyncing(false)
    setTimeout(() => setResult(null), 5000)
  }

  return (
    <Section title="Strava" onSave={onSave} saved={saved} dirty={dirty}>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Connects via the relay server. Make sure your relay URL and token are configured in
        Connections above.
      </p>

      <div
        className="rounded-lg p-3 space-y-2"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {status?.connected ? (
                <>
                  <span style={{ color: 'var(--accent-green)' }}>Connected</span>
                  <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>
                    {status.athlete}
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Not connected</span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            {status?.connected ? (
              <>
                <button
                  type="button"
                  onClick={() => sync(false)}
                  disabled={syncing}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--accent-blue)' }}
                >
                  <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                  {syncing ? 'Syncing...' : `Sync ${DEFAULT_TRAINING_DAYS} days`}
                </button>
                <button
                  type="button"
                  onClick={() => sync(true)}
                  disabled={syncing}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--accent-purple)' }}
                >
                  <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                  Sync all
                </button>
                <button
                  type="button"
                  onClick={disconnect}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--accent-red)' }}
                >
                  <Unlink size={12} />
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={connect}
                disabled={connecting}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
                style={{ background: 'var(--accent-orange)', color: 'white' }}
              >
                <Link2 size={12} />
                {connecting ? 'Connecting...' : 'Connect Strava'}
              </button>
            )}
          </div>
        </div>
        {result && (
          <span
            className="text-xs"
            style={{
              color: result.startsWith('Error') ? 'var(--accent-red)' : 'var(--accent-green)',
            }}
          >
            {result}
          </span>
        )}
      </div>
    </Section>
  )
}

// ----- Reusable primitives -----

function SaveButton({
  onClick,
  saved,
  dirty,
}: {
  onClick: () => void
  saved: boolean
  dirty: boolean
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg transition-colors"
      style={{
        background: saved
          ? 'var(--accent-green)'
          : dirty
            ? 'var(--accent-blue)'
            : 'var(--bg-tertiary)',
        color: saved || dirty ? 'white' : 'var(--text-muted)',
      }}
    >
      {saved ? <Check size={14} /> : <Save size={14} />}
      {saved ? 'Saved' : 'Save'}
    </button>
  )
}

function Section({
  title,
  children,
  onSave,
  saved,
  dirty,
}: {
  title: string
  children: React.ReactNode
  onSave?: () => void
  saved?: boolean
  dirty?: boolean
}) {
  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          {title}
        </h3>
        {onSave && (
          <button
            onClick={onSave}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded transition-colors"
            style={{
              background: saved
                ? 'var(--accent-green)'
                : dirty
                  ? 'var(--accent-blue)'
                  : 'transparent',
              color: saved || dirty ? 'white' : 'var(--text-muted)',
            }}
          >
            {saved ? <Check size={11} /> : <Save size={11} />}
            {saved ? 'Saved' : 'Save'}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div>
      <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors"
        style={{
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--separator)',
          color: 'var(--text-primary)',
        }}
      />
    </div>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div>
      <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
        style={{
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--separator)',
          color: 'var(--text-primary)',
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function Textarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  mono,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  mono?: boolean
}) {
  return (
    <div>
      <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={`w-full px-3 py-2.5 rounded-lg text-sm outline-none resize-none ${mono ? 'font-mono' : ''}`}
        style={{
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--separator)',
          color: 'var(--text-primary)',
        }}
      />
    </div>
  )
}

function Advanced({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs transition-colors"
        style={{ color: 'var(--text-muted)' }}
      >
        <ChevronDown
          size={12}
          style={{
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.15s',
          }}
        />
        {label}
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  )
}

// ----- Notion sub-components (unchanged) -----

function NotionDbPicker({
  label,
  hint,
  value,
  databases,
  onChange,
}: {
  label: string
  hint?: string
  value: string
  databases: { id: string; title: string }[]
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return databases
    return databases.filter((d) => d.title.toLowerCase().includes(q))
  }, [databases, query])

  const currentTitle = useMemo(() => {
    if (!value) return null
    const match = databases.find((d) => d.id === value)
    return match?.title || null
  }, [databases, value])

  if (databases.length === 0) {
    return (
      <div>
        <Field
          label={label}
          value={value}
          onChange={onChange}
          placeholder="Database ID (load databases above to pick from a list)"
        />
        {hint && (
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            {hint}
          </p>
        )}
      </div>
    )
  }

  return (
    <div>
      <label className="block text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      {hint && (
        <p className="text-[10px] mb-1.5" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
          {hint}
        </p>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors text-left flex items-center justify-between"
        style={{
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--separator)',
          color: currentTitle ? 'var(--text-primary)' : 'var(--text-muted)',
        }}
      >
        <span className="truncate">
          {currentTitle ? (
            <>
              {currentTitle}{' '}
              <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                ({value.slice(0, 8)}…)
              </span>
            </>
          ) : value ? (
            <span style={{ color: 'var(--text-muted)' }}>
              {value.slice(0, 12)}… (load databases to see name)
            </span>
          ) : (
            'None selected'
          )}
        </span>
        <Search size={12} style={{ color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div
          className="mt-1.5 rounded-lg overflow-hidden"
          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--separator)' }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search databases…"
            className="w-full px-3 py-2 text-sm outline-none"
            style={{
              background: 'transparent',
              color: 'var(--text-primary)',
              borderBottom: '1px solid var(--separator)',
            }}
          />
          <div className="max-h-48 overflow-y-auto">
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                  setQuery('')
                }}
                className="w-full px-3 py-2 text-left text-xs transition-colors hover:bg-white/[0.05]"
                style={{ color: 'var(--text-muted)' }}
              >
                Clear selection
              </button>
            )}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                No matches
              </div>
            )}
            {filtered.map((db) => (
              <button
                key={db.id}
                type="button"
                onClick={() => {
                  onChange(db.id)
                  setOpen(false)
                  setQuery('')
                }}
                className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/[0.05]"
                style={{ color: db.id === value ? 'var(--accent-blue)' : 'var(--text-primary)' }}
              >
                {db.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function NotionDatePropertyPicker({
  label,
  dbId,
  value,
  onChange,
}: {
  label: string
  dbId: string
  value: string
  onChange: (name: string) => void
}) {
  const [dateProps, setDateProps] = useState<{ name: string; type: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDateProps([])
    setError(null)
    if (!dbId) return
    setLoading(true)
    ;(async () => {
      try {
        const props = (await window.api.getNotionDbProperties(dbId)) as Array<{
          name: string
          type: string
        }>
        setDateProps((props || []).filter((p) => p.type === 'date'))
      } catch (err: any) {
        setError(err?.message || 'Failed to load DB properties')
      }
      setLoading(false)
    })()
  }, [dbId])

  if (!dbId) return null

  return (
    <div style={{ marginLeft: 12, paddingLeft: 12, borderLeft: '2px solid var(--separator)' }}>
      <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      {loading && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Loading properties…
        </p>
      )}
      {error && (
        <p className="text-xs" style={{ color: 'var(--accent-red)' }}>
          {error}
        </p>
      )}
      {!loading && !error && dateProps.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No writable date properties.
        </p>
      )}
      {!loading && !error && dateProps.length > 0 && (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg text-sm outline-none"
          style={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--separator)',
            color: 'var(--text-primary)',
          }}
        >
          <option value="">Auto (first match by name)</option>
          {dateProps.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function NotionPullBriefingsButton({ disabled }: { disabled: boolean }) {
  const [pulling, setPulling] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const run = async () => {
    setPulling(true)
    setResult(null)
    try {
      const r = await window.api.pullBriefingsFromNotion(14)
      if (r?.status === 'error') setResult(`Error: ${r.error}`)
      else
        setResult(
          `Pulled ${r.pulled || 0} briefings (${r.created || 0} new, ${r.updated || 0} updated)`,
        )
    } catch (err: any) {
      setResult(`Error: ${err?.message || String(err)}`)
    }
    setPulling(false)
  }

  return (
    <div className="flex items-center justify-between mt-2">
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {result || 'Pull recent briefings (runs daily at 06:00 too).'}
      </span>
      <button
        type="button"
        onClick={run}
        disabled={disabled || pulling}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors disabled:opacity-40"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
      >
        <RefreshCw size={12} className={pulling ? 'animate-spin' : ''} />
        {pulling ? 'Pulling…' : 'Pull from Notion'}
      </button>
    </div>
  )
}

// ----- Activity tab sub-panels (unchanged behavior) -----

interface AiActivityEntry {
  id: number
  timestamp: string
  kind: string
  label: string | null
  model: string
  tokens_in: number | null
  tokens_out: number | null
  cache_read_tokens: number | null
  cache_create_tokens: number | null
  duration_ms: number
  status: string
  error_msg: string | null
}

interface AiActivityStats {
  days: number
  calls: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheCreate: number
  avgMs: number
  errors: number
}

const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5-20250929': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
}

function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheRead = 0,
  cacheCreate = 0,
): number {
  const p = PRICING[model] || { in: 3, out: 15 }
  return (
    (tokensIn / 1_000_000) * p.in +
    (tokensOut / 1_000_000) * p.out +
    (cacheRead / 1_000_000) * p.in * 0.1 +
    (cacheCreate / 1_000_000) * p.in * 1.25
  )
}

interface SchedulerActivityEntry {
  id: number
  job_name: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'ok' | 'error' | null
  error_text: string | null
  duration_ms: number | null
}

function SchedulerActivityPanel() {
  const [log, setLog] = useState<SchedulerActivityEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const entries = await window.api.getSchedulerActivity(50)
      setLog((entries as SchedulerActivityEntry[]) || [])
    } catch (err) {
      console.error('Failed to load scheduler activity:', err)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const recentErrors = log.filter((e) => e.status === 'error').length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Last {log.length} job runs
          {recentErrors > 0 ? ` · ${recentErrors} error${recentErrors === 1 ? '' : 's'}` : ''}
        </span>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs px-2.5 py-1 rounded transition-colors"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
        >
          Refresh
        </button>
      </div>

      {log.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No scheduler runs recorded yet.
        </p>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead
                className="sticky top-0"
                style={{
                  background: 'var(--bg-tertiary)',
                  borderBottom: '1px solid var(--separator)',
                }}
              >
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left px-2 py-1.5 font-normal">When</th>
                  <th className="text-left px-2 py-1.5 font-normal">Job</th>
                  <th className="text-left px-2 py-1.5 font-normal">Status</th>
                  <th className="text-right px-2 py-1.5 font-normal">ms</th>
                  <th className="text-left px-2 py-1.5 font-normal">Error</th>
                </tr>
              </thead>
              <tbody>
                {log.map((e) => {
                  const isError = e.status === 'error'
                  const isRunning = e.status === 'running'
                  const statusColor = isError
                    ? 'var(--accent-red)'
                    : isRunning
                      ? 'var(--accent-blue)'
                      : 'var(--text-secondary)'
                  return (
                    <tr key={e.id} style={{ borderBottom: '1px solid var(--separator)' }}>
                      <td className="px-2 py-1.5" style={{ color: 'var(--text-muted)' }}>
                        {new Date(e.started_at + 'Z').toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-2 py-1.5" style={{ color: 'var(--text-primary)' }}>
                        {e.job_name}
                      </td>
                      <td className="px-2 py-1.5" style={{ color: statusColor }}>
                        {e.status || '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                        {e.duration_ms ?? '—'}
                      </td>
                      <td
                        className="px-2 py-1.5 truncate max-w-[260px]"
                        style={{ color: 'var(--accent-red)' }}
                        title={e.error_text || ''}
                      >
                        {e.error_text || ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function AiActivityPanel() {
  const [log, setLog] = useState<AiActivityEntry[]>([])
  const [stats, setStats] = useState<AiActivityStats | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [entries, s] = await Promise.all([
        window.api.getAiActivityLog(50) as Promise<AiActivityEntry[]>,
        window.api.getAiActivityStats(30) as Promise<AiActivityStats>,
      ])
      setLog(entries || [])
      setStats(s)
    } catch (err) {
      console.error('Failed to load AI activity:', err)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const handleClear = async () => {
    if (!confirm('Clear all AI activity history? Local data, no recovery.')) return
    await window.api.clearAiActivityLog()
    load()
  }

  const totalCost = useMemo(() => {
    return log.reduce((sum, e) => {
      if (!e.tokens_in && !e.tokens_out && !e.cache_read_tokens && !e.cache_create_tokens)
        return sum
      return (
        sum +
        estimateCost(
          e.model,
          e.tokens_in || 0,
          e.tokens_out || 0,
          e.cache_read_tokens || 0,
          e.cache_create_tokens || 0,
        )
      )
    }, 0)
  }, [log])

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-tertiary)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Calls (30d)</div>
          <div className="text-sm font-medium mt-0.5" style={{ color: 'var(--text-primary)' }}>
            {stats?.calls ?? 0}
          </div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-tertiary)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Tokens (30d)</div>
          <div className="text-sm font-medium mt-0.5" style={{ color: 'var(--text-primary)' }}>
            {((stats?.tokensIn ?? 0) + (stats?.tokensOut ?? 0)).toLocaleString()}
          </div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-tertiary)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Avg latency</div>
          <div className="text-sm font-medium mt-0.5" style={{ color: 'var(--text-primary)' }}>
            {Math.round(stats?.avgMs ?? 0)}ms
          </div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-tertiary)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Errors</div>
          <div
            className="text-sm font-medium mt-0.5"
            style={{ color: stats?.errors ? 'var(--accent-red)' : 'var(--text-primary)' }}
          >
            {stats?.errors ?? 0}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Last {log.length} calls · Est. cost ${totalCost.toFixed(3)}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="text-xs px-2.5 py-1 rounded transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
          >
            Refresh
          </button>
          <button
            onClick={handleClear}
            className="text-xs px-2.5 py-1 rounded transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-red)' }}
          >
            Clear log
          </button>
        </div>
      </div>

      {log.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No AI calls recorded yet.
        </p>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead
                className="sticky top-0"
                style={{
                  background: 'var(--bg-tertiary)',
                  borderBottom: '1px solid var(--separator)',
                }}
              >
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left px-2 py-1.5 font-normal">When</th>
                  <th className="text-left px-2 py-1.5 font-normal">Kind</th>
                  <th className="text-left px-2 py-1.5 font-normal">Label</th>
                  <th className="text-right px-2 py-1.5 font-normal">In</th>
                  <th className="text-right px-2 py-1.5 font-normal">Out</th>
                  <th
                    className="text-right px-2 py-1.5 font-normal"
                    title="Prompt cache: read / write"
                  >
                    Cache R/W
                  </th>
                  <th className="text-right px-2 py-1.5 font-normal">ms</th>
                  <th className="text-left px-2 py-1.5 font-normal">Error</th>
                </tr>
              </thead>
              <tbody>
                {log.map((e) => (
                  <tr key={e.id} style={{ borderBottom: '1px solid var(--separator)' }}>
                    <td className="px-2 py-1.5" style={{ color: 'var(--text-muted)' }}>
                      {new Date(e.timestamp + 'Z').toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td
                      className="px-2 py-1.5"
                      style={{
                        color: e.status === 'error' ? 'var(--accent-red)' : 'var(--text-secondary)',
                      }}
                    >
                      {e.kind}
                    </td>
                    <td
                      className="px-2 py-1.5 truncate max-w-[200px]"
                      style={{ color: 'var(--text-primary)' }}
                      title={e.label || ''}
                    >
                      {e.label || '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                      {e.tokens_in ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                      {e.tokens_out ?? '—'}
                    </td>
                    <td
                      className="px-2 py-1.5 text-right"
                      style={{
                        color: e.cache_read_tokens ? 'var(--accent-blue)' : 'var(--text-muted)',
                      }}
                    >
                      {e.cache_read_tokens || e.cache_create_tokens
                        ? `${e.cache_read_tokens ?? 0}/${e.cache_create_tokens ?? 0}`
                        : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                      {e.duration_ms}
                    </td>
                    <td
                      className="px-2 py-1.5 truncate max-w-[200px]"
                      style={{ color: 'var(--accent-red)' }}
                      title={e.error_msg || ''}
                    >
                      {e.error_msg || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

interface PromptPreview {
  system: string
  user: string
  chars: number
  estTokens: number
}

function BriefingPromptPreview() {
  const [type, setType] = useState<string>('morning_finance')
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    setPreview(null)
    try {
      const result = (await window.api.previewBriefing(type)) as PromptPreview
      setPreview(result)
    } catch (err: any) {
      setError(err?.message || 'Failed to build preview')
    }
    setLoading(false)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        See what would be sent to Claude before running a briefing. No tokens used.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="px-3 py-2 rounded-lg text-sm outline-none"
          style={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--separator)',
            color: 'var(--text-primary)',
          }}
        >
          <option value="morning_finance">morning_finance</option>
          <option value="market_research">market_research</option>
          <option value="health_weekly">health_weekly</option>
          <option value="morning_sleep">morning_sleep</option>
        </select>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded transition-colors"
          style={{ background: 'var(--accent-blue)', color: 'white' }}
        >
          {loading ? 'Building…' : 'Preview prompt'}
        </button>
      </div>
      {error && (
        <p className="text-xs" style={{ color: 'var(--accent-red)' }}>
          {error}
        </p>
      )}
      {preview && (
        <div className="space-y-2">
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {preview.chars.toLocaleString()} chars · ~{preview.estTokens.toLocaleString()} tokens
          </div>
          <details className="rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <summary
              className="px-3 py-2 cursor-pointer text-xs font-medium"
              style={{ color: 'var(--text-primary)' }}
            >
              System prompt ({preview.system.length} chars)
            </summary>
            <pre
              className="px-3 py-2 text-[11px] overflow-x-auto whitespace-pre-wrap"
              style={{ color: 'var(--text-secondary)' }}
            >
              {preview.system}
            </pre>
          </details>
          <details open className="rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <summary
              className="px-3 py-2 cursor-pointer text-xs font-medium"
              style={{ color: 'var(--text-primary)' }}
            >
              User prompt ({preview.user.length} chars)
            </summary>
            <pre
              className="px-3 py-2 text-[11px] overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto"
              style={{ color: 'var(--text-secondary)' }}
            >
              {preview.user}
            </pre>
          </details>
        </div>
      )}
    </div>
  )
}

interface ExportResult {
  ok: boolean
  folder: string
  files: number
  bytes: number
  byTable: Record<string, number>
  error?: string
}

function MarkdownExportPanel() {
  const [folder, setFolder] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ExportResult | null>(null)

  const pick = async () => {
    try {
      const f = (await window.api.pickFolder()) as string | null
      if (f) setFolder(f)
    } catch (err) {
      console.error('Folder pick failed:', err)
    }
  }

  const run = async () => {
    if (!folder) return
    setRunning(true)
    setResult(null)
    try {
      const r = (await window.api.exportMarkdown(folder)) as ExportResult
      setResult(r)
    } catch (err: any) {
      setResult({
        ok: false,
        folder,
        files: 0,
        bytes: 0,
        byTable: {},
        error: err?.message || 'Export failed',
      })
    }
    setRunning(false)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Briefings, schedules, weekend plans, and chat history as Markdown — opens in Obsidian or any
        editor.
      </p>

      <div className="flex items-center gap-2">
        <input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="Pick a folder…"
          className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
          style={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--separator)',
            color: 'var(--text-primary)',
          }}
        />
        <button
          onClick={pick}
          className="text-xs px-3 py-1.5 rounded transition-colors"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
        >
          Browse…
        </button>
        <button
          onClick={run}
          disabled={!folder || running}
          className="text-xs px-3 py-1.5 rounded transition-colors disabled:opacity-40"
          style={{ background: 'var(--accent-blue)', color: 'white' }}
        >
          {running ? 'Exporting…' : 'Export'}
        </button>
      </div>

      {result && (
        <div
          className="rounded-lg p-3 text-xs"
          style={{
            background: result.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            color: result.ok ? 'var(--accent-green)' : 'var(--accent-red)',
          }}
        >
          {result.ok ? (
            <>
              <div className="font-medium mb-1">
                Exported {result.files} files ({(result.bytes / 1024).toFixed(1)} KB) to{' '}
                {result.folder}
              </div>
              <ul className="space-y-0.5 ml-1">
                {Object.entries(result.byTable).map(([t, n]) => (
                  <li key={t}>
                    • {t}: {n} records
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div>Failed: {result.error}</div>
          )}
        </div>
      )}
    </div>
  )
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div
      className="inline-flex rounded-md overflow-hidden"
      style={{ background: 'var(--bg-tertiary)' }}
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className="px-3 py-1.5 text-xs font-medium transition-colors"
            style={{
              background: active ? 'var(--accent-blue)' : 'transparent',
              color: active ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string
  description?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button
        type="button"
        onClick={() => onChange(!value)}
        className="shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors relative"
        style={{ background: value ? 'var(--accent-green)' : 'var(--bg-tertiary)' }}
      >
        <span
          className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
          style={{ left: value ? 'calc(100% - 18px)' : '2px' }}
        />
      </button>
      <div className="flex-1">
        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {label}
        </p>
        {description && (
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {description}
          </p>
        )}
      </div>
    </label>
  )
}

function DiagnosticsPanel() {
  const cacheQ = useAiCacheStats(30)
  const relayQ = useRelayStats()
  const schedulerQ = useSchedulerSuccessRate(30)

  const cache = cacheQ.data as {
    hitRatePct: number
    cacheReadTokens: number
    cacheCreateTokens: number
    calls: number
    lookbackDays: number
  } | null
  const relay = relayQ.data as {
    lastSyncedAt: string | null
    lastStatus: string | null
    okCount7d: number
    errorCount7d: number
  } | null
  const scheduler =
    (schedulerQ.data as Array<{
      jobName: string
      successRatePct: number
      okCount: number
      errorCount: number
      avgDurationMs: number | null
      lastRun: string | null
    }>) || []

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <ChartCard
          title="Prompt-cache hit rate"
          subtitle={`Last ${cache?.lookbackDays ?? 30} days · ${cache?.calls ?? 0} calls`}
          lastUpdated={cacheQ.lastUpdated}
          loading={cacheQ.loading}
          onRefresh={cacheQ.refresh}
        >
          <div className="flex items-center justify-around">
            <RadialGauge
              value={cache?.hitRatePct ?? 0}
              min={0}
              max={100}
              label="Hit rate"
              unit="%"
              size={140}
              thresholds={[
                { at: 0, color: 'var(--accent-red)' },
                { at: 25, color: 'var(--accent-amber)' },
                { at: 50, color: 'var(--accent-green)' },
              ]}
            />
            <div className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Cache reads:</span>{' '}
                {(cache?.cacheReadTokens ?? 0).toLocaleString()}
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Cache writes:</span>{' '}
                {(cache?.cacheCreateTokens ?? 0).toLocaleString()}
              </div>
            </div>
          </div>
        </ChartCard>

        <ChartCard
          title="Relay sync"
          subtitle="Last 7 days"
          lastUpdated={relayQ.lastUpdated}
          loading={relayQ.loading}
          onRefresh={relayQ.refresh}
        >
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>Last sync:</span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {relay?.lastSyncedAt || 'never'}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>Last status:</span>
              <span
                style={{
                  color:
                    relay?.lastStatus === 'ok' ? 'var(--accent-green)' : 'var(--text-secondary)',
                }}
              >
                {relay?.lastStatus || '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>OK / err (7d):</span>
              <span style={{ color: 'var(--text-secondary)' }}>
                <span style={{ color: 'var(--accent-green)' }}>{relay?.okCount7d ?? 0}</span>
                {' / '}
                <span style={{ color: 'var(--accent-red)' }}>{relay?.errorCount7d ?? 0}</span>
              </span>
            </div>
            {relay && (
              <div className="pt-1">
                <TrendBadge
                  data={[relay.errorCount7d || 0, relay.okCount7d || 0]}
                  unit=""
                  higherIsBetter
                  compact
                />
              </div>
            )}
          </div>
        </ChartCard>
      </div>

      <ChartCard
        title="Scheduler success"
        subtitle="Per-job success rate over 30 days"
        lastUpdated={schedulerQ.lastUpdated}
        loading={schedulerQ.loading}
        onRefresh={schedulerQ.refresh}
      >
        {scheduler.length === 0 ? (
          <div className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
            No scheduler runs in the last 30 days.
          </div>
        ) : (
          <div className="space-y-2">
            {scheduler.map((job) => {
              const trend = [job.errorCount, job.okCount]
              const successColor =
                job.successRatePct >= 90
                  ? 'var(--accent-green)'
                  : job.successRatePct >= 75
                    ? 'var(--accent-amber)'
                    : 'var(--accent-red)'
              return (
                <div key={job.jobName} className="flex items-center gap-3">
                  <div
                    className="w-44 text-xs font-mono truncate"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {job.jobName}
                  </div>
                  <div
                    className="text-xs tabular-nums w-12 text-right"
                    style={{ color: successColor }}
                  >
                    {job.successRatePct.toFixed(0)}%
                  </div>
                  <div className="flex-1">
                    <SparklineRow data={trend} strokeColor={successColor} height={20} fillBelow />
                  </div>
                  <div
                    className="text-xs tabular-nums w-16 text-right"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {job.avgDurationMs != null ? `${Math.round(job.avgDurationMs)}ms` : '—'}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </ChartCard>
    </div>
  )
}

function AppUpdatePanel() {
  const [status, setStatus] = useState<
    'idle' | 'checking' | 'up-to-date' | 'ready' | 'applying' | 'error'
  >('idle')
  const [version, setVersion] = useState('')
  const [info, setInfo] = useState<{
    fileCount?: number
    timestamp?: number
    error?: string
    commitHash?: string
    commitMessage?: string
    commitDate?: string
    localCommit?: string
    appliedRelayCommit?: string | null
    upToDate?: boolean
    source?: string
    canApply?: boolean
    changedCount?: number
    deletedCount?: number
    packageVersion?: string
    mobileVersion?: string
  } | null>(null)

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
  }, [])

  async function check() {
    setStatus('checking')
    setInfo(null)
    const result = await window.api.checkUpdate()
    if (result?.error) {
      setInfo({ error: result.error })
      setStatus('error')
    } else if (result?.upToDate) {
      setInfo(result)
      setStatus('up-to-date')
    } else {
      setInfo(result)
      setStatus('ready')
    }
  }

  async function apply() {
    setStatus('applying')
    const result = await window.api.applyUpdate()
    if (result?.error) {
      setInfo({ error: result.error })
      setStatus('error')
    }
    // On success the app quits — no need to handle
  }

  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Current version:{' '}
        <strong style={{ color: 'var(--text-secondary)' }}>{version || '...'}</strong>
        {info?.localCommit ? <span> ({info.localCommit.slice(0, 7)})</span> : null}
        {info?.source ? <span> - updates from {info.source}</span> : null}
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={check}
          disabled={status === 'checking' || status === 'applying'}
          className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
        >
          <RefreshCw size={14} className={status === 'checking' ? 'animate-spin' : ''} />
          {status === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>

        {(status === 'ready' || status === 'applying') && info && info.canApply !== false && (
          <button
            onClick={apply}
            disabled={status === 'applying'}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            style={{ background: 'var(--accent-blue)', color: 'white' }}
          >
            {status === 'applying' ? 'Applying…' : `Update now (${info.fileCount} files)`}
          </button>
        )}
      </div>

      {status === 'up-to-date' && (
        <p className="text-xs" style={{ color: 'var(--accent-green)' }}>
          You're up to date.
          {info?.commitHash ? ` (${info.commitHash.slice(0, 7)})` : ''}
        </p>
      )}
      {status === 'ready' && info && (
        <div className="text-xs space-y-1">
          <p style={{ color: 'var(--accent-blue)' }}>Update available — {info.fileCount} files</p>
          {info.commitMessage && (
            <p style={{ color: 'var(--text-secondary)' }}>
              Latest: {info.commitMessage}
              {info.commitHash ? ` (${info.commitHash.slice(0, 7)})` : ''}
              {info.changedCount !== undefined
                ? ` - ${info.changedCount} changed, ${info.deletedCount || 0} deleted`
                : ''}
            </p>
          )}
          {info.canApply === false && (
            <p style={{ color: 'var(--accent-amber)' }}>
              Packaged installs need a rebuilt installer. Source checkouts can apply this from the
              app.
            </p>
          )}
        </div>
      )}
      {status === 'error' && info?.error && (
        <p className="text-xs" style={{ color: 'var(--accent-red)' }}>
          {info.error}
        </p>
      )}
    </div>
  )
}
