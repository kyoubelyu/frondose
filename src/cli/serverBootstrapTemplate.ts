/** P-27: bootstrap shell-script generator (inline template).
 *  P-34: step 5 replaced — curl + GitHub Release tarball (the package is private,
 *  so a global npm install 404s). The fine-grained PAT (`installToken`) is
 *  embedded; the URL is invite-gated (single-use). */
export function renderBootstrapScript(
  serverUrl: string,
  inviteToken: string,
  maiVersion: string,
  installToken?: string,
): string {
  // serverUrl / inviteToken / maiVersion / installToken are all server-trusted:
  //   - serverUrl: server config.json.server.url
  //   - inviteToken: hex, validated upstream (/^[0-9a-f]{64}$/)
  //   - maiVersion: package.json (echo only)
  //   - installToken: secrets.json.server.installToken (a fine-grained GitHub PAT).
  //     handleBootstrapScript only renders when the token is set; the `?? ""`
  //     fallback covers P-27-era 3-arg callers (no install-core auth).
  // No untrusted user input flows into this template; no shell-escape needed.
  return `#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${serverUrl}"
INVITE_TOKEN="${inviteToken}"
MAI_VERSION="${maiVersion}"
GITHUB_TOKEN="${installToken ?? ""}"

echo "=== mai bootstrap ==="
echo "Server: $SERVER_URL"

# 1. Platform check — macOS only
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This bootstrap script is macOS-only." >&2
  exit 1
fi

# 2. Homebrew check (Homebrew also provides the Xcode CLT)
if ! command -v brew &>/dev/null; then
  echo "ERROR: Homebrew not found. Install from https://brew.sh and retry." >&2
  exit 1
fi
echo "✓ Homebrew detected"

# 3. Chrome auto-install
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -f "$CHROME_PATH" ]]; then
  echo "Chrome not found. Installing via Homebrew..."
  brew install --cask google-chrome
fi
echo "✓ Chrome ready"

# 4. Node 20+ auto-install
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d 'v')" -lt 20 ]]; then
  echo "Installing Node 20 via Homebrew..."
  brew install node@20
  # shellcheck disable=SC2016
  echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
  export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
fi
echo "✓ Node $(node --version) ready"

# 5. Install mai-agent — GitHub Release tarball (P-34: the package is private)
echo "Installing mai-agent ($MAI_VERSION line)..."
# --- install-core: latest GitHub Release → tarball → build → npm-global symlink ---
RELEASE_JSON=$(curl -sL -H "Authorization: Bearer $GITHUB_TOKEN" \\
  -H "Accept: application/vnd.github+json" \\
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
echo "✓ mai-agent installed at $INSTALL_DIR"

# 6. Register with server (writes config + secrets + identity, prints next-steps)
mai bootstrap-register --server-url "$SERVER_URL" --invite-token "$INVITE_TOKEN"

echo ""
echo "=== Bootstrap complete ==="
echo "Follow the 'Next steps' printed above to start the worker, then check"
echo "'mai server worker list' on the server to confirm a fresh heartbeat."
`;
}
