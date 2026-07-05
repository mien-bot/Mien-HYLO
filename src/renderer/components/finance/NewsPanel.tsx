import { useState } from 'react'
import { Bookmark, BookmarkCheck, ExternalLink, FileText, RefreshCw } from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import type { NewsArticle } from '../../../shared/types/ipc.types'
import { scoreSentiment, sentimentColor, type Sentiment } from '../../../shared/news-sentiment'
import NoodleSpinner from '../anim/NoodleSpinner'

interface Props {
  news: NewsArticle[]
  loading: boolean
}

export default function NewsPanel({ news, loading }: Props) {
  const [summaries, setSummaries] = useState<Record<number, { text: string; loading: boolean }>>({})
  const [saved, setSaved] = useState<Record<number, boolean>>({})

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <NoodleSpinner size={56} color="var(--accent-blue)" />
      </div>
    )
  }

  if (news.length === 0) {
    return (
      <p className="text-sm py-4" style={{ color: 'var(--text-muted)' }}>
        No news yet. Click Refresh to fetch latest headlines.
      </p>
    )
  }

  const handleSummarize = async (
    article: NewsArticle,
    mode: 'standard' | 'deep' = 'standard',
    forceRegen = false,
  ) => {
    const current = summaries[article.id]
    if (current?.loading) return

    // Quick button: never regenerate when a summary already exists — toggle the
    // cached one open/closed. Only the explicit "Regenerate" button (forceRegen)
    // or the Deep button calls the AI again.
    if (mode === 'standard' && !forceRegen) {
      if (current) {
        setSummaries((prev) => {
          const next = { ...prev }
          delete next[article.id]
          return next
        })
        return
      }
      if (article.summary) {
        setSummaries((prev) => ({
          ...prev,
          [article.id]: { text: article.summary!, loading: false },
        }))
        return
      }
    }
    // Fetch summary
    setSummaries((prev) => ({ ...prev, [article.id]: { text: '', loading: true } }))
    try {
      const payload = {
        id: article.id,
        title: article.title,
        url: article.url,
        source: article.source,
        related_symbols: article.related_symbols,
        summary: article.summary,
        content_context: article.content_context,
      }
      const summary =
        mode === 'deep'
          ? await window.api.deepSummarizeNewsArticle(payload)
          : await window.api.summarizeNewsArticle(payload)
      setSummaries((prev) => ({ ...prev, [article.id]: { text: summary, loading: false } }))
      // Update the article object so subsequent toggles use cache
      article.summary = summary
    } catch (err: any) {
      setSummaries((prev) => ({
        ...prev,
        [article.id]: { text: formatSummaryError(err), loading: false },
      }))
    }
  }

  const handleSave = async (article: NewsArticle) => {
    const isSaved = saved[article.id] ?? Boolean(article.saved_at)
    setSaved((prev) => ({ ...prev, [article.id]: !isSaved }))
    try {
      const updated = await window.api.toggleNewsSaved(article.id, !isSaved)
      article.saved_at = updated?.saved_at ?? (!isSaved ? new Date().toISOString() : null)
      setSaved((prev) => ({ ...prev, [article.id]: Boolean(article.saved_at) }))
    } catch {
      setSaved((prev) => ({ ...prev, [article.id]: isSaved }))
    }
  }

  return (
    <div className="space-y-3 max-h-96 overflow-y-auto">
      {news.map((article) => {
        const sentiment: Sentiment =
          (article.sentiment as Sentiment | null) || scoreSentiment(article.title || '')
        const isAi = article.sentiment_source === 'ai'
        const isYouTube = isYouTubeArticle(article)
        const summaryState = summaries[article.id]
        const isSaved = saved[article.id] ?? Boolean(article.saved_at)

        return (
          <div key={article.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block p-3 pb-1 rounded-lg hover:bg-white/5 transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 flex-1">
                  <span
                    className="text-base leading-none mt-0.5"
                    style={{ color: sentimentColor(sentiment) }}
                    title={`${sentiment}${isAi ? ' (AI)' : ' (heuristic)'}`}
                  >
                    {sentiment === 'neutral' ? '○' : '●'}
                  </span>
                  <h4
                    className="text-sm leading-snug flex-1"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {cleanTitle(article.title)}
                  </h4>
                </div>
                <ExternalLink
                  size={12}
                  className="shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: 'var(--text-muted)' }}
                />
              </div>
              <div className="flex items-center gap-2 mt-1.5 ml-6">
                {isYouTube && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded font-medium"
                    style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}
                  >
                    YT
                  </span>
                )}
                {article.source && (
                  <span className="text-xs" style={{ color: 'var(--accent-blue)' }}>
                    {article.source.replace('YouTube: ', '')}
                  </span>
                )}
                {article.published_at && (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {formatDistanceToNow(parseISO(article.published_at), { addSuffix: true })}
                  </span>
                )}
                {article.related_symbols && (
                  <div className="flex gap-1">
                    {(() => {
                      try {
                        return JSON.parse(article.related_symbols)
                      } catch {
                        return []
                      }
                    })().map((s: string) => (
                      <span
                        key={s}
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{
                          background: 'rgba(59, 130, 246, 0.1)',
                          color: 'var(--accent-blue)',
                        }}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                {isSaved && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(34, 197, 94, 0.12)', color: 'var(--accent-green)' }}
                  >
                    Saved
                  </span>
                )}
              </div>
            </a>
            <div className="ml-9 pb-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleSummarize(article)}
                  disabled={summaryState?.loading}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors mt-1"
                  style={{
                    background:
                      summaryState && !summaryState.loading
                        ? 'rgba(139, 92, 246, 0.15)'
                        : 'rgba(139, 92, 246, 0.1)',
                    color: '#a78bfa',
                    cursor: summaryState?.loading ? 'wait' : 'pointer',
                  }}
                >
                  <FileText size={11} />
                  {summaryState?.loading
                    ? 'Summarizing…'
                    : summaryState
                      ? 'Hide Summary'
                      : article.summary
                        ? 'View Summary'
                        : 'Quick Summary'}
                </button>
                {article.summary && !summaryState?.loading && (
                  <button
                    onClick={() => handleSummarize(article, 'standard', true)}
                    title="Generate a fresh summary"
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors mt-1"
                    style={{ background: 'rgba(255, 255, 255, 0.06)', color: 'var(--text-secondary)' }}
                  >
                    <RefreshCw size={11} />
                    Regenerate
                  </button>
                )}
                <button
                  onClick={() => handleSummarize(article, 'deep')}
                  disabled={summaryState?.loading}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors mt-1"
                  style={{
                    background: 'rgba(59, 130, 246, 0.1)',
                    color: 'var(--accent-blue)',
                    cursor: summaryState?.loading ? 'wait' : 'pointer',
                  }}
                >
                  <FileText size={11} />
                  Deep Summary
                </button>
                <button
                  onClick={() => handleSave(article)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors mt-1"
                  style={{
                    background: isSaved ? 'rgba(34, 197, 94, 0.14)' : 'rgba(255, 255, 255, 0.06)',
                    color: isSaved ? 'var(--accent-green)' : 'var(--text-secondary)',
                  }}
                >
                  {isSaved ? <BookmarkCheck size={11} /> : <Bookmark size={11} />}
                  {isSaved ? 'Saved' : 'Save'}
                </button>
              </div>
              {summaryState && (
                <div
                  className="mt-2 text-xs leading-relaxed rounded-lg p-2.5"
                  style={{ background: 'rgba(139, 92, 246, 0.06)', color: 'var(--text-secondary)' }}
                >
                  {summaryState.loading ? (
                    <div className="flex items-center gap-2">
                      <NoodleSpinner size={14} color="#a78bfa" />
                      <span style={{ color: 'var(--text-muted)' }}>Generating summary...</span>
                    </div>
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{summaryState.text}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function cleanTitle(title: string): string {
  // Remove " - Source" suffix that Google News adds
  return title.replace(/ - [^-]+$/, '')
}

function isYouTubeArticle(article: NewsArticle): boolean {
  return Boolean(
    article.source?.startsWith('YouTube:') || /youtube\.com|youtu\.be/i.test(article.url || ''),
  )
}

function formatSummaryError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim()
  if (/connection error|network|fetch failed|timeout|econnrefused|enotfound/i.test(message)) {
    return [
      'AI summary is not reachable right now.',
      '',
      'Check Settings > AI relay/API configuration, then try Quick Summary or Deep Summary again.',
      'For YouTube videos, Mien uses the description, captions/subtitles, and optional local audio transcription when available.',
    ].join('\n')
  }
  return `Summary failed: ${message || 'Unknown error'}`
}
