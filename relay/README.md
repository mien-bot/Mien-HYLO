# Mien Relay Server

A second computer runs this relay server 24/7 behind a Cloudflare tunnel, acting as the bridge between the desktop app, mobile app, and Claude API. Eliminates the need for a direct API key on each client device.

## Architecture

```
iPhone (mobile app) ───→ Cloudflare Tunnel ───→ Server Computer ───→ Claude API (via OAuth)
Desktop (Electron) ────→ (relay URL) ──────────→ Health data sync
Health Auto Export ────→ Desktop:19876 ─────────→ Server (bidirectional sync)
```

### What the Server Does
1. **Claude API Proxy** — Attaches OAuth credentials from `~/.claude/.credentials.json`, forwards to `api.anthropic.com`
2. **Health Data Relay** — Stores and serves health metrics so mobile can pull data ingested on desktop
3. **Bidirectional Sync** — Desktop pushes every 30 min; mobile pulls on demand

## Quick Start

### 1. Install Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Cloudflare Tunnel** (for remote access):
  - Windows: `winget install cloudflare.cloudflared`
  - Mac: `brew install cloudflare/cloudflare/cloudflared`
  - Linux: `sudo apt install cloudflared`

### 2. Get a Claude Token

There are 3 ways to authenticate. **Only option A avoids disconnections.**

#### Option A: Setup Token (RECOMMENDED — lasts 1 year)

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
# Copy the token it prints, then:
CLAUDE_CODE_OAUTH_TOKEN=<paste-token-here> node server.js
```

Requires Claude Pro or Max subscription. Token lasts 1 year, no disconnections.

#### Option B: API Key (pay-per-token, never expires)

```bash
ANTHROPIC_API_KEY=sk-ant-your-key-here node server.js
```

#### Option C: CLI OAuth (free but disconnects every ~1 hour)

```bash
claude login
node server.js  # auto-detects token from ~/.claude/
```

**NOT recommended for a server** — expires hourly, auto-refresh is unreliable.

#### OpenAI / Codex Alternative

```bash
# API key:
OPENAI_API_KEY=sk-xxx AI_PROVIDER=openai node server.js

# Or Codex CLI OAuth:
codex login
AI_PROVIDER=openai node server.js
```

The relay auto-translates between Anthropic and OpenAI message formats.

### 3. Start the Server

```bash
# Local network only (same Wi-Fi):
cd relay
node server.js

# Remote access (different networks / cellular):
TUNNEL=1 node server.js
```

### 4. First Run Output

```
  ========================================
  NEW AUTH TOKEN GENERATED
  ========================================
  Token: aBcDeFgHiJkLmNoPqRsTuVwXyZ...

  Mien Relay Server v2.1
  Provider:  anthropic
  AI Auth:   oauth (eyJhbGci...)
  Port:      3456
  Auth:      Bearer token (see relay.key)
  TUNNEL URL: https://random-name.trycloudflare.com
```

Save the **auth token** — you need it for your phone and desktop.

### 5. Configure Your Devices

**Phone** (Mien app → Settings):
| Field | Value |
|-------|-------|
| Relay URL | `https://random-name.trycloudflare.com` |
| Relay Token | The token from `relay.key` |

Tap **Test Connection** to verify.

**Desktop** (Mien app → Settings): same fields. Desktop syncs health data bidirectionally every 30 min.

## Apple Shortcut (Health Sync)

Create a Shortcut called "Mien Sync":

1. **Find Health Samples** → Sleep Analysis, yesterday to now
2. **Find Health Samples** → Heart Rate, most recent 1
3. **Find Health Samples** → Step Count, today, group by day
4. **Get Contents of URL**:
   - URL: `https://YOUR-TUNNEL-URL/health/simple?sleep=[SLEEP]&hr=[HR]&steps=[STEPS]`
   - Method: POST
   - Header: `Authorization: Bearer YOUR_TOKEN`

Automate: Shortcuts → Automation → Time of Day → 7:30 AM → Daily → Run "Mien Sync"

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | Optional* | Health check (`{ status: "ok" }`) |
| POST | `/v1/messages` | Yes | Claude API proxy (Anthropic format) |
| POST | `/health/sync` | Yes | Push health metrics (JSON body) |
| POST | `/health/simple?sleep=420&hr=68` | Yes | Push health via query params |
| GET | `/health/data?type=sleep&days=14` | Yes | Pull health metrics |
| POST | `/health/cleanup` | Yes | Remove bad data entries |
| GET | `/sleep/analysis` | Yes | Pre-computed sleep analysis |
| GET | `/finance/prices` | Yes | Watchlist and price history |
| POST | `/sync/push` | Yes | Push bulk data from desktop |
| GET | `/sync/pull?days=14` | Yes | Pull all synced data |
| GET | `/strava/status` | Yes | Check Strava connection status |
| POST | `/strava/connect` | Yes | Start Strava OAuth (credentials from POST body, relay config, or env) |
| GET | `/strava/callback` | **No** | Strava OAuth callback (browser redirect) |
| POST | `/strava/disconnect` | Yes | Clear Strava tokens |
| POST | `/strava/sync?days=90&detail_limit=25&stream_limit=25` | Yes | Trigger Strava activity sync plus bounded detail/stream enrichment |
| GET | `/strava/streams?days=90` | Yes | Pull stored stream data for desktop analysis |

*Health check requires auth when tunnel is active.

## Strava Integration

The relay handles Strava OAuth and activity syncing. The desktop and mobile apps connect through the relay — no Strava credentials needed on client devices.

### Setup

1. **Create a Strava API app** at [strava.com/settings/api](https://www.strava.com/settings/api)
2. Set the **Authorization Callback Domain** to your relay domain (e.g. `relay.example.com`)
3. Save your Client ID and Client Secret on the server — either:

   **Option A: Config file** — create `relay/strava-config.json`:
   ```json
   {
     "clientId": "YOUR_CLIENT_ID",
     "clientSecret": "YOUR_CLIENT_SECRET"
   }
   ```

   **Option B: Environment variables** — add to `relay/.env`:
   ```
   STRAVA_CLIENT_ID=YOUR_CLIENT_ID
   STRAVA_CLIENT_SECRET=YOUR_CLIENT_SECRET
   ```

4. Restart the relay so it picks up the config
5. In the desktop app, go to Settings → Strava → **Connect Strava**. It opens your browser to authorize via the relay's callback URL.

Once connected, the relay syncs recent activities on startup and runs a daily safety-net sync. Manual syncs fetch summary workouts plus detailed activity fields and expanded stream data up to the requested limits.

Detailed Strava data is stored in:

- `strava-activity-details.json` for compact activity details, gear/map/device metadata, splits, laps, best efforts, segment efforts, and effort counts.
- `strava-streams.json` for normalized second-by-second streams used by route, moving, temperature, pace, cadence, power, grade, GAP, and best-split analysis.

## Keeping It Running 24/7

### Option 1: Auto-restart scripts (included)

**Mac / Linux:**
```bash
chmod +x start.sh
TUNNEL=1 ./start.sh              # foreground
nohup TUNNEL=1 ./start.sh &      # background
kill $(cat relay.pid)             # stop
```

**Windows (PowerShell):**
```powershell
$env:TUNNEL="1"; .\start.ps1                                              # foreground
Start-Process powershell -ArgumentList "-File", ".\start.ps1" -WindowStyle Hidden  # background
Get-Content relay.pid | ForEach-Object { Stop-Process -Id $_ }             # stop
```

### Option 2: pm2 (auto-start on boot)

```bash
npm install -g pm2
TUNNEL=1 pm2 start server.js --name mien-relay
pm2 save && pm2 startup
pm2 logs mien-relay    # view logs
pm2 restart mien-relay # restart
```

### Option 3: systemd (Linux)

Create `/etc/systemd/system/mien-relay.service`:
```ini
[Unit]
Description=Mien Relay Server
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/home/your-username/relay
Environment=TUNNEL=1
Environment=CLAUDE_CODE_OAUTH_TOKEN=your-token-here
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable mien-relay && sudo systemctl start mien-relay
```

### Option 4: Windows Task Scheduler

1. Create Task → "Mien Relay" → Run whether user is logged on or not
2. Trigger: At startup
3. Action: `powershell.exe -File "C:\path\to\relay\start.ps1"`
4. Settings: Restart every 1 minute on failure (up to 3 times)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `AI_PROVIDER` | `anthropic` | `anthropic` or `openai` |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | 1-year token from `claude setup-token` **(recommended)** |
| `ANTHROPIC_API_KEY` | — | Claude API key (pay-per-token) |
| `OPENAI_API_KEY` | — | OpenAI/Codex API key |
| `TUNNEL` | off | Set to `1` for Cloudflare Tunnel |
| `AUTH` | enabled | Set to `off` for local-only (not recommended remotely) |

`AUTH=off` is refused when `TUNNEL=1` is enabled. Public tunnels must use the relay bearer token.

## Authentication

- **OAuth Token**: `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
- **Relay Token**: auto-generated 256-bit key in `relay.key` (required for all requests)

## Security

| Layer | Protection |
|-------|-----------|
| HTTPS | Cloudflare encrypts all traffic end-to-end |
| Bearer Token | 256-bit random key, auto-generated, stored in `relay.key` |
| Rate Limiting | 200 req/min per IP |
| Zero Info Leak | Unauthenticated requests get 401 with no details |
| No Port Forwarding | Server is never directly exposed to the internet |

**Never commit `relay.key`** — it's in `.gitignore`.

## Permanent Tunnel URL

Free quick tunnels get a random URL that changes on restart. For a fixed URL:

```bash
cloudflared tunnel login
cloudflared tunnel create mien
cloudflared tunnel route dns mien relay.yourdomain.com
cloudflared tunnel run --url http://localhost:3456 mien
```

## Maintenance

### Checking Status
- `GET /health` — should return `{ "status": "ok" }`
- Heartbeat logs uptime and credential status every 10 minutes

### OAuth Token Refresh
If 401 errors, regenerate: `claude setup-token` → set `CLAUDE_CODE_OAUTH_TOKEN`.

### Updating Code
```bash
cd ~/Projects/Mien && git pull origin master && npm install
# Restart the relay server process
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "No credentials found" | Run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` |
| 401 from Claude API | Token expired — use `setup-token` (1 year) instead of CLI OAuth (~1 hour) |
| Server crashes randomly | Use `start.sh`/`start.ps1` for auto-restart, or pm2 |
| Tunnel not starting | Install cloudflared (see Prerequisites) |
| Random tunnel URL changed | Changes on restart. Use a named tunnel for permanent URL |
| Phone gets 401 | Token on phone doesn't match `relay.key` |
| Phone gets 403 | Wrong token value — copy from `relay.key` again |
| "Rate limited" | Wait 1 minute, or check for runaway automations |
| Server uses 100% CPU | Check `relay.log` for error loops; restart |

## Files

```
relay/
├── server.js        ← the server (zero dependencies)
├── package.json     ← metadata
├── start.sh         ← auto-restart launcher (Mac/Linux)
├── start.ps1        ← auto-restart launcher (Windows)
├── README.md        ← this file
├── relay.key        ← your secret token (auto-generated, DO NOT commit)
├── relay.log        ← server logs (created by start scripts)
├── relay.pid        ← launcher PID (created by start scripts)
└── health-data.json ← synced health data (auto-created)
```
