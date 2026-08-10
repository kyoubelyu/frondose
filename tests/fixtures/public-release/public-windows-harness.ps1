param(
  [Parameter(Mandatory = $true)][string]$Scenario,
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Receipt
)

$ErrorActionPreference = "Stop"
$events = [ordered]@{
  commands = @()
  import = $null
  importedThumbprint = "A1B2C3D4E5F60708"
  tauriArgs = @()
  tauriConfig = $null
  authenticodePaths = @()
  authenticodeStatus = if ($Scenario -eq "non-valid") { "UnknownError" } else { "Valid" }
  copied = @()
  removals = @()
}
$targetRoot = Join-Path $Root "target"
$outputRoot = Join-Path $Root "output"
$installer = Join-Path $targetRoot "x86_64-pc-windows-msvc\release\bundle\nsis\Frondose_0.5.19_x64-setup.exe"
$updaterSignature = "$installer.sig"

function Get-Command {
  param([string]$Name, [Parameter(ValueFromRemainingArguments = $true)]$Rest)
  $events.commands += "Get-Command $Name"
  $scenarioName = $Name -replace "\.cmd$", ""
  if ($Scenario -eq "missing-tool-$scenarioName") { return $null }
  return [pscustomobject]@{ Name = $Name; Source = "fixture" }
}

function Import-PfxCertificate {
  param([string]$FilePath, [string]$CertStoreLocation, $Password)
  $events.commands += "Import-PfxCertificate"
  $events.import = [ordered]@{ filePath = $FilePath; store = $CertStoreLocation; fileExisted = (Test-Path $FilePath) }
  $eku = if ($Scenario -eq "wrong-eku") { "1.3.6.1.5.5.7.3.2" } else { "1.3.6.1.5.5.7.3.3" }
  return [pscustomobject]@{
    Thumbprint = $events.importedThumbprint
    HasPrivateKey = ($Scenario -ne "no-private-key")
    EnhancedKeyUsageList = @([pscustomobject]@{ ObjectId = [pscustomobject]@{ Value = $eku } })
    PSPath = "Cert:\CurrentUser\My\$($events.importedThumbprint)"
  }
}

function npx.cmd {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Args)
  $events.commands += "npx $($Args -join ' ')"
  $events.tauriArgs = @($Args | ForEach-Object { "$_" })
  $configIndex = [Array]::IndexOf($events.tauriArgs, "--config")
  if ($configIndex -ge 0) {
    $configPath = $events.tauriArgs[$configIndex + 1]
    if (Test-Path $configPath) { $events.tauriConfig = Get-Content -Raw $configPath | ConvertFrom-Json }
  }
  if ($Scenario -eq "build-failure") { throw "injected build failure" }
  New-Item -ItemType Directory -Force (Split-Path $installer) | Out-Null
  [IO.File]::WriteAllBytes($installer, [Text.Encoding]::UTF8.GetBytes("authenticode fixture installer"))
  [IO.File]::WriteAllBytes($updaterSignature, [Text.Encoding]::UTF8.GetBytes("fixture updater signature"))
}

function npm.cmd {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Args)
  $events.commands += "npm $($Args -join ' ')"
}

function cargo {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Args)
  $events.commands += "cargo $($Args -join ' ')"
  if ($Scenario -eq "updater-verification-failure") { throw "injected updater verification failure" }
}

function Get-AuthenticodeSignature {
  param([string]$FilePath)
  $events.commands += "Get-AuthenticodeSignature $FilePath"
  $events.authenticodePaths += $FilePath
  if ($Scenario -eq "verification-failure") { throw "injected verification command failure" }
  return [pscustomobject]@{ Status = $events.authenticodeStatus }
}

function Copy-Item {
  param([string]$LiteralPath, [string]$Destination, [switch]$Force)
  $events.commands += "Copy-Item $LiteralPath $Destination"
  $events.copied += [ordered]@{ source = $LiteralPath; destination = $Destination }
  if ($Scenario -eq "upload-failure") { throw "injected normalization failure" }
  Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}

function Remove-Item {
  param([string]$LiteralPath, [switch]$Force, [switch]$Recurse)
  $events.commands += "Remove-Item $LiteralPath"
  $events.removals += $LiteralPath
  if (Test-Path $LiteralPath) {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force:$Force -Recurse:$Recurse
  }
}

$env:WINDOWS_CERTIFICATE = if ($Scenario -eq "missing-pfx") { "" } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("fixture-pfx-secret")) }
$env:WINDOWS_CERTIFICATE_PASSWORD = if ($Scenario -eq "missing-password") { "" } else { "fixture-password-secret" }
$env:TAURI_SIGNING_PRIVATE_KEY = if ($Scenario -eq "missing-updater-key") { "" } else { "fixture-updater-secret" }
$env:WINDOWS_TIMESTAMP_URL = if ($Scenario -eq "missing-timestamp") { "" } else { "https://timestamp.digicert.com" }
$env:CARGO_TARGET_DIR = $targetRoot
$env:FRONDOSE_PUBLIC_OUTPUT_DIR = $outputRoot

$exitCode = 0
try {
  . $Script
} catch {
  $exitCode = 1
} finally {
  $events | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $Receipt
}
exit $exitCode
