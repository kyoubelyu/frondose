#!/usr/bin/env bash
# P-34: standalone mai-agent installer for a fresh macOS machine.
# P-40: gh-native release fetch (no GITHUB_TOKEN); MAI_PREFIX sandbox override.
# Usage:  bash install.sh
#         MAI_PREFIX=/tmp/test bash install.sh   # sandbox install — overrides $HOME + brew prefix
# Requires: macOS, Homebrew, gh CLI (authenticated via `gh auth login`).
# Installs Chrome + Node@20 + mai-agent from the latest GitHub Release.
set -euo pipefail

REPO="kyoubelyu/mai-agent"

echo "=== mai-agent install ==="

# 1. Platform
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: mai-agent is macOS-only." >&2
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

# 6. Install mai-agent
echo "Installing mai-agent from the latest GitHub Release..."
# P-40 FINDING-I1: MAI_PREFIX overrides BOTH base paths → sandbox-testable installs.
HOME_BASE="${MAI_PREFIX:-$HOME}"
BREW_BASE="${MAI_PREFIX:-$(brew --prefix)}"

# --- install-core: latest GitHub Release → tarball → build → npm-global symlink ---
TAG=$(gh release view --repo "$REPO" --json tagName --jq '.tagName')
if [[ -z "$TAG" ]]; then
  echo "ERROR: could not read the latest GitHub Release for $REPO." >&2
  exit 1
fi
INSTALL_DIR="$HOME_BASE/.mai/agent/releases/$TAG"
mkdir -p "$INSTALL_DIR"
gh release download --repo "$REPO" --archive=tar.gz --output /tmp/mai-agent.tar.gz --clobber
tar -xzf /tmp/mai-agent.tar.gz -C "$INSTALL_DIR" --strip-components=1
rm -f /tmp/mai-agent.tar.gz

# P-40 FINDING-I3: non-fatal Xcode CLT check. The hardware-input addon needs the CLT,
# but cdp mode is fully functional without it — warn, do NOT exit.
if ! xcode-select -p &>/dev/null; then
  echo "WARNING: Xcode Command Line Tools not found — the hardware-input addon will be skipped."
  echo "         Run 'xcode-select --install', then rerun for full hardware-input support."
fi

# P-40 FINDING-I4: full output — set -euo pipefail surfaces the real failure point.
( cd "$INSTALL_DIR" && npm install --prefer-offline && npm run build )

PKG_LINK="$BREW_BASE/lib/node_modules/@kyoube/mai-agent"
BIN_LINK="$BREW_BASE/bin/mai"
mkdir -p "$(dirname "$PKG_LINK")" "$(dirname "$BIN_LINK")"
ln -sfn "$INSTALL_DIR" "$PKG_LINK"
ln -sfn "../lib/node_modules/@kyoube/mai-agent/dist/cli/main.js" "$BIN_LINK"
chmod +x "$INSTALL_DIR/dist/cli/main.js"
# --- end install-core ---

echo ""
echo "=== Install complete ==="
echo "mai-agent $TAG installed. 'mai' is on your PATH ($BIN_LINK)."
echo "Next: run 'mai auth set' to configure an LLM provider, then 'mai'."
