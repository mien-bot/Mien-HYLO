import store from './store'

export interface AppSettings {
  // API Keys
  claudeApiKey?: string
  alphaVantageKey?: string
  ticketmasterApiKey?: string
  googlePlacesKey?: string

  // Health
  healthDataPath?: string
  healthServerPort?: string
  userAge?: string
  userWeight?: string
  /** Legacy single-LTHR field. Kept for back-compat reads; new code uses lthrRun / lthrRide. */
  lactateThresholdHR?: string
  /** Auto-detected or user-set max HR for running. BPM. */
  maxHrRun?: string
  /** Auto-detected or user-set max HR for cycling. BPM. */
  maxHrRide?: string
  /** Auto-detected or user-set LTHR for running (Friel 20-min best avg). BPM. */
  lthrRun?: string
  /** Auto-detected or user-set LTHR for cycling. BPM. */
  lthrRide?: string
  /** Auto-detected or user-set resting HR. BPM. */
  restingHr?: string
  /** Zone definition model. 'friel' uses %LTHR (more accurate when LTHR is set), 'maxhr' uses %max HR. */
  zoneModel?: 'maxhr' | 'friel' | string
  ftp?: string
  activityIgnorePatterns?: string
  hrZones?: string
  stravaClientId?: string
  stravaClientSecret?: string

  // Finance
  youtubeChannels?: string
  newsSentimentDailyCap?: string
  showAdvancedTechnicals?: 'true' | 'false' | string
  defaultRange?: '7d' | '30d' | '90d' | '1y' | string

  // Location
  homeLocation?: string
  homeNeighborhood?: string
  commuteNotes?: string
  transportMode?: string

  // Weekend
  weekendCity?: string
  weekendRadius?: string
  weekendInterests?: string

  // Notion
  notionApiKey?: string
  notionTasksDbId?: string
  notionBriefingsDbId?: string
  notionCalendarDbId?: string
  notionBriefingsDateProperty?: string
  notionCalendarDateProperty?: string

  // Sleep
  sleepGoalHours?: string
  enableMorningSleepBriefing?: string
  morningSleepFallbackTime?: string
  enableWindDownReminder?: string
  windDownMinutesBefore?: string

  // Schedule
  morningBriefingTime?: string

  // Chat
  chatAutoMemory?: 'true' | 'false' | string
  chatModel?: string

  // Relay and display
  relayUrl?: string
  relayToken?: string
  relayDir?: string
  opusMode?: string
  chartDensity?: 'compact' | 'comfortable' | 'spacious' | string
  chartPalette?: string
  enableCrossDomainComposites?: 'true' | 'false' | string

  // Appearance / personalization
  themePreset?: 'ramen' | 'midnight' | 'ocean' | 'matcha' | 'sakura' | string
  accentColor?: string
  motionLevel?: 'calm' | 'playful' | string
  displayName?: string
}

export function getAppSettings(): AppSettings {
  return (store.get('appSettings') as AppSettings) || ({} as AppSettings)
}

export function getSetting<K extends keyof AppSettings>(
  key: K,
  fallback: AppSettings[K],
): AppSettings[K] {
  return getAppSettings()[key] ?? fallback
}
