export interface IpcChannels {
  // Settings
  'settings:get': (key: string) => unknown
  'settings:set': (key: string, value: unknown) => void

  // Finance
  'finance:getWatchlist': () => WatchlistItem[]
  'finance:addToWatchlist': (symbol: string, type: AssetType, name?: string) => void
  'finance:removeFromWatchlist': (symbol: string) => void
  'finance:getPrices': (symbol: string, days?: number) => PriceRecord[]
  'finance:getLatestPrices': () => LatestPrice[]
  'finance:getNews': () => NewsArticle[]
  'finance:refresh': () => void

  // Health
  'health:getMetrics': (type: string, days?: number) => HealthMetric[]
  'health:getLatestSleep': () => HealthMetric | null
  'health:getLatestHeartRate': () => HealthMetric | null

  // AI
  'ai:chat': (message: string, conversationId?: string, model?: string) => string
  'ai:generateBriefing': (type: BriefingType) => string
  'ai:getHistory': (conversationId?: string) => ChatMessage[]

  // Notion
  'notion:syncTasks': () => NotionTask[]
  'tasks:getToday': (date?: string) => TodayTaskItem[]
  'notion:pushBriefing': (briefingId: number) => void

  // Briefings
  'briefings:getLatest': (type?: BriefingType) => Briefing | null
  'briefings:getAll': (limit?: number) => Briefing[]

  // Schedule
  'schedule:getToday': () => DailySchedule | null
  'weather:getPlannerPreview': (dates?: string[], location?: string) => PlannerWeatherPreview
  'schedule:generate': () => DailySchedule
  'schedule:updateToday': (scheduleJson: string) => DailySchedule
}

export type AssetType = 'stock' | 'crypto' | 'etf'
export type BriefingType = 'morning_finance' | 'market_research' | 'health_weekly' | 'morning_sleep'
export type FinanceSkill =
  | 'earnings-review'
  | 'valuation'
  | 'market-research'
  | 'technical-analysis'
  | 'risk-assessment'
  | 'sector-comparison'

export interface WatchlistItem {
  id: number
  symbol: string
  type: AssetType
  name: string | null
  added_at: string
}

export interface PriceRecord {
  id: number
  symbol: string
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  source: string
}

export interface LatestPrice {
  symbol: string
  type: AssetType
  name: string | null
  price: number
  change: number
  changePercent: number
  volume: number | null
}

export interface NewsArticle {
  id: number
  title: string
  url: string
  source: string | null
  published_at: string | null
  related_symbols: string | null
  summary: string | null
  content_context: string | null
  saved_at: string | null
  sentiment: 'positive' | 'negative' | 'neutral' | null
  sentiment_confidence: number | null
  sentiment_source: 'heuristic' | 'ai' | null
}

export interface RiskMetric {
  volatility: number
  beta: number | null
  maxDrawdown: number
}

export interface HealthMetric {
  id: number
  metric_type: string
  date: string
  value_json: string
  source: string
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  conversation_id: string
  created_at: string
}

/** Image/PDF attachment the renderer sends with a user message. */
export interface ChatAttachmentInput {
  kind: 'image' | 'document'
  media_type: string
  name?: string
  /** base64 (data-URL prefix is stripped on save) */
  data_base64: string
}

/** A stored attachment row returned to the renderer for thumbnail rendering. */
export interface ChatAttachment {
  id: number
  message_id: number
  conversation_id: string
  kind: 'image' | 'document'
  media_type: string
  name: string | null
  data_base64: string
}

export interface ChatToolStatus {
  phase: 'start' | 'end'
  name: string
  label: string
}

/** A full-text message-search hit. */
export interface ChatSearchResult {
  id: number
  conversation_id: string
  title: string
  role: string
  snippet: string
  created_at: string
}

export interface ChatConversation {
  conversation_id: string
  title: string
  last_message_at: string
  message_count: number
  pinned: number
}

export interface ChatMemory {
  id: number
  content: string
  category: string
  pinned: number
  created_at: string
  updated_at: string
}

export interface Briefing {
  id: number
  type: BriefingType
  date: string
  content: string
  created_at: string
}

export interface NotionTask {
  id: string
  title: string
  status: string
  due_date: string | null
  priority: string | null
}

export interface TodayTaskItem extends NotionTask {
  source: 'notion' | 'weekend'
  time?: string | null
  detail?: string | null
  location?: string | null
}

export interface DailySchedule {
  id: number
  date: string
  schedule_json: string
  ai_rationale: string | null
  created_at: string
}

export interface PlannerWeatherDay {
  date: string
  label: string
  condition: string
  temperatureMinC: number | null
  temperatureMaxC: number | null
  precipitationProbabilityPct: number | null
  precipitationMm: number | null
  snowfallCm: number | null
  planningSummary: string
}

export interface PlannerWeatherPreview {
  location: string
  source: string
  days: PlannerWeatherDay[]
  unavailableReason?: string
}
