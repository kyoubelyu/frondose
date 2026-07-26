# reset06.ps1 — return the box to a first-use-clean Frondose state.
#
# Purpose: before box-smoke / first-install live verification (release.sh RESET_BOX=1,
# or manually: `ssh <box> "powershell -NoProfile -ExecutionPolicy Bypass -File reset06.ps1"`),
# wipe every trace of Frondose so the next install exercises a TRUE first-use machine
# (onboarding, ICP gate, embedded-key backfill, first auto-update baseline).
#
# Removes: Frondose.exe + bundled node sidecar processes, the per-user install
#          (%LOCALAPPDATA%\Frondose — Tauri NSIS currentUser), all user state
#          (~/.frondose, %APPDATA%\com.kyoube.frondose), installer shortcuts.
# Keeps:    WebView2 (system runtime — the embedded offline installer covers fresh
#           machines; uninstalling it tests Microsoft's network, not Frondose),
#           ssh keys, harness scripts (shot06.ps1/click06.ps1/...), harness schtasks.
$ErrorActionPreference = 'SilentlyContinue'

$installDir = Join-Path $env:LOCALAPPDATA 'Frondose'
$stateDir   = Join-Path $env:USERPROFILE '.frondose'
$appDataDir = Join-Path $env:APPDATA 'com.kyoube.frondose'

# 1. Stop Frondose.exe + the bundled node sidecar (filter by install path — the box
#    may be shared; never kill by bare process name).
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. Stop the Frondose-driven Chrome (its profile dir lives under ~/.frondose).
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine -like '*\.frondose\*'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

# 3. Silent-uninstall via the NSIS uninstaller when present, then remove leftovers.
$uninstall = Join-Path $installDir 'Uninstall Frondose.exe'
if (Test-Path $uninstall) { Start-Process $uninstall -ArgumentList '/S' -Wait }
Remove-Item -Recurse -Force $installDir

# 4. Wipe user state (config.json, agent/secrets.json, audit.jsonl, sqlite, webview data).
Remove-Item -Recurse -Force $stateDir
Remove-Item -Recurse -Force $appDataDir

# 5. Installer-dropped shortcuts.
Remove-Item -Force (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Frondose.lnk')
Remove-Item -Force (Join-Path $env:USERPROFILE 'Desktop\Frondose.lnk')

# 6. Verify clean.
$left = @()
if (Test-Path $installDir) { $left += 'install' }
if (Test-Path $stateDir)   { $left += 'state' }
if (Test-Path $appDataDir) { $left += 'appdata' }
if ($left.Count -gt 0) { Write-Output ('RESET_FAIL:' + ($left -join ',')) } else { Write-Output 'RESET_OK' }
