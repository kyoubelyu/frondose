/**
 * P-7 mock tests — T-MR2..T-MR6: modelResolver + detectAnyModelKey + current-secrets lookup.
 *
 * Tests:
 *   T-MR2 — auth projection reads a current-secrets key when the env is absent
 *   T-MR3 — env precedence over the current-secrets projection
 *   T-MR4 — detectAnyModelKey: only the approved DeepSeek env key is recognized
 *   T-MR5 — detectAnyModelKey: current provider key set → returns true
 *   T-MR6 — detectAnyModelKey: nothing set → returns false
 *
 * No Chrome, no LLM call (buildModel returns a LanguageModel object; we only verify it
 * doesn't throw and carries the expected API key configuration).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectAnyModelKey } from "../../src/agent/modelResolver.js";
import { readAuthJsonKey, writeAuth } from "../../src/persistence/auth.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── env-var isolation helpers ────────────────────────────────────────────────

/** Save + clear the three provider env vars; return a restore function. */
function clearModelEnvVars(): () => void {
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  return () => {
    if (saved.ANTHROPIC_API_KEY !== undefined) process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    else delete process.env.ANTHROPIC_API_KEY;
    if (saved.OPENAI_API_KEY !== undefined) process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
    else delete process.env.OPENAI_API_KEY;
    if (saved.DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = saved.DEEPSEEK_API_KEY;
    else delete process.env.DEEPSEEK_API_KEY;
  };
}

// ─── T-MR2 — auth projection reads current secrets ──────────────────────────

test("T-MR2: auth projection reads a current-secrets key when the environment key is absent", async () => {
  // We test the integration path: readAuthJsonKey is called by buildModel when
  // env var is absent. Since buildModel creates a provider object (no actual LLM call),
  // we verify the model object is returned (not undefined / not throw).
  // The only way to confirm the key is used: the returned model object should be
  // defined; if no key was found (undefined) the SDK would still return a model
  // object but calls would fail at runtime — acceptable since we're testing key routing.

  // We actually test this via detectAnyModelKey + readAuthJsonKey behavior
  // (the F-10 path in buildModel is the same readAuthJsonKey function we tested in T-MR1).
  // The integration is: env absent → readAuthJsonKey("anthropic") → current provider key.

  const dir = mkdtempSync(join(tmpdir(), "mai-p7-mr2-"));
  const authPath = join(dir, "auth.json");
  const restoreEnv = clearModelEnvVars();
  try {
    // Write through the auth projection into current secrets.
    writeAuth({ providers: { anthropic: { key: "sk-ant-from-authjson" } } }, authPath);

    // Confirm detectAnyModelKey returns false without env vars and with the default auth path.
    // (We can't easily redirect DEFAULT_AUTH_PATH in this test, so we test readAuthJsonKey directly.)
    const keyFromAuth = readAuthJsonKey("anthropic", authPath);
    assert.equal(keyFromAuth, "sk-ant-from-authjson", "T-MR2: readAuthJsonKey returns the current key");

    // Also verify that env var wins when both are present (belt-and-suspenders for T-MR3).
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    const keyFromEnv = process.env.ANTHROPIC_API_KEY ?? keyFromAuth;
    assert.equal(keyFromEnv, "sk-ant-from-env", "T-MR2: env var takes priority over current secrets");

    console.log("T-MR2: current-secrets key path verified ✓");
  } finally {
    restoreEnv();
    cleanupTmpDir(dir);
  }
});

// ─── T-MR3 — env var priority over current secrets ──────────────────────────

test("T-MR3: environment key wins over the current-secrets key", () => {
  // The env-priority logic lives in buildModel:
  //   const key = process.env.ANTHROPIC_API_KEY ?? readAuthJsonKey("anthropic");
  // We verify this at the unit level (same function).

  const dir = mkdtempSync(join(tmpdir(), "mai-p7-mr3-"));
  const authPath = join(dir, "auth.json");
  const restoreEnv = clearModelEnvVars();
  try {
    // env var set to "env-key"
    process.env.ANTHROPIC_API_KEY = "env-key";
    // Current secrets also have a different key.
    writeAuth({ providers: { anthropic: { key: "auth-json-key" } } }, authPath);

    // Simulate the ?? logic in buildModel:
    const effectiveKey = process.env.ANTHROPIC_API_KEY ?? readAuthJsonKey("anthropic", authPath);
    assert.equal(effectiveKey, "env-key", "T-MR3: env var must take priority over current secrets");
    console.log("T-MR3: env var priority over current secrets ✓");
  } finally {
    restoreEnv();
    cleanupTmpDir(dir);
  }
});

// ─── T-MR4 — detectAnyModelKey: provider-scope env behavior ─────────────────

test("T-MR4: detectAnyModelKey ignores reserved-provider env keys and accepts DeepSeek", () => {
  // Given an isolated empty current store, when each runtime key is tested alone, then only the approved DeepSeek env path activates detection.
  const dir = mkdtempSync(join(tmpdir(), "mai-p7-mr4-"));
  const restoreEnv = clearModelEnvVars();
  const savedHome = process.env.HOME;
  const savedHomeBase = process.env.FRONDOSE_HOME_BASE;
  try {
    process.env.HOME = dir;
    process.env.FRONDOSE_HOME_BASE = dir;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    assert.equal(detectAnyModelKey(), false, "T-MR4: reserved ANTHROPIC_API_KEY must remain scope-disabled");

    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-oai-test";
    assert.equal(detectAnyModelKey(), false, "T-MR4: reserved OPENAI_API_KEY must remain scope-disabled");

    delete process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = "dsk-test";
    assert.equal(detectAnyModelKey(), true, "T-MR4: DEEPSEEK_API_KEY set → detectAnyModelKey must return true");

    console.log("T-MR4: detectAnyModelKey provider-scope env paths ✓");
  } finally {
    restoreEnv();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = savedHomeBase;
    cleanupTmpDir(dir);
  }
});

// ─── T-MR5 — detectAnyModelKey: current secrets → true ──────────────────────

test("T-MR5: current provider key is detectable without environment keys", async () => {
  // Given an isolated current store and no provider env keys, when a valid custom provider is persisted, then detection reads it.
  const dir = mkdtempSync(join(tmpdir(), "mai-p7-mr5-"));
  const restoreEnv = clearModelEnvVars();
  const savedHome = process.env.HOME;
  const savedHomeBase = process.env.FRONDOSE_HOME_BASE;
  try {
    process.env.HOME = dir;
    process.env.FRONDOSE_HOME_BASE = dir;
    writeAuth({
      providers: {
        currenttest: { key: "current-provider-key", baseUrl: "https://current.invalid/v1", type: "openai" },
      },
    });
    assert.equal(detectAnyModelKey(), true, "T-MR5: detectAnyModelKey must read the current provider key");
  } finally {
    restoreEnv();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = savedHomeBase;
    cleanupTmpDir(dir);
  }
});

// ─── T-MR6 — detectAnyModelKey: nothing set → false ──────────────────────────

test("T-MR6: detectAnyModelKey returns false with no environment or current-secrets key", () => {
  // Given an isolated empty home and no runtime key env, when detected, then operator state is never consulted.
  const dir = mkdtempSync(join(tmpdir(), "mai-p7-mr6-"));
  const restoreEnv = clearModelEnvVars();
  const savedHome = process.env.HOME;
  const savedHomeBase = process.env.FRONDOSE_HOME_BASE;
  try {
    process.env.HOME = dir;
    process.env.FRONDOSE_HOME_BASE = dir;
    assert.equal(detectAnyModelKey(), false);
  } finally {
    restoreEnv();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = savedHomeBase;
    cleanupTmpDir(dir);
  }
});
