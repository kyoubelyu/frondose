/**
 * P-13 Step 4a — T-Nonint.1 scaffold + future auth regression tests
 *
 * T-Nonint.1: existing auth subcommand calls with positional args MUST continue
 * to pass when the new optional `prompter` parameter is OMITTED (backward-compat).
 *
 * Gate coverage: G-P13.7
 *
 * NOTE: The `runAuthSubcommand` signature gains a 3rd optional `prompter?` parameter
 * at Step 4b (P-13). These tests call the function with only 2 args (pre-P-13 call
 * pattern) to verify the default-prompter fallback keeps existing callers unaffected.
 *
 * Tests with 2-arg call pattern compile and run BEFORE Step 4b since auth.ts already
 * exists. They will PASS after Step 4b. At Step 4a they should pass since the
 * 2-arg signature is backward-compatible (prompter is optional with a default).
 *
 * Actually at Step 4a (before builder adds the prompter param), calling with 2 args
 * is the ONLY valid signature — so these tests pass immediately if the imports resolve.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runAuthSubcommand } from "../../src/cli/subcommands/auth.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpAuthDir(): { authPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p13-nonint-auth-"));
  return {
    authPath: join(dir, "auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return fn()
    .finally(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = orig;
    })
    .then(() => chunks.join(""));
}

// ─── T-Nonint.1 ──────────────────────────────────────────────────────────────

describe("runAuthSubcommand — backward-compat regression (prompter arg omitted)", () => {
  it("T-Nonint.1a: 'set' with full positional args (no prompter) writes auth.json correctly", async () => {
    // Given: runAuthSubcommand called with 2 args only (pre-P-13 call pattern)
    // When:  runAuthSubcommand("set", { spec: "anthropic:claude-sonnet-4-5", key: "sk-test", authPath })
    // Then:  auth.json written with anthropic key; function returns normally (no prompter invoked)

    const { authPath, cleanup } = makeTmpAuthDir();
    try {
      await captureStdout(() =>
        runAuthSubcommand("set", { spec: "anthropic:claude-sonnet-4-5", key: "sk-nonint-test", authPath }),
      );
      const written = JSON.parse(readFileSync(authPath, "utf-8"));
      assert.equal(
        written.providers?.anthropic?.key,
        "sk-nonint-test",
        "T-Nonint.1a: key must be written correctly with 2-arg call",
      );
    } finally {
      cleanup();
    }
  });

  it("T-Nonint.1b: 'list' with no providers (no prompter) prints 'No auth.json found' message", async () => {
    // Given: runAuthSubcommand called with 2 args; no auth.json exists yet
    // When:  runAuthSubcommand("list", { authPath })
    // Then:  stdout contains message about no auth.json; function returns normally

    const { authPath, cleanup } = makeTmpAuthDir();
    try {
      const stdout = await captureStdout(() => runAuthSubcommand("list", { authPath }));
      assert.ok(
        stdout.includes("No auth.json found") || stdout.includes("not found"),
        `T-Nonint.1b: must print no-auth message; got: "${stdout}"`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-Nonint.1c: 'remove' with provider arg present (no prompter) removes provider from auth.json", async () => {
    // Given: auth.json has anthropic+openai; runAuthSubcommand called with 2 args
    // When:  runAuthSubcommand("remove", { provider: "openai", authPath })
    // Then:  openai removed; anthropic preserved

    const { authPath, cleanup } = makeTmpAuthDir();
    try {
      writeFileSync(
        authPath,
        JSON.stringify({ providers: { anthropic: { key: "sk-a" }, openai: { key: "sk-o" } } }),
        "utf-8",
      );

      await captureStdout(() => runAuthSubcommand("remove", { provider: "openai", authPath }));
      const written = JSON.parse(readFileSync(authPath, "utf-8"));
      assert.ok(!written.providers?.openai, "T-Nonint.1c: openai must be removed");
      assert.ok(written.providers?.anthropic, "T-Nonint.1c: anthropic must be preserved");
    } finally {
      cleanup();
    }
  });

  it("T-Nonint.1d: 'default' with spec arg present (no prompter) writes default field to auth.json", async () => {
    // Given: auth.json has anthropic; runAuthSubcommand called with 2 args + spec
    // When:  runAuthSubcommand("default", { spec: "anthropic:claude-sonnet-4-5", authPath })
    // Then:  auth.json.default === "anthropic:claude-sonnet-4-5"

    const { authPath, cleanup } = makeTmpAuthDir();
    try {
      writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "sk-a" } } }), "utf-8");

      await captureStdout(() => runAuthSubcommand("default", { spec: "anthropic:claude-sonnet-4-5", authPath }));
      const written = JSON.parse(readFileSync(authPath, "utf-8"));
      assert.equal(
        written.default,
        "anthropic:claude-sonnet-4-5",
        "T-Nonint.1d: default field must be written correctly",
      );
    } finally {
      cleanup();
    }
  });
});
