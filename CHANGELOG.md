# Changelog

## Unreleased

---

## v1.10.2 — 2026-07-05 — Public Safety & Build Reliability

- Protected the desktop health receiver with bearer authentication for LAN access; tokenless installs now bind to localhost only.
- Added request-size and query-range limits to health endpoints and hardened relay token comparison and webhook body handling.
- Blocked unsafe Electron navigation and external URL protocols, and enabled renderer sandboxing.
- Restored desktop renderer and main-process typechecks, including Recharts compatibility and weekend-plan guards.
- Fixed Electron health-file imports to use `webUtils.getPathForFile` and corrected the updater's applying state.
- Expanded `health:quick` to detect tracked credential/database files, high-confidence secret patterns, and desktop version drift.

---

## v1.10.0 — 2026-05-29 — Visual Glow-Up & Personalization

### Visual Overhaul (Desktop + Mobile)
- Cozy "late-night noodle bar" aesthetic: warm steam-lit background glow, gradient/elevated cards with a glassy highlight, and **Nunito** display font for titles, greetings, and big numbers (bundled locally — no runtime network).
- **Personalization:** 5 theme presets (Ramen, Midnight, Ocean, Matcha, Sakura), a custom accent color picker, a motion level toggle (Playful/Calm), and a display name. Desktop drives it via CSS custom properties + `data-theme`/`data-motion`; mobile via a new `ThemeContext`.
- **Motion:** staggered card entrances, count-up score numbers, gauge sweep-on-mount with an accent glow, card hover-lift, and a gradient area price chart. Mobile adds press-scale feedback, haptics, and an accent-themed tab bar. All motion respects the motion setting and OS reduce-motion.
- **Cozy touches:** time-of-day personalized greeting and a noodle-bowl avatar monogram over the accent gradient.
- Appearance controls added to desktop Settings → Display and a new Appearance group in mobile Settings.

### YouTube / Video Transcripts (in progress)
- Began wiring transcript fetching for finance videos (`video-transcript.service.ts`, `youtube-transcript.service.ts`) with related fetcher/news/AI service updates.

### Weekend Plan Mobile Sync
- Added a desktop **Save to Mobile** action on Weekend plans. It saves the current itinerary to `weekend_plans` and immediately runs relay sync so the mobile app can pull it into Saved Plans.

### Weekend Event Search
- Added event search focus chips and optional detail prompts on desktop and mobile.
- Event search results now auto-save to `weekend_event_cache` and sync through the relay between desktop and mobile.

---

## v1.8.0 — 2026-05-13 — Codebase Audit & Restaurant Autocomplete

### Codebase Audit
Full 5-agent parallel audit of the entire codebase (main process, services, renderer, mobile, relay+config). Verified all IPC wiring, imports, database schema, and API calls.

### Fixes
- **Model ID**: `claude-opus-4-7` (non-existent) → `claude-opus-4-6` across desktop, mobile, relay, docs
- **SettingsPage**: Removed ANSI artifact `claude-opus-4-7[1m]` from pricing table
- **Relay**: Removed dead OpenAI model mapping for `claude-sonnet-4-20250514`
- **Docs**: Fixed incorrect model ID references in CHANGELOG.md and the archived legacy changes log

### Restaurant Search Autocomplete
Typeahead suggestions as you type in the restaurant search field (desktop + mobile). Uses Google Places Autocomplete API with debounce, shows top 6 suggestions with name and address. Click/tap a suggestion to search.

---

## v1.7.1 — 2026-05-13 — Relay health-store merge fix (data-loss bug)

`/sync/push-all` on the relay was wholesale-replacing `healthData.metrics` with
whatever the desktop sent. The desktop sends **incrementally** (only rows whose
`imported_at` is newer than the last `health_metrics_all` checkpoint), so any
push after the first one would wipe the relay's health store — including any
HAE rows that landed directly on the relay since the previous desktop sync.

Symptom: `relay/health-data.json` would silently revert to `{"metrics":[]}`
shortly after a desktop sync cycle, even though HAE was actively pushing.

Fix: relay now merges incoming rows on top of the existing set, indexing by
`${type}:${date}`. Empty `health: []` payloads are explicit no-ops.

**File:** `relay/server.js` (the `/sync/push-all` handler). See `docs/sync.md`
under "Health-Data Preservation" for the full semantics.

---

## v1.7.0 — 2026-05-12 — Full Data Sync & Mobile Audit

### Full Desktop-to-Mobile Sync
All desktop data now syncs to mobile through the relay server. Previously only health metrics were synced.

- **What syncs**: watchlist, price_history (30d), news_articles (7d), briefings (14d), chat_messages (bidirectional, last 100), weekend_plans (30d), daily_schedule (14d), saved_restaurants (bidirectional), health_metrics (bidirectional)
- Architecture: Desktop `pushAllToRelay()` every 30 min → relay `sync-data.json` → Mobile `fullSyncFromRelay()` on pull-to-refresh
- Conflict resolution: `INSERT OR REPLACE` for date-keyed tables, `INSERT OR IGNORE` for append-only, merge by `place_id` for restaurants, dedup by `role+timestamp+content` for chat
- Mobile Settings: "Sync All Data from Desktop" button, Dashboard pull-to-refresh triggers full sync

### Mobile App Audit
Comprehensive bug fix pass across all screens:
- **Critical**: Missing `await` on async `parseSleepSessions()` in notifications — scheduled with garbage data
- **High**: Zero error handling in PortfolioScreen (`loadWatchlist`, `loadNews`, `handleAdd`), stuck refresh spinners (missing `finally`), invalid model ID
- **Medium**: `JSON.parse` without try/catch in render, undefined `.toFixed()` calls, empty array crashes, locked keychain crash
- Cleanup: removed dead PriceChart component, unused imports

**Files**: `relay/server.js`, `src/main/services/sync.service.ts`, `mobile/src/services/health-sync.service.ts`, `mobile/src/screens/SettingsScreen.tsx`, `mobile/src/screens/DashboardScreen.tsx`, plus 10 mobile bug fixes

---

## v1.6.0 — 2026-05-12 — Productivity Planner & Restaurant Database Enhancement

Two major feature additions spanning both the Electron desktop app and the React Native (Expo) mobile app:

### AI Daily Planner (Productivity)

Generates a time-blocked daily schedule tailored to the user's actual routine (wake 9am, work 9:30-6pm, projects until 1-2am). Focuses AI optimization on after-work hours since work hours are fixed.

- Interactive questionnaire: special events, after-work project blocks (HYLO, OVA, Photography, Mien, Reading, Study) with duration pickers, evening mode (6 options), exercise type
- Evening modes: Exercise + Work, Straight to Work, Relax, Hang out, Sleep early, Custom
- Timeline view with color-coded blocks (sleep=purple, exercise=green, work=amber, projects=blue)
- Notion export: pushes schedule blocks to Notion calendar database
- Mobile: full parity with new ProductivityScreen + Productivity tab in navigation

**Files**: `src/main/services/productivity/daily-planner.service.ts`, `src/renderer/pages/ProductivityPage.tsx`, `mobile/src/services/productivity.service.ts`, `mobile/src/screens/ProductivityScreen.tsx`

### Enhanced Restaurant Database

Transformed basic restaurant search into a full personal database with rich metadata.

- 9 new DB columns: venue_type, cuisine_category, spice_level, reservation_link, peak_times, description, visited, visit_date, personal_rating
- Manual entry form (no Google Places needed), venue type filtering (Restaurant/Bar/Cafe/Dessert/Fast Food)
- Dual rating: Google rating (read-only) + personal 5-star rating (auto-marks visited)
- AI research button: Claude with web search fills description, cuisine, price, peak times, booking info
- AI discover: suggests 5-8 restaurants matching a query, each addable to DB
- Mobile: enhanced SavedRestaurantCard with all new fields, manual add, filters, star rating

**Files**: `src/main/services/weekend/restaurants.service.ts`, `src/renderer/pages/WeekendPage.tsx`, `mobile/src/screens/WeekendScreen.tsx`, `mobile/src/services/restaurants.service.ts`

---

## v1.5.0 — 2026-05-12 — Sleep Tracking & Automation Enhancements

Comprehensive upgrade to sleep tracking across desktop and mobile.

### New Analysis Functions
- **Sleep Regularity Index (SRI)**: bedtime/wake consistency score 0-100 with circular variance
- **Recovery Readiness Score**: WHOOP/Oura-inspired composite (sleep quality 40%, HRV recovery 40%, exercise load 20%)
- **Workout-Sleep Correlation**: Pearson correlation, workout vs rest day comparison, best timing analysis
- **Batch Quality Scoring**: per-night scores for trend charting
- **Wind-Down Routine Timeline**: 7-step science-based routine dynamically timed from circadian analysis

### Morning Automation Pipeline
1. Health Auto Export sends sleep data via HTTP POST
2. Service detects sleep data, debounces (once/day)
3. Generates morning sleep briefing via Claude AI
4. Desktop notification + auto-refresh sleep UI
5. Fallback cron job if no data by configurable time (default 08:30)

### Mobile Notifications
4 daily push notifications timed to circadian rhythm: dim lights, put phone away, shower time, lights out. Uses expo-notifications with DAILY trigger.

### YouTube Finance Channels
Added default channels (Meet Kevin, Trading Fraternity, Andrei Jikh, Financial Education). Mobile YouTube RSS fetching added to news service.

### UI Enhancements
- Desktop Health page: Recovery Readiness card, Sleep Regularity card, Wind-Down Routine card, Morning Sleep Briefing card
- Desktop Sleep Detail: efficiency chart (85% target line), quality score history, workout impact, wind-down grid
- New IPC handlers: `health:getRecoveryReadiness`, `health:getSleepCorrelations`, `health:getSleepQualityHistory`, `health:getSleepRegularity`, `health:getWindDownRoutine`

---

## v1.4.0 — 2026-05-12 — Weekend Planner Enhancements

### Editable Event Times
Activity times in weekend plan are clickable to edit inline. Updated times persist in Notion/image export.

### Restaurant Discovery (Desktop)
Ported from mobile to desktop Electron app. Google Places Text Search, save/remove favorites, booking advance heuristic, extended fields (venue type, cuisine, spice, reservation link, peak times, personal rating).

### Event Detail Modal
Click events to open detail modal with distance from home (Google Distance Matrix API — driving, transit, walking modes). Quick actions: View Listing, Open in Maps.

### Schedule Image Export
Polished PNG export (900px wide, 2x retina). Deep gradient background, card-style day sections, timeline visualization, activity metadata, "Generated by Mien" footer. Downloads as `weekend-plan-{date}.png`.

**New service**: `src/main/services/weekend/distance.service.ts` (Google Distance Matrix API)

---

## v1.3.0 — 2026-05-11 — Workouts, Exercise Page, YouTube, Bug Fixes

### Workout Data Parsing
- Health Auto Export sends workouts under `data.workouts` (separate from `data.metrics`)
- Workouts grouped by date, stored as `{ workouts: [...] }` with `metric_type = 'workout'`
- Each workout: name, duration, calories, distance, stepCount, start/end, avgHR, maxHR, source

### Exercise & Activity Detail Page
- New page at `/health/exercise` with steps, active energy, exercise time, workout data
- Three charts: Daily Steps (10k goal), Active Calories, Exercise Minutes
- Workouts log table + daily activity log
- Range selector: 7D, 14D, 30D, 90D, 1Y, All

### YouTube Fetcher Rewrite
- Replaced `rss-parser` with native fetch + custom Atom XML regex parser
- Chrome User-Agent header (YouTube returns 404 without it)
- Descriptions from `<media:description>` tags, promo links filtered
- Dedicated refresh button + IPC (`finance:refreshYoutube`)

### Sleep Data Display Fixes
- 1Y range option, "All" loads up to 3000 days
- Skip gap-filling for ranges >90 days
- Sleep score reads `totalAsleep` first (was falling through to `asleep` = 0)
- Bedtime/wake time properly formats ISO timestamps

### Other Fixes
- Steps: `Math.round()` before `toLocaleString()` — no fractional steps
- AI service: restored relay-first priority
- Desktop shortcut with noodle icon via `scripts/launch.vbs`

---

## v1.2.1 — 2026-05-11 — Black Screen Fix

### Problem
After adding YouTube refresh button, app displayed black screen. React never mounted.

### Root Cause
`FinancePage.tsx` imported `Youtube` from `lucide-react` — this export doesn't exist in the installed version. Entire renderer bundle failed to compile silently (Vite dev server didn't report it clearly).

### Fix
Replaced `Youtube` with `Play` from lucide-react. Lesson: run `npx electron-vite build` to surface import errors.

---

## v1.2.0 — 2026-05-11 — Health Auto Export Integration & Trends

### Health Auto Export Setup
- REST API: `<tunnel-url>/health/auto-export` with Bearer token auth
- Async response (HTTP 202) — fixes Cloudflare 524 timeouts on large payloads
- Date normalization: HAE sends `"YYYY-MM-DD HH:MM:SS -TZ"`, parsed via `slice(0,10)`
- Daily aggregation: SUM for steps/energy/exercise, AVG for HR/HRV/SpO2
- Sleep stage parsing: two-pass approach (leaf stages vs broad "Asleep") prevents double-counting
- `qty` in hours (not minutes) — multiply by 60
- Post-import cleanup collapsed 1,227,720 → 1,113 records
- 19 supported metric types (sleep, HR, HRV, steps, energy, SpO2, VO2max, etc.)

### Historical Trends Analysis
- Monthly aggregates for all metric types (up to 36 months)
- Mobile trends tab: summary banner, auto-computed insights, monthly bar charts
- Insight engine: sleep duration, deep sleep, HRV, resting HR, activity trend detection

### Bug Fixes
- 524 Cloudflare timeout (async response)
- Sleep double-counting (two-pass parsing)
- Sleep qty units (hours → minutes)
- Date format mismatch (HAE format vs ISO)
- Model ID fixed to valid `claude-sonnet-4-6`

---

## v1.1.0 — 2026-05 — Mobile App Enhancements

### Health Screen Rewrite
- Removed HealthKit/Apple Watch references (data via Health Auto Export → Relay)
- 3 tabs: Overview (sleep quality, debt gauge, vitals), Analysis (chronotype, optimal times, social jet lag), Energy (Borbely Two-Process Model curve)
- Custom chart components built with Views (no charting library)

### Sleep Analysis Engine (Mobile)
- Full port of desktop sleep analysis (~480 lines): `parseSleepSessions`, `calculateSleepDebt`, `predictCircadianRhythm`, `scoreSleepQuality`, `recommendWakeTime`, `detectChronotype`, `calculateSocialJetLag`, `calculateCaffeineCutoff`, `calculateHrvRecovery`, `calculateEnergyCurve`

### Portfolio Screen Rewrite
- Watchlist/News tab selector, Sparkline component, PriceChart, news articles
- CoinGecko crypto prices (16 common symbols mapped)

### Restaurant Feature (Mobile)
- Google Places API integration, save/remove favorites, booking advance heuristic
- Deep link openers: OpenTable, Resy, Yelp, Google Maps
- Saved restaurants injected into AI weekend planner prompt

### Notion Integration (Mobile)
- Direct Notion API client for tasks, database listing, weekend push, briefing push

---

## v1.0.1 — 2025-05-11 — Relay Server Hardening, Mobile Bug Fixes

### Relay Server v2.1
- Credential refresh every 30 minutes, heartbeat logging every 10 minutes
- Connection tracking, uncaught exception handling, keep-alive timeouts (65s/66s)
- Auto-restart scripts: `start.sh` (Mac/Linux) and `start.ps1` (Windows) with exponential backoff

### Mobile Bug Fixes
- PortfolioScreen: null-coalesce `price`/`changePercent` before `.toFixed()`
- Chat: React Native fetch doesn't support `ReadableStream.getReader()` — falls back to non-streaming

### Apple Shortcuts Health Sync
5 shortcuts (Get Sleep/HR/Steps/HRV, Mien Sync orchestrator) with daily 9:00 PM automation.

---

## v1.0.0 — 2025-05-10 — Technical Analysis, Bug Fixes, Performance, UI Polish, Mobile Parity

### Technical Analysis Engine
- RSI (14-period), SMA (20/50), EMA (12/26), MACD (12/26/9), Bollinger Bands, ATR, Support/Resistance
- All computed locally from stored OHLCV data — no external API calls

### Portfolio Risk Analytics
- Annualized volatility, Pearson correlation, Beta vs SPY, max drawdown, Herfindahl index

### 3 AI Finance Skills
- Technical Analysis, Risk Assessment, Sector Comparison (benchmarks vs SPY/QQQ)

### Bug Fixes
- Sleep analysis: circular variance, Friday weekend classification, awakeTime denominator
- Notion sync: `INSERT OR IGNORE` preserves local data
- AI chat: error messages no longer saved to history
- Settings merge with defaults instead of overwriting

### Performance
- 5 database indexes on hot query paths
- MACD: O(n²) → O(n) with iterative EMA
- Cached Anthropic client with settings-key invalidation

### UI Polish
- Chart time range selector (7d/30d/90d/1Y), technical indicators bar
- 6 finance skill buttons, live clock, stream cancel button
- Confirm-to-delete (double-click within 3s), clickable event links

### Mobile Parity
- HealthKit sync, chat context with portfolio/health, dynamic city for weekend planner
- CoinGecko crypto prices

### Dead Code Cleanup
- Deleted: `alphavantage.fetcher.ts`, `001_initial.sql`
- Removed unused exports from `useHealthData.ts`, `health-sync.service.ts`
