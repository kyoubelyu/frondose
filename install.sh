#!/usr/bin/env bash
# P-34: standalone mai-agent installer for a fresh macOS machine.
# Usage:  GITHUB_TOKEN=<fine-grained-PAT> bash install.sh
#         (or run without — it will prompt, masked, for the token)
# Requires: macOS, Homebrew. Installs Chrome + Node@20 + mai-agent from the
# latest GitHub Release. Attached to each Release as a downloadable asset.
set -euo pipefail

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

# 3. GitHub token — env var, else masked prompt (D-5)
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  read -rsp "GitHub token (fine-grained, contents:read on kyoubelyu/mai-agent): " GITHUB_TOKEN
  echo
fi
if [[ -z "$GITHUB_TOKEN" ]]; then
  echo "ERROR: a GitHub token is required." >&2
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
# --- install-core: latest GitHub Release → tarball → build → npm-global symlink ---
RELEASE_JSON=$(curl -sL -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/kyoubelyu/mai-agent/releases/latest")
TAG=$(printf '%s' "$RELEASE_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tag_name',''))")
TARBALL_URL=$(printf '%s' "$RELEASE_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tarball_url',''))")
if [[ -z "$TAG" || -z "$TARBALL_URL" ]]; then
  echo "ERROR: could not read latest release (check the GitHub token's contents:read scope)." >&2
  exit 1
fi
INSTALL_DIR="$HOME/.mai/agent/releases/$TAG"
mkdir -p "$INSTALL_DIR"
# auth header is stripped by curl on the cross-origin 302 to codeload (signed URL) — correct.
curl -sL -H "Authorization: Bearer $GITHUB_TOKEN" "$TARBALL_URL" -o /tmp/mai-agent.tar.gz
tar -xzf /tmp/mai-agent.tar.gz -C "$INSTALL_DIR" --strip-components=1
rm -f /tmp/mai-agent.tar.gz
( cd "$INSTALL_DIR" && npm install --prefer-offline 2>&1 | tail -3 && npm run build 2>&1 | tail -5 )
BREW_PREFIX=$(brew --prefix)
PKG_LINK="$BREW_PREFIX/lib/node_modules/@kyoube/mai-agent"
mkdir -p "$(dirname "$PKG_LINK")"
ln -sfn "$INSTALL_DIR" "$PKG_LINK"
ln -sfn "../lib/node_modules/@kyoube/mai-agent/dist/cli/main.js" "$BREW_PREFIX/bin/mai"
chmod +x "$INSTALL_DIR/dist/cli/main.js"
# --- end install-core ---
unset GITHUB_TOKEN

echo ""
echo "=== Install complete ==="
echo "mai-agent $TAG installed. 'mai' is on your PATH ($BREW_PREFIX/bin/mai)."
echo "Next: run 'mai auth set' to configure an LLM provider, then 'mai'."
