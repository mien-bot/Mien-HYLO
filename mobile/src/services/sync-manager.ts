import { syncFromRelay } from './health-sync.service'

type SyncResult = Awaited<ReturnType<typeof syncFromRelay>>

let inFlightSync: Promise<SyncResult> | null = null
let lastSuccessfulSyncAt = 0
let lastResult: SyncResult | null = null

const RECENT_SYNC_WINDOW_MS = 10_000

export function getOrStartHealthSync(days = 14): Promise<SyncResult> {
  const now = Date.now()
  if (lastResult?.success && now - lastSuccessfulSyncAt < RECENT_SYNC_WINDOW_MS) {
    return Promise.resolve({ ...lastResult, count: 0 })
  }

  if (inFlightSync) return inFlightSync

  inFlightSync = syncFromRelay(days)
    .then((result) => {
      if (result.success) {
        lastSuccessfulSyncAt = Date.now()
        lastResult = result
      }
      return result
    })
    .finally(() => {
      inFlightSync = null
    })

  return inFlightSync
}
