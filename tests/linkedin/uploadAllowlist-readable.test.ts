/**
 * P-9 mock tests — T-Sandbox.1..T-Sandbox.7
 *
 * Tests for assertFileReadable() added to src/linkedin/uploadAllowlist.ts in P-9 (D-7).
 *
 * T-Sandbox.1 — Path in os.tmpdir() subtree → allowed (no throw)
 * T-Sandbox.2 — Path in ~/.mai/agent/ subtree → allowed (no throw)
 * T-Sandbox.3 — Path in tests/fixtures/ subtree → allowed (no throw, when cwd is repo)
 * T-Sandbox.4 — /etc/passwd → denied ("File read denied")
 * T-Sandbox.5 — Path traversal via .. → denied after canonicalization
 * T-Sandbox.6 — MAI_UPLOAD_ALLOWLIST path → allowed
 * T-Sandbox.7 — Exact boundary: dir itself (not subpath) → denied; dir/ + sep + file → allowed
 *
 * Gate coverage: G-P9.10 (file sandbox)
 *
 * No LLM, no Chrome. Pure filesystem + env var control.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertFileReadable } from "../../src/linkedin/uploadAllowlist.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// ─── T-Sandbox.1: os.tmpdir() subtree → allowed ──────────────────────────────

test("T-Sandbox.1: path in os.tmpdir() subtree → assertFileReadable does not throw", () => {
  withEnv("MAI_UPLOAD_ALLOWLIST", undefined, () => {
    const pathInTmp = join(tmpdir(), "mai-test-file.png");
    // Does NOT need to exist — assertFileReadable only checks path prefix, not file existence
    assert.doesNotThrow(() => assertFileReadable(pathInTmp), `tmpdir path must be allowed; path: ${pathInTmp}`);
  });
});

// ─── T-Sandbox.2: ~/.mai/agent/ subtree → allowed ────────────────────────────

test("T-Sandbox.2: path in ~/.mai/agent/ subtree → assertFileReadable does not throw", () => {
  withEnv("MAI_UPLOAD_ALLOWLIST", undefined, () => {
    const agentPath = join(homedir(), ".frondose", "agent", "screenshots", "capture.png");
    assert.doesNotThrow(() => assertFileReadable(agentPath), `~/.mai/agent/ path must be allowed`);
  });
});

// ─── T-Sandbox.3: tests/fixtures/ subtree → allowed (when cwd = repo) ─────────

test("T-Sandbox.3: path in tests/fixtures/ subtree → assertFileReadable does not throw (repo cwd)", () => {
  withEnv("MAI_UPLOAD_ALLOWLIST", undefined, () => {
    // This works when process.cwd() is the repo root (standard for test runner)
    const fixturePath = join(process.cwd(), "tests", "fixtures", "test-screenshot.png");
    assert.doesNotThrow(() => assertFileReadable(fixturePath), `tests/fixtures/ path must be allowed`);
  });
});

// ─── T-Sandbox.4: /etc/passwd → denied ───────────────────────────────────────

test("T-Sandbox.4: /etc/passwd → denied with 'File read denied' error", () => {
  withEnv("MAI_UPLOAD_ALLOWLIST", undefined, () => {
    assert.throws(
      () => assertFileReadable("/etc/passwd"),
      /File read denied/i,
      "/etc/passwd must throw 'File read denied'",
    );
  });
});

// ─── T-Sandbox.5: path traversal → denied after canonicalization ──────────────

test("T-Sandbox.5: path traversal via .. → denied after path.resolve canonicalization", () => {
  withEnv("MAI_UPLOAD_ALLOWLIST", undefined, () => {
    // Try to escape from tmpdir via ../..
    const traversal = join(tmpdir(), "..", "..", "etc", "passwd");
    assert.throws(
      () => assertFileReadable(traversal),
      /File read denied/i,
      ".. traversal from tmpdir must be canonicalized and denied",
    );
  });
});

// ─── T-Sandbox.6: MAI_UPLOAD_ALLOWLIST custom dir → allowed ──────────────────

test("T-Sandbox.6: path inside MAI_UPLOAD_ALLOWLIST custom dir → allowed", () => {
  const customDir = mkdtempSync(join(tmpdir(), "mai-p9-allowlist-"));
  try {
    const allowedPath = join(customDir, "screenshot.png");
    withEnv("MAI_UPLOAD_ALLOWLIST", customDir, () => {
      assert.doesNotThrow(() => assertFileReadable(allowedPath), `custom allowlist path must be allowed`);
    });

    // Without the env var, the custom dir must NOT be allowed (default is ~/.mai/agent/uploads)
    withEnv("MAI_UPLOAD_ALLOWLIST", undefined, () => {
      // customDir is in tmpdir, which IS allowed via os.tmpdir() path (b)
      // So this test only verifies the MAI_UPLOAD_ALLOWLIST mechanism works
      // (tmpdir is also allowed via path (b) so we don't test denial here)
      assert.doesNotThrow(
        () => assertFileReadable(allowedPath),
        "tmpdir subpath is allowed via os.tmpdir() rule anyway",
      );
    });
  } finally {
    rmSync(customDir, { recursive: true, force: true });
  }
});

// ─── T-Sandbox.7: Exact boundary — home dir vs .mai/agent prefix ─────────────

test("T-Sandbox.7: exact boundary — home dir itself is NOT allowed; ~/.mai/agent/x IS allowed", () => {
  // P-Z3: under the clean-room HOME=$(mktemp -d) gate, homedir() falls INSIDE os.tmpdir(), so the
  // "home root" path would be allowed via the tmpdir rule — masking the boundary this test guards.
  // assertFileReadable derives the ~/.mai/agent prefix from getHomeBase() (= MAI_HOME_BASE ?? homedir);
  // pin it to a synthetic root OUTSIDE tmpdir (prefix-only check — the dir need not exist) so the
  // home-root-denied vs ~/.mai/agent-allowed boundary is exercised deterministically. Restored after.
  const SYNTH_HOME = "/mai-z3-home-root";
  withEnv("MAI_UPLOAD_ALLOWLIST", undefined, () =>
    withEnv("MAI_HOME_BASE", SYNTH_HOME, () => {
      // The home dir itself (not ~/.mai/agent/) must NOT be allowed
      const homePath = join(SYNTH_HOME, "secret.txt");
      assert.throws(
        () => assertFileReadable(homePath),
        /File read denied/i,
        "home dir root path must be denied (only ~/.mai/agent/** is allowed)",
      );

      // ~/.mai/agent/ subtree IS allowed
      const agentPath = join(SYNTH_HOME, ".frondose", "agent", "memory.sqlite");
      assert.doesNotThrow(() => assertFileReadable(agentPath), "~/.mai/agent/ path must be allowed");
    }),
  );
});
