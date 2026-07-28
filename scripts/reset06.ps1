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
#           ssh keys, harness scripts (shot06.ps1/click06.ps1/...), harness schtasks,
#           and the Frondose-owned Chrome profile (~/.frondose/agent/chrome-profile):
#           the LinkedIn login in it is a MANUAL environment prerequisite (like ssh
#           keys), not product state — wiping it forces a human re-login before any
#           LinkedIn live verification. The profile is moved aside before the wipe
#           and moved back after. Pass -WipeProfile for a true full wipe (loses the
#           LinkedIn session; use when fresh-profile first-run coverage is wanted).
param([switch]$WipeProfile)
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

# 2.5 Preserve the Frondose-owned Chrome profile (holds the manual LinkedIn login —
#     an environment prerequisite, not product state) unless -WipeProfile was passed.
#     Move aside to a sibling backup outside ~/.frondose; step 4.5 moves it back.
$profileDir = Join-Path $stateDir 'agent\chrome-profile'
$backupRoot = Join-Path $env:USERPROFILE '.frondose-reset-backup'
$backupDir  = Join-Path $backupRoot 'chrome-profile'
$preserveProfile = (-not $WipeProfile) -and (Test-Path $profileDir)
if ($preserveProfile) {
  Remove-Item -Recurse -Force $backupRoot
  New-Item -ItemType Directory -Force $backupRoot | Out-Null
  Move-Item $profileDir $backupDir
  # Fail hard BEFORE wiping anything: a failed move + a wipe would silently lose the login.
  if (-not (Test-Path $backupDir)) { Write-Output 'RESET_FAIL:profile-preserve'; exit 1 }
} elseif ($WipeProfile) {
  Remove-Item -Recurse -Force $backupRoot
}

# 3. Silent-uninstall via the NSIS uninstaller when present, then remove leftovers.
$uninstall = Join-Path $installDir 'Uninstall Frondose.exe'
if (Test-Path $uninstall) { Start-Process $uninstall -ArgumentList '/S' -Wait }
Remove-Item -Recurse -Force $installDir

# 4. Wipe user state (config.json, agent/secrets.json, audit.jsonl, sqlite, webview data).
Remove-Item -Recurse -Force $stateDir
Remove-Item -Recurse -Force $appDataDir

# 4.5 Restore the preserved Chrome profile.
if ($preserveProfile) {
  New-Item -ItemType Directory -Force (Join-Path $stateDir 'agent') | Out-Null
  Move-Item $backupDir $profileDir
  Remove-Item -Recurse -Force $backupRoot
  if (-not (Test-Path $profileDir)) { Write-Output 'RESET_FAIL:profile-restore'; exit 1 }
}

# 5. Installer-dropped shortcuts.
Remove-Item -Force (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Frondose.lnk')
Remove-Item -Force (Join-Path $env:USERPROFILE 'Desktop\Frondose.lnk')

# 6. Verify clean. With a preserved profile, ~/.frondose may contain ONLY
#    agent/chrome-profile (restored in step 4.5) — anything else is a dirty wipe.
$left = @()
if (Test-Path $installDir) { $left += 'install' }
if (Test-Path $appDataDir) { $left += 'appdata' }
if (Test-Path $stateDir) {
  if ($preserveProfile) {
    $stateJunk = @(Get-ChildItem -Force $stateDir | Where-Object { $_.Name -ne 'agent' })
    $agentJunk = @(Get-ChildItem -Force (Join-Path $stateDir 'agent') | Where-Object { $_.Name -ne 'chrome-profile' })
    if ($stateJunk.Count -gt 0 -or $agentJunk.Count -gt 0) { $left += 'state' }
  } else {
    $left += 'state'
  }
}
if (Test-Path $backupRoot) { $left += 'profile-backup' }
if ($left.Count -gt 0) { Write-Output ('RESET_FAIL:' + ($left -join ',')) } else { Write-Output 'RESET_OK' }
