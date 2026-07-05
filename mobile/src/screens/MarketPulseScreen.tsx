import React, { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  RefreshControl, Dimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'
import {
  fetchSectorPerformance, fetchMomentumPlays, MOMENTUM_TIMEFRAMES,
  type SectorPerformance, type MomentumStock, type MomentumTimeframe,
} from '../services/finance.service'
import { generateAnalysis } from '../services/ai.service'

type Section = 'sectors' | 'momentum' | 'sentiment' | 'brief'

export default function MarketPulseScreen({ navigation }: any) {
  const [sectors, setSectors] = useState<SectorPerformance[]>([])
  const [momentum, setMomentum] = useState<MomentumStock[]>([])
  const [sentiment, setSentiment] = useState<string | null>(null)
  const [brief, setBrief] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingSentiment, setLoadingSentiment] = useState(false)
  const [loadingBrief, setLoadingBrief] = useState(false)
  const [expandedSection, setExpandedSection] = useState<Section | null>('sectors')
  const [momentumTf, setMomentumTf] = useState<MomentumTimeframe>('1D')
  const [loadingData, setLoadingData] = useState(true)
  const insets = useSafeAreaInsets()

  useEffect(() => { loadData() }, [])

  const loadData = useCallback(async () => {
    setLoadingData(true)
    try {
      const [sectorData, momentumData] = await Promise.all([
        fetchSectorPerformance(),
        fetchMomentumPlays(),
      ])
      setSectors(sectorData)
      setMomentum(momentumData)

      // Load cached brief
      const db = await getDb()
      const cached = await db.getFirstAsync(
        `SELECT content FROM briefings WHERE type = 'market_pulse' AND date >= date('now', '-1 day') ORDER BY created_at DESC LIMIT 1`
      ) as { content: string } | null
      if (cached) setBrief(cached.content)

      const cachedSentiment = await db.getFirstAsync(
        `SELECT content FROM briefings WHERE type = 'market_sentiment' AND date >= date('now', '-1 day') ORDER BY created_at DESC LIMIT 1`
      ) as { content: string } | null
      if (cachedSentiment) setSentiment(cachedSentiment.content)
    } catch (err) {
      console.error('[MarketPulse] Load error:', err)
    }
    setLoadingData(false)
  }, [])

  const onRefresh = async () => {
    setRefreshing(true)
    try { await loadData() } finally { setRefreshing(false) }
  }

  const handleSentiment = async () => {
    if (loadingSentiment) return
    setLoadingSentiment(true)
    try {
      const sectorContext = sectors
        .map(s => `${s.name} (${s.symbol}): ${(s.changePercent ?? 0) >= 0 ? '+' : ''}${(s.changePercent ?? 0).toFixed(2)}%`)
        .join('\n')

      const momentumContext = momentum.slice(0, 10)
        .map(m => `${m.symbol}: ${(m.changePercent ?? 0) >= 0 ? '+' : ''}${(m.changePercent ?? 0).toFixed(2)}%, vol ratio ${(m.volumeRatio ?? 0).toFixed(1)}x, momentum ${m.momentumScore ?? 0}/100`)
        .join('\n')

      const result = await generateAnalysis(
        `You are an expert market analyst. Analyze current market data and identify emerging themes and trends. Be specific about sectors and stocks. Focus on what's driving moves and what trends are emerging. Keep it concise but insightful. Format with bullet points.`,
        `Current sector performance:\n${sectorContext || 'Unavailable'}\n\nStocks with unusual momentum:\n${momentumContext || 'None detected'}\n\nAnalyze what's happening in the market right now. Identify:\n1. Emerging themes (e.g., "AI infrastructure buildout", "memory chip demand")\n2. Sector rotation signals\n3. What the volume/momentum patterns suggest\n4. Any stocks that look like they're breaking out early\n\nBe direct and specific. No disclaimers.`
      )
      setSentiment(result)

      const db = await getDb()
      await db.runAsync(
        `INSERT INTO briefings (type, date, content, created_at)
         VALUES ('market_sentiment', date('now'), ?, datetime('now'))
         ON CONFLICT(type, date) DO UPDATE SET
           content = excluded.content,
           created_at = excluded.created_at`,
        result
      )
    } catch (err: any) {
      setSentiment(`Error: ${err.message}`)
    }
    setLoadingSentiment(false)
  }

  const handleBrief = async () => {
    if (loadingBrief) return
    setLoadingBrief(true)
    try {
      const sectorContext = sectors
        .map(s => `${s.name} (${s.symbol}): ${(s.changePercent ?? 0) >= 0 ? '+' : ''}${(s.changePercent ?? 0).toFixed(2)}%`)
        .join('\n')

      const momentumContext = momentum.slice(0, 10)
        .map(m => `${m.symbol}: $${(m.price ?? 0).toFixed(2)}, ${(m.changePercent ?? 0) >= 0 ? '+' : ''}${(m.changePercent ?? 0).toFixed(2)}%, vol ${(m.volumeRatio ?? 0).toFixed(1)}x avg, momentum ${m.momentumScore ?? 0}/100`)
        .join('\n')

      const result = await generateAnalysis(
        `You are a sharp market strategist writing a daily brief for a sophisticated retail investor who wants to catch trends early. Be concise, direct, and actionable. No disclaimers. Use markdown-style formatting with headers and bullet points.`,
        `Sector performance today:\n${sectorContext || 'Unavailable'}\n\nHigh-momentum stocks:\n${momentumContext || 'None detected'}\n\nWrite a daily market brief covering:\n1. TOP MOVERS — What's moving most and why (2-3 sentences)\n2. SECTOR ROTATION — Where is money flowing? Which sectors are gaining/losing favor?\n3. EMERGING THEMES — What macro/micro trends are worth watching? (e.g., AI capex cycle, memory demand, energy transition)\n4. WATCHLIST — 3-5 specific stocks worth watching with a one-line reason for each\n\nKeep each section tight. The reader wants signal, not noise.`
      )
      setBrief(result)

      const db = await getDb()
      await db.runAsync(
        `INSERT INTO briefings (type, date, content, created_at)
         VALUES ('market_pulse', date('now'), ?, datetime('now'))
         ON CONFLICT(type, date) DO UPDATE SET
           content = excluded.content,
           created_at = excluded.created_at`,
        result
      )
    } catch (err: any) {
      setBrief(`Error: ${err.message}`)
    }
    setLoadingBrief(false)
  }

  const toggleSection = (section: Section) => {
    setExpandedSection(prev => prev === section ? null : section)
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl * 2 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.green} />}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>Market Pulse</Text>
      </View>

      {loadingData && sectors.length === 0 && (
        <View style={styles.loadingContainer}>
          <NoodleSpinner size={44} color={colors.accent.blue} />
          <Text style={styles.loadingText}>Scanning markets...</Text>
        </View>
      )}

      {/* 1. Sector Heat Map */}
      <SectionHeader
        title="Sector Heat Map"
        icon="grid-outline"
        expanded={expandedSection === 'sectors'}
        onPress={() => toggleSection('sectors')}
      />
      {expandedSection === 'sectors' && (
        <View style={styles.heatMapGrid}>
          {sectors.length > 0 ? sectors.map((sector) => (
            <TouchableOpacity
              key={sector.symbol}
              style={[styles.heatCell, {
                backgroundColor: getHeatColor(sector.changePercent),
              }]}
              onPress={() => navigation.navigate('StockDetail', {
                symbol: sector.symbol, type: 'etf', name: sector.name,
              })}
            >
              <Text style={styles.heatName}>{sector.name}</Text>
              <Text style={styles.heatSymbol}>{sector.symbol}</Text>
              <Text style={styles.heatPercent}>
                {sector.changePercent >= 0 ? '+' : ''}{sector.changePercent.toFixed(2)}%
              </Text>
            </TouchableOpacity>
          )) : !loadingData && (
            <Text style={styles.emptyText}>Unable to load sector data. Pull to refresh.</Text>
          )}
        </View>
      )}

      {/* 2. Momentum Plays */}
      <SectionHeader
        title="Momentum Plays"
        icon="rocket-outline"
        expanded={expandedSection === 'momentum'}
        onPress={() => toggleSection('momentum')}
        badge={momentum.length > 0 ? `${momentum.length}` : undefined}
      />
      {expandedSection === 'momentum' && (
        <View style={styles.card}>
          {momentum.length > 0 && (
            <View style={styles.tfRow}>
              {MOMENTUM_TIMEFRAMES.map(tf => (
                <TouchableOpacity
                  key={tf}
                  style={[styles.tfBtn, momentumTf === tf && styles.tfBtnActive]}
                  onPress={() => setMomentumTf(tf)}
                >
                  <Text style={[styles.tfText, momentumTf === tf && styles.tfTextActive]}>
                    {tf}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {momentum.length > 0 ? momentum.slice(0, 12).map((stock) => {
            const pct = stock.changePercents?.[momentumTf] ?? null
            return (
              <TouchableOpacity
                key={stock.symbol}
                style={styles.momentumRow}
                onPress={() => navigation.navigate('StockDetail', {
                  symbol: stock.symbol, type: 'stock', name: stock.name,
                })}
              >
                <View style={styles.momentumLeft}>
                  <View style={styles.momentumHeader}>
                    <Text style={styles.momentumSymbol}>{stock.symbol}</Text>
                    <MomentumBadge score={stock.momentumScore} />
                  </View>
                  <View style={styles.momentumMeta}>
                    <Text style={styles.momentumDetail}>
                      Vol: {stock.volumeRatio.toFixed(1)}x avg
                    </Text>
                    {stock.volumeRatio >= 2 && (
                      <View style={styles.spikeBadge}>
                        <Ionicons name="trending-up" size={10} color={colors.accent.amber} />
                        <Text style={styles.spikeText}>Volume Spike</Text>
                      </View>
                    )}
                  </View>
                </View>
                <View style={styles.momentumRight}>
                  <Text style={styles.momentumPrice}>${stock.price.toFixed(2)}</Text>
                  {pct == null ? (
                    <Text style={[styles.momentumChange, { color: colors.text.muted }]}>
                      — <Text style={styles.momentumTfTag}>{momentumTf}</Text>
                    </Text>
                  ) : (
                    <Text style={[styles.momentumChange, {
                      color: pct >= 0 ? colors.accent.green : colors.accent.red,
                    }]}>
                      {pct >= 0 ? '+' : ''}{pct.toFixed(2)}% <Text style={styles.momentumTfTag}>{momentumTf}</Text>
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            )
          }) : !loadingData && (
            <Text style={styles.emptyText}>No unusual momentum detected today.</Text>
          )}
        </View>
      )}

      {/* 3. Market Sentiment */}
      <SectionHeader
        title="What's Moving & Why"
        icon="chatbubbles-outline"
        expanded={expandedSection === 'sentiment'}
        onPress={() => toggleSection('sentiment')}
      />
      {expandedSection === 'sentiment' && (
        <View style={styles.card}>
          {sentiment ? (
            <Text style={styles.analysisText}>{sentiment}</Text>
          ) : (
            <TouchableOpacity
              style={[styles.generateBtn, loadingSentiment && { opacity: 0.5 }]}
              onPress={handleSentiment}
              disabled={loadingSentiment || sectors.length === 0}
            >
              {loadingSentiment ? (
                <NoodleSpinner size={18} color="#fff" />
              ) : (
                <>
                  <Ionicons name="sparkles" size={16} color="#fff" />
                  <Text style={styles.generateBtnText}>Analyze Market Themes</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {sentiment && (
            <TouchableOpacity
              style={[styles.refreshAnalysisBtn, loadingSentiment && { opacity: 0.5 }]}
              onPress={handleSentiment}
              disabled={loadingSentiment}
            >
              {loadingSentiment ? (
                <NoodleSpinner size={18} color={colors.accent.purple} />
              ) : (
                <Text style={styles.refreshAnalysisText}>Refresh Analysis</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* 4. AI Market Brief */}
      <SectionHeader
        title="Daily Market Brief"
        icon="newspaper-outline"
        expanded={expandedSection === 'brief'}
        onPress={() => toggleSection('brief')}
      />
      {expandedSection === 'brief' && (
        <View style={styles.card}>
          {brief ? (
            <Text style={styles.analysisText}>{brief}</Text>
          ) : (
            <TouchableOpacity
              style={[styles.generateBtn, { backgroundColor: colors.accent.blue }, loadingBrief && { opacity: 0.5 }]}
              onPress={handleBrief}
              disabled={loadingBrief || sectors.length === 0}
            >
              {loadingBrief ? (
                <NoodleSpinner size={18} color="#fff" />
              ) : (
                <>
                  <Ionicons name="document-text" size={16} color="#fff" />
                  <Text style={styles.generateBtnText}>Generate Daily Brief</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {brief && (
            <TouchableOpacity
              style={[styles.refreshAnalysisBtn, loadingBrief && { opacity: 0.5 }]}
              onPress={handleBrief}
              disabled={loadingBrief}
            >
              {loadingBrief ? (
                <NoodleSpinner size={18} color={colors.accent.blue} />
              ) : (
                <Text style={[styles.refreshAnalysisText, { color: colors.accent.blue }]}>Regenerate Brief</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}
    </ScrollView>
  )
}

// === Sub-components ===

function SectionHeader({ title, icon, expanded, onPress, badge }: {
  title: string
  icon: string
  expanded: boolean
  onPress: () => void
  badge?: string
}) {
  return (
    <TouchableOpacity style={styles.sectionHeader} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.sectionLeft}>
        <Ionicons name={icon as any} size={18} color={colors.accent.blue} />
        <Text style={styles.sectionTitle}>{title}</Text>
        {badge && (
          <View style={styles.badgeContainer}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
      </View>
      <Ionicons
        name={expanded ? 'chevron-up' : 'chevron-down'}
        size={18}
        color={colors.text.muted}
      />
    </TouchableOpacity>
  )
}

function MomentumBadge({ score }: { score: number }) {
  let color = colors.text.muted
  let label = 'Low'
  if (score >= 70) { color = colors.accent.green; label = 'High' }
  else if (score >= 45) { color = colors.accent.amber; label = 'Med' }
  else { color = colors.text.muted; label = 'Low' }

  return (
    <View style={[styles.momentumBadge, { borderColor: color }]}>
      <Text style={[styles.momentumBadgeText, { color }]}>{score}</Text>
    </View>
  )
}

// === Helpers ===

function getHeatColor(changePercent: number): string {
  if (changePercent >= 2) return '#1b7a3d'
  if (changePercent >= 1) return '#22693a'
  if (changePercent >= 0.5) return '#2a5a38'
  if (changePercent >= 0) return '#2c4a35'
  if (changePercent >= -0.5) return '#4a2c2c'
  if (changePercent >= -1) return '#5a2a2a'
  if (changePercent >= -2) return '#692222'
  return '#7a1b1b'
}

// === Styles ===

const HEAT_CELL_WIDTH = (Dimensions.get('window').width - spacing.lg * 2 - spacing.xs * 4) / 3

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, paddingHorizontal: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, gap: spacing.sm },
  backBtn: { padding: spacing.xs },
  title: { ...typography.largeTitle, color: colors.text.primary },

  loadingContainer: { alignItems: 'center', paddingVertical: spacing.xl * 2 },
  loadingText: { ...typography.body, color: colors.text.muted, marginTop: spacing.md },

  // Section headers
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.md,
    marginBottom: spacing.xs, marginTop: spacing.sm,
  },
  sectionLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionTitle: { ...typography.headline, color: colors.text.primary },
  badgeContainer: {
    backgroundColor: colors.accent.amber + '33', borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  badgeText: { ...typography.caption2, color: colors.accent.amber, fontWeight: '700' },

  // Heat map
  heatMapGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs,
    padding: spacing.xs, marginBottom: spacing.sm,
  },
  heatCell: {
    width: HEAT_CELL_WIDTH,
    borderRadius: 10, padding: spacing.sm, alignItems: 'center',
    minHeight: 72, justifyContent: 'center',
  },
  heatName: { ...typography.caption2, color: '#fff', fontWeight: '600', textAlign: 'center' },
  heatSymbol: { ...typography.caption2, color: 'rgba(255,255,255,0.6)', marginTop: 2 },
  heatPercent: { ...typography.callout, color: '#fff', fontWeight: '700', marginTop: spacing.xs },

  // Card
  card: { backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.lg, marginBottom: spacing.sm },

  // Momentum
  momentumRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: spacing.sm, borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  momentumLeft: { flex: 1 },
  momentumHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  momentumSymbol: { ...typography.headline, fontWeight: '700', color: colors.text.primary },
  momentumBadge: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 1,
  },
  momentumBadgeText: { ...typography.caption2, fontWeight: '700' },
  momentumMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  momentumDetail: { ...typography.caption2, color: colors.text.muted },
  spikeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: colors.accent.amber + '22', borderRadius: 4,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  spikeText: { ...typography.caption2, color: colors.accent.amber, fontSize: 10 },
  momentumRight: { alignItems: 'flex-end' },
  momentumPrice: { ...typography.body, fontWeight: '600', color: colors.text.primary },
  momentumChange: { ...typography.callout },
  momentumTfTag: { ...typography.caption2, color: colors.text.muted, fontWeight: '600' },

  // Timeframe selector
  tfRow: {
    flexDirection: 'row', gap: 6,
    marginBottom: spacing.sm,
  },
  tfBtn: {
    flex: 1, paddingVertical: 6, borderRadius: 6,
    backgroundColor: colors.bg.tertiary, alignItems: 'center',
  },
  tfBtnActive: { backgroundColor: colors.accent.blue },
  tfText: { ...typography.caption2, color: colors.text.muted, fontWeight: '600' },
  tfTextActive: { color: '#fff' },

  // AI sections
  generateBtn: {
    backgroundColor: colors.accent.purple, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: spacing.sm,
  },
  generateBtnText: { ...typography.body, color: '#fff', fontWeight: '600' },
  analysisText: { ...typography.body, color: colors.text.secondary, lineHeight: 22 },
  refreshAnalysisBtn: {
    alignItems: 'center', marginTop: spacing.md,
    paddingVertical: spacing.sm,
  },
  refreshAnalysisText: { ...typography.caption, color: colors.accent.purple },

  emptyText: { ...typography.body, color: colors.text.muted, textAlign: 'center', paddingVertical: spacing.md },
})
