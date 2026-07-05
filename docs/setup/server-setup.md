# Server Computer Setup Guide

How to set up the always-on server computer as the main backend for Mien. This server handles AI (Claude), health data relay, finance data fetching, news, and morning briefings — so the mobile app works even when the desktop PC is off.

## What You Need

- The server computer (always on, has Node.js 18+)
- Cloudflare Tunnel installed (`winget install cloudflare.cloudflared` on Windows, `brew install cloudflare/cloudflare/cloudflared` on Mac)
- A Claude Pro or Max subscription (for the OAuth token)

## Step 1: Clone or Pull the Repo

```bash
# First time:
git clone https://github.com/mien-bot/Mien.git
cd Mien

# Already cloned:
cd ~/Mien  # or wherever it lives
git pull
```

## Step 2: Get a Claude OAuth Token (lasts 1 year)

This is the token the relay uses to call the Claude API on your behalf.

```bash
# Install Claude Code CLI if you haven't
npm install -g @anthropic-ai/claude-code

# Generate a long-lived token
claude setup-token
```

It will print a token like `eyJhbGci...`. Copy the entire token.

### Save it so you don't have to paste it every time

**Mac/Linux** — add to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):
```bash
export CLAUDE_CODE_OAUTH_TOKEN="eyJhbGci...your-full-token..."
```
Then `source ~/.bashrc` (or restart terminal).

**Windows** — set as a system environment variable:
```powershell
# PowerShell (persists across reboots)
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN", "eyJhbGci...your-full-token...", "User")
```
Restart your terminal after setting this.

## Step 3: Start the Relay Server

```bash
cd Mien/relay

# With Cloudflare Tunnel (recommended — gives you a public URL):
TUNNEL=1 node server.js

# Windows PowerShell:
$env:TUNNEL="1"; node server.js
```

### First run output

```
  ========================================
  NEW AUTH TOKEN GENERATED
  ========================================
  Token: aBcDeFgHiJkLmNoPqRsTuVwXyZ...

  Mien Relay Server v3.0 (autonomous mode)
  Provider:  anthropic
  AI Auth:   oauth (eyJhbGci...)
  Port:      3456
  Auth:      Bearer token (see relay.key)
  Cron:      finance every 4h, briefing daily ~7:30 AM
  TUNNEL URL: https://random-words.trycloudflare.com
```

**Save these two things:**
1. **Auth Token** — from `relay.key` file (or the first-run output)
2. **Tunnel URL** — the `https://xxx.trycloudflare.com` URL

## Step 4: Configure Your Devices

### Mobile App (Settings screen)
| Field | Value |
|-------|-------|
| Relay URL | `https://random-words.trycloudflare.com` |
| Relay Token | The token from `relay.key` |

Tap **Test Connection** to verify.

### Desktop App (Settings screen)
Same relay URL and token. The desktop pushes all its data to the relay every 30 minutes.

### iPhone Shortcuts (Health Sync)
Update the URL in your existing shortcuts to use the new tunnel URL.

## Step 5: Keep It Running 24/7

### Option A: Auto-restart script (simplest)

**Mac/Linux:**
```bash
cd Mien/relay
chmod +x start.sh
TUNNEL=1 nohup ./start.sh &
# Survives terminal close, auto-restarts on crash
```

**Windows PowerShell:**
```powershell
cd Mien\relay
$env:TUNNEL="1"
Start-Process powershell -ArgumentList "-File", ".\start.ps1" -WindowStyle Hidden
```

### Option B: pm2 (auto-starts on boot)

```bash
npm install -g pm2

cd Mien/relay
TUNNEL=1 pm2 start server.js --name mien-relay
pm2 save
pm2 startup   # follow the printed command to enable auto-start on boot
```

Useful pm2 commands:
```bash
pm2 logs mien-relay     # view live logs
pm2 restart mien-relay  # restart
pm2 stop mien-relay     # stop
```

### Option C: Windows Task Scheduler

1. Open Task Scheduler
2. Create Task > Name: "Mien Relay"
3. General: "Run whether user is logged on or not"
4. Trigger: "At startup"
5. Action: Start a program
   - Program: `powershell.exe`
   - Arguments: `-File "C:\path\to\Mien\relay\start.ps1"`
   - Start in: `C:\path\to\Mien\relay`
6. Add environment variable `TUNNEL=1` in the start.ps1 or as system env var
7. Settings: "If the task fails, restart every 1 minute" (up to 3)

## What the Server Does Automatically

| Schedule | What | Source |
|----------|------|--------|
| Every 4 hours | Stock/ETF/crypto prices | Yahoo Finance + CoinGecko (free, no keys) |
| Every 4 hours | Finance news | Google News RSS (free) |
| Daily ~7:30 AM | Morning briefing | Claude API (via your OAuth token) |
| On startup | Refresh if data > 4h stale | All of the above |
| On demand | Health data | iPhone Shortcuts + Health Auto Export |

## When the Tunnel URL Changes

The free Cloudflare tunnel URL changes every time the server restarts. You'll need to update it in 3 places:

1. Mobile app Settings > Relay URL
2. Desktop app Settings > Relay URL
3. iPhone Shortcuts (the URL in your health sync shortcuts)

To avoid this, set up a **permanent tunnel** (requires a domain):
```bash
cloudflared tunnel login
cloudflared tunnel create mien
cloudflared tunnel route dns mien relay.yourdomain.com
# Then start with:
cloudflared tunnel run --url http://localhost:3456 mien
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "No credentials found" | Set `CLAUDE_CODE_OAUTH_TOKEN` env var (Step 2) |
| 401 from Claude API | Token expired — run `claude setup-token` again |
| Tunnel URL not showing | Is `cloudflared` installed? (`cloudflared --version`) |
| Phone can't connect | Tunnel URL changed — update in app Settings |
| No fresh prices on mobile | Check relay logs — watchlist might be empty (sync from desktop first) |
| No briefing generated | Need AI credentials + at least 1 watchlist symbol |

## Manual Triggers

Force a refresh from any device (or curl):

```bash
# Refresh prices and news now
curl -X POST https://YOUR-TUNNEL-URL/relay/refresh-finance \
  -H "Authorization: Bearer YOUR_TOKEN"

# Generate a briefing now
curl -X POST https://YOUR-TUNNEL-URL/relay/generate-briefing \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Quick Reference: Full Startup Sequence

```bash
# 1. Pull latest code
cd ~/Mien && git pull

# 2. Start the relay (with tunnel)
cd relay
TUNNEL=1 node server.js

# That's it. The server now:
#   - Proxies Claude API calls (for mobile + desktop chat)
#   - Stores and serves health data (from iPhone)
#   - Fetches stock prices every 4 hours
#   - Fetches news every 4 hours
#   - Generates a morning briefing daily
#   - Serves all data to mobile via /sync/pull-all
```
