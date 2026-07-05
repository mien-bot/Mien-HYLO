# Mien Desktop/Mobile Sync Audit

Date: 2026-05-17

Scope reviewed:
- Desktop sync service: `src/main/services/sync.service.ts`
- Desktop database and IPC boundary: `src/main/db/database.ts`, `src/main/ipc.ts`, `src/main/preload.ts`
- Relay server sync/auth endpoints: `relay/server.js`
- Mobile sync service and SQLite schema: `mobile/src/services/health-sync.service.ts`, `mobile/src/lib/database.ts`, `mobile/App.tsx`
- Sync docs: `DATA-SYNC.md`, `HOW-IT-WORKS.md`

Checks run:
- `npm run health` passed, including the Electron production build.
- `cmd /c npx tsc -p mobile/tsconfig.json --noEmit` passed.

Implementation follow-up:
- Added bounded relay JSON body parsing for sync payloads.
- Added lightweight `/sync/pull-all?includeHealth=false` behavior and bounded health inclusion options.
- Changed mobile full app-data sync to avoid pulling health twice.
- Changed desktop relay sync to return structured per-step status instead of unconditional success.
- Removed health from desktop `pushAllToRelay()` so the dedicated health path owns health pushes.
- Added row-level mobile sync diagnostics.
- Hardened saved-restaurant merging so empty/stale rows do not wipe richer fields.
- Switched relay health/sync JSON persistence to temp-file rename writes.
- Added `mobile` `typecheck` script.

## Executive Summary

The current sync architecture is coherent and mostly works: the relay is the shared source for cross-device data, desktop keeps a fast SQLite mirror, mobile keeps its own SQLite mirror, and bearer-token auth is enforced for the sync routes.

The biggest problems are not compile errors. They are operational correctness and efficiency issues:

1. Mobile full sync pulls all relay health history every time it calls `/sync/pull-all`, and app-level sync can do this every 30 minutes.
2. Desktop manual sync reports success even when one or more sync sub-steps fail.
3. Sync writes often swallow row-level insert errors, so data can silently fail to sync.
4. Desktop health data is pushed through two overlapping paths with separate checkpoints.
5. The relay accepts unbounded JSON request bodies on sync endpoints.

These are fixable without changing the product model. The most effective fix is to make `/sync/pull-all` support bounded or delta health payloads and return structured sync results all the way to the UI.

## What Looks Good

- Desktop renderer access stays behind preload IPC. The relay sync operation is exposed as `relaySyncAll` in `src/main/preload.ts`, and handled in main in `src/main/ipc.ts`.
- Desktop and mobile schemas are broadly aligned for the synced tables: watchlist, price history, health metrics, briefings, chat, weekend plans, event cache, daily schedule, restaurants, holdings, alerts, health alerts, and fundamentals.
- Relay sync routes are protected after the public health/expo/webhook routes by `checkAuth(req, res)`.
- Mobile stores relay settings in Expo SecureStore via `mobile/src/lib/storage.ts`.
- Desktop uses `sync_checkpoints` for incremental desktop pushes of price/news/health rows.
- Workout merge logic preserves Strava and non-Strava workouts for the same date instead of blindly replacing the whole workout day.
- Health pull paths do useful validation for obviously bad rows on desktop, especially HR, HRV, sleep, steps, and zero-value metrics.

## Findings

### High: Mobile Full Sync Pulls All Health History

Evidence:
- `relay/server.js` returns `health: healthData.metrics` for every `/sync/pull-all` response.
- `mobile/src/services/health-sync.service.ts` calls `/sync/pull-all` in `fullSyncFromRelay()`.
- `seamlessSyncFromRelay()` runs `syncFromRelay(14)` first, then every 30 minutes runs `fullSyncFromRelay()` by default.
- `mobile/App.tsx` calls `seamlessSyncFromRelay()` on launch, foreground, and every 5 minutes while open.

Impact:
- Full history can become large: years of health, workouts, Strava, and HAE rows.
- Mobile may download and reprocess the same large health array every 30 minutes.
- This duplicates the health pull that already ran immediately before full sync.
- It will get worse as `health-data.json` grows.

Recommended fix:
- Add query parameters to `/sync/pull-all`, for example:
  - `includeHealth=false` for normal app-data sync.
  - `healthDays=14` for bounded health inclusion.
  - `since=<iso>` for delta-capable tables later.
- Change mobile `fullSyncFromRelay()` to call `/sync/pull-all?includeHealth=false` after `syncFromRelay()` has already refreshed health.
- Keep a separate explicit "full health backfill" action for first install or repair.

### High: Desktop Sync UI Can Report Success When Sync Failed

Evidence:
- `syncWithRelay()` returns `Promise<void>`.
- It calls `pushHealthToRelay()`, `pullHealthFromRelay()`, `pullMobileDataFromRelay()`, `pushAllToRelay()`, `pushSleepAnalysisToRelay()`, and `pullStravaStreamsFromRelay()`, but it does not aggregate or throw on `{ success: false }`.
- `ipcMain.handle('relay:syncAll')` awaits `syncWithRelay()` and always returns `{ success: true }`.

Impact:
- Settings or "Push to Phone" flows can say the sync succeeded after auth failure, relay outage, partial write failure, or bad relay URL.
- This makes troubleshooting much harder and can hide data loss.

Recommended fix:
- Make `syncWithRelay()` return a structured object:
  - `ok: boolean`
  - `steps: { pushHealth, pullHealth, pullMobile, pushAll, sleepAnalysis, stravaStreams }`
  - per-step counts and errors.
- Change `relay:syncAll` to return that object.
- Update desktop UI to show partial failure instead of unconditional success.

### High: Relay Sync Endpoints Have No Request Body Limit

Evidence:
- In `relay/server.js`, sync endpoints build bodies using `body += chunk` for `/sync/push`, `/sync/push-all`, and `/sync/push-mobile`.
- There is no maximum byte limit and no early connection close.

Impact:
- A reachable relay can be forced to allocate large strings in memory.
- Bearer auth helps, but leaked tokens, local-network mode, or accidental public exposure would make this a practical denial-of-service risk.
- Large legitimate first syncs also have no clear failure mode.

Recommended fix:
- Add a shared `readJsonBody(req, res, maxBytes)` helper.
- Use a larger but explicit limit for `/sync/push-all` and `/health/sync`, for example 10-25 MB initially.
- Return `413 Payload Too Large` with a clear JSON error.
- Consider chunked health backfill later.

### Medium: Desktop Pushes Health Through Two Overlapping Paths

Evidence:
- `syncWithRelay()` calls `pushHealthToRelay()` first.
- Later, `pushAllToRelay()` includes a `health` array and tracks a separate `health_metrics_all` checkpoint.
- Both paths can push full health on first run or after checkpoints are missing.

Impact:
- First sync can send health twice.
- Separate checkpoints can drift, making behavior harder to reason about.
- Relay deduplication mostly prevents duplicates, but not wasted transfer and processing.

Recommended fix:
- Pick one health push path.
- Prefer keeping health push in `pushHealthToRelay()` and remove health from `pushAllToRelay()`, unless `/sync/push-all` is being used as the single explicit "whole app snapshot" API.
- If health remains in both paths, unify checkpoint names and record which endpoint last pushed.

### Medium: Row-Level Sync Errors Are Often Swallowed

Evidence:
- Mobile `fullSyncFromRelay()` catches many insert failures with `catch {}` while still incrementing per-table success around the broader operation.
- Mobile migrations also ignore `ALTER TABLE` failures.
- Desktop pull/merge code has a few silent catches for existing workout parsing and sleep analysis profile generation.

Impact:
- Schema drift or bad rows can lead to missing data without the UI or logs explaining why.
- Counts can become misleading because attempted rows and inserted rows are not always distinguished.

Recommended fix:
- Track row-level failures per table:
  - `attempted`
  - `inserted`
  - `failed`
  - first 3 error messages
- Return these counts from mobile full sync and desktop relay sync.
- Keep noisy stack traces out of the UI, but write diagnostics to console/logs.

### Medium: Mobile Full Sync Uses Replace/Delete Semantics For Desktop-Owned Tables

Evidence:
- Mobile deletes `holdings`, `alerts`, and `health_alerts` before inserting relay snapshots.
- These are intended as read-only mirrors on mobile.

Impact:
- This is acceptable for read-only mirrors, but if mobile ever adds editing for these tables, its local edits will be deleted on the next full sync.

Recommended fix:
- Keep this behavior documented as read-only.
- If mobile editing is introduced, switch these tables to conflict-aware upsert with `updated_at` or source ownership.

### Medium: Last-Write-Wins Conflict Handling Is Very Broad

Evidence:
- Relay merge logic replaces rows by key for saved restaurants, event cache, prices, news, and desktop-owned snapshot tables.
- Docs already state that there is no conflict resolution and last writer wins.

Impact:
- Concurrent desktop/mobile edits to the same restaurant or chat-like state can overwrite fields.
- Saved restaurant merges use only `place_id`, so stale mobile data can overwrite richer desktop research fields if pushed later.

Recommended fix:
- Add `updated_at` to mutable shared tables where it is missing.
- For saved restaurants, merge per field or prefer the newer row by `last_researched_at`/`updated_at`.
- Preserve richer fields when incoming values are null or empty.

### Medium: Native `fetch` Calls In Sync Have No Timeout

Evidence:
- `src/main/services/sync.service.ts` uses `fetch()` directly for relay sync.
- The repo already has `src/main/lib/fetch-with-retry.ts` for bounded network calls, but sync does not use it.

Impact:
- A hung relay/tunnel connection can stall a scheduler run or manual sync longer than expected.
- It can leave the user with no useful error.

Recommended fix:
- Add a small `fetchRelayJson()` helper with `AbortController` timeout, JSON parsing, and consistent error messages.
- Use it in desktop sync and Strava relay calls.
- Mirror a timeout helper in mobile sync where possible.

### Low: `/sync/pull-all` Has An Unused `since` Parameter

Evidence:
- `relay/server.js` parses `since` for `/sync/pull-all` and comments "future use for delta sync", but always returns the full payload.

Impact:
- This can mislead future callers into expecting delta behavior.

Recommended fix:
- Either implement `since` for tables with usable timestamps or remove/comment it more explicitly as unused.
- Start with high-volume tables: `health`, `prices`, `weekend_event_cache`, `news`.

### Low: Relay `sync-data.json` Writes Are Not Atomic

Evidence:
- `saveSyncData()` writes directly with `fs.writeFileSync(SYNC_DATA_PATH, JSON.stringify(syncData))`.
- `saveHealthData()` writes directly too.

Impact:
- A crash or power loss during write could corrupt the JSON file.

Recommended fix:
- Write to `*.tmp`, `fsync` when practical, then rename.
- Keep one timestamped backup of the previous JSON file for recovery.

### Low: Mobile Has No Package Script For Type Checking

Evidence:
- `mobile/package.json` has `start`, `android`, `ios`, and `web`, but no `typecheck`.
- A direct `cmd /c npx tsc -p mobile/tsconfig.json --noEmit` passed.

Impact:
- Mobile type health is easy to skip because it is not part of `npm run health`.

Recommended fix:
- Add `mobile/package.json` script: `"typecheck": "tsc -p tsconfig.json --noEmit"`.
- Optionally call it from the root health check.

## Recommended Fix Plan

1. Fix `/sync/pull-all` payload shape.
   - Add `includeHealth` and `healthDays`.
   - Make mobile normal full sync exclude health.
   - Keep explicit first-run/repair backfill behavior.

2. Make sync results truthful.
   - Return a structured result from `syncWithRelay()`.
   - Wire that through `relay:syncAll`.
   - Show partial failures in Settings and "Push to Phone" UI.

3. Add request body limits to relay JSON endpoints.
   - Shared helper for body parsing.
   - Use `413` for oversized payloads.

4. Reduce duplicate health pushes.
   - Prefer one health push path and one checkpoint.

5. Add row-level diagnostics.
   - Stop using silent catches in sync inserts.
   - Report per-table failure counts.

6. Add bounded fetch timeouts.
   - Desktop sync should not hang scheduler/manual actions indefinitely.

7. Add mobile typecheck script.
   - Keep the command discoverable and easy to run.

## Suggested Validation After Fixes

- Start relay locally and verify unauthorized `/sync/pull-all` returns auth failure.
- Desktop Settings: run manual relay sync with a bad token and confirm UI reports failure.
- Mobile Settings: run "Sync All Data from Desktop" and confirm it does not download health twice.
- First mobile install: confirm health backfill still works.
- Add/edit a saved restaurant on mobile, push, then desktop sync pulls it.
- Save a weekend plan on desktop, push, then mobile full sync shows it.
- Run `npm run health`.
- Run mobile typecheck via the new script.
