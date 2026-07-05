import { useEffect, useMemo, useState } from 'react'
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Link2,
  Play,
  Sparkles,
} from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import type { NewsArticle } from '../../../shared/types/ipc.types'
import NoodleSpinner from '../anim/NoodleSpinner'

type Filter = 'all' | 'saved'
type Mode = 'standard' | 'deep'

function isYouTube(item: NewsArticle): boolean {
  return Boolean(
    item.source?.startsWith('YouTube:') || /youtube\.com|youtu\.be/i.test(item.url || ''),
  )
}

function sourceLabel(item: NewsArticle): string {
  return (item.source || 'Web').replace('YouTube: ', '')
}

function parseTickers(raw: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export default function SummariesPanel() {
  const [items, setItems] = useState<NewsArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<Mode>('standard')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const load = async () => {
    try {
      const rows = await window.api.getSummarizedNews()
      setItems(Array.isArray(rows) ? rows : [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const handleAdd = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    if (!/^https?:\/\/\S+$/i.test(trimmed)) {
      setStatus({ kind: 'err', text: 'Paste a full http(s) link.' })
      return
    }
    setSubmitting(true)
    setStatus({ kind: 'ok', text: mode === 'deep' ? 'Fetching + deep summarizing…' : 'Fetching + summarizing…' })
    try {
      const row = await window.api.addLinkSummary(trimmed, mode)
      setUrl('')
      setStatus({ kind: 'ok', text: 'Saved to summaries.' })
      // Put the new/updated row at the top and auto-expand it.
      setItems((prev) => [row, ...prev.filter((p) => p.id !== row.id)])
      setExpanded((prev) => new Set(prev).add(row.id))
      setTimeout(() => setStatus(null), 2500)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const msg = raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim()
      setStatus({ kind: 'err', text: msg || 'Could not summarize that link.' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleSave = async (item: NewsArticle) => {
    const next = !item.saved_at
    setItems((prev) =>
      prev.map((p) =>
        p.id === item.id ? { ...p, saved_at: next ? new Date().toISOString() : null } : p,
      ),
    )
    try {
      await window.api.toggleNewsSaved(item.id, next)
    } catch {
      setItems((prev) =>
        prev.map((p) => (p.id === item.id ? { ...p, saved_at: item.saved_at } : p)),
      )
    }
  }

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      if (filter === 'saved' && !item.saved_at) return false
      if (!q) return true
      return (
        item.title?.toLowerCase().includes(q) ||
        item.source?.toLowerCase().includes(q) ||
        item.summary?.toLowerCase().includes(q)
      )
    })
  }, [items, query, filter])

  return (
    <div>
      {/* Add-a-link box */}
      <div
        className="rounded-lg p-3 mb-3"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-2">
          <Link2 size={14} style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting) handleAdd()
            }}
            placeholder="Paste a YouTube or article link to summarize…"
            disabled={submitting}
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {(['standard', 'deep'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="text-xs px-2 py-1 transition-colors"
                style={{
                  background: mode === m ? 'rgba(139, 92, 246, 0.18)' : 'transparent',
                  color: mode === m ? '#a78bfa' : 'var(--text-muted)',
                }}
              >
                {m === 'standard' ? 'Quick' : 'Deep'}
              </button>
            ))}
          </div>
          <button
            onClick={handleAdd}
            disabled={submitting || !url.trim()}
            className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-md font-medium transition-colors disabled:opacity-40"
            style={{ background: 'rgba(139, 92, 246, 0.16)', color: '#a78bfa' }}
          >
            {submitting ? <NoodleSpinner size={13} color="#a78bfa" /> : <Sparkles size={13} />}
            {submitting ? 'Working…' : 'Summarize & Save'}
          </button>
        </div>
        {status && (
          <p
            className="text-xs mt-2 ml-6"
            style={{ color: status.kind === 'err' ? '#ef4444' : 'var(--accent-green)' }}
          >
            {status.text}
          </p>
        )}
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search summaries…"
          className="flex-1 text-xs px-2.5 py-1.5 rounded-md bg-transparent outline-none"
          style={{ border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        />
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {(['all', 'saved'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="text-xs px-2.5 py-1.5 transition-colors capitalize"
              style={{
                background: filter === f ? 'var(--bg-secondary)' : 'transparent',
                color: filter === f ? 'var(--accent-blue)' : 'var(--text-muted)',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-8">
          <NoodleSpinner size={48} color="var(--accent-blue)" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm py-6 text-center" style={{ color: 'var(--text-muted)' }}>
          {items.length === 0
            ? 'No summaries yet. Paste a link above, or use Quick/Deep Summary in the News feed.'
            : 'No summaries match your search.'}
        </p>
      ) : (
        <div className="space-y-2 max-h-[28rem] overflow-y-auto">
          {filtered.map((item) => {
            const yt = isYouTube(item)
            const open = expanded.has(item.id)
            const tickers = parseTickers(item.related_symbols)
            return (
              <div
                key={item.id}
                className="rounded-lg"
                style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
              >
                <div className="flex items-start gap-2 p-2.5">
                  <button
                    onClick={() => toggleExpand(item.id)}
                    className="mt-0.5 shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                    aria-label={open ? 'Collapse summary' : 'Expand summary'}
                  >
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <button
                      onClick={() => toggleExpand(item.id)}
                      className="text-sm leading-snug text-left w-full"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {item.title}
                    </button>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span
                        className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium"
                        style={
                          yt
                            ? { background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }
                            : { background: 'rgba(59, 130, 246, 0.12)', color: 'var(--accent-blue)' }
                        }
                      >
                        {yt ? <Play size={10} /> : <Globe size={10} />}
                        {yt ? 'Video' : 'Article'}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--accent-blue)' }}>
                        {sourceLabel(item)}
                      </span>
                      {item.published_at && (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {formatDistanceToNow(parseISO(item.published_at), { addSuffix: true })}
                        </span>
                      )}
                      {tickers.map((s) => (
                        <span
                          key={s}
                          className="text-xs px-1.5 py-0.5 rounded"
                          style={{ background: 'rgba(59, 130, 246, 0.1)', color: 'var(--accent-blue)' }}
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 rounded hover:bg-white/5"
                      style={{ color: 'var(--text-muted)' }}
                      title="Open link"
                    >
                      <ExternalLink size={13} />
                    </a>
                    <button
                      onClick={() => handleToggleSave(item)}
                      className="p-1 rounded hover:bg-white/5"
                      style={{ color: item.saved_at ? 'var(--accent-green)' : 'var(--text-muted)' }}
                      title={item.saved_at ? 'Saved' : 'Save'}
                    >
                      {item.saved_at ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
                    </button>
                  </div>
                </div>
                {open && item.summary && (
                  <div
                    className="mx-2.5 mb-2.5 p-2.5 rounded-lg text-xs leading-relaxed"
                    style={{
                      background: 'rgba(139, 92, 246, 0.06)',
                      color: 'var(--text-secondary)',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {item.summary}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
