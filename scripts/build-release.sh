#!/usr/bin/env bash
# P-58d.1 — build a SIGNED, UNIVERSAL Frondose.app + Tauri updater artifacts (.app.tar.gz + .sig).
# Build-layer tooling (CLAUDE.md HR-8): NOT a src/tools/** change, never invoked by the agent.
# [3b-r3] Build host = Intel Mac (x86_64); test machines = ARM (arm64). Build a universal
# (x86_64 + arm64 fat) bundle so ONE artifact runs natively on both.
# Uses `npx tauri` (the @tauri-apps/cli devDep) — the global cargo-tauri from P-58b is gone.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="${TAURI_KEY_FILE:-$HOME/.tauri/frondose.key}"

if [ ! -f "$KEY_FILE" ]; then
  echo "[build-release] minisign private key missing at $KEY_FILE" >&2
  echo "[build-release] generate once: npx tauri signer generate -w \"$KEY_FILE\" -p \"\"" >&2
  exit 1
fi

# [3b-r3] The universal build needs BOTH Rust target slices. The Intel host already has
# x86_64; add the arm64 slice (idempotent — no-op if already installed).
rustup target add aarch64-apple-darwin x86_64-apple-darwin

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

cd "$REPO_ROOT/src/tauri/src-tauri"
npx tauri build --target universal-apple-darwin

# [3b-r3] Universal artifacts live under the target-triple dir, NOT target/release/.
BUNDLE_DIR="target/universal-apple-darwin/release/bundle/macos"
TARBALL="$(ls "$BUNDLE_DIR"/*.app.tar.gz 2>/dev/null | head -1 || true)"
SIG="$(ls "$BUNDLE_DIR"/*.app.tar.gz.sig 2>/dev/null | head -1 || true)"
if [ -z "$TARBALL" ] || [ -z "$SIG" ]; then
  echo "[build-release] FAILED: universal updater artifacts not produced (.app.tar.gz / .sig missing under $BUNDLE_DIR)" >&2
  echo "[build-release] check tauri.conf bundle.createUpdaterArtifacts:true + signing key + both rustup target slices" >&2
  exit 1
fi
echo "[build-release] OK (universal-apple-darwin)"
echo "[build-release]   $TARBALL"
echo "[build-release]   $SIG"
