# Mien — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    External Data Sources                     │
│  Yahoo Finance  CoinGecko  AlphaVantage  News RSS  Ticketmaster │
│  Health Auto Export (iPhone)  Notion API  Claude API         │
└──────────┬──────────────────────────────────┬───────────────┘
           │                                  │
     ┌─────▼─────────────────────┐   ┌───────▼────────┐
     │   Electron Main Process   │   │   Mobile App   │
     │                           │   │   (Expo/RN)    │
     │  ┌──────────────────┐     │   │                │
     │  │   Scheduler      │     │   │  Claude API    │
     │  │   (node-cron)    │     │   │  expo-sqlite   │
     │  └──────┬───────────┘     │   │  SecureStore   │
     │         │                 │   └───────┬────────┘
     │  ┌──────▼───────────┐     │           │
     │  │   Services       │     │     ┌─────▼──────┐
     │  │  ├── Finance     │     │     │  Screens   │
     │  │  ├── Health      │     │     │ Dashboard  │
     │  │  │   └── Sleep   │     │     │ Health     │
     │  │  │       Analysis│     │     │ Weekend    │
     │  │  ├── Weekend     │     │     │ Chat       │
     │  │  ├── Notion      │     │     │ Settings   │
     │  │  ├── AI          │     │     └────────────┘
     │  │  └── Productivity│     │
     │  └──────┬───────────┘     │
     │         │                 │
     │  ┌──────▼───────────┐     │
     │  │   SQLite (WAL)   │     │
     │  │   better-sqlite3 │     │
     │  └──────────────────┘     │
     │         │                 │
     │  ┌──────▼───────────┐     │
     │  │  IPC Bridge      │     │
     │  │  (contextBridge) │     │
     │  └──────┬───────────┘     │
     │         │                 │
     └─────────┼─────────────────┘
               │
     ┌─────────▼─────────────────┐
     │   Electron Renderer       │
     │   (React 19 + Tailwind)   │
     │                           │
     │   7 Pages:                │
     │   Dashboard | Finance     │
     │   Health | Productivity   │
     │   Weekend | Chat          │
     │   Settings                │
     └───────────────────────────┘
```

## Data Flow

### Finance Pipeline
```
Yahoo/CoinGecko/AlphaVantage → Fetchers → price_history table
                                        → getLatestPricesLive() → UI
Google News RSS → news_articles table → UI
All data + Claude API → Finance Briefing → briefings table → Notion
```

### Health Pipeline
```
Health Auto Export (iPhone)
  → HTTP POST to localhost:19876  ─┐
  → File watcher (JSON/CSV)       ├→ health_metrics table
  → Manual import                 ─┘
                                    │
health_metrics → parseSleepSessions() → Sleep Analysis Engine
                                        ├── calculateSleepDebt()
                                        ├── predictCircadianRhythm()
                                        ├── scoreSleepQuality()
                                        ├── recommendWakeTime()
                                        └── buildSleepAnalysisContext() → AI prompts
```

### Weekend Planning Pipeline
```
Ticketmaster API → fetchTicketmasterEvents() ─┐
Curated spots → getCuratedChicagoSpots()      ├→ allEvents
                                               │
Settings (home, commute, transport) ───────────┤
Sleep analysis context ────────────────────────┤
User preferences ──────────────────────────────┤
                                               │
All context → Claude AI → Weekend Itinerary → weekend_plans table → UI
```

### Daily Schedule Pipeline
```
Sleep analysis (energy phases) ─┐
HRV / recovery data ───────────┤
Market data ────────────────────┤→ Claude AI → daily_schedule table → UI
Notion tasks ───────────────────┤
Latest briefing ────────────────┘
```

## Sleep Analysis Model

Based on the Two-Process Model of sleep regulation (Borbély 1982):

**Process S (Homeostatic Sleep Drive)**
- Accumulates during waking, dissipates during sleep
- Modeled via sleep debt: 14-night rolling window
- Last night = 15% weight, remaining 85% with exponential decay

**Process C (Circadian Rhythm)**
- ~24-hour biological clock
- Melatonin window: 2h before habitual bedtime
- 5 energy phases predicted from habitual sleep/wake times:
  1. Sleep Inertia (wake → wake+1.5h): Low energy, avoid decisions
  2. Morning Peak (wake+1.5h → wake+5h): Highest cognitive performance
  3. Afternoon Dip (wake+5h → wake+8h): Natural energy valley
  4. Evening Peak (wake+8h → wake+12h): Second cognitive peak
  5. Wind Down (wake+12h → bedtime): Melatonin rising

**Sleep Quality Scoring** (0-100 each, equal weight):
- Deep sleep: target 15-23% of total sleep
- REM: target 20-25% of total sleep
- Efficiency: target 85%+ (time asleep / time in bed)
- Consistency: bedtime variance across 7 days

**Wake Time Optimization**
- Aligns with 90-min sleep cycle endings (REM phase completion)
- Recommends 4, 5, or 6 complete cycles from sleep onset

## File Map

### Desktop — Main Process
| File | Purpose |
|------|---------|
| `src/main/index.ts` | Electron app entry, window, tray |
| `src/main/ipc.ts` | All IPC handler registration |
| `src/main/preload.ts` | contextBridge API exposure |
| `src/main/lib/store.ts` | electron-store v11 ESM wrapper |
| `src/main/db/database.ts` | SQLite init + inline migrations |
| `src/main/services/ai.service.ts` | Claude API (streaming + one-shot) |
| `src/main/services/finance/*.ts` | Yahoo, CoinGecko, AlphaVantage, News |
| `src/main/services/health/health-export.service.ts` | Health data ingestion |
| `src/main/services/health/sleep-analysis.ts` | Sleep analysis engine |
| `src/main/services/weekend/events.fetcher.ts` | Ticketmaster + curated spots |
| `src/main/services/weekend/weekend-planner.service.ts` | AI weekend planner |
| `src/main/services/notion/notion.sync.ts` | Notion two-way sync |
| `src/main/services/productivity/daily-planner.service.ts` | AI daily scheduler |
| `src/main/services/scheduler.service.ts` | node-cron job orchestration |
| `src/main/ai/prompts.ts` | All AI prompt templates |
| `src/main/ai/briefing-generator.ts` | Briefing orchestrator |

### Desktop — Renderer
| File | Purpose |
|------|---------|
| `src/renderer/App.tsx` | Router with Shell layout |
| `src/renderer/pages/*.tsx` | 7 pages (Dashboard, Finance, Health, Productivity, Weekend, Chat, Settings) |
| `src/renderer/components/layout/` | Sidebar, TopBar, Shell |
| `src/renderer/components/finance/` | WatchlistTable, PriceChart, NewsPanel, AddSymbolForm |
| `src/renderer/components/health/` | SleepChart, HeartRateChart, MetricCard |
| `src/renderer/components/productivity/` | DayTimeline, TaskList |
| `src/renderer/components/icons/BreadLogo.tsx` | App logo (bread SVG) |
| `src/renderer/hooks/` | useFinanceData, useHealthData, useChat |

### Mobile
| File | Purpose |
|------|---------|
| `mobile/App.tsx` | Tab navigator |
| `mobile/src/screens/*.tsx` | Dashboard, Health, Weekend, Chat, Settings |
| `mobile/src/services/` | AI, Finance |
| `mobile/src/lib/` | Database (expo-sqlite), Storage (SecureStore), Theme |

### Shared
| File | Purpose |
|------|---------|
| `src/shared/types/ipc.types.ts` | TypeScript interfaces for all data models |
| `resources/icon.svg` | App icon (bread logo, 512x512) |
