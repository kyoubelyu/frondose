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

# P-58d.2 (B1): make rustup findable in script scope without touching the shell
# profile or Homebrew's /usr/local/bin cargo (install: curl --no-modify-path -y).
export PATH="$HOME/.cargo/bin:$PATH"

# [3b-r3] The universal build needs BOTH Rust target slices. The Intel host already has
# x86_64; add the arm64 slice (idempotent — no-op if already installed).
rustup target add aarch64-apple-darwin x86_64-apple-darwin

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ── [P-58d.3] Phase 0: assemble the self-contained runtime bundled into the .app ──
# tauri.conf bundle.resources copies $REPO_ROOT/build/runtime/ → Frondose.app/Contents/
# Resources/runtime/ DURING `tauri build`, so this MUST complete before Phase 1.
NODE_VERSION="v22.22.3"
SQLITE_VER="v12.9.0"
SQLITE_ABI="v127"
RUNTIME="$REPO_ROOT/build/runtime"

echo "[build-release] Phase 0: assembling self-contained runtime -> $RUNTIME"

# 0a. Build dist/ + native cgevent addon (the payload sources).
( cd "$REPO_ROOT" && npm run build )

# [DEFECT-2 fix] Create build/runtime AFTER npm run build — node-gyp's rm -rf build/
# clean step would otherwise wipe a runtime dir created before it.
rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"

# 0b. Universal Node binary: download arm64 + x64 standalone bin/node -> lipo.
for arch in arm64 x64; do
  url="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$arch.tar.gz"
  tmp="/tmp/frondose-node-$arch"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  curl -fsSL --http1.1 --retry 3 --retry-delay 3 --retry-connrefused --connect-timeout 20 "$url" -o "$tmp/node.tar.gz"
  tar xzf "$tmp/node.tar.gz" -C "$tmp" --strip-components=2 \
    "node-$NODE_VERSION-darwin-$arch/bin/node"
  chmod +x "$tmp/node"
done
lipo -create /tmp/frondose-node-arm64/node /tmp/frondose-node-x64/node -output "$RUNTIME/node"
chmod +x "$RUNTIME/node"

# 0c. Production-only node_modules (native build skipped; sqlite .node placed in 0e).
cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$RUNTIME/"
( cd "$RUNTIME" && npm ci --omit=dev --ignore-scripts --no-fund --no-audit )

# 0d. dist/ payload (built by 0a).
rm -rf "$RUNTIME/dist"
cp -R "$REPO_ROOT/dist" "$RUNTIME/dist"

# 0e. Universal better_sqlite3.node: download arm64 + x64 ABI-127 prebuilts -> lipo.
BSQ_BASE="https://github.com/WiseLibs/better-sqlite3/releases/download/$SQLITE_VER"
BSQ_TARGET="$RUNTIME/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
mkdir -p "$(dirname "$BSQ_TARGET")"
for arch in arm64 x64; do
  pkg="better-sqlite3-$SQLITE_VER-node-$SQLITE_ABI-darwin-$arch.tar.gz"
  tmp="/tmp/frondose-bsq-$arch"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  curl -fsSL --http1.1 --retry 3 --retry-delay 3 --retry-connrefused --connect-timeout 20 "$BSQ_BASE/$pkg" -o "$tmp/bsq.tar.gz"
  tar xzf "$tmp/bsq.tar.gz" -C "$tmp"
done
lipo -create /tmp/frondose-bsq-arm64/build/Release/better_sqlite3.node \
             /tmp/frondose-bsq-x64/build/Release/better_sqlite3.node \
             -output "$BSQ_TARGET"

# 0f. cgevent.node (x64-only; arm64 degrades to CDP). Best-effort.
mkdir -p "$RUNTIME/build/Release"
if [ -f "$REPO_ROOT/build/Release/cgevent.node" ]; then
  cp "$REPO_ROOT/build/Release/cgevent.node" "$RUNTIME/build/Release/cgevent.node"
else
  echo "[build-release] WARNING: cgevent.node absent — hardware input unavailable; CDP fallback" >&2
fi

# 0g. ENFORCE universal (both arches) on BOTH native artifacts.
for f in "$RUNTIME/node" "$BSQ_TARGET"; do
  out="$(lipo -info "$f" 2>&1 || true)"
  echo "[build-release] $(basename "$f") arches: $out"
  if ! echo "$out" | grep -q "x86_64" || ! echo "$out" | grep -q "arm64"; then
    echo "[build-release] FAILED: $f is not universal (need x86_64 + arm64): $out" >&2
    exit 1
  fi
done

# 0h. [3b CMR-2] LOADABILITY gate — prove the bundled node can load runtime deps.
NODE_ABI="$("$RUNTIME/node" -p 'process.versions.modules')"
if [ "$NODE_ABI" != "${SQLITE_ABI#v}" ]; then
  echo "[build-release] FAILED: ABI mismatch: node=$NODE_ABI sqlite=${SQLITE_ABI#v}" >&2
  exit 1
fi
# P-OPEN-SOURCE-SPLIT §9.3: ssh2 retired — the loadability probe covers the kept native addon only.
( cd "$RUNTIME" && ./node -e "require('better-sqlite3')" )
(
  cd "$RUNTIME"
)

echo "[build-release] Phase 0 OK: runtime assembled ($(du -sh "$RUNTIME" | cut -f1))"
# ── end Phase 0 ──

cd "$REPO_ROOT/src/tauri/src-tauri"
# [5a-fix] Phase 1 — app + updater artifacts (.app.tar.gz + .sig via createUpdaterArtifacts).
# Minisign-signed only (no Apple cert / no GUI). MUST succeed — load-bearing updater deliverable,
# decoupled from the fragile DMG step.
npx tauri build --target universal-apple-darwin --bundles app

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

# The bundled binary is renamed to "Frondose" via tauri.conf `mainBinaryName`
# (was the Cargo crate name "mai-tauri" — a branding leak, user-visible as
# mai-tauri.exe on Windows; mainBinaryName fixes it on both platforms).
BIN="$BUNDLE_DIR/Frondose.app/Contents/MacOS/Frondose"
SITE_DIR="${FRONDOSE_SITE_DIR:-${MAI_SITE_DIR:-$HOME/.frondose/site}}"
UPDATE_SERVER_URL="${UPDATE_SERVER_URL:-http://localhost:4875}"

DMG_OUT="$BUNDLE_DIR/Frondose-universal.dmg"
if hdiutil create -volname "Frondose" -srcfolder "$BUNDLE_DIR/Frondose.app" -ov -format UDZO "$DMG_OUT" \
   && hdiutil verify "$DMG_OUT"; then
  DMG="$DMG_OUT"
  echo "[build-release] headless DMG created + verified: $DMG_OUT"
else
  echo "[build-release] WARNING: hdiutil DMG create/verify failed — skipping DMG publish (updater unaffected)" >&2
  rm -f "$DMG_OUT"
  DMG=""
fi

# [3b CLR-3] Version source: the Tauri updater compares the manifest version against the
# app's bundle version (tauri.conf.json). Guard against package.json ↔ tauri.conf drift.
PKG_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
TAURI_VERSION="$(node -p "require('$REPO_ROOT/src/tauri/src-tauri/tauri.conf.json').version")"
if [ "$PKG_VERSION" != "$TAURI_VERSION" ]; then
  echo "[build-release] FAILED: version drift — package.json=$PKG_VERSION tauri.conf.json=$TAURI_VERSION" >&2
  echo "[build-release] re-run the Step-7 tri-bump so both match before building a release" >&2
  exit 1
fi
VERSION="$PKG_VERSION"

# [3b CMR-3 + 5a-fix DEFECT-1] ENFORCE the universal (fat) binary — F-SB1 closure depends on it
# and this script IS the distribution path. Hard-fail BEFORE site population if either slice missing.
LIPO_OUT="$(lipo -info "$BIN" 2>&1 || true)"
echo "[build-release] universal binary arches: $LIPO_OUT"
if ! echo "$LIPO_OUT" | grep -q "x86_64" || ! echo "$LIPO_OUT" | grep -q "arm64"; then
  echo "[build-release] FAILED: $BIN is not universal (need both x86_64 + arm64): $LIPO_OUT" >&2
  echo "[build-release] ensure rustup + both target slices: rustup target add aarch64-apple-darwin x86_64-apple-darwin" >&2
  exit 1
fi

# [P-58d.4 5a] DMG is set ONLY by the C-1 hdiutil gate above ($DMG_OUT on success, "" on failure).
# The old P-58d.3 fallback locator is removed — hdiutil is now the sole DMG source, so any fallback
# could only publish a STALE dmg (defeating the CMR-4 fail-safe). No dmg published when hdiutil fails.

# ── Gates (a) version-drift, (b) updater-artifacts-exist [upstream check], (c) lipo passed —
#    populate the portal. Updater artifacts + manifest ALWAYS; DMG installer only if present. ──
mkdir -p "$SITE_DIR/downloads"
cp "$TARBALL" "$SITE_DIR/downloads/Frondose.app.tar.gz"
cp "$SIG" "$SITE_DIR/downloads/Frondose.app.tar.gz.sig"
if [ -n "$DMG" ]; then
  cp "$DMG" "$SITE_DIR/downloads/Frondose-universal.dmg"
  echo "[build-release] DMG installer published: $DMG"
else
  rm -f "$SITE_DIR/downloads/Frondose-universal.dmg"
  echo "[build-release] WARNING: no final .dmg — removed any stale installer; portal has no installer this build (updater unaffected)" >&2
fi
# P-OPEN-SOURCE-SPLIT §9.2: the landing page moved to the Web project.
cp "$REPO_ROOT/projects/web/index.html" "$SITE_DIR/index.html"

SIG_PATH="$SITE_DIR/downloads/Frondose.app.tar.gz.sig" \
VERSION="$VERSION" \
MANIFEST_URL="${UPDATE_SERVER_URL%/}/downloads/Frondose.app.tar.gz" \
OUT_PATH="$SITE_DIR/latest.json" \
  node "$REPO_ROOT/scripts/gen-latest-json.mjs"

echo "[build-release] site populated at $SITE_DIR (version $VERSION, url base: $UPDATE_SERVER_URL)"
