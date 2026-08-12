$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# P-RELEASE-SIGN-ADHOC: minisign updater key only — no Authenticode certificate required.
$requiredEnvironment = @("TAURI_SIGNING_PRIVATE_KEY")
foreach ($name in $requiredEnvironment) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) { throw "[public-windows] required environment variable is missing: $name" }
}
foreach ($tool in @("node", "npm.cmd", "npx.cmd", "cargo", "7z")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "[public-windows] required tool is missing: $tool" }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$targetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repoRoot "src\tauri\src-tauri\target" }
$outputRoot = if ($env:FRONDOSE_PUBLIC_OUTPUT_DIR) { $env:FRONDOSE_PUBLIC_OUTPUT_DIR } else { Join-Path $repoRoot "build\public-windows" }
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("frondose-public-windows-" + [Guid]::NewGuid().ToString("N"))
$configPath = Join-Path $repoRoot "src\tauri\src-tauri\tauri.public.conf.json"

try {
  New-Item -ItemType Directory -Force $temporaryRoot | Out-Null

  Push-Location $repoRoot
  try {
    npm.cmd run build:tauri:public
    npm.cmd run build:runtime:public:windows
  } finally {
    Pop-Location
  }
  Push-Location (Join-Path $repoRoot "src\tauri\src-tauri")
  try {
    npx.cmd tauri build --config $configPath --target x86_64-pc-windows-msvc
  } finally {
    Pop-Location
  }

  $package = Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json
  $installerRoot = Join-Path $targetRoot "x86_64-pc-windows-msvc\release\bundle\nsis"
  $expectedName = "Frondose_$($package.version)_x64-setup.exe"
  $installers = @(Get-ChildItem -LiteralPath $installerRoot -File -Filter "Frondose_*_x64-setup.exe")
  if ($installers.Count -ne 1 -or $installers[0].Name -ne $expectedName) {
    throw "[public-windows] expected exactly one current-version NSIS installer"
  }
  $installer = $installers[0].FullName
  $updaterSignature = "$installer.sig"
  $updaterSignatures = @(Get-ChildItem -LiteralPath $installerRoot -File -Filter "Frondose_*.exe.sig")
  if ($updaterSignatures.Count -ne 1 -or $updaterSignatures[0].FullName -ne $updaterSignature) {
    throw "[public-windows] expected exactly one matching updater signature"
  }
  # P-RELEASE-SIGN-ADHOC: no Authenticode check — updater minisign pairs are the load-bearing check.
  $tauriConfig = Get-Content -Raw (Join-Path $repoRoot "src\tauri\src-tauri\tauri.conf.json") | ConvertFrom-Json
  $publicKeyText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($tauriConfig.plugins.updater.pubkey))
  $updaterPublicKey = ($publicKeyText -split "`r?`n")[1]
  cargo run --quiet --release --manifest-path (Join-Path $repoRoot "scripts\updater-verifier\Cargo.toml")
  $verifier = Join-Path $repoRoot "scripts\updater-verifier\target\release\frondose-updater-verifier"
  if (-not (Test-Path $verifier)) { throw "[public-windows] updater verifier binary missing" }
  & $verifier $updaterPublicKey $installer $updaterSignature
  if ($LASTEXITCODE -ne 0) { throw "[public-windows] updater signature verification failed" }

  if (Test-Path $outputRoot) { Remove-Item -LiteralPath $outputRoot -Recurse -Force }
  New-Item -ItemType Directory -Force $outputRoot | Out-Null
  Copy-Item -LiteralPath $installer -Destination (Join-Path $outputRoot "Frondose.nsis.exe") -Force
  Copy-Item -LiteralPath $updaterSignature -Destination (Join-Path $outputRoot "Frondose.nsis.exe.sig") -Force
  $manifest = [ordered]@{
    platform = "windows-x86_64"
    files = @("Frondose.nsis.exe", "Frondose.nsis.exe.sig")
    sha256 = [ordered]@{ windowsExe = (Get-FileHash -Algorithm SHA256 (Join-Path $outputRoot "Frondose.nsis.exe")).Hash.ToLowerInvariant() }
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $outputRoot "verified-producer-manifest.json")
} catch {
  if (Test-Path $outputRoot) { Remove-Item -LiteralPath $outputRoot -Recurse -Force }
  throw
} finally {
  if (Test-Path $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
