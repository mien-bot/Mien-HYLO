import React, { useState, useEffect } from 'react'
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, RefreshControl, Alert, Linking, Dimensions
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import { getDb } from '../lib/database'
import { getWatchlist, addToWatchlist, removeFromWatchlist, fetchQuote, fetchCryptoPrice, LatestPrice } from '../services/finance.service'
import { refreshNews, getLocalNews, type NewsArticle } from '../services/news.service'
import { fetchPricesFromRelay } from '../services/health-sync.service'
import { generateAnalysis } from '../services/ai.service'
import { getYouTubeContext } from '../services/youtube-transcript.service'
import { listDatabases, pushBriefingToNotion, type NotionDatabase } from '../services/notion.service'

const SCREEN_WIDTH = Dimensions.get('window').width

const CRYPTO_ID_MAP: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano',
  DOT: 'polkadot', AVAX: 'avalanche-2', MATIC: 'matic-network',
  LINK: 'chainlink', DOGE: 'dogecoin', XRP: 'ripple', ATOM: 'cosmos',
  UNI: 'uniswap', LTC: 'litecoin', NEAR: 'near', ARB: 'arbitrum', OP: 'optimism',
}

interface WatchlistItem {
  id: number
  symbol: string
  type: string
  name: string | null
}

interface PricePoint {
  date: string
  close: number
}

interface Holding {
  id: number
  symbol: string
  quantity: number
  cost_basis: number
  acquired_at: string | null
  notes: string | null
}

export default function PortfolioScreen({ navigation }: any) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [prices, setPrices] = useState<Record<string, LatestPrice>>({})
  const [priceHistory, setPriceHistory] = useState<Record<string, PricePoint[]>>({})
  const [news, setNews] = useState<NewsArticle[]>([])
  const [newSymbol, setNewSymbol] = useState('')
  const [newType, setNewType] = useState<'stock' | 'crypto' | 'etf'>('stock')
  const [refreshing, setRefreshing] = useState(false)
  const [briefing, setBriefing] = useState<string | null>(null)
  const [generatingBriefing, setGeneratingBriefing] = useState(false)
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [showHoldingForm, setShowHoldingForm] = useState(false)
  const [holdingSymbol, setHoldingSymbol] = useState('')
  const [holdingQty, setHoldingQty] = useState('')
  const [holdingCost, setHoldingCost] = useState('')
  const [holdingNotes, setHoldingNotes] = useState('')
  const [editingHolding, setEditingHolding] = useState<Holding | null>(null)
  const [activeTab, setActiveTab] = useState<'watchlist' | 'news' | 'holdings'>('watchlist')
  useEffect(() => { loadWatchlist(); loadNews(); loadHoldings() }, [])

  const loadWatchlist = async () => {
    try {
    const items = await getWatchlist() as WatchlistItem[]
    setWatchlist(items)

    // Try relay prices first (pre-computed by desktop)
    const relayData = await fetchPricesFromRelay()
    if (relayData && relayData.prices.length > 0) {
      // Build price history map
      const historyMap: Record<string, PricePoint[]> = {}
      for (const p of relayData.prices) {
        if (!historyMap[p.symbol]) historyMap[p.symbol] = []
        historyMap[p.symbol].push({ date: p.date, close: p.close })
      }
      setPriceHistory(historyMap)

      // Store relay prices locally
      const db = await getDb()
      for (const p of relayData.prices) {
        await db.runAsync(
          `INSERT OR REPLACE INTO price_history (symbol, date, open, high, low, close, volume, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'relay')`,
          p.symbol, p.date, p.open, p.high, p.low, p.close, p.volume
        )
      }
    }

    // Fetch live prices
    const priceMap: Record<string, LatestPrice> = {}

    // Use relay latest prices if available
    if (relayData && relayData.prices.length > 0) {
      for (const item of items) {
        const symbolPrices = relayData.prices.filter(p => p.symbol === item.symbol)
        if (symbolPrices.length > 0) {
          const latest = symbolPrices[symbolPrices.length - 1]
          const prev = symbolPrices.length > 1 ? symbolPrices[symbolPrices.length - 2] : latest
          priceMap[item.symbol] = {
            symbol: item.symbol,
            type: item.type,
            name: item.name,
            price: latest.close,
            change: latest.close - prev.close,
            changePercent: prev.close > 0 ? ((latest.close - prev.close) / prev.close) * 100 : 0,
          }
        }
      }
      if (Object.keys(priceMap).length > 0) {
        setPrices(prev => ({ ...prev, ...priceMap }))
      }
    }

    // Fetch live prices for any missing symbols
    const missingSymbols = items.filter(i => !priceMap[i.symbol])
    const promises = missingSymbols.map(async (item) => {
      try {
        let quote: LatestPrice | null = null
        if (item.type === 'crypto') {
          const coinId = CRYPTO_ID_MAP[item.symbol.toUpperCase()] || item.symbol.toLowerCase()
          quote = await fetchCryptoPrice(coinId, item.symbol)
        } else {
          quote = await fetchQuote(item.symbol)
        }
        if (quote) return { symbol: item.symbol, quote }
      } catch {}
      return null
    })

    const results = await Promise.allSettled(promises)
    const liveMap: Record<string, LatestPrice> = {}
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        liveMap[result.value.symbol] = result.value.quote
      }
    }
    if (Object.keys(liveMap).length > 0) {
      setPrices(prev => ({ ...prev, ...liveMap }))
    }

    // Load local price history if no relay data
    if (!relayData || relayData.prices.length === 0) {
      const db = await getDb()
      const history = await db.getAllAsync(
        `SELECT symbol, date, close FROM price_history
         WHERE date >= date('now', '-30 days') AND close IS NOT NULL
         ORDER BY symbol, date ASC`
      ) as Array<{ symbol: string; date: string; close: number }>

      const historyMap: Record<string, PricePoint[]> = {}
      for (const p of history) {
        if (!historyMap[p.symbol]) historyMap[p.symbol] = []
        historyMap[p.symbol].push({ date: p.date, close: p.close })
      }
      setPriceHistory(historyMap)
    }
    } catch (err) {
      console.error('[Portfolio] loadWatchlist error:', err)
    }
  }

  const loadNews = async () => {
    try {
      const db = await getDb()
      const wl = await db.getAllAsync('SELECT symbol FROM watchlist') as Array<{ symbol: string }>
      const symbols = wl.map(w => w.symbol)
      const articles = await refreshNews(symbols)
      if (articles.length > 0) {
        setNews(articles)
      } else {
        const cached = await getLocalNews(20)
        setNews(cached)
      }
    } catch (err) {
      console.error('[Portfolio] loadNews error:', err)
    }
  }

  const loadHoldings = async () => {
    try {
      const db = await getDb()
      const rows = await db.getAllAsync(
        'SELECT id, symbol, quantity, cost_basis, acquired_at, notes FROM holdings ORDER BY symbol ASC'
      ) as Holding[]
      setHoldings(rows)
    } catch {}
  }

  const handleAddHolding = async () => {
    const symbol = holdingSymbol.trim().toUpperCase()
    const qty = parseFloat(holdingQty)
    const cost = parseFloat(holdingCost)
    if (!symbol || isNaN(qty) || qty <= 0 || isNaN(cost) || cost <= 0) {
      Alert.alert('Invalid', 'Enter a valid symbol, quantity, and cost basis.')
      return
    }
    try {
      const db = await getDb()
      if (editingHolding) {
        await db.runAsync(
          `UPDATE holdings SET symbol = ?, quantity = ?, cost_basis = ?, notes = ? WHERE id = ?`,
          symbol, qty, cost, holdingNotes || null, editingHolding.id
        )
      } else {
        await db.runAsync(
          `INSERT INTO holdings (symbol, quantity, cost_basis, acquired_at, notes, created_at)
           VALUES (?, ?, ?, datetime('now'), ?, datetime('now'))`,
          symbol, qty, cost, holdingNotes || null
        )
      }
      setHoldingSymbol('')
      setHoldingQty('')
      setHoldingCost('')
      setHoldingNotes('')
      setEditingHolding(null)
      setShowHoldingForm(false)
      await loadHoldings()
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to save holding')
    }
  }

  const handleEditHolding = (h: Holding) => {
    setEditingHolding(h)
    setHoldingSymbol(h.symbol)
    setHoldingQty(String(h.quantity))
    setHoldingCost(String(h.cost_basis))
    setHoldingNotes(h.notes || '')
    setShowHoldingForm(true)
  }

  const handleDeleteHolding = (h: Holding) => {
    Alert.alert('Delete', `Remove ${h.symbol} holding?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          const db = await getDb()
          await db.runAsync('DELETE FROM holdings WHERE id = ?', h.id)
          await loadHoldings()
        } catch {}
      }},
    ])
  }

  const handleAdd = async () => {
    const symbol = newSymbol.trim().toUpperCase()
    if (!symbol) return
    try {
      await addToWatchlist(symbol, newType)
      setNewSymbol('')
      await loadWatchlist()
    } catch (err) {
      console.error('[Portfolio] handleAdd error:', err)
    }
  }

  const handleRemove = (symbol: string) => {
    Alert.alert('Remove', `Remove ${symbol} from watchlist?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        await removeFromWatchlist(symbol)
        await loadWatchlist()
      }},
    ])
  }

  const handleBriefing = async () => {
    if (watchlist.length === 0) return
    setGeneratingBriefing(true)
    try {
      const priceContext = Object.entries(prices)
        .map(([sym, p]) => `${sym}: $${(p.price ?? 0).toFixed(2)} (${(p.changePercent ?? 0) >= 0 ? '+' : ''}${(p.changePercent ?? 0).toFixed(2)}%)`)
        .join('\n')

      const newsContext = news.slice(0, 5).map(a => `- ${a.title} (${a.source})`).join('\n')

      const response = await generateAnalysis(
        `You are a concise financial analyst. Provide a brief market update and actionable insights for the user's portfolio. Reference relevant news if available. Be direct and specific.`,
        `My portfolio:\n${priceContext}\n\nRecent news:\n${newsContext || 'No recent news'}\n\nGive me a brief market update and actionable insights.`
      )
      setBriefing(response)
    } catch (err: any) {
      setBriefing(`Error: ${err.message}`)
    }
    setGeneratingBriefing(false)
  }

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      await Promise.all([loadWatchlist(), loadNews()])
    } finally {
      setRefreshing(false)
    }
  }

  const insets = useSafeAreaInsets()

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl * 2 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent.green} />}
    >
      <Text style={styles.title}>Portfolio</Text>

      {/* Tab Selector */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'watchlist' && styles.tabActive]}
          onPress={() => setActiveTab('watchlist')}
        >
          <Text style={[styles.tabText, activeTab === 'watchlist' && styles.tabTextActive]}>Watchlist</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'holdings' && styles.tabActive]}
          onPress={() => setActiveTab('holdings')}
        >
          <Text style={[styles.tabText, activeTab === 'holdings' && styles.tabTextActive]}>
            Holdings {holdings.length > 0 ? `(${holdings.length})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'news' && styles.tabActive]}
          onPress={() => setActiveTab('news')}
        >
          <Text style={[styles.tabText, activeTab === 'news' && styles.tabTextActive]}>
            News {news.length > 0 ? `(${news.length})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, styles.pulseTab]}
          onPress={() => navigation.navigate('MarketPulse')}
        >
          <Ionicons name="pulse" size={14} color={colors.accent.purple} style={{ marginBottom: 1 }} />
          <Text style={[styles.tabText, { color: colors.accent.purple, fontWeight: '700' }]}>Pulse</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, styles.pulseTab]}
          onPress={() => navigation.navigate('Alerts')}
        >
          <Ionicons name="notifications" size={14} color={colors.accent.amber} style={{ marginBottom: 1 }} />
          <Text style={[styles.tabText, { color: colors.accent.amber, fontWeight: '700' }]}>Alerts</Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'watchlist' && (
        <>
          {/* Add asset */}
          <View style={styles.addRow}>
            <TextInput
              style={styles.addInput}
              value={newSymbol}
              onChangeText={setNewSymbol}
              placeholder="AAPL, BTC, VOO..."
              placeholderTextColor={colors.text.muted}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <View style={styles.typeRow}>
              {(['stock', 'crypto', 'etf'] as const).map(t => (
                <TouchableOpacity
                  key={t}
                  style={[styles.typeBtn, newType === t && styles.typeBtnActive]}
                  onPress={() => setNewType(t)}
                >
                  <Text style={[styles.typeText, newType === t && styles.typeTextActive]}>
                    {t.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.addBtn} onPress={handleAdd}>
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          </View>

          {/* Watchlist */}
          {watchlist.length > 0 && (
            <View style={styles.card}>
              {Object.keys(prices).length > 0 && (() => {
                const priceList = Object.values(prices)
                const upCount = priceList.filter(p => (p.changePercent ?? 0) > 0).length
                const downCount = priceList.filter(p => (p.changePercent ?? 0) < 0).length
                const avgChange = priceList.reduce((s, p) => s + (p.changePercent ?? 0), 0) / priceList.length
                return (
                  <View style={styles.totalContainer}>
                    <Text style={styles.totalLabel}>Market Overview</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                      <Text style={{ fontSize: 28, fontWeight: '700', color: avgChange >= 0 ? colors.accent.green : colors.accent.red }}>
                        {avgChange >= 0 ? '+' : ''}{avgChange.toFixed(2)}%
                      </Text>
                      <Text style={{ fontSize: 13, color: colors.text.muted }}>avg</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 16, marginTop: 6 }}>
                      <Text style={{ fontSize: 13, color: colors.accent.green, fontWeight: '600' }}>
                        {upCount} up
                      </Text>
                      <Text style={{ fontSize: 13, color: colors.accent.red, fontWeight: '600' }}>
                        {downCount} down
                      </Text>
                      <Text style={{ fontSize: 13, color: colors.text.muted }}>
                        {priceList.length} tracked
                      </Text>
                    </View>
                  </View>
                )
              })()}
              {watchlist.map((item) => {
                const price = prices[item.symbol]
                const history = priceHistory[item.symbol]
                return (
                  <View key={item.id}>
                    <TouchableOpacity
                      style={styles.assetRow}
                      onPress={() => navigation.navigate('StockDetail', {
                        symbol: item.symbol,
                        type: item.type,
                        name: item.name,
                      })}
                      onLongPress={() => handleRemove(item.symbol)}
                    >
                      <View style={styles.assetLeft}>
                        <Text style={styles.assetSymbol}>{item.symbol}</Text>
                        <Text style={styles.assetType}>{item.type}</Text>
                      </View>
                      {/* Mini sparkline */}
                      {history && history.length > 2 && (
                        <Sparkline data={history.map(p => p.close)} width={50} height={20} />
                      )}
                      {price ? (
                        <View style={styles.assetRight}>
                          <Text style={styles.assetPrice}>${(price.price ?? 0).toFixed(2)}</Text>
                          <Text style={[styles.assetChange, {
                            color: (price.changePercent ?? 0) >= 0 ? colors.accent.green : colors.accent.red
                          }]}>
                            {(price.changePercent ?? 0) >= 0 ? '+' : ''}{(price.changePercent ?? 0).toFixed(2)}%
                          </Text>
                        </View>
                      ) : (
                        <Text style={styles.assetLoading}>...</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                )
              })}
              <Text style={styles.hint}>Tap for details · Hold to remove</Text>
            </View>
          )}

          {watchlist.length === 0 && (
            <View style={styles.emptyCard}>
              <Ionicons name="trending-up-outline" size={32} color={colors.text.muted} />
              <Text style={styles.emptyTitle}>No assets yet</Text>
              <Text style={styles.emptyText}>Add a stock, crypto, or ETF symbol above.</Text>
            </View>
          )}

          {/* AI Briefing */}
          <TouchableOpacity
            style={[styles.briefingBtn, (generatingBriefing || watchlist.length === 0) && { opacity: 0.5 }]}
            onPress={handleBriefing}
            disabled={generatingBriefing || watchlist.length === 0}
          >
            {generatingBriefing ? (
              <NoodleSpinner size={18} color="#fff" />
            ) : (
              <Text style={styles.briefingBtnText}>Get AI Briefing</Text>
            )}
          </TouchableOpacity>

          {briefing && (
            <View style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm }}>
                <Text style={[styles.cardLabel, { color: colors.accent.blue, marginBottom: 0 }]}>Market Briefing</Text>
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: colors.bg.tertiary }}
                  onPress={async () => {
                    try {
                      const dbs = await listDatabases()
                      if (dbs.length === 0) {
                        Alert.alert('No Databases', 'No Notion databases found. Check your integration token.')
                        return
                      }
                      Alert.alert('Push to Notion', 'Select a database', dbs.slice(0, 8).map(db => ({
                        text: db.title,
                        onPress: async () => {
                          const ok = await pushBriefingToNotion(db.id, briefing, 'Market Briefing')
                          if (ok) Alert.alert('Sent!', 'Briefing pushed to Notion.')
                          else Alert.alert('Error', 'Failed to push briefing.')
                        },
                      })).concat([{ text: 'Cancel', onPress: async () => {} }]))
                    } catch (err: any) {
                      Alert.alert('Error', err.message)
                    }
                  }}
                >
                  <Ionicons name="send" size={10} color={colors.text.muted} />
                  <Text style={{ fontSize: 11, color: colors.text.muted }}>Notion</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.briefingText}>{briefing}</Text>
            </View>
          )}
        </>
      )}

      {activeTab === 'holdings' && (
        <>
          {/* Add/Edit Holding */}
          {showHoldingForm ? (
            <View style={styles.addRow}>
              <TextInput
                style={styles.addInput}
                value={holdingSymbol}
                onChangeText={setHoldingSymbol}
                placeholder="Symbol (e.g. AAPL)"
                placeholderTextColor={colors.text.muted}
                autoCapitalize="characters"
              />
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <TextInput
                  style={[styles.addInput, { flex: 1, marginBottom: 0 }]}
                  value={holdingQty}
                  onChangeText={setHoldingQty}
                  placeholder="Quantity"
                  placeholderTextColor={colors.text.muted}
                  keyboardType="decimal-pad"
                />
                <TextInput
                  style={[styles.addInput, { flex: 1, marginBottom: 0 }]}
                  value={holdingCost}
                  onChangeText={setHoldingCost}
                  placeholder="Cost basis ($)"
                  placeholderTextColor={colors.text.muted}
                  keyboardType="decimal-pad"
                />
              </View>
              <TextInput
                style={[styles.addInput, { marginTop: spacing.sm }]}
                value={holdingNotes}
                onChangeText={setHoldingNotes}
                placeholder="Notes (optional)"
                placeholderTextColor={colors.text.muted}
              />
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <TouchableOpacity
                  style={[styles.addBtn, { flex: 1 }]}
                  onPress={handleAddHolding}
                >
                  <Text style={styles.addBtnText}>{editingHolding ? 'Update' : 'Add Holding'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.addBtn, { flex: 1, backgroundColor: colors.bg.tertiary }]}
                  onPress={() => {
                    setShowHoldingForm(false)
                    setEditingHolding(null)
                    setHoldingSymbol('')
                    setHoldingQty('')
                    setHoldingCost('')
                    setHoldingNotes('')
                  }}
                >
                  <Text style={[styles.addBtnText, { color: colors.text.muted }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.briefingBtn}
              onPress={() => setShowHoldingForm(true)}
            >
              <Text style={styles.briefingBtnText}>+ Add Holding</Text>
            </TouchableOpacity>
          )}

          {/* Holdings list with P&L */}
          {holdings.length > 0 ? (
            <View style={styles.card}>
              {/* Total portfolio value */}
              {(() => {
                let totalValue = 0
                let totalCost = 0
                for (const h of holdings) {
                  const currentPrice = prices[h.symbol]?.price
                  if (currentPrice) totalValue += currentPrice * h.quantity
                  totalCost += h.cost_basis * h.quantity
                }
                const totalGain = totalValue - totalCost
                const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0
                return totalValue > 0 ? (
                  <View style={styles.totalContainer}>
                    <Text style={styles.totalLabel}>Portfolio Value</Text>
                    <Text style={styles.totalValue}>${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
                    <Text style={[styles.assetChange, { color: totalGain >= 0 ? colors.accent.green : colors.accent.red }]}>
                      {totalGain >= 0 ? '+' : ''}${totalGain.toFixed(2)} ({totalGainPct >= 0 ? '+' : ''}{totalGainPct.toFixed(2)}%)
                    </Text>
                  </View>
                ) : null
              })()}

              {holdings.map((h) => {
                const currentPrice = prices[h.symbol]?.price
                const marketValue = currentPrice ? currentPrice * h.quantity : null
                const costTotal = h.cost_basis * h.quantity
                const gain = marketValue !== null ? marketValue - costTotal : null
                const gainPct = gain !== null && costTotal > 0 ? (gain / costTotal) * 100 : null
                return (
                  <TouchableOpacity
                    key={h.id}
                    style={styles.assetRow}
                    onPress={() => handleEditHolding(h)}
                    onLongPress={() => handleDeleteHolding(h)}
                  >
                    <View style={styles.assetLeft}>
                      <Text style={styles.assetSymbol}>{h.symbol}</Text>
                      <Text style={styles.assetType}>{h.quantity} shares</Text>
                    </View>
                    <View style={styles.assetRight}>
                      {marketValue !== null ? (
                        <>
                          <Text style={styles.assetPrice}>${marketValue.toFixed(2)}</Text>
                          <Text style={[styles.assetChange, { color: (gain ?? 0) >= 0 ? colors.accent.green : colors.accent.red }]}>
                            {(gain ?? 0) >= 0 ? '+' : ''}{gainPct?.toFixed(2)}%
                          </Text>
                        </>
                      ) : (
                        <Text style={styles.assetLoading}>Cost: ${costTotal.toFixed(2)}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                )
              })}
              <Text style={styles.hint}>Tap to edit · Long press to delete</Text>
            </View>
          ) : (
            <View style={styles.emptyCard}>
              <Ionicons name="wallet-outline" size={32} color={colors.text.muted} />
              <Text style={styles.emptyTitle}>No holdings yet</Text>
              <Text style={styles.emptyText}>Add your positions to track P&L.</Text>
            </View>
          )}
        </>
      )}

      {activeTab === 'news' && (
        <>
          {news.length > 0 ? (
            news.map((article, i) => (
              <NewsItem
                key={article.url || i}
                article={article}
                onSummaryGenerated={(summary) => {
                  setNews(prev => prev.map((a, j) => j === i ? { ...a, summary } : a))
                }}
              />
            ))
          ) : (
            <View style={styles.emptyCard}>
              <Ionicons name="newspaper-outline" size={32} color={colors.text.muted} />
              <Text style={styles.emptyTitle}>No articles yet</Text>
              <Text style={styles.emptyText}>Pull to refresh or add watchlist symbols to get relevant news.</Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  )
}

// === NEWS ITEM COMPONENT ===

function NewsItem({ article, onSummaryGenerated }: { article: NewsArticle; onSummaryGenerated: (summary: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [summarizing, setSummarizing] = useState(false)

  const handleSummarize = async () => {
    setSummarizing(true)
    try {
      const isYoutube = article.source?.startsWith('YouTube')
      const sourceContext = isYoutube
        ? await getYouTubeContext(article.url, article.content_context || null)
        : null
      const prompt = isYoutube
        ? `Summarize this YouTube finance video for an investor. Use the available source context when provided. If no transcript/context is available, say that briefly and only summarize what can be supported from the title/channel.

Title: ${article.title}
Channel: ${article.source}
URL: ${article.url}

Available source context:
${sourceContext || '(none)'}`
        : `Summarize this news article in 2-3 concise sentences. Focus on the key facts and market implications.\n\nTitle: ${article.title}\nSource: ${article.source}\nURL: ${article.url}`
      const summary = await generateAnalysis(
        'You are a concise financial news summarizer. Give brief, factual summaries.',
        prompt
      )
      onSummaryGenerated(summary)
      // Persist to local DB
      const db = await getDb()
      await db.runAsync('UPDATE news_articles SET summary = ? WHERE url = ?', summary, article.url)
    } catch (err) {
      Alert.alert('Error', 'Failed to generate summary')
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <View style={styles.newsItem}>
      <TouchableOpacity
        style={{ flex: 1 }}
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.newsContent}>
          <Text style={styles.newsTitle} numberOfLines={expanded ? undefined : 2}>{article.title}</Text>
          <View style={styles.newsMeta}>
            <Text style={styles.newsSource}>{article.source}</Text>
            {(() => {
              try {
                const syms = article.related_symbols ? JSON.parse(article.related_symbols) : []
                return syms.length > 0 ? <Text style={styles.newsSymbols}>{syms.join(', ')}</Text> : null
              } catch { return null }
            })()}
            <Text style={styles.newsTime}>{formatTimeAgo(article.published_at)}</Text>
          </View>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={{ marginTop: spacing.sm }}>
          {article.summary ? (
            <Text style={{ fontSize: 12, color: colors.text.secondary, lineHeight: 18 }}>
              {article.summary}
            </Text>
          ) : (
            <TouchableOpacity
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 6,
                backgroundColor: colors.accent.blue + '15', paddingHorizontal: 10,
                paddingVertical: 6, borderRadius: 6, alignSelf: 'flex-start',
              }}
              onPress={handleSummarize}
              disabled={summarizing}
            >
              {summarizing ? (
                <Text style={{ fontSize: 12, color: colors.accent.blue }}>Summarizing...</Text>
              ) : (
                <>
                  <Ionicons name="sparkles" size={14} color={colors.accent.blue} />
                  <Text style={{ fontSize: 12, color: colors.accent.blue, fontWeight: '600' }}>Summarize</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm }}
            onPress={() => Linking.openURL(article.url)}
          >
            <Ionicons name="open-outline" size={12} color={colors.accent.cyan} />
            <Text style={{ fontSize: 11, color: colors.accent.cyan }}>Open article</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}

// === CHART COMPONENTS ===

function Sparkline({ data, width, height }: { data: number[]; width: number; height: number }) {
  const clean = data.filter(Number.isFinite)
  if (clean.length < 2) return null
  const min = Math.min(...clean)
  const max = Math.max(...clean)
  const range = max - min || 1
  const isUp = clean[clean.length - 1] >= clean[0]

  return (
    <View style={{ width, height, flexDirection: 'row', alignItems: 'flex-end', gap: 1 }}>
      {clean.slice(-10).map((val, i) => {
        const barHeight = Math.max(2, ((val - min) / range) * height)
        return (
          <View key={i} style={{
            flex: 1, height: barHeight, borderRadius: 1,
            backgroundColor: isUp ? colors.accent.green + '88' : colors.accent.red + '88',
          }} />
        )
      })}
    </View>
  )
}

// === HELPERS ===

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
  tabActive: { backgroundColor: colors.accent.green + '33' },
  tabText: { ...typography.caption, color: colors.text.muted },
  tabTextActive: { color: colors.accent.green, fontWeight: '700' },
  pulseTab: { backgroundColor: colors.accent.purple + '1A', flexDirection: 'row', gap: 4, justifyContent: 'center' },

  addRow: { backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.lg, marginBottom: spacing.md },
  addInput: {
    backgroundColor: colors.bg.primary, borderRadius: 10, paddingHorizontal: spacing.md,
    paddingVertical: 12, ...typography.body, color: colors.text.primary, marginBottom: spacing.sm,
  },
  typeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  typeBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.bg.primary },
  typeBtnActive: { backgroundColor: colors.accent.green },
  typeText: { ...typography.caption, color: colors.text.muted },
  typeTextActive: { color: '#fff' },
  addBtn: { backgroundColor: colors.accent.green, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  addBtnText: { ...typography.body, color: '#fff', fontWeight: '600' },

  card: { backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.lg, marginBottom: spacing.md },
  cardLabel: { ...typography.caption, marginBottom: spacing.md },

  assetRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: spacing.sm, borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  assetLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  assetSymbol: { ...typography.headline, fontWeight: '700', color: colors.text.primary },
  assetType: {
    ...typography.caption2, color: colors.text.muted, backgroundColor: colors.bg.primary,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden',
  },
  assetRight: { alignItems: 'flex-end' },
  assetPrice: { ...typography.body, fontWeight: '600', color: colors.text.primary },
  assetChange: { ...typography.callout },
  assetLoading: { ...typography.body, color: colors.text.muted },
  expandedChart: { paddingVertical: spacing.md, paddingHorizontal: spacing.sm },

  totalContainer: {
    alignItems: 'center', paddingBottom: spacing.md, marginBottom: spacing.sm,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  totalLabel: { ...typography.caption, color: colors.text.muted, marginBottom: spacing.xs, textTransform: 'uppercase', letterSpacing: 1 },
  totalValue: { fontSize: 28, fontWeight: '700', color: colors.text.primary, letterSpacing: 0.3 },

  hint: { ...typography.caption2, color: colors.text.muted, textAlign: 'center', marginTop: spacing.sm },
  emptyCard: { backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.xl, alignItems: 'center', marginBottom: spacing.md },
  emptyTitle: { ...typography.headline, color: colors.text.secondary, marginTop: spacing.sm, marginBottom: spacing.xs },
  emptyText: { ...typography.body, color: colors.text.muted, textAlign: 'center' },

  briefingBtn: { backgroundColor: colors.accent.blue, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: spacing.md },
  briefingBtnText: { ...typography.body, color: '#fff', fontWeight: '600' },
  briefingText: { ...typography.body, color: colors.text.secondary },

  // News
  newsItem: {
    backgroundColor: colors.bg.card,
    borderRadius: 12, padding: spacing.md, marginBottom: spacing.sm,
  },
  newsContent: { flex: 1 },
  newsTitle: { ...typography.callout, color: colors.text.primary, fontWeight: '500', marginBottom: spacing.xs },
  newsMeta: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', flexWrap: 'wrap' },
  newsSource: { ...typography.caption2, color: colors.accent.blue },
  newsSymbols: { ...typography.caption2, color: colors.accent.green, fontWeight: '600' },
  newsTime: { ...typography.caption2, color: colors.text.muted },
})
