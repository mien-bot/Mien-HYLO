import { useState, useEffect, useCallback, useRef } from 'react'
import type { ChatMessage, ChatAttachmentInput } from '../../shared/types/ipc.types'
import { parseSlash, isSlashCommand } from '../lib/slash-commands'

export function useChat(conversationId: string = 'default', model?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingContent, setStreamingContent] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cleanupRef = useRef<(() => void)[]>([])
  const modelRef = useRef(model)

  useEffect(() => {
    modelRef.current = model
  }, [model])

  // Load history on mount / conversation switch
  useEffect(() => {
    window.api.getChatHistory(conversationId).then(setMessages)
  }, [conversationId])

  // Set up stream listeners
  useEffect(() => {
    const cleanupChunk = window.api.onChatStream((chunk: string) => {
      setStreamingContent((prev) => prev + chunk)
    })

    const cleanupEnd = window.api.onChatStreamEnd(() => {
      setIsStreaming(false)
      setStreamingContent('')
      setToolStatus(null)
      // Reload full history to get the saved message
      window.api.getChatHistory(conversationId).then(setMessages)
    })

    // Live tool activity status while the agent runs tools mid-turn.
    const cleanupTool = window.api.onChatTool((status) => {
      setToolStatus(status.phase === 'start' ? status.label : null)
    })

    cleanupRef.current = [cleanupChunk, cleanupEnd, cleanupTool]

    return () => {
      cleanupRef.current.forEach((fn) => fn())
    }
  }, [conversationId])

  const runSlashCommand = useCallback(
    async (input: string) => {
      const { command, args, raw } = parseSlash(input)
      setError(null)

      // Always record the user's input as a chat message
      const userMsg: ChatMessage = {
        id: Date.now(),
        role: 'user',
        content: raw,
        conversation_id: conversationId,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, userMsg])
      try {
        await window.api.saveChatMessage('user', raw, conversationId)
      } catch {}

      if (!command) {
        const tip = `Unknown command \`${raw.split(/\s+/)[0]}\`. Type \`/help\` to see what's available.`
        try {
          await window.api.saveChatMessage('assistant', tip, conversationId)
        } catch {}
        window.api.getChatHistory(conversationId).then(setMessages)
        return
      }

      setIsStreaming(true)
      try {
        const result = await command.run(args)
        try {
          await window.api.saveChatMessage('assistant', result, conversationId)
        } catch {}
        window.api.getChatHistory(conversationId).then(setMessages)
      } catch (err: any) {
        const errText = `Error running ${command.name}: ${err?.message || 'unknown error'}`
        try {
          await window.api.saveChatMessage('assistant', errText, conversationId)
        } catch {}
        window.api.getChatHistory(conversationId).then(setMessages)
        setError(err?.message || 'Command failed')
      }
      setIsStreaming(false)
    },
    [conversationId],
  )

  const sendMessage = useCallback(
    async (content: string, attachments?: ChatAttachmentInput[]) => {
      const hasAttachments = !!attachments && attachments.length > 0
      if ((!content.trim() && !hasAttachments) || isStreaming) return

      if (!hasAttachments && isSlashCommand(content)) {
        return runSlashCommand(content)
      }

      setError(null)
      setIsStreaming(true)
      setStreamingContent('')
      setToolStatus(null)

      // Optimistically add user message to UI
      const userMsg: ChatMessage = {
        id: Date.now(),
        role: 'user',
        content,
        conversation_id: conversationId,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, userMsg])

      try {
        await window.api.chat(content, conversationId, modelRef.current, attachments)
      } catch (err: any) {
        setError(err.message || 'Failed to send message')
        setIsStreaming(false)
        setStreamingContent('')
        setToolStatus(null)
      }
    },
    [conversationId, isStreaming, runSlashCommand],
  )

  // Re-run the last assistant turn from the same question.
  const regenerate = useCallback(async () => {
    if (isStreaming) return
    setError(null)
    setIsStreaming(true)
    setStreamingContent('')
    setToolStatus(null)
    // Drop trailing assistant message(s) from the UI immediately.
    setMessages((prev) => {
      const copy = [...prev]
      while (copy.length && copy[copy.length - 1].role === 'assistant') copy.pop()
      return copy
    })
    try {
      await window.api.regenerateChat(conversationId, modelRef.current)
    } catch (err: any) {
      setError(err.message || 'Failed to regenerate')
      setIsStreaming(false)
      setStreamingContent('')
      setToolStatus(null)
    }
  }, [conversationId, isStreaming])

  // Edit a prior user message: trim it + everything after, then resend.
  const editAndResend = useCallback(
    async (messageId: number, newText: string) => {
      if (isStreaming || !newText.trim()) return
      try {
        await window.api.trimMessagesFrom(conversationId, messageId)
      } catch {}
      const hist = await window.api.getChatHistory(conversationId)
      setMessages(hist)
      await sendMessage(newText)
    },
    [conversationId, isStreaming, sendMessage],
  )

  const cancelStream = useCallback(() => {
    // Abort the in-flight turn in the main process (stops the API stream and
    // any running tools), then reset local UI state.
    window.api.cancelChat(conversationId).catch(() => {})
    setIsStreaming(false)
    setStreamingContent('')
    setToolStatus(null)
  }, [conversationId])

  const clearChat = useCallback(async () => {
    try {
      await window.api.clearChatHistory(conversationId)
      setMessages([])
      setStreamingContent('')
      setError(null)
    } catch (err: any) {
      setError(err.message || 'Failed to clear chat')
    }
  }, [conversationId])

  return {
    messages,
    streamingContent,
    isStreaming,
    toolStatus,
    error,
    sendMessage,
    regenerate,
    editAndResend,
    cancelStream,
    clearChat,
  }
}
