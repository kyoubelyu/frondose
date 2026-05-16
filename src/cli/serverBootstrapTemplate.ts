/** P-27: bootstrap shell-script generator (inline template). */

export function renderBootstrapScript(serverUrl: string, inviteToken: string, maiVersion: string): string {
  // serverUrl, inviteToken, maiVersion are caller-controlled (server-trusted):
  //   - serverUrl comes from server config.json.server.url
  //   - inviteToken is hex (validated upstream — /^[0-9a-f]{64}$/)
  //   - maiVersion comes from package.json
  // No untrusted user input flows into this template; no shell-escape needed.
  return `#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${serverUrl}"
INVITE_TOKEN="${inviteToken}"
MAI_VERSION="${maiVersion}"

echo "=== mai bootstrap ==="
echo "Server: $SERVER_URL"

# 1. Platform check — macOS only (per mai-agent scope, P-27)
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This bootstrap script is macOS-only (per mai-agent scope)."
  exit 1
fi

# 2. Homebrew check
if ! command -v brew &>/dev/null; then
  echo "ERROR: Homebrew not found. Install from https://brew.sh and retry."
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

# 5. Install mai-agent
npm install -g "@kyoube/mai-agent@\${MAI_VERSION}" 2>&1 | tail -3
echo "✓ mai-agent $MAI_VERSION installed"

# 6. Register with server (writes config + secrets + identity, prints next-steps)
mai bootstrap-register --server-url "$SERVER_URL" --invite-token "$INVITE_TOKEN"

echo ""
echo "=== Bootstrap complete ==="
echo "Follow the 'Next steps' printed above to start the worker, then check"
echo "'mai server worker list' on the server to confirm a fresh heartbeat."
`;
}
