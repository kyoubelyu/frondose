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

# 1. Compile dist (tsc + web + tauri-ui; the WIN-2 cross-platform npm scripts).
Push-Location $root
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

# 2. Assemble the self-contained Windows runtime into build/runtime/.
node "$PSScriptRoot\build-runtime-windows.mjs"
if ($LASTEXITCODE -ne 0) { throw "build-runtime-windows failed" }
Pop-Location

# 3. Tauri bundle → Frondose_<ver>_x64-setup.exe (NSIS).
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
