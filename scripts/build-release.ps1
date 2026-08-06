# WIN-3 F-3: Windows self-contained release build (the Windows analogue of
# build-release.sh — bash/macOS-only). Produces the NSIS installer with the
# bundled Node runtime, so the installed app is open-and-use (no Node needed).
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
#   (from the repo root, on Windows; requires git/Node/npm + Rust+MSVC + WebView2)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$siteDir = if ($env:FRONDOSE_SITE_DIR) { $env:FRONDOSE_SITE_DIR } elseif ($env:MAI_SITE_DIR) { $env:MAI_SITE_DIR } else { Join-Path $HOME ".frondose\site" }
$updateServerUrl = if ($env:UPDATE_SERVER_URL) { $env:UPDATE_SERVER_URL.TrimEnd("/") } else { "http://localhost:4875" }

# 0. Preflight — make the build robust on a China-LAN box behind Clash/mihomo
# (P-RELEASE-SH-WIN-GAP). Two failure modes this clears so `release.sh` runs
# unattended end-to-end:
#   (a) Build tools (curl for the Node zip, prebuild-install for the better-sqlite3
#       native prebuild, npm, WebView2 fetch) honor the HTTP(S)_PROXY env but NOT
#       the Windows *system* proxy — so direct fetches to nodejs.org/github get
#       blocked. Route them through the running Clash/mihomo proxy. Opt out /
#       override with FRONDOSE_WIN_PROXY; set it to "" to disable proxying.
#   (b) NSIS bundling fails with `os error 10055` (WSAENOBUFS) when the ephemeral
#       port range is exhausted — the mihomo core does not leak continuously, but
#       stray Frondose/Chrome/WebView2/orphan-node processes accumulate sockets
#       over a session. Kill those hoggers (never this build's node) + widen the
#       ephemeral range. If the proxy is unreachable, fail fast with a clear msg
#       (so the operator restarts Clash Verge) instead of a cryptic mid-build error.
if ($null -eq $env:FRONDOSE_WIN_PROXY) {
  $sysProxy = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue).ProxyServer
  $proxy = if ($sysProxy) { if ($sysProxy -match '://') { $sysProxy } else { "http://$sysProxy" } } else { "http://127.0.0.1:7897" }
} else {
  $proxy = $env:FRONDOSE_WIN_PROXY
}
# NOTE: the proxy env is applied ONLY around the runtime-assembly step below (which
# fetches the Node zip + better-sqlite3 prebuild + npm deps) — NOT globally. Setting
# HTTP(S)_PROXY for the whole build makes `npm run build`'s build:native (node-gyp)
# HANG on the China-LAN box (header fetch / WindowsApps python stub) instead of the
# fast `|| echo skipped` fallback. So verify reachability here, but scope the env narrowly.
if ($proxy) {
  Write-Host "[build-release.ps1] preflight: runtime-assembly fetches will use proxy $proxy"
  try {
    Invoke-WebRequest -Uri "https://nodejs.org" -Method Head -UseBasicParsing -TimeoutSec 20 -Proxy $proxy | Out-Null
    Write-Host "[build-release.ps1] preflight: proxy reachable (nodejs.org 200)"
  } catch {
    throw "[build-release.ps1] preflight: proxy $proxy cannot reach nodejs.org — is Clash Verge/mihomo running? Restart it and retry. ($($_.Exception.Message))"
  }
} else {
  Write-Host "[build-release.ps1] preflight: FRONDOSE_WIN_PROXY='' — no proxy (direct fetches)"
}
Get-Process Frondose,chrome,msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -like '*runtime\node.exe' -or $_.ExecutablePath -like '*AppData\Local\Frondose*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
& netsh int ipv4 set dynamicport tcp start=10000 num=55000 | Out-Null
Write-Host "[build-release.ps1] preflight: killed stray socket hoggers + widened ephemeral port range"

# 1. Compile dist (tsc + web + tauri-ui; the WIN-2 cross-platform npm scripts).
# Run inside Start-Job. Without it, the nested `npm run build` → `npm run build:web`
# → cmd.exe → esbuild chain HANGS forever at build:web when this script runs with no
# console/pty (over ssh via release.sh, or a detached scheduled task): a child process
# inherits a broken stdin handle and blocks reading it. A bare `$null |` pipe only
# fixes the OUTERMOST npm.cmd's stdin, not the nested children. Start-Job gives the
# ENTIRE process tree valid job stdio, so the chain runs to completion. Proven on
# win-build-host 2026-07-03: direct `npm run build` over ssh hangs indefinitely at
# build:web; the identical command inside Start-Job completes exit 0.
Push-Location $root
$buildJob = Start-Job -ScriptBlock {
  param($r)
  Set-Location $r
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $env:FRONDOSE_DEFAULT_LLM_BASEURL = $using:env:FRONDOSE_DEFAULT_LLM_BASEURL
  $env:FRONDOSE_DEFAULT_LLM_MODEL   = $using:env:FRONDOSE_DEFAULT_LLM_MODEL
  $env:FRONDOSE_DEFAULT_LLM_KEY     = $using:env:FRONDOSE_DEFAULT_LLM_KEY
  & npm run build 2>&1
  "BUILD_JOB_EXIT=$LASTEXITCODE"
} -ArgumentList $root
$buildJob | Wait-Job -Timeout 900 | Out-Null
$buildOut = Receive-Job $buildJob
$buildOut | ForEach-Object { Write-Host $_ }
Remove-Job $buildJob -Force -ErrorAction SilentlyContinue
if (-not ($buildOut -match 'BUILD_JOB_EXIT=0')) { throw "npm run build failed or timed out (see output above)" }

# 2. Assemble the self-contained Windows runtime into build/runtime/ — THIS step
# fetches the Node zip (curl) + better-sqlite3 prebuild (prebuild-install) + prod
# deps (npm ci), which need the proxy on the China-LAN box. Scope HTTP(S)_PROXY to
# just this call (see the preflight note) so the dist build above stays proxy-free.
if ($proxy) { $env:HTTP_PROXY = $proxy; $env:HTTPS_PROXY = $proxy; $env:http_proxy = $proxy; $env:https_proxy = $proxy }
node "$PSScriptRoot\build-runtime-windows.mjs"
$runtimeExit = $LASTEXITCODE
if ($proxy) { Remove-Item Env:\HTTP_PROXY,Env:\HTTPS_PROXY,Env:\http_proxy,Env:\https_proxy -ErrorAction SilentlyContinue }
if ($runtimeExit -ne 0) { throw "build-runtime-windows failed" }
Pop-Location

# 3. Tauri bundle → Frondose_<ver>_x64-setup.exe (NSIS). Unlike `npm run build`,
# `npx tauri build` (cargo + makensis) does NOT read stdin, so it runs fine over
# ssh/detached without the Start-Job workaround (proven by the 0.5.0/0.5.1 builds).
Push-Location "$root\src\tauri\src-tauri"
npx tauri build --target x86_64-pc-windows-msvc --bundles nsis
$tauriExitCode = $LASTEXITCODE
Pop-Location

# Tauri emits the NSIS installer before optional updater signing. The current
# Windows box may lack TAURI_SIGNING_PRIVATE_KEY, so installer-present remains a
# useful artifact, but WIN-5 only publishes a Windows updater entry when a signed
# updater artifact + .sig exist.
$nsis = "$root\src\tauri\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
$installer = Get-ChildItem -Path "$nsis\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $installer) { throw "tauri build did not produce an NSIS installer (check the log above)" }
Write-Host "[build-release.ps1] OK — installer: $($installer.FullName) ($([math]::Round($installer.Length/1MB,1)) MB)"

$downloadsDir = Join-Path $siteDir "downloads"
New-Item -ItemType Directory -Force -Path $downloadsDir | Out-Null

$publishedInstaller = Join-Path $downloadsDir "Frondose-windows-x86_64-setup.exe"
Copy-Item -Force $installer.FullName $publishedInstaller
Copy-Item -Force (Join-Path $root "website\frondose-landing.html") (Join-Path $siteDir "index.html")
Write-Host "[build-release.ps1] published Windows installer: $publishedInstaller"

$signedUpdater = $null
$signedUpdaterSig = $null
foreach ($candidate in @(
  "$($installer.FullName).zip",
  "$($installer.FullName)"
)) {
  $candidateSig = "$candidate.sig"
  if ((Test-Path $candidate) -and (Test-Path $candidateSig)) {
    $signedUpdater = Get-Item $candidate
    $signedUpdaterSig = Get-Item $candidateSig
    break
  }
}

$latestJson = Join-Path $siteDir "latest.json"
$macSig = Join-Path $downloadsDir "Frondose.app.tar.gz.sig"
$macUrl = "$updateServerUrl/downloads/Frondose.app.tar.gz"
$rootFwd = $root -replace '\\','/'  # backslashes in a JS string literal corrupt the path (\U/\b/\f escapes); use forward slashes
$env:VERSION = (node -p "require('$rootFwd/package.json').version")
$env:OUT_PATH = $latestJson
if (Test-Path $macSig) {
  $env:SIG_PATH = $macSig
  $env:MANIFEST_URL = $macUrl
} else {
  Remove-Item Env:\SIG_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:\MANIFEST_URL -ErrorAction SilentlyContinue
  Write-Warning "[build-release.ps1] macOS updater artifact not found in site; latest.json will contain Windows only unless macOS artifacts are published first"
}

if ($signedUpdater -and $signedUpdaterSig) {
  $publishedUpdaterName = if ($signedUpdater.Name.EndsWith(".zip")) { "Frondose-windows-x86_64-setup.exe.zip" } else { "Frondose-windows-x86_64-setup.exe" }
  $publishedUpdater = Join-Path $downloadsDir $publishedUpdaterName
  $publishedUpdaterSig = "$publishedUpdater.sig"
  Copy-Item -Force $signedUpdater.FullName $publishedUpdater
  Copy-Item -Force $signedUpdaterSig.FullName $publishedUpdaterSig
  $env:WINDOWS_SIG_PATH = $publishedUpdaterSig
  $env:WINDOWS_MANIFEST_URL = "$updateServerUrl/downloads/$publishedUpdaterName"
  node "$PSScriptRoot\gen-latest-json.mjs"
  if ($LASTEXITCODE -ne 0) { throw "gen-latest-json failed" }
  Write-Host "[build-release.ps1] latest.json includes windows-x86_64: $latestJson"
} else {
  Remove-Item Env:\WINDOWS_SIG_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:\WINDOWS_MANIFEST_URL -ErrorAction SilentlyContinue
  if ($env:TAURI_SIGNING_PRIVATE_KEY) {
    throw "TAURI_SIGNING_PRIVATE_KEY is set, but no signed Windows updater artifact + .sig was found under $nsis"
  }
  if ($tauriExitCode -ne 0) {
    Write-Warning "[build-release.ps1] tauri build exited $tauriExitCode; TAURI_SIGNING_PRIVATE_KEY is absent, so Windows updater .sig publication is deferred"
  } else {
    Write-Warning "[build-release.ps1] TAURI_SIGNING_PRIVATE_KEY is absent; Windows updater .sig publication is deferred"
  }
  if (Test-Path $macSig) {
    node "$PSScriptRoot\gen-latest-json.mjs"
    if ($LASTEXITCODE -ne 0) { throw "gen-latest-json failed" }
    Write-Warning "[build-release.ps1] latest.json regenerated with existing macOS entries only"
  }
}

Write-Host "[build-release.ps1] site populated at $siteDir (version $env:VERSION, url base: $updateServerUrl)"
