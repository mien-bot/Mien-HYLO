# Mien setup script for Windows (no admin required)
# Run this from inside an extracted Mien source folder:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# The script does NOT download Mien source itself - Mien lives in a private
# repo, so transfer the folder onto this machine first (Download ZIP from
# GitHub on a permissive machine, then OneDrive / USB / Teams over to this
# one). See SETUP.md section 1b for the source-transfer step.
$ErrorActionPreference = "Stop"

$MienHome    = "$env:USERPROFILE\.mien"
$SrcDir      = "$MienHome\src"
$ToolsDir    = "$MienHome\tools"
$NodeVersion = "20.18.1"
$NodeDir     = "$ToolsDir\node-v$NodeVersion-win-x64"
$NodeZipUrl  = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

function Info($msg) { Write-Host "  > " -ForegroundColor Cyan   -NoNewline; Write-Host $msg }
function Ok($msg)   { Write-Host "  + " -ForegroundColor Green  -NoNewline; Write-Host $msg }
function Warn($msg) { Write-Host "  ! " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Fail($msg) { Write-Host "  x " -ForegroundColor Red    -NoNewline; Write-Host $msg; exit 1 }

Write-Host ""
Write-Host "  Mien Setup" -ForegroundColor White
Write-Host "  -----------------------------"
Write-Host ""

New-Item -ItemType Directory -Path $MienHome -Force | Out-Null
New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null

# --- Node.js (>= 20) ---
$NodeOk = $false
$nodeVerOutput = ""
try { $nodeVerOutput = & node --version 2>$null } catch { $nodeVerOutput = "" }
if ($nodeVerOutput -match "^v(\d+)\.") {
    if ([int]$Matches[1] -ge 20) {
        $NodeOk = $true
        Ok "Node.js: $nodeVerOutput (already on PATH)"
    } else {
        Warn "Found Node $nodeVerOutput but need >= v20. Installing v$NodeVersion alongside..."
    }
}

if (-not $NodeOk) {
    if (Test-Path "$NodeDir\node.exe") {
        Ok "Node.js already extracted at $NodeDir"
    } else {
        Info "Downloading Node.js v$NodeVersion (~30 MB, no admin needed)..."
        $NodeZip = "$ToolsDir\node.zip"
        try {
            Invoke-WebRequest -Uri $NodeZipUrl -OutFile $NodeZip -UseBasicParsing
        } catch {
            Fail "Could not download Node.js. If you are behind a corporate proxy, set HTTPS_PROXY and re-run."
        }
        Info "Extracting Node.js..."
        Expand-Archive -Path $NodeZip -DestinationPath $ToolsDir -Force
        Remove-Item $NodeZip -Force
        Ok "Node.js extracted to $NodeDir"
    }

    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($null -eq $userPath) { $userPath = "" }
    if ($userPath -notlike "*$NodeDir*") {
        [Environment]::SetEnvironmentVariable("PATH", "$NodeDir;$userPath", "User")
        Ok "Added Node.js to your User PATH (new terminals will pick it up)"
    } else {
        Ok "Node.js already on User PATH"
    }
    $env:PATH = "$NodeDir;$env:PATH"
}

# --- Resolve Mien source ---
# The installer never reaches GitHub; the user must transfer the source folder
# onto this machine first (Mien is a private repo). We prefer the folder this
# script lives in; fall back to $SrcDir if a previous run was extracted there.
function Test-MienSource($path) {
    $pkg = Join-Path $path "package.json"
    if (-not (Test-Path $pkg)) { return $false }
    try {
        $json = Get-Content $pkg -Raw | ConvertFrom-Json
        return ($json.name -eq "mien")
    } catch { return $false }
}

if ($PSScriptRoot -and (Test-MienSource $PSScriptRoot)) {
    $SrcDir = $PSScriptRoot
    Ok "Source: $SrcDir (running from extracted folder)"
} elseif ((Test-Path $SrcDir) -and (Test-MienSource $SrcDir)) {
    Ok "Source: $SrcDir (from previous run)"
} else {
    Warn "Mien source not found."
    Write-Host "    Transfer the Mien source folder to this machine first," -ForegroundColor Yellow
    Write-Host "    then re-run this script from inside that folder." -ForegroundColor Yellow
    Write-Host "    See SETUP.md section 1b for transfer options (Download ZIP" -ForegroundColor Yellow
    Write-Host "    from GitHub, OneDrive, USB, git archive, etc.)." -ForegroundColor Yellow
    Fail "No source at $SrcDir and not running from a Mien checkout."
}

# --- npm install + native rebuild ---
Push-Location $SrcDir
try {
    Info "Installing dependencies (first run can take a few minutes)..."
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Warn "npm install failed."
        Write-Host "    Common fixes on locked-down machines:" -ForegroundColor Yellow
        Write-Host "      - Corporate proxy: npm config set proxy http://proxy.example.com:8080" -ForegroundColor Yellow
        Write-Host "      - Defender quarantining node.exe: Add-MpPreference -ExclusionPath $ToolsDir" -ForegroundColor Yellow
        Fail "Resolve the issue above, then re-run the installer."
    }
    Ok "Dependencies installed"

    # better-sqlite3 ships a prebuilt .node compiled for Node.js's ABI, so the
    # file exists post-install but is the wrong ABI for Electron. Always rebuild.
    Info "Rebuilding better-sqlite3 for Electron's ABI..."
    & npx electron-rebuild -f -w better-sqlite3
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Warn "electron-rebuild failed."
        Write-Host "    This is the one step SETUP.md warns about: the prebuilt better-sqlite3" -ForegroundColor Yellow
        Write-Host "    binary for this Electron version may be unavailable, and the fallback" -ForegroundColor Yellow
        Write-Host "    compile needs Visual Studio Build Tools (rare on locked-down machines)." -ForegroundColor Yellow
        Write-Host "    Workaround: run setup.ps1 once on a permissive machine, then copy" -ForegroundColor Yellow
        Write-Host "    %USERPROFILE%\.mien\src\node_modules\better-sqlite3 to this machine." -ForegroundColor Yellow
        Fail "Native rebuild blocked."
    }
    Ok "better-sqlite3 rebuilt for Electron"
} finally {
    Pop-Location
}

# --- Resolve npm.cmd path for the launcher ---
$NpmCmd = $null
if ($NodeOk) {
    $whereOut = & where.exe npm.cmd 2>$null
    if ($whereOut) { $NpmCmd = ($whereOut | Select-Object -First 1) }
}
if (-not $NpmCmd) {
    $NpmCmd = "$NodeDir\npm.cmd"
}

# --- Emit launcher (silent, no console window) ---
$LaunchVbs = "$MienHome\launch.vbs"
$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$SrcDir"
WshShell.Run """$NpmCmd"" run dev", 0, False
"@
Set-Content -Path $LaunchVbs -Value $vbsContent -Encoding ASCII
Ok "Launcher: $LaunchVbs"

# --- Desktop + Start Menu shortcuts ---
$IconPath = "$SrcDir\resources\icon.ico"
$DesktopLnk   = "$([Environment]::GetFolderPath('Desktop'))\Mien.lnk"
$StartMenuLnk = "$([Environment]::GetFolderPath('Programs'))\Mien.lnk"

$WshShell = New-Object -ComObject WScript.Shell
foreach ($lnk in @($DesktopLnk, $StartMenuLnk)) {
    $sc = $WshShell.CreateShortcut($lnk)
    $sc.TargetPath = "wscript.exe"
    $sc.Arguments = "`"$LaunchVbs`""
    $sc.WorkingDirectory = $SrcDir
    if (Test-Path $IconPath) { $sc.IconLocation = "$IconPath, 0" }
    $sc.Description = "Mien - Personal Dashboard"
    $sc.WindowStyle = 7
    $sc.Save()
}
Ok "Shortcuts: Desktop + Start Menu"

# --- Done ---
Write-Host ""
Write-Host "  Mien is ready." -ForegroundColor Green
Write-Host ""
Write-Host "     Launch:  double-click 'Mien' on your Desktop or in the Start Menu"
Write-Host "     Source:  $SrcDir"
Write-Host ""
Write-Host "  Next step - wire to your home relay:" -ForegroundColor Yellow
Write-Host "     1. Open Mien, click the gear icon (Settings)."
Write-Host "     2. Under AI Connection, paste:"
Write-Host "          Relay Server URL  =  your home relay's Cloudflare tunnel URL"
Write-Host "          Relay Auth Token  =  contents of relay/relay.key on your home machine"
Write-Host "     3. Save. The Chat page should respond on the next message."
Write-Host ""
Write-Host "     Full details: $SrcDir\SETUP.md (section 1b)"
Write-Host ""

if ($Host.Name -eq "ConsoleHost") {
    Write-Host "  Press any key to close..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
