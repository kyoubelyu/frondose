#!/usr/bin/env bash
# P-34: standalone frondose installer for a fresh macOS machine.
# P-40: gh-native release fetch (no GITHUB_TOKEN); FRONDOSE_PREFIX sandbox override.
# Usage:  bash install.sh
#         FRONDOSE_PREFIX=/tmp/test bash install.sh   # sandbox install — overrides $HOME + brew prefix
# Requires: macOS, Homebrew, gh CLI (authenticated via `gh auth login`).
# Installs Chrome + Node@20 + frondose from the latest GitHub Release.
set -euo pipefail

REPO="kyoubelyu/frondose"

# P-58b: optional release-channel flags. No-arg => stable "Latest" (backward compatible).
CHANNEL="stable"
REQ_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prerelease) CHANNEL="prerelease"; shift ;;
    --version)
      # MR1 fix: validate the operand BEFORE `shift 2` — a bare `--version`
      # (no tag) leaves only 1 positional, so `shift 2` errors under `set -u`.
      REQ_VERSION="${2:-}"
      if [[ -z "$REQ_VERSION" ]]; then
        echo "ERROR: --version requires a tag (e.g. --version v0.5.0-alpha.26)" >&2
        exit 1
      fi
      shift 2 ;;
    --version=*) REQ_VERSION="${1#*=}"; shift ;;
    *) echo "ERROR: unknown argument '$1'. Usage: bash install.sh [--prerelease] [--version <tag>]" >&2; exit 1 ;;
  esac
done

echo "=== frondose install ==="

# 1. Platform
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: frondose is macOS-only." >&2
  exit 1
fi

# 2. Homebrew (also provides the Xcode CLT)
if ! command -v brew &>/dev/null; then
  echo "ERROR: Homebrew not found. Install from https://brew.sh and retry." >&2
  exit 1
fi

# 3. gh CLI — P-40: replaces the GITHUB_TOKEN/curl release fetch.
if ! command -v gh &>/dev/null; then
  echo "ERROR: gh CLI not found. Install from https://cli.github.com and run 'gh auth login'." >&2
  exit 1
fi
if ! gh auth status &>/dev/null; then
  echo "ERROR: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

# 4. Chrome
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -f "$CHROME_PATH" ]]; then
  echo "Installing Chrome via Homebrew..."
  brew install --cask google-chrome
fi

# 5. Node 20+
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d 'v')" -lt 20 ]]; then
  echo "Installing Node 20 via Homebrew..."
  brew install node@20
  # shellcheck disable=SC2016
  echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
  export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
fi

# 6. Install frondose
echo "Installing frondose from the latest GitHub Release..."
# P-40 FINDING-I1: FRONDOSE_PREFIX overrides BOTH base paths → sandbox-testable installs.
HOME_BASE="${FRONDOSE_PREFIX:-$HOME}"
BREW_BASE="${FRONDOSE_PREFIX:-$(brew --prefix)}"

# --- install-core: latest GitHub Release → tarball → build → npm-global symlink ---
if [[ -n "$REQ_VERSION" ]]; then
  # Explicit pin: validate the tag exists (gh release view errors if absent).
  if ! gh release view "$REQ_VERSION" --repo "$REPO" --json tagName &>/dev/null; then
    echo "ERROR: release '$REQ_VERSION' not found in $REPO." >&2
    exit 1
  fi
  TAG="$REQ_VERSION"
elif [[ "$CHANNEL" == "prerelease" ]]; then
  # Latest prerelease by publish date (scout §3 jq — VERIFIED against the repo).
  TAG=$(gh release list --repo "$REPO" --exclude-drafts --limit 30 \
    --json tagName,isPrerelease,publishedAt \
    --jq 'map(select(.isPrerelease==true)) | sort_by(.publishedAt) | reverse | .[0].tagName')
else
  TAG=$(gh release view --repo "$REPO" --json tagName --jq '.tagName')  # stable "Latest"
fi
if [[ -z "$TAG" || "$TAG" == "null" ]]; then
  echo "ERROR: could not resolve a release tag for $REPO (channel=$CHANNEL)." >&2
  exit 1
fi
INSTALL_DIR="$HOME_BASE/.frondose/agent/releases/$TAG"
mkdir -p "$INSTALL_DIR"
gh release download "$TAG" --repo "$REPO" --archive=tar.gz --output /tmp/frondose.tar.gz --clobber
tar -xzf /tmp/frondose.tar.gz -C "$INSTALL_DIR" --strip-components=1
rm -f /tmp/frondose.tar.gz

# P-40 FINDING-I3: non-fatal Xcode CLT check. The hardware-input addon needs the CLT,
# but cdp mode is fully functional without it — warn, do NOT exit.
if ! xcode-select -p &>/dev/null; then
  echo "WARNING: Xcode Command Line Tools not found — the hardware-input addon will be skipped."
  echo "         Run 'xcode-select --install', then rerun for full hardware-input support."
fi

# P-40 FINDING-I4: full output — set -euo pipefail surfaces the real failure point.
( cd "$INSTALL_DIR" && npm install --prefer-offline && npm run build )

PKG_LINK="$BREW_BASE/lib/node_modules/@kyoube/frondose"
BIN_LINK="$BREW_BASE/bin/mai"
mkdir -p "$(dirname "$PKG_LINK")" "$(dirname "$BIN_LINK")"
ln -sfn "$INSTALL_DIR" "$PKG_LINK"
ln -sfn "../lib/node_modules/@kyoube/frondose/dist/cli/main.js" "$BIN_LINK"
chmod +x "$INSTALL_DIR/dist/cli/main.js"
# --- end install-core ---

# P-58b: persist the update channel so `mai` startup auto-update stays on it.
# --prerelease => "prerelease" (ride alphas); otherwise "stable". --version pins
# explicitly => stable (no auto-ride). Plain text; read by src/persistence/channel.ts.
CHANNEL_FILE="$HOME_BASE/.frondose/agent/channel"
mkdir -p "$(dirname "$CHANNEL_FILE")"
printf '%s\n' "$CHANNEL" > "$CHANNEL_FILE"

echo ""
echo "=== Install complete ==="
echo "frondose $TAG installed. 'mai' is on your PATH ($BIN_LINK)."
echo "Next: open Frondose and use Settings to configure your provider key, identity, and integrations."
