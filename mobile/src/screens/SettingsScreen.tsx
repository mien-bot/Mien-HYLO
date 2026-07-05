import React, { useState, useEffect, useMemo } from 'react'
import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, radius, THEME_PRESETS, type MotionLevel } from '../lib/theme'
import { useTheme } from '../lib/ThemeContext'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getSettings, saveSettings, setSecure } from '../lib/storage'
import { cleanupBadData, seamlessSyncFromRelay } from '../services/health-sync.service'
import { scheduleSleepNotifications, cancelSleepNotifications } from '../services/sleep-notifications.service'
import { listDatabases, getDbProperties, type NotionDatabase } from '../services/notion.service'

export default function SettingsScreen() {
  const [settings, setSettings] = useState({
    relayUrl: '',
    relayToken: '',
    claudeApiKey: '',
    aiModel: 'claude-sonnet-4-6',
    alphaVantageKey: '',
    ticketmasterKey: '',
    googlePlacesKey: '',
    notionKey: '',
    notionTasksDbId: '',
    notionCalendarDbId: '',
    notionCalendarDateProperty: '',
    homeNeighborhood: '',
    homeLocation: '',
    commuteNotes: '',
    transportMode: 'driving',
    weekendCity: '',
    weekendRadius: '30',
    weekendInterests: '',
    sleepGoalHours: '8.0',
    windDownMinutesBefore: '120',
    enableWindDownNotifications: 'true',
    opusMode: 'false',
    userAge: '',
    userWeight: '',
    lactateThresholdHR: '',
    ftp: '',
    activityIgnorePatterns: '',
    notionBriefingsDbId: '',
    themePreset: 'ramen',
    accentColor: '',
    motionLevel: 'playful',
    displayName: '',
  })
  const [relayStatus, setRelayStatus] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [notionDbs, setNotionDbs] = useState<NotionDatabase[]>([])
  const [loadingDbs, setLoadingDbs] = useState(false)
  const [dbsError, setDbsError] = useState<string | null>(null)

  const loadNotionDbs = async () => {
    setLoadingDbs(true)
    setDbsError(null)
    try {
      const dbs = await listDatabases()
      setNotionDbs(dbs)
    } catch (err: any) {
      setDbsError(err?.message || 'Failed to list Notion databases')
    }
    setLoadingDbs(false)
  }

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(prev => ({ ...prev, ...s }))
    })
  }, [])

  const handleSave = async () => {
    await saveSettings(settings)
    if (settings.claudeApiKey) {
      await setSecure('claudeApiKey', settings.claudeApiKey)
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const update = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  const theme = useTheme()

  const insets = useSafeAreaInsets()

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl * 2 }}
    >
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appearance</Text>
        <Field
          label="Display name (used in your greeting)"
          value={settings.displayName}
          onChange={(v) => {
            update('displayName', v)
            theme.setDisplayName(v)
          }}
          placeholder="Ian"
        />
        <Text style={styles.fieldLabel}>Theme</Text>
        <View style={styles.swatchRow}>
          {THEME_PRESETS.map((p) => {
            const active = theme.preset === p.id && !theme.customAccent
            return (
              <TouchableOpacity
                key={p.id}
                onPress={() => {
                  theme.setPreset(p.id)
                  update('themePreset', p.id)
                  update('accentColor', '')
                }}
                style={[
                  styles.swatchChip,
                  { borderColor: active ? p.accent : colors.separator },
                  active && { backgroundColor: p.accent + '22' },
                ]}
              >
                <View style={[styles.swatchDot, { backgroundColor: p.accent }]} />
                <Text style={[styles.swatchLabel, { color: active ? colors.text.primary : colors.text.secondary }]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
        <Text style={styles.fieldLabel}>Motion</Text>
        <View style={styles.segmentRow}>
          {(['playful', 'calm'] as MotionLevel[]).map((m) => {
            const active = theme.motionLevel === m
            return (
              <TouchableOpacity
                key={m}
                onPress={() => {
                  theme.setMotionLevel(m)
                  update('motionLevel', m)
                }}
                style={[
                  styles.segment,
                  { backgroundColor: active ? theme.accent : colors.bg.tertiary },
                ]}
              >
                <Text
                  style={{
                    color: active ? '#fff' : colors.text.secondary,
                    fontSize: 13,
                    fontWeight: '600',
                    textTransform: 'capitalize',
                  }}
                >
                  {m}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>AI Connection</Text>
        <Field
          label="Relay Server URL"
          value={settings.relayUrl}
          onChange={(v) => update('relayUrl', v)}
          placeholder="http://192.168.1.50:3456 or https://xxx.trycloudflare.com"
        />
        <Field
          label="Relay Token"
          value={settings.relayToken}
          onChange={(v) => update('relayToken', v)}
          placeholder="From relay.key on the server"
          secure
        />
        {settings.relayUrl ? (
          <TouchableOpacity style={styles.testBtn} onPress={async () => {
            setRelayStatus('Connecting...')
            try {
              const headers: Record<string, string> = {}
              if (settings.relayToken) {
                headers['Authorization'] = `Bearer ${settings.relayToken}`
              }
              const res = await fetch(`${settings.relayUrl.replace(/\/$/, '')}/health`, { headers })
              if (!res.ok) {
                setRelayStatus(`Failed: ${res.status} ${res.statusText}`)
                return
              }
              const data = await res.json()
              setRelayStatus(`Connected — ${data.provider || 'relay'} (${data.status || 'ok'})`)
            } catch (err: any) {
              setRelayStatus(`Failed: ${err.message}`)
            }
          }}>
            <Text style={styles.testBtnText}>Test Connection</Text>
          </TouchableOpacity>
        ) : null}
        {relayStatus ? (
          <Text style={[styles.statusText, {
            color: relayStatus.startsWith('Connected') ? colors.accent.green : colors.accent.red
          }]}>{relayStatus}</Text>
        ) : null}
        <Text style={styles.hint}>
          Run the relay server on any computer.{'\n'}
          First run generates a token (relay.key).{'\n'}
          For remote: TUNNEL=1 node server.js
        </Text>
        {settings.relayUrl ? (
          <>
            <TouchableOpacity
              style={[styles.testBtn, syncing && { opacity: 0.5 }]}
              onPress={async () => {
                if (syncing) return
                setSyncing(true)
                setSyncStatus('Syncing all data...')
                try {
                  const result = await seamlessSyncFromRelay({ forceFull: true })
                  if (result.success) {
                    const details = Object.entries(result.full?.tables || {})
                      .filter(([, n]) => n > 0)
                      .map(([t, n]) => `${t}: ${n}`)
                      .join(', ')
                    setSyncStatus(details ? `Synced: ${details}` : 'Up to date')
                  } else {
                    setSyncStatus(`Failed: ${result.error}`)
                  }
                } catch (err: any) {
                  setSyncStatus(`Error: ${err.message}`)
                } finally {
                  setSyncing(false)
                }
              }}
              disabled={syncing}
            >
              <Text style={styles.testBtnText}>
                {syncing ? 'Syncing...' : 'Sync All Data from Desktop'}
              </Text>
            </TouchableOpacity>
            {syncStatus ? (
              <Text style={[styles.statusText, {
                color: syncStatus.startsWith('Synced') || syncStatus === 'Up to date'
                  ? colors.accent.green : syncStatus.startsWith('Failed') || syncStatus.startsWith('Error')
                  ? colors.accent.red : colors.text.muted
              }]}>{syncStatus}</Text>
            ) : null}
          </>
        ) : null}
        <View style={styles.divider} />
        <Text style={styles.fieldLabel}>Model</Text>
        <View style={styles.modelRow}>
          {(['false', 'true'] as const).map(val => (
            <TouchableOpacity
              key={val}
              style={[styles.modelBtn, settings.opusMode === val && styles.modelBtnActive]}
              onPress={() => update('opusMode', val)}
            >
              <Text style={[styles.modelBtnText, settings.opusMode === val && styles.modelBtnTextActive]}>
                {val === 'false' ? 'Sonnet (faster, cheaper)' : 'Opus (deeper reasoning)'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.hint}>
          Opus uses Claude Opus 4.6 for richer analysis. Sonnet is faster and cheaper for everyday use.
        </Text>
        <View style={styles.divider} />
        <Field
          label="Claude API Key (direct mode, optional)"
          value={settings.claudeApiKey}
          onChange={(v) => update('claudeApiKey', v)}
          placeholder="sk-ant-... (not needed if using relay)"
          secure
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>API Keys</Text>
        <Field
          label="Alpha Vantage (stocks/finance)"
          value={settings.alphaVantageKey}
          onChange={(v) => update('alphaVantageKey', v)}
          placeholder="Free at alphavantage.co/support"
          secure
        />
        <Field
          label="Ticketmaster (weekend events)"
          value={settings.ticketmasterKey}
          onChange={(v) => update('ticketmasterKey', v)}
          placeholder="Free at developer.ticketmaster.com"
          secure
        />
        <Field
          label="Google Places (restaurants)"
          value={settings.googlePlacesKey}
          onChange={(v) => update('googlePlacesKey', v)}
          placeholder="Free at console.cloud.google.com"
          secure
        />
        <Field
          label="Notion Integration Token"
          value={settings.notionKey}
          onChange={(v) => update('notionKey', v)}
          placeholder="ntn_..."
          secure
        />
        <View style={styles.notionDbHeader}>
          <Text style={styles.notionDbHint}>
            {notionDbs.length > 0
              ? `${notionDbs.length} database${notionDbs.length === 1 ? '' : 's'} found`
              : 'Load databases from your integration'}
          </Text>
          <TouchableOpacity
            onPress={loadNotionDbs}
            disabled={loadingDbs || !settings.notionKey}
            style={[styles.notionDbBtn, (loadingDbs || !settings.notionKey) && { opacity: 0.4 }]}
          >
            {loadingDbs
              ? <NoodleSpinner size={14} color={colors.accent.blue} />
              : <Ionicons name="refresh" size={12} color={colors.accent.blue} />}
            <Text style={styles.notionDbBtnText}>
              {notionDbs.length > 0 ? 'Refresh' : 'Load databases'}
            </Text>
          </TouchableOpacity>
        </View>
        {dbsError && (
          <Text style={[styles.notionDbError]}>{dbsError}</Text>
        )}
        <NotionDbPicker
          label="Tasks Database"
          value={settings.notionTasksDbId}
          databases={notionDbs}
          onChange={(v) => update('notionTasksDbId', v)}
        />
        <NotionDbPicker
          label="Briefings Database"
          value={settings.notionBriefingsDbId}
          databases={notionDbs}
          onChange={(v) => update('notionBriefingsDbId', v)}
        />
        <NotionDbPicker
          label="Calendar Database"
          value={settings.notionCalendarDbId}
          databases={notionDbs}
          onChange={(v) => {
            update('notionCalendarDbId', v)
            update('notionCalendarDateProperty', '')
          }}
        />
        <NotionDatePropertyPicker
          label="Calendar Date Property"
          dbId={settings.notionCalendarDbId}
          value={settings.notionCalendarDateProperty}
          onChange={(v) => update('notionCalendarDateProperty', v)}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sleep & Notifications</Text>
        <Field
          label="Sleep Goal (hours)"
          value={settings.sleepGoalHours}
          onChange={(v) => update('sleepGoalHours', v)}
          placeholder="8.0"
          keyboardType="numeric"
        />
        <Field
          label="Wind-Down Lead Time (minutes before bed)"
          value={settings.windDownMinutesBefore}
          onChange={(v) => update('windDownMinutesBefore', v)}
          placeholder="120"
          keyboardType="numeric"
        />
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Wind-Down Reminders</Text>
          <View style={styles.modelRow}>
            {(['true', 'false'] as const).map(val => (
              <TouchableOpacity
                key={val}
                style={[styles.modelBtn, settings.enableWindDownNotifications === val && styles.modelBtnActive]}
                onPress={async () => {
                  update('enableWindDownNotifications', val)
                  if (val === 'true') {
                    await scheduleSleepNotifications()
                    Alert.alert('Enabled', 'Wind-down notifications scheduled based on your sleep data.')
                  } else {
                    await cancelSleepNotifications()
                    Alert.alert('Disabled', 'Wind-down notifications cancelled.')
                  }
                }}
              >
                <Text style={[styles.modelBtnText, settings.enableWindDownNotifications === val && styles.modelBtnTextActive]}>
                  {val === 'true' ? 'Enabled' : 'Disabled'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.hint}>
            Daily reminders to dim lights, stop screens, shower, and go to bed — timed to your circadian rhythm.
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Profile</Text>
        <Field
          label="Age"
          value={settings.userAge}
          onChange={(v) => update('userAge', v)}
          placeholder="33"
          keyboardType="numeric"
        />
        <Field
          label="Weight (lbs)"
          value={settings.userWeight}
          onChange={(v) => update('userWeight', v)}
          placeholder="160"
          keyboardType="numeric"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Location</Text>
        <Field
          label="Neighborhood"
          value={settings.homeNeighborhood}
          onChange={(v) => update('homeNeighborhood', v)}
          placeholder="e.g. Naperville, Lincoln Park"
        />
        <Field
          label="Home Address"
          value={settings.homeLocation}
          onChange={(v) => update('homeLocation', v)}
          placeholder="123 Main St, Naperville, IL"
        />
        <Field
          label="Commute Notes"
          value={settings.commuteNotes}
          onChange={(v) => update('commuteNotes', v)}
          placeholder="e.g. 40 min to downtown"
        />
        <Text style={styles.fieldLabel}>Transport Mode</Text>
        <View style={styles.modelRow}>
          {(['driving', 'transit', 'biking', 'walking'] as const).map(mode => (
            <TouchableOpacity
              key={mode}
              style={[styles.modelBtn, (settings.transportMode || 'driving') === mode && styles.modelBtnActive]}
              onPress={() => update('transportMode', mode)}
            >
              <Text style={[styles.modelBtnText, (settings.transportMode || 'driving') === mode && styles.modelBtnTextActive]}>
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Field
          label="City"
          value={settings.weekendCity}
          onChange={(v) => update('weekendCity', v)}
          placeholder="Chicago"
        />
        <Field
          label="Weekend Radius (miles)"
          value={settings.weekendRadius}
          onChange={(v) => update('weekendRadius', v)}
          placeholder="30"
          keyboardType="numeric"
        />
        <Field
          label="Weekend Interests"
          value={settings.weekendInterests}
          onChange={(v) => update('weekendInterests', v)}
          placeholder="e.g. food, music, hiking, art"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Fitness Profile</Text>
        <Field
          label="Lactate Threshold HR (LTHR)"
          value={settings.lactateThresholdHR}
          onChange={(v) => update('lactateThresholdHR', v)}
          placeholder="e.g. 170"
          keyboardType="numeric"
        />
        <Field
          label="FTP (watts)"
          value={settings.ftp}
          onChange={(v) => update('ftp', v)}
          placeholder="e.g. 250"
          keyboardType="numeric"
        />
        <Field
          label="Activity Ignore Patterns"
          value={settings.activityIgnorePatterns}
          onChange={(v) => update('activityIgnorePatterns', v)}
          placeholder="e.g. commute, walk to lunch"
        />
        <Text style={styles.hint}>
          LTHR normalizes heart rate stress scores. FTP sets power zones. Ignore patterns filter activities from fitness trends by name.
        </Text>
      </View>

      <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
        <Text style={styles.saveText}>{saved ? 'Saved!' : 'Save Settings'}</Text>
      </TouchableOpacity>

      <AppUpdatePanel relayUrl={settings.relayUrl} relayToken={settings.relayToken} />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <TouchableOpacity
          onLongPress={() => {
            Alert.alert(
              'Clean Bad Health Data',
              'This removes outlier records (HRV >300ms, SpO2 >100%, HR=0, invalid sleep) from both the server and local database.\n\nThis cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Clean Data',
                  style: 'destructive',
                  onPress: async () => {
                    const result = await cleanupBadData()
                    if (result.success) {
                      const total = (result.relayRemoved || 0) + (result.localRemoved || 0)
                      Alert.alert('Cleanup Complete', total > 0
                        ? `Removed ${result.relayRemoved || 0} server + ${result.localRemoved || 0} local bad records`
                        : 'No bad data found')
                    } else {
                      Alert.alert('Cleanup Failed', result.error || 'Unknown error')
                    }
                  },
                },
              ]
            )
          }}
          delayLongPress={1500}
          activeOpacity={1}
        >
          <Text style={styles.aboutText}>
            Mien — Personal Intelligence Dashboard{'\n'}
            Version 1.8.0
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  )
}

function AppUpdatePanel({ relayUrl, relayToken }: { relayUrl: string; relayToken: string }) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error'>('idle')
  const [info, setInfo] = useState<{
    commitHash?: string; commitMessage?: string; commitDate?: string; error?: string
  } | null>(null)

  // Hardcoded at build time — update this when you rebuild the app
  const BUILD_COMMIT = '__DEV__'

  async function check() {
    if (!relayUrl) {
      setInfo({ error: 'No relay URL configured.' })
      setStatus('error')
      return
    }
    setStatus('checking')
    setInfo(null)
    try {
      const headers: Record<string, string> = {}
      if (relayToken) headers['Authorization'] = `Bearer ${relayToken}`
      const res = await fetch(`${relayUrl.replace(/\/$/, '')}/update/info`, {
        headers,
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        setInfo({ error: `Relay returned ${res.status}` })
        setStatus('error')
        return
      }
      const data = await res.json()
      setInfo(data)
      // In dev mode we can't compare commits, just show what's on the server
      setStatus(BUILD_COMMIT !== '__DEV__' && data.commitHash === BUILD_COMMIT ? 'up-to-date' : 'update-available')
    } catch (e: any) {
      setInfo({ error: e.message || 'Could not reach relay' })
      setStatus('error')
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Software Update</Text>
      <Text style={styles.hint}>
        Check the relay server for the latest version. Rebuild the app in Expo to apply updates.
      </Text>
      <TouchableOpacity
        style={[styles.testBtn, status === 'checking' && { opacity: 0.5 }]}
        onPress={check}
        disabled={status === 'checking'}
      >
        <Text style={styles.testBtnText}>
          {status === 'checking' ? 'Checking…' : 'Check for updates'}
        </Text>
      </TouchableOpacity>
      {status === 'up-to-date' && (
        <Text style={[styles.statusText, { color: colors.accent.green }]}>
          You're up to date.{info?.commitHash ? ` (${info.commitHash.slice(0, 7)})` : ''}
        </Text>
      )}
      {status === 'update-available' && info && (
        <View>
          <Text style={[styles.statusText, { color: colors.accent.blue }]}>
            Latest: {info.commitMessage || 'Unknown'}
            {info.commitHash ? ` (${info.commitHash.slice(0, 7)})` : ''}
          </Text>
          {info.commitDate && (
            <Text style={[styles.statusText, { color: colors.text.muted }]}>
              {new Date(info.commitDate).toLocaleString()}
            </Text>
          )}
        </View>
      )}
      {status === 'error' && info?.error && (
        <Text style={[styles.statusText, { color: colors.accent.red }]}>{info.error}</Text>
      )}
    </View>
  )
}

function Field({ label, value, onChange, placeholder, secure = false, keyboardType }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  secure?: boolean
  keyboardType?: 'default' | 'numeric' | 'email-address' | 'url'
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.text.muted}
        secureTextEntry={secure}
        keyboardType={keyboardType || 'default'}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  )
}

function NotionDbPicker({ label, value, databases, onChange }: {
  label: string
  value: string
  databases: NotionDatabase[]
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
    return databases.find((d) => d.id === value)?.title || null
  }, [databases, value])

  if (databases.length === 0) {
    return <Field label={label} value={value} onChange={onChange} placeholder="Database ID" />
  }

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)}
        style={[styles.fieldInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
      >
        <Text style={{ color: currentTitle ? colors.text.primary : colors.text.muted, flex: 1 }} numberOfLines={1}>
          {currentTitle || 'None selected'}
        </Text>
        <Ionicons name="search" size={12} color={colors.text.muted} />
      </TouchableOpacity>
      {open && (
        <View style={styles.notionDbDropdown}>
          <TextInput
            style={styles.notionDbSearch}
            value={query}
            onChangeText={setQuery}
            placeholder="Search databases…"
            placeholderTextColor={colors.text.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
            {value !== '' && (
              <TouchableOpacity onPress={() => { onChange(''); setOpen(false); setQuery('') }} style={styles.notionDbItem}>
                <Text style={{ color: colors.text.muted, fontSize: 12 }}>Clear selection</Text>
              </TouchableOpacity>
            )}
            {filtered.length === 0 && (
              <View style={styles.notionDbItem}>
                <Text style={{ color: colors.text.muted, fontSize: 12 }}>No matches</Text>
              </View>
            )}
            {filtered.map((db) => (
              <TouchableOpacity
                key={db.id}
                onPress={() => { onChange(db.id); setOpen(false); setQuery('') }}
                style={styles.notionDbItem}
              >
                <Text style={{ color: db.id === value ? colors.accent.blue : colors.text.primary, fontSize: 14 }}>
                  {db.title}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  )
}

function NotionDatePropertyPicker({ label, dbId, value, onChange }: {
  label: string
  dbId: string
  value: string
  onChange: (name: string) => void
}) {
  const [dateProps, setDateProps] = useState<Array<{ name: string; type: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setDateProps([])
    setError(null)
    setOpen(false)
    if (!dbId) return
    setLoading(true)
    ;(async () => {
      try {
        const props = await getDbProperties(dbId)
        setDateProps(props.filter((p) => p.type === 'date'))
      } catch (err: any) {
        setError(err?.message || 'Failed to load DB properties')
      }
      setLoading(false)
    })()
  }, [dbId])

  if (!dbId) return null

  const currentLabel = value || 'Auto (first match by name)'

  return (
    <View style={[styles.field, { marginLeft: 12, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: colors.border }]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {loading && <Text style={{ color: colors.text.muted, fontSize: 12 }}>Loading properties…</Text>}
      {error && <Text style={{ color: colors.accent.red, fontSize: 12 }}>{error}</Text>}
      {!loading && !error && dateProps.length === 0 && (
        <Text style={{ color: colors.text.muted, fontSize: 12 }}>This database has no writable date properties.</Text>
      )}
      {!loading && !error && dateProps.length > 0 && (
        <>
          <TouchableOpacity
            onPress={() => setOpen(!open)}
            style={[styles.fieldInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
          >
            <Text style={{ color: value ? colors.text.primary : colors.text.muted, flex: 1 }} numberOfLines={1}>
              {currentLabel}
            </Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={colors.text.muted} />
          </TouchableOpacity>
          {open && (
            <View style={styles.notionDbDropdown}>
              <TouchableOpacity onPress={() => { onChange(''); setOpen(false) }} style={styles.notionDbItem}>
                <Text style={{ color: !value ? colors.accent.blue : colors.text.primary, fontSize: 14 }}>Auto (first match by name)</Text>
              </TouchableOpacity>
              {dateProps.map((p) => (
                <TouchableOpacity
                  key={p.name}
                  onPress={() => { onChange(p.name); setOpen(false) }}
                  style={styles.notionDbItem}
                >
                  <Text style={{ color: p.name === value ? colors.accent.blue : colors.text.primary, fontSize: 14 }}>{p.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
    paddingHorizontal: spacing.lg,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: spacing.lg,
  },
  section: {
    backgroundColor: colors.bg.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 5,
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  swatchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    backgroundColor: colors.bg.tertiary,
  },
  swatchDot: { width: 14, height: 14, borderRadius: 7 },
  swatchLabel: { fontSize: 13, fontWeight: '600' },
  segmentRow: { flexDirection: 'row', gap: spacing.sm },
  segment: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.secondary,
    marginBottom: spacing.md,
  },
  field: {
    marginBottom: spacing.md,
  },
  fieldLabel: {
    fontSize: 13,
    color: colors.text.muted,
    marginBottom: spacing.xs,
  },
  fieldInput: {
    backgroundColor: colors.bg.tertiary,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text.primary,
  },
  modelRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  modelBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 10,
    backgroundColor: colors.bg.tertiary, alignItems: 'center',
  },
  modelBtnActive: { backgroundColor: colors.accent.blue + '22' },
  modelBtnText: { fontSize: 14, fontWeight: '500', color: colors.text.muted },
  modelBtnTextActive: { color: colors.accent.blue, fontWeight: '700' },
  saveBtn: {
    backgroundColor: colors.accent.blue,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  saveText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  aboutText: {
    fontSize: 15,
    color: colors.text.muted,
    lineHeight: 22,
  },
  testBtn: {
    backgroundColor: colors.bg.tertiary,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  testBtnText: {
    color: colors.accent.blue,
    fontSize: 14,
    fontWeight: '500',
  },
  statusText: {
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  hint: {
    fontSize: 13,
    color: colors.text.muted,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  divider: {
    height: 0.5,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  notionDbHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  notionDbHint: {
    fontSize: 12,
    color: colors.text.muted,
    flex: 1,
  },
  notionDbBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.bg.tertiary,
    borderRadius: 6,
  },
  notionDbBtnText: {
    fontSize: 12,
    color: colors.accent.blue,
    fontWeight: '500',
  },
  notionDbError: {
    fontSize: 12,
    color: colors.accent.red,
    backgroundColor: colors.accent.red + '22',
    padding: spacing.sm,
    borderRadius: 6,
    marginBottom: spacing.sm,
  },
  notionDbDropdown: {
    marginTop: spacing.xs,
    backgroundColor: colors.bg.tertiary,
    borderRadius: 8,
    overflow: 'hidden',
  },
  notionDbSearch: {
    padding: 10,
    fontSize: 14,
    color: colors.text.primary,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  notionDbItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
})
