/**
 * P-27 Step 5 — T-TPL.1..3 (original)
 * P-34 Step 4a — T-BT.1..5 (new scaffolds, assertion bodies TODO)
 *
 * Tests for src/cli/serverBootstrapTemplate.ts — renderBootstrapScript().
 * Gate coverage: G-P27.19 (macOS guard, brew, node20, mai install, bootstrap-register call),
 *                G-P27.20 (HTTP response has correct substitutions),
 *                G-P34.1  (install-core present, npm install -g absent),
 *                G-P34.2  (installToken embedded as GITHUB_TOKEN),
 *                G-P34.3  (P-27 behavior preserved),
 *                G-P34.4  (set -euo pipefail, no set -x, unset GITHUB_TOKEN)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBootstrapScript } from "../../src/cli/serverBootstrapTemplate.js";

const SERVER_URL = "http://100.64.0.5:3031";
const INVITE_TOKEN = "ab".repeat(32); // 64 hex chars
const MAI_VERSION = "0.4.24";

// ─── T-TPL.1 ─────────────────────────────────────────────────────────────────

describe("renderBootstrapScript — variable substitution (G-P27.19 + G-P27.20)", () => {
  it("T-TPL.1: rendered script starts with #!/usr/bin/env bash and contains all 3 substituted variables", () => {
    // Given: serverUrl='http://100.64.0.5:3031', inviteToken='ab'.repeat(32), maiVersion='0.4.24'
    // When:  renderBootstrapScript(serverUrl, inviteToken, maiVersion)
    // Then:  starts with '#!/usr/bin/env bash'; contains all 3 variable assignments
    const script = renderBootstrapScript(SERVER_URL, INVITE_TOKEN, MAI_VERSION);
    assert.ok(script.startsWith("#!/usr/bin/env bash"), "must start with shebang");
    assert.ok(script.includes(`SERVER_URL="${SERVER_URL}"`), `must contain SERVER_URL assignment; got: ${script.slice(0, 200)}`);
    assert.ok(script.includes(`INVITE_TOKEN="${INVITE_TOKEN}"`), "must contain INVITE_TOKEN assignment");
    assert.ok(script.includes(`MAI_VERSION="${MAI_VERSION}"`), "must contain MAI_VERSION assignment");
  });
});

// ─── T-TPL.2 ─────────────────────────────────────────────────────────────────

describe("renderBootstrapScript — required bash segments (G-P27.19)", () => {
  it("T-TPL.2: rendered script contains macOS uname guard, brew chrome install, node@20 install, mai npm install, bootstrap-register invocation", () => {
    // Given: any valid serverUrl + inviteToken + maiVersion
    // When:  renderBootstrapScript(...)
    // Then:  all required segments present
    const script = renderBootstrapScript(SERVER_URL, INVITE_TOKEN, MAI_VERSION);
    assert.ok(script.includes("uname"), "must contain uname (macOS guard)");
    assert.ok(script.includes("brew install --cask google-chrome"), "must contain chrome auto-install");
    assert.ok(script.includes("node@20"), "must contain node@20 install");
    // NOTE: the `npm install -g "@kyoube/mai-agent@...` assertion is intentionally REMOVED
    // (P-34 BLOCKER fix — builder replaces it with curl+tarball install at Step 4b).
    assert.ok(script.includes("mai bootstrap-register --server-url"), "must invoke mai bootstrap-register");
    assert.ok(script.includes("--invite-token"), "bootstrap-register must pass --invite-token");
  });
});

// ─── T-TPL.3 ─────────────────────────────────────────────────────────────────

describe("renderBootstrapScript — hex token passthrough (G-P27.19)", () => {
  it("T-TPL.3: invite token consisting of hex chars only is passed through unmodified (no shell-escape needed)", () => {
    // Given: inviteToken = 'a1b2c3d4'.repeat(8) (64 hex chars)
    // When:  renderBootstrapScript(url, token, version)
    // Then:  exact token string appears verbatim in output
    const hexToken = "a1b2c3d4".repeat(8); // 64 hex chars
    const script = renderBootstrapScript("http://srv", hexToken, "0.4.24");
    assert.ok(
      script.includes(hexToken),
      `hex token must appear verbatim in script; token=${hexToken.slice(0, 8)}...`,
    );
    // No shell-escape artifacts (no backslashes injected around token).
    const tokenIdx = script.indexOf(hexToken);
    const charBefore = script[tokenIdx - 1];
    const charAfter = script[tokenIdx + hexToken.length];
    // Token should be directly quoted (adjacent to " or $) — no backslash before it.
    assert.notEqual(charBefore, "\\", "no backslash before hex token (no escaping)");
    assert.notEqual(charAfter, "\\", "no backslash after hex token");
  });
});

// ─── P-34 Step 5 assertions (T-BT.1..5) ─────────────────────────────────────
// Assertion bodies filled at Step 5 after builder Step 4b implementation.

const INSTALL_TOKEN_PLACEHOLDER = "ghp_TESTTOKEN_placeholder_not_real";

// ─── T-BT.1 ──────────────────────────────────────────────────────────────────

describe("renderBootstrapScript — install-core present, npm install -g absent (G-P34.1)", () => {
  it(
    "T-BT.1: when renderBootstrapScript called with all 4 args, output contains install-core markers (releases/latest, Authorization: Bearer, tar -xzf, --strip-components=1, npm install, npm run build, ln -sfn) and does NOT contain npm install -g",
    () => {
      // Given: serverUrl, inviteToken, maiVersion, installToken all provided
      // When:  renderBootstrapScript(serverUrl, inviteToken, maiVersion, installToken) called
      // Then:  output contains install-core markers; no 'npm install -g' anywhere
      const script = renderBootstrapScript(SERVER_URL, INVITE_TOKEN, MAI_VERSION, INSTALL_TOKEN_PLACEHOLDER);
      // install-core markers
      assert.ok(script.includes("releases/latest"), "must contain 'releases/latest' API path");
      assert.ok(script.includes("Authorization: Bearer"), "must contain 'Authorization: Bearer' for GitHub API");
      assert.ok(script.includes("tar -xzf"), "must contain 'tar -xzf' extraction command");
      assert.ok(script.includes("--strip-components=1"), "must contain '--strip-components=1'");
      assert.ok(script.includes("npm install"), "must contain 'npm install' step");
      assert.ok(script.includes("npm run build"), "must contain 'npm run build' step");
      assert.ok(script.includes("ln -sfn"), "must contain 'ln -sfn' symlink creation");
      // BLOCKER fix: no npm install -g
      assert.ok(!script.includes("npm install -g"), "must NOT contain 'npm install -g' (broken private-package path)");
    },
  );
});

// ─── T-BT.2 ──────────────────────────────────────────────────────────────────

describe("renderBootstrapScript — installToken embedded as GITHUB_TOKEN (G-P34.2)", () => {
  it(
    'T-BT.2: when renderBootstrapScript called with installToken="ghp_TESTTOKEN_placeholder_not_real", output contains GITHUB_TOKEN="ghp_TESTTOKEN_placeholder_not_real"',
    () => {
      // Given: installToken = "ghp_TESTTOKEN_placeholder_not_real"
      // When:  renderBootstrapScript(serverUrl, inviteToken, maiVersion, installToken)
      // Then:  output contains 'GITHUB_TOKEN="ghp_TESTTOKEN_placeholder_not_real"'
      const script = renderBootstrapScript(SERVER_URL, INVITE_TOKEN, MAI_VERSION, INSTALL_TOKEN_PLACEHOLDER);
      assert.ok(
        script.includes(`GITHUB_TOKEN="${INSTALL_TOKEN_PLACEHOLDER}"`),
        `script must contain GITHUB_TOKEN="ghp_TESTTOKEN_placeholder_not_real"; got snippet: ${script.slice(script.indexOf("GITHUB_TOKEN") - 0, script.indexOf("GITHUB_TOKEN") + 60)}`,
      );
    },
  );
});

// ─── T-BT.3 ──────────────────────────────────────────────────────────────────

describe("renderBootstrapScript — P-27 bootstrap behavior preserved (G-P34.3)", () => {
  it(
    "T-BT.3: when renderBootstrapScript called with all 4 args, output still contains uname macOS guard, command -v brew, google-chrome, node@20, and mai bootstrap-register --server-url + --invite-token",
    () => {
      // Given: any valid server args + installToken placeholder
      // When:  renderBootstrapScript(serverUrl, inviteToken, maiVersion, installToken)
      // Then:  P-27 behavioral segments (uname, brew, chrome, node@20, bootstrap-register) present
      const script = renderBootstrapScript(SERVER_URL, INVITE_TOKEN, MAI_VERSION, INSTALL_TOKEN_PLACEHOLDER);
      assert.ok(script.includes("uname"), "must contain 'uname' macOS platform check");
      assert.ok(script.includes("command -v brew"), "must contain 'command -v brew' Homebrew check");
      assert.ok(script.includes("google-chrome"), "must contain 'google-chrome' Chrome install");
      assert.ok(script.includes("node@20"), "must contain 'node@20' Node install");
      assert.ok(
        script.includes('mai bootstrap-register --server-url "$SERVER_URL" --invite-token "$INVITE_TOKEN"'),
        "must contain mai bootstrap-register invocation with $SERVER_URL + $INVITE_TOKEN variables",
      );
    },
  );
});

// ─── T-BT.4 ──────────────────────────────────────────────────────────────────

describe("renderBootstrapScript — safety shell flags + unset GITHUB_TOKEN (G-P34.4)", () => {
  it(
    "T-BT.4: when renderBootstrapScript called with all 4 args, output contains set -euo pipefail, does NOT contain set -x, and contains unset GITHUB_TOKEN after install-core (D-9)",
    () => {
      // Given: any valid args with installToken
      // When:  renderBootstrapScript(serverUrl, inviteToken, maiVersion, installToken)
      // Then:  'set -euo pipefail' present; 'set -x' absent; 'unset GITHUB_TOKEN' present (post install-core)
      const script = renderBootstrapScript(SERVER_URL, INVITE_TOKEN, MAI_VERSION, INSTALL_TOKEN_PLACEHOLDER);
      assert.ok(script.includes("set -euo pipefail"), "must contain 'set -euo pipefail' safety flags");
      assert.ok(!script.includes("set -x"), "must NOT contain 'set -x' (would leak token to trace log)");
      // unset GITHUB_TOKEN must appear AFTER the install-core block (D-9).
      const installCoreEnd = script.indexOf("# --- end install-core ---");
      const unsetIdx = script.indexOf("unset GITHUB_TOKEN");
      assert.ok(unsetIdx !== -1, "must contain 'unset GITHUB_TOKEN'");
      assert.ok(
        unsetIdx > installCoreEnd,
        `'unset GITHUB_TOKEN' (pos ${unsetIdx}) must appear after end-of-install-core marker (pos ${installCoreEnd})`,
      );
    },
  );
});

// ─── T-BT.5 ──────────────────────────────────────────────────────────────────

describe("renderBootstrapScript — variable substitution regression (G-P34.3 sibling / P-27 regression)", () => {
  it(
    "T-BT.5: when renderBootstrapScript called, SERVER_URL, INVITE_TOKEN, MAI_VERSION are the passed arg values (P-27 substitution regression)",
    () => {
      // Given: serverUrl='http://100.64.0.5:3031', inviteToken='ab'.repeat(32), maiVersion='0.4.32'
      // When:  renderBootstrapScript(serverUrl, inviteToken, maiVersion, installToken)
      // Then:  SERVER_URL="http://100.64.0.5:3031", INVITE_TOKEN='ab'.repeat(32), MAI_VERSION="0.4.32" in output
      const script = renderBootstrapScript(SERVER_URL, INVITE_TOKEN, MAI_VERSION, INSTALL_TOKEN_PLACEHOLDER);
      // Variable assignment lines (P-27 regression: values must match args)
      assert.ok(script.includes(`SERVER_URL="${SERVER_URL}"`), `SERVER_URL must be assigned to '${SERVER_URL}'`);
      assert.ok(script.includes(`INVITE_TOKEN="${INVITE_TOKEN}"`), `INVITE_TOKEN must be assigned to invite hex`);
      assert.ok(script.includes(`MAI_VERSION="${MAI_VERSION}"`), `MAI_VERSION must be assigned to '${MAI_VERSION}'`);
    },
  );
});
