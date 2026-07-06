import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type { ChatAttachmentInput, ChatToolStatus } from '../shared/types/ipc.types'

const api = {
  setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),
  getZoomFactor: () => webFrame.getZoomFactor(),
  capturePage: (rect?: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('app:capturePage', rect),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Settings
  getSettings: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSettings: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  getSavedOverview: () => ipcRenderer.invoke('saved:getOverview'),

  // App lock
  authIsSet: () => ipcRenderer.invoke('auth:isSet') as Promise<boolean>,
  authSetPassword: (password: string) =>
    ipcRenderer.invoke('auth:setPassword', password) as Promise<boolean>,
  authVerify: (password: string) => ipcRenderer.invoke('auth:verify', password) as Promise<boolean>,

  // Finance
  getWatchlist: () => ipcRenderer.invoke('finance:getWatchlist'),
  addToWatchlist: (symbol: string, type: string, name?: string) =>
    ipcRenderer.invoke('finance:addToWatchlist', symbol, type, name),
  removeFromWatchlist: (symbol: string) =>
    ipcRenderer.invoke('finance:removeFromWatchlist', symbol),
  getCachedPrices: () => ipcRenderer.invoke('finance:getCachedPrices'),
  getLatestPrices: () => ipcRenderer.invoke('finance:getLatestPrices'),
  getPrices: (symbol: string, days?: number) =>
    ipcRenderer.invoke('finance:getPrices', symbol, days),
  getNews: () => ipcRenderer.invoke('finance:getNews'),
  getSummarizedNews: () => ipcRenderer.invoke('finance:getSummarizedNews'),
  refreshNews: () => ipcRenderer.invoke('finance:refreshNews'),
  getNewsStats: () => ipcRenderer.invoke('finance:getNewsStats'),
  toggleNewsSaved: (id: number, saved: boolean) =>
    ipcRenderer.invoke('finance:toggleNewsSaved', id, saved),
  refreshFinance: () => ipcRenderer.invoke('finance:refresh'),
  refreshYoutube: () => ipcRenderer.invoke('finance:refreshYoutube'),
  getTechnicals: (symbol: string) => ipcRenderer.invoke('finance:technicals', symbol),
  getRiskMetrics: () => ipcRenderer.invoke('finance:getRiskMetrics'),
  listHoldings: () => ipcRenderer.invoke('holdings:list'),
  addHolding: (input: {
    symbol: string
    quantity: number
    cost_basis: number
    acquired_at?: string | null
    notes?: string | null
  }) => ipcRenderer.invoke('holdings:add', input),
  updateHolding: (id: number, patch: Record<string, unknown>) =>
    ipcRenderer.invoke('holdings:update', id, patch),
  removeHolding: (id: number) => ipcRenderer.invoke('holdings:remove', id),
  importRobinhoodHoldings: () => ipcRenderer.invoke('holdings:importRobinhood'),
  getPortfolioSummary: () => ipcRenderer.invoke('portfolio:getSummary'),
  getPortfolioValueHistory: (days?: number) =>
    ipcRenderer.invoke('portfolio:getValueHistory', days),
  getFundamentals: (symbol?: string) => ipcRenderer.invoke('finance:getFundamentals', symbol),
  refreshFundamentals: (symbol?: string) =>
    ipcRenderer.invoke('finance:refreshFundamentals', symbol),
  getEarningsCalendar: (days?: number) => ipcRenderer.invoke('finance:getEarningsCalendar', days),
  refreshEarningsCalendar: () => ipcRenderer.invoke('finance:refreshEarningsCalendar'),
  scoreNewsSentiment: (max?: number) => ipcRenderer.invoke('finance:scoreNewsSentiment', max),
  getHealthScores: () => ipcRenderer.invoke('finance:getHealthScores'),
  listAlerts: () => ipcRenderer.invoke('alerts:list'),
  createAlert: (input: {
    symbol: string
    type: string
    threshold: number
    note?: string | null
    one_shot?: boolean
  }) => ipcRenderer.invoke('alerts:create', input),
  toggleAlert: (id: number, active: boolean) => ipcRenderer.invoke('alerts:toggle', id, active),
  removeAlert: (id: number) => ipcRenderer.invoke('alerts:remove', id),
  checkAlertsNow: () => ipcRenderer.invoke('alerts:checkNow'),

  listHealthAlerts: () => ipcRenderer.invoke('healthAlerts:list'),
  createHealthAlert: (input: {
    type: string
    threshold: number
    note?: string | null
    one_shot?: boolean
  }) => ipcRenderer.invoke('healthAlerts:create', input),
  toggleHealthAlert: (id: number, active: boolean) =>
    ipcRenderer.invoke('healthAlerts:toggle', id, active),
  removeHealthAlert: (id: number) => ipcRenderer.invoke('healthAlerts:remove', id),
  checkHealthAlertsNow: () => ipcRenderer.invoke('healthAlerts:checkNow'),
  onAlertsFired: (
    callback: (
      hits: Array<{ id: number; symbol: string; type: string; message: string; value: number }>,
    ) => void,
  ) => {
    const listener = (_event: Electron.IpcRendererEvent, hits: any) => callback(hits)
    ipcRenderer.on('alerts:fired', listener)
    return () => {
      ipcRenderer.removeListener('alerts:fired', listener)
    }
  },

  // Health
  getHealthMetrics: (type: string, days?: number) =>
    ipcRenderer.invoke('health:getMetrics', type, days),
  getLatestSleep: () => ipcRenderer.invoke('health:getLatestSleep'),
  getLatestHeartRate: () => ipcRenderer.invoke('health:getLatestHeartRate'),
  importHealthFile: (filePath: string) => ipcRenderer.invoke('health:import', filePath),
  getHealthServerPort: () => ipcRenderer.invoke('health:getServerPort'),
  recalculateSleepInBed: () => ipcRenderer.invoke('health:recalculateSleepInBed'),
  getHealthSummary: () => ipcRenderer.invoke('health:getSummary'),
  getSleepAnalysis: (days?: number) => ipcRenderer.invoke('health:getSleepAnalysis', days),
  getWakeRecommendation: (bedtime: string, latency?: number) =>
    ipcRenderer.invoke('health:getWakeRecommendation', bedtime, latency),
  getBedtimeRecommendation: (wakeTime: string, latency?: number) =>
    ipcRenderer.invoke('health:getBedtimeRecommendation', wakeTime, latency),
  getSleepContext: () => ipcRenderer.invoke('health:getSleepContext'),
  getRecoveryReadiness: () => ipcRenderer.invoke('health:getRecoveryReadiness'),
  getSleepCorrelations: () => ipcRenderer.invoke('health:getSleepCorrelations'),
  getSleepQualityHistory: (days?: number) =>
    ipcRenderer.invoke('health:getSleepQualityHistory', days),
  getSleepRegularity: () => ipcRenderer.invoke('health:getSleepRegularity'),
  getWindDownRoutine: () => ipcRenderer.invoke('health:getWindDownRoutine'),
  getSleepNeedProfile: (days?: number) => ipcRenderer.invoke('health:getSleepNeedProfile', days),

  // Wake Prediction
  predictWakeTime: (input?: {
    recentSleepDays?: number
    isWorkday?: boolean
    plannedBedtime?: string
    sleepLatencyMinutes?: number
  }) => ipcRenderer.invoke('health:predictWakeTime', input),
  saveWakePrediction: (prediction: any, dateStr?: string) =>
    ipcRenderer.invoke('health:saveWakePrediction', prediction, dateStr),
  recordWakeOutcome: (params: {
    date: string
    actualWakeTime: string
    grogginessRating?: number
    energyRating?: number
    minutesToAlertAfterWake?: number
    snoozed?: boolean
  }) => ipcRenderer.invoke('health:recordWakeOutcome', params),
  validateWakePredictions: (days?: number) =>
    ipcRenderer.invoke('health:validateWakePredictions', days),

  // Strava
  stravaConnect: () => ipcRenderer.invoke('strava:connect'),
  stravaDisconnect: () => ipcRenderer.invoke('strava:disconnect'),
  stravaStatus: () => ipcRenderer.invoke('strava:status'),
  stravaSync: (days?: number) => ipcRenderer.invoke('strava:sync', days),
  stravaSyncAll: () => ipcRenderer.invoke('strava:syncAll'),
  stravaSyncStreams: (days?: number, limit?: number) =>
    ipcRenderer.invoke('strava:syncStreams', days, limit),

  // Fitness Analysis
  getFitnessAnalysis: (days?: number) => ipcRenderer.invoke('health:getFitnessAnalysis', days),
  getTrainingLoad: (days?: number) => ipcRenderer.invoke('health:getTrainingLoad', days),
  getRecoveryAnalysis: (days?: number) => ipcRenderer.invoke('health:getRecoveryAnalysis', days),
  getFitnessProfile: (days?: number) => ipcRenderer.invoke('health:getFitnessProfile', days),
  getHRZoneAnalysis: (days?: number) => ipcRenderer.invoke('health:getHRZoneAnalysis', days),
  getHRSS: (days?: number) => ipcRenderer.invoke('health:getHRSS', days),
  getYearProgression: (days?: number) => ipcRenderer.invoke('health:getYearProgression', days),
  getBestEfforts: (days?: number) => ipcRenderer.invoke('health:getBestEfforts', days),
  getStreamZones: (days?: number) => ipcRenderer.invoke('health:getStreamZones', days),
  getBestSplits: (days?: number) => ipcRenderer.invoke('health:getBestSplits', days),
  getGradeAdjustedPace: (days?: number) => ipcRenderer.invoke('health:getGradeAdjustedPace', days),
  getRunningPower: (days?: number) => ipcRenderer.invoke('health:getRunningPower', days),
  getWorkoutDetail: (key: string) => ipcRenderer.invoke('health:getWorkoutDetail', key),
  generateWorkoutReport: (key: string) =>
    ipcRenderer.invoke('health:generateWorkoutReport', key) as Promise<string>,
  getFilteredFitness: (days?: number, patterns?: string[]) =>
    ipcRenderer.invoke('health:getFilteredFitness', days, patterns),

  // Health events
  onSleepDataArrived: (callback: (data: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('health:sleep-data-arrived', listener)
    return () => {
      ipcRenderer.removeListener('health:sleep-data-arrived', listener)
    }
  },
  onWindDown: (callback: (data: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('health:wind-down', listener)
    return () => {
      ipcRenderer.removeListener('health:wind-down', listener)
    }
  },

  // AI
  chat: (
    message: string,
    conversationId?: string,
    model?: string,
    attachments?: ChatAttachmentInput[],
  ) => ipcRenderer.invoke('ai:chat', message, conversationId, model, attachments),
  regenerateChat: (conversationId?: string, model?: string) =>
    ipcRenderer.invoke('ai:regenerate', conversationId, model),
  cancelChat: (conversationId?: string) => ipcRenderer.invoke('ai:cancelChat', conversationId),
  generateBriefing: (type: string) => ipcRenderer.invoke('ai:generateBriefing', type),
  runFinanceSkill: (skill: string, symbol?: string) =>
    ipcRenderer.invoke('ai:financeSkill', skill, symbol),
  getChatHistory: (conversationId?: string) => ipcRenderer.invoke('ai:getHistory', conversationId),
  clearChatHistory: (conversationId?: string) =>
    ipcRenderer.invoke('ai:clearHistory', conversationId),
  listConversations: () => ipcRenderer.invoke('ai:listConversations'),
  renameConversation: (conversationId: string, title: string) =>
    ipcRenderer.invoke('ai:renameConversation', conversationId, title),
  pinConversation: (conversationId: string, pinned: boolean) =>
    ipcRenderer.invoke('ai:pinConversation', conversationId, pinned),
  deleteConversation: (conversationId: string) =>
    ipcRenderer.invoke('ai:deleteConversation', conversationId),
  trimMessagesFrom: (conversationId: string, messageId: number) =>
    ipcRenderer.invoke('ai:trimMessagesFrom', conversationId, messageId),
  listArchivedConversations: () => ipcRenderer.invoke('ai:listArchivedConversations'),
  archiveConversation: (conversationId: string, archived: boolean) =>
    ipcRenderer.invoke('ai:archiveConversation', conversationId, archived),
  searchMessages: (query: string) => ipcRenderer.invoke('ai:searchMessages', query),
  getConversationAttachments: (conversationId?: string) =>
    ipcRenderer.invoke('ai:getConversationAttachments', conversationId),
  exportConversation: (conversationId: string) =>
    ipcRenderer.invoke('ai:exportConversation', conversationId),
  getMemories: () => ipcRenderer.invoke('ai:getMemories'),
  addMemory: (content: string, category?: string) =>
    ipcRenderer.invoke('ai:addMemory', content, category),
  updateMemory: (id: number, content: string, category?: string) =>
    ipcRenderer.invoke('ai:updateMemory', id, content, category),
  deleteMemory: (id: number) => ipcRenderer.invoke('ai:deleteMemory', id),
  clearMemories: () => ipcRenderer.invoke('ai:clearMemories'),
  checkAIConnection: () => ipcRenderer.invoke('ai:checkConnection'),
  addLinkSummary: (url: string, mode: 'standard' | 'deep' = 'standard') =>
    ipcRenderer.invoke('ai:addLinkSummary', url, mode),
  summarizeVideo: (title: string, url: string) =>
    ipcRenderer.invoke('ai:summarizeVideo', title, url) as Promise<string>,
  deepSummarizeVideo: (title: string, url: string) =>
    ipcRenderer.invoke('ai:deepSummarizeVideo', title, url) as Promise<string>,
  summarizeNewsArticle: (article: {
    id?: number
    title: string
    url: string
    source?: string | null
    related_symbols?: string | null
    summary?: string | null
    content_context?: string | null
  }) => ipcRenderer.invoke('ai:summarizeNewsArticle', article) as Promise<string>,
  deepSummarizeNewsArticle: (article: {
    id?: number
    title: string
    url: string
    source?: string | null
    related_symbols?: string | null
    summary?: string | null
    content_context?: string | null
  }) => ipcRenderer.invoke('ai:deepSummarizeNewsArticle', article) as Promise<string>,
  getAiActivityLog: (limit?: number) => ipcRenderer.invoke('ai:getActivityLog', limit),
  getAiActivityStats: (days?: number) => ipcRenderer.invoke('ai:getActivityStats', days),
  clearAiActivityLog: () => ipcRenderer.invoke('ai:clearActivityLog'),
  previewBriefing: (type: string) => ipcRenderer.invoke('ai:previewBriefing', type),
  saveChatMessage: (role: string, content: string, conversationId?: string) =>
    ipcRenderer.invoke('chat:saveMessage', role, content, conversationId),
  pickFolder: () => ipcRenderer.invoke('data:pickFolder'),
  exportMarkdown: (folderPath: string) => ipcRenderer.invoke('data:exportMarkdown', folderPath),

  // AI streaming
  onChatStream: (callback: (chunk: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: string) => callback(chunk)
    ipcRenderer.on('ai:stream-chunk', listener)
    return () => {
      ipcRenderer.removeListener('ai:stream-chunk', listener)
    }
  },
  onChatStreamEnd: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('ai:stream-end', listener)
    return () => {
      ipcRenderer.removeListener('ai:stream-end', listener)
    }
  },
  // Tool-activity status while the agent is running tools mid-turn.
  onChatTool: (callback: (status: ChatToolStatus) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: ChatToolStatus,
    ) => callback(status)
    ipcRenderer.on('ai:chat-tool', listener)
    return () => {
      ipcRenderer.removeListener('ai:chat-tool', listener)
    }
  },
  // Analysis streaming (skills, planners) — separate channel from chat so a
  // skill running in the background doesn't bleed chunks into the chat UI.
  onAnalysisStream: (callback: (chunk: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: string) => callback(chunk)
    ipcRenderer.on('ai:analysis-stream-chunk', listener)
    return () => {
      ipcRenderer.removeListener('ai:analysis-stream-chunk', listener)
    }
  },
  onAnalysisStreamEnd: (callback: (payload?: { error?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload?: { error?: string }) =>
      callback(payload)
    ipcRenderer.on('ai:analysis-stream-end', listener)
    return () => {
      ipcRenderer.removeListener('ai:analysis-stream-end', listener)
    }
  },

  // Notion
  syncNotionTasks: () => ipcRenderer.invoke('notion:syncTasks'),
  getTodayTasks: (date?: string) => ipcRenderer.invoke('tasks:getToday', date),
  pushBriefingToNotion: (briefingId: number) =>
    ipcRenderer.invoke('notion:pushBriefing', briefingId),
  pullBriefingsFromNotion: (daysBack?: number) =>
    ipcRenderer.invoke('notion:pullBriefings', daysBack),

  // Briefings
  getLatestBriefing: (type?: string) => ipcRenderer.invoke('briefings:getLatest', type),
  getAllBriefings: (limit?: number) => ipcRenderer.invoke('briefings:getAll', limit),

  // Schedule
  getTodaySchedule: () => ipcRenderer.invoke('schedule:getToday'),
  getPlannerWeatherPreview: (dates?: string[], location?: string) =>
    ipcRenderer.invoke('weather:getPlannerPreview', dates, location),
  getScheduleHistory: (limit?: number) => ipcRenderer.invoke('schedule:getHistory', limit),
  generateSchedule: (prefs?: object) => ipcRenderer.invoke('schedule:generate', prefs),
  updateTodaySchedule: (scheduleJson: string) =>
    ipcRenderer.invoke('schedule:updateToday', scheduleJson),
  tweakDailySchedule: (date: string, instruction: string) =>
    ipcRenderer.invoke('schedule:tweak', date, instruction),
  pushScheduleToNotion: (scheduleJson: string, date: string, databaseId?: string) =>
    ipcRenderer.invoke('schedule:pushToNotion', scheduleJson, date, databaseId),

  // Scheduler
  getSchedulerStatus: () => ipcRenderer.invoke('scheduler:getStatus'),
  getSchedulerActivity: (limit?: number) => ipcRenderer.invoke('scheduler:getActivity', limit),

  // Relay sync
  relaySyncAll: () => ipcRenderer.invoke('relay:syncAll'),
  relayPushSleepAnalysis: () => ipcRenderer.invoke('relay:pushSleepAnalysis'),
  relayPullHistoricalSleep: (days?: number) =>
    ipcRenderer.invoke('relay:pullHistoricalSleep', days),
  getTunnelUrl: () => ipcRenderer.invoke('relay:getTunnelUrl'),
  onTunnelUrl: (
    callback: (data: {
      url: string | null
      source: string | null
      updatedAt: number | null
    }) => void,
  ) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('relay:tunnel-url', listener)
    return () => {
      ipcRenderer.removeListener('relay:tunnel-url', listener)
    }
  },

  // Weekend Planner
  getWeekendEvents: () => ipcRenderer.invoke('weekend:getEvents'),
  searchWeekendEvents: (opts?: {
    keyword?: string
    date?: string
    category?: string
    page?: number
  }) => ipcRenderer.invoke('weekend:searchEvents', opts),
  webSearchEvents: (query: string, date?: string) =>
    ipcRenderer.invoke('weekend:webSearchEvents', query, date),
  listCachedWeekendEvents: (limit?: number) =>
    ipcRenderer.invoke('weekend:listCachedEvents', limit),
  getWeekendPlan: (weekendDate?: string) => ipcRenderer.invoke('weekend:getPlan', weekendDate),
  generateWeekendPlan: (params?: string | object) => ipcRenderer.invoke('weekend:generate', params),
  generateWeekendPlanForDay: (day: string, params?: string | object) =>
    ipcRenderer.invoke('weekend:generateDay', day, params),
  updateWeekendPlan: (weekendDate: string, planJson: string) =>
    ipcRenderer.invoke('weekend:updatePlan', weekendDate, planJson),
  tweakWeekendPlan: (weekendDate: string, instruction: string, day?: string) =>
    ipcRenderer.invoke('weekend:tweakPlan', weekendDate, instruction, day),
  getWeekendAgendaMapImages: (routes: { saturday?: string[]; sunday?: string[] }) =>
    ipcRenderer.invoke('weekend:getAgendaMapImages', routes),
  resolveRouteLocations: (route: string[]) =>
    ipcRenderer.invoke('weekend:resolveRouteLocations', route),
  pushWeekendToNotion: (planJson: string, weekendDate: string, databaseId?: string) =>
    ipcRenderer.invoke('weekend:pushToNotion', planJson, weekendDate, databaseId),
  listWeekendPlans: (limit?: number) => ipcRenderer.invoke('weekend:listPlans', limit),
  listNotionDatabases: () => ipcRenderer.invoke('notion:listDatabases'),
  getNotionDbProperties: (dbId: string) => ipcRenderer.invoke('notion:getDbProperties', dbId),

  // Restaurants
  autocompleteRestaurants: (input: string, mode?: 'food' | 'places') =>
    ipcRenderer.invoke('restaurants:autocomplete', input, mode),
  searchRestaurants: (query?: string) => ipcRenderer.invoke('restaurants:search', query),
  getPlaceById: (placeId: string) => ipcRenderer.invoke('restaurants:getPlace', placeId),
  searchNearbyPlaces: (options: {
    lat: number
    lng: number
    radiusMiles?: number
    types?: string[]
  }) => ipcRenderer.invoke('restaurants:searchNearby', options),
  getSavedRestaurants: (filter?: any) => ipcRenderer.invoke('restaurants:getSaved', filter),
  saveRestaurant: (restaurant: any, notes?: string) =>
    ipcRenderer.invoke('restaurants:save', restaurant, notes),
  addManualRestaurant: (input: any) => ipcRenderer.invoke('restaurants:addManual', input),
  updateRestaurant: (placeId: string, updates: any) =>
    ipcRenderer.invoke('restaurants:update', placeId, updates),
  removeSavedRestaurant: (placeId: string) => ipcRenderer.invoke('restaurants:remove', placeId),
  updateRestaurantNotes: (placeId: string, notes: string) =>
    ipcRenderer.invoke('restaurants:updateNotes', placeId, notes),
  describePlace: (name: string, address: string, primaryType?: string | null) =>
    ipcRenderer.invoke('restaurants:describe', name, address, primaryType),
  researchRestaurant: (placeId: string) => ipcRenderer.invoke('restaurants:research', placeId),
  researchAllRestaurants: (opts?: { force?: boolean }) =>
    ipcRenderer.invoke('restaurants:researchAll', opts),
  onRestaurantResearchProgress: (callback: (progress: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress)
    ipcRenderer.on('restaurants:research-progress', listener)
    return () => {
      ipcRenderer.removeListener('restaurants:research-progress', listener)
    }
  },
  discoverRestaurants: (query: string, mode?: 'food' | 'places') =>
    ipcRenderer.invoke('restaurants:discover', query, mode),
  discoverTrendingPlaces: (mode?: 'food' | 'places') =>
    ipcRenderer.invoke('restaurants:discoverTrending', mode),
  editRestaurant: (placeId: string, updates: any) =>
    ipcRenderer.invoke('restaurants:edit', placeId, updates),
  addVisit: (placeId: string, rating: number | null, visitDate?: string, notes?: string) =>
    ipcRenderer.invoke('restaurants:addVisit', placeId, rating, visitDate, notes),
  updateVisit: (visitId: number, updates: any) =>
    ipcRenderer.invoke('restaurants:updateVisit', visitId, updates),
  removeVisit: (visitId: number) => ipcRenderer.invoke('restaurants:removeVisit', visitId),
  getVisits: (placeId: string) => ipcRenderer.invoke('restaurants:getVisits', placeId),

  // Distance
  getDistanceFromHome: (destination: string) =>
    ipcRenderer.invoke('distance:fromHome', destination),

  // Background notifications from scheduler
  onBriefingNew: (callback: (data: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('briefing:new', listener)
    return () => {
      ipcRenderer.removeListener('briefing:new', listener)
    }
  },
  onFinanceUpdated: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('finance:updated', listener)
    return () => {
      ipcRenderer.removeListener('finance:updated', listener)
    }
  },

  // --- Visualization aggregations ---
  getPriceTimeSeries: (symbol: string, days?: number, withIndicators?: boolean) =>
    ipcRenderer.invoke('finance:getPriceTimeSeries', symbol, days, withIndicators),
  getPortfolioVsBenchmark: (days?: number, benchmarks?: string[]) =>
    ipcRenderer.invoke('finance:getPortfolioVsBenchmark', days, benchmarks),
  getCorrelationMatrix: (symbols?: string[], days?: number) =>
    ipcRenderer.invoke('finance:getCorrelationMatrix', symbols, days),
  getSectorExposure: () => ipcRenderer.invoke('finance:getSectorExposure'),
  getSentimentTimeSeries: (symbol?: string, days?: number) =>
    ipcRenderer.invoke('finance:getSentimentTimeSeries', symbol, days),
  getMetricRollingAverages: (metricType: string, windows?: number[], days?: number) =>
    ipcRenderer.invoke('health:getMetricRollingAverages', metricType, windows, days),
  getSleepStageHistory: (days?: number) => ipcRenderer.invoke('health:getSleepStageHistory', days),
  getCircadianPhases24h: () => ipcRenderer.invoke('health:getCircadianPhases24h'),
  getFitnessHistory: (days?: number) => ipcRenderer.invoke('health:getFitnessHistory', days),
  getAiCacheStats: (days?: number) => ipcRenderer.invoke('ai:getCacheStats', days),
  getRelayStats: () => ipcRenderer.invoke('relay:getStats'),
  getSchedulerSuccessRate: (days?: number) => ipcRenderer.invoke('scheduler:getSuccessRate', days),

  // --- Cross-domain composite engine ---
  getCrossDomainReadiness: () => ipcRenderer.invoke('composite:getReadiness'),
  getEnergyAlignment: (date?: string) => ipcRenderer.invoke('composite:getEnergyAlignment', date),
  getCrossDomainCorrelations: (days?: number) =>
    ipcRenderer.invoke('composite:getCorrelations', days),
  testRelayConnection: () => ipcRenderer.invoke('relay:testConnection'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>,
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  applyUpdate: () => ipcRenderer.invoke('app:applyUpdate'),
}

contextBridge.exposeInMainWorld('api', api)

export type MienAPI = typeof api
