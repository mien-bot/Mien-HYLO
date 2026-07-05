import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Search, ArrowUp, ArrowDown } from 'lucide-react'
import type { LatestPrice, RiskMetric } from '../../../shared/types/ipc.types'
import NoodleSpinner from '../anim/NoodleSpinner'

const COLLAPSED_COUNT = 8

type SortKey = 'symbol' | 'price' | 'change' | 'changePercent' | 'volatility' | 'beta' | 'mdd' | 'pe' | 'yield' | 'health' | 'volume'
type SortDir = 'asc' | 'desc'
type FilterType = 'all' | 'stock' | 'crypto' | 'etf'

interface FundamentalsLite {
  symbol: string
  pe: number | null
  dividend_yield: number | null
}

interface HealthScoreLite {
  symbol: string
  score: number
  breakdown: {
    valuation: number | null
    momentum: number | null
    risk: number | null
    sentiment: number | null
  }
}

interface Props {
  prices: LatestPrice[]
  loading: boolean
  onSelect: (symbol: string) => void
  selectedSymbol: string | null
  riskMetrics?: Record<string, RiskMetric>
  fundamentals?: Record<string, FundamentalsLite>
  healthScores?: Record<string, HealthScoreLite>
}

export default function WatchlistTable({
  prices,
  loading,
  onSelect,
  selectedSymbol,
  riskMetrics,
  fundamentals,
  healthScores,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'symbol' ? 'asc' : 'desc')
    }
  }

  const filteredAndSorted = useMemo(() => {
    let list = prices.filter((p) => {
      if (filterType !== 'all' && p.type !== filterType) return false
      if (search) {
        const q = search.toLowerCase()
        return p.symbol.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)
      }
      return true
    })
    if (sortKey) {
      list = [...list].sort((a, b) => {
        let av: number | string = 0
        let bv: number | string = 0
        switch (sortKey) {
          case 'symbol': av = a.symbol; bv = b.symbol; break
          case 'price': av = a.price; bv = b.price; break
          case 'change': av = a.change; bv = b.change; break
          case 'changePercent': av = a.changePercent; bv = b.changePercent; break
          case 'volatility': av = riskMetrics?.[a.symbol]?.volatility ?? -Infinity; bv = riskMetrics?.[b.symbol]?.volatility ?? -Infinity; break
          case 'beta': av = riskMetrics?.[a.symbol]?.beta ?? -Infinity; bv = riskMetrics?.[b.symbol]?.beta ?? -Infinity; break
          case 'mdd': av = riskMetrics?.[a.symbol]?.maxDrawdown ?? -Infinity; bv = riskMetrics?.[b.symbol]?.maxDrawdown ?? -Infinity; break
          case 'pe': av = fundamentals?.[a.symbol]?.pe ?? -Infinity; bv = fundamentals?.[b.symbol]?.pe ?? -Infinity; break
          case 'yield': av = fundamentals?.[a.symbol]?.dividend_yield ?? -Infinity; bv = fundamentals?.[b.symbol]?.dividend_yield ?? -Infinity; break
          case 'health': av = healthScores?.[a.symbol]?.score ?? -Infinity; bv = healthScores?.[b.symbol]?.score ?? -Infinity; break
          case 'volume': av = a.volume ?? -Infinity; bv = b.volume ?? -Infinity; break
        }
        if (typeof av === 'string' && typeof bv === 'string') {
          return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
        }
        return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
      })
    }
    return list
  }, [prices, search, filterType, sortKey, sortDir, riskMetrics, fundamentals, healthScores])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <NoodleSpinner size={72} color="var(--accent-blue)" label="Loading watchlist…" />
      </div>
    )
  }

  if (prices.length === 0) {
    return (
      <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
        Your watchlist is empty. Add stocks, crypto, or ETFs below.
      </p>
    )
  }

  const canCollapse = filteredAndSorted.length > COLLAPSED_COUNT
  const visiblePrices = canCollapse && !expanded ? filteredAndSorted.slice(0, COLLAPSED_COUNT) : filteredAndSorted

  const typeCount = (t: FilterType) => t === 'all' ? prices.length : prices.filter((p) => p.type === t).length
  const hasMultipleTypes = new Set(prices.map((p) => p.type)).size > 1

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1" style={{ maxWidth: 220 }}>
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter symbols…"
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border-0 outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />
        </div>
        {hasMultipleTypes && (
          <div className="flex gap-1">
            {(['all', 'stock', 'crypto', 'etf'] as FilterType[]).map((t) => {
              const count = typeCount(t)
              if (t !== 'all' && count === 0) return null
              return (
                <button
                  key={t}
                  onClick={() => setFilterType(t)}
                  className="px-2 py-1 text-[11px] rounded-md transition-colors capitalize"
                  style={{
                    background: filterType === t ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                    color: filterType === t ? '#fff' : 'var(--text-secondary)',
                  }}
                >
                  {t === 'all' ? 'All' : t} {count}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: 680 }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)' }} className="text-xs uppercase tracking-wide">
              {([
                { key: 'symbol' as SortKey, label: 'Symbol', width: 90, align: 'left', title: undefined },
                { key: null, label: 'Name', width: 100, align: 'left', title: undefined },
                { key: 'price' as SortKey, label: 'Price', width: 70, align: 'right', title: undefined },
                { key: 'change' as SortKey, label: 'Chg', width: 60, align: 'right', title: undefined },
                { key: 'changePercent' as SortKey, label: '%', width: 50, align: 'right', title: undefined },
                { key: 'volatility' as SortKey, label: 'Vol', width: 40, align: 'right', title: 'Annualized volatility (60d)' },
                { key: 'beta' as SortKey, label: 'β', width: 38, align: 'right', title: 'Beta vs SPY (60d)' },
                { key: 'mdd' as SortKey, label: 'MDD', width: 48, align: 'right', title: 'Max drawdown (30d)' },
                { key: 'pe' as SortKey, label: 'P/E', width: 38, align: 'right', title: 'Price-to-earnings (TTM)' },
                { key: 'yield' as SortKey, label: 'Yld', width: 42, align: 'right', title: 'Dividend yield' },
                { key: 'health' as SortKey, label: 'H', width: 32, align: 'right', title: 'Composite health (0-100)' },
                { key: 'volume' as SortKey, label: 'Vol', width: 50, align: 'right', title: undefined },
              ] as const).map((col, ci) => (
                <th
                  key={ci}
                  className={`${col.align === 'left' ? 'text-left' : 'text-right'} py-2 font-medium ${col.key ? 'cursor-pointer select-none hover:text-[var(--text-secondary)] transition-colors' : ''}`}
                  style={{ width: col.width, maxWidth: col.label === 'Name' ? 100 : undefined }}
                  title={col.title}
                  onClick={col.key ? () => toggleSort(col.key!) : undefined}
                >
                  <span className="inline-flex items-center gap-0.5">
                    {col.label}
                    {col.key && sortKey === col.key && (
                      sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visiblePrices.map((p) => {
              const isUp = p.change > 0
              const isDown = p.change < 0
              const changeColor = isUp
                ? 'var(--accent-green)'
                : isDown
                  ? 'var(--accent-red)'
                  : 'var(--text-secondary)'
              const isSelected = selectedSymbol === p.symbol
              const risk = riskMetrics?.[p.symbol]
              const fund = fundamentals?.[p.symbol]
              const health = healthScores?.[p.symbol]
              const healthColor =
                health == null
                  ? 'var(--text-muted)'
                  : health.score >= 70
                    ? 'var(--accent-green)'
                    : health.score >= 40
                      ? 'var(--accent-amber)'
                      : 'var(--accent-red)'
              const breakdownTitle = health
                ? [
                    `Val: ${health.breakdown.valuation?.toFixed(0) ?? '—'}`,
                    `Mom: ${health.breakdown.momentum?.toFixed(0) ?? '—'}`,
                    `Risk: ${health.breakdown.risk?.toFixed(0) ?? '—'}`,
                    `Sent: ${health.breakdown.sentiment?.toFixed(0) ?? '—'}`,
                  ].join(' · ')
                : 'No data'

              return (
                <tr
                  key={p.symbol}
                  onClick={() => onSelect(p.symbol)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.symbol) } }}
                  tabIndex={0}
                  role="button"
                  className="cursor-pointer transition-colors hover:bg-white/5"
                  style={{
                    background: isSelected ? 'rgba(59, 130, 246, 0.1)' : undefined,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <td className="py-3 font-medium flex items-center gap-2">
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{
                        background:
                          p.type === 'crypto'
                            ? 'rgba(168, 85, 247, 0.15)'
                            : p.type === 'etf'
                              ? 'rgba(245, 158, 11, 0.15)'
                              : 'rgba(59, 130, 246, 0.15)',
                        color:
                          p.type === 'crypto'
                            ? 'var(--accent-purple)'
                            : p.type === 'etf'
                              ? 'var(--accent-amber)'
                              : 'var(--accent-blue)',
                      }}
                    >
                      {p.type.toUpperCase()}
                    </span>
                    {p.symbol}
                  </td>
                  <td
                    className="py-3 truncate"
                    style={{ color: 'var(--text-secondary)', maxWidth: 100 }}
                    title={p.name || ''}
                  >
                    {p.name || '--'}
                  </td>
                  <td className="py-3 text-right font-mono">
                    $
                    {p.price.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="py-3 text-right font-mono" style={{ color: changeColor }}>
                    {isUp ? '+' : ''}
                    {p.change.toFixed(2)}
                  </td>
                  <td className="py-3 text-right font-mono" style={{ color: changeColor }}>
                    {isUp ? '+' : ''}
                    {p.changePercent.toFixed(2)}%
                  </td>
                  <td
                    className="py-3 text-right font-mono"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {risk && risk.volatility > 0 ? `${risk.volatility.toFixed(0)}%` : '--'}
                  </td>
                  <td
                    className="py-3 text-right font-mono"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {risk?.beta != null ? risk.beta.toFixed(2) : '--'}
                  </td>
                  <td
                    className="py-3 text-right font-mono"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {risk && risk.maxDrawdown > 0 ? `-${risk.maxDrawdown.toFixed(1)}%` : '--'}
                  </td>
                  <td
                    className="py-3 text-right font-mono"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {fund?.pe != null ? fund.pe.toFixed(1) : '--'}
                  </td>
                  <td
                    className="py-3 text-right font-mono"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {fund?.dividend_yield != null
                      ? `${(fund.dividend_yield * 100).toFixed(2)}%`
                      : '--'}
                  </td>
                  <td className="py-3 text-right" title={breakdownTitle}>
                    {health != null ? (
                      <span
                        className="inline-block px-1.5 py-0.5 rounded text-xs font-mono font-semibold"
                        style={{ background: 'var(--bg-tertiary)', color: healthColor }}
                      >
                        {health.score}
                      </span>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        --
                      </span>
                    )}
                  </td>
                  <td
                    className="py-3 text-right font-mono"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {p.volume ? formatVolume(p.volume) : '--'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {canCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-center gap-1.5 w-full py-2 mt-1 text-xs rounded-lg transition-colors hover:bg-white/[0.04]"
          style={{ color: 'var(--accent-blue)' }}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? 'Show less' : `Show all ${filteredAndSorted.length} items`}
        </button>
      )}
    </div>
  )
}

function formatVolume(v: number): string {
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1) + 'B'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K'
  return v.toString()
}
