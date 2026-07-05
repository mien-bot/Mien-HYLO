# Mien — Personal Intelligence Dashboard

## What This Is
A desktop + mobile app that consolidates financial research, health/sleep tracking (Apple Watch), fitness analysis, productivity scheduling, weekend planning, restaurant discovery, and AI chat — all powered by Claude. Replaces scattered tools and Notion workflows with one unified dashboard.

## Tech Stack

### Desktop (Electron)
- **electron-vite** — Vite for Electron (main + preload + renderer bundles)
- **React 19 + TypeScript** — renderer process; strictly typed `window.api` (no `as any`)
- **Tailwind CSS v4** — styling via `@tailwindcss/vite` plugin
- **better-sqlite3** — local SQLite database (requires `npx electron-rebuild -f -w better-sqlite3`)
- **electron-store v11** — settings persistence (ESM wrapper at `src/main/lib/store.ts`)
- **@anthropic-ai/sdk** — Claude API for AI features
- **@notionhq/client** — Notion two-way sync
- **node-cron** — scheduled background tasks
- **recharts** — data visualization
- **rss-parser** — Google News RSS for finance news
- **date-fns** — date utilities in renderer
- **lucide-react** — icon library
- **Vitest** — unit tests (sleep + fitness analysis suites in `src/main/services/health/*.test.ts`)

### Mobile (React Native / Expo)
- **Expo SDK 54** — React Native framework
- **expo-sqlite** — local SQLite database
- **expo-secure-store** — API key storage
- **expo-notifications** — push notifications (sleep routine reminders)
- **@react-navigation** — tab + stack navigation
- **@anthropic-ai/sdk** — Claude API (same as desktop)

### Relay Server
- **Node.js (ESM)** — `relay/server.js`
- Bearer token auth (auto-generated `relay.key`)
- Cloudflare Tunnel support (`TUNNEL=1`)
- Proxies Claude API calls + syncs health data between desktop ↔ mobile
- **Auth caveat:** when the relay authenticates with a Claude Code OAuth token (not an `x-api-key`), **server-side tools are unavailable** — `web_search` and `code_execution` calls fail and Claude falls back to training data. AI features that pass `{ webSearch: true }` (Plan Weekend web search, restaurant discovery/research) degrade silently in this mode. See `docs/COMMON-BUGS.md` §6. Use a direct API key or the key-free Ticketmaster path for real results.

## Architecture

### Desktop (Electron Two-Process Model)
```
Main Process                              Renderer (React)
├── db/database.ts (SQLite, 24 tables)    ├── pages/ (14 pages)
├── services/                             ├── components/
│   ├── finance/ (Yahoo, CoinGecko,       │   ├── finance/ (chart, watchlist, news)
│   │   AlphaVantage, news, YouTube,      │   ├── health/ (sleep, HR, metrics)
│   │   portfolio, alerts, sentiment,     │   ├── layout/ (Shell, Sidebar, TopBar)
│   │   health-score, tech indicators)    │   ├── productivity/ (timeline, tasks)
│   ├── health/ (sleep-analysis,          │   └── icons/ (BreadLogo)
│   │   fitness-analysis, strava,         ├── hooks/
│   │   health-alerts, workout-merge,     └── App.tsx (router)
│   │   wake-prediction, HTTP server)
│   ├── composite/ (correlation,
│   │   energy-alignment, readiness)
│   ├── weekend/ (events, restaurants,
│   │   distance, planner)
│   ├── notion/ (sync, client, schema)
│   ├── productivity/ (daily planner)
│   ├── ai.service.ts (Claude)
│   ├── markdown-export.service.ts
│   ├── tunnel-url.service.ts
│   ├── sync.service.ts (relay push/pull)
│   └── scheduler.service.ts (7 cron jobs)
├── ai/
│   ├── prompts.ts (system prompts)
│   ├── briefing-generator.ts
│   └── skills/finance/ (6 analysis skills)
├── ipc/ (8 domain modules: ai, finance, health, strava,
│         weekend, productivity, notion, settings;
│         + safe-handle.ts error wrapper, index.ts registrar)
├── preload.ts (contextBridge, typed WindowAPI)
└── index.ts (app entry)
```

All renderer↔main communication goes through IPC via contextBridge. The renderer never has direct Node.js access.

### Mobile
```
mobile/
├── App.tsx (tab navigator + sleep notification init)
├── src/
│   ├── screens/ (12 screens)
│   │   ├── DashboardScreen, HealthScreen, PortfolioScreen
│   │   ├── StockDetailScreen, MarketPulseScreen
│   │   ├── ProductivityScreen, WeekendScreen
│   │   ├── SavedPlansScreen, PlanDetailScreen, ActivityDetailScreen
│   │   ├── ChatScreen, SettingsScreen
│   ├── services/ (12 services)
│   │   ├── ai, finance, news (with YouTube RSS)
│   │   ├── healthkit, health-sync, health-trends
│   │   ├── sleep-analysis, sleep-notifications
│   │   ├── events, restaurants, notion, productivity
│   ├── lib/ (database, storage, theme)
│   └── hooks/
```

## Critical Patterns

### electron-store v11 ESM Import
electron-store v11 exports ESM by default. When externalized by electron-vite, the default export gets nested. Always use the wrapper:
```typescript
import store from './lib/store'  // NOT from 'electron-store'
```
The wrapper at `src/main/lib/store.ts` handles: `const StoreClass = (ElectronStore as any).default || ElectronStore`

### Database Migrations Are Inlined
All SQL is in `database.ts` using `database.exec()`. Do NOT use file-based migrations — electron-vite bundles break `__dirname` / `fs.readFileSync` for SQL files.

### better-sqlite3 Native Module
After any Electron version change or fresh install:
```bash
npx electron-rebuild -f -w better-sqlite3
```

### IPC Flow
1. Add handler in the right domain file under `src/main/ipc/` (ai, finance, health, strava, weekend, productivity, notion, settings); wrap with `safeHandle()` from `safe-handle.ts` for consistent error reporting
2. Register via `registerAllHandlers()` in `src/main/ipc/index.ts` (already auto-wired per domain)
3. Expose in `src/main/preload.ts` and add to the `WindowAPI` interface
4. Call via `window.api.xxx()` in renderer
5. For IPC events (push from main → renderer): use `ipcRenderer.on()` in preload, return cleanup function

### Finance APIs (All Free)
- **Yahoo Finance v8**: No API key needed, raw HTTP to `query1.finance.yahoo.com`
- **CoinGecko**: Free `/api/v3/`, no key needed
- **Alpha Vantage**: Free tier (25 req/day), key in Settings
- **Ticketmaster**: Free (5000 req/day), key in Settings, for weekend events
- **Google Places**: Key in Settings, for restaurant search/discovery
- **YouTube RSS**: No API key — fetches channel feeds via `youtube.com/feeds/videos.xml`

### YouTube Channels
Default finance channels (configurable in Settings as `Name|ChannelID` per line):
- Meet Kevin, Trading Fraternity, Andrei Jikh, Financial Education

Videos are stored in `news_articles` table with source `YouTube: ChannelName`. Both desktop and mobile fetch independently via RSS.

### Health Data Ingestion
- **Primary**: Health Auto Export iOS app → HTTP POST to `localhost:19876`
- **Fallback**: File watcher mode (JSON/CSV files in configured folder)
- **Manual**: Import button on Health page
- **Morning automation**: Sleep data arrival triggers AI briefing + notifications + auto-refresh

### Sleep Analysis Engine
Based on Rise Science / Two-Process Model (Borbély 1982):
- 14-night rolling sleep debt with exponential decay weighting
- Circadian energy phase predictions (5 phases based on habitual sleep/wake times)
- Sleep quality scoring: deep sleep, REM, efficiency, consistency (each 0-100)
- Wake/bedtime recommendations based on 90-min sleep cycle alignment
- Melatonin window estimation (2h before habitual bedtime)
- Chronotype detection (Lion/Bear/Wolf/Dolphin via MCTQ methodology)
- Social jet lag calculation (weekday vs weekend sleep timing)
- Caffeine cutoff recommendation (8h before melatonin window)
- HRV-based recovery scoring (z-score vs 60-day baseline)
- Sleep Regularity Index (0-100, bedtime/wake consistency)
- Recovery Readiness (sleep 40% + HRV 40% + exercise load 20%)
- Workout-sleep correlation (Pearson coefficient + timing analysis)
- Wind-down routine timeline (7 steps timed to optimal bedtime)
- Process S/C continuous energy curve

### Fitness Analysis Engine
`src/main/services/health/fitness-analysis.ts`:
- Banister Impulse-Response Model: CTL (τ=42d fitness), ATL (τ=7d fatigue), TSB (form)
- TRIMP (Banister 1991 exponential HR weighting), EPOC from HR zones
- ACWR (sweet spot 0.8–1.3, >1.5 = injury risk), training status states
- Recovery scoring weighted across HRV z-score, RHR, sleep, training load
- Sleep recommendation auto-adjusts upward with weekly TRIMP

### Strava Integration
`src/main/services/health/strava.service.ts`:
- OAuth2 + activity sync; preferred over Health Auto Export workouts (`workout-merge.ts` dedups same sport / same day)
- `strava_streams` table stores second-by-second HR, velocity, cadence, power, grade, altitude
- Elevate-style metrics: HR zones, HRSS, year progression, best efforts, pace/cadence/power/grade zones, grade-adjusted pace (5th-order polynomial), estimated running power
- Settings: LTHR, FTP, activity ignore patterns (Health → Profile)
- IPC: `strava:syncStreams` for detailed stream backfill

### Composite Services
`src/main/services/composite/` cross-domain analysis:
- `readiness.service.ts` — daily readiness blending sleep, HRV, training load
- `energy-alignment.service.ts` — circadian energy vs scheduled tasks
- `correlation.service.ts` — Pearson/heatmap correlations across health + productivity signals

### Weekend Planner
- Fetches real events from Ticketmaster Discovery API
- 12 curated Chicago-area spots as fallback
- AI generates Saturday/Sunday itineraries considering: events, home location, commute, sleep debt, energy levels, preferences

### Restaurant Discovery
`src/main/services/weekend/restaurants.service.ts`:
- Google Places search + AI-powered restaurant research
- Save/rate/note restaurants, discover new ones via AI

### AI Skills
6 finance analysis skills at `src/main/ai/skills/finance/`:
- Earnings review, valuation, market research, technical analysis, risk assessment, sector comparison

4 briefing types: `morning_finance`, `market_research`, `health_weekly`, `morning_sleep`

## Database Tables (24 total, all inlined in `src/main/db/database.ts`)
**Finance**: `watchlist`, `price_history`, `news_articles`, `holdings`, `fundamentals`, `earnings_calendar`, `alerts`, `price_cache`
**Health**: `health_metrics`, `health_alerts`, `sync_checkpoints`
**Weekend**: `weekend_plans`, `weekend_map_cache`, `weekend_event_cache`, `saved_restaurants`, `restaurant_visits`
**AI / scheduler / chat**: `briefings`, `chat_messages`, `ai_activity_log`, `scheduler_activity_log`, `daily_schedule`
**Notion**: `notion_sync_log`, `notion_tasks`
**Infra**: `migrations`

Strava streams (`strava_streams`) and activities live separately — see Strava Integration section.

## Scheduled Jobs (node-cron, 7 total)
| Schedule | Job | Key |
|----------|-----|-----|
| Configurable (default 7:00) | Morning finance briefing | `morning-briefing` |
| Every 4 hours | Market data refresh | `market-refresh` |
| 22:30 | Evening health sync | `evening-health` |
| Every 30 min | Relay sync (desktop ↔ mobile) | `relay-sync` |
| Configurable (default 8:30) | Morning sleep briefing fallback | `morning-sleep-fallback` |
| Dynamic (melatonin window) | Wind-down reminder notification | `wind-down-reminder` |
| Sunday 9:00 | Weekly deep analysis | `weekly-analysis` |

## IPC Events (push from main → renderer)
| Event | Trigger |
|-------|---------|
| `health:sleep-data-arrived` | New sleep data imported via Health Auto Export |
| `health:wind-down` | Wind-down reminder fires |
| `briefing:new` | New briefing generated |
| `finance:updated` | Market data refreshed |

## Settings (stored in electron-store, typed via `AppSettings` interface)
**API keys**: Claude, Alpha Vantage, Ticketmaster, Google Places, Notion, Strava (OAuth)
**Relay**: URL, auth token
**YouTube**: channel list (Name|ChannelID per line)
**Health**: data path, server port; LTHR + FTP + activity ignore patterns for Strava
**Sleep**: goal hours, morning briefing toggle, fallback time, wind-down toggle, wind-down lead time
**Location**: home address, neighborhood, commute notes, transport mode
**Weekend**: city, radius, interests (per-day overrides)
**Schedule**: morning briefing time
**Notion**: API key, tasks DB ID, briefings DB ID, calendar DB ID
**UI**: scale/zoom level

## Build & Run
```bash
# Desktop
npm run dev          # development with hot reload
npm run build        # production build (outputs to out/)
npm run package      # electron-builder .exe installer — ALWAYS run `npm run build` first (package does not rebuild)
npm test             # Vitest unit tests
npm run typecheck    # tsc --noEmit (run by CI)
npm run lint         # eslint (run by CI)

# Mobile
cd mobile
npm start            # Expo dev server
npm run ios          # iOS simulator (macOS only)
npm run web          # web preview

# Relay Server
cd relay
node server.js                  # local network
TUNNEL=1 node server.js         # with Cloudflare tunnel
```

CI: `.github/workflows/ci.yml` runs typecheck + lint + test + build on every PR. `build-installer.yml` builds the Windows installer.

## UI Pages (Desktop, 14 total — under `src/renderer/pages/`)
1. **Dashboard** — summary cards, market snapshot, latest briefing, scheduler status
2. **Finance** — watchlist, price chart, AI analysis, news feed (Google News + YouTube)
3. **Portfolio** — holdings, cost basis (eyeball toggle to hide), allocation, sortable/filterable tables
4. **Saved** — saved restaurants / plans / artifacts library
5. **Health** — sleep quality scores, sleep debt gauge, sleep stages, circadian energy timeline, optimal times, wake/bedtime calculator, recovery readiness, sleep regularity, wind-down routine, morning briefing, HR/HRV/steps, AI insights
6. **Sleep Detail** — full sleep history with trend lines, efficiency chart, quality score history, bedtime/wake chart, workout impact, wind-down routine, stage analysis, nightly log with filters
7. **HRV Detail** — HRV history and recovery trends
8. **Heart Rate Detail** — HR history, resting HR, daily log
9. **Exercise Detail** — 5-tab fitness dashboard (Overview, Training Science, Heart & Recovery, Sleep vs Fitness, Activity Log) — Strava-backed
10. **Productivity** — day timeline, Notion tasks, briefings
11. **Weekend** — AI itinerary planner, event listings, restaurant discovery, location info, per-day settings
12. **Chat** — streaming Claude chat with portfolio/health context
13. **Settings** — all configuration (API keys, relay, YouTube, health, sleep, location, weekend, Notion, Strava, LTHR/FTP, UI scale)
14. **_DevCharts** — internal chart playground (dev only)

## Mobile Screens (12 total)
Dashboard, Portfolio, StockDetail, MarketPulse, Health, Productivity, Weekend, SavedPlans, PlanDetail, ActivityDetail, Chat, Settings

## Mobile Notifications
- **Sleep routine reminders** via `expo-notifications`: dim lights, stop screens, shower, lights out
- Scheduled daily based on circadian analysis from last 14 nights
- Toggle in Settings → Sleep & Notifications
- Auto-scheduled on app launch if enabled

## Logo
Noodle icon SVG at `resources/icon.svg`, ICO at `resources/icon.ico`, and React component at `src/renderer/components/icons/BreadLogo.tsx` (name is legacy)
Desktop shortcut: `scripts/launch.vbs` (launches `npm run dev` without terminal window)

## Conventions
- **No silent error swallowing** — surface failures via toast notifications (see `src/renderer/components/Toast.tsx`); errors at the IPC boundary already flow through `safe-handle.ts`
- **Strict types** — no `as any` casts; `AppSettings` and `WindowAPI` are fully typed
- **Accessibility** — clickable non-buttons need keyboard handlers; modals get ARIA attributes
- **Notion DB location** — primary SQLite lives at `%APPDATA%/mien/mien.db` on Windows (`app.getPath('userData')` on macOS/Linux; the `mien.db` at project root is empty). better-sqlite3 is compiled for Electron's Node, so query externally with Python's `sqlite3`, not system Node
