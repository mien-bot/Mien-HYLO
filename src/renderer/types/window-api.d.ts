import type {
  AssetType,
  Briefing,
  BriefingType,
  ChatMessage,
  ChatMemory,
  ChatAttachment,
  ChatAttachmentInput,
  ChatSearchResult,
  ChatToolStatus,
  DailySchedule,
  HealthMetric,
  LatestPrice,
  NewsArticle,
  NotionTask,
  PriceRecord,
  TodayTaskItem,
  WatchlistItem,
  PlannerWeatherPreview,
} from '../../shared/types/ipc.types'

type UnknownRecord = Record<string, unknown>
type Cleanup = () => void
type ToastEvent<T> = (callback: (data: T) => void) => Cleanup
type VoidEvent = (callback: () => void) => Cleanup

export interface WindowAPI {
  setZoomFactor: (factor: number) => void
  getZoomFactor: () => number
  capturePage: (rect?: { x: number; y: number; width: number; height: number }) => Promise<string>

  getSettings: (key: string) => Promise<unknown>
  setSettings: (key: string, value: unknown) => Promise<void>
  getSavedOverview: () => Promise<UnknownRecord>

  authIsSet: () => Promise<boolean>
  authSetPassword: (password: string) => Promise<boolean>
  authVerify: (password: string) => Promise<boolean>

  getWatchlist: () => Promise<WatchlistItem[]>
  addToWatchlist: (symbol: string, type: AssetType | string, name?: string) => Promise<void>
  removeFromWatchlist: (symbol: string) => Promise<void>
  getCachedPrices: () => Promise<LatestPrice[]>
  getLatestPrices: () => Promise<LatestPrice[]>
  getPrices: (symbol: string, days?: number) => Promise<PriceRecord[]>
  getNews: () => Promise<NewsArticle[]>
  getSummarizedNews: () => Promise<NewsArticle[]>
  refreshNews: () => Promise<UnknownRecord>
  getNewsStats: () => Promise<UnknownRecord>
  toggleNewsSaved: (id: number, saved: boolean) => Promise<void>
  refreshFinance: () => Promise<UnknownRecord>
  refreshYoutube: () => Promise<UnknownRecord>
  getTechnicals: (symbol: string) => Promise<UnknownRecord>
  getRiskMetrics: () => Promise<UnknownRecord>
  listHoldings: () => Promise<UnknownRecord[]>
  addHolding: (input: {
    symbol: string
    quantity: number
    cost_basis: number
    acquired_at?: string | null
    notes?: string | null
  }) => Promise<number>
  updateHolding: (id: number, patch: UnknownRecord) => Promise<void>
  removeHolding: (id: number) => Promise<void>
  importRobinhoodHoldings: () => Promise<UnknownRecord>
  getPortfolioSummary: () => Promise<UnknownRecord>
  getPortfolioValueHistory: (days?: number) => Promise<UnknownRecord[]>
  getFundamentals: (symbol?: string) => Promise<UnknownRecord | UnknownRecord[] | null>
  refreshFundamentals: (symbol?: string) => Promise<UnknownRecord | { count: number }>
  getEarningsCalendar: (days?: number) => Promise<UnknownRecord[]>
  refreshEarningsCalendar: () => Promise<{ count: number }>
  scoreNewsSentiment: (max?: number) => Promise<{ count: number }>
  getHealthScores: () => Promise<UnknownRecord[]>
  listAlerts: () => Promise<UnknownRecord[]>
  createAlert: (input: {
    symbol: string
    type: string
    threshold: number
    note?: string | null
    one_shot?: boolean
  }) => Promise<number>
  toggleAlert: (id: number, active: boolean) => Promise<void>
  removeAlert: (id: number) => Promise<void>
  checkAlertsNow: () => Promise<UnknownRecord[]>

  listHealthAlerts: () => Promise<UnknownRecord[]>
  createHealthAlert: (input: {
    type: string
    threshold: number
    note?: string | null
    one_shot?: boolean
  }) => Promise<number>
  toggleHealthAlert: (id: number, active: boolean) => Promise<void>
  removeHealthAlert: (id: number) => Promise<void>
  checkHealthAlertsNow: () => Promise<UnknownRecord[]>
  onAlertsFired: ToastEvent<
    Array<{ id: number; symbol: string; type: string; message: string; value: number }>
  >

  getHealthMetrics: (type: string, days?: number) => Promise<HealthMetric[]>
  getLatestSleep: () => Promise<HealthMetric | null>
  getLatestHeartRate: () => Promise<HealthMetric | null>
  importHealthFile: (filePath: string) => Promise<number>
  getHealthServerPort: () => Promise<number>
  recalculateSleepInBed: () => Promise<number>
  getHealthSummary: () => Promise<Record<string, number>>
  getSleepAnalysis: (days?: number) => Promise<UnknownRecord>
  getWakeRecommendation: (bedtime: string, latency?: number) => Promise<UnknownRecord>
  getBedtimeRecommendation: (wakeTime: string, latency?: number) => Promise<UnknownRecord>
  getSleepContext: () => Promise<string>
  getRecoveryReadiness: () => Promise<UnknownRecord>
  getSleepCorrelations: () => Promise<UnknownRecord>
  getSleepQualityHistory: (days?: number) => Promise<UnknownRecord[]>
  getSleepRegularity: () => Promise<UnknownRecord>
  getWindDownRoutine: () => Promise<UnknownRecord>
  getSleepNeedProfile: (days?: number) => Promise<UnknownRecord>

  predictWakeTime: (input?: {
    recentSleepDays?: number
    isWorkday?: boolean
    plannedBedtime?: string
    sleepLatencyMinutes?: number
  }) => Promise<UnknownRecord>
  saveWakePrediction: (prediction: unknown, dateStr?: string) => Promise<void>
  recordWakeOutcome: (params: {
    date: string
    actualWakeTime: string
    grogginessRating?: number
    energyRating?: number
    minutesToAlertAfterWake?: number
    snoozed?: boolean
  }) => Promise<void>
  validateWakePredictions: (days?: number) => Promise<UnknownRecord>

  stravaConnect: () => Promise<UnknownRecord>
  stravaDisconnect: () => Promise<UnknownRecord>
  stravaStatus: () => Promise<UnknownRecord>
  stravaSync: (days?: number) => Promise<UnknownRecord>
  stravaSyncAll: () => Promise<UnknownRecord>
  stravaSyncStreams: (days?: number, limit?: number) => Promise<UnknownRecord>

  getFitnessAnalysis: (days?: number) => Promise<UnknownRecord>
  getTrainingLoad: (days?: number) => Promise<UnknownRecord>
  getRecoveryAnalysis: (days?: number) => Promise<UnknownRecord>
  getFitnessProfile: (days?: number) => Promise<UnknownRecord>
  getHRZoneAnalysis: (days?: number) => Promise<UnknownRecord>
  getHRSS: (days?: number) => Promise<UnknownRecord>
  getYearProgression: (days?: number) => Promise<UnknownRecord>
  getBestEfforts: (days?: number) => Promise<UnknownRecord>
  getStreamZones: (days?: number) => Promise<UnknownRecord>
  getBestSplits: (days?: number) => Promise<UnknownRecord>
  getGradeAdjustedPace: (days?: number) => Promise<UnknownRecord>
  getRunningPower: (days?: number) => Promise<UnknownRecord>
  getWorkoutDetail: (key: string) => Promise<any>
  generateWorkoutReport: (key: string) => Promise<string>
  getFilteredFitness: (days?: number, patterns?: string[]) => Promise<UnknownRecord>

  onSleepDataArrived: ToastEvent<unknown>
  onWindDown: ToastEvent<unknown>

  chat: (
    message: string,
    conversationId?: string,
    model?: string,
    attachments?: ChatAttachmentInput[],
  ) => Promise<string>
  regenerateChat: (conversationId?: string, model?: string) => Promise<string>
  cancelChat: (conversationId?: string) => Promise<boolean>
  generateBriefing: (type: string) => Promise<string>
  runFinanceSkill: (skill: string, symbol?: string) => Promise<string>
  getChatHistory: (conversationId?: string) => Promise<ChatMessage[]>
  clearChatHistory: (conversationId?: string) => Promise<void>
  listConversations: () => Promise<
    Array<{
      conversation_id: string
      title: string
      last_message_at: string
      message_count: number
      pinned: number
    }>
  >
  renameConversation: (conversationId: string, title: string) => Promise<{ ok: boolean }>
  pinConversation: (conversationId: string, pinned: boolean) => Promise<{ ok: boolean }>
  deleteConversation: (conversationId: string) => Promise<{ ok: boolean }>
  trimMessagesFrom: (conversationId: string, messageId: number) => Promise<{ ok: boolean }>
  listArchivedConversations: () => Promise<
    Array<{
      conversation_id: string
      title: string
      last_message_at: string
      message_count: number
      pinned: number
    }>
  >
  archiveConversation: (conversationId: string, archived: boolean) => Promise<{ ok: boolean }>
  searchMessages: (query: string) => Promise<ChatSearchResult[]>
  getConversationAttachments: (conversationId?: string) => Promise<ChatAttachment[]>
  exportConversation: (
    conversationId: string,
  ) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>
  getMemories: () => Promise<ChatMemory[]>
  addMemory: (content: string, category?: string) => Promise<ChatMemory>
  updateMemory: (id: number, content: string, category?: string) => Promise<{ ok: boolean }>
  deleteMemory: (id: number) => Promise<{ ok: boolean }>
  clearMemories: () => Promise<{ ok: boolean }>
  checkAIConnection: () => Promise<boolean>
  addLinkSummary: (url: string, mode?: 'standard' | 'deep') => Promise<NewsArticle>
  summarizeVideo: (title: string, url: string) => Promise<string>
  deepSummarizeVideo: (title: string, url: string) => Promise<string>
  summarizeNewsArticle: (article: {
    id?: number
    title: string
    url: string
    source?: string | null
    related_symbols?: string | null
    summary?: string | null
    content_context?: string | null
  }) => Promise<string>
  deepSummarizeNewsArticle: (article: {
    id?: number
    title: string
    url: string
    source?: string | null
    related_symbols?: string | null
    summary?: string | null
    content_context?: string | null
  }) => Promise<string>
  getAiActivityLog: (limit?: number) => Promise<UnknownRecord[]>
  getAiActivityStats: (days?: number) => Promise<UnknownRecord>
  clearAiActivityLog: () => Promise<void>
  previewBriefing: (type: string) => Promise<UnknownRecord>
  saveChatMessage: (role: string, content: string, conversationId?: string) => Promise<void>
  pickFolder: () => Promise<string | null>
  exportMarkdown: (folderPath: string) => Promise<UnknownRecord>

  onChatStream: (callback: (chunk: string) => void) => Cleanup
  onChatStreamEnd: VoidEvent
  onChatTool: (callback: (status: ChatToolStatus) => void) => Cleanup
  onAnalysisStream: (callback: (chunk: string) => void) => Cleanup
  onAnalysisStreamEnd: (callback: (payload?: { error?: string }) => void) => Cleanup

  syncNotionTasks: () => Promise<NotionTask[]>
  getTodayTasks: (date?: string) => Promise<TodayTaskItem[]>
  pushBriefingToNotion: (briefingId: number) => Promise<string>
  pullBriefingsFromNotion: (daysBack?: number) => Promise<UnknownRecord>

  getLatestBriefing: (type?: BriefingType | string) => Promise<Briefing | null>
  getAllBriefings: (limit?: number) => Promise<Briefing[]>

  getTodaySchedule: () => Promise<DailySchedule | null>
  getPlannerWeatherPreview: (
    dates?: string[],
    location?: string,
  ) => Promise<PlannerWeatherPreview>
  getScheduleHistory: (limit?: number) => Promise<DailySchedule[]>
  generateSchedule: (prefs?: object) => Promise<DailySchedule>
  updateTodaySchedule: (scheduleJson: string) => Promise<DailySchedule>
  tweakDailySchedule: (date: string, instruction: string) => Promise<DailySchedule>
  pushScheduleToNotion: (scheduleJson: string, date: string, databaseId?: string) => Promise<string>

  getSchedulerStatus: () => Promise<UnknownRecord>
  getSchedulerActivity: (limit?: number) => Promise<UnknownRecord[]>

  relaySyncAll: () => Promise<UnknownRecord>
  relayPushSleepAnalysis: () => Promise<UnknownRecord>
  relayPullHistoricalSleep: (days?: number) => Promise<UnknownRecord>
  getTunnelUrl: () => Promise<{
    url: string | null
    source: string | null
    updatedAt: number | null
  }>
  onTunnelUrl: ToastEvent<{ url: string | null; source: string | null; updatedAt: number | null }>

  getWeekendEvents: () => Promise<UnknownRecord[]>
  searchWeekendEvents: (opts?: {
    keyword?: string
    date?: string
    category?: string
    page?: number
  }) => Promise<UnknownRecord[]>
  webSearchEvents: (query: string, date?: string) => Promise<UnknownRecord[]>
  listCachedWeekendEvents: (limit?: number) => Promise<UnknownRecord[]>
  getWeekendPlan: (weekendDate?: string) => Promise<UnknownRecord | null>
  generateWeekendPlan: (params?: string | object) => Promise<UnknownRecord>
  updateWeekendPlan: (weekendDate: string, planJson: string) => Promise<UnknownRecord>
  tweakWeekendPlan: (weekendDate: string, instruction: string, day?: string) => Promise<UnknownRecord>
  getWeekendAgendaMapImages: (routes: {
    saturday?: string[]
    sunday?: string[]
  }) => Promise<UnknownRecord>
  resolveRouteLocations: (route: string[]) => Promise<UnknownRecord[]>
  pushWeekendToNotion: (
    planJson: string,
    weekendDate: string,
    databaseId?: string,
  ) => Promise<string>
  listWeekendPlans: (limit?: number) => Promise<UnknownRecord[]>
  listNotionDatabases: () => Promise<UnknownRecord[]>
  getNotionDbProperties: (dbId: string) => Promise<UnknownRecord[]>

  autocompleteRestaurants: (input: string, mode?: 'food' | 'places') => Promise<UnknownRecord[]>
  searchRestaurants: (query?: string) => Promise<UnknownRecord[]>
  getPlaceById: (placeId: string) => Promise<UnknownRecord | null>
  searchNearbyPlaces: (options: {
    lat: number
    lng: number
    radiusMiles?: number
    types?: string[]
  }) => Promise<UnknownRecord[]>
  getSavedRestaurants: (filter?: UnknownRecord) => Promise<UnknownRecord[]>
  saveRestaurant: (restaurant: UnknownRecord, notes?: string) => Promise<UnknownRecord>
  addManualRestaurant: (input: UnknownRecord) => Promise<UnknownRecord>
  updateRestaurant: (placeId: string, updates: UnknownRecord) => Promise<UnknownRecord>
  removeSavedRestaurant: (placeId: string) => Promise<void>
  updateRestaurantNotes: (placeId: string, notes: string) => Promise<void>
  describePlace: (name: string, address: string, primaryType?: string | null) => Promise<string>
  researchRestaurant: (placeId: string) => Promise<UnknownRecord>
  researchAllRestaurants: (opts?: { force?: boolean }) => Promise<UnknownRecord>
  onRestaurantResearchProgress: ToastEvent<unknown>
  discoverRestaurants: (query: string, mode?: 'food' | 'places') => Promise<UnknownRecord[]>
  discoverTrendingPlaces: (mode?: 'food' | 'places') => Promise<string>
  editRestaurant: (placeId: string, updates: UnknownRecord) => Promise<UnknownRecord>
  addVisit: (
    placeId: string,
    rating: number | null,
    visitDate?: string,
    notes?: string,
  ) => Promise<UnknownRecord>
  updateVisit: (visitId: number, updates: UnknownRecord) => Promise<UnknownRecord>
  removeVisit: (visitId: number) => Promise<void>
  getVisits: (placeId: string) => Promise<UnknownRecord[]>

  getDistanceFromHome: (destination: string) => Promise<UnknownRecord>
  onBriefingNew: ToastEvent<unknown>
  onFinanceUpdated: VoidEvent

  getPriceTimeSeries: (
    symbol: string,
    days?: number,
    withIndicators?: boolean,
  ) => Promise<UnknownRecord[]>
  getPortfolioVsBenchmark: (days?: number, benchmarks?: string[]) => Promise<UnknownRecord>
  getCorrelationMatrix: (symbols?: string[], days?: number) => Promise<UnknownRecord>
  getSectorExposure: () => Promise<UnknownRecord>
  getSentimentTimeSeries: (symbol?: string, days?: number) => Promise<UnknownRecord[]>
  getMetricRollingAverages: (
    metricType: string,
    windows?: number[],
    days?: number,
  ) => Promise<UnknownRecord[]>
  getSleepStageHistory: (days?: number) => Promise<UnknownRecord[]>
  getCircadianPhases24h: () => Promise<UnknownRecord[]>
  getFitnessHistory: (days?: number) => Promise<UnknownRecord[]>
  getAiCacheStats: (days?: number) => Promise<UnknownRecord>
  getRelayStats: () => Promise<UnknownRecord>
  getSchedulerSuccessRate: (days?: number) => Promise<UnknownRecord[]>

  getCrossDomainReadiness: () => Promise<UnknownRecord>
  getEnergyAlignment: (date?: string) => Promise<UnknownRecord>
  getCrossDomainCorrelations: (days?: number) => Promise<UnknownRecord>
  testRelayConnection: () => Promise<UnknownRecord>
  getAppVersion: () => Promise<string>
  checkUpdate: () => Promise<UnknownRecord>
  applyUpdate: () => Promise<UnknownRecord>
}

declare global {
  interface Window {
    api: WindowAPI
  }
}
