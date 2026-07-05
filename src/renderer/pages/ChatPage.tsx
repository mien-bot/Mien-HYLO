import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import {
  Send,
  Square,
  Bot,
  User,
  AlertCircle,
  Trash2,
  Plus,
  Pin,
  PinOff,
  Pencil,
  Check,
  X,
  Copy,
  RefreshCw,
  Brain,
  Search,
  ArrowDown,
  Paperclip,
  Archive,
  ArchiveRestore,
  Download,
  FileText,
  ChevronRight,
  ChevronDown,
  Loader2,
} from 'lucide-react'
import { useChat } from '../hooks/useChat'
import { renderMarkdown } from '../lib/markdown'
import { COMMANDS } from '../lib/slash-commands'
import type {
  ChatMemory,
  ChatAttachment,
  ChatAttachmentInput,
  ChatSearchResult,
} from '../../shared/types/ipc.types'
import {
  formatDistanceToNow,
  parseISO,
  isToday,
  isYesterday,
  differenceInCalendarDays,
} from 'date-fns'

/** Just the appSettings fields this page reads/writes. Spreading the full
 *  stored object at runtime preserves every other setting. */
interface ChatAppSettings {
  chatModel?: string
  chatAutoMemory?: string
}

interface Conversation {
  conversation_id: string
  title: string
  last_message_at: string
  message_count: number
  pinned: number
}

type ChatModel = 'sonnet' | 'opus'

export default function ChatPage() {
  const [conversationId, setConversationId] = useState<string>('default')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [input, setInput] = useState('')
  const [model, setModel] = useState<ChatModel>('sonnet')
  const {
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
  } = useChat(conversationId, model)

  const [confirmClear, setConfirmClear] = useState(false)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Conversation list state
  const [search, setSearch] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Archived conversations
  const [archived, setArchived] = useState<Conversation[]>([])
  const [showArchived, setShowArchived] = useState(false)

  // Full-text message search
  const [msgResults, setMsgResults] = useState<ChatSearchResult[]>([])
  const [pendingJumpId, setPendingJumpId] = useState<number | null>(null)
  const [highlightMsgId, setHighlightMsgId] = useState<number | null>(null)

  // Attachments: pending (composer) + loaded per-message map for rendering
  const [pendingFiles, setPendingFiles] = useState<ChatAttachmentInput[]>([])
  const [attachmentsByMsg, setAttachmentsByMsg] = useState<Record<number, ChatAttachment[]>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Message edit state
  const [editingMsgId, setEditingMsgId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  // Memory panel
  const [showMemory, setShowMemory] = useState(false)

  // Scroll handling
  const messagesRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const forceJumpRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  // Slash autocomplete
  const [slashIndex, setSlashIndex] = useState(0)

  const loadConversations = useCallback(async () => {
    try {
      const convos = (await window.api.listConversations()) as Conversation[]
      setConversations(convos || [])
    } catch {}
  }, [])

  const loadArchived = useCallback(async () => {
    try {
      const rows = (await window.api.listArchivedConversations()) as Conversation[]
      setArchived(rows || [])
    } catch {}
  }, [])

  useEffect(() => {
    loadConversations()
    loadArchived()
  }, [loadConversations, loadArchived])

  // Reload conversation list when message count changes (titles/pins update too)
  useEffect(() => {
    loadConversations()
  }, [messages.length, isStreaming, loadConversations])

  // Load attachments for the current conversation so user bubbles can show them.
  useEffect(() => {
    let cancelled = false
    window.api
      .getConversationAttachments(conversationId)
      .then((rows) => {
        if (cancelled) return
        const map: Record<number, ChatAttachment[]> = {}
        for (const a of rows || []) (map[a.message_id] ||= []).push(a)
        setAttachmentsByMsg(map)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [conversationId, messages.length])

  // Debounced full-text message search (in addition to title filtering).
  useEffect(() => {
    const q = search.trim()
    if (!q) {
      setMsgResults([])
      return
    }
    const t = setTimeout(() => {
      window.api
        .searchMessages(q)
        .then((rows) => setMsgResults(rows || []))
        .catch(() => {})
    }, 200)
    return () => clearTimeout(t)
  }, [search])

  // Load the persisted model preference once.
  useEffect(() => {
    window.api
      .getSettings('appSettings')
      .then((val) => {
        const s = (val as ChatAppSettings | null) || {}
        if (s.chatModel === 'opus' || s.chatModel === 'sonnet') setModel(s.chatModel)
      })
      .catch(() => {})
  }, [])

  const persistModel = useCallback(async (next: ChatModel) => {
    setModel(next)
    try {
      const current = ((await window.api.getSettings('appSettings')) as ChatAppSettings | null) || {}
      await window.api.setSettings('appSettings', { ...current, chatModel: next })
    } catch {}
  }, [])

  const handleClearChat = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true)
      clearTimerRef.current = setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    setConfirmClear(false)
    clearChat().then(loadConversations)
  }, [confirmClear, clearChat, loadConversations])

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  // --- Scroll: only auto-stick to bottom when the user is already there ---
  const onMessagesScroll = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = near
    setShowJump(!near)
  }, [])

  // Force a jump to the bottom whenever the conversation changes.
  useEffect(() => {
    forceJumpRef.current = true
  }, [conversationId])

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    if (forceJumpRef.current) {
      el.scrollTop = el.scrollHeight
      forceJumpRef.current = false
      atBottomRef.current = true
      setShowJump(false)
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, streamingContent])

  const jumpToLatest = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowJump(false)
  }, [])

  // After a search-result click, scroll to and briefly highlight that message.
  // Declared after the bottom-stick effect so it wins on conversation switch.
  useEffect(() => {
    if (pendingJumpId == null) return
    const el = document.getElementById(`msg-${pendingJumpId}`)
    if (!el) return
    forceJumpRef.current = false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlightMsgId(pendingJumpId)
    setPendingJumpId(null)
    const t = setTimeout(() => setHighlightMsgId(null), 2200)
    return () => clearTimeout(t)
  }, [messages, pendingJumpId])

  const openSearchResult = useCallback(
    (r: ChatSearchResult) => {
      setSearch('')
      setMsgResults([])
      if (r.conversation_id !== conversationId) {
        setConversationId(r.conversation_id)
        setEditingMsgId(null)
      }
      setPendingJumpId(r.id)
    },
    [conversationId],
  )

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 150) + 'px'
    }
  }, [input])

  const handleSend = useCallback(() => {
    if ((!input.trim() && pendingFiles.length === 0) || isStreaming) return
    forceJumpRef.current = true
    sendMessage(input.trim(), pendingFiles.length ? pendingFiles : undefined)
    setInput('')
    setPendingFiles([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [input, pendingFiles, isStreaming, sendMessage])

  // Read selected files into base64 attachment inputs (images + PDFs).
  const onFilesPicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file
    files.forEach((file) => {
      const isImage = file.type.startsWith('image/')
      const isPdf = file.type === 'application/pdf'
      if (!isImage && !isPdf) return
      const reader = new FileReader()
      reader.onload = () => {
        const data = String(reader.result || '').replace(/^data:[^;]+;base64,/, '')
        if (!data) return
        setPendingFiles((prev) => [
          ...prev,
          {
            kind: isImage ? 'image' : 'document',
            media_type: file.type,
            name: file.name,
            data_base64: data,
          },
        ])
      }
      reader.readAsDataURL(file)
    })
  }, [])

  const removePendingFile = useCallback((idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const handleNewChat = useCallback(() => {
    const id = `chat-${Date.now()}`
    setConversationId(id)
    setConfirmClear(false)
    setSearch('')
  }, [])

  const handleSelectConversation = (id: string) => {
    setConversationId(id)
    setConfirmClear(false)
    setEditingMsgId(null)
  }

  // --- Conversation management ---
  const startRename = (conv: Conversation) => {
    setRenamingId(conv.conversation_id)
    setRenameDraft(conv.title || '')
  }
  const commitRename = async () => {
    if (renamingId && renameDraft.trim()) {
      try {
        await window.api.renameConversation(renamingId, renameDraft.trim())
      } catch {}
    }
    setRenamingId(null)
    setRenameDraft('')
    loadConversations()
  }
  const togglePin = async (conv: Conversation) => {
    try {
      await window.api.pinConversation(conv.conversation_id, conv.pinned ? false : true)
    } catch {}
    loadConversations()
  }
  const handleDeleteConversation = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 3000)
      return
    }
    setConfirmDeleteId(null)
    try {
      await window.api.deleteConversation(id)
    } catch {}
    if (id === conversationId) handleNewChat()
    loadConversations()
    loadArchived()
  }
  const handleArchive = async (id: string, makeArchived: boolean) => {
    try {
      await window.api.archiveConversation(id, makeArchived)
    } catch {}
    if (makeArchived && id === conversationId) handleNewChat()
    loadConversations()
    loadArchived()
  }
  const handleExport = async (id: string) => {
    try {
      await window.api.exportConversation(id)
    } catch {}
  }

  // --- Keyboard shortcuts (Ctrl/Cmd+N new chat, Esc stop) ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        handleNewChat()
      } else if (e.key === 'Escape' && isStreaming) {
        cancelStream()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNewChat, isStreaming, cancelStream])

  // --- Slash autocomplete ---
  const slashMatches = useMemo(() => {
    const m = input.match(/^\/(\S*)$/)
    if (!m) return []
    const q = m[1].toLowerCase()
    return COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q)).slice(0, 8)
  }, [input])

  useEffect(() => {
    setSlashIndex(0)
  }, [input])

  const applySlash = (name: string) => {
    setInput(name + ' ')
    textareaRef.current?.focus()
  }

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        applySlash(slashMatches[slashIndex].name)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // --- Message edit ---
  const startEdit = (id: number, content: string) => {
    setEditingMsgId(id)
    setEditDraft(content)
  }
  const commitEdit = async () => {
    if (editingMsgId != null && editDraft.trim()) {
      forceJumpRef.current = true
      await editAndResend(editingMsgId, editDraft.trim())
    }
    setEditingMsgId(null)
    setEditDraft('')
  }

  const hasMessages = messages.length > 0 || streamingContent
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].id
    return null
  }, [messages])
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i].role === 'assistant') return messages[i].id
    return null
  }, [messages])

  const grouped = useMemo(() => groupConversations(conversations, search), [conversations, search])

  return (
    <div className="flex h-full gap-4">
      {/* Conversation sidebar */}
      <div
        className="w-60 shrink-0 flex flex-col rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        <button
          onClick={handleNewChat}
          className="flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors hover:bg-white/[0.03]"
          style={{ color: 'var(--accent-blue)', borderBottom: '1px solid var(--separator)' }}
          title="New chat (Ctrl+N)"
        >
          <Plus size={14} />
          New Chat
        </button>

        {/* Search */}
        <div
          className="flex items-center gap-2 px-2.5 py-2"
          style={{ borderBottom: '1px solid var(--separator)' }}
        >
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats"
            className="flex-1 text-xs outline-none bg-transparent"
            style={{ color: 'var(--text-primary)' }}
          />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear search">
              <X size={12} style={{ color: 'var(--text-muted)' }} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {conversations.length === 0 ? (
            <p className="text-xs px-3 py-4 text-center" style={{ color: 'var(--text-muted)' }}>
              No conversations yet
            </p>
          ) : grouped.every((g) => g.items.length === 0) ? (
            <p className="text-xs px-3 py-4 text-center" style={{ color: 'var(--text-muted)' }}>
              No matches
            </p>
          ) : (
            grouped.map((group) =>
              group.items.length === 0 ? null : (
                <div key={group.label} className="mb-1">
                  <div
                    className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {group.label}
                  </div>
                  {group.items.map((conv) => {
                    const isActive = conv.conversation_id === conversationId
                    const title = conv.title || 'Untitled'
                    const isRenaming = renamingId === conv.conversation_id
                    return (
                      <div
                        key={conv.conversation_id}
                        className="group relative w-full px-2 py-1.5 transition-colors hover:bg-white/[0.03] flex flex-col gap-0.5 cursor-pointer"
                        style={{
                          background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                          borderLeft: isActive
                            ? '2px solid var(--accent-blue)'
                            : '2px solid transparent',
                        }}
                        onClick={() => !isRenaming && handleSelectConversation(conv.conversation_id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && !isRenaming) {
                            e.preventDefault()
                            handleSelectConversation(conv.conversation_id)
                          }
                        }}
                      >
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename()
                              else if (e.key === 'Escape') {
                                setRenamingId(null)
                                setRenameDraft('')
                              }
                            }}
                            onBlur={commitRename}
                            className="text-xs px-1 py-0.5 rounded outline-none"
                            style={{
                              background: 'var(--bg-card)',
                              color: 'var(--text-primary)',
                              border: '1px solid var(--accent-blue)',
                            }}
                          />
                        ) : (
                          <div className="flex items-center gap-1 pr-1">
                            {conv.pinned ? (
                              <Pin
                                size={10}
                                className="shrink-0"
                                style={{ color: 'var(--accent-blue)' }}
                                fill="currentColor"
                              />
                            ) : null}
                            <span
                              className="text-xs font-medium truncate block flex-1"
                              style={{
                                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                              }}
                            >
                              {title}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {conv.message_count} msg
                            {conv.last_message_at && (
                              <>
                                {' · '}
                                {formatDistanceToNow(parseISO(conv.last_message_at), {
                                  addSuffix: true,
                                })}
                              </>
                            )}
                          </span>
                          {!isRenaming && (
                            <div className="hidden group-hover:flex items-center gap-1">
                              <IconBtn
                                title={conv.pinned ? 'Unpin' : 'Pin'}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  togglePin(conv)
                                }}
                              >
                                {conv.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                              </IconBtn>
                              <IconBtn
                                title="Rename"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  startRename(conv)
                                }}
                              >
                                <Pencil size={12} />
                              </IconBtn>
                              <IconBtn
                                title="Export to Markdown"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleExport(conv.conversation_id)
                                }}
                              >
                                <Download size={12} />
                              </IconBtn>
                              <IconBtn
                                title="Archive"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleArchive(conv.conversation_id, true)
                                }}
                              >
                                <Archive size={12} />
                              </IconBtn>
                              <IconBtn
                                title={
                                  confirmDeleteId === conv.conversation_id ? 'Confirm delete' : 'Delete'
                                }
                                danger={confirmDeleteId === conv.conversation_id}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteConversation(conv.conversation_id)
                                }}
                              >
                                <Trash2 size={12} />
                              </IconBtn>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ),
            )
          )}

          {/* Full-text message search results */}
          {search.trim() && msgResults.length > 0 && (
            <div className="mb-1 mt-2">
              <div
                className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Messages
              </div>
              {msgResults.map((r) => (
                <button
                  key={r.id}
                  onClick={() => openSearchResult(r)}
                  className="w-full text-left px-3 py-1.5 transition-colors hover:bg-white/[0.03] flex flex-col gap-0.5"
                >
                  <span
                    className="text-[11px] font-medium truncate"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {r.role === 'user' ? 'You' : 'Mien'} · {r.title}
                  </span>
                  <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {r.snippet}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Archived conversations */}
          {archived.length > 0 && (
            <div className="mt-2 border-t" style={{ borderColor: 'var(--separator)' }}>
              <button
                onClick={() => setShowArchived((v) => !v)}
                className="w-full flex items-center gap-1 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                {showArchived ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                Archived ({archived.length})
              </button>
              {showArchived &&
                archived.map((conv) => (
                  <div
                    key={conv.conversation_id}
                    className="group w-full px-3 py-1.5 transition-colors hover:bg-white/[0.03] flex items-center justify-between gap-1 cursor-pointer"
                    onClick={() => handleSelectConversation(conv.conversation_id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleSelectConversation(conv.conversation_id)
                      }
                    }}
                  >
                    <span
                      className="text-xs truncate flex-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {conv.title || 'Untitled'}
                    </span>
                    <div className="hidden group-hover:flex items-center gap-1">
                      <IconBtn
                        title="Unarchive"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleArchive(conv.conversation_id, false)
                        }}
                      >
                        <ArchiveRestore size={12} />
                      </IconBtn>
                      <IconBtn
                        title={
                          confirmDeleteId === conv.conversation_id ? 'Confirm delete' : 'Delete'
                        }
                        danger={confirmDeleteId === conv.conversation_id}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteConversation(conv.conversation_id)
                        }}
                      >
                        <Trash2 size={12} />
                      </IconBtn>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        <div className="flex items-center justify-between mb-3 shrink-0 gap-2">
          <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            Chat with Mien
          </h2>
          <div className="flex items-center gap-2">
            {/* Model picker */}
            <select
              value={model}
              onChange={(e) => persistModel(e.target.value as ChatModel)}
              className="text-xs px-2 py-1.5 rounded-lg outline-none cursor-pointer"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--separator)',
              }}
              title="Model for this chat"
            >
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
            </select>
            <button
              onClick={() => setShowMemory(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors hover:opacity-80"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              title="What Mien remembers about you"
            >
              <Brain size={13} />
              Memory
            </button>
            {hasMessages && !isStreaming && (
              <button
                onClick={handleClearChat}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors hover:opacity-80"
                style={{
                  background: confirmClear ? 'var(--accent-red)' : 'var(--bg-tertiary)',
                  color: confirmClear ? 'white' : 'var(--text-muted)',
                }}
              >
                <Trash2 size={12} />
                {confirmClear ? 'Confirm?' : 'Clear'}
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div
          ref={messagesRef}
          onScroll={onMessagesScroll}
          className="flex-1 overflow-y-auto rounded-xl mb-3"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', padding: 16 }}
        >
          {!hasMessages ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <Bot
                  size={36}
                  className="mx-auto mb-3"
                  style={{ color: 'var(--text-muted)', opacity: 0.5 }}
                />
                <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
                  Ask me about your portfolio, health trends, or anything else.
                </p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {[
                    'How is my portfolio doing?',
                    'Analyze my sleep patterns',
                    'What should I focus on today?',
                    'Any market news I should know about?',
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setInput(suggestion)}
                      className="text-xs px-3 py-1.5 rounded-full transition-colors hover:bg-white/[0.05]"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className="rounded-2xl transition-shadow"
                  style={
                    highlightMsgId === msg.id
                      ? { boxShadow: '0 0 0 2px var(--accent-blue)' }
                      : undefined
                  }
                >
                  <MessageBubble
                    role={msg.role}
                    content={msg.content}
                    attachments={attachmentsByMsg[msg.id]}
                    canCopy
                    canRegenerate={!isStreaming && msg.id === lastAssistantId}
                    canEdit={!isStreaming && msg.id === lastUserId}
                    isEditing={editingMsgId === msg.id}
                    editDraft={editDraft}
                    onEditDraftChange={setEditDraft}
                    onStartEdit={() => startEdit(msg.id, msg.content)}
                    onCancelEdit={() => setEditingMsgId(null)}
                    onCommitEdit={commitEdit}
                    onRegenerate={regenerate}
                  />
                </div>
              ))}
              {isStreaming && toolStatus && (
                <ChatActivityStatus label={toolStatus} />
              )}
              {streamingContent && (
                <MessageBubble role="assistant" content={streamingContent} isStreaming />
              )}
            </div>
          )}
        </div>

        {/* Jump to latest */}
        {showJump && (
          <button
            onClick={jumpToLatest}
            className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 text-xs px-3 py-1.5 rounded-full shadow-lg transition-opacity"
            style={{
              bottom: 90,
              background: 'var(--accent-blue)',
              color: 'white',
            }}
            aria-label="Jump to latest"
          >
            <ArrowDown size={13} />
            Latest
          </button>
        )}

        {/* Error */}
        {error && (
          <div
            className="flex items-center gap-2 text-sm mb-2 px-1 shrink-0"
            style={{ color: 'var(--accent-red)' }}
          >
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {/* Input */}
        <div className="relative shrink-0">
          {/* Slash autocomplete */}
          {slashMatches.length > 0 && (
            <div
              className="absolute bottom-full mb-2 left-0 right-0 rounded-xl overflow-hidden z-10 shadow-xl"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              {slashMatches.map((c, i) => (
                <button
                  key={c.name}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applySlash(c.name)
                  }}
                  className="w-full text-left px-3 py-2 flex items-baseline gap-2 transition-colors"
                  style={{
                    background: i === slashIndex ? 'var(--bg-tertiary)' : 'transparent',
                  }}
                >
                  <span className="text-xs font-mono font-semibold" style={{ color: 'var(--accent-blue)' }}>
                    {c.name}
                    {c.args ? ' ' + c.args : ''}
                  </span>
                  <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {c.description}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Pending attachment chips */}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {pendingFiles.map((f, i) => (
                <div
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-2 rounded-lg p-1 pr-2"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--separator)' }}
                >
                  {f.kind === 'image' ? (
                    <img
                      src={`data:${f.media_type};base64,${f.data_base64}`}
                      alt={f.name || 'attachment'}
                      className="w-9 h-9 rounded object-cover"
                    />
                  ) : (
                    <div
                      className="w-9 h-9 rounded flex items-center justify-center"
                      style={{ background: 'var(--bg-tertiary)' }}
                    >
                      <FileText size={16} style={{ color: 'var(--text-muted)' }} />
                    </div>
                  )}
                  <span
                    className="text-[11px] max-w-[120px] truncate"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {f.name || 'attachment'}
                  </span>
                  <button onClick={() => removePendingFile(i)} aria-label="Remove attachment">
                    <X size={12} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={onFilesPicked}
          />

          <div
            className="flex items-end gap-2 rounded-xl p-2"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--separator)' }}
          >
            <button
              className="px-2 py-2 rounded-lg transition-colors disabled:opacity-40 shrink-0 hover:bg-white/[0.05]"
              style={{ color: 'var(--text-muted)' }}
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              title="Attach image or PDF"
              aria-label="Attach file"
            >
              <Paperclip size={16} />
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                isStreaming
                  ? 'Waiting for response...'
                  : 'Ask Mien anything — or type /help for commands'
              }
              disabled={isStreaming}
              rows={1}
              className="flex-1 px-3 py-2 text-sm outline-none resize-none disabled:opacity-50"
              style={{ background: 'transparent', color: 'var(--text-primary)', maxHeight: 150 }}
              onKeyDown={onComposerKeyDown}
            />
            {isStreaming ? (
              <button
                className="px-3 py-2 rounded-lg transition-colors shrink-0"
                style={{ background: 'var(--accent-red)', color: 'white' }}
                onClick={cancelStream}
                title="Stop generating (Esc)"
                aria-label="Stop generating"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                className="px-3 py-2 rounded-lg transition-colors disabled:opacity-40 shrink-0"
                style={{ background: 'var(--accent-blue)', color: 'white' }}
                onClick={handleSend}
                disabled={!input.trim() && pendingFiles.length === 0}
                aria-label="Send message"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {showMemory && <MemoryPanel onClose={() => setShowMemory(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small icon button used in the conversation row hover actions
// ---------------------------------------------------------------------------
function IconBtn({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode
  onClick: (e: React.MouseEvent) => void
  title: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1 rounded transition-colors hover:bg-white/[0.08]"
      style={{ color: danger ? 'var(--accent-red)' : 'var(--text-muted)' }}
    >
      {children}
    </button>
  )
}

function ChatActivityStatus({ label }: { label: string }) {
  return (
    <div className="group flex gap-3">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
        aria-hidden="true"
      >
        <Loader2 size={14} className="animate-spin" />
      </div>
      <div
        className="max-w-[80%] rounded-2xl rounded-tl-sm px-3 py-2 text-xs"
        style={{
          background: 'var(--bg-tertiary)',
          color: 'var(--text-muted)',
          border: '1px solid var(--border)',
        }}
        role="status"
        aria-live="polite"
      >
        Mien is {label}...
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Message bubble with hover actions (copy / regenerate / edit)
// ---------------------------------------------------------------------------
function MessageBubble({
  role,
  content,
  attachments,
  isStreaming = false,
  canCopy = false,
  canRegenerate = false,
  canEdit = false,
  isEditing = false,
  editDraft = '',
  onEditDraftChange,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onRegenerate,
}: {
  role: string
  content: string
  attachments?: ChatAttachment[]
  isStreaming?: boolean
  canCopy?: boolean
  canRegenerate?: boolean
  canEdit?: boolean
  isEditing?: boolean
  editDraft?: string
  onEditDraftChange?: (v: string) => void
  onStartEdit?: () => void
  onCancelEdit?: () => void
  onCommitEdit?: () => void
  onRegenerate?: () => void
}) {
  const isUser = role === 'user'
  const rendered = useMemo(() => (isUser ? null : renderMarkdown(content)), [content, isUser])
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard?.writeText(content).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }

  return (
    <div className={`group flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: isUser ? 'var(--accent-blue)' : 'var(--bg-tertiary)', color: 'white' }}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className={`max-w-[80%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
            isUser ? 'rounded-tr-sm' : 'rounded-tl-sm'
          }`}
          style={{
            background: isUser ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
            color: isUser ? 'white' : 'var(--text-primary)',
          }}
        >
          {attachments && attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachments.map((a) =>
                a.kind === 'image' ? (
                  <img
                    key={a.id}
                    src={`data:${a.media_type};base64,${a.data_base64}`}
                    alt={a.name || 'attachment'}
                    className="max-w-[200px] max-h-[200px] rounded-lg object-cover"
                  />
                ) : (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                    style={{ background: 'rgba(0,0,0,0.2)' }}
                  >
                    <FileText size={14} />
                    <span className="text-xs truncate max-w-[160px]">
                      {a.name || 'document.pdf'}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
          {isEditing ? (
            <div className="flex flex-col gap-2" style={{ minWidth: 240 }}>
              <textarea
                autoFocus
                value={editDraft}
                onChange={(e) => onEditDraftChange?.(e.target.value)}
                rows={3}
                className="text-sm outline-none resize-y rounded p-2"
                style={{ background: 'rgba(0,0,0,0.2)', color: 'white' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    onCommitEdit?.()
                  } else if (e.key === 'Escape') {
                    onCancelEdit?.()
                  }
                }}
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={onCancelEdit}
                  className="text-xs px-2 py-1 rounded"
                  style={{ background: 'rgba(255,255,255,0.15)', color: 'white' }}
                >
                  Cancel
                </button>
                <button
                  onClick={onCommitEdit}
                  className="text-xs px-2 py-1 rounded font-medium"
                  style={{ background: 'white', color: 'var(--accent-blue)' }}
                >
                  Send
                </button>
              </div>
            </div>
          ) : isUser ? (
            <div className="whitespace-pre-wrap break-words">{content}</div>
          ) : (
            <div
              className="markdown-content break-words"
              dangerouslySetInnerHTML={{ __html: rendered || '' }}
            />
          )}
          {isStreaming && (
            <span
              className="inline-block w-1.5 h-4 ml-0.5 animate-pulse rounded-sm"
              style={{ background: 'var(--accent-purple)' }}
            />
          )}
        </div>

        {/* Hover actions */}
        {!isEditing && !isStreaming && (canCopy || canRegenerate || canEdit) && (
          <div className="flex gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {canCopy && (
              <IconBtn title={copied ? 'Copied' : 'Copy'} onClick={copy}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </IconBtn>
            )}
            {canRegenerate && onRegenerate && (
              <IconBtn title="Regenerate" onClick={() => onRegenerate()}>
                <RefreshCw size={12} />
              </IconBtn>
            )}
            {canEdit && onStartEdit && (
              <IconBtn title="Edit & resend" onClick={() => onStartEdit()}>
                <Pencil size={12} />
              </IconBtn>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Memory panel — view / add / edit / delete durable facts + auto-memory toggle
// ---------------------------------------------------------------------------
function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [memories, setMemories] = useState<ChatMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [autoMemory, setAutoMemory] = useState(true)
  const [newContent, setNewContent] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const load = useCallback(async () => {
    try {
      const list = (await window.api.getMemories()) as ChatMemory[]
      setMemories(list || [])
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    window.api
      .getSettings('appSettings')
      .then((val) => {
        const s = (val as ChatAppSettings | null) || {}
        setAutoMemory(s.chatAutoMemory !== 'false')
      })
      .catch(() => {})
  }, [load])

  const toggleAuto = async () => {
    const next = !autoMemory
    setAutoMemory(next)
    try {
      const current = ((await window.api.getSettings('appSettings')) as ChatAppSettings | null) || {}
      await window.api.setSettings('appSettings', {
        ...current,
        chatAutoMemory: next ? 'true' : 'false',
      })
    } catch {}
  }

  const add = async () => {
    if (!newContent.trim()) return
    try {
      await window.api.addMemory(newContent.trim())
    } catch {}
    setNewContent('')
    load()
  }
  const saveEdit = async () => {
    if (editingId != null && editDraft.trim()) {
      try {
        await window.api.updateMemory(editingId, editDraft.trim())
      } catch {}
    }
    setEditingId(null)
    setEditDraft('')
    load()
  }
  const remove = async (id: number) => {
    try {
      await window.api.deleteMemory(id)
    } catch {}
    load()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="h-full w-[380px] flex flex-col"
        style={{ background: 'var(--bg-card)', borderLeft: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Chat memory"
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--separator)' }}
        >
          <div className="flex items-center gap-2">
            <Brain size={16} style={{ color: 'var(--accent-purple)' }} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Memory
            </h3>
          </div>
          <button onClick={onClose} aria-label="Close memory panel">
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Auto-memory toggle */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--separator)' }}
        >
          <div>
            <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Auto-remember
            </p>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Learn durable facts from chats automatically
            </p>
          </div>
          <button
            onClick={toggleAuto}
            className="relative w-10 h-5 rounded-full transition-colors shrink-0"
            style={{ background: autoMemory ? 'var(--accent-blue)' : 'var(--bg-tertiary)' }}
            aria-pressed={autoMemory}
            aria-label="Toggle auto-memory"
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
              style={{ left: autoMemory ? 22 : 2 }}
            />
          </button>
        </div>

        {/* Add */}
        <div className="px-4 py-3 flex gap-2" style={{ borderBottom: '1px solid var(--separator)' }}>
          <input
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="Add a fact to remember…"
            className="flex-1 text-xs px-2.5 py-2 rounded-lg outline-none"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--separator)',
            }}
          />
          <button
            onClick={add}
            disabled={!newContent.trim()}
            className="px-2.5 rounded-lg disabled:opacity-40"
            style={{ background: 'var(--accent-blue)', color: 'white' }}
            aria-label="Add memory"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading ? (
            <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
              Loading…
            </p>
          ) : memories.length === 0 ? (
            <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
              Nothing remembered yet. Mien will learn as you chat, or add facts above.
            </p>
          ) : (
            memories.map((m) => (
              <div
                key={m.id}
                className="group rounded-lg px-3 py-2"
                style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--separator)' }}
              >
                {editingId === m.id ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={2}
                      className="text-xs p-2 rounded outline-none resize-y"
                      style={{
                        background: 'var(--bg-card)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--accent-blue)',
                      }}
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditingId(null)}
                        className="text-[11px] px-2 py-1 rounded"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveEdit}
                        className="text-[11px] px-2 py-1 rounded font-medium flex items-center gap-1"
                        style={{ background: 'var(--accent-blue)', color: 'white' }}
                      >
                        <Check size={11} /> Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <p
                      className="text-xs flex-1 leading-relaxed"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {m.content}
                    </p>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <IconBtn
                        title="Edit"
                        onClick={() => {
                          setEditingId(m.id)
                          setEditDraft(m.content)
                        }}
                      >
                        <Pencil size={11} />
                      </IconBtn>
                      <IconBtn title="Delete" danger onClick={() => remove(m.id)}>
                        <Trash2 size={11} />
                      </IconBtn>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Group conversations into Pinned / Today / Yesterday / Previous 7 Days / Older
// ---------------------------------------------------------------------------
function groupConversations(
  conversations: Conversation[],
  search: string,
): Array<{ label: string; items: Conversation[] }> {
  const q = search.trim().toLowerCase()
  const filtered = q
    ? conversations.filter((c) => (c.title || '').toLowerCase().includes(q))
    : conversations

  const pinned: Conversation[] = []
  const today: Conversation[] = []
  const yesterday: Conversation[] = []
  const week: Conversation[] = []
  const older: Conversation[] = []

  for (const c of filtered) {
    if (c.pinned) {
      pinned.push(c)
      continue
    }
    let date: Date | null = null
    try {
      date = c.last_message_at ? parseISO(c.last_message_at) : null
    } catch {
      date = null
    }
    if (!date || isNaN(date.getTime())) {
      older.push(c)
    } else if (isToday(date)) {
      today.push(c)
    } else if (isYesterday(date)) {
      yesterday.push(c)
    } else if (differenceInCalendarDays(new Date(), date) <= 7) {
      week.push(c)
    } else {
      older.push(c)
    }
  }

  return [
    { label: 'Pinned', items: pinned },
    { label: 'Today', items: today },
    { label: 'Yesterday', items: yesterday },
    { label: 'Previous 7 Days', items: week },
    { label: 'Older', items: older },
  ]
}
