#!/usr/bin/env bash
# P-RELEASE-SIGN-ADHOC Step-5 helper: produce the DMG canary fixture for T-OS.Release.2
# (FRONDOSE_TEST_REAL_DMG_CANARY / _MEMBER). Copies the real DMG, mounts it read-write,
# embeds "release-canary" in the packaged app payload, and unmounts.
# Usage: bash scripts/assemble-dmg-canary-fixture.sh <real-dmg> <out-dmg>
set -euo pipefail

REAL_DMG="${1:?real dmg required}"
OUT_DMG="${2:?output dmg required}"
CANARY="release-canary"

[ -e "$REAL_DMG" ] || { echo "missing real dmg: $REAL_DMG" >&2; exit 1; }
rm -f "$OUT_DMG"
cp "$REAL_DMG" "$OUT_DMG"

MOUNT="$(mktemp -d "${TMPDIR:-/tmp}/frondose-canary-mount.XXXXXX")"
trap 'hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true; rm -rf "$MOUNT"' EXIT
hdiutil attach -quiet -nobrowse -readwrite -mountpoint "$MOUNT" "$OUT_DMG"
# The packaged app payload path inside the mounted DMG
APP="$(find "$MOUNT" -maxdepth 2 -name "Frondose.app" -type d | head -1)"
[ -n "$APP" ] || { echo "no Frondose.app inside the DMG" >&2; exit 1; }
mkdir -p "$APP/Contents/Resources"
printf '%s\n' "$CANARY" > "$APP/Contents/Resources/release-canary"
hdiutil detach -quiet "$MOUNT"
trap - EXIT
rm -rf "$MOUNT"
echo "DMG canary fixture: $OUT_DMG (member: Frondose.app/Contents/Resources/release-canary)"
