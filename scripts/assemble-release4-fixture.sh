#!/usr/bin/env bash
# P-RELEASE-SIGN-ADHOC Step-5 helper: assemble the real-artifact fixture directory for the
# release-gate carriers (T-OS.Release.4 / 4-negative) from a fresh tauri build output.
# Usage: bash scripts/assemble-release4-fixture.sh <fixture-dir> [bundle-root]
set -euo pipefail

FIXTURE="${1:?fixture dir required}"
BUNDLE_ROOT="${2:-$PWD/src/tauri/src-tauri/target/universal-apple-darwin/release/bundle}"

MACOS="$BUNDLE_ROOT/macos"
DMG="$(find "$BUNDLE_ROOT/dmg" -maxdepth 1 -name 'Frondose_*_universal.dmg' | head -1)"
TARBALL="$(find "$MACOS" -maxdepth 1 -name 'Frondose.app.tar.gz' | head -1)"
SIG="${TARBALL}.sig"
# Windows: use the newest real released NSIS installer pair available in the Windows target bundle dir
NSIS_DIR="$BUNDLE_ROOT/../../../x86_64-pc-windows-msvc/release/bundle/nsis"
NSIS="$(ls -t "$NSIS_DIR"/Frondose_*_x64-setup.exe 2>/dev/null | head -1 || true)"
NSIS_SIG="${NSIS}.sig"

for path in "$MACOS/Frondose.app" "$DMG" "$TARBALL" "$SIG" "$NSIS" "$NSIS_SIG"; do
  [ -n "$path" ] && [ -e "$path" ] || { echo "missing required artifact: $path" >&2; exit 1; }
done

rm -rf "$FIXTURE"
mkdir -p "$FIXTURE"
cp -R "$MACOS/Frondose.app" "$FIXTURE/Frondose.app"
cp "$DMG" "$FIXTURE/Frondose.dmg"
cp "$TARBALL" "$FIXTURE/Frondose.app.tar.gz"
cp "$SIG" "$FIXTURE/Frondose.app.tar.gz.sig"
cp "$NSIS" "$FIXTURE/Frondose.nsis.exe"
cp "$NSIS_SIG" "$FIXTURE/Frondose.nsis.exe.sig"
echo "fixture assembled at $FIXTURE:"
ls -la "$FIXTURE"
