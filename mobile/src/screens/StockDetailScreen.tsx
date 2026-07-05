import React, { useState, useEffect, useRef } from 'react'
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Linking, Dimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { fetchQuote, fetchCryptoPrice, type LatestPrice } from '../services/finance.service'
import { fetchNewsFromRSS, type NewsArticle } from '../services/news.service'
import { generateAnalysis } from '../services/ai.service'
import { runFinanceSkill, getCachedSkillResult, SKILL_LABELS, type FinanceSkill } from '../services/finance-skills.service'

const SCREEN_WIDTH = Dimensions.get('window').width

const CRYPTO_ID_MAP: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano',
  DOT: 'polkadot', AVAX: 'avalanche-2', MATIC: 'matic-network',
  LINK: 'chainlink', DOGE: 'dogecoin', XRP: 'ripple', ATOM: 'cosmos',
  UNI: 'uniswap', LTC: 'litecoin', NEAR: 'near', ARB: 'arbitrum', OP: 'optimism',
}

type TimeRange = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'

const RANGE_MAP: Record<TimeRange, string> = {
  '1D': '1D', '1W': '5D', '1M': '1M', '3M': '3M', '1Y': '12M', 'ALL': '60M',
}

export default function StockDetailScreen({ route, navigation }: any) {
  const { symbol, type, name } = route.params as { symbol: string; type: string; name: string | null }
  const insets = useSafeAreaInsets()
  const [price, setPrice] = useState<LatestPrice | null>(null)
  const [news, setNews] = useState<NewsArticle[]>([])
  const [newsLoading, setNewsLoading] = useState(true)
  const [timeRange, setTimeRange] = useState<TimeRange>('3M')
  const [analysis, setAnalysis] = useState<string | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [activeSection, setActiveSection] = useState<'chart' | 'news' | 'analysis'>('chart')
  const [selectedSkill, setSelectedSkill] = useState<FinanceSkill | 'general'>('general')
  const webViewRef = useRef<WebView>(null)

  useEffect(() => {
    loadPrice()
    loadNews()
  }, [])

  const loadPrice = async () => {
    try {
      let quote: LatestPrice | null = null
      if (type === 'crypto') {
        const coinId = CRYPTO_ID_MAP[symbol.toUpperCase()] || symbol.toLowerCase()
        quote = await fetchCryptoPrice(coinId, symbol)
      } else {
        quote = await fetchQuote(symbol)
      }
      if (quote) setPrice(quote)
    } catch {}
  }

  const loadNews = async () => {
    setNewsLoading(true)
    try {
      const articles = await fetchNewsFromRSS([symbol])
      const symbolNews = articles.filter(a =>
        a.title.toUpperCase().includes(symbol.toUpperCase()) ||
        (a.related_symbols && a.related_symbols.includes(symbol))
      ).slice(0, 15)
      // Show symbol-specific news if available, otherwise show all
      setNews(symbolNews.length > 0 ? symbolNews : articles.slice(0, 10))
    } catch {}
    setNewsLoading(false)
  }

  const loadAnalysis = async (skill?: FinanceSkill | 'general') => {
    const activeSkill = skill ?? selectedSkill
    setAnalysisLoading(true)
    setAnalysis(null)
    try {
      if (activeSkill !== 'general') {
        // Check cache first
        const cached = await getCachedSkillResult(activeSkill, symbol)
        if (cached) {
          setAnalysis(cached)
          setAnalysisLoading(false)
          return
        }
        const result = await runFinanceSkill(activeSkill, symbol)
        setAnalysis(result)
      } else {
        // General research (original behavior)
        const priceStr = price
          ? `Current price: $${(price.price ?? 0).toFixed(2)}, change: ${(price.changePercent ?? 0) >= 0 ? '+' : ''}${(price.changePercent ?? 0).toFixed(2)}%`
          : 'Price data not available'

        const newsStr = news.length > 0
          ? 'Recent headlines:\n' + news.slice(0, 8).map(a => `- ${a.title} (${a.source})`).join('\n')
          : 'No recent news available'

        const isCrypto = type === 'crypto'

        const response = await generateAnalysis(
          `You are a senior financial analyst. Provide a comprehensive but concise research report. Be specific with numbers, dates, and actionable insights. Use clear section headers.`,
          `Give me a full research brief on ${symbol}${name ? ` (${name})` : ''} (${isCrypto ? 'cryptocurrency' : type}).

${priceStr}

${newsStr}

Cover these sections:
1. **Current Snapshot** — Price action, trend, momentum. What's happening right now?
2. **Key Catalysts (Near-Term)** — What events, earnings, regulatory changes, or macro factors could move the price in the next 1-4 weeks?
3. **Long-Term Outlook** — Fundamental thesis, competitive position, growth drivers, and risks over 6-12 months.
4. **Technical Levels** — Key support/resistance, moving averages, any notable chart patterns.
5. **Risk Factors** — What could go wrong? Bear case scenarios.
6. **Verdict** — Bullish/Bearish/Neutral rating with a 1-sentence summary.

Be direct. No disclaimers. Give your honest analytical opinion.`
        )
        setAnalysis(response)
      }
    } catch (err: any) {
      setAnalysis(`Error: ${err.message}`)
    }
    setAnalysisLoading(false)
  }

  const tradingViewSymbol = type === 'crypto'
    ? `BINANCE:${symbol}USDT`
    : symbol

  const chartHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #000; overflow: hidden; }
        #container { width: 100%; height: 100vh; }
      </style>
    </head>
    <body>
      <div id="container">
        <div class="tradingview-widget-container" style="height:100%;width:100%">
          <div id="tradingview_chart" style="height:100%;width:100%"></div>
          <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
          <script type="text/javascript">
            new TradingView.widget({
              "autosize": true,
              "symbol": "${tradingViewSymbol}",
              "interval": "${timeRange === '1D' ? '5' : timeRange === '1W' ? '60' : 'D'}",
              "range": "${RANGE_MAP[timeRange]}",
              "timezone": "America/Chicago",
              "theme": "dark",
              "style": "1",
              "locale": "en",
              "toolbar_bg": "#000000",
              "enable_publishing": false,
              "hide_top_toolbar": false,
              "hide_legend": false,
              "save_image": false,
              "container_id": "tradingview_chart",
              "hide_volume": false,
              "backgroundColor": "rgba(0, 0, 0, 1)",
              "gridColor": "rgba(255, 255, 255, 0.03)",
              "studies": ["RSI@tv-basicstudies", "MACD@tv-basicstudies"],
            });
          </script>
        </div>
      </div>
    </body>
    </html>
  `

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text.primary} />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.headerSymbol}>{symbol}</Text>
          <Text style={styles.headerType}>{name || type.toUpperCase()}</Text>
        </View>
        {price && (
          <View style={styles.headerPrice}>
            <Text style={styles.priceText}>${(price.price ?? 0).toFixed(2)}</Text>
            <Text style={[styles.changeText, {
              color: (price.changePercent ?? 0) >= 0 ? colors.accent.green : colors.accent.red
            }]}>
              {(price.changePercent ?? 0) >= 0 ? '+' : ''}{(price.changePercent ?? 0).toFixed(2)}%
            </Text>
          </View>
        )}
      </View>

      {/* Section tabs */}
      <View style={styles.sectionTabs}>
        {(['chart', 'news', 'analysis'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.sectionTab, activeSection === tab && styles.sectionTabActive]}
            onPress={() => {
              setActiveSection(tab)
              if (tab === 'analysis' && !analysis && !analysisLoading) loadAnalysis()
            }}
          >
            <Ionicons
              name={tab === 'chart' ? 'stats-chart' : tab === 'news' ? 'newspaper' : 'bulb'}
              size={14}
              color={activeSection === tab ? colors.accent.blue : colors.text.muted}
            />
            <Text style={[styles.sectionTabText, activeSection === tab && styles.sectionTabTextActive]}>
              {tab === 'chart' ? 'Chart' : tab === 'news' ? 'News' : 'Research'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Chart section */}
      {activeSection === 'chart' && (
        <View style={styles.chartContainer}>
          {/* Time range selector */}
          <View style={styles.rangeRow}>
            {(['1D', '1W', '1M', '3M', '1Y', 'ALL'] as TimeRange[]).map(range => (
              <TouchableOpacity
                key={range}
                style={[styles.rangeBtn, timeRange === range && styles.rangeBtnActive]}
                onPress={() => setTimeRange(range)}
              >
                <Text style={[styles.rangeText, timeRange === range && styles.rangeTextActive]}>
                  {range}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <WebView
            ref={webViewRef}
            key={`${symbol}-${timeRange}`}
            source={{ html: chartHtml }}
            style={styles.chart}
            scrollEnabled={false}
            javaScriptEnabled
            domStorageEnabled
            originWhitelist={['*']}
          />
        </View>
      )}

      {/* News section */}
      {activeSection === 'news' && (
        <ScrollView style={styles.scrollContent} contentContainerStyle={styles.scrollPadding}>
          {newsLoading ? (
            <View style={styles.loadingContainer}>
              <NoodleSpinner color={colors.accent.blue} size={32} />
              <Text style={styles.loadingText}>Fetching news...</Text>
            </View>
          ) : news.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="newspaper-outline" size={28} color={colors.text.muted} />
              <Text style={styles.emptyText}>No recent news for {symbol}</Text>
            </View>
          ) : (
            news.map((article, i) => (
              <TouchableOpacity
                key={i}
                style={styles.newsItem}
                onPress={() => Linking.openURL(article.url)}
              >
                <View style={styles.newsContent}>
                  <Text style={styles.newsTitle} numberOfLines={2}>{article.title}</Text>
                  <View style={styles.newsMeta}>
                    <Text style={styles.newsSource}>{article.source}</Text>
                    <Text style={styles.newsTime}>{formatTimeAgo(article.published_at)}</Text>
                  </View>
                </View>
                <Ionicons name="open-outline" size={12} color={colors.text.muted} />
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      )}

      {/* Analysis section */}
      {activeSection === 'analysis' && (
        <ScrollView style={styles.scrollContent} contentContainerStyle={styles.scrollPadding}>
          {/* Skill Picker */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.skillRow}>
            <TouchableOpacity
              style={[styles.skillChip, selectedSkill === 'general' && styles.skillChipActive]}
              onPress={() => { setSelectedSkill('general'); setAnalysis(null) }}
            >
              <Text style={[styles.skillChipText, selectedSkill === 'general' && styles.skillChipTextActive]}>General</Text>
            </TouchableOpacity>
            {(Object.entries(SKILL_LABELS) as [FinanceSkill, string][]).map(([key, label]) => (
              <TouchableOpacity
                key={key}
                style={[styles.skillChip, selectedSkill === key && styles.skillChipActive]}
                onPress={() => { setSelectedSkill(key); setAnalysis(null) }}
              >
                <Text style={[styles.skillChipText, selectedSkill === key && styles.skillChipTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {analysisLoading ? (
            <View style={styles.loadingContainer}>
              <NoodleSpinner color={colors.accent.purple} size={32} />
              <Text style={styles.loadingText}>
                {selectedSkill === 'general' ? 'Generating research brief...' : `Running ${SKILL_LABELS[selectedSkill as FinanceSkill] || 'analysis'}...`}
              </Text>
              <Text style={[styles.loadingText, { marginTop: 4 }]}>This may take a moment</Text>
            </View>
          ) : analysis ? (
            <View style={styles.analysisCard}>
              <View style={styles.analysisHeader}>
                <Ionicons name="bulb" size={16} color={colors.accent.purple} />
                <Text style={styles.analysisTitle}>
                  {selectedSkill === 'general' ? `AI Research: ${symbol}` : `${SKILL_LABELS[selectedSkill as FinanceSkill]}: ${symbol}`}
                </Text>
              </View>
              <Text style={styles.analysisText}>{analysis}</Text>
              <TouchableOpacity style={styles.refreshBtn} onPress={() => { setAnalysis(null); loadAnalysis() }}>
                <Ionicons name="refresh" size={14} color={colors.accent.blue} />
                <Text style={styles.refreshBtnText}>Regenerate</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyContainer}>
              <Ionicons name="bulb-outline" size={28} color={colors.accent.purple} />
              <Text style={styles.emptyText}>
                {selectedSkill === 'general' ? 'Tap to generate an AI research brief' : `Run ${SKILL_LABELS[selectedSkill as FinanceSkill]} analysis`}
              </Text>
              <TouchableOpacity style={styles.generateBtn} onPress={() => loadAnalysis()}>
                <Text style={styles.generateBtnText}>
                  {selectedSkill === 'general' ? 'Generate Research' : `Run ${SKILL_LABELS[selectedSkill as FinanceSkill]}`}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  )
}

function formatTimeAgo(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffH = Math.floor(diffMs / 3600000)
    if (diffH < 1) return 'Just now'
    if (diffH < 24) return `${diffH}h ago`
    const diffD = Math.floor(diffH / 24)
    if (diffD < 7) return `${diffD}d ago`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md, gap: spacing.sm,
  },
  backBtn: { padding: 4 },
  headerInfo: { flex: 1 },
  headerSymbol: { fontSize: 22, fontWeight: '800', color: colors.text.primary, letterSpacing: 0.5 },
  headerType: { ...typography.caption, color: colors.text.muted, marginTop: 1 },
  headerPrice: { alignItems: 'flex-end' },
  priceText: { fontSize: 20, fontWeight: '700', color: colors.text.primary },
  changeText: { ...typography.callout, fontWeight: '600', marginTop: 1 },

  // Section tabs
  sectionTabs: {
    flexDirection: 'row', paddingHorizontal: spacing.lg, gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  sectionTab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: 8, borderRadius: 8,
    backgroundColor: colors.bg.tertiary,
  },
  sectionTabActive: { backgroundColor: colors.accent.blue + '22' },
  sectionTabText: { ...typography.caption, color: colors.text.muted, fontWeight: '600' },
  sectionTabTextActive: { color: colors.accent.blue },

  // Chart
  chartContainer: { flex: 1 },
  rangeRow: {
    flexDirection: 'row', paddingHorizontal: spacing.lg, gap: 6,
    marginBottom: spacing.xs,
  },
  rangeBtn: {
    flex: 1, paddingVertical: 6, borderRadius: 6,
    backgroundColor: colors.bg.tertiary, alignItems: 'center',
  },
  rangeBtnActive: { backgroundColor: colors.accent.blue },
  rangeText: { ...typography.caption2, color: colors.text.muted, fontWeight: '600' },
  rangeTextActive: { color: '#fff' },
  chart: { flex: 1, backgroundColor: '#000' },

  // Scroll content
  scrollContent: { flex: 1 },
  scrollPadding: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },

  // Loading / Empty
  loadingContainer: { alignItems: 'center', paddingVertical: spacing.xl * 2 },
  loadingText: { ...typography.caption, color: colors.text.muted, marginTop: spacing.sm },
  emptyContainer: { alignItems: 'center', paddingVertical: spacing.xl * 2 },
  emptyText: { ...typography.body, color: colors.text.muted, marginTop: spacing.sm, textAlign: 'center' },

  // News
  newsItem: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg.card,
    borderRadius: 10, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.sm,
  },
  newsContent: { flex: 1 },
  newsTitle: { ...typography.callout, color: colors.text.primary, fontWeight: '500', marginBottom: 4 },
  newsMeta: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  newsSource: { ...typography.caption2, color: colors.accent.blue },
  newsTime: { ...typography.caption2, color: colors.text.muted },

  // Skill picker
  skillRow: { marginBottom: spacing.md, flexGrow: 0 },
  skillChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: colors.bg.tertiary, marginRight: spacing.sm,
    borderWidth: 0.5, borderColor: colors.border,
  },
  skillChipActive: { backgroundColor: colors.accent.purple + '22', borderColor: colors.accent.purple },
  skillChipText: { ...typography.caption, color: colors.text.muted },
  skillChipTextActive: { color: colors.accent.purple, fontWeight: '700' },

  // Analysis
  analysisCard: {
    backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.lg,
  },
  analysisHeader: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginBottom: spacing.md, paddingBottom: spacing.sm,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  analysisTitle: { ...typography.headline, color: colors.accent.purple, fontWeight: '700' },
  analysisText: {
    ...typography.body, color: colors.text.secondary, lineHeight: 22,
  },
  refreshBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, marginTop: spacing.lg, paddingVertical: 10, borderRadius: 8,
    backgroundColor: colors.bg.tertiary,
  },
  refreshBtnText: { ...typography.caption, color: colors.accent.blue, fontWeight: '600' },
  generateBtn: {
    marginTop: spacing.md, paddingHorizontal: 24, paddingVertical: 12,
    borderRadius: 10, backgroundColor: colors.accent.purple,
  },
  generateBtnText: { ...typography.body, color: '#fff', fontWeight: '600' },
})
