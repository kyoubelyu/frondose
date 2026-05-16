/**
 * P-27 Step 5 — T-TPL.1..3
 *
 * Tests for src/cli/serverBootstrapTemplate.ts — renderBootstrapScript().
 * Gate coverage: G-P27.19 (macOS guard, brew, node20, mai install, bootstrap-register call),
 *                G-P27.20 (HTTP response has correct substitutions)
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
    assert.ok(script.includes(`npm install -g "@kyoube/mai-agent@`), "must contain npm install of mai-agent");
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
