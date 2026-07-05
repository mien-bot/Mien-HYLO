# How Mien works, in plain language

This is the "I just want to understand the moving parts" guide. It explains where your data lives, how the relay and tunnels fit in, how two computers stay in sync, and what someone needs to do to run their own copy.

If you want install steps, those are in [SETUP.md](./SETUP.md) (or [work PC setup](./docs/setup/install-work-pc.md) for locked-down machines). This file is the mental model behind those steps.

---

## The big picture

```
   ┌──────────────────┐               ┌──────────────────┐
   │  Your iPhone     │               │  Your work PC    │
   │  (Health Auto    │               │  (Mien desktop)  │
   │   Export)        │               │                  │
   └────────┬─────────┘               └────────┬─────────┘
            │ POST health data                  │ GET briefings, sleep, etc.
            │ over the internet                 │ POST new chat messages
            ▼                                   ▼
   ┌──────────────────────────────────────────────┐
   │           Cloudflare tunnel                       │
   │  https://your-domain.com  →  localhost:3456       │
   └──────────────────────────┬───────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────┐
   │     Home machine (always-on)                      │
   │                                                   │
   │   relay/server.js (Node, port 3456)               │
   │   ├── health-data.json    (Apple Health)          │
   │   ├── sync-data.json      (briefings, chat, etc.) │
   │   ├── relay.key           (the shared password)   │
   │   └── tunnel-url.txt      (only if TUNNEL=1)      │
   │                                                   │
   └──────────────────────────┬───────────────────┘
                            │ HTTPS to api.anthropic.com
                            ▼
                       ┌──────────┐
                       │  Claude  │
                       └──────────┘
```

Three players: your iPhone (writes health data), your desktop clients (read and add their own data), and the relay (a small server in the middle that everyone reads from / writes to). The relay is also the only thing that talks to Claude.

---

## The relay: what it actually is

The relay is `relay/server.js` — a ~2000-line Node program. You run it once with:

```bash
cd Mien/relay
node server.js
```

It opens **port 3456** on whatever machine you run it on (your home laptop, a Raspberry Pi, whatever) and listens for HTTP requests. It does three jobs:

1. **Stores data on disk.** Two JSON files next to `server.js`:
   - `health-data.json` — every sleep, heart-rate, HRV, steps, etc. metric from your phone.
   - `sync-data.json` — your watchlist, prices, news, briefings, chat history, weekend plans, daily schedule, saved restaurants.
   - That's it. No database, no cloud, no third party. Just two JSON files.
2. **Proxies AI requests.** When the desktop clicks "Generate plan" or sends a chat message, the request goes `desktop → relay → api.anthropic.com → relay → desktop`. The relay is the only place that talks to Claude — your desktop never does directly.
3. **Serves cached data.** Any desktop pointed at the relay can `GET /health/data`, `GET /sync/pull-all`, etc. and pull down whatever the relay has.

### Why a relay instead of running everything on the desktop?

- **Your iPhone can post health data to it 24/7.** Your laptop is asleep half the time; a small relay on an always-on machine isn't.
- **Multiple devices share the same view.** Both your home desktop and your work PC pull from the same relay → they see the same briefings, the same watchlist, the same sleep.
- **One Claude credential, one place.** The relay holds the OAuth token. You don't need to copy it to every machine you use Mien on.

### The relay's password (`relay.key`)

When you first run `node server.js`, it generates a 32-byte random token and writes it to `relay/relay.key`. Every request to the relay must include this token in an `Authorization: Bearer ...` header — otherwise you get a 401. That's how the relay knows you (and your devices) are allowed in.

You copy this token into:
- **Each desktop's Settings → Relay Auth Token.**
- **Health Auto Export's request headers** on your iPhone, so its uploads authenticate.

It never rotates automatically. Treat it like a password.

---

## Tunnels: making the relay reachable from anywhere

The relay listens on `localhost:3456` — that's only reachable from the same machine. To use Mien from your work PC (or your phone over cellular), you need to expose `localhost:3456` to the public internet. That's what a **tunnel** does.

### Cloudflare tunnels (the only kind Mien supports natively)

Two flavors:

#### 1. Quick tunnel (random URL, free, no setup)

Run:
```bash
TUNNEL=1 node server.js
```

The relay starts `cloudflared tunnel --url http://localhost:3456` internally. Cloudflare assigns you a random URL like `https://shy-cloud-1234.trycloudflare.com` and writes it to `relay/tunnel-url.txt`. The desktop reads that file and shows you a "Use as relay URL" banner in Settings.

**Downsides:**
- The URL changes every time the relay restarts — annoying if you reboot often.
- Many corporate firewalls block `*.trycloudflare.com` because it's commonly used to bypass content filters.

#### 2. Named tunnel (your own domain, stable URL)

This is what most long-term setups use. Steps:
1. You own a domain on Cloudflare (e.g. `yourdomain.com`).
2. Run `cloudflared tunnel login` once, then `cloudflared tunnel create mien` to make a named tunnel.
3. Create a config (`~/.cloudflared/config.yml` or similar) pointing `relay.yourdomain.com` at `http://localhost:3456`.
4. Run `cloudflared tunnel run mien` as a separate process from `node server.js`.

The URL `https://relay.yourdomain.com` stays the same forever, doesn't get caught by category-blockers as often, and you don't set `TUNNEL=1` (you're running cloudflared yourself, separately).

Most corporate firewalls let through traffic to your own domain unless they do full SSL inspection.

### Other tunnels (ngrok, localtunnel, etc.)

Mien doesn't have built-in support for these, but **the relay is just an HTTP server on port 3456 — anything that exposes a port works.** You could:

- `ngrok http 3456` and paste the ngrok URL into Mien Settings. Same idea, just a different tunnel provider.
- `tailscale serve --https=443 / http://localhost:3456` and use your Tailscale magic-DNS hostname.
- Port-forward 3456 on your router (not recommended — no HTTPS, no auth at the network layer beyond the bearer token).

If you ever said "grok tunnel," you probably meant ngrok. (Grok the AI is unrelated to any of this — Mien only talks to Anthropic's Claude.)

### Quick reference

| Tunnel               | URL stability | Setup time | Corp-firewall-friendly       |
|----------------------|---------------|------------|------------------------------|
| Cloudflare quick     | Changes every restart | 0 min  | Often blocked (`*.trycloudflare.com` is a known category) |
| Cloudflare named     | Stable        | 20 min     | Best — your own domain |
| ngrok free           | Changes       | 5 min      | Mixed — `*.ngrok.io` is sometimes blocked |
| Tailscale            | Stable        | 10 min     | Works on most corp networks (requires Tailscale client) |
| Router port-forward  | IP-based      | 30 min     | Only works for inbound to your home IP — not from your phone on cellular |

---

## Where data lives

There are three storage layers. Knowing which is which makes troubleshooting much easier.

### 1. On the relay (shared, the source of truth for synced data)

| File                 | What's in it                                                |
|----------------------|-------------------------------------------------------------|
| `relay/health-data.json` | Every health metric from your phone — sleep, HR, HRV, steps, calories, etc. Up to ~50k entries. |
| `relay/sync-data.json`   | Watchlist tickers, prices, news, AI briefings, chat history, weekend plans, daily schedule, saved restaurants. |
| `relay/relay.key`        | The bearer token. Generated once, lasts forever. |
| `relay/tunnel-url.txt`   | The Cloudflare quick-tunnel URL (only present if `TUNNEL=1`). |

These are what get *synced* — any desktop reading from the same relay sees the same data.

### 2. On each desktop, in `electron-store` (per-device config)

Lives at `%APPDATA%\mien\config.json` (Windows) or `~/Library/Application Support/mien/config.json` (Mac). One file, plain JSON. Contains:

- API keys you paste in Settings (Claude, Alpha Vantage, Ticketmaster, Google Places, Notion).
- Your Relay URL and Relay Auth Token.
- App-lock password hash (the thing you set when you first launch).
- YouTube channel list, home location, sleep goals, etc.

**This file is per-device** — your work PC and your home laptop each have their own. That's why you have to type the Relay URL + Token on each new machine.

### 3. On each desktop, in SQLite (a local cache + analytics layer)

A `mien.db` file in the same `%APPDATA%\mien\` folder, managed by `better-sqlite3`. Mirrors most of what's on the relay (watchlist, prices, briefings, etc.) plus some local-only things:

- `ai_activity_log` — every AI call made from this device, with timing and token counts. This is what the **Settings → AI Activity** panel reads from.
- `sync_checkpoints` — the timestamp of the last successful push to the relay, per table. Used to avoid re-uploading the same data.
- `scheduler_activity_log` — when the periodic sync job last ran, and what happened.

**Why a local copy if the relay already has it?** Speed. Reading from SQLite is microseconds; reading from the relay over the internet is hundreds of milliseconds. Mien shows you the local copy instantly and refreshes from the relay in the background.

---

## How Apple Health data gets in

The flow:

```
iPhone Health app
   │ (HealthKit shares data with...)
   ▼
Health Auto Export (iOS app)
   │ Automation: every hour, POST JSON to relay
   ▼
https://relay.yourdomain.com/health/auto-export
   │ Authorization: Bearer <relay.key>
   ▼
relay/server.js
   │ - Parses HAE's JSON format
   │ - Maps "Sleep_Analysis" → internal "sleep" type
   │ - Deduplicates by (type, date) — same metric for same day isn't stored twice
   │ - Aggregates by day (steps = sum, heart rate = average)
   │ - Writes to relay/health-data.json
   ▼
Desktop clients
   │ GET /health/data?days=14
   │ Cache locally in SQLite (health_metrics table)
   │ Render on Health page
```

The relay processes the upload **asynchronously** — it responds 202 immediately, then chews through the payload in the background. That's why a fresh upload can take a minute or two to fully appear.

---

## Adding new data and how it syncs

Three ways data enters the system:

### 1. From your phone (Apple Health)

Already covered above. Health Auto Export does this on a schedule; you don't lift a finger after setup.

### 2. From a desktop (chat messages, generated briefings, watchlist changes)

When you do something on a desktop client (send a chat message, add a ticker to watchlist, click "Generate briefing"), here's what happens:

1. **Write locally first.** The client immediately writes to its own SQLite. The UI updates instantly.
2. **Sync to the relay.** Either right away (chat) or on the 30-minute cron (`POST /sync/push-all`). The relay merges it into `sync-data.json`.
3. **Other clients pick it up.** On their next `GET /sync/pull-all` (also every 30 min, or when you click refresh), they pull the new data.

### 3. From the relay's own background jobs

The relay runs its own crons:
- **Finance** (`/relay/refresh-finance`): fetches prices from Yahoo Finance and news from various sources every N minutes.
- **Briefing generation** (`/relay/generate-briefing`): once a day, calls Claude to produce a "morning briefing" using your latest health + finance + calendar data, and stores it in `sync-data.json` so every client sees it.

You can trigger either manually with a POST to the same endpoint.

### Conflict resolution

Synced user rows carry version metadata. Schedules and weekend plans merge by date; holdings and finance/health alerts merge by stable `sync_id`; restaurant reviews merge by `place_id + visit_date`. For the same row, the relay keeps the newest `updated_at` value, and deletes travel as `deleted_at` tombstones so another device does not resurrect removed rows.

This is still row-level conflict handling, not field-by-field merging. If two desktops edit the same schedule date before either syncs, the newest saved row wins.

---

## How two devices stay in sync (the loop)

```
Device A                Relay                  Device B
   │                      │                       │
   │── POST /sync/push ──▶│                       │
   │   (every 30 min)     │                       │
   │                      │ writes to             │
   │                      │ sync-data.json        │
   │                      │                       │
   │                      │◀── GET /sync/pull ───│
   │                      │    (every 30 min)     │
   │                      │                       │
   │                      │── returns merged ────▶│
   │                      │     data              │
   │                      │                       │
   │                                              │ writes to
   │                                              │ local SQLite
```

So "near-real-time" really means "within ~30 minutes." If you want a faster refresh, the desktop has a manual refresh button on most pages.

**Health data is slightly different** — desktops do a more targeted `GET /health/data?days=14` rather than the full sync-data pull, since health metrics are large.

---

## The AI Activity panel (your "what's breaking" view)

`Settings → AI Activity` shows the last 50 AI calls this device made, with:

- Timestamp
- Kind (briefing / chat / skill)
- Tokens in/out, cache reads/writes
- Latency
- Status (success/failed) and error message

It reads from this device's local SQLite (`ai_activity_log` table) — **not** from the relay. So if you have two desktops, each one sees its own activity, not the other's.

When chat fails with errors, this is where you go. Individual entries don't have a click-through detail view today (one of the suggestions below).

---

## Sharing Mien with a friend

Mien has **no shared server**. If a friend wants their own Mien, they run their own relay, with their own Claude credential. Their data and yours stay completely separate, on different machines. Here's what they'd do:

### Their setup, end to end

1. **Get the code.** Either:
   - You give them collaborator access on GitHub and they clone the repo, **or**
   - You download a ZIP and hand it to them on a USB / OneDrive / etc.

2. **Pick a machine for their relay.** Ideally always-on — a desktop they leave running, a Raspberry Pi, an old laptop. The relay is tiny (~50 MB RAM).

3. **Install Node 20+.** `https://nodejs.org` → LTS → install. (Or follow [work PC setup](./docs/setup/install-work-pc.md) if their machine is locked down.)

4. **Start the relay.**
   ```bash
   cd Mien/relay
   npm install
   # If they have a Claude Pro/Max subscription:
   #   They install the Claude Code CLI, run `claude setup-token`,
   #   and export the resulting token:
   export CLAUDE_CODE_OAUTH_TOKEN="..."
   # Or, pay-as-you-go API:
   export ANTHROPIC_API_KEY="sk-ant-..."
   node server.js
   ```
   First run prints a relay token they need to save. Their `relay/relay.key` is generated.

5. **(Optional) Expose the relay.**
   - Quick path: `TUNNEL=1 node server.js` — random Cloudflare URL.
   - Stable path: register a Cloudflare domain, run a named tunnel.
   - If they only use Mien on the same machine as the relay, **skip this entirely** — they point Mien at `http://localhost:3456` and it just works.

6. **Install the desktop app.**
   ```bash
   cd Mien
   npm install
   npx electron-rebuild -f -w better-sqlite3
   npm run dev
   ```
   Or run `setup.ps1` if on Windows.

7. **Connect the desktop to the relay.** Settings → AI Connection:
   - Relay Server URL: `http://localhost:3456` (or their tunnel URL)
   - Relay Auth Token: contents of their `relay/relay.key`
   - (Optional) Claude API Key: if they don't use the OAuth path, paste an API key here

8. **(Optional) Wire their phone to the relay.** Install Health Auto Export, point it at `<their-relay-url>/health/auto-export` with their bearer token.

That's it. Their relay holds their data. Their Claude credential is theirs. You can't see their data; they can't see yours. Even if you both used Mien for a year, you'd never know.

### What they should NOT copy from you

- Your `relay.key` (it's specific to your relay; they generate their own)
- Your `health-data.json` (your sleep data isn't theirs)
- Your tunnel URL or Cloudflare domain
- Your Claude credential

They are starting fresh, not cloning your state.

---

## Suggestions (things worth considering)

These are not bugs — they're improvements you might want, in rough order of value-for-effort.

### High-leverage

1. **Run the relay as a service so it survives reboots.**
   Right now if the home machine reboots, you have to manually `node server.js` again. Two easy options:
   - **NSSM** on Windows: `nssm install MienRelay`. Wraps `node server.js` as a service that auto-starts.
   - **pm2** cross-platform: `npm install -g pm2; pm2 start server.js; pm2 startup`. Same effect.
   Either eliminates the "I rebooted and AI broke" class of problem.

2. **Back up the four files that matter.**
   The relay's entire state is four files: `relay.key`, `health-data.json`, `sync-data.json`, plus your Cloudflare tunnel config. Throw them in a daily OneDrive backup. If your home machine dies, you're back up in 15 minutes on a new one.

3. **Persist the relay token, not just the file.**
   If you ever delete `relay.key` by accident, every device loses access. Write it down in a password manager. (Same for your Claude OAuth token.)

### Code-level

4. **Add click-through detail to the AI Activity panel.**
   Today it shows status + error message, but you can't see the request body or response. Adding a "details" modal would have saved hours of recent debugging. Implementation: extend `ai_activity_log` to store request/response JSON (truncated to 8 KB), wire a modal in `SettingsPage.tsx`. ~2 hours of work.

5. **Named tunnel via `TUNNEL=1`.**
   Currently `TUNNEL=1` only starts a quick tunnel. Add `TUNNEL=named TUNNEL_NAME=mien` to skip the quick tunnel and assume `cloudflared tunnel run mien` is running externally — saves people running two `cloudflared` commands.

6. **A "Test relay connection" button in Settings.**
   One click that GETs `/health`, reports status code + auth result, so you don't have to drop to PowerShell + `Invoke-WebRequest` to debug.

7. **Health Auto Export verify endpoint.**
   `GET /health/auto-export/last` that returns the timestamp of the last successful HAE upload. Lets you see at a glance whether your phone's automation is firing.

### Operational

8. **Switch off `*.trycloudflare.com` for any real use.**
   A named tunnel gives you a stable URL and better firewall reputation. The quick-tunnel default in `TUNNEL=1` is fine for testing but should never be a daily setup.

9. **Set `ANTHROPIC_API_KEY` as a fallback on the relay.**
   If you only have `CLAUDE_CODE_OAUTH_TOKEN` set and Anthropic ever invalidates it (revoked session, year expiry), AI breaks until you regenerate. Setting `ANTHROPIC_API_KEY` as a secondary means a pay-as-you-go key kicks in automatically.

10. **Consider Tailscale instead of Cloudflare tunnel.**
    If all the devices you use Mien from are yours, Tailscale gives you a private network without exposing the relay to the public internet at all. Slightly more setup, much smaller attack surface.

---

## Glossary

| Term | What it means in Mien |
|---|---|
| **Relay** | The Node program at `relay/server.js`. Runs on your always-on machine. |
| **Relay token** | A 32-byte random string in `relay/relay.key`. Required for every API call. |
| **Tunnel** | A way to expose `localhost:3456` to the public internet so other devices can reach the relay. |
| **Cloudflare quick tunnel** | Random `*.trycloudflare.com` URL. Free, no account needed, URL changes on restart. |
| **Cloudflare named tunnel** | Stable URL on a domain you own. Needs a Cloudflare account and ~20 min of setup. |
| **Bearer token** | An HTTP header (`Authorization: Bearer <token>`) used to authenticate. Mien uses one for the relay token. |
| **electron-store** | A small JSON file (`%APPDATA%\mien\config.json`) where the desktop app keeps settings. |
| **`mien.db`** | Local SQLite file in the same `%APPDATA%\mien\` folder. Caches synced data and stores AI activity log. |
| **Health Auto Export (HAE)** | iOS app that POSTs HealthKit data to your relay on a schedule. |
| **OAuth token** | A 1-year token from `claude setup-token` (Claude Code CLI). Authenticates as your Claude account. |
| **API key** | A `sk-ant-...` key from console.anthropic.com. Pay-as-you-go alternative to the OAuth token. |
