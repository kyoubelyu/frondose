#!/usr/bin/env bash
set -euo pipefail

for command_name in node npm curl tar lipo; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[public-runtime-macos] required tool is missing: $command_name" >&2
    exit 69
  }
done

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime="$repo_root/build/runtime"
node_version="v22.22.3"
sqlite_abi="v127"
sqlite_version="v$(node -p "require('$repo_root/package-lock.json').packages['node_modules/better-sqlite3'].version")"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/frondose-public-runtime-macos.XXXXXX")"
trap 'rm -rf "$temporary_root"' EXIT

cd "$repo_root"
npm run build:tauri:public
npm run build:native
rm -rf "$runtime"
mkdir -p "$runtime"

for arch in arm64 x64; do
  node_root="$temporary_root/node-$arch"
  mkdir -p "$node_root"
  archive="$node_root/node.tar.gz"
  url="https://nodejs.org/dist/$node_version/node-$node_version-darwin-$arch.tar.gz"
  curl -fsSL --http1.1 --retry 3 --retry-delay 3 --retry-connrefused --connect-timeout 20 "$url" -o "$archive"
  tar xzf "$archive" -C "$node_root" --strip-components=2 "node-$node_version-darwin-$arch/bin/node"
  chmod +x "$node_root/node"
done
lipo -create "$temporary_root/node-arm64/node" "$temporary_root/node-x64/node" -output "$runtime/node"
chmod +x "$runtime/node"

cp "$repo_root/package.json" "$repo_root/package-lock.json" "$runtime/"
(cd "$runtime" && npm ci --omit=dev --ignore-scripts --no-fund --no-audit)
cp -R "$repo_root/dist" "$runtime/dist"

sqlite_target="$runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
mkdir -p "$(dirname "$sqlite_target")"
for arch in arm64 x64; do
  sqlite_root="$temporary_root/sqlite-$arch"
  mkdir -p "$sqlite_root"
  package="better-sqlite3-$sqlite_version-node-$sqlite_abi-darwin-$arch.tar.gz"
  url="https://github.com/WiseLibs/better-sqlite3/releases/download/$sqlite_version/$package"
  curl -fsSL --http1.1 --retry 3 --retry-delay 3 --retry-connrefused --connect-timeout 20 "$url" -o "$sqlite_root/sqlite.tar.gz"
  tar xzf "$sqlite_root/sqlite.tar.gz" -C "$sqlite_root"
done
lipo -create \
  "$temporary_root/sqlite-arm64/build/Release/better_sqlite3.node" \
  "$temporary_root/sqlite-x64/build/Release/better_sqlite3.node" \
  -output "$sqlite_target"

mkdir -p "$runtime/build/Release"
if [[ -f "$repo_root/build/Release/cgevent.node" ]]; then
  cp "$repo_root/build/Release/cgevent.node" "$runtime/build/Release/cgevent.node"
fi

for binary in "$runtime/node" "$sqlite_target"; do
  arches="$(lipo -info "$binary")"
  [[ "$arches" == *x86_64* && "$arches" == *arm64* ]] || {
    echo "[public-runtime-macos] non-universal runtime binary: $binary ($arches)" >&2
    exit 65
  }
done
node_abi="$("$runtime/node" -p 'process.versions.modules')"
[[ "$node_abi" == "${sqlite_abi#v}" ]] || {
  echo "[public-runtime-macos] Node/sqlite ABI mismatch: $node_abi != ${sqlite_abi#v}" >&2
  exit 65
}
(cd "$runtime" && ./node -e "require('better-sqlite3')")
