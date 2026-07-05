# Relay Server — Initial Setup Playbook

This file is the single-source instruction set for an AI agent (or human)
setting up the Mien relay server on a fresh server PC. Follow each step in
order, verify the expected output before moving on, and stop and ask the user
if any step fails in a way not covered below.

The relay must run 24/7 on a machine with internet access. Once set up, the
mobile and desktop apps will route AI requests and sync calls through it.

When you finish, report back to the user:
- The current tunnel URL (`cat relay/tunnel-url.txt`)
- The bearer token (`cat relay/relay.key`)
- The exact mechanism keeping the relay alive (start.sh / pm2 / systemd)

---

## Phase 1 — Prerequisites (verify, install if missing)

```bash
# 1. Node.js 18 or newer
node --version
# Expected: v18.x.x or higher. If "command not found" or older, install:
#   Mac:    brew install node
#   Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
#   Win:    winget install OpenJS.NodeJS

# 2. git
git --version
# Expected: any recent version. Install if missing.

# 3. cloudflared (required for TUNNEL=1)
cloudflared --version
# Expected: cloudflared version 2024.x.x or later. If missing:
#   Mac:    brew install cloudflare/cloudflare/cloudflared
#   Ubuntu: sudo apt install cloudflared
#           (or download from https://github.com/cloudflare/cloudflared/releases)
#   Win:    winget install cloudflare.cloudflared

# 4. Claude Code CLI (for the 1-year setup token)
claude --version
# Expected: any recent version. Install if missing:
#   npm install -g @anthropic-ai/claude-code
```

If any check fails, install the missing tool and re-verify before moving on.

---

## Phase 2 — Clone or update the repo

```bash
# If the repo doesn't exist yet:
cd ~
git clone <repo-url> Mien
cd Mien

# If it does exist:
cd ~/Mien
git fetch origin
git checkout master
git pull origin master
```

The relay lives at `relay/server.js`. There are no relay-specific dependencies
to install (the package.json declares zero deps), but verify:

```bash
cat relay/package.json
# Expected: "dependencies": {} or absent dependencies field.
```

---

## Phase 3 — Generate the long-lived Claude OAuth token

The relay supports three credential sources (in priority order):
1. `ANTHROPIC_API_KEY` env var — pay-per-token, never expires
2. `CLAUDE_CODE_OAUTH_TOKEN` env var — 1-year token from `claude setup-token`
3. `~/.claude/.credentials.json` — short-lived (~1 hour) session token from
   `claude login`

**Use option 2** unless the user explicitly says to use an API key. Option 3
is the source of the recurring disconnections the user is trying to escape —
do not rely on it.

```bash
claude setup-token
```

This opens a browser. Have the user complete the login. The CLI prints a
token starting with `sk-ant-oat...` — capture it.

**Important:** the token is shown once. If you miss it, run `claude setup-token`
again to get a fresh one.

Export it so the relay can read it:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=<paste-token-here>
# Verify it's set (only prints prefix, not full token):
echo "${CLAUDE_CODE_OAUTH_TOKEN:0:12}..."
# Expected: prints "sk-ant-oat..." (or whatever the prefix is)
```

This `export` only persists in the current shell. To make it stick, see
Phase 6 (one of the persistence mechanisms — start.sh wrapper, pm2 ecosystem
file, or systemd unit Environment= line).

---

## Phase 4 — First run (generates relay.key)

Start the relay briefly in the foreground to generate its bearer token:

```bash
cd ~/Mien/relay
TUNNEL=1 node server.js
```

Expected output within the first 5–10 seconds:

```
  ========================================
  NEW AUTH TOKEN GENERATED
  ========================================
  Token: <43-char-random-string>
  Saved: /home/<user>/Mien/relay/relay.key

  Mien Relay Server v3.x
  Provider:  anthropic
  AI Auth:   oauth (sk-ant-oat...)
  Port:      3456
  Auth:      Bearer token (see relay.key)
  Starting Cloudflare Tunnel...

  ========================================
  TUNNEL URL: https://<random-words>.trycloudflare.com
  TOKEN:      <the-bearer-token-again>
  ========================================
  Written to /home/<user>/Mien/relay/tunnel-url.txt
```

Key things to confirm in the output:
- `AI Auth: oauth (sk-ant-oat...)` — confirms `CLAUDE_CODE_OAUTH_TOKEN` was
  picked up. If it says `oauth (eyJ...)` or `No credentials found`, the env
  var wasn't actually set in this shell — re-check `echo $CLAUDE_CODE_OAUTH_TOKEN`.
- `TUNNEL URL: https://...trycloudflare.com` — confirms cloudflared came up.
  If it says `Cloudflare Tunnel not installed`, Phase 1 step 3 failed.
- `Written to /.../tunnel-url.txt` — confirms the URL is persisted to disk.

Once you see those three things, press **Ctrl+C** to stop. You'll restart
under one of the persistent supervisors in Phase 6.

If something went wrong, see `relay/AGENT.md` for failure diagnostics before
proceeding.

---

## Phase 5 — Smoke test

With the relay still NOT running, verify the files exist:

```bash
ls -la ~/Mien/relay/relay.key ~/Mien/relay/tunnel-url.txt
# Both should exist with 600 permissions (rw for owner only).

# Note: tunnel-url.txt is cleared at next startup until cloudflared
# reissues a URL, so a stale value here is expected and harmless.
```

Briefly bring it back up to confirm health:

```bash
cd ~/Mien/relay
TUNNEL=1 node server.js &
SERVER_PID=$!
sleep 8  # give cloudflared time to issue a URL
TOKEN=$(cat relay.key)
URL=$(cat tunnel-url.txt 2>/dev/null)

# Local health check (should always work):
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:3456/health
# Expected: {"status":"ok","service":"mien-relay",...}

# Tunnel health check (depends on cloudflared having issued a URL yet):
if [ -n "$URL" ]; then
  curl -sS -H "Authorization: Bearer $TOKEN" "$URL/health"
  # Expected: same JSON as above.
fi

# Stop the test process:
kill $SERVER_PID
wait 2>/dev/null
```

If both `curl` calls return `{"status":"ok",...}`, the relay is wired up
correctly. Proceed to Phase 6.

---

## Phase 6 — Make it survive (pick ONE)

The relay must restart after crashes, reboots, and laptop sleep. Choose the
supervisor that matches the OS and user preference. If unsure, ask the user.
**systemd is the default recommendation on Linux servers**; pm2 is best on
Mac/dev laptops; start.sh is fine for a terminal that the user keeps open.

### Option A — systemd (Linux, recommended for dedicated server)

```bash
# Capture the user and home dir for the unit:
WHOAMI=$(whoami)
HOMEDIR=$HOME
TOKEN_LINE="CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"

# Write the unit (requires sudo):
sudo tee /etc/systemd/system/mien-relay.service > /dev/null <<EOF
[Unit]
Description=Mien Relay Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$WHOAMI
WorkingDirectory=$HOMEDIR/Mien/relay
Environment=TUNNEL=1
Environment=$TOKEN_LINE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=append:$HOMEDIR/Mien/relay/relay.log
StandardError=append:$HOMEDIR/Mien/relay/relay.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mien-relay
sudo systemctl start mien-relay

# Verify it came up:
sleep 5
sudo systemctl status mien-relay --no-pager | head -20
# Expected: "Active: active (running)"
journalctl -u mien-relay -n 30 --no-pager | grep -E "TUNNEL URL|AI Auth|NEW AUTH"
```

### Option B — pm2 (cross-platform, easy log access)

```bash
npm install -g pm2

cd ~/Mien/relay
TUNNEL=1 CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN \
  pm2 start server.js --name mien-relay

pm2 save
pm2 startup
# pm2 prints a `sudo ...` command — run exactly that command to install
# the boot hook, then `pm2 save` once more.

# Verify:
pm2 status
pm2 logs mien-relay --lines 30 --nostream
```

### Option C — start.sh (no extra deps, terminal must stay open)

```bash
cd ~/Mien/relay
chmod +x start.sh

# Foreground (terminal must stay open):
TUNNEL=1 CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN ./start.sh

# Or background (survives terminal close):
nohup env TUNNEL=1 CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN \
  ./start.sh > /dev/null 2>&1 &

# Verify:
tail -30 relay.log
cat relay.pid
```

To stop start.sh: `kill $(cat relay.pid)`.

### Option D — Windows Task Scheduler

If on Windows, use `relay/start.ps1` and Task Scheduler. See `relay/README.md`
section "Option 4". Ask the user before going down this path.

---

## Phase 7 — Final verification

After the supervisor is in place, run the post-restart checklist from
`relay/AGENT.md`:

```bash
cd ~/Mien

# 1. Process alive
pgrep -af "relay/server.js" && echo "ok: node alive" || echo "FAIL"

# 2. cloudflared alive
pgrep -af cloudflared && echo "ok: cloudflared alive" || echo "FAIL"

# 3. Tunnel URL persisted
test -s relay/tunnel-url.txt && \
  echo "ok: tunnel URL = $(cat relay/tunnel-url.txt)" || \
  echo "FAIL: no tunnel URL"

# 4. Local /health
TOKEN=$(cat relay/relay.key)
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:3456/health \
  | grep -q '"status":"ok"' && echo "ok: local /health" || echo "FAIL"

# 5. Tunnel /health
URL=$(cat relay/tunnel-url.txt 2>/dev/null)
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/health" \
  | grep -q '"status":"ok"' && echo "ok: tunnel /health" || echo "FAIL"
```

All five must say `ok`. If any say `FAIL`, see the matching failure mode in
`relay/AGENT.md`.

---

## Phase 8 — Report to the user

Once Phase 7 is fully green, message the user with **exactly** this
information:

```
Relay is up.

Tunnel URL: https://<from-tunnel-url.txt>
Bearer Token: <from-relay.key>

Supervisor: <systemd | pm2 | start.sh | task-scheduler>
Logs: <journalctl -u mien-relay -f | pm2 logs mien-relay | tail -f relay/relay.log>

Paste these into the Mien app on phone + desktop:
- Settings > Relay Server URL = <Tunnel URL>
- Settings > Relay Token       = <Bearer Token>
```

The user can then Test Connection in mobile Settings — it should say
"Connected".

---

## Common pitfalls (and what to do)

| Symptom during setup | Cause | Action |
|----------------------|-------|--------|
| `AI Auth: No credentials found` in startup output | env var not actually exported in the shell that started the relay | Verify with `echo $CLAUDE_CODE_OAUTH_TOKEN`. If empty, re-`export` and restart. For supervisors, put it in the unit/ecosystem config — your current shell's exports don't propagate to a sudo'd systemctl. |
| Tunnel URL line never appears | cloudflared not installed, network blocked, or Cloudflare account issue | Run `cloudflared tunnel --url http://localhost:3456` manually and read its stderr — the real error is there. |
| `AI Auth: oauth (eyJ...)` with mysterious failures later | relay fell back to short-lived `~/.claude/.credentials.json` (option 3) instead of the long-lived setup-token | Re-export `CLAUDE_CODE_OAUTH_TOKEN` and put it in the supervisor config. Restart. |
| Two different tokens shown in two restarts | `relay.key` was regenerated (the file was deleted between starts) | If `relay.key` exists, the relay reuses it. Don't delete it — mobile/desktop have cached the old value. |
| systemd `Active: failed` | Usually a missing `Environment=` or wrong `WorkingDirectory` | `journalctl -u mien-relay -n 50` to see the actual error. |

---

## When to stop and ask the user

- They want a permanent, never-changing tunnel URL → that's a **named**
  Cloudflare tunnel (`cloudflared tunnel create mien` + DNS routing) which
  needs a Cloudflare account and a domain. Don't set it up unprompted; ask
  first.
- They don't have Claude Pro/Max subscription → `claude setup-token` will
  fail; fall back to asking for an `ANTHROPIC_API_KEY` instead.
- The machine is behind a corporate firewall that blocks outbound HTTPS to
  Cloudflare or Anthropic → escalate; this isn't fixable on the server side.
- Any step in Phase 4 or 5 produces output that doesn't match the expected
  patterns and isn't covered in the pitfalls table → don't guess, ask.
