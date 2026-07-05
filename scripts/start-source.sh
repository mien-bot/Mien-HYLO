#!/usr/bin/env bash
# Mien — run from source on macOS / Linux.
# Run with: bash scripts/start-source.sh  (or chmod +x and double-click on Mac)
# Installs deps if missing, rebuilds the SQLite native module on first run,
# then starts the Electron dev server. Close the window to stop the app.

set -e

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "Installing dependencies (one-time, ~2 min)..."
  npm install
fi

if [ ! -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then
  echo "Rebuilding native modules for this Electron version..."
  npx electron-rebuild -f -w better-sqlite3
fi

echo "Starting Mien..."
npm run dev
