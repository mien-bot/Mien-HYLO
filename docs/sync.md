# Data Sync — Desktop ↔ Mobile

## Overview

Mien uses a **relay server** as the bridge between the desktop Electron app and the mobile Expo app. The desktop pushes data to the relay, and the mobile pulls from it. The relay also accepts health data directly from Apple Shortcuts and Health Auto Export.

```
Health Auto Export (phone)
        │
        ▼
┌──────────────────┐       push every 30min       ┌──────────────────┐
│  Desktop (Electron) │ ──────────────────────────▶ │   Relay Server   │
│  SQLite (mien.db)   │ ◀────────────────────────── │   (Node.js)      │
│                      │       pull mobile data      │   Port 3456      │
└──────────────────┘                               └──────────────────┘
                                                           │  ▲
                                                     pull  │  │  push
                                                           ▼  │
                                                   ┌──────────────────┐
                                                   │  Mobile (Expo)    │
                                                   │  expo-sqlite      │
                                                   └──────────────────┘
```

## What Gets Synced

| Data | Direction | Scope |
|------|-----------|-------|
| Health metrics (sleep, HR, HRV, steps, etc.) | Desktop → Relay → Mobile | Last 3 years (1095 days) |
| Workout data | Desktop → Relay → Mobile | All available |
| Watchlist | Desktop → Relay → Mobile | All symbols |
| Price history | Desktop → Relay → Mobile | Last 30 days |
| News articles | Desktop → Relay → Mobile | Last 7 days (100 max) |
| Briefings | Desktop → Relay → Mobile | Last 14 days |
| Chat messages | Bidirectional | Last 100 messages |
| Weekend plans | Desktop → Relay → Mobile | Last 30 days |
| Daily schedules | Desktop → Relay → Mobile | Last 14 days |
| Saved restaurants | Bidirectional | All |
| Restaurant visit reviews | Bidirectional | All, keyed by restaurant + visit date |

## Setup

### 1. Start the Relay Server

On the server machine (the one that stays on):

```bash
cd relay
node server.js
```

On first run, it generates a **Bearer token** saved to `relay/relay.key`. Copy this token.

**Options:**

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | 3456 | Server port |
| `TUNNEL=1` | off | Enable Cloudflare Tunnel for public HTTPS |
| `AUTH=off` | on | Disable auth (local network only) |
| `ANTHROPIC_API_KEY` | — | Direct API key (alternative to OAuth) |

### 2. Configure Desktop App

In **Settings**, set:
- **Relay URL**: `http://<server-ip>:3456` (or the Cloudflare tunnel URL)
- **Relay Token**: The token from `relay.key`

### 3. Configure Mobile App

In **Settings**, set:
- **Relay URL**: Same URL as desktop
- **Relay Token**: Same token

Then tap **"Sync All Data from Desktop"** to pull everything.

## How Sync Works

### Automatic (Desktop)

The desktop scheduler runs `syncWithRelay()` **every 30 minutes**, which:

1. **Pushes health data** (last 14 days) to relay via `POST /health/sync`
2. **Pulls health data** from relay (e.g., data from Apple Shortcuts) via `GET /health/data?days=14`
3. **Pushes all tables** (watchlist, prices, news, briefings, chat, schedules, restaurants, restaurant reviews) via `POST /sync/push-all`
4. **Pulls mobile data** (restaurants, restaurant reviews, chat added on phone) via `GET /sync/pull-all`

### Manual (Mobile)

Tap **"Sync All Data from Desktop"** in Settings. This calls `fullSyncFromRelay()`, which:

1. Fetches `GET /sync/pull-all` from the relay
2. Merges all tables into the local expo-sqlite database using `INSERT OR REPLACE`
3. Pushes mobile-only data back via `POST /sync/push-mobile`

### Health Data Ingestion (Relay)

The relay also accepts health data directly:

| Endpoint | Method | Source | Description |
|----------|--------|--------|-------------|
| `/health/sync` | POST | Desktop / Apple Shortcuts | Array of `{type, date, value, source}` metrics |
| `/health/simple` | POST | Apple Shortcuts (flat) | Query params: `?sleep=420&hr=68&steps=8500` |
| `/health/auto-export` | POST | Health Auto Export app | Grouped metric samples |
| `/health/data` | GET | Mobile / Desktop | Pull stored health data (`?days=14`) |
| `/health/trends` | GET | Any | Monthly aggregated trends |
| `/health/cleanup` | POST | Any | Remove bad/outlier data |

## Relay Server Endpoints

### Sync Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync/push-all` | POST | Desktop pushes all table data |
| `/sync/pull-all` | GET | Mobile pulls all table data |
| `/sync/push-mobile` | POST | Mobile pushes restaurants, restaurant reviews, event cache, and chat back |
| `/sync/push` | POST | Legacy health-only push |
| `/sync/pull` | GET | Legacy health-only pull |

### AI Proxy

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Proxies to Claude API (streaming supported) |

The relay resolves Claude credentials in order:
1. `ANTHROPIC_API_KEY` environment variable
2. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
3. OAuth token from `~/.claude/credentials.json` (Claude CLI)

### Sleep Analysis

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sleep/analysis` | GET | Pre-computed sleep analysis from desktop |

## Data Storage on Relay

The relay stores data in two JSON files:

- **`relay/health-data.json`** — Health metrics received via `/health/sync`, `/health/simple`, `/health/auto-export`, and merged from desktop's `/sync/push-all`
- **`relay/sync-data.json`** — All table data from desktop (watchlist, prices, news, briefings, chat, schedules, restaurants)

These are plain JSON files, not a database. They act as a temporary staging area between desktop and mobile.

## Health-Data Preservation (Merge Semantics)

The desktop's `pushAllToRelay()` sends health rows **incrementally** — only rows whose
`imported_at` is newer than the last `health_metrics_all` checkpoint (see
`src/main/services/sync.service.ts`). The relay must therefore **merge** the incoming
rows on top of what's already stored, *not* wholesale-replace, otherwise:

- HAE-only rows pushed directly to `/health/auto-export` between desktop syncs
  would be wiped.
- Older history (before the desktop's last checkpoint) would disappear from the
  relay as soon as the desktop did its next incremental push.

The relay enforces this in `/sync/push-all` by indexing existing rows by
`${type}:${date}` and overlaying the incoming list. Empty `health: []` arrays are
explicitly no-ops — they never reduce the stored set.

If you ever do need to wipe and re-seed the relay's health store, do it directly
on the file:

```bash
echo '{"metrics":[]}' > relay/health-data.json
# then restart the relay so the in-memory copy is reloaded
```

## Security

- **Bearer token auth** — Auto-generated 32-byte random token on first run
- **Rate limiting** — 200 requests/minute per IP
- **Cloudflare Tunnel** — Optional public HTTPS without port forwarding (`TUNNEL=1`)
- Auth can be disabled for local-only networks (`AUTH=off`), but this is not recommended for remote access

## Data Validation

Both the desktop pull and the relay cleanup endpoint filter bad data:

- HRV: reject > 300ms or ≤ 0
- SpO2: reject > 100% or < 50%
- Heart rate: reject > 220 or ≤ 0
- Sleep: reject ≤ 1 minute or > 14 hours
- Steps: reject < 10
- Active energy: reject < 1
- Zero-value metrics filtered for: basal energy, distance, exercise time, flights climbed, daylight

## Troubleshooting

**"No relay URL configured"**
→ Set the relay URL in Settings on both desktop and mobile.

**"Invalid token"**
→ Check that the token in Settings matches `relay/relay.key` on the server.

**Desktop not pushing**
→ The scheduler pushes every 30 minutes. Check `scheduler.lastRun.relay-sync` in electron-store, or restart the desktop app.

**Mobile shows "Up to date" but no data**
→ The desktop needs to push first. Make sure the desktop app has been running with the relay URL configured.

**Health data not appearing after export**
→ Health Auto Export can be pointed at *either* the desktop's local health server
(`http://<desktop-ip>:19876/health/auto-export`) or the relay
(`https://<your-relay-host>/health/auto-export`). Local-network is real-time;
the relay path costs up to ~30 min latency because desktop only pulls from
the relay on its scheduler tick. Use the relay path when the phone is off-LAN.

**Relay's health store suddenly empty after a successful sync**
→ Pre-fix bug: `/sync/push-all` did a wholesale replace instead of a merge, so
an incremental empty push from desktop would wipe the whole store. Fixed in
`relay/server.js` — see "Health-Data Preservation" above. If you're seeing this
on an older relay binary, restart the relay against the current `server.js`.
