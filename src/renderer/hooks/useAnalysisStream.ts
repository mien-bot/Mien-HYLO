import { useEffect, useState, useCallback } from 'react'

/**
 * Subscribe to the analysis streaming channel (ai:analysis-stream-chunk /
 * ai:analysis-stream-end). Used by skill, briefing, and planner pages to
 * render the model's response as it streams instead of waiting for the
 * whole IPC promise to resolve.
 *
 * The channel is shared across pages — only one heavy analysis op should
 * be in flight at a time. Pages should call `reset()` before firing their
 * request so the buffer starts fresh.
 */
export function useAnalysisStream() {
  const [streamingContent, setStreamingContent] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)

  useEffect(() => {
    const cleanupChunk = window.api.onAnalysisStream((chunk: string) => {
      setStreamingContent((prev) => prev + chunk)
      setIsStreaming(true)
    })
    const cleanupEnd = window.api.onAnalysisStreamEnd((payload) => {
      setIsStreaming(false)
      if (payload?.error) setStreamError(payload.error)
    })
    return () => {
      cleanupChunk?.()
      cleanupEnd?.()
    }
  }, [])

  const reset = useCallback(() => {
    setStreamingContent('')
    setIsStreaming(false)
    setStreamError(null)
  }, [])

  return { streamingContent, isStreaming, streamError, reset }
}
