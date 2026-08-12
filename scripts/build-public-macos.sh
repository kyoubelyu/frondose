#!/usr/bin/env bash
set -euo pipefail

export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

# P-RELEASE-SIGN-ADHOC: ad-hoc codesign + Tauri-updater minisign only — no Apple identity required.
required_env=(TAURI_SIGNING_PRIVATE_KEY)
required_tools=(codesign hdiutil npm npx cargo rustup node)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "[public-macos] required environment variable is missing: ${name}" >&2
    exit 64
  fi
done
for command_name in "${required_tools[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[public-macos] required tool is missing: ${command_name}" >&2
    exit 69
  }
done

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
target_root="${CARGO_TARGET_DIR:-${repo_root}/src/tauri/src-tauri/target}"
output_root="${FRONDOSE_PUBLIC_OUTPUT_DIR:-${repo_root}/build/public-macos}"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/frondose-public-macos.XXXXXX")"
config="$repo_root/src/tauri/src-tauri/tauri.public.conf.json"
mount_point="${temporary_root}/mounted"

cleanup() {
  if [[ "${mounted:-0}" == "1" ]]; then
    hdiutil detach -quiet "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT

cd "$repo_root"
npm run build:runtime:public:macos
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cd "$repo_root/src/tauri/src-tauri"
npx tauri build --config "$config" --target universal-apple-darwin
cd "$repo_root"
verifier_target="$temporary_root/verifier-target"
CARGO_TARGET_DIR="$verifier_target" cargo build --release --manifest-path scripts/updater-verifier/Cargo.toml

bundle_root="$target_root/universal-apple-darwin/release/bundle"
app="$bundle_root/macos/Frondose.app"
dmg_count="$(find "$bundle_root/dmg" -maxdepth 1 -type f -name 'Frondose_*.dmg' | wc -l | tr -d ' ')"
[[ "$dmg_count" == "1" ]] || { echo "[public-macos] expected exactly one universal DMG" >&2; exit 66; }
dmg="$(find "$bundle_root/dmg" -maxdepth 1 -type f -name 'Frondose_*_universal.dmg')"
archive="$bundle_root/macos/Frondose.app.tar.gz"
signature="${archive}.sig"
archive_count="$(find "$bundle_root/macos" -maxdepth 1 -type f -name 'Frondose*.tar.gz' | wc -l | tr -d ' ')"
signature_count="$(find "$bundle_root/macos" -maxdepth 1 -type f -name 'Frondose*.tar.gz.sig' | wc -l | tr -d ' ')"
[[ "$archive_count" == "1" && "$signature_count" == "1" ]] || {
  echo "[public-macos] expected exactly one updater archive and sidecar" >&2
  exit 66
}
for path in "$app" "$dmg" "$archive" "$signature"; do
  [[ -e "$path" ]] || { echo "[public-macos] expected output missing: $path" >&2; exit 66; }
done
updater_public_key="$(node -e 'const c=require(process.argv[1]); process.stdout.write(Buffer.from(c.plugins.updater.pubkey,"base64").toString("utf8").trim().split(/\r?\n/)[1])' "$repo_root/src/tauri/src-tauri/tauri.conf.json")"
"$verifier_target/release/frondose-updater-verifier" "$updater_public_key" "$archive" "$signature"

# P-RELEASE-SIGN-ADHOC: ad-hoc codesign verification only (no notarization/stapler/Gatekeeper requirements).
codesign --verify --deep --strict --verbose=2 "$app"

mkdir -p "$mount_point"
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mount_point" "$dmg"
mounted=1
if ! diff -qr "$app" "$mount_point/Frondose.app" >/dev/null; then
  hdiutil detach -quiet "$mount_point" || true
  mounted=0
  echo "[public-macos] mounted App differs from verified producer App" >&2
  exit 67
fi
hdiutil detach -quiet "$mount_point"
mounted=0

[[ ! -e "$output_root" ]] || { echo "[public-macos] output path must not already exist" >&2; exit 68; }
mkdir -p "$output_root"
cp "$dmg" "$output_root/Frondose.dmg"
cp "$archive" "$output_root/Frondose.app.tar.gz"
cp "$signature" "$output_root/Frondose.app.tar.gz.sig"
node - "$output_root" <<'NODE'
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2];
const digest = (name) => createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
fs.writeFileSync(path.join(root, "verified-producer-manifest.json"), `${JSON.stringify({
  platform: "macos-universal",
  files: ["Frondose.dmg", "Frondose.app.tar.gz", "Frondose.app.tar.gz.sig"],
  sha256: { dmg: digest("Frondose.dmg"), appTar: digest("Frondose.app.tar.gz") },
}, null, 2)}\n`);
NODE
