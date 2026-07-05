import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns'
import {
  Bookmark,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Heart,
  Newspaper,
  NotebookText,
  RefreshCw,
  Search,
  Utensils,
  Wallet,
  X,
} from 'lucide-react'
import NoodleSpinner from '../components/anim/NoodleSpinner'

type SavedItem = {
  id: string
  category: string
  title: string
  subtitle?: string | null
  note?: string | null
  date?: string | null
  savedAt?: string | null
  source: string
  meta?: string | null
  url?: string | null
}

type SavedOverview = {
  items: SavedItem[]
}

const CATEGORY_META: Record<string, { label: string; color: string; icon: any }> = {
  all: { label: 'All', color: 'var(--accent-blue)', icon: Bookmark },
  restaurant: { label: 'Restaurants', color: '#ff9f0a', icon: Utensils },
  bar: { label: 'Bars', color: 'var(--accent-purple)', icon: Utensils },
  dessert: { label: 'Dessert', color: '#ff375f', icon: Utensils },
  cafe: { label: 'Cafes', color: 'var(--accent-amber)', icon: Utensils },
  attraction: { label: 'Places', color: 'var(--accent-cyan)', icon: Heart },
  place: { label: 'Places', color: 'var(--accent-cyan)', icon: Heart },
  visit: { label: 'Visits', color: 'var(--accent-green)', icon: NotebookText },
  finance: { label: 'Finance', color: 'var(--accent-blue)', icon: Newspaper },
  portfolio: { label: 'Portfolio', color: 'var(--accent-green)', icon: Wallet },
  weekend: { label: 'Weekend', color: 'var(--accent-purple)', icon: CalendarDays },
  schedule: { label: 'Schedules', color: 'var(--accent-cyan)', icon: CalendarDays },
  briefing: { label: 'Briefings', color: 'var(--accent-amber)', icon: FileText },
  health: { label: 'Health', color: '#ff375f', icon: Heart },
}

function getCategoryMeta(category: string) {
  return (
    CATEGORY_META[category] || {
      label: category.replace(/_/g, ' '),
      color: 'var(--text-muted)',
      icon: Bookmark,
    }
  )
}

function parseItemDate(value?: string | null): Date | null {
  if (!value) return null
  try {
    const parsed = parseISO(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  } catch {
    return null
  }
}

function itemDateKey(item: SavedItem): string {
  return item.date || item.savedAt?.slice(0, 10) || ''
}

function getItemRoute(item: SavedItem): string {
  if (
    ['restaurant', 'bar', 'dessert', 'cafe', 'attraction', 'place', 'visit', 'weekend'].includes(
      item.category,
    )
  )
    return '/weekend'
  if (item.category === 'finance') return '/finance'
  if (item.category === 'portfolio') return '/portfolio'
  if (item.category === 'schedule') return '/productivity'
  if (item.category === 'health') return '/health'
  if (item.category === 'briefing') return '/chat'
  return '/saved'
}

function ItemCard({ item, onOpen }: { item: SavedItem; onOpen: (item: SavedItem) => void }) {
  const meta = getCategoryMeta(item.category)
  const Icon = meta.icon
  const route = getItemRoute(item)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(item)
        }
      }}
      className="cursor-pointer rounded-lg p-3 transition-colors hover:bg-white/[0.05] focus:outline-none focus:ring-1 focus:ring-blue-500/60"
      style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--separator)' }}
      title={`Open ${route}`}
    >
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 rounded-lg p-2"
          style={{ color: meta.color, background: 'rgba(255,255,255,0.04)' }}
        >
          <Icon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {item.title}
              </p>
              <p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {[item.source, item.meta, itemDateKey(item)].filter(Boolean).join(' - ')}
              </p>
            </div>
            {item.url && (
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  window.open(item.url!, '_blank')
                }}
                className="shrink-0 rounded-md p-1.5 transition-colors hover:bg-white/[0.06]"
                style={{ color: 'var(--text-muted)' }}
                title="Open external link"
              >
                <ExternalLink size={13} />
              </button>
            )}
          </div>
          {item.subtitle && (
            <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {item.subtitle}
            </p>
          )}
          {item.note && (
            <p
              className="mt-2 line-clamp-3 text-xs leading-relaxed"
              style={{ color: 'var(--text-muted)' }}
            >
              {item.note}
            </p>
          )}
          <p className="mt-2 text-[10px]" style={{ color: meta.color }}>
            Click to view details
          </p>
        </div>
      </div>
    </div>
  )
}

export default function SavedPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<SavedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    window.api
      .getSavedOverview()
      .then((data: SavedOverview) => setItems(Array.isArray(data?.items) ? data.items : []))
      .catch(() => setError('Saved information could not be loaded.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) counts.set(item.category, (counts.get(item.category) || 0) + 1)
    const entries = Array.from(counts.entries()).sort((a, b) =>
      getCategoryMeta(a[0]).label.localeCompare(getCategoryMeta(b[0]).label),
    )
    return [['all', items.length] as [string, number], ...entries]
  }, [items])

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      if (activeCategory !== 'all' && item.category !== activeCategory) return false
      if (!q) return true
      return [item.title, item.subtitle, item.note, item.source, item.meta].some((value) =>
        String(value || '')
          .toLowerCase()
          .includes(q),
      )
    })
  }, [items, activeCategory, query])

  const itemsByDate = useMemo(() => {
    const grouped = new Map<string, SavedItem[]>()
    for (const item of filteredItems) {
      const key = itemDateKey(item)
      if (!key) continue
      grouped.set(key, [...(grouped.get(key) || []), item])
    }
    return grouped
  }, [filteredItems])

  const calendarDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(month))
    const end = endOfWeek(endOfMonth(month))
    return eachDayOfInterval({ start, end })
  }, [month])

  const selectedItems = selectedDate ? itemsByDate.get(selectedDate) || [] : []
  const recentItems = filteredItems.slice(0, 30)
  const [detailItem, setDetailItem] = useState<SavedItem | null>(null)

  const openItem = (item: SavedItem) => {
    setDetailItem(item)
  }

  if (loading) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <NoodleSpinner size={88} color="var(--accent-blue)" label="Loading saved information..." />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Bookmark size={18} style={{ color: 'var(--accent-blue)' }} />
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              Saved
            </h1>
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {items.length} saved item{items.length === 1 ? '' : 's'} across notes, plans, places,
            finance, health, and briefings.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors hover:opacity-80"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--separator)',
          }}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {error && (
        <div
          className="rounded-lg p-3 text-sm"
          style={{
            background: 'rgba(255,69,58,0.12)',
            color: 'var(--accent-red)',
            border: '1px solid rgba(255,69,58,0.22)',
          }}
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {categories.map(([category, count]) => {
          const meta = getCategoryMeta(category)
          const Icon = meta.icon
          const active = activeCategory === category
          return (
            <button
              key={category}
              onClick={() => setActiveCategory(category)}
              className="rounded-lg p-3 text-left transition-colors hover:bg-white/[0.05]"
              style={{
                background: active ? 'rgba(255,255,255,0.08)' : 'var(--bg-card)',
                border: `1px solid ${active ? meta.color : 'var(--border)'}`,
              }}
            >
              <div className="flex items-center justify-between">
                <Icon size={15} style={{ color: meta.color }} />
                <span className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {count}
                </span>
              </div>
              <p
                className="mt-2 truncate text-xs font-medium"
                style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
              >
                {meta.label}
              </p>
            </button>
          )
        })}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="card">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CalendarDays size={16} style={{ color: 'var(--accent-cyan)' }} />
              <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {format(month, 'MMMM yyyy')}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMonth(subMonths(month, 1))}
                className="rounded-lg p-2 hover:bg-white/[0.05]"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Previous month"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                onClick={() => setMonth(startOfMonth(new Date()))}
                className="rounded-lg px-3 py-2 text-xs hover:bg-white/[0.05]"
                style={{ color: 'var(--text-muted)' }}
              >
                Today
              </button>
              <button
                onClick={() => setMonth(addMonths(month, 1))}
                className="rounded-lg p-2 hover:bg-white/[0.05]"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Next month"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>

          <div
            className="grid grid-cols-7 gap-px overflow-hidden rounded-lg"
            style={{ background: 'var(--separator)', border: '1px solid var(--separator)' }}
          >
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <div
                key={day}
                className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
              >
                {day}
              </div>
            ))}
            {calendarDays.map((day) => {
              const key = format(day, 'yyyy-MM-dd')
              const dayItems = itemsByDate.get(key) || []
              const inMonth = isSameMonth(day, month)
              const selected = selectedDate === key
              return (
                <button
                  key={key}
                  onClick={() => setSelectedDate(selected ? null : key)}
                  className="min-h-[112px] p-2 text-left transition-colors hover:bg-white/[0.04]"
                  style={{
                    background: selected ? 'rgba(10,132,255,0.12)' : 'var(--bg-card)',
                    opacity: inMonth ? 1 : 0.45,
                    outline: selected ? '1px solid var(--accent-blue)' : 'none',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="text-xs font-medium"
                      style={{ color: inMonth ? 'var(--text-secondary)' : 'var(--text-muted)' }}
                    >
                      {format(day, 'd')}
                    </span>
                    {dayItems.length > 0 && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[9px]"
                        style={{ color: 'white', background: 'var(--accent-blue)' }}
                      >
                        {dayItems.length}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 space-y-1">
                    {dayItems.slice(0, 3).map((item) => {
                      const meta = getCategoryMeta(item.category)
                      return (
                        <div
                          key={item.id}
                          className="truncate rounded px-1.5 py-1 text-[10px]"
                          style={{
                            color: 'var(--text-secondary)',
                            background: 'rgba(255,255,255,0.04)',
                            borderLeft: `2px solid ${meta.color}`,
                          }}
                        >
                          {item.title}
                        </div>
                      )
                    })}
                    {dayItems.length > 3 && (
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        +{dayItems.length - 3} more
                      </p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card">
            <div className="mb-3 flex items-center gap-2">
              <Search size={14} style={{ color: 'var(--accent-blue)' }} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search saved information"
                className="w-full bg-transparent text-sm outline-none"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Showing {filteredItems.length} of {items.length}
            </p>
          </div>

          <div className="card">
            <h2 className="mb-3 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {selectedDate ? format(parseISO(selectedDate), 'MMM d, yyyy') : 'Recent saved'}
            </h2>
            <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
              {(selectedDate ? selectedItems : recentItems).length > 0 ? (
                (selectedDate ? selectedItems : recentItems).map((item) => (
                  <ItemCard key={item.id} item={item} onOpen={openItem} />
                ))
              ) : (
                <p className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  No saved items found.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Detail popup modal */}
      {detailItem &&
        (() => {
          const meta = getCategoryMeta(detailItem.category)
          const Icon = meta.icon
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              onClick={() => setDetailItem(null)}
              role="dialog"
              aria-modal="true"
              aria-label="Item detail"
            >
              <div
                className="relative mx-4 max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl p-5"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--separator)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-4 flex items-start gap-3">
                  <div
                    className="rounded-lg p-2.5"
                    style={{ color: meta.color, background: 'rgba(255,255,255,0.04)' }}
                  >
                    <Icon size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3
                      className="text-base font-semibold"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {detailItem.title}
                    </h3>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {[detailItem.source, detailItem.meta, itemDateKey(detailItem)]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <button
                    onClick={() => setDetailItem(null)}
                    className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/10"
                    style={{ color: 'var(--text-muted)' }}
                    aria-label="Close detail"
                  >
                    <X size={16} />
                  </button>
                </div>

                {detailItem.subtitle && (
                  <p
                    className="mb-3 text-sm leading-relaxed"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {detailItem.subtitle}
                  </p>
                )}
                {detailItem.note && (
                  <p
                    className="mb-3 text-sm leading-relaxed whitespace-pre-wrap"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {detailItem.note}
                  </p>
                )}

                <div className="mt-4 flex items-center gap-2">
                  <button
                    onClick={() => {
                      navigate(getItemRoute(detailItem))
                      setDetailItem(null)
                    }}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors hover:opacity-90"
                    style={{ background: meta.color, color: 'white' }}
                  >
                    Go to page
                  </button>
                  {detailItem.url && (
                    <button
                      onClick={() => window.open(detailItem.url!, '_blank')}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors hover:bg-white/5"
                      style={{ color: 'var(--text-muted)', border: '1px solid var(--separator)' }}
                    >
                      <ExternalLink size={12} /> Open link
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })()}
    </div>
  )
}
