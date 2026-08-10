#!/usr/bin/env bash
if [[ -n "${FRONDOSE_PUBLIC_BUILD:-}" || -n "${FRONDOSE_REQUIRE_NATIVE_SIGNING:-}" ]]; then
  echo "[build-release-win-mac] private-only cross-build; public native release is forbidden" >&2
  exit 64
fi
# P-RELEASE-SH-WIN-GAP — cross-compile the SIGNED Windows NSIS installer entirely on
# macOS (cargo-xwin), so `release.sh` needs no Windows build host. Spike-proven +
# box-smoke-tested 2026-07-04: a Mac-cross-built setup.exe installs + runs full-stack
# (Rust app + node sidecar + WebView2) on real Windows. Tauri's own "cross-compilation
# is experimental" warning stands → release.sh keeps an OPTIONAL box smoke-test gate.
#
# Produces: build/runtime/ (win-x64) → Frondose_<ver>_x64-setup.exe + updater .sig,
# published into $SITE_DIR/downloads/ as Frondose-windows-x86_64-setup.exe(.sig).
#
# One-time host setup (idempotent checks below):
#   rustup target add x86_64-pc-windows-msvc
#   cargo install --locked cargo-xwin
#   brew install llvm lld makensis
# First cargo-xwin run caches ~1.1GB MSVC CRT+SDK under ~/Library/Caches/cargo-xwin/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

KEY_FILE="${TAURI_KEY_FILE:-$HOME/.tauri/frondose.key}"
SITE_DIR="${FRONDOSE_SITE_DIR:-${MAI_SITE_DIR:-$HOME/.frondose/site}}"
TARGET="x86_64-pc-windows-msvc"
# China-LAN / Microsoft-CDN-blocked hosts: the MSVC SDK + WebView2 fetches need the
# system proxy. Auto-detect Clash/mihomo; override with FRONDOSE_WIN_PROXY ("" disables).
PROXY="${FRONDOSE_WIN_PROXY-http://127.0.0.1:7897}"

die() { echo "[build-win-mac] ERROR: $*" >&2; exit 1; }

# ── Preflight: toolchain present? (fail with the exact install command) ──
command -v cargo-xwin >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/cargo-xwin" ] || \
  die "cargo-xwin missing — run: cargo install --locked cargo-xwin"
command -v makensis >/dev/null 2>&1 || die "makensis missing — run: brew install makensis"
LLVM_BIN="$(brew --prefix llvm 2>/dev/null)/bin"
[ -x "$LLVM_BIN/clang-cl" ] || die "llvm (clang-cl) missing — run: brew install llvm lld"
rustup target list --installed 2>/dev/null | grep -qx "$TARGET" || rustup target add "$TARGET"
[ -f "$KEY_FILE" ] || die "minisign private key missing at $KEY_FILE"

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ── 1. dist (OS-agnostic JS: tsc + web + tauri-ui) ──
echo "[build-win-mac] npm run build (dist)"
( cd "$REPO_ROOT" && npm run build )

# ── 2. win-x64 self-contained runtime (cross-build; build-runtime auto-detects non-win) ──
echo "[build-win-mac] assemble win-x64 runtime (cross)"
if [ -n "$PROXY" ]; then export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"; fi
node "$REPO_ROOT/scripts/build-runtime-windows.mjs"
if [ -n "$PROXY" ]; then unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; fi

# ── 3. cargo-xwin cross-compile + Tauri NSIS bundle (needs proxy for MSVC SDK + WebView2) ──
echo "[build-win-mac] tauri build --target $TARGET --bundles nsis (cargo-xwin)"
pushd "$REPO_ROOT/src/tauri/src-tauri" >/dev/null
# cargo-xwin exports the clang-cl/lld-link/llvm-lib toolchain env for the MSVC target.
eval "$(PATH="$LLVM_BIN:$PATH" cargo xwin env --target "$TARGET")"
export PATH="$LLVM_BIN:$PATH"
if [ -n "$PROXY" ]; then export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"; fi
npx tauri build --target "$TARGET" --bundles nsis
if [ -n "$PROXY" ]; then unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; fi
popd >/dev/null

NSIS_DIR="$REPO_ROOT/src/tauri/src-tauri/target/$TARGET/release/bundle/nsis"
# [P-RELEASE-WIN-STALE-FIX 2026-07-05] Pick the exe matching the CURRENT package version —
# NOT `ls ... | head -1`, which sorts ALPHABETICALLY and would publish a stale older-version
# exe still in the dir (e.g. a leftover Frondose_0.5.3_x64-setup.exe sorts before 0.5.5),
# silently deploying the wrong installer while latest.json advertises the new version.
# Root-caused during the 0.5.5 release (shipped a stale 0.5.3 exe until caught + re-deployed).
VER="$(node -p "require('$REPO_ROOT/package.json').version")"
SETUP="$NSIS_DIR/Frondose_${VER}_x64-setup.exe"
[ -n "$SETUP" ] && [ -f "$SETUP" ] || die "no NSIS installer for v${VER} under $NSIS_DIR (found: $(ls "$NSIS_DIR"/*-setup.exe 2>/dev/null | tr '\n' ' '))"
echo "[build-win-mac] built: $SETUP ($(du -h "$SETUP" | cut -f1))"

# ── 4. sign (minisign updater .sig) + publish into the site ──
SIG="$SETUP.sig"
if [ ! -f "$SIG" ]; then
  echo "[build-win-mac] signing updater artifact on Mac"
  npx tauri signer sign --private-key "$TAURI_SIGNING_PRIVATE_KEY" --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" "$SETUP" >/dev/null
fi
[ -f "$SIG" ] || die "signing produced no .sig for $SETUP"

mkdir -p "$SITE_DIR/downloads"
cp -f "$SETUP" "$SITE_DIR/downloads/Frondose-windows-x86_64-setup.exe"
cp -f "$SIG"   "$SITE_DIR/downloads/Frondose-windows-x86_64-setup.exe.sig"
echo "[build-win-mac] OK — published Frondose-windows-x86_64-setup.exe(.sig) -> $SITE_DIR/downloads"
