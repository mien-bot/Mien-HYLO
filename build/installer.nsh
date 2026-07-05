; Mien — custom NSIS hooks for the Windows installer.
;
; The default electron-builder template uninstalls the previous version by
; reading its registry entry. That registry entry is keyed by appId, so if
; an earlier install had a different appId (or none, or per-machine vs
; per-user), the old binaries stay on disk and the new install ends up
; sitting next to stale .asar / .dll / .exe files.
;
; These hooks belt-and-brace the cleanup: before placing new files, force
; the previous install dir empty regardless of how the previous install
; was registered.
;
; User data lives under %APPDATA%\Mien and is left untouched — settings and
; the SQLite database survive upgrades. Use deleteAppDataOnUninstall in
; electron-builder.json5 if you want that wiped on uninstall.

!macro customInit
  ; Stop any running Mien instance — RMDir /r below can't delete locked files.
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\Mien\Mien.exe"
    DetailPrint "Stopping running Mien instance..."
    nsExec::Exec 'taskkill /F /IM "Mien.exe" /T'
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES\Mien\Mien.exe"
    DetailPrint "Stopping running Mien instance (per-machine)..."
    nsExec::Exec 'taskkill /F /IM "Mien.exe" /T'
  ${EndIf}

  ; Run the previous uninstaller if we can find one — gives Windows a chance
  ; to deregister the old install cleanly (Add/Remove Programs entry, file
  ; associations, etc).
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\Mien\Uninstall Mien.exe"
    DetailPrint "Removing previous Mien install (per-user)..."
    ExecWait '"$LOCALAPPDATA\Programs\Mien\Uninstall Mien.exe" /S _?=$LOCALAPPDATA\Programs\Mien'
  ${EndIf}

  ; Force-remove any leftover program files that survived the uninstaller
  ; (or were left by a previous install with a different appId).
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\Mien"
    DetailPrint "Removing leftover Mien program files (per-user)..."
    RMDir /r "$LOCALAPPDATA\Programs\Mien"
  ${EndIf}
!macroend

!macro customUnInstall
  ; If anything survived the standard uninstall step (e.g. files newly
  ; created post-install that aren't tracked by NSIS), nuke them.
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\Mien"
    RMDir /r "$LOCALAPPDATA\Programs\Mien"
  ${EndIf}
!macroend
