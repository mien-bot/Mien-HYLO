# Setting up Mien

A 10–20 minute checklist that gets you from "I have nothing" to "the dashboard works and AI features respond."

Mien is fully self-hosted: there is no Mien account, no shared server. You'll run your own little relay on the same laptop you use Mien on, and the app will talk to Claude through your own credential. None of your data leaves your machine except for the AI requests you send to Claude (and only those — they're not stored beyond Anthropic's normal retention).

> **Want the mental model first?** See [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) — a layman's-terms walkthrough of relay, tunnels, storage, and multi-device sync. Worth a 5-minute read before setting up.
>
> If you want a 24/7 setup with a dedicated always-on machine, see [server setup](./docs/setup/server-setup.md) instead. This page covers the everyday-laptop path.
>
> **Installing on a locked-down work computer?** Use [work PC setup](./docs/setup/install-work-pc.md) — it's a focused top-to-bottom checklist for the no-admin / RemoteSigned / AppLocker case.

---

## 0. What you need

- A Windows, macOS, or Linux machine.
- Node.js 20+ and npm (only if you're building from source).
- A Claude account at [claude.ai](https://claude.ai) (free is fine — see step 3).
- *(Optional but recommended)* A free Cloudflare account if you want mobile access from anywhere.

---

## 1. Install the desktop app

**Option A — installer (easiest):**
1. Download the installer for your OS from the project's Releases page (or grab the `mien-windows-installer` artifact from the latest **Build Windows installer** GitHub Actions run if no release is cut yet).
   - Windows: `mien-*-setup.exe`
   - macOS: `mien-*.dmg`
   - Linux: `mien-*.AppImage`
2. Run it.
   - **Windows**: SmartScreen will show "Unknown Publisher." Click *More info → Run anyway*. (The app isn't code-signed yet.) **If "Run anyway" is disabled on your work machine, this path is blocked — use [work PC setup](./docs/setup/install-work-pc.md) instead.**
   - **macOS**: Right-click the app → *Open* → confirm. If macOS says "damaged," run `xattr -d com.apple.quarantine /Applications/Mien.app` once.
   - **Linux**: `chmod +x mien-*.AppImage && ./mien-*.AppImage`.

**Option B — build from source:**
```bash
git clone <repo-url> Mien
cd Mien
npm install
npx electron-rebuild -f -w better-sqlite3   # needed once after install
npm run package
```
Installer appears under `dist/`.

Launch the app once. The Dashboard will load with a banner telling you to configure AI in Settings — that's expected. We'll fill it in shortly.

---

## 1b. Run from source on a restricted / work computer

> For the linear, top-to-bottom version with no asides, see [work PC setup](./docs/setup/install-work-pc.md). The section below is kept for context and non-Windows machines.

**Quickest path (Windows, no admin):**

1. On a machine that *can* reach GitHub (your home PC, a friend's), grab a copy of the Mien source folder. Easiest is **Code → Download ZIP** on the GitHub repo page; `git clone` and `git archive --format=zip HEAD` also work. Move it to the locked-down machine via OneDrive, USB, or Teams.
2. Extract anywhere in your user folder, e.g. `C:\Users\<you>\Mien\`.
3. Open PowerShell (in VS Code: *Terminal → New Terminal*), `cd` into that folder, and run:

   ```powershell
   Get-ChildItem -Recurse | Unblock-File
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```

The `Unblock-File` line removes the Zone.Identifier ADS that Group Policy's `RemoteSigned` policy refuses to run. The script then downloads Node.js into `%USERPROFILE%\.mien\tools`, runs `npm install` + `npx electron-rebuild` against the folder you ran it from, and drops `Mien` shortcuts on your Desktop and Start Menu. No admin prompt, nothing in `Program Files`, **no network calls to GitHub** — so a private repo / no SSO is fine. Skip to step **e** below afterward to point the client at your existing relay. The manual steps that follow are kept for non-Windows machines and for understanding what the script does.

---

Work / corporate / school machines often block installers (SmartScreen, AppLocker, no admin password). Mien doesn't need to be installed — it's a Node + Electron app and runs fine from a folder in your home directory. Useful when:

- The Windows installer is blocked by SmartScreen and "Run anyway" is disabled.
- You don't have admin rights.
- You already run a relay on another machine and just want a second client.

You're going to:
1. Get Node.js without admin rights.
2. Get the Mien source onto the machine.
3. `npm install` + rebuild + run.
4. Point the app at the relay you already run elsewhere.

### a) Install Node.js without admin

Download the **Windows Binary (.zip)** from [nodejs.org/en/download](https://nodejs.org/en/download) — pick the LTS zip, not the .msi installer. Extract anywhere in your user folder, e.g. `C:\Users\<you>\tools\node-v20\`.

Add that folder to your **user** `PATH` (no admin needed):
```powershell
[Environment]::SetEnvironmentVariable("Path", "$env:Path;C:\Users\<you>\tools\node-v20", "User")
```
Open a **new** terminal and confirm:
```powershell
node --version    # should print v20.x
npm --version
```

On macOS the easiest no-admin route is [Volta](https://volta.sh) (`curl https://get.volta.sh | bash`, then `volta install node@20`). On Linux managed machines, `nvm` (`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; nvm install 20`).

### b) Get the source

Mien is a private repo, so the locked-down machine probably can't clone or download it directly (no SSO, no PAT setup, GitHub blocked, etc.). Get the source onto the machine the same way you'd move any other file:

- On a permissive machine, **Code → Download ZIP** from the GitHub repo page, or `git clone <repo-url> Mien` and zip the folder.
- Transfer via OneDrive / Teams / USB / email to yourself.
- Extract to `C:\Users\<you>\Mien\` on the work machine.

If `git` happens to be available on the work machine *and* you've already got a PAT or SSO set up there, `git clone <repo-url> Mien` works too — but for most locked-down setups the file-transfer route is the only one that doesn't need IT involvement.

### c) Install dependencies

```powershell
cd C:\Users\<you>\Mien
npm install
npx electron-rebuild -f -w better-sqlite3
```

`better-sqlite3` ships prebuilt binaries for common Electron versions, so this step usually downloads a binary rather than compiling. If it falls back to compiling and fails because you don't have Visual Studio Build Tools, that's the one blocker without a workaround — you'd need to either get Build Tools approved (or use the prebuilt installer route on a permissive machine and copy the unpacked folder over).

### d) Run

```powershell
npm run dev
```

The Electron window opens. This is identical to the installed version, just running through electron-vite's dev server. **Leave this terminal open while you use the app** — closing it kills the app.

For repeat use, double-click `scripts\start-source.bat` (Windows) or `./scripts/start-source.sh` (Mac/Linux) — included in the repo as a one-click launcher.

### e) Wire it to your existing relay

Skip steps 2 and 3 below — you already have a relay running on your other computer. Open Settings on this fresh machine and paste:
- **Relay Server URL**: the same Cloudflare tunnel URL your other client uses.
- **Relay Auth Token**: the same token from your other machine's `relay/relay.key`.

Both clients now read the same relay = the same health data, the same briefings, the same watchlist. No second relay needed.

### Common work-computer gotchas

| Problem | Fix |
|---|---|
| `npm install` hangs / SSL errors | Corporate proxy. `npm config set proxy http://proxy.example.com:8080` (ask IT for the URL), or use `--registry https://registry.npmmirror.com`. |
| `electron-rebuild` says "cannot find Python" | The prebuilt binary download failed and it's trying to compile. Ensure your Electron version (`grep electron package.json`) has prebuilt better-sqlite3 binaries — usually yes for recent Electrons. |
| Windows Defender quarantines `node.exe` | Add an exclusion for your `C:\Users\<you>\tools\node-v20` folder in user-level Windows Security, or run `Add-MpPreference -ExclusionPath` (works without admin in some policy modes). |
| Cloudflare tunnel URL is blocked by corp firewall | Your tunnel may be classified as VPN/unknown. Try a domain-mapped tunnel (named cloudflared tunnel pointing at a subdomain you own), or just use Mien off the corporate network. |
| Outlook / Teams blocks `git clone <ssh>` | Use the ZIP transfer path above; no clone needed. |

### Updating

When the source changes upstream, repeat the transfer (download fresh ZIP, replace the folder), then:
```powershell
cd C:\Users\<you>\Mien
npm install      # only if package.json changed
npm run dev
```

If you have a working clone on the work machine, `git pull` from inside the folder still works.

---

## 2. Get a Claude credential

You have two options. Pick one.

**Option A — 1-year OAuth token (recommended; no per-call billing if you're on Claude Pro/Max):**
```bash
# Install the Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code
claude setup-token
```
Copy the token it prints. Note: this token authenticates as *your* Claude account; treat it like a password.

**Option B — Raw API key (pay-as-you-go):**
Go to [console.anthropic.com](https://console.anthropic.com) → *API Keys* → *Create Key*. Copy the key.

You'll paste whichever one you chose in step 4.

---

## 3. Start the relay on the same laptop

The relay is a small Node server that proxies AI calls and stores synced data. It runs on the same laptop as the desktop app.

```bash
cd Mien/relay
# If you chose Option A in step 2:
export CLAUDE_CODE_OAUTH_TOKEN="<the-token-you-copied>"
# (Windows PowerShell: $env:CLAUDE_CODE_OAUTH_TOKEN = "<...>")

node server.js
```

On first run it prints:
```
==========================================
  NEW AUTH TOKEN GENERATED
  Relay Token: <a long random string>
==========================================
Listening on port 3456
```

**Copy that relay token.** It's also saved to `relay/relay.key`.

> If you'd rather store the Claude key in the app instead of as an env var, skip the `export` and you'll paste the raw API key in step 4 instead.

### Optional: expose the relay over the internet (for mobile away from home)

If you only use Mien on the desktop, skip this — `http://localhost:3456` is enough.

If you want the iPhone app to work over LTE / when away from your laptop:
```bash
# Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
TUNNEL=1 node server.js
```
The relay will spin up a Cloudflare tunnel and write the URL to `relay/tunnel-url.txt`. The desktop app picks this up automatically (Settings shows it as a clickable banner with a "Use as relay URL" button).

For a permanent tunnel URL (instead of a random one each restart), set up a named tunnel — see [server setup](./docs/setup/server-setup.md#named-tunnels).

---

## 4. Wire the desktop app to the relay

In the desktop app:

1. Click the gear icon (Settings).
2. Under **AI Connection**:
   - **Relay Server URL**: `http://localhost:3456` (or paste the Cloudflare tunnel URL).
   - **Relay Auth Token**: paste the relay token from step 3.
3. *(If you used Option B in step 2)*: under **Claude API Key**, paste the raw API key.
4. Click **Save**.

The onboarding banner on the Dashboard should disappear. Try the Chat page — it should respond.

---

## 5. Mobile (optional)

The mobile app needs your own iOS dev build because HealthKit requires Apple's entitlement gate, which Expo Go doesn't grant.

**Free path (Personal Team signing):**
1. Install Xcode.
2. Plug in your iPhone, sign in to Xcode with your free Apple ID.
3. From the `mobile/` folder: `npx expo prebuild && npx expo run:ios --device`.
4. Apps signed this way expire after 7 days — re-run the build weekly.

**Paid path:**
$99/year Apple Developer Program gets you year-long certs and TestFlight access. Not necessary for personal use.

Once installed, open Settings on the iPhone and paste the same Relay URL and Token from step 4.

> Don't have a dev account or Xcode? Skip mobile. Health Auto Export → relay → desktop already gives you all the data on the desktop side.

---

## 6. Apple Health → relay (optional)

If you want your Apple Watch data in Mien:

1. Install [Health Auto Export](https://apps.apple.com/us/app/health-auto-export-json-csv/id1115567069) on iPhone.
2. In Health Auto Export, set up an **Automation** → **Automatic** export.
3. Format: **JSON** (REST API).
4. URL: `<your-relay-url>/health/auto-export` (e.g. `http://192.168.1.50:3456/health/auto-export` on LAN, or your Cloudflare tunnel URL).
5. **Headers**: `Authorization: Bearer <your-relay-token>`.
6. Include: Sleep, Heart Rate, HRV, Steps, Active Energy, Workouts (toggle on).
7. Frequency: every hour, or "on app open." Daily at 8 AM works well for sleep data.

Verify by opening the Health page in Mien — last night's sleep should appear within a few minutes of the next HAE export.

---

## 7. Other optional integrations

All of these are optional; the app works without them.

| Service | Free tier | Where to get key | Where to paste |
|---|---|---|---|
| Alpha Vantage | 25 req/day | [alphavantage.co](https://www.alphavantage.co/support/#api-key) | Settings → Finance |
| Ticketmaster | 5000 req/day | [developer.ticketmaster.com](https://developer.ticketmaster.com/) | Settings → Weekend |
| Google Places | Free trial | [console.cloud.google.com](https://console.cloud.google.com/) | Settings → Restaurants |
| Notion | Free | [notion.so/my-integrations](https://www.notion.so/my-integrations) → share each DB with the integration | Settings → Notion |

For Notion, after pasting the integration token, click **Load databases** in Settings — your DBs appear in a dropdown. Pick which one is your Tasks / Briefings / Calendar DB, then pick the date property each DB's calendar view is grouped by.

---

## Troubleshooting

- **"AI not configured" error** — relay isn't running, or the URL/token in Settings doesn't match. Restart `node server.js` and re-check.
- **"Sleep didn't show up after sync"** — check that the relay is reachable (visit `<relay-url>/health` in a browser; should return `{"status":"ok"}` with the bearer token). HAE's logs in the iPhone app tell you if the POST succeeded.
- **Tunnel URL changes every restart** — that's expected for free Cloudflare quick tunnels. Set up a named tunnel for a stable URL.
- **`better-sqlite3` errors on first launch** — rebuild for Electron: `cd Mien && npx electron-rebuild -f -w better-sqlite3`.
- **macOS "app is damaged"** — `xattr -d com.apple.quarantine /Applications/Mien.app`.

---

## What's running on my machine?

| Process | What it does | Resource use |
|---|---|---|
| Mien desktop app (Electron) | UI + SQLite + Apple Health receiver on port 19876 | ~200 MB RAM idle |
| `relay/server.js` (Node) | Claude proxy + relay storage on port 3456 | ~50 MB RAM idle |
| `cloudflared` *(optional)* | Public tunnel to the relay | ~30 MB RAM |

You can close the desktop app and the relay keeps running (useful so the phone can still sync). The relay logs to stdout — pipe it to a file if you want persistence: `node server.js >> relay.log 2>&1`.

---

## Sharing with friends

If you want to give Mien to someone else, send them this SETUP.md and a fresh installer. They run their own relay with their own credential. There is no shared server — their data and yours stay separate by default, on different machines.

What you do **not** share: your `relay.key`, your `health-data.json`, your tunnel URL, or your Claude credential. Those are personal to your instance.
