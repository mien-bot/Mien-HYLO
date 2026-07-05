import { registerFinanceHandlers } from './finance'
import { registerHealthHandlers } from './health'
import { registerStravaHandlers } from './strava'
import { registerAiHandlers } from './ai'
import { registerWeekendHandlers } from './weekend'
import { registerProductivityHandlers } from './productivity'
import { registerNotionHandlers } from './notion'
import { registerSettingsHandlers } from './settings'

export function registerAllHandlers(): void {
  registerFinanceHandlers()
  registerHealthHandlers()
  registerStravaHandlers()
  registerAiHandlers()
  registerWeekendHandlers()
  registerProductivityHandlers()
  registerNotionHandlers()
  registerSettingsHandlers()
}
