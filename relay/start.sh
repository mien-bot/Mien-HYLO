#!/usr/bin/env bash
# ============================================================
# Mien Relay — Auto-restart startup script
#
# Keeps the relay server alive permanently. If it crashes,
# it restarts after a short backoff. Logs to relay.log.
#
# Usage:
#   ./start.sh                  # local network
#   TUNNEL=1 ./start.sh         # with Cloudflare tunnel
#   TUNNEL=1 ./start.sh &       # background + tunnel
#   nohup TUNNEL=1 ./start.sh & # survives terminal close
#
# To stop:
#   kill $(cat relay.pid)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="$SCRIPT_DIR/relay.log"
PID_FILE="$SCRIPT_DIR/relay.pid"
MAX_BACKOFF=60
BACKOFF=1

# Write our PID so we can be stopped
echo $$ > "$PID_FILE"

cleanup() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Relay launcher stopped" >> "$LOG_FILE"
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Relay launcher started (PID $$)" | tee -a "$LOG_FILE"

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting relay server..." | tee -a "$LOG_FILE"

  # Run the server, tee output to log and stdout
  node server.js 2>&1 | tee -a "$LOG_FILE"
  EXIT_CODE=${PIPESTATUS[0]}

  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server exited cleanly" >> "$LOG_FILE"
    break
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server crashed (exit $EXIT_CODE). Restarting in ${BACKOFF}s..." | tee -a "$LOG_FILE"
  sleep "$BACKOFF"

  # Exponential backoff capped at MAX_BACKOFF
  BACKOFF=$((BACKOFF * 2))
  if [ "$BACKOFF" -gt "$MAX_BACKOFF" ]; then
    BACKOFF=$MAX_BACKOFF
  fi
done
