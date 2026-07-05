@echo off
REM Mien — run from source on Windows.
REM Double-click this file. It walks back to the repo root, installs deps
REM if needed, rebuilds the SQLite native module on first run, and starts
REM the Electron dev server. Close the window to stop the app.

cd /d "%~dp0\.."

if not exist node_modules (
  echo Installing dependencies (one-time, ~2 min)...
  call npm install || goto :error
)

if not exist node_modules\better-sqlite3\build\Release\better_sqlite3.node (
  echo Rebuilding native modules for this Electron version...
  call npx electron-rebuild -f -w better-sqlite3 || goto :error
)

echo Starting Mien...
call npm run dev
goto :eof

:error
echo.
echo Something went wrong. Scroll up for the error. Common fixes:
echo   - Behind a corporate proxy? See SETUP.md "Common work-computer gotchas".
echo   - Need Node 20+? Run "node --version" to check.
pause
exit /b 1
