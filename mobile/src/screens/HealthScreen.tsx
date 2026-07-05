import React, { useEffect, useState, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity,
  TextInput, Dimensions, Platform, DeviceEventEmitter
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'
import { fetchSleepAnalysisFromRelay, SLEEP_UPDATED_EVENT } from '../services/health-sync.service'
import { getOrStartHealthSync } from '../services/sync-manager'
import { generateAnalysis } from '../services/ai.service'
import {
  runFullAnalysis, parseSleepSessions, recommendWakeTime, recommendBedtime, analyzeSleepNeedProfile, calculateWindDownRoutine,
  type FullSleepAnalysis, type SleepSession, type EnergyCurvePoint, type SleepNeedProfile, type WindDownRoutine
} from '../services/sleep-analysis.service'
import {
  fetchHealthTrends, computeTrendInsights,
  type HealthTrends, type MonthlyDataPoint, type TrendInsight
} from '../services/health-trends.service'
import { safeDiv, safePct } from '../utils/safe-math'
import { safeFormatTime, safeHourOfDay } from '../utils/safe-date'
import {
  getFullFitnessAnalysis,
  type FitnessAnalysisResult, type TrainingLoadResult, type RecoveryAnalysis, type FitnessProfile
} from '../services/fitness-analysis.service'

const SCREEN_WIDTH = Dimensions.get('window').width

// Population norms by age — Nunan 2010/Shaffer 2017 (HRV), Tudor-Locke 2011 (steps), AHA (RHR), ACSM 2013 (VO2)
function getMobileAgeNorms(age: number | null) {
  if (!age) return { ageGroup: 'Adults', hrv: { avg: 55, sd: 18 }, steps: { avg: 8000, sd: 2500 }, rhr: { avg: 71, sd: 10 }, vo2: { avg: 43, sd: 8 } }
  if (age < 20) return { ageGroup: '14-19', hrv: { avg: 72, sd: 22 }, steps: { avg: 9000, sd: 2500 }, rhr: { avg: 73, sd: 11 }, vo2: { avg: 50, sd: 9 } }
  if (age < 30) return { ageGroup: '20-29', hrv: { avg: 65, sd: 20 }, steps: { avg: 8500, sd: 2500 }, rhr: { avg: 70, sd: 10 }, vo2: { avg: 46, sd: 8 } }
  if (age < 40) return { ageGroup: '30-39', hrv: { avg: 55, sd: 18 }, steps: { avg: 8000, sd: 2500 }, rhr: { avg: 71, sd: 10 }, vo2: { avg: 43, sd: 7 } }
  if (age < 50) return { ageGroup: '40-49', hrv: { avg: 45, sd: 16 }, steps: { avg: 7500, sd: 2500 }, rhr: { avg: 72, sd: 10 }, vo2: { avg: 40, sd: 7 } }
  if (age < 60) return { ageGroup: '50-59', hrv: { avg: 35, sd: 14 }, steps: { avg: 7000, sd: 2500 }, rhr: { avg: 73, sd: 10 }, vo2: { avg: 36, sd: 7 } }
  return { ageGroup: '60+', hrv: { avg: 27, sd: 11 }, steps: { avg: 6000, sd: 2000 }, rhr: { avg: 74, sd: 11 }, vo2: { avg: 30, sd: 6 } }
}

function mobilePctRank(you: number, mean: number, sd: number): number {
  if (sd <= 0) return 50
  const z = (you - mean) / sd
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const phi = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly
  return Math.round((z >= 0 ? phi : 1 - phi) * 100)
}

function parseClockToMinutes(time: string): number | null {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  return ((parseInt(match[1], 10) * 60 + parseInt(match[2], 10)) % 1440 + 1440) % 1440
}

function formatClockMinutes(minutes: number): string {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440
  const h = Math.floor(normalized / 60)
  const m = normalized % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

function buildSleepCyclePlan(time: string, mode: 'wake' | 'bed', latencyMin: number) {
  const base = parseClockToMinutes(time)
  if (base === null) return []

  return [4, 5, 6].map((cycles) => {
    const sleepMinutes = cycles * 90
    const targetMinutes = mode === 'wake'
      ? base + latencyMin + sleepMinutes
      : base - sleepMinutes - latencyMin

    return {
      cycles,
      hours: sleepMinutes / 60,
      time: formatClockMinutes(targetMinutes),
      isRecommended: cycles === 5,
    }
  })
}

function statusColor(status: string): string {
  switch (status) {
    case 'peaking': case 'productive': return colors.accent.green
    case 'maintaining': case 'recovery': return colors.accent.blue
    case 'overreaching': return colors.accent.red
    case 'detraining': return colors.accent.amber
    default: return colors.text.muted
  }
}

function recoveryColor(status: string): string {
  switch (status) {
    case 'optimal': return colors.accent.green
    case 'good': return colors.accent.blue
    case 'fair': return colors.accent.amber
    case 'poor': case 'critical': return colors.accent.red
    default: return colors.text.muted
  }
}

export default function HealthScreen({ navigation }: { navigation?: any } = {}) {
  const [refreshing, setRefreshing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sleepData, setSleepData] = useState<SleepSession[]>([])
  const [latestHR, setLatestHR] = useState<number | null>(null)
  const [latestHRV, setLatestHRV] = useState<number | null>(null)
  const [latestSteps, setLatestSteps] = useState<number | null>(null)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [aiInsight, setAiInsight] = useState<string | null>(null)
  const [generatingInsight, setGeneratingInsight] = useState(false)
  const [selectedNight, setSelectedNight] = useState<number>(0) // index into sleepData
  const [nightAiInsight, setNightAiInsight] = useState<string | null>(null)
  const [generatingNightInsight, setGeneratingNightInsight] = useState(false)
  const [analysis, setAnalysis] = useState<FullSleepAnalysis | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'analysis' | 'energy' | 'exercise' | 'trends'>('overview')
  const [exerciseData, setExerciseData] = useState<Array<{
    date: string; steps: number; activeEnergy: number; exerciseTime: number;
    distance: number; flights: number; vo2Max: number | null;
  }>>([])
  const [latestVO2, setLatestVO2] = useState<number | null>(null)
  const [wakeCalcBedtime, setWakeCalcBedtime] = useState('23:00')
  const [bedCalcWakeTime, setBedCalcWakeTime] = useState('07:00')
  const [calcMode, setCalcMode] = useState<'wake' | 'bed'>('wake')
  const [sleepLatency, setSleepLatency] = useState(15)
  const [wakeCalcResult, setWakeCalcResult] = useState<string | null>(null)
  const [bedCalcResult, setBedCalcResult] = useState<string | null>(null)
  const [seededCalcDefaults, setSeededCalcDefaults] = useState(false)
  const [trends, setTrends] = useState<HealthTrends | null>(null)
  const [trendInsights, setTrendInsights] = useState<TrendInsight[]>([])
  const [loadingTrends, setLoadingTrends] = useState(false)
  const [sleepRange, setSleepRange] = useState<number>(14) // days to show
  const [sleepNeedProfile, setSleepNeedProfile] = useState<SleepNeedProfile | null>(null)
  const [showSleepNeedDetail, setShowSleepNeedDetail] = useState(false)
  const [windDownRoutine, setWindDownRoutine] = useState<WindDownRoutine | null>(null)
  const [userAge, setUserAge] = useState<number | null>(null)
  const [fitnessAnalysis, setFitnessAnalysis] = useState<FitnessAnalysisResult | null>(null)

  const RANGE_OPTIONS = [
    { label: '2W', days: 14 },
    { label: '1M', days: 30 },
    { label: '3M', days: 90 },
    { label: '6M', days: 180 },
    { label: '1Y', days: 365 },
    { label: '2Y', days: 730 },
    { label: '4Y', days: 1460 },
    { label: 'All', days: 9999 },
  ]

  const syncHealth = async (silent = false) => {
    if (!silent) setSyncStatus('Syncing from relay...')
    // On first sync (empty DB), pull all historical data; subsequent syncs pull 30 days
    const db = await getDb()
    const countRow = await db.getFirstAsync('SELECT COUNT(*) as n FROM health_metrics') as { n: number } | null
    const days = (countRow?.n ?? 0) === 0 ? 3650 : 30
    const result = await getOrStartHealthSync(days)
    if (!result.success) {
      if (!silent) setSyncStatus(result.error || 'Sync failed')
    } else if (result.latestDate) {
      if (silent) return
      setSyncStatus(`Synced ${result.count} metrics · latest sleep: ${result.latestDate}`)
      setTimeout(() => setSyncStatus(null), 3000)
    } else {
      if (!silent) setSyncStatus(null)
    }
  }

  const loadData = async (silent = false) => {
    try {
      await syncHealth(silent)
      const db = await getDb()

      // Read user age for age-adjusted comparisons
      try {
        const { getSettings } = await import('../lib/storage')
        const settings = await getSettings()
        const age = settings.userAge ? parseInt(settings.userAge) : null
        if (age && age > 0 && age < 120) setUserAge(age)
      } catch {}

      // Collect all data before touching state so every setState fires in one batch
      let nextSleepData: SleepSession[] = []
      let nextHR: number | null = null
      let nextHRV: number | null = null
      let nextSteps: number | null = null
      let nextVO2: number | null = null
      let nextExerciseData: typeof exerciseData = []
      let nextAnalysis: FullSleepAnalysis | null = null
      let nextSleepNeedProfile: typeof sleepNeedProfile = null
      let nextWindDown: typeof windDownRoutine = null
      let nextTrends: HealthTrends | null = null
      let nextTrendInsights: TrendInsight[] = []

      nextSleepData = await parseSleepSessions(Math.max(sleepRange, 14))

      const hr = await db.getFirstAsync(
        `SELECT value_json FROM health_metrics WHERE metric_type = 'heart_rate' ORDER BY date DESC LIMIT 1`
      ) as any
      if (hr) { try { const v = JSON.parse(hr.value_json); nextHR = v.qty || v.value || null } catch {} }

      const hrv = await db.getFirstAsync(
        `SELECT value_json FROM health_metrics WHERE metric_type = 'hrv' ORDER BY date DESC LIMIT 1`
      ) as any
      if (hrv) { try { const v = JSON.parse(hrv.value_json); nextHRV = v.qty || v.value || null } catch {} }

      const steps = await db.getFirstAsync(
        `SELECT value_json FROM health_metrics WHERE metric_type = 'steps' ORDER BY date DESC LIMIT 1`
      ) as any
      if (steps) { try { const v = JSON.parse(steps.value_json); nextSteps = v.qty || v.value || null } catch {} }

      const vo2 = await db.getFirstAsync(
        `SELECT value_json FROM health_metrics WHERE metric_type = 'vo2_max' ORDER BY date DESC LIMIT 1`
      ) as any
      if (vo2) { try { const v = JSON.parse(vo2.value_json); nextVO2 = v.qty || v.value || null } catch {} }

      const exerciseRows = await db.getAllAsync(
        `SELECT metric_type, date, value_json FROM health_metrics
         WHERE metric_type IN ('steps', 'active_energy', 'exercise_time', 'distance', 'flights_climbed', 'vo2_max')
         AND date >= date('now', '-30 days')
         ORDER BY date ASC`
      ) as Array<{ metric_type: string; date: string; value_json: string }>
      const dayMap: Record<string, any> = {}
      for (const row of exerciseRows) {
        if (!dayMap[row.date]) dayMap[row.date] = { date: row.date, steps: 0, activeEnergy: 0, exerciseTime: 0, distance: 0, flights: 0, vo2Max: null }
        try {
          const v = JSON.parse(row.value_json)
          const qty = v.qty || v.value || 0
          if (row.metric_type === 'steps') dayMap[row.date].steps = qty
          else if (row.metric_type === 'active_energy') dayMap[row.date].activeEnergy = Math.round(qty)
          else if (row.metric_type === 'exercise_time') dayMap[row.date].exerciseTime = Math.round(qty)
          else if (row.metric_type === 'distance') dayMap[row.date].distance = Math.round(qty * 10) / 10
          else if (row.metric_type === 'flights_climbed') dayMap[row.date].flights = qty
          else if (row.metric_type === 'vo2_max') dayMap[row.date].vo2Max = qty
        } catch {}
      }
      nextExerciseData = Object.values(dayMap)

      const relayResult = await fetchSleepAnalysisFromRelay()
      let analysisResult = relayResult.analysis
      if (analysisResult && nextSleepData.length > 0) {
        const latestLocalDate = nextSleepData[0].date
        const analysisDate = analysisResult.debt?.last14Nights?.[0]?.date
        if (analysisDate && latestLocalDate > analysisDate) {
          analysisResult = null
        }
      }
      if (!analysisResult) {
        analysisResult = await runFullAnalysis()
      }
      nextAnalysis = analysisResult

      if (relayResult.sleepNeedProfile && analysisResult === relayResult.analysis) {
        nextSleepNeedProfile = relayResult.sleepNeedProfile
      } else {
        try {
          nextSleepNeedProfile = await analyzeSleepNeedProfile(Math.max(sleepRange, 90))
        } catch (err) {
          console.error('Failed to load sleep need profile:', err)
        }
      }

      try {
        if (nextSleepData.length >= 7) {
          nextWindDown = calculateWindDownRoutine(nextSleepData)
        }
      } catch (err) {
        console.error('Failed to calculate wind-down routine:', err)
      }

      const trendsData = await fetchHealthTrends(36)
      if (trendsData) {
        nextTrends = trendsData
        nextTrendInsights = computeTrendInsights(trendsData)
      }

      // Load fitness analysis (non-blocking — don't delay other data)
      let nextFitness: FitnessAnalysisResult | null = null
      try { nextFitness = await getFullFitnessAnalysis(90) } catch (err) {
        console.error('Fitness analysis failed:', err)
      }

      // Commit all state in one synchronous block — React batches these into a single render
      setSleepData(nextSleepData)
      setLatestHR(nextHR)
      setLatestHRV(nextHRV)
      setLatestSteps(nextSteps)
      setLatestVO2(nextVO2)
      setExerciseData(nextExerciseData)
      setAnalysis(nextAnalysis)
      setSleepNeedProfile(nextSleepNeedProfile)
      setWindDownRoutine(nextWindDown)
      setTrends(nextTrends)
      setTrendInsights(nextTrendInsights)
      setFitnessAnalysis(nextFitness)
    } catch (err) {
      console.error('Health data load error:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData(true) }, [sleepRange])

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(SLEEP_UPDATED_EVENT, () => { loadData(true) })
    return () => sub.remove()
  }, [])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData(true)
    setRefreshing(false)
  }

  const lastSleep = sleepData[0]
  const sleepHours = lastSleep ? (lastSleep.totalAsleep / 60).toFixed(1) : '--'
  const insets = useSafeAreaInsets()
  const calcPlan = useMemo(
    () => buildSleepCyclePlan(calcMode === 'wake' ? wakeCalcBedtime : bedCalcWakeTime, calcMode, sleepLatency),
    [bedCalcWakeTime, calcMode, sleepLatency, wakeCalcBedtime]
  )

  useEffect(() => {
    if (!analysis?.circadian || seededCalcDefaults) return
    if (analysis.circadian.optimalBedtime) {
      setWakeCalcBedtime(analysis.circadian.optimalBedtime)
    }
    if (analysis.circadian.optimalWakeTime) {
      setBedCalcWakeTime(analysis.circadian.optimalWakeTime)
    }
    setSeededCalcDefaults(true)
  }, [analysis, seededCalcDefaults])

  const handleWakeCalc = () => {
    const result = recommendWakeTime(wakeCalcBedtime, sleepLatency)
    setWakeCalcResult(
      `Optimal: ${result.optimalWakeTime}\n` +
      `Alternatives: ${result.alternativeWakeTimes.join(', ')}\n` +
      `${result.reasoning}`
    )
  }

  const handleBedCalc = () => {
    const result = recommendBedtime(bedCalcWakeTime, sleepLatency)
    setBedCalcResult(
      `Optimal bedtime: ${result.optimalWakeTime}\n` +
      `Alternatives: ${result.alternativeWakeTimes.join(', ')}\n` +
      `${result.reasoning}`
    )
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl * 2 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.purple} />}
    >
      <Text style={styles.title}>Health & Sleep</Text>
      <Text style={[styles.syncStatus, !syncStatus && { opacity: 0 }]}>{syncStatus || ' '}</Text>

      {/* Sync from desktop — data comes via Health Auto Export → Desktop → Relay */}
      <TouchableOpacity style={styles.syncBtn} onPress={() => syncHealth()}>
        <Ionicons name="cloud-download-outline" size={14} color={colors.accent.purple} />
        <Text style={[styles.syncBtnText, { color: colors.accent.purple }]}>Sync from Desktop</Text>
      </TouchableOpacity>

      {/* Tab Selector */}
      <View style={styles.tabRow}>
        {(['overview', 'analysis', 'energy', 'exercise', 'trends'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'overview' ? 'Overview' : tab === 'analysis' ? 'Analysis' : tab === 'energy' ? 'Energy' : tab === 'exercise' ? 'Exercise' : 'Trends'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.loadingCard}>
          <NoodleSpinner size={40} color={colors.accent.purple} variant="inside" />
          <Text style={styles.loadingText}>Syncing health data</Text>
        </View>
      ) : (
        <>
          {activeTab === 'overview' && renderOverview()}
          {activeTab === 'analysis' && renderAnalysis()}
          {activeTab === 'energy' && renderEnergy()}
          {activeTab === 'exercise' && renderExercise()}
          {activeTab === 'trends' && renderTrends()}
        </>
      )}

      {/* AI Insights (always visible) */}
      {sleepData.length > 0 && (
        <TouchableOpacity
          style={[styles.insightBtn, generatingInsight && { opacity: 0.5 }]}
          onPress={async () => {
            setGeneratingInsight(true)
            try {
              const context = sleepData.slice(0, 7).map(s =>
                `${s.date}: ${(s.totalAsleep/60).toFixed(1)}h (deep: ${s.deepSleep}m, REM: ${s.remSleep}m, core: ${s.coreSleep}m)`
              ).join('\n')
              const analysisContext = analysis ? `\nSleep debt: ${analysis.debt.currentDebt}h (${analysis.debt.debtCategory})\nChronotype: ${analysis.chronotype.label}\nQuality score: ${analysis.quality?.overall || 'N/A'}/100` : ''

              const response = await generateAnalysis(
                `You are a sleep and health optimization coach using Rise Science methodology. Analyze the user's sleep data and provide specific, actionable suggestions. Consider their chronotype, sleep debt, and circadian rhythm. Be concise and direct.`,
                `My sleep data (last 7 nights):\n${context}\n${analysisContext}\nHR: ${latestHR || '?'} bpm, HRV: ${latestHRV || '?'} ms, Steps: ${latestSteps || '?'}\n\nGive me specific suggestions to improve my sleep and energy.`
              )
              setAiInsight(response)
            } catch (err: any) {
              setAiInsight(`Error: ${err.message}`)
            }
            setGeneratingInsight(false)
          }}
          disabled={generatingInsight}
        >
          {generatingInsight ? (
            <NoodleSpinner size={18} color="#fff" />
          ) : (
            <Text style={styles.insightBtnText}>Get AI Sleep Coaching</Text>
          )}
        </TouchableOpacity>
      )}

      {aiInsight && (
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.blue }]}>AI Sleep Coach</Text>
          <Text style={styles.insightText}>{aiInsight}</Text>
        </View>
      )}

      {!loading && sleepData.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No health data yet. Set up Health Auto Export on your iPhone to send data to the desktop, then tap "Sync from Desktop" to pull it here.
          </Text>
        </View>
      )}
    </ScrollView>
  )

  // === OVERVIEW TAB ===
  function renderOverview() {
    return (
      <>
        {/* Hero Sleep Card with Quality Score */}
        <View style={styles.heroCard}>
          <View style={styles.heroTopRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.heroLabel, { color: colors.accent.purple }]}>Last Night's Sleep</Text>
              <View style={styles.heroRow}>
                <Text style={styles.heroValue}>{sleepHours}</Text>
                <Text style={styles.heroUnit}>hours</Text>
              </View>
              {lastSleep && lastSleep.totalAsleep > 0 && (
                <Text style={styles.heroDetail}>
                  Deep {lastSleep.deepSleep}m  ·  REM {lastSleep.remSleep}m  ·  Core {lastSleep.coreSleep}m{lastSleep.awakeTime > 0 ? `  ·  Awake ${lastSleep.awakeTime}m` : ''}
                </Text>
              )}
              {lastSleep?.sleepStart && (
                <Text style={[styles.heroDetail, { marginTop: 2 }]}>
                  {safeFormatTime(lastSleep.sleepStart, '--')} – {safeFormatTime(lastSleep.sleepEnd, '--')}
                  {lastSleep.totalInBed > 0 && `  ·  ${safePct(lastSleep.totalAsleep, lastSleep.totalInBed).toFixed(0)}% eff`}
                </Text>
              )}
            </View>
            {analysis?.quality && (
              <ScoreRing score={analysis.quality.overall} size={72} label="Quality" />
            )}
          </View>
          <TouchableOpacity
            onPress={() => navigation?.navigate('SleepHistory')}
            style={styles.historyLink}
          >
            <Ionicons name="time-outline" size={14} color={colors.accent.purple} />
            <Text style={styles.historyLinkText}>See full history</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.accent.purple} />
          </TouchableOpacity>
        </View>

        {/* Quality Score Breakdown */}
        {analysis?.quality && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>Sleep Quality Breakdown</Text>
            <View style={styles.scoreGrid}>
              <MiniScore label="Deep" score={analysis.quality.deepSleepScore} color="#6366f1" />
              <MiniScore label="REM" score={analysis.quality.remScore} color="#8b5cf6" />
              <MiniScore label="Core" score={analysis.quality.coreSleepScore ?? 0} color="#818cf8" />
              <MiniScore label="WASO" score={analysis.quality.wasoScore ?? 0} color="#7dd3fc" />
              <MiniScore label="Efficiency" score={analysis.quality.efficiencyScore} color="#a78bfa" />
              <MiniScore label="Consistency" score={analysis.quality.consistencyScore} color="#c4b5fd" />
            </View>
            <Text style={styles.cycleText}>
              ~{analysis.quality.cycleCompletion} sleep cycles completed
            </Text>
          </View>
        )}

        {/* Sleep Debt Gauge */}
        {analysis?.debt && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: debtColor(analysis.debt.debtCategory) }]}>
              Sleep Debt: {analysis.debt.currentDebt}h
            </Text>
            <DebtGauge debt={analysis.debt.currentDebt} category={analysis.debt.debtCategory} />
            <Text style={styles.captionText}>
              Sleep need: {analysis.debt.sleepNeedEstimate}h/night · Target: under 5h debt
            </Text>
          </View>
        )}

        {/* Vitals Row */}
        {(() => {
          const norms = getMobileAgeNorms(userAge)
          const hrvPct = latestHRV ? mobilePctRank(latestHRV, norms.hrv.avg, norms.hrv.sd) : null
          const stepsPct = latestSteps ? mobilePctRank(latestSteps, norms.steps.avg, norms.steps.sd) : null
          const rhrPct = latestHR ? 100 - mobilePctRank(latestHR, norms.rhr.avg, norms.rhr.sd) : null
          const pctColor = (p: number) => p >= 60 ? colors.accent.green : p >= 35 ? colors.accent.amber : colors.accent.red
          const rankLabel = (p: number) => p >= 50 ? `Top ${100 - p}%` : `Bot ${p}%`
          return (
            <View style={styles.cardRow}>
              <View style={[styles.metricCard, { flex: 1 }]}>
                <Ionicons name="heart" size={16} color={colors.accent.red} />
                <Text style={styles.metricValue}>{latestHR ?? '--'}</Text>
                <Text style={styles.metricUnit}>bpm</Text>
                {rhrPct !== null && <Text style={[styles.metricUnit, { color: pctColor(rhrPct), marginTop: 2 }]}>{rankLabel(rhrPct)}</Text>}
              </View>
              <View style={{ width: spacing.sm }} />
              <View style={[styles.metricCard, { flex: 1 }]}>
                <Ionicons name="pulse" size={16} color={colors.accent.blue} />
                <Text style={styles.metricValue}>{latestHRV ?? '--'}</Text>
                <Text style={styles.metricUnit}>ms HRV</Text>
                {hrvPct !== null && <Text style={[styles.metricUnit, { color: pctColor(hrvPct), marginTop: 2 }]}>{rankLabel(hrvPct)}</Text>}
              </View>
              <View style={{ width: spacing.sm }} />
              <View style={[styles.metricCard, { flex: 1 }]}>
                <Ionicons name="footsteps" size={16} color={colors.accent.green} />
                <Text style={styles.metricValue}>{latestSteps ? (latestSteps > 999 ? `${(latestSteps/1000).toFixed(1)}k` : latestSteps) : '--'}</Text>
                <Text style={styles.metricUnit}>steps</Text>
                {stepsPct !== null && <Text style={[styles.metricUnit, { color: pctColor(stepsPct), marginTop: 2 }]}>{rankLabel(stepsPct)}</Text>}
              </View>
            </View>
          )
        })()}

        {/* Sleep Stages */}
        {lastSleep && lastSleep.totalAsleep > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>Sleep Stages</Text>
            <View style={styles.stageBar}>
              {lastSleep.deepSleep > 0 && (
                <View style={[styles.stageSegment, {
                  flex: safeDiv(lastSleep.deepSleep, lastSleep.totalAsleep),
                  backgroundColor: '#6366f1',
                  borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
                }]} />
              )}
              {lastSleep.coreSleep > 0 && (
                <View style={[styles.stageSegment, {
                  flex: safeDiv(lastSleep.coreSleep, lastSleep.totalAsleep),
                  backgroundColor: '#818cf8',
                }]} />
              )}
              {lastSleep.remSleep > 0 && (
                <View style={[styles.stageSegment, {
                  flex: safeDiv(lastSleep.remSleep, lastSleep.totalAsleep),
                  backgroundColor: '#a78bfa',
                  borderTopRightRadius: 6, borderBottomRightRadius: 6,
                }]} />
              )}
            </View>
            <View style={styles.stageLabels}>
              <StageLabel color="#6366f1" label="Deep" mins={lastSleep.deepSleep} total={lastSleep.totalAsleep} />
              <StageLabel color="#818cf8" label="Core" mins={lastSleep.coreSleep} total={lastSleep.totalAsleep} />
              <StageLabel color="#a78bfa" label="REM" mins={lastSleep.remSleep} total={lastSleep.totalAsleep} />
            </View>
          </View>
        )}

        {/* HRV Recovery */}
        {analysis?.hrvRecovery && (
          <View style={styles.card}>
            <View style={styles.hrvHeader}>
              <Text style={[styles.cardLabel, { color: hrvColor(analysis.hrvRecovery.status), marginBottom: 0 }]}>
                HRV Recovery
              </Text>
              <View style={[styles.badge, { backgroundColor: hrvColor(analysis.hrvRecovery.status) + '33' }]}>
                <Text style={[styles.badgeText, { color: hrvColor(analysis.hrvRecovery.status) }]}>
                  {analysis.hrvRecovery.score}/100 · {analysis.hrvRecovery.status}
                </Text>
              </View>
            </View>
            <Text style={styles.captionText}>
              Latest: {analysis.hrvRecovery.latestHrv}ms · Baseline: {analysis.hrvRecovery.baseline}ms · z={analysis.hrvRecovery.zScore}
            </Text>
            <Text style={[styles.captionText, { marginTop: spacing.xs }]}>{analysis.hrvRecovery.recommendation}</Text>
            {(() => {
              const norms = getMobileAgeNorms(userAge)
              const pct = mobilePctRank(analysis.hrvRecovery.latestHrv, norms.hrv.avg, norms.hrv.sd)
              const diff = Math.round(analysis.hrvRecovery.latestHrv - norms.hrv.avg)
              const color = pct >= 60 ? colors.accent.green : pct >= 35 ? colors.accent.amber : colors.accent.red
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 0.5, borderTopColor: colors.border }}>
                  <Text style={[styles.captionText, { flex: 1, marginTop: 0 }]}>
                    Ages {norms.ageGroup} avg: {norms.hrv.avg}ms
                  </Text>
                  <Text style={{ fontSize: 10, color: diff >= 0 ? colors.accent.green : colors.accent.red, fontWeight: '600' }}>
                    {diff >= 0 ? '+' : ''}{diff}ms
                  </Text>
                  <View style={{ backgroundColor: color + '22', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                    <Text style={{ fontSize: 10, color, fontWeight: '600' }}>
                      {pct >= 50 ? `Top ${100 - pct}%` : `Bottom ${pct}%`}
                    </Text>
                  </View>
                </View>
              )
            })()}
            <TouchableOpacity
              onPress={() => navigation?.navigate('HrvHistory')}
              style={[styles.historyLink, { backgroundColor: colors.accent.cyan + '15', marginTop: spacing.md }]}
            >
              <Ionicons name="time-outline" size={14} color={colors.accent.cyan} />
              <Text style={[styles.historyLinkText, { color: colors.accent.cyan }]}>HRV history</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.accent.cyan} />
            </TouchableOpacity>
          </View>
        )}

        {/* Night-by-Night Detail Browser */}
        {sleepData.length > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>Night Detail</Text>

            {/* Night Selector */}
            <View style={styles.nightNav}>
              <TouchableOpacity
                onPress={() => setSelectedNight(Math.min(selectedNight + 1, sleepData.length - 1))}
                disabled={selectedNight >= sleepData.length - 1}
                style={styles.nightNavBtn}
              >
                <Ionicons name="chevron-back" size={20} color={selectedNight >= sleepData.length - 1 ? colors.text.muted + '33' : colors.text.primary} />
              </TouchableOpacity>
              <View style={{ alignItems: 'center', flex: 1 }}>
                <Text style={styles.nightNavDate}>
                  {sleepData[selectedNight]?.date ? formatNightDate(sleepData[selectedNight].date) : '--'}
                </Text>
                <Text style={styles.nightNavSub}>
                  {selectedNight === 0 ? 'Last Night' : `${selectedNight} night${selectedNight > 1 ? 's' : ''} ago`}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setSelectedNight(Math.max(selectedNight - 1, 0))}
                disabled={selectedNight <= 0}
                style={styles.nightNavBtn}
              >
                <Ionicons name="chevron-forward" size={20} color={selectedNight <= 0 ? colors.text.muted + '33' : colors.text.primary} />
              </TouchableOpacity>
            </View>

            {(() => {
              const night = sleepData[selectedNight]
              if (!night || night.totalAsleep === 0) return <Text style={styles.emptyText}>No data for this night</Text>

              const hrs = safeDiv(night.totalAsleep, 60)
              const deepPct = safePct(night.deepSleep, night.totalAsleep)
              const remPct = safePct(night.remSleep, night.totalAsleep)
              const corePct = safePct(night.coreSleep, night.totalAsleep)
              const efficiency = safePct(night.totalAsleep, night.totalInBed)
              const bedtime = safeFormatTime(night.sleepStart, '--')
              const wakeTime = safeFormatTime(night.sleepEnd, '--')

              return (
                <>
                  {/* Duration + Times */}
                  <View style={styles.nightSummaryRow}>
                    <View style={styles.nightSumItem}>
                      <Text style={styles.nightSumValue}>{hrs.toFixed(1)}h</Text>
                      <Text style={styles.nightSumLabel}>Total Sleep</Text>
                    </View>
                    <View style={styles.nightSumItem}>
                      <Text style={styles.nightSumValue}>{bedtime}</Text>
                      <Text style={styles.nightSumLabel}>Bedtime</Text>
                    </View>
                    <View style={styles.nightSumItem}>
                      <Text style={styles.nightSumValue}>{wakeTime}</Text>
                      <Text style={styles.nightSumLabel}>Wake</Text>
                    </View>
                    {efficiency > 0 && (
                      <View style={styles.nightSumItem}>
                        <Text style={[styles.nightSumValue, { color: efficiency >= 85 ? colors.accent.green : efficiency >= 75 ? colors.accent.amber : colors.accent.red }]}>
                          {efficiency.toFixed(0)}%
                        </Text>
                        <Text style={styles.nightSumLabel}>Efficiency</Text>
                      </View>
                    )}
                  </View>

                  {/* Stage Bar */}
                  <View style={[styles.stageBar, { marginTop: spacing.md }]}>
                    {night.deepSleep > 0 && (
                      <View style={[styles.stageSegment, {
                        flex: safeDiv(night.deepSleep, night.totalAsleep),
                        backgroundColor: '#6366f1',
                        borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
                      }]} />
                    )}
                    {night.coreSleep > 0 && (
                      <View style={[styles.stageSegment, {
                        flex: safeDiv(night.coreSleep, night.totalAsleep),
                        backgroundColor: '#818cf8',
                      }]} />
                    )}
                    {night.remSleep > 0 && (
                      <View style={[styles.stageSegment, {
                        flex: safeDiv(night.remSleep, night.totalAsleep),
                        backgroundColor: '#a78bfa',
                        borderTopRightRadius: 6, borderBottomRightRadius: 6,
                      }]} />
                    )}
                  </View>

                  {/* Stage Detail Cards */}
                  <View style={styles.stageDetailGrid}>
                    <View style={[styles.stageDetailCard, { borderLeftColor: '#6366f1' }]}>
                      <Text style={styles.stageDetailTitle}>Deep Sleep</Text>
                      <Text style={styles.stageDetailValue}>{night.deepSleep}m</Text>
                      <Text style={[styles.stageDetailPct, { color: deepPct >= 13 ? colors.accent.green : colors.accent.red }]}>
                        {deepPct.toFixed(0)}%
                      </Text>
                      <Text style={styles.stageDetailTarget}>Target: 13-23%</Text>
                    </View>
                    <View style={[styles.stageDetailCard, { borderLeftColor: '#818cf8' }]}>
                      <Text style={styles.stageDetailTitle}>Core Sleep</Text>
                      <Text style={styles.stageDetailValue}>{night.coreSleep}m</Text>
                      <Text style={styles.stageDetailPct}>{corePct.toFixed(0)}%</Text>
                      <Text style={styles.stageDetailTarget}>Light/N1+N2</Text>
                    </View>
                    <View style={[styles.stageDetailCard, { borderLeftColor: '#a78bfa' }]}>
                      <Text style={styles.stageDetailTitle}>REM Sleep</Text>
                      <Text style={styles.stageDetailValue}>{night.remSleep}m</Text>
                      <Text style={[styles.stageDetailPct, { color: remPct >= 20 ? colors.accent.green : remPct >= 15 ? colors.accent.amber : colors.accent.red }]}>
                        {remPct.toFixed(0)}%
                      </Text>
                      <Text style={styles.stageDetailTarget}>Target: 20-25%</Text>
                    </View>
                  </View>

                  {/* AI Suggestion for this night */}
                  <TouchableOpacity
                    style={[styles.nightAiBtn, generatingNightInsight && { opacity: 0.5 }]}
                    disabled={generatingNightInsight}
                    onPress={async () => {
                      setGeneratingNightInsight(true)
                      setNightAiInsight(null)
                      try {
                        const nightContext = `Date: ${night.date}\nTotal sleep: ${hrs.toFixed(1)}h\nDeep: ${night.deepSleep}m (${deepPct.toFixed(0)}%)\nREM: ${night.remSleep}m (${remPct.toFixed(0)}%)\nCore: ${night.coreSleep}m (${corePct.toFixed(0)}%)\nIn bed: ${(night.totalInBed / 60).toFixed(1)}h\nEfficiency: ${efficiency.toFixed(0)}%\nBedtime: ${bedtime}\nWake: ${wakeTime}`
                        const weekContext = sleepData.slice(0, 7).map(s =>
                          `${s.date}: ${(s.totalAsleep/60).toFixed(1)}h (deep ${s.deepSleep}m, REM ${s.remSleep}m)`
                        ).join('\n')
                        const analysisCtx = analysis ? `\nSleep debt: ${analysis.debt.currentDebt}h (${analysis.debt.debtCategory})\nChronotype: ${analysis.chronotype.label}\nSleep need: ${analysis.debt.sleepNeedEstimate}h` : ''

                        const response = await generateAnalysis(
                          `You are a sleep scientist and optimization coach. Analyze this specific night's sleep data in context of the user's recent pattern. Give 3-4 specific, actionable insights about this night. Note what went well and what could improve. Be concise — use bullet points.`,
                          `This night's data:\n${nightContext}\n\nRecent week for context:\n${weekContext}${analysisCtx}\n\nAnalyze this specific night and give targeted suggestions.`
                        )
                        setNightAiInsight(response)
                      } catch (err: any) {
                        setNightAiInsight(`Error: ${err.message}`)
                      }
                      setGeneratingNightInsight(false)
                    }}
                  >
                    {generatingNightInsight ? (
                      <NoodleSpinner size={16} color={colors.accent.purple} />
                    ) : (
                      <>
                        <Ionicons name="sparkles" size={14} color={colors.accent.purple} />
                        <Text style={styles.nightAiBtnText}>Analyze This Night</Text>
                      </>
                    )}
                  </TouchableOpacity>

                  {nightAiInsight && (
                    <View style={styles.nightAiResult}>
                      <Text style={styles.insightText}>{nightAiInsight}</Text>
                    </View>
                  )}
                </>
              )
            })()}
          </View>
        )}

        {/* Range Selector */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
          <View style={{ flexDirection: 'row', gap: spacing.xs }}>
            {RANGE_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.days}
                style={[styles.rangeBtn, sleepRange === opt.days && styles.rangeBtnActive]}
                onPress={() => { setSleepRange(opt.days); setSelectedNight(0); setNightAiInsight(null) }}
              >
                <Text style={[styles.rangeBtnText, sleepRange === opt.days && styles.rangeBtnTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        {/* Sleep Duration Line Chart */}
        {sleepData.length > 1 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>
              Sleep Duration ({Math.min(sleepData.length, sleepRange)} nights)
            </Text>
            {sleepRange <= 90 ? (
              <SleepLineChart
                data={sleepData.slice(0, sleepRange).reverse()}
                selectedIndex={Math.min(sleepData.length, sleepRange) - 1 - selectedNight}
                onSelect={(i) => { setSelectedNight(Math.min(sleepData.length, sleepRange) - 1 - i); setNightAiInsight(null) }}
              />
            ) : (
              <SleepBarChart data={sleepData.slice(0, sleepRange).reverse()} />
            )}
          </View>
        )}

        {/* Sleep Stages Stacked Chart */}
        {sleepData.length > 1 && sleepData.some(s => s.deepSleep > 0 || s.remSleep > 0) && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: '#6366f1' }]}>Sleep Stages Breakdown</Text>
            <SleepStagesChart
              data={sleepData.slice(0, Math.min(sleepRange, 90)).reverse()}
              selectedIndex={Math.min(sleepData.length, Math.min(sleepRange, 90)) - 1 - selectedNight}
              onSelect={(i) => { setSelectedNight(Math.min(sleepData.length, Math.min(sleepRange, 90)) - 1 - i); setNightAiInsight(null) }}
            />
          </View>
        )}

        {/* Bedtime & Wake Consistency */}
        {sleepData.length > 1 && sleepData.some(s => s.sleepStart) && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.cyan }]}>Sleep Schedule Consistency</Text>
            <ScheduleChart data={sleepData.slice(0, Math.min(sleepRange, 90)).reverse()} />
          </View>
        )}

        {/* Weekly Comparison */}
        {sleepData.length >= 7 && (
          <WeeklyComparison data={sleepData} />
        )}

        {/* Nightly Sleep Log (detailed table) */}
        {sleepData.length > 1 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>Nightly Log ({Math.min(sleepData.length, sleepRange)} nights)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ minWidth: 340 }}>
                {/* Table header */}
                <View style={{ flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: colors.border }}>
                  <Text style={{ width: 68, fontSize: 10, fontWeight: '600', color: colors.text.muted }}>Date</Text>
                  <Text style={{ width: 38, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Sleep</Text>
                  <Text style={{ width: 32, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Eff</Text>
                  <Text style={{ width: 34, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Deep</Text>
                  <Text style={{ width: 34, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>REM</Text>
                  <Text style={{ width: 60, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Bed</Text>
                  <Text style={{ width: 60, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Wake</Text>
                </View>
                {sleepData.slice(0, Math.min(sleepRange, 60)).map((s, i) => {
                  const hrs = s.totalAsleep / 60
                  const eff = s.totalInBed > 0 ? Math.round((s.totalAsleep / s.totalInBed) * 100) : 0
                  const bedtime = safeFormatTime(s.sleepStart, '--')
                  const wake = safeFormatTime(s.sleepEnd, '--')
                  const isSelected = i === selectedNight
                  const hrsColor = hrs >= 7 ? colors.accent.blue : hrs >= 6 ? colors.accent.amber : colors.accent.red
                  const effColor = eff >= 85 ? colors.accent.green : eff >= 75 ? colors.accent.amber : eff > 0 ? colors.accent.red : colors.text.muted
                  return (
                    <TouchableOpacity
                      key={i}
                      onPress={() => { setSelectedNight(i); setNightAiInsight(null) }}
                      style={[{
                        flexDirection: 'row', alignItems: 'center', paddingVertical: 5,
                        borderBottomWidth: 0.5, borderBottomColor: colors.border,
                      }, isSelected && { backgroundColor: colors.accent.purple + '12' }]}
                    >
                      <Text style={{ width: 68, fontSize: 10, color: isSelected ? colors.accent.purple : colors.text.secondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                        {s.date}
                      </Text>
                      <Text style={{ width: 38, fontSize: 11, fontWeight: '600', color: hrsColor, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                        {hrs.toFixed(1)}
                      </Text>
                      <Text style={{ width: 32, fontSize: 11, color: effColor, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                        {eff > 0 ? `${eff}%` : '--'}
                      </Text>
                      <Text style={{ width: 34, fontSize: 11, color: colors.text.secondary, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                        {s.deepSleep > 0 ? `${s.deepSleep}` : '--'}
                      </Text>
                      <Text style={{ width: 34, fontSize: 11, color: colors.text.secondary, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                        {s.remSleep > 0 ? `${s.remSleep}` : '--'}
                      </Text>
                      <Text style={{ width: 60, fontSize: 10, color: colors.text.muted, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                        {bedtime}
                      </Text>
                      <Text style={{ width: 60, fontSize: 10, color: colors.text.muted, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                        {wake}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </ScrollView>
          </View>
        )}
      </>
    )
  }

  // === ANALYSIS TAB ===
  function renderAnalysis() {
    if (!analysis) {
      return (
        <View style={styles.card}>
          <Text style={styles.emptyText}>Need at least 7 nights of data for full analysis. Sync from Apple Watch or relay.</Text>
        </View>
      )
    }

    return (
      <>
        {/* Chronotype */}
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.cyan }]}>Your Chronotype</Text>
          <View style={styles.chronoRow}>
            <Text style={styles.chronoEmoji}>{chronoEmoji(analysis.chronotype.chronotype)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.chronoLabel}>{analysis.chronotype.label}</Text>
              <Text style={styles.captionText}>{analysis.chronotype.description}</Text>
            </View>
          </View>
          <View style={styles.chronoGrid}>
            <View style={styles.chronoItem}>
              <Text style={styles.chronoItemLabel}>Ideal Wake</Text>
              <Text style={styles.chronoItemValue}>{analysis.chronotype.idealWake}</Text>
            </View>
            <View style={styles.chronoItem}>
              <Text style={styles.chronoItemLabel}>Ideal Sleep</Text>
              <Text style={styles.chronoItemValue}>{analysis.chronotype.idealSleep}</Text>
            </View>
            <View style={styles.chronoItem}>
              <Text style={styles.chronoItemLabel}>Peak Focus</Text>
              <Text style={styles.chronoItemValue}>{analysis.chronotype.peakFocus}</Text>
            </View>
            <View style={styles.chronoItem}>
              <Text style={styles.chronoItemLabel}>Best Exercise</Text>
              <Text style={styles.chronoItemValue}>{analysis.chronotype.peakExercise}</Text>
            </View>
          </View>
        </View>

        {/* Optimal Times */}
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>Optimal Sleep Times</Text>
          <View style={styles.timeRow}>
            <View style={styles.timeItem}>
              <Ionicons name="moon" size={20} color={colors.accent.purple} />
              <Text style={styles.timeLabel}>Melatonin Window</Text>
              <Text style={styles.timeValue}>
                {analysis.circadian.melatoninWindowStart} - {analysis.circadian.melatoninWindowEnd}
              </Text>
            </View>
            <View style={styles.timeItem}>
              <Ionicons name="bed" size={20} color={colors.accent.blue} />
              <Text style={styles.timeLabel}>Optimal Bedtime</Text>
              <Text style={styles.timeValue}>{analysis.circadian.optimalBedtime}</Text>
            </View>
            <View style={styles.timeItem}>
              <Ionicons name="sunny" size={20} color={colors.accent.amber} />
              <Text style={styles.timeLabel}>Optimal Wake</Text>
              <Text style={styles.timeValue}>{analysis.circadian.optimalWakeTime}</Text>
            </View>
          </View>
        </View>

        {/* Social Jet Lag */}
        <View style={styles.card}>
          <View style={styles.hrvHeader}>
            <Text style={[styles.cardLabel, { color: sjlColor(analysis.socialJetLag.severity), marginBottom: 0 }]}>
              Social Jet Lag
            </Text>
            <View style={[styles.badge, { backgroundColor: sjlColor(analysis.socialJetLag.severity) + '33' }]}>
              <Text style={[styles.badgeText, { color: sjlColor(analysis.socialJetLag.severity) }]}>
                {analysis.socialJetLag.jetLagHours}h · {analysis.socialJetLag.severity}
              </Text>
            </View>
          </View>
          <Text style={styles.captionText}>{analysis.socialJetLag.recommendation}</Text>
        </View>

        {/* Caffeine Cutoff */}
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.amber }]}>Caffeine Cutoff</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Ionicons name="cafe" size={24} color={colors.accent.amber} />
            <Text style={styles.caffeineTime}>{analysis.caffeineCutoff.lastCaffeineTime}</Text>
          </View>
          <Text style={[styles.captionText, { marginTop: spacing.sm }]}>{analysis.caffeineCutoff.reason}</Text>
        </View>

        {/* Wind-Down Routine */}
        {windDownRoutine && windDownRoutine.steps && (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
              <Text style={[styles.cardLabel, { color: colors.accent.purple, marginBottom: 0 }]}>Tonight's Wind-Down</Text>
              <Text style={{ fontSize: 10, color: colors.text.muted }}>
                Bed: {windDownRoutine.optimalBedtime} | Melatonin: {windDownRoutine.melatoninWindow}
              </Text>
            </View>
            {windDownRoutine.steps.map((step, i) => {
              const iconMap: Record<string, string> = {
                dim: 'flashlight', phone: 'phone-portrait', shower: 'water',
                snack: 'cafe', stretch: 'leaf', read: 'book', bed: 'bed',
              }
              const isLast = i === windDownRoutine.steps.length - 1
              return (
                <View key={i} style={{
                  flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
                  paddingVertical: spacing.sm, borderBottomWidth: isLast ? 0 : 0.5,
                  borderBottomColor: colors.border,
                }}>
                  <View style={{
                    width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: isLast ? colors.accent.purple + '22' : colors.bg.tertiary,
                  }}>
                    <Ionicons name={(iconMap[step.icon] || 'time') as any} size={16}
                      color={isLast ? colors.accent.purple : colors.text.muted} />
                  </View>
                  <Text style={{
                    fontSize: 13, fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                    color: isLast ? colors.accent.purple : colors.text.primary, width: 60,
                  }}>{step.time}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: isLast ? colors.accent.purple : colors.text.primary }}>
                      {step.activity}
                    </Text>
                    <Text style={{ fontSize: 10, color: colors.text.muted, marginTop: 1 }}>{step.description}</Text>
                  </View>
                </View>
              )
            })}
          </View>
        )}

        {/* Sleep Calculator */}
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.blue }]}>Sleep Calculator</Text>
          <Text style={styles.captionText}>
            Plan either when to wake up from a bedtime, or when to go to sleep for a wake time.
          </Text>

          <View style={styles.calcModeRow}>
            <TouchableOpacity
              style={[styles.calcModeBtn, calcMode === 'wake' && { backgroundColor: colors.accent.green }]}
              onPress={() => setCalcMode('wake')}
            >
              <Text style={[styles.calcModeText, calcMode === 'wake' && styles.calcModeTextActive]}>Wake up</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.calcModeBtn, calcMode === 'bed' && { backgroundColor: colors.accent.purple }]}
              onPress={() => setCalcMode('bed')}
            >
              <Text style={[styles.calcModeText, calcMode === 'bed' && styles.calcModeTextActive]}>Go to sleep</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.latencyRow}>
            <Text style={styles.latencyLabel}>Fall asleep in</Text>
            {[5, 15, 30, 45].map((min) => (
              <TouchableOpacity
                key={min}
                style={[styles.latencyBtn, sleepLatency === min && styles.latencyBtnActive]}
                onPress={() => setSleepLatency(min)}
              >
                <Text style={[styles.latencyText, sleepLatency === min && styles.latencyTextActive]}>{min}m</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.wakeCalcRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.calcInputLabel}>{calcMode === 'wake' ? 'Bedtime' : 'Wake time'}</Text>
              <TextInput
                style={styles.wakeCalcInput}
                value={calcMode === 'wake' ? wakeCalcBedtime : bedCalcWakeTime}
                onChangeText={calcMode === 'wake' ? setWakeCalcBedtime : setBedCalcWakeTime}
                placeholder={calcMode === 'wake' ? '23:00' : '07:00'}
                placeholderTextColor={colors.text.muted}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <TouchableOpacity
              style={[styles.wakeCalcBtn, { backgroundColor: calcMode === 'wake' ? colors.accent.green : colors.accent.purple }]}
              onPress={calcMode === 'wake' ? handleWakeCalc : handleBedCalc}
            >
              <Text style={styles.wakeCalcBtnText}>Calculate</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.calcQuickRow}>
            {calcMode === 'wake' && analysis?.circadian?.optimalBedtime && (
              <TouchableOpacity style={styles.quickBtn} onPress={() => setWakeCalcBedtime(analysis?.circadian?.optimalBedtime || wakeCalcBedtime)}>
                <Text style={[styles.quickBtnText, { color: colors.accent.purple }]}>Optimal bed</Text>
              </TouchableOpacity>
            )}
            {calcMode === 'bed' && analysis?.circadian?.optimalWakeTime && (
              <TouchableOpacity style={styles.quickBtn} onPress={() => setBedCalcWakeTime(analysis?.circadian?.optimalWakeTime || bedCalcWakeTime)}>
                <Text style={[styles.quickBtnText, { color: colors.accent.green }]}>Optimal wake</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.quickBtn} onPress={() => {
              const now = formatClockMinutes(new Date().getHours() * 60 + new Date().getMinutes())
              if (calcMode === 'wake') setWakeCalcBedtime(now)
              else setBedCalcWakeTime(now)
            }}>
              <Text style={[styles.quickBtnText, { color: colors.accent.blue }]}>Now</Text>
            </TouchableOpacity>
          </View>

          {calcPlan.length > 0 && (
            <View style={styles.cyclePlanRow}>
              {calcPlan.map((plan) => (
                <TouchableOpacity
                  key={plan.cycles}
                  style={[styles.cyclePlanCard, plan.isRecommended && styles.cyclePlanCardRecommended]}
                  onPress={() => {
                    const resultText = `${plan.isRecommended ? 'Optimal' : `${plan.cycles} cycles`}: ${plan.time}\n` +
                      `${plan.cycles} sleep cycles gives about ${plan.hours.toFixed(1)}h asleep after ${sleepLatency}m to fall asleep.`
                    if (calcMode === 'wake') setWakeCalcResult(resultText)
                    else setBedCalcResult(resultText.replace('Optimal:', 'Optimal bedtime:'))
                  }}
                >
                  <Text style={[styles.cyclePlanLabel, plan.isRecommended && { color: colors.accent.green }]}>
                    {plan.cycles} cycles
                  </Text>
                  <Text style={styles.cyclePlanTime}>{plan.time}</Text>
                  <Text style={styles.cyclePlanHours}>{plan.hours.toFixed(1)}h</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {calcMode === 'wake' ? (
            wakeCalcResult && <Text style={[styles.captionText, { marginTop: spacing.sm }]}>{wakeCalcResult}</Text>
          ) : (
            bedCalcResult && <Text style={[styles.captionText, { marginTop: spacing.sm }]}>{bedCalcResult}</Text>
          )}
        </View>

        {/* Recommendations */}
        {analysis.quality && analysis.quality.recommendations.length > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.green }]}>Recommendations</Text>
            {analysis.quality.recommendations.map((rec, i) => (
              <View key={i} style={styles.recRow}>
                <Ionicons name="checkmark-circle" size={16} color={colors.accent.green} />
                <Text style={styles.recText}>{rec}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Sleep Need Profile */}
        {sleepNeedProfile && (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Ionicons name="bed" size={16} color={colors.accent.green} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text.primary }}>Your Sleep Need</Text>
                <View style={{
                  paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
                  backgroundColor: sleepNeedProfile.confidence === 'high' ? colors.accent.green + '22'
                    : sleepNeedProfile.confidence === 'medium' ? colors.accent.blue + '22'
                    : colors.accent.amber + '22',
                }}>
                  <Text style={{
                    fontSize: 10, fontWeight: '600',
                    color: sleepNeedProfile.confidence === 'high' ? colors.accent.green
                      : sleepNeedProfile.confidence === 'medium' ? colors.accent.blue
                      : colors.accent.amber,
                  }}>{sleepNeedProfile.confidence}</Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => setShowSleepNeedDetail(!showSleepNeedDetail)}
                style={{ backgroundColor: colors.bg.tertiary, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 }}
              >
                <Text style={{ fontSize: 11, color: colors.accent.blue }}>{showSleepNeedDetail ? 'Show Less' : 'Learn More'}</Text>
              </TouchableOpacity>
            </View>

            {/* Summary grid */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md }}>
              <View style={{ flex: 1, minWidth: '45%', backgroundColor: colors.bg.tertiary, borderRadius: 10, padding: spacing.sm, alignItems: 'center' }}>
                <Text style={{ fontSize: 10, color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Estimated Need</Text>
                <Text style={{ fontSize: 24, fontWeight: '700', color: colors.accent.green, marginTop: 4 }}>
                  {sleepNeedProfile.estimatedNeed}<Text style={{ fontSize: 14, fontWeight: '400' }}>h</Text>
                </Text>
                <Text style={{ fontSize: 10, color: colors.text.muted }}>{sleepNeedProfile.classification}</Text>
              </View>
              <View style={{ flex: 1, minWidth: '45%', backgroundColor: colors.bg.tertiary, borderRadius: 10, padding: spacing.sm, alignItems: 'center' }}>
                <Text style={{ fontSize: 10, color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Chronotype</Text>
                <Text style={{ fontSize: 18, fontWeight: '600', color: colors.accent.purple, marginTop: 4, textTransform: 'capitalize' }}>
                  {sleepNeedProfile.chronotype}
                </Text>
                <Text style={{ fontSize: 10, color: colors.text.muted }}>
                  {sleepNeedProfile.userAge ? `Age ${sleepNeedProfile.userAge} · ` : ''}{sleepNeedProfile.dataPoints} nights
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: '45%', backgroundColor: colors.bg.tertiary, borderRadius: 10, padding: spacing.sm, alignItems: 'center' }}>
                <Text style={{ fontSize: 10, color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Weekday Avg</Text>
                <Text style={{
                  fontSize: 18, fontWeight: '600', marginTop: 4,
                  color: sleepNeedProfile.weekdayAvg >= sleepNeedProfile.estimatedNeed ? colors.accent.green : colors.accent.amber,
                }}>
                  {sleepNeedProfile.weekdayAvg}<Text style={{ fontSize: 14, fontWeight: '400' }}>h</Text>
                </Text>
                <Text style={{ fontSize: 10, color: colors.text.muted }}>
                  {sleepNeedProfile.weekdayAvg >= sleepNeedProfile.estimatedNeed ? 'Meeting need' : `${(sleepNeedProfile.estimatedNeed - sleepNeedProfile.weekdayAvg).toFixed(1)}h short`}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: '45%', backgroundColor: colors.bg.tertiary, borderRadius: 10, padding: spacing.sm, alignItems: 'center' }}>
                <Text style={{ fontSize: 10, color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Weekend Avg</Text>
                <Text style={{
                  fontSize: 18, fontWeight: '600', marginTop: 4,
                  color: sleepNeedProfile.weekendAvg >= sleepNeedProfile.estimatedNeed ? colors.accent.green : colors.accent.amber,
                }}>
                  {sleepNeedProfile.weekendAvg}<Text style={{ fontSize: 14, fontWeight: '400' }}>h</Text>
                </Text>
                <Text style={{ fontSize: 10, color: colors.text.muted }}>
                  {sleepNeedProfile.weekendAvg >= sleepNeedProfile.estimatedNeed ? 'Meeting need' : `${(sleepNeedProfile.estimatedNeed - sleepNeedProfile.weekendAvg).toFixed(1)}h short`}
                </Text>
              </View>
            </View>

            {/* Sleep debt impact */}
            <Text style={{ fontSize: 12, color: colors.text.secondary, lineHeight: 18, marginBottom: spacing.sm }}>
              {sleepNeedProfile.sleepDebtImpact}
            </Text>

            {/* Expanded detail */}
            {showSleepNeedDetail && (
              <View style={{ borderTopWidth: 0.5, borderTopColor: colors.border, paddingTop: spacing.md }}>
                {/* Best vs Worst nights */}
                <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md }}>
                  <View style={{ flex: 1, backgroundColor: colors.accent.green + '0D', borderRadius: 10, padding: spacing.sm }}>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: colors.accent.green, textTransform: 'uppercase', letterSpacing: 0.5 }}>Best Nights (top 30%)</Text>
                    <Text style={{ fontSize: 18, fontWeight: '600', color: colors.text.primary, marginTop: 4 }}>
                      {sleepNeedProfile.bestNights.avgHours}h avg
                    </Text>
                    <Text style={{ fontSize: 10, color: colors.text.muted, marginTop: 2 }}>
                      Deep: {sleepNeedProfile.bestNights.avgDeepPct}% · REM: {sleepNeedProfile.bestNights.avgRemPct}% · {sleepNeedProfile.bestNights.count} nights
                    </Text>
                  </View>
                  <View style={{ flex: 1, backgroundColor: colors.accent.red + '0D', borderRadius: 10, padding: spacing.sm }}>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: colors.accent.red, textTransform: 'uppercase', letterSpacing: 0.5 }}>Worst Nights (bottom 30%)</Text>
                    <Text style={{ fontSize: 18, fontWeight: '600', color: colors.text.primary, marginTop: 4 }}>
                      {sleepNeedProfile.worstNights.avgHours}h avg
                    </Text>
                    <Text style={{ fontSize: 10, color: colors.text.muted, marginTop: 2 }}>
                      Deep: {sleepNeedProfile.worstNights.avgDeepPct}% · REM: {sleepNeedProfile.worstNights.avgRemPct}% · {sleepNeedProfile.worstNights.count} nights
                    </Text>
                  </View>
                </View>

                {/* You vs Population */}
                {sleepNeedProfile.comparison && (
                  <View style={{ marginBottom: spacing.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                      <Ionicons name="people" size={14} color={colors.accent.cyan} />
                      <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text.primary }}>You vs Average Adult</Text>
                    </View>
                    {/* Table header */}
                    <View style={{
                      flexDirection: 'row', backgroundColor: colors.bg.tertiary, borderTopLeftRadius: 8, borderTopRightRadius: 8,
                      paddingVertical: 6, paddingHorizontal: spacing.sm,
                    }}>
                      <Text style={{ flex: 1, fontSize: 10, fontWeight: '600', color: colors.text.muted }}>Metric</Text>
                      <Text style={{ width: 55, fontSize: 10, fontWeight: '600', color: colors.accent.purple, textAlign: 'center' }}>You</Text>
                      <Text style={{ width: 55, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'center' }}>
                        {sleepNeedProfile.comparison.population.ageGroup ? `Avg (${sleepNeedProfile.comparison.population.ageGroup})` : 'US Avg'}
                      </Text>
                      <Text style={{ width: 50, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'center' }}>Diff</Text>
                    </View>
                    {/* Table rows */}
                    {[
                      { label: 'Duration', you: sleepNeedProfile.comparison.you.avgDuration, pop: sleepNeedProfile.comparison.population.avgDuration, unit: 'h' },
                      { label: 'Deep Sleep', you: sleepNeedProfile.comparison.you.avgDeepPct, pop: sleepNeedProfile.comparison.population.avgDeepPct, unit: '%' },
                      { label: 'REM Sleep', you: sleepNeedProfile.comparison.you.avgRemPct, pop: sleepNeedProfile.comparison.population.avgRemPct, unit: '%' },
                      { label: 'Efficiency', you: sleepNeedProfile.comparison.you.avgEfficiency, pop: sleepNeedProfile.comparison.population.avgEfficiency, unit: '%' },
                    ].map((row, i) => {
                      const diff = row.you - row.pop
                      const isGood = diff >= 0
                      return (
                        <View key={row.label} style={{
                          flexDirection: 'row', paddingVertical: 6, paddingHorizontal: spacing.sm,
                          borderTopWidth: 0.5, borderTopColor: colors.border,
                        }}>
                          <Text style={{ flex: 1, fontSize: 11, color: colors.text.secondary }}>{row.label}</Text>
                          <Text style={{ width: 55, fontSize: 11, color: colors.text.primary, textAlign: 'center', fontWeight: '600', fontFamily: 'monospace' }}>
                            {row.you}{row.unit}
                          </Text>
                          <Text style={{ width: 55, fontSize: 11, color: colors.text.muted, textAlign: 'center', fontFamily: 'monospace' }}>
                            {row.pop}{row.unit}
                          </Text>
                          <Text style={{
                            width: 50, fontSize: 11, textAlign: 'center', fontWeight: '600', fontFamily: 'monospace',
                            color: Math.abs(diff) < 1 ? colors.text.muted : isGood ? colors.accent.green : colors.accent.red,
                          }}>
                            {diff > 0 ? '+' : ''}{diff.toFixed(1)}{row.unit}
                          </Text>
                        </View>
                      )
                    })}
                    <View style={{
                      backgroundColor: colors.bg.tertiary, borderBottomLeftRadius: 8, borderBottomRightRadius: 8,
                      paddingVertical: 4, paddingHorizontal: spacing.sm,
                    }}>
                      <Text style={{ fontSize: 9, color: colors.text.muted, fontStyle: 'italic' }}>
                        Population data: Ohayon et al. 2004, CDC BRFSS 2020.
                        {sleepNeedProfile.userAge ? ` Age-adjusted for ${sleepNeedProfile.comparison.population.ageGroup}.` : ' Set age in Settings for age-adjusted norms.'}
                      </Text>
                    </View>
                  </View>
                )}

                {/* Insights */}
                <View style={{ marginBottom: spacing.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                    <Ionicons name="bulb" size={14} color={colors.accent.amber} />
                    <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text.primary }}>Analysis</Text>
                  </View>
                  {sleepNeedProfile.insights.map((insight, i) => (
                    <Text key={i} style={{ fontSize: 12, color: colors.text.secondary, lineHeight: 18, marginBottom: spacing.sm, paddingLeft: spacing.md }}>
                      {insight}
                    </Text>
                  ))}
                </View>

                {/* Scientific references */}
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                    <Ionicons name="book" size={14} color={colors.accent.blue} />
                    <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text.primary }}>Research</Text>
                  </View>
                  {sleepNeedProfile.references.map((ref, i) => (
                    <View key={i} style={{ backgroundColor: colors.bg.tertiary, borderRadius: 8, padding: spacing.sm, marginBottom: spacing.sm }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text.primary }}>{ref.title}</Text>
                      <Text style={{ fontSize: 11, color: colors.text.secondary, lineHeight: 16, marginTop: 4 }}>{ref.finding}</Text>
                      <Text style={{ fontSize: 10, color: colors.text.muted, fontStyle: 'italic', marginTop: 4 }}>{ref.source}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </View>
        )}
      </>
    )
  }

  // === EXERCISE TAB ===
  function renderExercise() {
    const today = exerciseData.length > 0 ? exerciseData[exerciseData.length - 1] : null
    const weekData = exerciseData.slice(-7)
    const weekAvgSteps = weekData.length > 0 ? Math.round(weekData.reduce((s, d) => s + d.steps, 0) / weekData.length) : 0
    const weekTotalEnergy = weekData.reduce((s, d) => s + d.activeEnergy, 0)
    const weekTotalExercise = weekData.reduce((s, d) => s + d.exerciseTime, 0)
    const maxSteps = Math.max(...exerciseData.map(d => d.steps), 1)

    return (
      <View>
        {/* Workouts history link */}
        <TouchableOpacity
          onPress={() => navigation?.navigate('ExerciseHistory')}
          style={[styles.historyLink, { backgroundColor: colors.accent.green + '15', marginBottom: spacing.md }]}
        >
          <Ionicons name="barbell" size={14} color={colors.accent.green} />
          <Text style={[styles.historyLinkText, { color: colors.accent.green }]}>Workout history</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.accent.green} />
        </TouchableOpacity>

        {/* Today's Stats */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Today</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
            <ExerciseStat icon="footsteps" label="Steps" value={today?.steps?.toLocaleString() || '—'} color={colors.accent.green} />
            <ExerciseStat icon="flame" label="Active Cal" value={today?.activeEnergy ? `${today.activeEnergy}` : '—'} color={colors.accent.red} />
            <ExerciseStat icon="timer" label="Exercise" value={today?.exerciseTime ? `${today.exerciseTime} min` : '—'} color={colors.accent.blue} />
            <ExerciseStat icon="navigate" label="Distance" value={today?.distance ? `${today.distance} mi` : '—'} color={colors.accent.purple} />
            <ExerciseStat icon="trending-up" label="Flights" value={today?.flights ? `${today.flights}` : '—'} color={colors.accent.amber} />
            <ExerciseStat icon="pulse" label="VO2 Max" value={latestVO2 ? `${latestVO2.toFixed(1)}` : '—'} color={colors.accent.green} />
          </View>
        </View>

        {/* Weekly Summary */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>This Week</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginBottom: spacing.md }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '700', color: colors.accent.green }}>{weekAvgSteps.toLocaleString()}</Text>
              <Text style={{ fontSize: 12, color: colors.text.muted }}>avg steps/day</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '700', color: colors.accent.red }}>{weekTotalEnergy.toLocaleString()}</Text>
              <Text style={{ fontSize: 12, color: colors.text.muted }}>total calories</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '700', color: colors.accent.blue }}>{weekTotalExercise}</Text>
              <Text style={{ fontSize: 12, color: colors.text.muted }}>total min</Text>
            </View>
          </View>
        </View>

        {/* Steps Chart (last 30 days) */}
        {exerciseData.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Daily Steps (30 days)</Text>
            <View style={{ height: 120, flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginTop: spacing.sm }}>
              {exerciseData.map((d, i) => {
                const height = Math.max(2, (d.steps / maxSteps) * 110)
                const isToday = i === exerciseData.length - 1
                return (
                  <View key={d.date} style={{ flex: 1, alignItems: 'center' }}>
                    <View style={{
                      width: '100%', height, borderRadius: 2,
                      backgroundColor: isToday ? colors.accent.green : colors.accent.green + '55',
                    }} />
                  </View>
                )
              })}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs }}>
              <Text style={{ fontSize: 10, color: colors.text.muted }}>{exerciseData[0]?.date.slice(5)}</Text>
              <Text style={{ fontSize: 10, color: colors.text.muted }}>{exerciseData[exerciseData.length - 1]?.date.slice(5)}</Text>
            </View>
          </View>
        )}

        {/* Fitness Analysis */}
        {fitnessAnalysis && (
          <>
            {/* Fitness Score + Profile */}
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Fitness Profile</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm }}>
                <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: fitnessAnalysis.profile.fitnessScore >= 70 ? colors.accent.green + '20' : fitnessAnalysis.profile.fitnessScore >= 45 ? colors.accent.amber + '20' : colors.accent.red + '20', justifyContent: 'center', alignItems: 'center' }}>
                  <Text style={{ fontSize: 22, fontWeight: '700', color: fitnessAnalysis.profile.fitnessScore >= 70 ? colors.accent.green : fitnessAnalysis.profile.fitnessScore >= 45 ? colors.accent.amber : colors.accent.red }}>
                    {fitnessAnalysis.profile.fitnessScore}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text.primary }}>{fitnessAnalysis.profile.fitnessLevel}</Text>
                  <Text style={{ fontSize: 12, color: colors.text.muted }}>
                    {fitnessAnalysis.profile.weeklyExerciseMinutes}min exercise · {fitnessAnalysis.profile.exerciseConsistencyPct}% consistency
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {fitnessAnalysis.profile.vo2Max && (
                  <View style={{ backgroundColor: colors.accent.green + '12', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>
                    <Text style={{ fontSize: 11, color: colors.text.muted }}>VO2 Max</Text>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.accent.green }}>{fitnessAnalysis.profile.vo2Max.toFixed(1)}</Text>
                    <Text style={{ fontSize: 10, color: colors.text.muted }}>{fitnessAnalysis.profile.vo2Category} {fitnessAnalysis.profile.vo2Trend === 'improving' ? '↑' : fitnessAnalysis.profile.vo2Trend === 'declining' ? '↓' : ''}</Text>
                  </View>
                )}
                {fitnessAnalysis.profile.restingHr && (
                  <View style={{ backgroundColor: colors.accent.red + '12', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>
                    <Text style={{ fontSize: 11, color: colors.text.muted }}>Resting HR</Text>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.accent.red }}>{fitnessAnalysis.profile.restingHr} bpm</Text>
                    <Text style={{ fontSize: 10, color: colors.text.muted }}>{fitnessAnalysis.profile.rhrCategory} {fitnessAnalysis.profile.rhrTrend === 'improving' ? '↑' : fitnessAnalysis.profile.rhrTrend === 'worsening' ? '↓' : ''}</Text>
                  </View>
                )}
                {fitnessAnalysis.profile.hrvBaseline && (
                  <View style={{ backgroundColor: colors.accent.purple + '12', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>
                    <Text style={{ fontSize: 11, color: colors.text.muted }}>HRV</Text>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.accent.purple }}>{fitnessAnalysis.profile.hrvCurrent ?? fitnessAnalysis.profile.hrvBaseline} ms</Text>
                    <Text style={{ fontSize: 10, color: colors.text.muted }}>baseline {fitnessAnalysis.profile.hrvBaseline} {fitnessAnalysis.profile.hrvTrend === 'improving' ? '↑' : fitnessAnalysis.profile.hrvTrend === 'declining' ? '↓' : ''}</Text>
                  </View>
                )}
              </View>
            </View>

            {/* Training Load (Banister Model) */}
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Training Load</Text>
              <View style={{ backgroundColor: statusColor(fitnessAnalysis.trainingLoad.trainingStatus) + '15', padding: spacing.sm, borderRadius: 8, marginBottom: spacing.sm }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: statusColor(fitnessAnalysis.trainingLoad.trainingStatus) }}>
                  {fitnessAnalysis.trainingLoad.trainingStatusLabel}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 20, fontWeight: '700', color: colors.accent.blue }}>{fitnessAnalysis.trainingLoad.ctl.toFixed(0)}</Text>
                  <Text style={{ fontSize: 11, color: colors.text.muted }}>Fitness (CTL)</Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 20, fontWeight: '700', color: colors.accent.red }}>{fitnessAnalysis.trainingLoad.atl.toFixed(0)}</Text>
                  <Text style={{ fontSize: 11, color: colors.text.muted }}>Fatigue (ATL)</Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 20, fontWeight: '700', color: fitnessAnalysis.trainingLoad.tsb >= 0 ? colors.accent.green : colors.accent.amber }}>
                    {fitnessAnalysis.trainingLoad.tsb > 0 ? '+' : ''}{fitnessAnalysis.trainingLoad.tsb.toFixed(0)}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.text.muted }}>Form (TSB)</Text>
                </View>
              </View>
              {/* Mini CTL/ATL/TSB chart */}
              {fitnessAnalysis.trainingLoad.history.length > 7 && (
                <View style={{ height: 60, flexDirection: 'row', alignItems: 'flex-end', gap: 1, marginTop: spacing.md }}>
                  {fitnessAnalysis.trainingLoad.history.slice(-30).map((h, i) => {
                    const maxVal = Math.max(...fitnessAnalysis!.trainingLoad.history.slice(-30).map(d => Math.max(d.ctl, d.atl)), 1)
                    return (
                      <View key={i} style={{ flex: 1, alignItems: 'center' }}>
                        <View style={{ width: '100%', height: Math.max(1, (h.ctl / maxVal) * 55), backgroundColor: colors.accent.blue + '60', borderRadius: 1 }} />
                      </View>
                    )
                  })}
                </View>
              )}
            </View>

            {/* Recovery */}
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Recovery</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm }}>
                <View style={{ width: 50, height: 50, borderRadius: 25, borderWidth: 3, borderColor: recoveryColor(fitnessAnalysis.recovery.recoveryStatus), justifyContent: 'center', alignItems: 'center' }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: recoveryColor(fitnessAnalysis.recovery.recoveryStatus) }}>
                    {fitnessAnalysis.recovery.recoveryScore}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text.primary, textTransform: 'capitalize' }}>
                    {fitnessAnalysis.recovery.recoveryStatus}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors.text.muted }}>
                    {fitnessAnalysis.recovery.readinessToTrain ? 'Ready to train' : 'Rest recommended'} · ~{fitnessAnalysis.recovery.estimatedRecoveryHours}h to full recovery
                  </Text>
                </View>
              </View>
              {fitnessAnalysis.recovery.factors.map(f => (
                <View key={f.name} style={{ marginBottom: spacing.xs }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                    <Text style={{ fontSize: 12, color: colors.text.secondary }}>{f.name}</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: f.score >= 65 ? colors.accent.green : f.score >= 40 ? colors.accent.amber : colors.accent.red }}>{f.score}/100</Text>
                  </View>
                  <View style={{ height: 4, backgroundColor: colors.border, borderRadius: 2 }}>
                    <View style={{ height: 4, width: `${f.score}%`, backgroundColor: f.score >= 65 ? colors.accent.green : f.score >= 40 ? colors.accent.amber : colors.accent.red, borderRadius: 2 }} />
                  </View>
                  <Text style={{ fontSize: 10, color: colors.text.muted, marginTop: 1 }}>{f.observation}</Text>
                </View>
              ))}
              {fitnessAnalysis.recovery.sleepRecommendation.trainingAdjustment > 0 && (
                <View style={{ marginTop: spacing.sm, backgroundColor: colors.accent.purple + '12', padding: spacing.sm, borderRadius: 8 }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: colors.accent.purple }}>
                    Sleep need: {fitnessAnalysis.recovery.sleepRecommendation.totalRecommended}h
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.text.muted, marginTop: 2 }}>
                    {fitnessAnalysis.recovery.sleepRecommendation.reasoning}
                  </Text>
                </View>
              )}
            </View>

            {/* Insights */}
            {fitnessAnalysis.insights.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Insights</Text>
                {fitnessAnalysis.insights.map((ins, i) => (
                  <Text key={i} style={{ fontSize: 12, color: colors.text.secondary, marginBottom: spacing.xs, lineHeight: 18 }}>
                    {ins}
                  </Text>
                ))}
              </View>
            )}
          </>
        )}

        {/* Daily Exercise Log (detailed table) */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Daily Log ({exerciseData.length} days)</Text>
          {exerciseData.length > 0 && (
            <>
              {/* Table header */}
              <View style={{ flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: colors.border }}>
                <Text style={{ width: 48, fontSize: 10, fontWeight: '600', color: colors.text.muted }}>Date</Text>
                <Text style={{ flex: 1, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Steps</Text>
                <Text style={{ flex: 1, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Cal</Text>
                <Text style={{ width: 40, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Exer</Text>
                <Text style={{ width: 42, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Dist</Text>
                <Text style={{ width: 28, fontSize: 10, fontWeight: '600', color: colors.text.muted, textAlign: 'right' }}>Fl</Text>
              </View>
              {exerciseData.slice().reverse().slice(0, 30).map(d => {
                const stepColor = d.steps >= 10000 ? colors.accent.green : d.steps >= 7000 ? colors.accent.amber : colors.text.secondary
                return (
                  <View key={d.date} style={{
                    flexDirection: 'row', alignItems: 'center', paddingVertical: 5,
                    borderBottomWidth: 0.5, borderBottomColor: colors.border,
                  }}>
                    <Text style={{ width: 48, fontSize: 11, color: colors.text.secondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                      {d.date.slice(5)}
                    </Text>
                    <Text style={{ flex: 1, fontSize: 11, fontWeight: '600', color: stepColor, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                      {d.steps > 999 ? `${(d.steps / 1000).toFixed(1)}k` : d.steps}
                    </Text>
                    <Text style={{ flex: 1, fontSize: 11, color: colors.accent.red, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                      {d.activeEnergy || '--'}
                    </Text>
                    <Text style={{ width: 40, fontSize: 11, color: d.exerciseTime > 0 ? colors.accent.blue : colors.text.muted, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                      {d.exerciseTime > 0 ? `${d.exerciseTime}m` : '--'}
                    </Text>
                    <Text style={{ width: 42, fontSize: 11, color: colors.text.secondary, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                      {d.distance > 0 ? `${d.distance}` : '--'}
                    </Text>
                    <Text style={{ width: 28, fontSize: 11, color: colors.text.secondary, textAlign: 'right', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                      {d.flights > 0 ? d.flights : '--'}
                    </Text>
                  </View>
                )
              })}
            </>
          )}
          {exerciseData.length === 0 && (
            <Text style={{ fontSize: 13, color: colors.text.muted, textAlign: 'center', paddingVertical: spacing.lg }}>
              No exercise data yet. Sync from your relay server.
            </Text>
          )}
        </View>
      </View>
    )
  }

  // === TRENDS TAB ===
  function renderTrends() {
    if (!trends || Object.keys(trends.trends).length === 0) {
      return (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No historical data yet. Export from Health Auto Export to see trends over time.
          </Text>
        </View>
      )
    }

    const { summary } = trends
    const sleepTrend = trends.trends.sleep || []
    const hrvTrend = trends.trends.hrv || []
    const stepsTrend = trends.trends.steps || []
    const rhrTrend = trends.trends.resting_heart_rate || []

    return (
      <>
        {/* Summary Banner */}
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.cyan }]}>Historical Overview</Text>
          <View style={styles.trendSummaryRow}>
            <View style={styles.trendStat}>
              <Text style={styles.trendStatValue}>{summary.totalMonths}</Text>
              <Text style={styles.trendStatLabel}>months</Text>
            </View>
            <View style={styles.trendStat}>
              <Text style={styles.trendStatValue}>{(summary.totalDataPoints / 1000).toFixed(1)}k</Text>
              <Text style={styles.trendStatLabel}>data points</Text>
            </View>
            <View style={styles.trendStat}>
              <Text style={styles.trendStatValue}>{summary.metricTypes.length}</Text>
              <Text style={styles.trendStatLabel}>metrics</Text>
            </View>
          </View>
          {summary.sleepTrendDirection && (
            <View style={[styles.trendDirectionBadge, {
              backgroundColor: summary.sleepTrendDirection === 'improving' ? colors.accent.green + '22'
                : summary.sleepTrendDirection === 'declining' ? colors.accent.red + '22'
                : colors.accent.amber + '22'
            }]}>
              <Ionicons
                name={summary.sleepTrendDirection === 'improving' ? 'trending-up' : summary.sleepTrendDirection === 'declining' ? 'trending-down' : 'remove'}
                size={16}
                color={summary.sleepTrendDirection === 'improving' ? colors.accent.green : summary.sleepTrendDirection === 'declining' ? colors.accent.red : colors.accent.amber}
              />
              <Text style={[styles.trendDirectionText, {
                color: summary.sleepTrendDirection === 'improving' ? colors.accent.green
                  : summary.sleepTrendDirection === 'declining' ? colors.accent.red
                  : colors.accent.amber
              }]}>
                Sleep {summary.sleepTrendDirection}: {summary.recentAvgSleep ? (summary.recentAvgSleep / 60).toFixed(1) : '--'}h/night recently
                {summary.oldestAvgSleep ? ` vs ${(summary.oldestAvgSleep / 60).toFixed(1)}h earlier` : ''}
              </Text>
            </View>
          )}
        </View>

        {/* Insights */}
        {trendInsights.length > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.blue }]}>Key Insights</Text>
            {trendInsights.map((insight, i) => (
              <View key={i} style={styles.insightRow}>
                <Ionicons
                  name={insight.direction === 'up' ? 'trending-up' : 'trending-down'}
                  size={18}
                  color={insight.severity === 'good' ? colors.accent.green : insight.severity === 'bad' ? colors.accent.red : colors.accent.amber}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.insightTitle, {
                    color: insight.severity === 'good' ? colors.accent.green : insight.severity === 'bad' ? colors.accent.red : colors.accent.amber
                  }]}>{insight.title}</Text>
                  <Text style={styles.captionText}>{insight.detail}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Sleep Duration Trend */}
        {sleepTrend.length > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>
              Sleep Duration ({sleepTrend.length} months)
            </Text>
            <TrendChart
              data={sleepTrend}
              getValue={d => d.avg / 60}
              formatValue={v => `${v.toFixed(1)}h`}
              color={colors.accent.purple}
              targetMin={7}
              targetMax={9}
            />
          </View>
        )}

        {/* Sleep Stages Trend */}
        {sleepTrend.length > 0 && sleepTrend[0].avgDeep !== undefined && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: '#6366f1' }]}>
              Sleep Stages Over Time
            </Text>
            {sleepTrend.slice(-12).map((m, i) => {
              const total = (m.avgDeep || 0) + (m.avgRem || 0) + (m.avgCore || 0)
              if (total === 0) return null
              return (
                <View key={i} style={styles.stagesTrendRow}>
                  <Text style={styles.stagesTrendMonth}>{formatMonthShort(m.month)}</Text>
                  <View style={styles.stagesTrendBar}>
                    {(m.avgDeep || 0) > 0 && (
                      <View style={[styles.stageSegment, {
                        flex: m.avgDeep! / total,
                        backgroundColor: '#6366f1',
                        borderTopLeftRadius: 4, borderBottomLeftRadius: 4,
                      }]} />
                    )}
                    {(m.avgCore || 0) > 0 && (
                      <View style={[styles.stageSegment, {
                        flex: m.avgCore! / total,
                        backgroundColor: '#818cf8',
                      }]} />
                    )}
                    {(m.avgRem || 0) > 0 && (
                      <View style={[styles.stageSegment, {
                        flex: m.avgRem! / total,
                        backgroundColor: '#a78bfa',
                        borderTopRightRadius: 4, borderBottomRightRadius: 4,
                      }]} />
                    )}
                  </View>
                  <Text style={styles.stagesTrendTotal}>{Math.round(total)}m</Text>
                </View>
              )
            })}
            <View style={[styles.stageLabels, { marginTop: spacing.sm }]}>
              <StageLabel color="#6366f1" label="Deep" mins={0} total={0} />
              <StageLabel color="#818cf8" label="Core" mins={0} total={0} />
              <StageLabel color="#a78bfa" label="REM" mins={0} total={0} />
            </View>
          </View>
        )}

        {/* HRV Trend */}
        {hrvTrend.length > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.blue }]}>
              HRV ({hrvTrend.length} months)
            </Text>
            <TrendChart
              data={hrvTrend}
              getValue={d => d.avg}
              formatValue={v => `${Math.round(v)}ms`}
              color={colors.accent.blue}
            />
          </View>
        )}

        {/* Steps Trend */}
        {stepsTrend.length > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.green }]}>
              Daily Steps ({stepsTrend.length} months)
            </Text>
            <TrendChart
              data={stepsTrend}
              getValue={d => d.avg}
              formatValue={v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`}
              color={colors.accent.green}
              targetMin={7000}
            />
          </View>
        )}

        {/* Resting Heart Rate Trend */}
        {rhrTrend.length > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.red }]}>
              Resting Heart Rate ({rhrTrend.length} months)
            </Text>
            <TrendChart
              data={rhrTrend}
              getValue={d => d.avg}
              formatValue={v => `${Math.round(v)}`}
              color={colors.accent.red}
              invertColor
            />
          </View>
        )}
      </>
    )
  }

  // === ENERGY TAB ===
  function renderEnergy() {
    if (!analysis) {
      return (
        <View style={styles.card}>
          <Text style={styles.emptyText}>Need sleep data for energy predictions. Sync from Apple Watch or relay.</Text>
        </View>
      )
    }

    return (
      <>
        {/* Process S/C Energy Curve */}
        {analysis.energyCurve && analysis.energyCurve.length > 0 && (
          <View style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.accent.blue }]}>Energy Prediction (Two-Process Model)</Text>
            <Text style={[styles.captionText, { marginBottom: spacing.md }]}>
              Based on Borbely's model: sleep pressure (Process S) vs circadian alerting (Process C)
            </Text>
            <EnergyCurveChart data={analysis.energyCurve} />
          </View>
        )}

        {/* Energy Phases Timeline */}
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.cyan }]}>Daily Energy Phases</Text>
          {analysis.circadian.energyPhases.map((phase, i) => (
            <View key={i} style={styles.phaseRow}>
              <View style={[styles.phaseIndicator, { backgroundColor: phaseColor(phase.level) }]} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.phaseName}>{phase.name}</Text>
                  <Text style={styles.phaseTime}>{phase.start} - {phase.end}</Text>
                </View>
                <Text style={styles.phaseDesc}>{phase.description}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Optimal Times Summary */}
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>Today's Optimal Schedule</Text>
          <OptimalTimeItem icon="sunny" label="Wake Up" time={analysis.circadian.optimalWakeTime} color={colors.accent.amber} />
          <OptimalTimeItem icon="cafe" label="Last Caffeine" time={analysis.caffeineCutoff.lastCaffeineTime} color={colors.accent.amber} />
          <OptimalTimeItem icon="moon" label="Melatonin Window" time={`${analysis.circadian.melatoninWindowStart}`} color={colors.accent.purple} />
          <OptimalTimeItem icon="bed" label="Bedtime" time={analysis.circadian.optimalBedtime} color={colors.accent.blue} />
          {analysis.chronotype && (
            <>
              <OptimalTimeItem icon="flash" label="Peak Focus" time={analysis.chronotype.peakFocus} color={colors.accent.green} />
              <OptimalTimeItem icon="barbell" label="Exercise" time={analysis.chronotype.peakExercise} color={colors.accent.red} />
            </>
          )}
        </View>

        {/* Wake recommendation */}
        <View style={styles.card}>
          <Text style={[styles.cardLabel, { color: colors.accent.blue }]}>Wake Time Recommendation</Text>
          <Text style={styles.captionText}>{analysis.wakeRecommendation.reasoning}</Text>
        </View>
      </>
    )
  }
}

// === COMPONENTS ===

function ScoreRing({ score, size, label }: { score: number; size: number; label: string }) {
  const scoreColor = score >= 80 ? colors.accent.green : score >= 60 ? colors.accent.amber : colors.accent.red
  const circumference = (size - 8) * Math.PI
  const progress = (score / 100) * circumference

  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', width: size, height: size }}>
      {/* Background circle */}
      <View style={{
        position: 'absolute', width: size, height: size, borderRadius: size / 2,
        borderWidth: 4, borderColor: colors.bg.tertiary,
      }} />
      {/* Progress arc (approximated with border) */}
      <View style={{
        position: 'absolute', width: size, height: size, borderRadius: size / 2,
        borderWidth: 4, borderColor: scoreColor,
        borderTopColor: score >= 25 ? scoreColor : 'transparent',
        borderRightColor: score >= 50 ? scoreColor : 'transparent',
        borderBottomColor: score >= 75 ? scoreColor : 'transparent',
        borderLeftColor: score >= 100 ? scoreColor : 'transparent',
        transform: [{ rotate: '-90deg' }],
      }} />
      <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text.primary }}>{score}</Text>
      <Text style={{ fontSize: 9, color: colors.text.muted, marginTop: -2 }}>{label}</Text>
    </View>
  )
}

function MiniScore({ label, score, color }: { label: string; score: number; color: string }) {
  return (
    <View style={styles.miniScoreItem}>
      <View style={styles.miniScoreBarBg}>
        <View style={[styles.miniScoreBarFill, { width: `${score}%`, backgroundColor: color }]} />
      </View>
      <View style={styles.miniScoreRow}>
        <Text style={styles.miniScoreLabel}>{label}</Text>
        <Text style={[styles.miniScoreValue, { color }]}>{score}</Text>
      </View>
    </View>
  )
}

function DebtGauge({ debt, category }: { debt: number; category: string }) {
  const maxDebt = 20
  const safeDebt = Number.isFinite(debt) ? debt : 0
  const pct = Math.min(Math.max(safeDebt / maxDebt, 0), 1) * 100
  const color = debtColor(category)
  return (
    <View>
      <View style={styles.debtGaugeBg}>
        <View style={[styles.debtGaugeFill, { width: `${pct}%`, backgroundColor: color }]} />
        {/* 5h marker */}
        <View style={[styles.debtMarker, { left: `${(5/maxDebt)*100}%` }]}>
          <View style={styles.debtMarkerLine} />
        </View>
      </View>
      <View style={styles.debtLabels}>
        <Text style={styles.debtLabelText}>0h</Text>
        <Text style={[styles.debtLabelText, { position: 'absolute', left: `${(5/maxDebt)*100}%` }]}>5h</Text>
        <Text style={styles.debtLabelText}>{maxDebt}h+</Text>
      </View>
    </View>
  )
}

function EnergyCurveChart({ data }: { data: EnergyCurvePoint[] }) {
  const chartWidth = SCREEN_WIDTH - spacing.lg * 2 - spacing.lg * 2
  const chartHeight = 120
  const maxVal = Math.max(...data.map(d => d.combined), 0.01)

  return (
    <View>
      <View style={[styles.chartContainer, { height: chartHeight }]}>
        {data.map((point, i) => {
          const barHeight = (point.combined / maxVal) * chartHeight
          const barWidth = chartWidth / data.length - 1
          return (
            <View key={i} style={{ alignItems: 'center', width: barWidth + 1 }}>
              <View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: energyBarColor(point.combined, maxVal),
                borderRadius: 2,
                position: 'absolute',
                bottom: 0,
              }} />
            </View>
          )
        })}
      </View>
      {/* Time labels — rounded to the nearest hour, 12-hour AM/PM */}
      <View style={styles.chartLabels}>
        {data.filter((_, i) => i % 4 === 0).map((point, i) => {
          const h = Math.round(point.hour) % 24
          const ampm = h < 12 ? 'AM' : 'PM'
          const h12 = h % 12 === 0 ? 12 : h % 12
          return <Text key={i} style={styles.chartLabelText}>{`${h12} ${ampm}`}</Text>
        })}
      </View>
      {/* Legend */}
      <View style={styles.chartLegend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.accent.green }]} />
          <Text style={styles.legendText}>High Energy</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.accent.amber }]} />
          <Text style={styles.legendText}>Medium</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.accent.red }]} />
          <Text style={styles.legendText}>Low</Text>
        </View>
      </View>
    </View>
  )
}

function ExerciseStat({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
  return (
    <View style={{ width: '28%', alignItems: 'center', paddingVertical: spacing.sm }}>
      <Ionicons name={icon as any} size={20} color={color} />
      <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text.primary, marginTop: 4 }}>{value}</Text>
      <Text style={{ fontSize: 11, color: colors.text.muted }}>{label}</Text>
    </View>
  )
}

function OptimalTimeItem({ icon, label, time, color }: { icon: string; label: string; time: string; color: string }) {
  return (
    <View style={styles.optimalRow}>
      <Ionicons name={icon as any} size={18} color={color} />
      <Text style={styles.optimalLabel}>{label}</Text>
      <Text style={[styles.optimalTime, { color }]}>{time}</Text>
    </View>
  )
}

function TrendChart({ data, getValue, formatValue, color, targetMin, targetMax, invertColor }: {
  data: MonthlyDataPoint[]
  getValue: (d: MonthlyDataPoint) => number
  formatValue: (v: number) => string
  color: string
  targetMin?: number
  targetMax?: number
  invertColor?: boolean
}) {
  const values = data.map(getValue)
  const maxVal = Math.max(...values, targetMax || 0) * 1.1
  const minVal = Math.min(...values, targetMin || Infinity) * 0.9
  const range = maxVal - minVal || 1
  const chartHeight = 100
  const chartWidth = SCREEN_WIDTH - spacing.lg * 4

  // Show last 12 months max for readability
  const display = data.slice(-12)
  const displayValues = display.map(getValue)

  return (
    <View>
      <View style={[styles.trendChartContainer, { height: chartHeight }]}>
        {/* Target zone */}
        {targetMin !== undefined && (
          <View style={[styles.trendTargetZone, {
            bottom: ((targetMin - minVal) / range) * chartHeight,
            height: targetMax ? ((targetMax - targetMin) / range) * chartHeight : 1,
          }]} />
        )}
        {/* Bars */}
        {displayValues.map((val, i) => {
          const barHeight = Math.max(2, ((val - minVal) / range) * chartHeight)
          const barWidth = (chartWidth / display.length) - 2
          const isGood = targetMin !== undefined
            ? invertColor ? val <= targetMin : val >= targetMin
            : true
          const barColor = isGood ? color : colors.accent.amber
          return (
            <View key={i} style={{ alignItems: 'center', width: barWidth + 2 }}>
              <View style={{
                width: barWidth, height: barHeight,
                backgroundColor: barColor + '88',
                borderRadius: 3, position: 'absolute', bottom: 0,
              }} />
            </View>
          )
        })}
      </View>
      {/* Month labels */}
      <View style={styles.trendChartLabels}>
        {display.map((d, i) => (
          i % Math.max(1, Math.floor(display.length / 6)) === 0 ? (
            <Text key={i} style={styles.trendChartLabel}>{formatMonthShort(d.month)}</Text>
          ) : <View key={i} />
        ))}
      </View>
      {/* Min/Max/Avg summary */}
      <View style={styles.trendChartSummary}>
        <Text style={styles.trendChartSummaryText}>
          Avg: <Text style={{ color, fontWeight: '700' }}>{formatValue(displayValues.reduce((a, b) => a + b, 0) / displayValues.length)}</Text>
        </Text>
        <Text style={styles.trendChartSummaryText}>
          Best: <Text style={{ color: colors.accent.green, fontWeight: '700' }}>
            {formatValue(invertColor ? Math.min(...displayValues) : Math.max(...displayValues))}
          </Text>
        </Text>
        <Text style={styles.trendChartSummaryText}>
          Worst: <Text style={{ color: colors.accent.red, fontWeight: '700' }}>
            {formatValue(invertColor ? Math.max(...displayValues) : Math.min(...displayValues))}
          </Text>
        </Text>
      </View>
    </View>
  )
}

/** Sleep duration line chart with dots, connecting line, and 7h target zone */
function SleepLineChart({ data, selectedIndex, onSelect }: {
  data: SleepSession[]
  selectedIndex: number
  onSelect: (i: number) => void
}) {
  const chartW = SCREEN_WIDTH - spacing.lg * 4
  const chartH = 120
  const hours = data.map(s => s.totalAsleep / 60)
  const maxH = Math.max(...hours, 9) + 0.5
  const minH = Math.min(...hours, 5) - 0.5
  const range = maxH - minH || 1
  const stepX = data.length > 1 ? chartW / (data.length - 1) : chartW

  const getY = (h: number) => chartH - ((h - minH) / range) * chartH
  const targetY7 = getY(7)
  const targetY9 = getY(9)

  return (
    <View>
      <View style={{ height: chartH, marginBottom: spacing.sm }}>
        {/* Target zone 7-9h */}
        <View style={{
          position: 'absolute', left: 0, right: 0,
          top: Math.min(targetY7, targetY9),
          height: Math.abs(targetY9 - targetY7),
          backgroundColor: colors.accent.green + '0D',
          borderTopWidth: 1, borderTopColor: colors.accent.green + '33',
          borderBottomWidth: 1, borderBottomColor: colors.accent.green + '33',
        }} />
        <Text style={{
          position: 'absolute', right: 2, top: targetY7 - 14,
          fontSize: 9, color: colors.accent.green + '88',
        }}>7h</Text>
        <Text style={{
          position: 'absolute', right: 2, top: targetY9 + 2,
          fontSize: 9, color: colors.accent.green + '88',
        }}>9h</Text>

        {/* Connecting lines */}
        {hours.map((h, i) => {
          if (i === 0) return null
          const x1 = (i - 1) * stepX
          const y1 = getY(hours[i - 1])
          const x2 = i * stepX
          const y2 = getY(h)
          const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
          const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI)
          return (
            <View key={`l${i}`} style={{
              position: 'absolute',
              left: x1, top: y1,
              width: len, height: 2,
              backgroundColor: colors.accent.purple + '66',
              borderRadius: 1,
              transform: [{ rotate: `${angle}deg` }],
              transformOrigin: 'left center',
            }} />
          )
        })}

        {/* Dots */}
        {hours.map((h, i) => {
          const x = i * stepX
          const y = getY(h)
          const isSelected = i === selectedIndex
          const dotColor = h < 6 ? colors.accent.red : h < 7 ? colors.accent.amber : colors.accent.green
          return (
            <TouchableOpacity
              key={`d${i}`}
              onPress={() => onSelect(i)}
              style={{
                position: 'absolute',
                left: x - (isSelected ? 8 : 5),
                top: y - (isSelected ? 8 : 5),
                width: isSelected ? 16 : 10,
                height: isSelected ? 16 : 10,
                borderRadius: isSelected ? 8 : 5,
                backgroundColor: isSelected ? colors.accent.purple : dotColor,
                borderWidth: isSelected ? 2 : 0,
                borderColor: '#fff',
              }}
            />
          )
        })}

        {/* Selected value tooltip */}
        {selectedIndex >= 0 && selectedIndex < hours.length && (
          <View style={{
            position: 'absolute',
            left: Math.min(Math.max(selectedIndex * stepX - 20, 0), chartW - 44),
            top: Math.max(getY(hours[selectedIndex]) - 28, 0),
            backgroundColor: colors.accent.purple,
            borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
          }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>
              {hours[selectedIndex].toFixed(1)}h
            </Text>
          </View>
        )}
      </View>
      {/* Date labels */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {data.map((s, i) => (
          i % Math.max(1, Math.ceil(data.length / 7)) === 0 ? (
            <Text key={i} style={{ fontSize: 9, color: colors.text.muted }}>
              {formatDateLabel(s.date, data.length, data[0]?.date, data[data.length - 1]?.date)}
            </Text>
          ) : <View key={i} />
        ))}
      </View>
    </View>
  )
}

/** Aggregated bar chart for long ranges (>90 days) — weekly averages */
function SleepBarChart({ data }: { data: SleepSession[] }) {
  const chartW = SCREEN_WIDTH - spacing.lg * 4
  const chartH = 110

  // Group into weeks
  const weeks: { label: string; avgHrs: number; count: number }[] = []
  for (let i = 0; i < data.length; i += 7) {
    const chunk = data.slice(i, i + 7).filter(s => s.totalAsleep > 0)
    if (chunk.length === 0) continue
    const avgHrs = chunk.reduce((a, s) => a + s.totalAsleep / 60, 0) / chunk.length
    const label = chunk[0].date.slice(5)
    weeks.push({ label, avgHrs, count: chunk.length })
  }

  if (weeks.length === 0) return null

  const maxH = Math.max(...weeks.map(w => w.avgHrs), 9)
  const barW = Math.max(3, (chartW / weeks.length) - 2)

  return (
    <View>
      <View style={{ height: chartH, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        {/* 7h target line */}
        <View style={{
          position: 'absolute', left: 0, right: 0,
          bottom: (7 / maxH) * chartH,
          height: 1, backgroundColor: colors.accent.green + '44',
        }} />
        {weeks.map((w, i) => {
          const h = (w.avgHrs / maxH) * chartH
          const barColor = w.avgHrs >= 9 ? '#7c3aed'
            : w.avgHrs >= 8 ? '#1d4ed8'
            : w.avgHrs >= 7 ? '#3b82f6'
            : w.avgHrs >= 6 ? '#64748b'
            : w.avgHrs >= 5 ? '#f59e0b'
            : w.avgHrs > 4 ? '#dc2626'
            : '#7f1d1d'
          return (
            <View key={i} style={{
              width: barW, height: h,
              backgroundColor: barColor + '88',
              borderRadius: 2,
            }} />
          )
        })}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs }}>
        {weeks.map((w, i) => {
          if (i % Math.max(1, Math.ceil(weeks.length / 8)) !== 0) return <View key={i} />
          const firstDate = data[0]?.date
          const lastDate = data[data.length - 1]?.date
          const isMultiYear = firstDate && lastDate && firstDate.slice(0, 4) !== lastDate.slice(0, 4)
          const label = isMultiYear ? `${w.label}/${data[i * 7]?.date?.slice(2, 4) || ''}` : w.label
          return <Text key={i} style={{ fontSize: 9, color: colors.text.muted }}>{label}</Text>
        })}
      </View>
      {/* Legend */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 10, marginTop: spacing.xs }}>
        {[{ color: '#7c3aed', label: '9h+' }, { color: '#1d4ed8', label: '8–9h' }, { color: '#3b82f6', label: '7–8h' }, { color: '#64748b', label: '6–7h' }, { color: '#f59e0b', label: '5–6h' }, { color: '#dc2626', label: '4–5h' }, { color: '#7f1d1d', label: '≤4h' }].map(item => (
          <View key={item.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: item.color }} />
            <Text style={{ fontSize: 9, color: colors.text.muted }}>{item.label}</Text>
          </View>
        ))}
      </View>
      {/* Stats */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: spacing.sm }}>
        <Text style={{ fontSize: 11, color: colors.text.secondary }}>
          Avg: <Text style={{ color: colors.accent.purple, fontWeight: '700' }}>
            {(weeks.reduce((a, w) => a + w.avgHrs, 0) / weeks.length).toFixed(1)}h
          </Text>
        </Text>
        <Text style={{ fontSize: 11, color: colors.text.secondary }}>
          Best: <Text style={{ color: colors.accent.green, fontWeight: '700' }}>
            {Math.max(...weeks.map(w => w.avgHrs)).toFixed(1)}h
          </Text>
        </Text>
        <Text style={{ fontSize: 11, color: colors.text.secondary }}>
          Worst: <Text style={{ color: colors.accent.red, fontWeight: '700' }}>
            {Math.min(...weeks.map(w => w.avgHrs)).toFixed(1)}h
          </Text>
        </Text>
        <Text style={{ fontSize: 11, color: colors.text.secondary }}>
          {weeks.length} weeks
        </Text>
      </View>
    </View>
  )
}

/** Stacked bar chart showing deep/core/REM per night */
function SleepStagesChart({ data, selectedIndex, onSelect }: {
  data: SleepSession[]
  selectedIndex: number
  onSelect: (i: number) => void
}) {
  const chartW = SCREEN_WIDTH - spacing.lg * 4
  const chartH = 110
  const maxTotal = Math.max(...data.map(s => s.deepSleep + s.coreSleep + s.remSleep), 1)
  const barW = Math.max(4, (chartW / data.length) - 3)

  return (
    <View>
      <View style={{ height: chartH, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        {data.map((s, i) => {
          const total = s.deepSleep + s.coreSleep + s.remSleep
          const h = total > 0 ? (total / maxTotal) * chartH : 2
          const deepH = total > 0 ? (s.deepSleep / total) * h : 0
          const coreH = total > 0 ? (s.coreSleep / total) * h : 0
          const remH = total > 0 ? (s.remSleep / total) * h : 0
          const isSelected = i === selectedIndex
          return (
            <TouchableOpacity
              key={i}
              onPress={() => onSelect(i)}
              style={{
                width: barW,
                height: h,
                borderRadius: 3,
                overflow: 'hidden',
                opacity: isSelected ? 1 : 0.7,
                borderWidth: isSelected ? 1.5 : 0,
                borderColor: '#fff',
              }}
            >
              <View style={{ flex: 0, height: remH, backgroundColor: '#a78bfa' }} />
              <View style={{ flex: 0, height: coreH, backgroundColor: '#818cf8' }} />
              <View style={{ flex: 0, height: deepH, backgroundColor: '#6366f1' }} />
            </TouchableOpacity>
          )
        })}
      </View>
      {/* Date labels */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs }}>
        {data.map((s, i) => (
          i % Math.max(1, Math.ceil(data.length / 7)) === 0 ? (
            <Text key={i} style={{ fontSize: 9, color: colors.text.muted }}>
              {formatDateLabel(s.date, data.length, data[0]?.date, data[data.length - 1]?.date)}
            </Text>
          ) : <View key={i} />
        ))}
      </View>
      {/* Legend */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.md, marginTop: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#6366f1' }} />
          <Text style={{ fontSize: 11, color: colors.text.muted }}>Deep</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#818cf8' }} />
          <Text style={{ fontSize: 11, color: colors.text.muted }}>Core</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#a78bfa' }} />
          <Text style={{ fontSize: 11, color: colors.text.muted }}>REM</Text>
        </View>
      </View>
    </View>
  )
}

/** Bedtime & wake time consistency scatter chart */
function ScheduleChart({ data }: { data: SleepSession[] }) {
  const chartW = SCREEN_WIDTH - spacing.lg * 4
  const chartH = 100

  // Convert sleep start/end to hour decimals. safeHourOfDay returns null
  // for empty or unparseable timestamps so NaN never enters the math.
  const points = data.map(s => {
    let bedHour = safeHourOfDay(s.sleepStart)
    const wakeHour = safeHourOfDay(s.sleepEnd)
    // Normalize: if after noon, it's PM bedtime (e.g. 23 = 23); if before noon, wrap (e.g. 1 AM = 25)
    if (bedHour !== null && bedHour < 12) bedHour += 24
    return { date: s.date, bedHour, wakeHour }
  }).filter(p => p.bedHour !== null || p.wakeHour !== null)

  if (points.length < 2) return null

  // Range: bedtimes ~20-27 (8PM-3AM), wake ~5-11
  const allBed = points.filter(p => p.bedHour !== null).map(p => p.bedHour!)
  const allWake = points.filter(p => p.wakeHour !== null).map(p => p.wakeHour!)

  // If we have no bed OR no wake samples at all, the chart can't render meaningfully.
  if (allBed.length === 0 && allWake.length === 0) return null

  const minBed = allBed.length ? Math.min(...allBed) - 0.5 : 20
  const maxBed = allBed.length ? Math.max(...allBed) + 0.5 : 26
  const minWake = allWake.length ? Math.min(...allWake) - 0.5 : 6
  const maxWake = allWake.length ? Math.max(...allWake) + 0.5 : 9

  // Two separate rows
  const bedRange = maxBed - minBed || 1
  const wakeRange = maxWake - minWake || 1
  const halfH = (chartH - 8) / 2
  const stepX = points.length > 1 ? chartW / (points.length - 1) : chartW

  const formatHr = (h: number | null) => {
    if (h === null || !Number.isFinite(h)) return '—'
    const norm = h >= 24 ? h - 24 : h
    const hr = Math.floor(norm)
    const min = Math.round((norm - hr) * 60)
    const ampm = hr >= 12 ? 'PM' : 'AM'
    const h12 = hr > 12 ? hr - 12 : hr === 0 ? 12 : hr
    return `${h12}:${min.toString().padStart(2, '0')} ${ampm}`
  }

  // Compute consistency (std dev). Guard against empty arrays so NaN never
  // surfaces — the empty-arrays case (e.g. no sleepStart timestamps at all)
  // shows "—" instead of "NaN:NaN".
  const avgBed: number | null = allBed.length
    ? allBed.reduce((a, b) => a + b, 0) / allBed.length
    : null
  const avgWake: number | null = allWake.length
    ? allWake.reduce((a, b) => a + b, 0) / allWake.length
    : null
  const bedStd = avgBed !== null
    ? Math.sqrt(allBed.reduce((s, v) => s + (v - avgBed) ** 2, 0) / allBed.length)
    : 0
  const wakeStd = avgWake !== null
    ? Math.sqrt(allWake.reduce((s, v) => s + (v - avgWake) ** 2, 0) / allWake.length)
    : 0
  const hasConsistency = avgBed !== null && avgWake !== null
  const consistencyScore = hasConsistency
    ? Math.max(0, Math.round(100 - (bedStd + wakeStd) * 15))
    : null

  return (
    <View>
      {/* Consistency score */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm }}>
        <Text style={{ fontSize: 11, color: colors.text.muted }}>
          Avg bed: {formatHr(avgBed)} · Avg wake: {formatHr(avgWake)}
        </Text>
        {consistencyScore !== null ? (
          <View style={{
            backgroundColor: (consistencyScore >= 80 ? colors.accent.green : consistencyScore >= 60 ? colors.accent.amber : colors.accent.red) + '22',
            paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6,
          }}>
            <Text style={{
              fontSize: 11, fontWeight: '700',
              color: consistencyScore >= 80 ? colors.accent.green : consistencyScore >= 60 ? colors.accent.amber : colors.accent.red,
            }}>{consistencyScore}/100</Text>
          </View>
        ) : null}
      </View>

      <View style={{ height: chartH }}>
        {/* Bedtime row (top half) */}
        <Text style={{ fontSize: 9, color: colors.accent.purple, marginBottom: 2 }}>Bedtime</Text>
        <View style={{ height: halfH, position: 'relative' }}>
          {points.map((p, i) => {
            if (p.bedHour === null) return null
            const x = i * stepX
            const y = halfH - ((p.bedHour - minBed) / bedRange) * halfH
            return (
              <View key={`b${i}`} style={{
                position: 'absolute', left: x - 4, top: y - 4,
                width: 8, height: 8, borderRadius: 4,
                backgroundColor: colors.accent.purple,
              }} />
            )
          })}
          {/* Connecting line */}
          {points.map((p, i) => {
            if (i === 0 || p.bedHour === null || points[i-1].bedHour === null) return null
            const x1 = (i-1) * stepX; const y1 = halfH - ((points[i-1].bedHour! - minBed) / bedRange) * halfH
            const x2 = i * stepX; const y2 = halfH - ((p.bedHour - minBed) / bedRange) * halfH
            const len = Math.sqrt((x2-x1)**2 + (y2-y1)**2)
            const angle = Math.atan2(y2-y1, x2-x1) * (180/Math.PI)
            return <View key={`bl${i}`} style={{
              position: 'absolute', left: x1, top: y1,
              width: len, height: 1.5, backgroundColor: colors.accent.purple + '55',
              transform: [{ rotate: `${angle}deg` }], transformOrigin: 'left center',
            }} />
          })}
        </View>

        {/* Wake row (bottom half) */}
        <Text style={{ fontSize: 9, color: colors.accent.amber, marginBottom: 2 }}>Wake time</Text>
        <View style={{ height: halfH, position: 'relative' }}>
          {points.map((p, i) => {
            if (p.wakeHour === null) return null
            const x = i * stepX
            const y = halfH - ((p.wakeHour - minWake) / wakeRange) * halfH
            return (
              <View key={`w${i}`} style={{
                position: 'absolute', left: x - 4, top: y - 4,
                width: 8, height: 8, borderRadius: 4,
                backgroundColor: colors.accent.amber,
              }} />
            )
          })}
          {points.map((p, i) => {
            if (i === 0 || p.wakeHour === null || points[i-1].wakeHour === null) return null
            const x1 = (i-1) * stepX; const y1 = halfH - ((points[i-1].wakeHour! - minWake) / wakeRange) * halfH
            const x2 = i * stepX; const y2 = halfH - ((p.wakeHour - minWake) / wakeRange) * halfH
            const len = Math.sqrt((x2-x1)**2 + (y2-y1)**2)
            const angle = Math.atan2(y2-y1, x2-x1) * (180/Math.PI)
            return <View key={`wl${i}`} style={{
              position: 'absolute', left: x1, top: y1,
              width: len, height: 1.5, backgroundColor: colors.accent.amber + '55',
              transform: [{ rotate: `${angle}deg` }], transformOrigin: 'left center',
            }} />
          })}
        </View>
      </View>

      {/* X-axis date labels */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
        {(() => {
          const labelCount = Math.min(points.length <= 14 ? 7 : 5, points.length)
          const labels: { idx: number; label: string }[] = []
          const firstDate = points[0]?.date
          const lastDate = points[points.length - 1]?.date
          for (let i = 0; i < labelCount; i++) {
            const idx = labelCount <= 1 ? 0 : Math.round(i * (points.length - 1) / (labelCount - 1))
            const d = points[idx]?.date || ''
            labels.push({ idx, label: formatDateLabel(d, points.length, firstDate, lastDate) })
          }
          return labels.map((l, i) => (
            <Text key={i} style={{ fontSize: 8, color: colors.text.muted }}>{l.label}</Text>
          ))
        })()}
      </View>

      {/* Std dev info — only render when we have samples for both */}
      {hasConsistency && (
        <Text style={{ fontSize: 10, color: colors.text.muted, marginTop: spacing.xs, textAlign: 'center' }}>
          Bedtime varies {'\u00B1'}{(bedStd * 60).toFixed(0)}min · Wake varies {'\u00B1'}{(wakeStd * 60).toFixed(0)}min
        </Text>
      )}
    </View>
  )
}

/** This week vs last week comparison */
function WeeklyComparison({ data }: { data: SleepSession[] }) {
  const thisWeek = data.slice(0, 7)
  const lastWeek = data.slice(7, 14)

  if (lastWeek.length < 3) return null

  const avg = (arr: SleepSession[], fn: (s: SleepSession) => number) => {
    const valid = arr.filter(s => s.totalAsleep > 0)
    if (valid.length === 0) return 0
    return valid.reduce((a, s) => a + fn(s), 0) / valid.length
  }

  const metrics = [
    {
      label: 'Total Sleep',
      thisVal: avg(thisWeek, s => s.totalAsleep / 60),
      lastVal: avg(lastWeek, s => s.totalAsleep / 60),
      format: (v: number) => `${v.toFixed(1)}h`,
      higherBetter: true,
    },
    {
      label: 'Deep Sleep',
      thisVal: avg(thisWeek, s => s.deepSleep),
      lastVal: avg(lastWeek, s => s.deepSleep),
      format: (v: number) => `${Math.round(v)}m`,
      higherBetter: true,
    },
    {
      label: 'REM Sleep',
      thisVal: avg(thisWeek, s => s.remSleep),
      lastVal: avg(lastWeek, s => s.remSleep),
      format: (v: number) => `${Math.round(v)}m`,
      higherBetter: true,
    },
    {
      label: 'Efficiency',
      thisVal: avg(thisWeek, s => s.totalInBed > 0 ? (s.totalAsleep / s.totalInBed) * 100 : 0),
      lastVal: avg(lastWeek, s => s.totalInBed > 0 ? (s.totalAsleep / s.totalInBed) * 100 : 0),
      format: (v: number) => `${Math.round(v)}%`,
      higherBetter: true,
    },
  ]

  return (
    <View style={styles.card}>
      <Text style={[styles.cardLabel, { color: colors.accent.cyan }]}>This Week vs Last Week</Text>
      {metrics.map((m, i) => {
        const diff = m.thisVal - m.lastVal
        const improved = m.higherBetter ? diff > 0 : diff < 0
        const diffColor = Math.abs(diff) < 0.1 ? colors.text.muted
          : improved ? colors.accent.green : colors.accent.red
        return (
          <View key={i} style={{
            flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
            borderBottomWidth: i < metrics.length - 1 ? 0.5 : 0, borderBottomColor: colors.border,
          }}>
            <Text style={{ flex: 1, fontSize: 13, color: colors.text.secondary }}>{m.label}</Text>
            <Text style={{ fontSize: 13, color: colors.text.muted, width: 50, textAlign: 'right' }}>
              {m.format(m.lastVal)}
            </Text>
            <Ionicons
              name={diff > 0 ? 'arrow-forward' : diff < 0 ? 'arrow-forward' : 'remove'}
              size={14} color={diffColor}
              style={{ marginHorizontal: 8 }}
            />
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text.primary, width: 50, textAlign: 'right' }}>
              {m.format(m.thisVal)}
            </Text>
            <Text style={{ fontSize: 11, fontWeight: '600', color: diffColor, width: 42, textAlign: 'right' }}>
              {diff > 0 ? '+' : ''}{m.label === 'Efficiency' ? `${Math.round(diff)}%` : m.label.includes('Sleep') && m.label !== 'Total Sleep' ? `${Math.round(diff)}m` : `${diff.toFixed(1)}h`}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function StageLabel({ color, label, mins, total }: { color: string; label: string; mins: number; total: number }) {
  return (
    <View style={styles.stageLabelRow}>
      <View style={[styles.stageDot, { backgroundColor: color }]} />
      <Text style={styles.stageLabelText}>{label}</Text>
      <Text style={styles.stageValue}>{mins}m ({total > 0 ? Math.round(mins / total * 100) : 0}%)</Text>
    </View>
  )
}

// === HELPERS ===

function debtColor(category: string): string {
  switch (category) {
    case 'low': return colors.accent.green
    case 'moderate': return colors.accent.amber
    case 'high': return '#ff6b35'
    case 'severe': return colors.accent.red
    default: return colors.accent.green
  }
}

function hrvColor(status: string): string {
  switch (status) {
    case 'optimal': return colors.accent.green
    case 'good': return colors.accent.blue
    case 'fair': return colors.accent.amber
    case 'poor': return colors.accent.red
    default: return colors.accent.blue
  }
}

function sjlColor(severity: string): string {
  switch (severity) {
    case 'none': return colors.accent.green
    case 'mild': return colors.accent.amber
    case 'moderate': return '#ff6b35'
    case 'severe': return colors.accent.red
    default: return colors.accent.green
  }
}

function phaseColor(level: string): string {
  switch (level) {
    case 'low': return colors.accent.red
    case 'rising': return colors.accent.amber
    case 'peak': return colors.accent.green
    case 'dipping': return colors.accent.amber
    case 'winding_down': return colors.accent.purple
    default: return colors.text.muted
  }
}

function formatNightDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T12:00:00')
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  } catch { return dateStr }
}

function formatMonthShort(monthStr: string): string {
  const [, month] = monthStr.split('-')
  const months = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
  return months[parseInt(month) - 1] || ''
}

/** Format a YYYY-MM-DD date label based on total data points visible */
function formatDateLabel(dateStr: string, totalPoints: number, firstDate?: string, lastDate?: string): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const parts = dateStr.split('-')
  if (parts.length < 3) return dateStr.substring(5)
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
  const isMultiYear = firstDate && lastDate && firstDate.slice(0, 4) !== lastDate.slice(0, 4)
  if (totalPoints <= 14) {
    // Short range: show day-of-week + M/D
    return `${days[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`
  }
  if (isMultiYear) {
    // Multi-year: show M/D/YY
    return `${d.getMonth() + 1}/${d.getDate()}/${parts[0].substring(2)}`
  }
  // Default: M/D
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function energyBarColor(value: number, max: number): string {
  const ratio = value / max
  if (ratio > 0.66) return colors.accent.green
  if (ratio > 0.33) return colors.accent.amber
  return colors.accent.red
}

function chronoEmoji(type: string): string {
  switch (type) {
    case 'lion': return 'Lion'
    case 'bear': return 'Bear'
    case 'wolf': return 'Wolf'
    case 'dolphin': return 'Dolphin'
    default: return 'Bear'
  }
}

// === STYLES ===

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, paddingHorizontal: spacing.lg },
  title: { ...typography.largeTitle, color: colors.text.primary, marginBottom: spacing.md },

  // Tabs
  tabRow: { flexDirection: 'row', marginBottom: spacing.md, gap: spacing.sm },
  tab: {
    flex: 1, paddingVertical: spacing.sm, borderRadius: 10,
    backgroundColor: colors.bg.tertiary, alignItems: 'center',
  },
  tabActive: { backgroundColor: colors.accent.purple + '33' },
  tabText: { ...typography.caption, color: colors.text.muted },
  tabTextActive: { color: colors.accent.purple, fontWeight: '700' },

  // Hero
  heroCard: { backgroundColor: colors.bg.card, borderRadius: 16, padding: spacing.lg, marginBottom: spacing.md },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroLabel: { ...typography.caption, textTransform: 'uppercase', letterSpacing: 1, marginBottom: spacing.xs },
  heroRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  heroValue: { fontSize: 48, fontWeight: '700', color: colors.text.primary },
  heroUnit: { ...typography.body, color: colors.text.muted },
  heroDetail: { ...typography.caption, color: colors.text.secondary, marginTop: spacing.sm },
  historyLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: spacing.md,
    paddingVertical: 8,
    backgroundColor: colors.accent.purple + '15',
    borderRadius: 8,
  },
  historyLinkText: { fontSize: 13, fontWeight: '500', color: colors.accent.purple },

  // Cards
  card: { backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.lg, marginBottom: spacing.md },
  cardRow: { flexDirection: 'row', marginBottom: spacing.md },
  cardLabel: { ...typography.caption, fontWeight: '600', marginBottom: spacing.md },

  // Metrics
  metricCard: { backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.md, alignItems: 'center', gap: spacing.xs },
  metricValue: { fontSize: 22, fontWeight: '700', color: colors.text.primary },
  metricUnit: { ...typography.caption2, color: colors.text.muted },

  // Score grid
  scoreGrid: { gap: spacing.sm },
  miniScoreItem: { gap: spacing.xs },
  miniScoreBarBg: { height: 6, backgroundColor: colors.bg.tertiary, borderRadius: 3, overflow: 'hidden' },
  miniScoreBarFill: { height: '100%', borderRadius: 3 },
  miniScoreRow: { flexDirection: 'row', justifyContent: 'space-between' },
  miniScoreLabel: { ...typography.caption2, color: colors.text.secondary },
  miniScoreValue: { ...typography.caption2, fontWeight: '700' },
  cycleText: { ...typography.caption, color: colors.text.muted, marginTop: spacing.sm, textAlign: 'center' },

  // Debt gauge
  debtGaugeBg: { height: 12, backgroundColor: colors.bg.tertiary, borderRadius: 6, overflow: 'hidden', marginBottom: spacing.xs },
  debtGaugeFill: { height: '100%', borderRadius: 6 },
  debtMarker: { position: 'absolute', top: -2, width: 2, height: 16 },
  debtMarkerLine: { width: 2, height: 16, backgroundColor: colors.text.muted },
  debtLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  debtLabelText: { ...typography.caption2, color: colors.text.muted },

  // Stages
  stageBar: { flexDirection: 'row', height: 16, borderRadius: 6, overflow: 'hidden', marginBottom: spacing.md },
  stageSegment: { height: '100%' },
  stageLabels: { gap: spacing.sm },
  stageLabelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stageDot: { width: 10, height: 10, borderRadius: 3 },
  stageLabelText: { ...typography.callout, color: colors.text.secondary, flex: 1 },
  stageValue: { ...typography.callout, color: colors.text.primary },

  // HRV
  hrvHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: 6 },
  badgeText: { ...typography.caption2, fontWeight: '700' },

  // Chrono
  chronoRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center', marginBottom: spacing.md },
  chronoEmoji: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  chronoLabel: { ...typography.headline, color: colors.text.primary, marginBottom: spacing.xs },
  chronoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chronoItem: { width: '47%', backgroundColor: colors.bg.tertiary, borderRadius: 8, padding: spacing.sm },
  chronoItemLabel: { ...typography.caption2, color: colors.text.muted, marginBottom: 2 },
  chronoItemValue: { ...typography.callout, color: colors.text.primary, fontWeight: '600' },

  // Times
  timeRow: { gap: spacing.md },
  timeItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  timeLabel: { ...typography.callout, color: colors.text.secondary, flex: 1 },
  timeValue: { ...typography.headline, color: colors.text.primary },

  // Caffeine
  caffeineTime: { fontSize: 28, fontWeight: '700', color: colors.accent.amber },

  // Sleep calc
  calcModeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  calcModeBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10,
    backgroundColor: colors.bg.tertiary,
  },
  calcModeText: { ...typography.caption, color: colors.text.muted, fontWeight: '700' },
  calcModeTextActive: { color: '#fff' },
  latencyRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  latencyLabel: { ...typography.caption2, color: colors.text.muted, marginRight: spacing.xs },
  latencyBtn: {
    paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  latencyBtnActive: { backgroundColor: colors.bg.tertiary, borderColor: colors.accent.blue + '66' },
  latencyText: { ...typography.caption2, color: colors.text.muted, fontWeight: '600' },
  latencyTextActive: { color: colors.accent.blue },
  wakeCalcRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, alignItems: 'flex-end' },
  calcInputLabel: { ...typography.caption2, color: colors.text.muted, marginBottom: spacing.xs },
  wakeCalcInput: {
    backgroundColor: colors.bg.primary, borderRadius: 10, paddingHorizontal: spacing.md,
    paddingVertical: 10, ...typography.body, color: colors.text.primary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  wakeCalcBtn: { borderRadius: 10, paddingHorizontal: spacing.md, paddingVertical: 11, justifyContent: 'center' },
  wakeCalcBtnText: { ...typography.callout, color: '#fff', fontWeight: '600' },
  calcQuickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  quickBtn: { backgroundColor: colors.bg.tertiary, borderRadius: 8, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  quickBtnText: { ...typography.caption2, fontWeight: '700' },
  cyclePlanRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  cyclePlanCard: {
    flex: 1, backgroundColor: colors.bg.tertiary, borderRadius: 10, padding: spacing.sm,
    borderWidth: 1, borderColor: colors.border,
  },
  cyclePlanCardRecommended: { borderColor: colors.accent.green, backgroundColor: colors.accent.green + '18' },
  cyclePlanLabel: { ...typography.caption2, color: colors.text.muted, fontWeight: '700' },
  cyclePlanTime: { fontSize: 16, fontWeight: '700', color: colors.text.primary, marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  cyclePlanHours: { ...typography.caption2, color: colors.text.muted, marginTop: 1 },

  // Phase timeline
  phaseRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  phaseIndicator: { width: 4, borderRadius: 2, minHeight: 40 },
  phaseName: { ...typography.callout, color: colors.text.primary, fontWeight: '600' },
  phaseTime: { ...typography.caption, color: colors.text.muted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  phaseDesc: { ...typography.caption, color: colors.text.secondary, marginTop: 2 },

  // Optimal schedule
  optimalRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 0.5, borderBottomColor: colors.border },
  optimalLabel: { ...typography.callout, color: colors.text.secondary, flex: 1 },
  optimalTime: { ...typography.headline, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  // Recs
  recRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, alignItems: 'flex-start' },
  recText: { ...typography.callout, color: colors.text.secondary, flex: 1 },

  // Night Detail
  nightNav: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  nightNavBtn: { padding: spacing.sm },
  nightNavDate: { ...typography.headline, color: colors.text.primary, textAlign: 'center' },
  nightNavSub: { ...typography.caption2, color: colors.text.muted },
  nightSummaryRow: { flexDirection: 'row', justifyContent: 'space-around' },
  nightSumItem: { alignItems: 'center' },
  nightSumValue: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  nightSumLabel: { ...typography.caption2, color: colors.text.muted, marginTop: 2 },
  stageDetailGrid: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  stageDetailCard: {
    flex: 1, backgroundColor: colors.bg.tertiary, borderRadius: 8, padding: spacing.sm,
    borderLeftWidth: 3, alignItems: 'center',
  },
  stageDetailTitle: { ...typography.caption2, color: colors.text.muted, marginBottom: 2 },
  stageDetailValue: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  stageDetailPct: { ...typography.caption, fontWeight: '600', color: colors.text.secondary },
  stageDetailTarget: { ...typography.caption2, color: colors.text.muted, marginTop: 2 },
  nightAiBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    marginTop: spacing.md, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: colors.accent.purple + '44',
  },
  nightAiBtnText: { ...typography.caption, color: colors.accent.purple, fontWeight: '600' },
  nightAiResult: {
    marginTop: spacing.sm, backgroundColor: colors.bg.tertiary, borderRadius: 8,
    padding: spacing.md,
  },

  // History
  historyRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs, gap: spacing.sm, paddingVertical: 3, paddingHorizontal: spacing.xs, borderRadius: 6 },
  historyRowSelected: { backgroundColor: colors.accent.purple + '15' },
  historyDate: { ...typography.caption2, color: colors.text.muted, width: 40, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  historyBar: { flex: 1, height: 8, backgroundColor: colors.bg.tertiary, borderRadius: 4, overflow: 'hidden' },
  historyFill: { height: '100%', borderRadius: 4 },
  historyValue: { ...typography.caption2, color: colors.text.primary, width: 30, textAlign: 'right' },
  historyDelta: { ...typography.caption2, width: 28, textAlign: 'right' },

  // Energy chart
  chartContainer: { flexDirection: 'row', alignItems: 'flex-end' },
  chartLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  chartLabelText: { ...typography.caption2, color: colors.text.muted },
  chartLegend: { flexDirection: 'row', justifyContent: 'center', gap: spacing.md, marginTop: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { ...typography.caption2, color: colors.text.muted },

  // Trends
  trendSummaryRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: spacing.md },
  trendStat: { alignItems: 'center' },
  trendStatValue: { fontSize: 24, fontWeight: '700', color: colors.text.primary },
  trendStatLabel: { ...typography.caption2, color: colors.text.muted },
  trendDirectionBadge: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: 8,
  },
  trendDirectionText: { ...typography.caption, fontWeight: '600', flex: 1 },
  insightRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginBottom: spacing.md },
  insightTitle: { ...typography.callout, fontWeight: '600', marginBottom: 2 },
  trendChartContainer: { flexDirection: 'row', alignItems: 'flex-end' },
  trendTargetZone: { position: 'absolute', left: 0, right: 0, backgroundColor: colors.accent.green + '11', borderTopWidth: 1, borderTopColor: colors.accent.green + '33' },
  trendChartLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  trendChartLabel: { ...typography.caption2, color: colors.text.muted },
  trendChartSummary: { flexDirection: 'row', justifyContent: 'space-around', marginTop: spacing.sm },
  trendChartSummaryText: { ...typography.caption, color: colors.text.secondary },
  stagesTrendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 4 },
  stagesTrendMonth: { ...typography.caption2, color: colors.text.muted, width: 16, textAlign: 'center' },
  stagesTrendBar: { flex: 1, flexDirection: 'row', height: 12, borderRadius: 4, overflow: 'hidden' },
  stagesTrendTotal: { ...typography.caption2, color: colors.text.muted, width: 32, textAlign: 'right' },

  // Range selector
  rangeBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8,
    backgroundColor: colors.bg.tertiary,
  },
  rangeBtnActive: { backgroundColor: colors.accent.purple + '33' },
  rangeBtnText: { fontSize: 12, fontWeight: '500', color: colors.text.muted },
  rangeBtnTextActive: { color: colors.accent.purple, fontWeight: '700' },

  // Sync
  syncStatus: { ...typography.caption, color: colors.accent.amber, marginBottom: spacing.sm },
  syncBtn: {
    borderWidth: 1, borderColor: colors.accent.purple + '55', borderRadius: 10,
    paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.xs, marginBottom: spacing.md,
  },
  syncBtnText: { color: colors.text.secondary, fontWeight: '500', fontSize: 12 },
  loadingCard: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 220,
    backgroundColor: colors.bg.card,
    borderRadius: 16,
    padding: spacing.xl,
    marginBottom: spacing.md,
  },
  loadingText: {
    ...typography.callout,
    color: colors.text.secondary,
    marginTop: spacing.md,
    fontWeight: '600',
  },

  // AI insights
  insightBtn: { backgroundColor: colors.accent.blue, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: spacing.md },
  insightBtnText: { color: '#fff', fontWeight: '600', ...typography.body },
  insightText: { ...typography.body, color: colors.text.secondary },
  captionText: { ...typography.caption, color: colors.text.secondary },
  emptyText: { ...typography.body, color: colors.text.muted, textAlign: 'center' },
})
