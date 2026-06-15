# WIN-3 F-3: Windows self-contained release build (the Windows analogue of
# build-release.sh — bash/macOS-only). Produces the NSIS installer with the
# bundled Node runtime, so the installed app is open-and-use (no Node needed).
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
#   (from the repo root, on Windows; requires git/Node/npm + Rust+MSVC + WebView2)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

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
Pop-Location

# The NSIS installer is produced BEFORE tauri's (optional) updater-artifact signing,
# which fails on a box without TAURI_SIGNING_PRIVATE_KEY and makes `tauri build` exit
# non-zero. The installer is the WIN-3 deliverable; the .sig auto-updater is WIN-5.
# So: treat installer-present as success, not the exit code.
$nsis = "$root\src\tauri\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
$installer = Get-ChildItem -Path "$nsis\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $installer) { throw "tauri build did not produce an NSIS installer (check the log above)" }
Write-Host "[build-release.ps1] OK — installer: $($installer.FullName) ($([math]::Round($installer.Length/1MB,1)) MB)"
