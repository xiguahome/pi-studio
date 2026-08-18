; Custom NSIS hooks for pi-studio (nsis.include in electron-builder.yml).
;
; Replaces electron-builder's stock "app is running" check. The stock
; _CHECK_APP_RUNNING macro (allowOnlyOneInstallerInstance.nsh):
;   1. scans EVERY process whose executable lives under $INSTDIR — that
;      includes pi-studio's node-runtime node.exe server, not just
;      pi-studio.exe;
;   2. tries a graceful close, then a force kill, and if anything still
;      matches it pops the "pi-studio 无法关闭 / 重试" MessageBox with no
;      automatic recovery — on this app the old-uninstaller pass ran for
;      1-2 minutes (deleting the runtime-installed node_modules), so any
;      INSTDIR process appearing in that window traps the update forever.
;
; Replaced with a single silent force-close of everything running from
; $INSTDIR. In-app updates spawn this installer WITHOUT /S (the assisted
; wizard is the update UI — it auto-skips the mode/directory pages on
; update), so by the time the wizard appears this app is usually already
; gone; this mainly catches leftovers (node server) and protects MANUAL
; double-click installs while the app happens to be running. No dialogs,
; ever.
;
; NOTE: do NOT SetSilent here — assisted mode needs its pages (directory
; choice) for manual first installs; in-app updates are silent via /S.

!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "Get-CimInstance Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith('$INSTDIR','CurrentCultureIgnoreCase') } | %% { Stop-Process -Id $$_.ProcessId -Force }"`
  Sleep 500
!macroend
