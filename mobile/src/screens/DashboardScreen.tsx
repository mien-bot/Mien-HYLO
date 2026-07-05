import React, { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Linking, Alert } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography, fonts } from '../lib/theme'
import { useTheme } from '../lib/ThemeContext'
import Avatar from '../components/Avatar'
import { getDb } from '../lib/database'
import { seamlessSyncFromRelay } from '../services/health-sync.service'
import { getOrStartHealthSync } from '../services/sync-manager'
import { runFullAnalysis, type FullSleepAnalysis } from '../services/sleep-analysis.service'
import { refreshNews, getLocalNews, type NewsArticle } from '../services/news.service'
import { fetchTasks, type NotionTask } from '../services/notion.service'
import { generateBriefing, type BriefingType } from '../services/briefing-generator.service'
import { RadialGauge, CalendarHeatmap, type CalendarPoint } from '../components/charts'
import NoodleSpinner from '../components/anim/NoodleSpinner'

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}

export default function DashboardScreen() {
  const [refreshing, setRefreshing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [latestBriefing, setLatestBriefing] = useState<string | null>(null)
  const [topMover, setTopMover] = useState<{ symbol: string; price: number; change: number } | null>(null)
  const [lastSleepHours, setLastSleepHours] = useState<number | null>(null)
  const [analysis, setAnalysis] = useState<FullSleepAnalysis | null>(null)
  const [news, setNews] = useState<NewsArticle[]>([])
  const [tasks, setTasks] = useState<NotionTask[]>([])
  const [currentPhase, setCurrentPhase] = useState<string | null>(null)
  const [sleepConsistency, setSleepConsistency] = useState<CalendarPoint[]>([])
  const [sleepRange, setSleepRange] = useState<'90d' | '6m' | '1y' | '3y' | 'all'>('90d')
  const [readiness, setReadiness] = useState<{ score: number; label: string; color: string } | null>(null)
  const [generatingBriefing, setGeneratingBriefing] = useState<BriefingType | null>(null)

  const navigation = useNavigation<any>()
  const { accent, displayName } = useTheme()

  const handleGenerateBriefing = async (type: BriefingType) => {
    if (generatingBriefing) return
    setGeneratingBriefing(type)
    try {
      const content = await generateBriefing(type)
      setLatestBriefing(content)
    } catch (err: any) {
      Alert.alert('Generate Failed', err?.message || String(err))
    } finally {
      setGeneratingBriefing(null)
    }
  }

  const loadSleepConsistency = async (range: '90d' | '6m' | '1y' | '3y' | 'all') => {
    try {
      const db = await getDb()
      const dateFilter =
        range === 'all' ? '' :
        range === '90d' ? "AND date >= date('now', '-90 days')" :
        range === '6m'  ? "AND date >= date('now', '-6 months')" :
        range === '1y'  ? "AND date >= date('now', '-1 year')" :
                          "AND date >= date('now', '-3 years')"
      const rows = await db.getAllAsync(`
        SELECT date, value_json FROM health_metrics
        WHERE metric_type = 'sleep'
        ${dateFilter}
        ORDER BY date ASC
      `) as Array<{ date: string; value_json: string }>
      const points = rows.map((r) => {
        try {
          const d = JSON.parse(r.value_json)
          const asleep = d.asleep ?? d.totalAsleep ?? d.qty ?? 0
          return { date: r.date, value: asleep ? asleep / 60 : null }
        } catch {
          return { date: r.date, value: null }
        }
      }).filter((p) => p.value != null && (p.value as number) > 0)
      setSleepConsistency(points)
    } catch {}
  }

  const loadData = async () => {
    try {
      await getOrStartHealthSync()
      const db = await getDb()

      // Collect all data before touching state so every setState fires in one batch
      let nextTopMover: { symbol: string; price: number; change: number } | null = null
      let nextSleepHours: number | null = null
      let nextBriefing: string | null = null
      let nextAnalysis: FullSleepAnalysis | null = null
      let nextPhase: string | null = null
      let nextNews: NewsArticle[] = []
      let nextTasks: NotionTask[] = []

      const mover = await db.getFirstAsync(`
        SELECT w.symbol, w.type, p.close, p.date
        FROM watchlist w
        LEFT JOIN price_history p ON p.symbol = w.symbol
        WHERE p.date = (SELECT MAX(date) FROM price_history WHERE symbol = w.symbol)
        ORDER BY w.added_at DESC LIMIT 1
      `) as any
      if (mover?.symbol && mover?.close) {
        nextTopMover = { symbol: mover.symbol, price: mover.close, change: 0 }
      }

      const lastSleep = await db.getFirstAsync(`
        SELECT date, value_json FROM health_metrics
        WHERE metric_type = 'sleep' ORDER BY date DESC LIMIT 1
      `) as any
      if (lastSleep?.value_json) {
        try {
          const parsed = JSON.parse(lastSleep.value_json)
          const mins = parsed.asleep || parsed.totalAsleep || parsed.qty || 0
          nextSleepHours = mins > 0 ? Math.round((mins / 60) * 10) / 10 : null
        } catch {}
      }

      const briefing = await db.getFirstAsync('SELECT content FROM briefings ORDER BY created_at DESC LIMIT 1') as any
      nextBriefing = briefing?.content || null

      nextAnalysis = await runFullAnalysis()

      if (nextAnalysis?.circadian.energyPhases) {
        const now = new Date()
        const currentHour = now.getHours() + now.getMinutes() / 60
        for (const phase of nextAnalysis.circadian.energyPhases) {
          const startH = parseTime(phase.start)
          const endH = parseTime(phase.end)
          if (currentHour >= startH && currentHour < endH) {
            nextPhase = phase.name
            break
          }
        }
      }

      const watchlistRows = await db.getAllAsync('SELECT symbol FROM watchlist') as Array<{ symbol: string }>
      const symbols = watchlistRows.map(w => w.symbol)
      try {
        const articles = await refreshNews(symbols)
        nextNews = articles.slice(0, 5)
      } catch {
        nextNews = await getLocalNews(5)
      }

      await loadSleepConsistency(sleepRange)

      try {
        const settings = await (await import('../lib/storage')).getSettings()
        const tasksDbId = settings.notionTasksDbId
        if (tasksDbId) {
          nextTasks = await fetchTasks(tasksDbId)
        }
      } catch {}

      // Compute composite readiness score from sleep + HRV
      let nextReadiness: { score: number; label: string; color: string } | null = null
      if (nextAnalysis) {
        let sleepScore = 0
        if (nextAnalysis.quality) {
          sleepScore = Math.round((nextAnalysis.quality.deepSleepScore + nextAnalysis.quality.remScore + nextAnalysis.quality.efficiencyScore) / 3)
        }
        let hrvScore = 50 // default if no HRV data
        if (nextAnalysis.hrvRecovery?.zScore !== undefined) {
          // Map z-score: >0 is above average (good), <0 is below
          hrvScore = Math.min(100, Math.max(0, 50 + nextAnalysis.hrvRecovery.zScore * 25))
        }
        // Composite: 50% sleep + 50% HRV
        const composite = Math.round(sleepScore * 0.5 + hrvScore * 0.5)
        let label = 'Moderate'
        let color = colors.accent.amber
        if (composite >= 80) { label = 'Excellent'; color = colors.accent.green }
        else if (composite >= 65) { label = 'Good'; color = colors.accent.blue }
        else if (composite < 40) { label = 'Low'; color = colors.accent.red }
        nextReadiness = { score: composite, label, color }
      }

      // Commit all state in one synchronous block — React batches these into a single render
      setTopMover(nextTopMover)
      setLastSleepHours(nextSleepHours)
      setLatestBriefing(nextBriefing)
      setAnalysis(nextAnalysis)
      setCurrentPhase(nextPhase)
      setNews(nextNews)
      setTasks(nextTasks)
      setReadiness(nextReadiness)
    } catch {
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])
  useEffect(() => { loadSleepConsistency(sleepRange) }, [sleepRange])

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      await seamlessSyncFromRelay({ forceFull: true })
      await loadData()
    } finally {
      setRefreshing(false)
    }
  }

  const insets = useSafeAreaInsets()

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.blue} />}
    >
      {/* Greeting Header */}
      <View style={styles.greetingRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>
            {displayName ? `${getGreeting()}, ${displayName} 🍜` : getGreeting()}
          </Text>
          <Text style={styles.dateText}>{formatDate()}</Text>
        </View>
        <Avatar name={displayName} size={42} />
      </View>

      {/* Quick Actions */}
      <View style={styles.quickActions}>
        <TouchableOpacity
          style={[styles.pill, { backgroundColor: accent + '22' }]}
          onPress={() => navigation.navigate('Chat')}
        >
          <Text style={[styles.pillText, { color: accent }]}>Ask AI</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pill, { backgroundColor: colors.accent.amber + '22' }]}
          onPress={() => navigation.navigate('Weekend')}
        >
          <Text style={[styles.pillText, { color: colors.accent.amber }]}>Plan Weekend</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pill, { backgroundColor: colors.accent.purple + '22' }]}
          onPress={() => navigation.navigate('Health')}
        >
          <Text style={[styles.pillText, { color: colors.accent.purple }]}>Health</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingCard}>
          <NoodleSpinner size={40} color={colors.accent.blue} variant="inside" />
          <Text style={styles.loadingText}>Syncing data</Text>
        </View>
      ) : (
        <>

      {/* Recovery score gauge — added PR 8 (mobile parity) */}
      {analysis?.quality && (
        <View
          style={{
            backgroundColor: colors.bg.card,
            borderRadius: 12,
            padding: 16,
            marginBottom: spacing.md,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <RadialGauge
            value={analysis.quality.overall}
            min={0}
            max={100}
            label="Sleep score"
            unit="/100"
            size={120}
            thresholds={[
              { at: 0, color: colors.accent.red },
              { at: 45, color: colors.accent.amber },
              { at: 70, color: colors.accent.green },
            ]}
          />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text.primary, fontSize: 14, fontWeight: '600' }}>
              Last night
            </Text>
            <Text style={{ color: colors.text.secondary, fontSize: 12, marginTop: 4, lineHeight: 16 }}>
              Deep {analysis.quality.deepSleepScore}/100 · REM {analysis.quality.remScore}/100 · Efficiency {analysis.quality.efficiencyScore}/100
            </Text>
          </View>
        </View>
      )}

      {/* Current Energy Phase */}
      {currentPhase && (
        <TouchableOpacity
          style={styles.energyBanner}
          onPress={() => navigation.navigate('Health')}
        >
          <Ionicons name="flash" size={16} color={phaseColor(currentPhase)} />
          <Text style={styles.energyText}>
            Current Phase: <Text style={{ color: phaseColor(currentPhase), fontWeight: '700' }}>{currentPhase}</Text>
          </Text>
          <Ionicons name="chevron-forward" size={14} color={colors.text.muted} />
        </TouchableOpacity>
      )}

      {/* Readiness Score */}
      {readiness && (
        <TouchableOpacity
          style={styles.energyBanner}
          onPress={() => navigation.navigate('Health')}
        >
          <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: readiness.color + '22', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: readiness.color }}>{readiness.score}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: spacing.sm }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text.primary }}>
              Readiness: <Text style={{ color: readiness.color }}>{readiness.label}</Text>
            </Text>
            <Text style={{ fontSize: 11, color: colors.text.muted }}>Sleep + HRV composite</Text>
          </View>
          <Ionicons name="chevron-forward" size={14} color={colors.text.muted} />
        </TouchableOpacity>
      )}

      {/* Summary Cards */}
      <View style={styles.cardRow}>
        {/* Portfolio Card */}
        <TouchableOpacity
          style={[styles.card, styles.portfolioCard, { flex: 1 }]}
          onPress={() => navigation.navigate('Portfolio')}
        >
          <Text style={[styles.cardLabel, { color: colors.accent.green }]}>Portfolio</Text>
          {topMover ? (
            <>
              <Text style={styles.cardValue}>{topMover.symbol}</Text>
              <Text style={styles.cardSub}>
                ${topMover.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.cardValue}>--</Text>
              <Text style={styles.cardSub}>No assets</Text>
            </>
          )}
        </TouchableOpacity>
        <View style={{ width: spacing.md }} />

        {/* Sleep Card with Score */}
        <TouchableOpacity
          style={[styles.card, styles.healthCard, { flex: 1 }]}
          onPress={() => navigation.navigate('Health')}
        >
          <Text style={[styles.cardLabel, { color: colors.accent.purple }]}>Last Night</Text>
          {lastSleepHours !== null ? (
            <>
              <Text style={styles.cardValue}>{lastSleepHours}h</Text>
              {analysis?.quality && (
                <Text style={[styles.cardSub, {
                  color: analysis.quality.overall >= 80 ? colors.accent.green
                    : analysis.quality.overall >= 60 ? colors.accent.amber
                    : colors.accent.red
                }]}>
                  Score: {analysis.quality.overall}/100
                </Text>
              )}
            </>
          ) : (
            <>
              <Text style={styles.cardValue}>--</Text>
              <Text style={styles.cardSub}>No data</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Sleep Debt + Optimal Times Row */}
      {analysis && (
        <View style={styles.cardRow}>
          <View style={[styles.card, { flex: 1 }]}>
            <Text style={[styles.cardLabel, { color: debtColor(analysis.debt.debtCategory) }]}>Sleep Debt</Text>
            <Text style={[styles.cardValue, { fontSize: 24 }]}>{analysis.debt.currentDebt}h</Text>
            <Text style={[styles.cardSub, { color: debtColor(analysis.debt.debtCategory) }]}>
              {analysis.debt.debtCategory}
            </Text>
          </View>
          <View style={{ width: spacing.md }} />
          <View style={[styles.card, { flex: 1 }]}>
            <Text style={[styles.cardLabel, { color: colors.accent.amber }]}>Caffeine By</Text>
            <Text style={[styles.cardValue, { fontSize: 24 }]}>{analysis.caffeineCutoff.lastCaffeineTime}</Text>
            <Text style={styles.cardSub}>Bedtime: {analysis.circadian.optimalBedtime}</Text>
          </View>
        </View>
      )}

      {/* Sleep consistency calendar */}
      {sleepConsistency.length > 0 && (
        <View
          style={{
            backgroundColor: colors.bg.card,
            borderRadius: 12,
            padding: 16,
            marginBottom: spacing.md,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Text style={{ color: colors.text.primary, fontSize: 14, fontWeight: '600' }}>
              Sleep Consistency
            </Text>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {(['90d', '6m', '1y', '3y', 'all'] as const).map((r) => (
                <TouchableOpacity
                  key={r}
                  onPress={() => setSleepRange(r)}
                  style={{
                    paddingHorizontal: 7,
                    paddingVertical: 3,
                    borderRadius: 6,
                    backgroundColor: sleepRange === r ? colors.accent.blue : colors.bg.tertiary,
                  }}
                >
                  <Text style={{
                    fontSize: 10,
                    fontWeight: '600',
                    color: sleepRange === r ? '#fff' : colors.text.muted,
                  }}>
                    {r === 'all' ? 'All' : r.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <Text style={{ color: colors.text.muted, fontSize: 11, marginBottom: 12 }}>
            {sleepRange === '90d' ? 'Last 90 nights' :
             sleepRange === '6m'  ? 'Last 6 months' :
             sleepRange === '1y'  ? 'Last year' :
             sleepRange === '3y'  ? 'Last 3 years' : 'All time'} · hours asleep
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <CalendarHeatmap
              data={sleepConsistency}
              cellSize={12}
              valueRange={[4, 9]}
              valueScale="sleep-hours"
              colorRamp={['#7f1d1d', '#dc2626', '#f59e0b', '#64748b', '#3b82f6', '#1d4ed8', '#7c3aed']}
              collapseEmptyWeeks={sleepRange === 'all'}
            />
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 4 }}>
            <Text style={{ color: colors.text.muted, fontSize: 10 }}>{'≤4h'}</Text>
            {['#7f1d1d', '#dc2626', '#f59e0b', '#64748b', '#3b82f6', '#1d4ed8', '#7c3aed'].map((c, i) => (
              <View key={i} style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: c }} />
            ))}
            <Text style={{ color: colors.text.muted, fontSize: 10 }}>9h+</Text>
          </View>
          <Text style={{ color: colors.text.muted, fontSize: 9, marginTop: 3 }}>5 / 6 / 7 / 8h</Text>
        </View>
      )}

      {/* Latest Briefing */}
      <View style={[styles.card, styles.briefingCard]}>
        <View style={styles.briefingHeader}>
          <Text style={[styles.cardLabel, { color: colors.accent.blue }]}>Latest Briefing</Text>
          <View style={styles.briefingActions}>
            <TouchableOpacity
              onPress={() => handleGenerateBriefing('morning_finance')}
              disabled={generatingBriefing !== null}
              style={[styles.briefingActionBtn, { borderColor: colors.accent.green }]}
            >
              {generatingBriefing === 'morning_finance' ? (
                <NoodleSpinner color={colors.accent.green} size={12} />
              ) : (
                <Ionicons name="trending-up" size={12} color={colors.accent.green} />
              )}
              <Text style={[styles.briefingActionText, { color: colors.accent.green }]}>Finance</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleGenerateBriefing('morning_sleep')}
              disabled={generatingBriefing !== null}
              style={[styles.briefingActionBtn, { borderColor: colors.accent.purple }]}
            >
              {generatingBriefing === 'morning_sleep' ? (
                <NoodleSpinner color={colors.accent.purple} size={12} />
              ) : (
                <Ionicons name="moon" size={12} color={colors.accent.purple} />
              )}
              <Text style={[styles.briefingActionText, { color: colors.accent.purple }]}>Sleep</Text>
            </TouchableOpacity>
          </View>
        </View>
        <TouchableOpacity activeOpacity={0.8} onPress={() => navigation.navigate('Briefings')}>
          {latestBriefing ? (
            <Text style={styles.briefingText} numberOfLines={15}>{latestBriefing}</Text>
          ) : (
            <Text style={styles.cardSub}>No briefings yet. Tap to see history or generate one above.</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Notion Tasks — today only */}
      {(() => {
        const today = new Date().toISOString().slice(0, 10)
        const todayTasks = tasks.filter(t => t.due_date === today)
        return todayTasks.length > 0 ? (
        <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: colors.accent.amber }]}>
          <Text style={[styles.cardLabel, { color: colors.accent.amber }]}>Tasks ({todayTasks.length})</Text>
          {todayTasks.slice(0, 6).map((task) => (
            <View key={task.id} style={styles.taskRow}>
              <View style={[styles.taskDot, {
                backgroundColor: task.status === 'In progress' ? colors.accent.blue
                  : task.status === 'Not started' ? colors.text.muted
                  : colors.accent.amber
              }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.taskTitle} numberOfLines={1}>{task.title}</Text>
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <Text style={styles.taskMeta}>{task.status}</Text>
                  {task.due_date && <Text style={styles.taskMeta}>{task.due_date}</Text>}
                  {task.priority && <Text style={[styles.taskMeta, {
                    color: task.priority === 'High' ? colors.accent.red
                      : task.priority === 'Medium' ? colors.accent.amber
                      : colors.text.muted
                  }]}>{task.priority}</Text>}
                </View>
              </View>
            </View>
          ))}
          {todayTasks.length > 6 && (
            <Text style={[styles.cardSub, { textAlign: 'center', marginTop: spacing.sm }]}>
              +{todayTasks.length - 6} more tasks
            </Text>
          )}
        </View>
        ) : null
      })()}

      {/* News Feed */}
      {news.length > 0 && (
        <View>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent News</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Portfolio')}>
              <Text style={styles.seeAll}>See All</Text>
            </TouchableOpacity>
          </View>
          {news.slice(0, 5).map((article, i) => (
            <TouchableOpacity
              key={i}
              style={styles.newsItem}
              onPress={() => Linking.openURL(article.url)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.newsTitle} numberOfLines={2}>{article.title}</Text>
                <Text style={styles.newsMeta}>{article.source} · {formatTimeAgo(article.published_at)}</Text>
              </View>
              <Ionicons name="open-outline" size={12} color={colors.text.muted} />
            </TouchableOpacity>
          ))}
        </View>
      )}
        </>
      )}
    </ScrollView>
  )
}

function parseTime(timeStr: string): number {
  if (!timeStr) return 0
  const match = timeStr.match(/(\d{1,2}):(\d{2})/)
  if (!match || !match[1] || !match[2]) return 0
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0
  return hours + minutes / 60
}

function phaseColor(phase: string): string {
  switch (phase) {
    case 'Sleep Inertia': return colors.accent.red
    case 'Morning Peak': return colors.accent.green
    case 'Afternoon Dip': return colors.accent.amber
    case 'Evening Peak': return colors.accent.cyan
    case 'Wind Down': return colors.accent.purple
    default: return colors.text.secondary
  }
}

function debtColor(category: string): string {
  switch (category) {
    case 'low': return colors.accent.green
    case 'moderate': return colors.accent.amber
    case 'high': return '#ff6b35'
    case 'severe': return colors.accent.red
    default: return colors.accent.green
  }
}

function formatTimeAgo(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    const diffH = Math.floor((Date.now() - date.getTime()) / 3600000)
    if (diffH < 1) return 'Just now'
    if (diffH < 24) return `${diffH}h ago`
    return `${Math.floor(diffH / 24)}d ago`
  } catch { return '' }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, paddingHorizontal: spacing.lg },
  greetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  greeting: {
    fontFamily: fonts.display,
    fontSize: 28,
    letterSpacing: -0.3,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  dateText: { ...typography.callout, color: colors.text.muted },

  quickActions: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  pill: { flex: 1, paddingVertical: spacing.sm + 2, borderRadius: 999, alignItems: 'center' },
  pillText: { ...typography.caption, fontWeight: '600' },
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

  // Energy banner
  energyBanner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.bg.card, borderRadius: 10, padding: spacing.md, marginBottom: spacing.md,
  },
  energyText: { ...typography.callout, color: colors.text.secondary, flex: 1 },

  cardRow: { flexDirection: 'row', marginBottom: spacing.md },
  card: {
    backgroundColor: colors.bg.card,
    borderRadius: 16,
    padding: 20,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  portfolioCard: { borderLeftWidth: 3, borderLeftColor: colors.accent.green },
  healthCard: { borderLeftWidth: 3, borderLeftColor: colors.accent.purple },
  briefingCard: { borderLeftWidth: 3, borderLeftColor: colors.accent.blue },
  briefingHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  briefingActions: { flexDirection: 'row', gap: 6 },
  briefingActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderRadius: 12,
    backgroundColor: colors.bg.tertiary,
  },
  briefingActionText: { fontSize: 10, fontWeight: '600' },
  cardLabel: { ...typography.caption, fontWeight: '600', marginBottom: spacing.sm },
  cardValue: { fontSize: 34, fontWeight: '700', color: colors.text.primary },
  cardSub: { ...typography.caption, color: colors.text.muted, marginTop: 2 },
  briefingText: { ...typography.body, color: colors.text.secondary },

  // News
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  sectionTitle: { ...typography.headline, color: colors.text.primary },
  seeAll: { ...typography.caption, color: colors.accent.blue },
  newsItem: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.bg.card, borderRadius: 10, padding: spacing.md, marginBottom: spacing.sm,
  },
  newsTitle: { ...typography.callout, color: colors.text.primary, marginBottom: 2 },
  newsMeta: { ...typography.caption2, color: colors.text.muted },

  // Tasks
  taskRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    paddingVertical: spacing.sm, borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  taskDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  taskTitle: { ...typography.callout, color: colors.text.primary, fontWeight: '500' },
  taskMeta: { ...typography.caption2, color: colors.text.muted },
})
