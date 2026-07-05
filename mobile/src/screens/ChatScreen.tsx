import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, Modal,
  NativeSyntheticEvent, NativeScrollEvent, Switch,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import Markdown from 'react-native-markdown-display'
import { colors, spacing, typography } from '../lib/theme'
import { COMMANDS, isSlashCommand, parseSlash, helpText, type SlashCommand } from '../lib/slash-commands'
import {
  chat,
  regenerateLastResponse,
  listConversations,
  renameConversation,
  setConversationPinned,
  deleteConversation,
  deleteMessagesFrom,
  listMemories,
  addMemory,
  updateMemory,
  deleteMemory,
  type ConversationRow,
  type MemoryRow,
} from '../services/ai.service'
import { getDb } from '../lib/database'
import { seamlessSyncFromRelay } from '../services/health-sync.service'
import { getSettings, saveSettings } from '../lib/storage'
import NoodleSpinner from '../components/anim/NoodleSpinner'

interface Message {
  id?: number
  role: 'user' | 'assistant'
  content: string
}

type ChatModel = 'sonnet' | 'opus'

const SYSTEM_PROMPT = `You are Mien, a personal AI assistant with access to the user's financial portfolio, health data, and schedule. You are knowledgeable about finance (stocks, crypto, ETFs), health optimization (sleep, HRV, fitness), and productivity. Be concise, direct, and actionable.`

const SUGGESTION_CHIPS = [
  "How's my portfolio doing?",
  "Analyze my sleep",
  "Plan my weekend",
  "What should I focus on today?",
]

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationRow[]>([])
  const [showConversationList, setShowConversationList] = useState(false)
  const [convSearch, setConvSearch] = useState('')
  const [model, setModel] = useState<ChatModel>('sonnet')

  // Rename modal
  const [renamingConv, setRenamingConv] = useState<ConversationRow | null>(null)
  const [renameText, setRenameText] = useState('')

  // Memory modal
  const [showMemory, setShowMemory] = useState(false)
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [memInput, setMemInput] = useState('')
  const [editingMemId, setEditingMemId] = useState<number | null>(null)
  const [editMemText, setEditMemText] = useState('')
  const [autoMemory, setAutoMemory] = useState(true)

  const flatListRef = useRef<FlatList>(null)
  const inputRef = useRef<TextInput>(null)
  const atBottomRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const [showJump, setShowJump] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const db = await getDb()
        const row = await db.getFirstAsync(
          `SELECT conversation_id FROM chat_messages
           ORDER BY created_at DESC LIMIT 1`
        ) as { conversation_id: string } | null
        setConversationId(row?.conversation_id ?? generateConversationId())
      } catch {
        setConversationId(generateConversationId())
      }
      try {
        const s = await getSettings()
        if (s.chatModel === 'opus' || s.chatModel === 'sonnet') setModel(s.chatModel)
      } catch {}
    })()
  }, [])

  useEffect(() => {
    if (conversationId) loadHistory(conversationId, true)
  }, [conversationId])

  const loadHistory = async (convId: string, forceJump = false) => {
    try {
      const db = await getDb()
      const rows = await db.getAllAsync(
        `SELECT id, role, content FROM chat_messages
         WHERE conversation_id = ? AND role != 'system'
         ORDER BY created_at ASC LIMIT 50`,
        convId
      ) as Message[]
      setMessages(rows)
      if (forceJump) {
        atBottomRef.current = true
        setShowJump(false)
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 60)
      }
    } catch {}
  }

  const loadConversations = async () => {
    try {
      setConversations(await listConversations())
    } catch {}
  }

  const modelId = useCallback(() => (model === 'opus' ? 'opus' : 'sonnet'), [model])

  const setModelPersist = async (m: ChatModel) => {
    setModel(m)
    try {
      const s = await getSettings()
      await saveSettings({ ...s, chatModel: m })
    } catch {}
  }

  const handleSend = async (overrideMsg?: string) => {
    const raw = (overrideMsg ?? input).trim()
    if (!raw || streaming || !conversationId) return

    // Slash commands expand into a templated prompt (or render help locally).
    if (isSlashCommand(raw)) {
      const { command, args } = parseSlash(raw)
      setInput('')
      if (!command) {
        setMessages(prev => [
          ...prev,
          { role: 'user', content: raw },
          { role: 'assistant', content: "Unknown command. Type `/help` to see what's available." },
        ])
        return
      }
      if (command.name === '/help') {
        setMessages(prev => [
          ...prev,
          { role: 'user', content: raw },
          { role: 'assistant', content: helpText() },
        ])
        return
      }
      let prompt: string
      try {
        prompt = command.buildPrompt(args)
      } catch (err: any) {
        setMessages(prev => [
          ...prev,
          { role: 'user', content: raw },
          { role: 'assistant', content: err?.message || 'Command failed' },
        ])
        return
      }
      return doSend(prompt)
    }

    setInput('')
    return doSend(raw)
  }

  // Pull fresh data from the relay before answering, so chat context (prices,
  // health, memory) isn't stale. Time-boxed so a slow/offline relay can't hang
  // the message — if it times out, the sync keeps running in the background and
  // we answer with whatever's already local.
  const refreshContextBeforeChat = async () => {
    setSyncing(true)
    try {
      await Promise.race([
        seamlessSyncFromRelay({ forceFull: true }).catch(() => null),
        new Promise(resolve => setTimeout(resolve, 7000)),
      ])
    } catch {
      // Never let a sync failure block the chat.
    } finally {
      setSyncing(false)
    }
  }

  // Stream a real message to Claude (used for normal input + expanded commands).
  const doSend = async (msg: string) => {
    if (!conversationId) return
    const controller = new AbortController()
    abortRef.current = controller
    atBottomRef.current = true
    setMessages(prev => [...prev, { role: 'user', content: msg }])
    setStreaming(true)
    setStreamText('')

    await refreshContextBeforeChat()

    try {
      await chat(msg, SYSTEM_PROMPT, conversationId, (chunk) => {
        setStreamText(prev => prev + chunk)
      }, modelId(), controller.signal)
    } catch (err: any) {
      if (!controller.signal.aborted) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Error: ${err.message || 'Failed to connect'}`
        }])
      }
    }
    abortRef.current = null
    setStreamText('')
    setStreaming(false)
    await loadHistory(conversationId)
    loadConversations()
  }

  const handleStop = () => {
    abortRef.current?.abort()
  }

  const handleRegenerate = async () => {
    if (streaming || !conversationId) return
    setMessages(prev => {
      const copy = [...prev]
      while (copy.length && copy[copy.length - 1].role === 'assistant') copy.pop()
      return copy
    })
    atBottomRef.current = true
    const controller = new AbortController()
    abortRef.current = controller
    setStreaming(true)
    setStreamText('')
    try {
      await regenerateLastResponse(SYSTEM_PROMPT, conversationId, (chunk) => {
        setStreamText(prev => prev + chunk)
      }, modelId(), controller.signal)
    } catch (err: any) {
      if (!controller.signal.aborted) Alert.alert('Error', err.message || 'Failed to regenerate')
    }
    abortRef.current = null
    setStreamText('')
    setStreaming(false)
    await loadHistory(conversationId)
  }

  const startEditUser = async (item: Message) => {
    if (item.id == null || !conversationId) return
    await deleteMessagesFrom(conversationId, item.id)
    await loadHistory(conversationId)
    setInput(item.content)
    inputRef.current?.focus()
  }

  const onMessageLongPress = (item: Message) => {
    const actions: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }> = [
      { text: 'Copy', onPress: () => Clipboard.setStringAsync(item.content) },
    ]
    if (!streaming && item.id != null && item.id === lastAssistantId) {
      actions.push({ text: 'Regenerate', onPress: handleRegenerate })
    }
    if (!streaming && item.id != null && item.id === lastUserId) {
      actions.push({ text: 'Edit & Resend', onPress: () => startEditUser(item) })
    }
    actions.push({ text: 'Cancel', style: 'cancel' })
    Alert.alert('Message', undefined, actions)
  }

  const handleChipPress = (chip: string) => handleSend(chip)

  const handleNewConversation = () => {
    const newId = generateConversationId()
    setConversationId(newId)
    setMessages([])
    setStreamText('')
    setShowConversationList(false)
  }

  const handleSelectConversation = (convId: string) => {
    setConversationId(convId)
    setShowConversationList(false)
  }

  const onConversationLongPress = (conv: ConversationRow) => {
    Alert.alert(conv.title || 'Conversation', undefined, [
      { text: 'Rename', onPress: () => { setRenamingConv(conv); setRenameText(conv.title || '') } },
      {
        text: conv.pinned ? 'Unpin' : 'Pin',
        onPress: async () => {
          await setConversationPinned(conv.conversation_id, !conv.pinned)
          loadConversations()
        },
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteConversation(conv.conversation_id)
          if (conv.conversation_id === conversationId) handleNewConversation()
          loadConversations()
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const commitRename = async () => {
    if (renamingConv && renameText.trim()) {
      await renameConversation(renamingConv.conversation_id, renameText.trim())
    }
    setRenamingConv(null)
    setRenameText('')
    loadConversations()
  }

  const handleClearChat = () => {
    Alert.alert('Clear Chat', 'Clear all messages in this conversation?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          if (!conversationId) return
          try {
            const db = await getDb()
            await db.runAsync('DELETE FROM chat_messages WHERE conversation_id = ?', conversationId)
          } catch {}
          setMessages([])
          setStreamText('')
        },
      },
    ])
  }

  const openConversationList = () => {
    setConvSearch('')
    loadConversations()
    setShowConversationList(true)
  }

  // --- Memory ---
  const openMemory = async () => {
    setShowMemory(true)
    try {
      setMemories(await listMemories())
      const s = await getSettings()
      setAutoMemory(s.chatAutoMemory !== 'false')
    } catch {}
  }
  const refreshMemories = async () => {
    try { setMemories(await listMemories()) } catch {}
  }
  const toggleAutoMemory = async (val: boolean) => {
    setAutoMemory(val)
    try {
      const s = await getSettings()
      await saveSettings({ ...s, chatAutoMemory: val ? 'true' : 'false' })
    } catch {}
  }
  const addMem = async () => {
    if (!memInput.trim()) return
    await addMemory(memInput.trim())
    setMemInput('')
    refreshMemories()
  }
  const saveMemEdit = async () => {
    if (editingMemId != null && editMemText.trim()) await updateMemory(editingMemId, editMemText.trim())
    setEditingMemId(null)
    setEditMemText('')
    refreshMemories()
  }
  const removeMem = (id: number) => {
    Alert.alert('Delete memory', 'Remove this remembered fact?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteMemory(id); refreshMemories() } },
    ])
  }

  // --- Scroll ---
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent
    const near = contentSize.height - contentOffset.y - layoutMeasurement.height < 80
    atBottomRef.current = near
    setShowJump(!near)
  }
  const onContentSize = () => {
    if (atBottomRef.current) setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 40)
  }
  const jumpToLatest = () => {
    flatListRef.current?.scrollToEnd({ animated: true })
    atBottomRef.current = true
    setShowJump(false)
  }

  const insets = useSafeAreaInsets()

  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].id
    return null
  }, [messages])
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i].id
    return null
  }, [messages])

  // Slash-command autocomplete: only while typing the command token itself.
  const slashMatches = useMemo<SlashCommand[]>(() => {
    const m = input.match(/^\/(\S*)$/)
    if (!m) return []
    const q = m[1].toLowerCase()
    return COMMANDS.filter(c => c.name.slice(1).toLowerCase().startsWith(q)).slice(0, 6)
  }, [input])

  const applySlash = (name: string) => {
    setInput(name + ' ')
    inputRef.current?.focus()
  }

  const listData: (Message & { key: string })[] = messages.map((msg, i) => ({
    ...msg,
    key: msg.id != null ? `msg-${msg.id}` : `tmp-${i}`,
  }))
  if (streaming && streamText) {
    listData.push({ role: 'assistant', content: streamText, key: 'streaming' })
  }

  const filteredConvs = useMemo(() => {
    const q = convSearch.trim().toLowerCase()
    return q ? conversations.filter(c => (c.title || '').toLowerCase().includes(q)) : conversations
  }, [conversations, convSearch])

  const renderItem = useCallback(({ item }: { item: Message & { key: string } }) => {
    // Render finalized assistant replies as markdown; user bubbles and the
    // still-streaming bubble stay plain text (faster, no half-parsed markdown).
    const useMarkdown = item.role === 'assistant' && item.key !== 'streaming'
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={() => item.key !== 'streaming' && onMessageLongPress(item)}
        style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.aiBubble]}
      >
        {useMarkdown ? (
          <Markdown style={markdownStyles}>{item.content}</Markdown>
        ) : (
          <Text style={[styles.bubbleText, item.role === 'user' ? styles.userText : styles.aiText]}>
            {item.content}
          </Text>
        )}
      </TouchableOpacity>
    )
  }, [lastUserId, lastAssistantId, streaming])

  const renderThinkingIndicator = () => {
    if (!streaming || streamText) return null
    return (
      <View style={[styles.bubble, styles.aiBubble, styles.thinkingBubble, syncing && styles.thinkingBubbleRow]}>
        <NoodleSpinner variant="slurp" size={28} color={colors.text.secondary} />
        {syncing && <Text style={styles.thinkingLabel}>Refreshing latest data...</Text>}
      </View>
    )
  }

  const renderEmpty = () => {
    if (streaming) return null
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Chat with Mien</Text>
        <Text style={styles.emptyText}>
          Ask about your portfolio, sleep, schedule, or anything.
        </Text>
        <View style={styles.chipsContainer}>
          {SUGGESTION_CHIPS.map((chip) => (
            <TouchableOpacity key={chip} style={styles.chip} onPress={() => handleChipPress(chip)} activeOpacity={0.7}>
              <Text style={styles.chipText}>{chip}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    )
  }

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr)
      const now = new Date()
      const diff = now.getTime() - d.getTime()
      if (diff < 86400000) return 'Today'
      if (diff < 172800000) return 'Yesterday'
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    } catch { return '' }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={60}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={openConversationList} activeOpacity={0.6}>
          <Text style={styles.headerBtn}>Chats</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />

        {/* Model toggle */}
        <TouchableOpacity
          onPress={() => setModelPersist(model === 'sonnet' ? 'opus' : 'sonnet')}
          activeOpacity={0.7}
          style={styles.modelPill}
        >
          <Text style={styles.modelPillText}>{model === 'opus' ? 'Opus' : 'Sonnet'}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={openMemory} activeOpacity={0.6} style={{ marginLeft: spacing.md }}>
          <Ionicons name="sparkles-outline" size={20} color={colors.accent.blue} />
        </TouchableOpacity>

        <TouchableOpacity onPress={handleNewConversation} activeOpacity={0.6} style={{ marginLeft: spacing.md }}>
          <Text style={styles.headerBtn}>+ New</Text>
        </TouchableOpacity>
        {messages.length > 0 && (
          <TouchableOpacity onPress={handleClearChat} activeOpacity={0.6} style={{ marginLeft: spacing.md }}>
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {messages.length === 0 && !streaming ? (
        <View style={styles.messagesList}>{renderEmpty()}</View>
      ) : (
        <View style={{ flex: 1 }}>
          <FlatList
            ref={flatListRef}
            style={styles.messagesList}
            contentContainerStyle={styles.messagesContent}
            data={listData}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            onScroll={onScroll}
            scrollEventThrottle={100}
            onContentSizeChange={onContentSize}
            ListFooterComponent={renderThinkingIndicator}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          />
          {showJump && (
            <TouchableOpacity style={styles.jumpBtn} onPress={jumpToLatest} activeOpacity={0.8}>
              <Ionicons name="arrow-down" size={16} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Slash command autocomplete */}
      {slashMatches.length > 0 && (
        <View style={styles.slashMenu}>
          {slashMatches.map((c) => (
            <TouchableOpacity
              key={c.name}
              style={styles.slashItem}
              onPress={() => applySlash(c.name)}
              activeOpacity={0.7}
            >
              <Text style={styles.slashName}>
                {c.name}
                {c.args ? ' ' + c.args : ''}
              </Text>
              <Text style={styles.slashDesc} numberOfLines={1}>{c.description}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask Mien anything — or / for commands"
          placeholderTextColor={colors.text.muted}
          multiline
          maxLength={2000}
          onSubmitEditing={() => handleSend()}
          returnKeyType="send"
        />
        {streaming ? (
          <TouchableOpacity
            style={styles.stopBtn}
            onPress={handleStop}
            activeOpacity={0.7}
          >
            <Ionicons name="stop" size={18} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
            onPress={() => handleSend()}
            disabled={!input.trim()}
            activeOpacity={0.7}
          >
            <Text style={styles.sendIcon}>{'↑'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Conversation List Modal */}
      <Modal
        visible={showConversationList}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowConversationList(false)}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Conversations</Text>
            <TouchableOpacity onPress={() => setShowConversationList(false)}>
              <Text style={styles.headerBtn}>Done</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.searchRow}>
            <Ionicons name="search" size={15} color={colors.text.muted} />
            <TextInput
              style={styles.searchInput}
              value={convSearch}
              onChangeText={setConvSearch}
              placeholder="Search chats"
              placeholderTextColor={colors.text.muted}
            />
          </View>

          <TouchableOpacity style={styles.newConvButton} onPress={handleNewConversation} activeOpacity={0.7}>
            <Text style={styles.newConvText}>+ New Conversation</Text>
          </TouchableOpacity>

          <FlatList
            data={filteredConvs}
            keyExtractor={(item) => item.conversation_id}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.convItem, item.conversation_id === conversationId && styles.convItemActive]}
                onPress={() => handleSelectConversation(item.conversation_id)}
                onLongPress={() => onConversationLongPress(item)}
                activeOpacity={0.7}
              >
                {!!item.pinned && (
                  <Ionicons name="pin" size={13} color={colors.accent.blue} style={{ marginRight: 6 }} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.convTitle} numberOfLines={1}>{item.title || 'Untitled'}</Text>
                  <Text style={styles.convMeta}>
                    {item.message_count} msg · {formatDate(item.last_message_at)}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => onConversationLongPress(item)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="ellipsis-horizontal" size={18} color={colors.text.muted} />
                </TouchableOpacity>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.emptyConvText}>No conversations yet</Text>}
          />
        </View>
      </Modal>

      {/* Rename Modal */}
      <Modal visible={!!renamingConv} transparent animationType="fade" onRequestClose={() => setRenamingConv(null)}>
        <View style={styles.centerOverlay}>
          <View style={styles.renameCard}>
            <Text style={styles.renameTitle}>Rename chat</Text>
            <TextInput
              style={styles.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              placeholder="Conversation name"
              placeholderTextColor={colors.text.muted}
            />
            <View style={styles.renameActions}>
              <TouchableOpacity onPress={() => setRenamingConv(null)}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={commitRename}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Memory Modal */}
      <Modal
        visible={showMemory}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowMemory(false)}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Memory</Text>
            <TouchableOpacity onPress={() => setShowMemory(false)}>
              <Text style={styles.headerBtn}>Done</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.autoRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.autoTitle}>Auto-remember</Text>
              <Text style={styles.autoSub}>Learn durable facts from chats automatically</Text>
            </View>
            <Switch value={autoMemory} onValueChange={toggleAutoMemory} />
          </View>

          <View style={styles.memAddRow}>
            <TextInput
              style={styles.memAddInput}
              value={memInput}
              onChangeText={setMemInput}
              placeholder="Add a fact to remember…"
              placeholderTextColor={colors.text.muted}
              onSubmitEditing={addMem}
            />
            <TouchableOpacity style={styles.memAddBtn} onPress={addMem} activeOpacity={0.7}>
              <Ionicons name="add" size={20} color="#fff" />
            </TouchableOpacity>
          </View>

          <FlatList
            data={memories}
            keyExtractor={(m) => `mem-${m.id}`}
            contentContainerStyle={{ padding: spacing.md }}
            renderItem={({ item }) => (
              <View style={styles.memItem}>
                {editingMemId === item.id ? (
                  <View>
                    <TextInput
                      style={styles.memEditInput}
                      value={editMemText}
                      onChangeText={setEditMemText}
                      multiline
                      autoFocus
                    />
                    <View style={styles.renameActions}>
                      <TouchableOpacity onPress={() => setEditingMemId(null)}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
                      <TouchableOpacity onPress={saveMemEdit}><Text style={styles.saveText}>Save</Text></TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                    <Text style={styles.memText}>{item.content}</Text>
                    <TouchableOpacity
                      onPress={() => { setEditingMemId(item.id); setEditMemText(item.content) }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{ marginLeft: 8 }}
                    >
                      <Ionicons name="pencil" size={15} color={colors.text.muted} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => removeMem(item.id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{ marginLeft: 10 }}
                    >
                      <Ionicons name="trash-outline" size={15} color={colors.accent.red} />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyConvText}>
                Nothing remembered yet. Mien learns as you chat, or add facts above.
              </Text>
            }
          />
        </View>
      </Modal>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  headerBtn: { ...typography.callout, color: colors.accent.blue },
  clearText: { ...typography.callout, color: colors.accent.red },
  modelPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
    backgroundColor: colors.bg.tertiary, borderWidth: 0.5, borderColor: colors.border,
  },
  modelPillText: { ...typography.caption, color: colors.text.secondary, fontWeight: '600' },
  messagesList: { flex: 1 },
  messagesContent: { padding: spacing.md, paddingBottom: spacing.xl },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: spacing.md },
  emptyTitle: { ...typography.title, color: colors.text.primary, marginBottom: spacing.sm },
  emptyText: { ...typography.body, color: colors.text.muted, textAlign: 'center' },
  chipsContainer: {
    flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center',
    marginTop: spacing.lg, gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.bg.tertiary, borderRadius: 20,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderWidth: 0.5, borderColor: colors.border,
  },
  chipText: { ...typography.callout, color: colors.accent.blue },
  bubble: { maxWidth: '85%', padding: spacing.md, marginBottom: spacing.sm },
  userBubble: {
    alignSelf: 'flex-end', backgroundColor: colors.accent.blue,
    borderRadius: 18, borderBottomRightRadius: 6,
  },
  aiBubble: {
    alignSelf: 'flex-start', backgroundColor: colors.bg.card,
    borderRadius: 18, borderBottomLeftRadius: 6,
  },
  bubbleText: { ...typography.body },
  userText: { color: '#ffffff' },
  aiText: { color: colors.text.primary },
  thinkingBubble: { paddingVertical: 8, paddingHorizontal: 14 },
  thinkingBubbleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '86%' },
  thinkingLabel: { color: colors.text.secondary, fontSize: 13, flexShrink: 1 },
  jumpBtn: {
    position: 'absolute', alignSelf: 'center', bottom: 12,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.accent.blue, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    padding: spacing.md, paddingBottom: spacing.sm,
    borderTopWidth: 0.5, borderTopColor: colors.border,
    backgroundColor: colors.bg.secondary, gap: spacing.sm,
  },
  input: {
    flex: 1, backgroundColor: colors.bg.tertiary, borderRadius: 24,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    ...typography.body, color: colors.text.primary, maxHeight: 100,
  },
  sendBtn: {
    backgroundColor: colors.accent.blue, width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.35 },
  sendIcon: { color: '#ffffff', fontWeight: '700', fontSize: 20, marginTop: -1 },
  stopBtn: {
    backgroundColor: colors.accent.red, width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  slashMenu: {
    marginHorizontal: spacing.md, marginBottom: spacing.xs,
    backgroundColor: colors.bg.card, borderRadius: 12,
    borderWidth: 0.5, borderColor: colors.border, overflow: 'hidden',
  },
  slashItem: {
    flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  slashName: { ...typography.callout, color: colors.accent.blue, fontWeight: '600' },
  slashDesc: { ...typography.caption, color: colors.text.muted, flex: 1 },
  modalContainer: { flex: 1, backgroundColor: colors.bg.primary },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  modalTitle: { ...typography.title, color: colors.text.primary },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: spacing.md, marginTop: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: 8,
    backgroundColor: colors.bg.tertiary, borderRadius: 12,
  },
  searchInput: { flex: 1, ...typography.body, color: colors.text.primary, padding: 0 },
  newConvButton: { padding: spacing.md, borderBottomWidth: 0.5, borderBottomColor: colors.border },
  newConvText: { ...typography.callout, color: colors.accent.blue },
  convItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  convItemActive: { backgroundColor: colors.bg.secondary },
  convTitle: { ...typography.body, color: colors.text.primary, fontWeight: '500' },
  convMeta: { ...typography.caption, color: colors.text.muted, marginTop: 2 },
  emptyConvText: { ...typography.body, color: colors.text.muted, textAlign: 'center', paddingTop: spacing.xl, paddingHorizontal: spacing.lg },
  centerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  renameCard: { width: '100%', backgroundColor: colors.bg.card, borderRadius: 16, padding: spacing.lg },
  renameTitle: { ...typography.headline, color: colors.text.primary, marginBottom: spacing.md },
  renameInput: {
    backgroundColor: colors.bg.tertiary, borderRadius: 10,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    ...typography.body, color: colors.text.primary,
  },
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.lg, marginTop: spacing.md },
  cancelText: { ...typography.callout, color: colors.text.muted },
  saveText: { ...typography.callout, color: colors.accent.blue, fontWeight: '600' },
  autoRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  autoTitle: { ...typography.body, color: colors.text.primary, fontWeight: '500' },
  autoSub: { ...typography.caption, color: colors.text.muted, marginTop: 2 },
  memAddRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  memAddInput: {
    flex: 1, backgroundColor: colors.bg.tertiary, borderRadius: 12,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    ...typography.body, color: colors.text.primary,
  },
  memAddBtn: {
    backgroundColor: colors.accent.blue, width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },
  memItem: {
    backgroundColor: colors.bg.card, borderRadius: 12, padding: spacing.md,
    marginBottom: spacing.sm, borderWidth: 0.5, borderColor: colors.border,
  },
  memText: { ...typography.body, color: colors.text.primary, flex: 1 },
  memEditInput: {
    backgroundColor: colors.bg.tertiary, borderRadius: 10, padding: spacing.md,
    ...typography.body, color: colors.text.primary, minHeight: 60,
  },
})

// Theme map for markdown-rendered assistant messages.
const markdownStyles = {
  body: { color: colors.text.primary, fontSize: 15, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  heading1: { color: colors.text.primary, fontSize: 20, fontWeight: '700' as const, marginTop: 4, marginBottom: 6 },
  heading2: { color: colors.text.primary, fontSize: 18, fontWeight: '700' as const, marginTop: 4, marginBottom: 6 },
  heading3: { color: colors.text.primary, fontSize: 16, fontWeight: '600' as const, marginTop: 4, marginBottom: 4 },
  strong: { fontWeight: '700' as const, color: colors.text.primary },
  em: { fontStyle: 'italic' as const },
  link: { color: colors.accent.blue },
  bullet_list: { marginBottom: 6 },
  ordered_list: { marginBottom: 6 },
  list_item: { marginBottom: 2 },
  code_inline: {
    backgroundColor: colors.bg.tertiary, color: colors.accent.cyan,
    borderRadius: 4, paddingHorizontal: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fence: {
    backgroundColor: colors.bg.tertiary, color: colors.text.primary,
    borderRadius: 8, padding: 10, borderWidth: 0,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13,
  },
  code_block: {
    backgroundColor: colors.bg.tertiary, color: colors.text.primary,
    borderRadius: 8, padding: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13,
  },
  blockquote: {
    backgroundColor: colors.bg.tertiary, borderLeftColor: colors.accent.blue,
    borderLeftWidth: 3, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4,
  },
  table: { borderColor: colors.border, borderWidth: 0.5, borderRadius: 6 },
  th: { padding: 6, color: colors.text.primary, fontWeight: '600' as const },
  td: { padding: 6, color: colors.text.secondary },
  hr: { backgroundColor: colors.border, height: 0.5 },
}
