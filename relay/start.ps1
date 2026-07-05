# ============================================================
# Mien Relay — Auto-restart startup script (Windows PowerShell)
#
# Keeps the relay server alive permanently. If it crashes,
# it restarts after a short backoff. Logs to relay.log.
#
# Usage:
#   .\start.ps1                           # local network
#   $env:TUNNEL="1"; .\start.ps1          # with Cloudflare tunnel
#
# To run in background (survives terminal close):
#   Start-Process powershell -ArgumentList "-File", ".\start.ps1" -WindowStyle Hidden
#
# To stop:
#   Get-Content relay-server.pid, relay.pid | ForEach-Object { Stop-Process -Id $_ -Force }
# ============================================================

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$LogFile = Join-Path $ScriptDir "relay.log"
$PidFile = Join-Path $ScriptDir "relay.pid"
$ServerPidFile = Join-Path $ScriptDir "relay-server.pid"
$MaxBackoff = 60
$Backoff = 1
$process = $null

# Write our PID
$PID | Out-File -FilePath $PidFile -Encoding ascii -NoNewline

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

function Stop-ExistingServerFromPidFile {
    if (-not (Test-Path $ServerPidFile)) { return }

    $oldPidText = (Get-Content -Path $ServerPidFile -Raw -ErrorAction SilentlyContinue).Trim()
    $oldPid = 0
    if ([int]::TryParse($oldPidText, [ref]$oldPid)) {
        $oldProcess = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($oldProcess -and $oldProcess.ProcessName -eq "node") {
            Write-Log "Stopping previous relay server process (PID $oldPid)"
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        }
    }

    Remove-Item $ServerPidFile -ErrorAction SilentlyContinue
}

function Append-ServerOutput {
    if (Test-Path "$ScriptDir\relay-stdout.tmp") {
        Get-Content "$ScriptDir\relay-stdout.tmp" | Add-Content -Path $LogFile
        Get-Content "$ScriptDir\relay-stdout.tmp" | Write-Host
        Remove-Item "$ScriptDir\relay-stdout.tmp" -ErrorAction SilentlyContinue
    }
    if (Test-Path "$ScriptDir\relay-stderr.tmp") {
        Get-Content "$ScriptDir\relay-stderr.tmp" | Add-Content -Path $LogFile
        Get-Content "$ScriptDir\relay-stderr.tmp" | Write-Host
        Remove-Item "$ScriptDir\relay-stderr.tmp" -ErrorAction SilentlyContinue
    }
}

Write-Log "Relay launcher started (PID $PID)"
Stop-ExistingServerFromPidFile

while ($true) {
    Write-Log "Starting relay server..."

    try {
        $process = Start-Process -FilePath "node" -ArgumentList "server.js" `
            -WorkingDirectory $ScriptDir `
            -NoNewWindow -PassThru `
            -RedirectStandardOutput "$ScriptDir\relay-stdout.tmp" `
            -RedirectStandardError "$ScriptDir\relay-stderr.tmp"

        $process.Id | Out-File -FilePath $ServerPidFile -Encoding ascii -NoNewline
        Write-Log "Relay server started (PID $($process.Id))"

        $process.WaitForExit()
        Append-ServerOutput
        Remove-Item $ServerPidFile -ErrorAction SilentlyContinue

        $ExitCode = $process.ExitCode

        if ($ExitCode -eq 0) {
            Write-Log "Server exited cleanly"
            break
        }

        Write-Log "Server crashed (exit $ExitCode). Restarting in ${Backoff}s..."
    }
    catch {
        Write-Log "Failed to start server: $_. Restarting in ${Backoff}s..."
    }

    Start-Sleep -Seconds $Backoff

    # Exponential backoff
    $Backoff = [Math]::Min($Backoff * 2, $MaxBackoff)
}

Remove-Item $PidFile, $ServerPidFile -ErrorAction SilentlyContinue
Write-Log "Relay launcher stopped"
