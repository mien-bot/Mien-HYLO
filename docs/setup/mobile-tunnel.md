# Mobile App — Tunnel Setup Guide

## What's running today

The phone connects to the Expo Metro dev bundler over a **named Cloudflare
tunnel**, not ngrok. The same tunnel that exposes `relay.example.com`
(Mien relay) also exposes `metro.example.com` (Expo Metro) via a second
ingress rule. Stable URL, your own domain, no rate limits, no ngrok
account.

| Hostname | Routes to | Purpose |
|---|---|---|
| `https://relay.example.com` | `localhost:3456` | Mien relay (AI + data sync, always-on) |
| `https://metro.example.com` | `localhost:8081` | Expo Metro dev bundler (only while developing) |

Both ride the same `cloudflared tunnel run mien` process, supervised by
the `MienTunnel` Windows Task Scheduler entry.

## To connect the phone (one-time per Expo Go install)

1. **Start Expo**:
   ```bash
   cd mobile
   npx expo start --clear
   ```
   `mobile/.env` is committed; it tells Metro to publish its manifest as
   `https://metro.example.com` (no port, HTTPS) instead of the LAN-style
   `host:8081`. Without that, the bundle URL the phone reads from the
   manifest will fail through the tunnel.

2. **On the phone, open iOS Camera and scan `expo-qr.png`** at the
   repo root. The QR encodes `https://relay.example.com/expo`.

3. iOS Camera shows a yellow banner "Open in Safari" — tap it. Safari
   briefly loads the relay's `/expo` page, which auto-redirects to
   `exps://metro.example.com` via meta-refresh.

4. iOS prompts "Open in Expo Go?" — tap Open. Expo Go fetches the
   manifest from `https://metro.example.com/`, then the bundle, then runs
   the app.

After the first connect, the URL appears in Expo Go's "Recently visited"
list — subsequent sessions are one-tap.

### Why this flow has so many redirects

iOS Camera only offers a quick-action banner for URL schemes it
recognizes. Expo Go registers `exps://` (and on newer builds
`exp+https://`), but iOS Camera will not surface those schemes in the
banner — they're considered too obscure for the system-level UI. The
workaround:

1. Camera scans a plain `https://` URL (universally surfaced).
2. Safari runs the URL.
3. The page redirects to the registered Expo Go scheme.
4. iOS recognizes the scheme handoff and prompts.

The `GET /expo` handler in `relay/server.js` is what performs step 3.
It's public (no bearer token) and only serves an HTML meta-refresh +
JS fallback.

## To regenerate the QR

```bash
npx --yes --package=qrcode -- qrcode -o expo-qr.png -s 20 -m 4 "https://relay.example.com/expo"
```

The QR is gitignored (it's a local artifact); the URL it encodes is
stable as long as the `metro.example.com` ingress rule stays put.

## To restart everything

```powershell
# 1. Cloudflare tunnel (both ingresses ride this)
Stop-ScheduledTask -TaskName MienTunnel
Start-ScheduledTask -TaskName MienTunnel

# 2. Mien relay (only needed if relay/server.js changed)
Stop-ScheduledTask -TaskName MienRelay
Start-ScheduledTask -TaskName MienRelay

# 3. Expo Metro (not a service — just run in a terminal)
cd mobile
npx expo start --clear
```

## To add a new hostname to the tunnel later

```yaml
# %USERPROFILE%.cloudflared\config.yml
ingress:
  - hostname: relay.example.com
    service: http://localhost:3456
  - hostname: metro.example.com
    service: http://localhost:8081
  - hostname: <new>.example.com        # add here
    service: http://localhost:<port>
  - service: http_status:404         # keep this last
```

Then:
```bash
cloudflared tunnel route dns mien <new>.example.com
# Restart MienTunnel to reload config.
```

## Fallback paths if the tunnel is down

| Situation | Use |
|---|---|
| Phone is on same Wi-Fi as the PC | LAN URL `exp://<PC-LAN-IP>:8081` in Expo Go |
| Cloudflare itself is having an outage | `npx expo start --tunnel` (Expo's ngrok integration — flaky on Windows but works as a one-off) |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Phone error `http://metro.example.com:8081/...` | `mobile/.env` not loaded by Metro | confirm `mobile/.env` exists; restart `expo start` |
| Safari: "cannot launch, link invalid" | Expo Go doesn't register `exps://` on this device | the `/expo` redirect now uses `exps://` (older scheme); update Expo Go if still broken |
| `runtime not ready` on bundle load | Native module mismatch with Expo Go binary | `cd mobile && npx expo install --fix`, restart Metro |
| iOS Camera no banner appears | URL scheme not registered by Expo Go | use Expo Go's home-screen "Enter URL manually" with `https://metro.example.com` instead |
| `ngrok tunnel took too long to connect` | Used `--tunnel` flag, which invokes ngrok instead of the Cloudflare tunnel | don't use `--tunnel`; just run `npx expo start --clear` — the `mobile/.env` + `MienTunnel` handle everything |
