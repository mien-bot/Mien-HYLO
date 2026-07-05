# Mien Mobile — Setup Guide

## Prerequisites

- iPhone with **Expo Go** installed (free from App Store)
- PC running Windows (relay server + Expo dev server)
- Claude CLI logged in (`claude login` — uses OAuth, no API key needed)

## 1. Start the Relay Server

The relay server proxies AI requests using your Claude CLI OAuth token so your phone doesn't need any API key.

```bash
cd relay
TUNNEL=1 node server.js
```

The relay auto-detects your Claude CLI OAuth credentials from `~/.claude/`.

On first run, it generates a **relay token** saved to `relay/relay.key`. Copy this token — you'll need it for the mobile app.

The terminal will show:
```
Mien Relay Server v2.0

Provider:  anthropic
AI Auth:   oauth (eyJhbGci...)
Port:      3456
Tunnel:    Cloudflare (starting...)

TUNNEL URL: https://xxxxx.trycloudflare.com
```

**Important:** The tunnel URL changes every time you restart. Update it in your phone's Settings when it changes.

### If AI Auth shows "No credentials found"

Make sure you're logged into Claude CLI:
```bash
claude login
```

Then restart the relay server.

## 2. Start the Expo Dev Server

In a separate terminal:

```bash
cd mobile
npx expo start --tunnel
```

This starts Metro bundler with a tunnel so your phone can connect from any network.

## 3. Connect Your Phone

1. Open **Expo Go** on your iPhone
2. The project should appear automatically, or scan the QR code from the terminal
3. Your phone does NOT need to be on the same Wi-Fi (tunnel mode handles this)

## 4. Configure Mobile App Settings

In the app, go to **Settings** and enter:

| Setting | Value |
|---------|-------|
| Relay URL | The `https://xxxxx.trycloudflare.com` URL from step 1 |
| Relay Token | The token from `relay/relay.key` |

Leave the Claude API key field **empty** — relay mode handles auth.

## Troubleshooting

### 401 "Invalid authentication credentials"
- The Claude CLI OAuth token may be expired
- Fix: run `claude login` again, then restart the relay server

### 403 "Invalid token"
- The relay token in your phone Settings doesn't match `relay/relay.key`
- Open `relay/relay.key`, copy the token, paste it into Settings > Relay Token

### 429 "Rate limited"
- Too many requests in a short time (limit: 200/min)
- Wait a minute and try again

### JSON Parse error
- Usually means the relay server is down or the tunnel URL changed
- Check that both the relay server and Cloudflare tunnel are running

### App won't load in Expo Go
- Make sure `npx expo start --tunnel` is running on your PC
- Your PC must stay on — Expo Go streams the app from the dev server
- If the tunnel URL expired, restart with `npx expo start --tunnel`

## Limitations

- **Expo Go requires your PC to be running.** There is no free way to make a standalone iOS app without an Apple Developer account ($99/year).
- **Tunnel URLs change on restart.** Update the Relay URL in Settings each time.
- **OAuth tokens expire.** If you get 401 errors, run `claude login` and restart the relay.
- **Relay server must be running** for AI features (chat, sleep suggestions, portfolio analysis, weekend planning).

## Quick Start (Both Servers)

Run in two separate terminals:

```bash
# Terminal 1 — Relay (uses Claude CLI OAuth automatically)
cd relay && TUNNEL=1 node server.js

# Terminal 2 — Expo
cd mobile && npx expo start --tunnel
```
