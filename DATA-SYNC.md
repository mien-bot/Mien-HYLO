# Mien Data Sync Architecture

How data flows between devices in the Mien ecosystem.

## System Overview

```
                                 RELAY SERVER (always-on)
                                 relay/server.js :3456
                                 ┌─────────────────────┐
  iPhone Shortcuts ──POST───────>│                     │
  Health Auto Export ──POST─────>│   In-memory store   │<──────── Cloudflare Tunnel
                                 │   + health-data.json│           (public HTTPS)
                                 │   + sync-data.json  │
                                 └──────┬───────┬──────┘
                                        │       │
                              pull/push │       │ pull/push
                                        v       v
                          ┌─────────────┐       ┌──────────────┐
                          │  DESKTOP    │       │   MOBILE     │
                          │  Electron   │       │   Expo Go    │
                          │  SQLite DB  │       │   SQLite DB  │
                          └─────────────┘       └──────────────┘
```

## Data Sources (How Data Enters the System)

### 1. Health Auto Export (iOS app)
- Sends health data directly to the relay server
- `POST /health/sync` — bulk JSON with metrics array
- Metrics: sleep, heart_rate, hrv, steps, active_energy, blood_oxygen, etc.
- Runs on schedule from the iPhone (morning + 11:50 PM)

### 2. iPhone Shortcuts
- Simple flat key-value format for quick health data entry
- `POST /health/simple?sleep=420&deep=90&hr=68&steps=8500&hrv=45`
- Optional params: `rhr`, `active_energy`, `spo2`, `resp_rate`, `vo2max`
- Date defaults to today, can override with `?date=2026-05-14`

### 3. Desktop Electron App
- **Health Auto Export listener**: HTTP server on port `19876` receives data from Health Auto Export when desktop is running
- **Strava**: OAuth2 integration fetches workouts from Strava API, stores as `metric_type='workout'` in `health_metrics`
- **Finance APIs**: Yahoo Finance, CoinGecko, Alpha Vantage, Google News RSS, YouTube RSS
- **AI Briefings**: Claude generates morning finance + sleep briefings
- **Notion**: Two-way sync of tasks, briefings, calendar
- **Manual import**: Health page upload button for JSON/CSV files

### 4. Relay Server (Autonomous)
The relay itself generates data independently:
- **Finance refresh** every 4 hours (prices, news via Yahoo/CoinGecko/RSS)
- **Morning briefing** daily at 7:00-8:00 AM (Claude-generated)
- These run even when desktop and mobile are offline

## Relay Server Storage

The relay stores data in two JSON files on disk:

| File | Contents |
|------|----------|
| `health-data.json` | All health metrics (sleep, HR, HRV, steps, workouts, etc.) |
| `sync-data.json` | Everything else: watchlist, prices, news and summary context, briefings, chat, weekend plans, schedules, restaurants, holdings, alerts |

Data is also held in memory for fast access. Files are written on every update for persistence across restarts.

## Sync Endpoints

### Health Data
| Endpoint | Method | Direction | Description |
|----------|--------|-----------|-------------|
| `/health/sync` | POST | In | Receive health metrics (from HAE, Shortcuts, or desktop) |
| `/health/simple` | POST | In | Flat key-value health data (Shortcuts-friendly) |
| `/health/data?days=N` | GET | Out | Serve health metrics for the last N days |
| `/health/cleanup` | POST | — | Remove bad data (out-of-range HR, HRV, sleep, SpO2) |

### Full Sync
| Endpoint | Method | Direction | Description |
|----------|--------|-----------|-------------|
| `/sync/push-all` | POST | In | Desktop pushes all table data (watchlist, prices, news, briefings, chat, plans, restaurants, holdings, alerts, health) |
| `/sync/pull-all` | GET | Out | Desktop and mobile pull synced app tables. Use `includeHealth=false` for the normal lightweight path, or `healthDays=N` for bounded health inclusion. |
| `/sync/push-mobile` | POST | In | Mobile pushes restaurants, chat, event cache, and schedules back |

### Weekend Event Search Cache
- Desktop and mobile event searches are auto-saved into `weekend_event_cache`.
- Cached events include Ticketmaster and web-search results with name, date, time, venue, URL, price, description, source, query, and category metadata.
- Desktop pushes cached events through `/sync/push-all`; mobile pushes cached events through `/sync/push-mobile`.
- Both clients merge cached events from `/sync/pull-all`, so event searches discovered on one device can appear on the other after relay sync.

### Weekend Plans
- Desktop weekend plans are stored in SQLite table `weekend_plans`.
- The Weekend page's **Save to Mobile** button writes the currently visible itinerary to `weekend_plans`, then runs `relaySyncAll()` so the relay receives the latest plan immediately.
- Mobile sees saved desktop plans after a full relay pull (`fullSyncFromRelay()`), including the Saved Plans screen and plan detail view.
- The normal 30-minute desktop sync still pushes recent `weekend_plans`, so the button is an explicit immediate sync path rather than a separate storage system.

### Sleep Analysis
| Endpoint | Method | Direction | Description |
|----------|--------|-----------|-------------|
| `/sleep/analysis` | POST | In | Desktop pushes pre-computed sleep analysis |
| `/sleep/analysis` | GET | Out | Mobile pulls sleep analysis results |

## Desktop Sync Cycle

`syncWithRelay()` runs every 30 minutes (cron) and on startup:

```
1. pushHealthToRelay()         — Push new health_metrics rows to relay
2. pullHealthFromRelay()       — Pull data relay has (from HAE/Shortcuts)
3. pullMobileDataFromRelay()   — Pull app data pushed by mobile or other desktop sessions
4. pushAllToRelay()            — Push app tables (prices, news, briefings, etc.; health uses the dedicated health path)
5. pushSleepAnalysisToRelay()  — Push computed sleep analysis for mobile
```

**Incremental sync**: Each table tracks a `last_pushed_at` checkpoint in `sync_checkpoints`. Only rows with `imported_at > checkpoint` are pushed, keeping the 30-min sync cheap.

**First-time sync**: If the local `health_metrics` table is empty, the desktop backfills everything the relay has (up to ~10 years).

**Conflict handling**: user-authored schedules and weekend plans carry `updated_at`/`deleted_at` metadata and merge by their natural key (`date` or `weekend_date`). Holdings and finance/health alerts carry stable `sync_id` values plus `updated_at`/`deleted_at`, so independent rows created on different desktops do not collide just because their local SQLite IDs match. For the same row, the newest update or tombstone wins.

### Data Validation on Pull
The desktop validates incoming health data before inserting:
- Sleep < 60 min: filtered
- HR <= 0 or > 220: filtered
- HRV <= 0 or > 300: filtered
- Zero-value energy/steps/distance: filtered
- Sleep `inBed` recomputed from timestamps when raw field is 0

## Mobile Sync

### Auto-sync (background)
- On app launch and when returning from background (throttled to once per 2 min)
- Every 5 minutes while the app is open
- Calls `syncFromRelay(14)` — pulls last 14 days of health data
- Every 30 minutes, pushes mobile-owned data and runs a lightweight full app-data sync with `/sync/pull-all?includeHealth=false`; health has already been refreshed through `/health/data`.

### Manual sync
- **Full sync**: Settings screen "Sync from Desktop" button → `fullSyncFromRelay()` pulls everything (all tables)
- **Health sync**: Health screen cloud button → `syncFromRelay(days)`
- **Exercise sync**: Exercise screen cloud button → `syncFromRelay(days)` then reload

### Mobile → Relay
- `pushMobileDataToRelay()` — sends saved restaurants and recent chat messages
- `pushHealthToRelay()` — sends any locally-collected health data

**Saved weekend plans**: After using **Save to Mobile** on desktop, run full sync on mobile to pull the latest `weekend_plans` into Saved Plans.

### Restaurant Reviews
- Restaurant visit reviews live in `restaurant_visits` and sync bidirectionally through the relay.
- Desktop and mobile both push `place_id`, `visit_date`, `rating`, `notes`, and `created_at`.
- The relay treats `place_id + visit_date` as the stable review key and keeps the row with the newest `created_at`, so edited reviews replace stale copies across devices.
- When pulled, each client upserts reviews by `place_id + visit_date` and refreshes the saved restaurant's visited date and average personal rating.
- Deleting a review writes a `deleted_at` tombstone instead of dropping the row immediately, so the delete can propagate and the UI still hides the removed review.

## Strava Integration

Strava workouts flow through a specific path:

```
Strava API ──OAuth──> Desktop Electron
                      strava.service.ts
                      ├── syncStravaActivities(days)
                      ├── Stores as metric_type='workout' in health_metrics
                      └── source='strava'
                            │
                            v (every 30 min via syncWithRelay)
                      Relay Server
                      health-data.json
                            │
                            v (on-demand via sync button)
                      Mobile App
                      local SQLite
```

### Strava IPC Handlers (Desktop)
| Handler | Description |
|---------|-------------|
| `strava:connect` | Start OAuth2 flow (opens browser, callback on port 19877) |
| `strava:disconnect` | Clear stored tokens |
| `strava:status` | Check connection status + athlete name |
| `strava:sync` | Sync recent activities (default 90 days) |
| `strava:syncAll` | Sync full history (~10 years) |

### Strava Data Format
Stored in `health_metrics` as:
```json
{
  "metric_type": "workout",
  "date": "2026-05-14",
  "value_json": {
    "workouts": [{
      "name": "Run",
      "duration": 45,
      "calories": 520,
      "distance": 4.2,
      "avgHR": 155,
      "maxHR": 178,
      "start": "2026-05-14T07:00:00Z",
      "end": "2026-05-14T07:45:00Z",
      "source": "Strava",
      "stravaId": 12345678,
      "sportType": "Run",
      "elevationGain": 120,
      "sufferScore": 85,
      "avgCadence": 170,
      "avgWatts": 0,
      "normalizedPower": 0
    }]
  },
  "source": "strava"
}
```

## Relay Authentication

- Bearer token stored in `relay/relay.key` (auto-generated on first run)
- All endpoints except `GET /` require `Authorization: Bearer <token>`
- Token must be configured in desktop Settings and mobile Settings
- When Cloudflare Tunnel is active, even `GET /` requires auth

## Strava on the Relay Server

The relay server has its own Strava integration, independent of the desktop app. This means workouts sync even when the desktop is offline.

### Setup (one-time)
1. Create a Strava API app at https://www.strava.com/settings/api
2. Set the "Authorization Callback Domain" to your tunnel domain (e.g. `abc-xyz.trycloudflare.com`) or `localhost`
3. Connect from any device by opening this URL (replace values):
   ```
   https://<tunnel-url>/strava/connect?client_id=YOUR_ID&client_secret=YOUR_SECRET
   ```
   This returns a JSON response with `authUrl` — open that URL in your browser to authorize.
4. Or set env vars `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` in `relay/.env`

### Auto-sync schedule
- Once per day: syncs recent activities as a safety net
- On server boot: syncs last 7 days (after 15s delay)
- On first auth: syncs last 90 days immediately

### Manual sync
```
POST /strava/sync?days=90
Authorization: Bearer <relay-token>
```

By default, relay sync also fetches detailed Strava activity fields and stream data for a bounded set of activities so the desktop analysis can use splits, laps, segment efforts, best efforts, route/lat-lng streams, moving flags, temperature, power/cadence/elevation fields, HR zone seconds, pace zones, GAP, and best splits:

```
POST /strava/sync?days=90&detail_limit=25&stream_limit=25
```

### Files stored on server
| File | Purpose |
|------|---------|
| `relay/strava-tokens.json` | OAuth tokens + athlete info (chmod 600) |
| `relay/strava-config.json` | Client ID/secret (chmod 600) |
| `relay/strava-activity-details.json` | Detailed activity fields, gear/map/device metadata, splits/laps/best efforts/segment efforts summaries |
| `relay/strava-streams.json` | Normalized second-by-second streams for analysis, including route, moving, temperature, HR, pace, cadence, power, elevation, and grade |

### Strava Relay Endpoints
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/strava/connect?client_id=X&client_secret=Y` | GET | Bearer | Returns `authUrl` to open in browser |
| `/strava/callback` | GET | None | OAuth redirect target (browser lands here) |
| `/strava/status` | GET | Bearer | Check connection + athlete name |
| `/strava/sync?days=N&detail_limit=25&stream_limit=25` | POST | Bearer | Trigger manual sync and bounded detail/stream enrichment |
| `/strava/streams?days=N` | GET | Bearer | Pull stored stream data for desktop analysis |
| `/strava/disconnect` | POST | Bearer | Clear tokens |

### Triggering from any device
- **Desktop**: Click "Sync Strava" on Fitness page. It asks the relay to sync Strava, then pulls enriched workout rows and streams into the local database used by the Exercise analysis tabs.
- **Mobile**: Sync button pulls workouts from relay (which has its own Strava data)
- **Any browser**: Hit `/strava/sync` with bearer token to trigger relay-side sync

## Port Map

| Port | Service | Purpose |
|------|---------|---------|
| 3456 | Relay server | Central sync hub |
| 19876 | Health Auto Export listener | Desktop receives HAE data directly |
| 19877 | Strava OAuth callback | Temporary during OAuth flow |
| 8081/8082 | Expo dev server | Mobile development |
