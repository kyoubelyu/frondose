/**
 * P-13 Step 4a — T-AuthI.1..6 + T-AuthI.5b scaffolds
 *
 * Tests: runAuthSubcommand interactive paths (set/remove/default dual-mode)
 * Gate coverage: G-P13.2 + G-P13.7
 *
 * NOTE: Imports _mockPrompter.ts which itself imports _prompts.ts (does NOT exist
 * at Step 4a). All tests will fail at import-resolution until builder Step 4b.
 * This is the expected scaffold failure mode. Step 5 fills assertion bodies.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runAuthSubcommand } from "../../../src/cli/subcommands/auth.js";
import { captureStdout, makeMockPrompter, stubInteractive } from "./_mockPrompter.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpAuthDir(): { authPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p13-auth-"));
  return {
    authPath: join(dir, "auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface AuthJson {
  providers?: Record<string, { key: string; baseUrl?: string }>;
  default?: string;
}

function readAuthJson(authPath: string): AuthJson {
  try {
    return JSON.parse(readFileSync(authPath, "utf-8")) as AuthJson;
  } catch {
    return {};
  }
}

// ─── T-AuthI.1 ───────────────────────────────────────────────────────────────

describe("runAuthSubcommand — args-present (non-interactive path)", () => {
  it("T-AuthI.1: when full positional args present, writes auth.json AND prompter is NOT called", async () => {
    // Given: spec="anthropic:claude-sonnet-4-5" and key="sk-test" both present in opts
    // When:  runAuthSubcommand("set", { spec, key }, mockPrompter) is called
    // Then:  auth.json is written with the new key; no prompter method is invoked

    const { authPath, cleanup } = makeTmpAuthDir();
    const mp = makeMockPrompter();
    try {
      await captureStdout(() =>
        runAuthSubcommand("set", { spec: "anthropic:claude-sonnet-4-5", key: "sk-test", authPath }, mp),
      );
      const written = readAuthJson(authPath);
      assert.ok(written.providers?.anthropic?.key, "T-AuthI.1: key must be written");
      assert.equal(mp.calls.providerSelect.length, 0, "T-AuthI.1: providerSelect MUST NOT be called");
      assert.equal(mp.calls.apiKeyInput.length, 0, "T-AuthI.1: apiKeyInput MUST NOT be called");
    } finally {
      cleanup();
    }
  });
});

// ─── T-AuthI.2 ───────────────────────────────────────────────────────────────

describe("runAuthSubcommand('set') — interactive path (no args)", () => {
  it("T-AuthI.2: when no args AND isInteractive() returns true, calls providerSelect+apiKeyInput and writes auth.json", async () => {
    // Given: no spec/key in opts; stdin.isTTY=true; MAI_NO_INTERACTIVE unset
    // When:  runAuthSubcommand("set", {}, mockPrompter) with providerSelect→"anthropic:claude-sonnet-4-5" apiKeyInput→"sk-mock-123"
    // Then:  auth.json written with anthropic provider key; both prompter methods called once

    const { authPath, cleanup } = makeTmpAuthDir();
    const restore = stubInteractive(true);
    const mp = makeMockPrompter({
      providerSelect: async () => "anthropic:claude-sonnet-4-5",
      apiKeyInput: async () => "sk-mock-123",
    });
    try {
      await captureStdout(() => runAuthSubcommand("set", { authPath }, mp));
      const written = readAuthJson(authPath);
      assert.equal(written.providers?.anthropic?.key, "sk-mock-123", "T-AuthI.2: key must be stored");
      assert.equal(mp.calls.providerSelect.length, 1, "T-AuthI.2: providerSelect called once");
      assert.equal(mp.calls.apiKeyInput.length, 1, "T-AuthI.2: apiKeyInput called once");
    } finally {
      restore();
      cleanup();
    }
  });
});

// ─── T-AuthI.3 ───────────────────────────────────────────────────────────────

describe("runAuthSubcommand('remove') — args-present regression", () => {
  it("T-AuthI.3: when provider arg present, removes it AND prompter is NOT invoked", async () => {
    // Given: opts.provider="anthropic" present; existing auth.json has anthropic key
    // When:  runAuthSubcommand("remove", { provider: "anthropic", authPath }, mockPrompter)
    // Then:  anthropic removed from auth.json; no prompter invocation

    const { authPath, cleanup } = makeTmpAuthDir();
    const mp = makeMockPrompter();
    try {
      // Pre-write auth.json with anthropic configured
      writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "sk-existing" } } }), "utf-8");

      await captureStdout(() => runAuthSubcommand("remove", { provider: "anthropic", authPath }, mp));
      const written = readAuthJson(authPath);
      assert.ok(!written.providers?.anthropic, "T-AuthI.3: anthropic must be removed");
      assert.equal(mp.calls.providerSelect.length, 0, "T-AuthI.3: prompter MUST NOT be called");
    } finally {
      cleanup();
    }
  });
});

// ─── T-AuthI.4 ───────────────────────────────────────────────────────────────

describe("runAuthSubcommand('remove') — interactive path", () => {
  it("T-AuthI.4: when no provider AND isInteractive()=true AND auth has 2 providers, calls providerSelect and removes the selected one", async () => {
    // Given: no provider in opts; stdin.isTTY=true; auth.json has anthropic+openai
    // When:  runAuthSubcommand("remove", {}, mockPrompter) with providerSelect→"openai"
    // Then:  openai removed from auth.json; providerSelect received the configured-providers array; anthropic preserved

    const { authPath, cleanup } = makeTmpAuthDir();
    const restore = stubInteractive(true);
    const mp = makeMockPrompter({
      providerSelect: async () => "openai",
    });
    try {
      writeFileSync(
        authPath,
        JSON.stringify({ providers: { anthropic: { key: "sk-a" }, openai: { key: "sk-o" } } }),
        "utf-8",
      );

      await captureStdout(() => runAuthSubcommand("remove", { authPath }, mp));
      const written = readAuthJson(authPath);
      assert.ok(!written.providers?.openai, "T-AuthI.4: openai must be removed");
      assert.ok(written.providers?.anthropic, "T-AuthI.4: anthropic must be preserved");
      assert.equal(mp.calls.providerSelect.length, 1, "T-AuthI.4: providerSelect called once");
      const passedChoices = mp.calls.providerSelect[0] as string[];
      assert.ok(
        passedChoices.includes("anthropic") && passedChoices.includes("openai"),
        "T-AuthI.4: providerSelect must receive configured providers",
      );
    } finally {
      restore();
      cleanup();
    }
  });
});

// ─── T-AuthI.5 ───────────────────────────────────────────────────────────────

describe("runAuthSubcommand('default') — interactive path", () => {
  it("T-AuthI.5: when no spec AND isInteractive()=true AND auth has 2 providers, calls providerSelect and writes default field", async () => {
    // Given: no spec in opts; stdin.isTTY=true; auth.json has anthropic+openai; mock returns "openai:gpt-4o"
    // When:  runAuthSubcommand("default", {}, mockPrompter)
    // Then:  auth.json.default === "openai:gpt-4o"

    const { authPath, cleanup } = makeTmpAuthDir();
    const restore = stubInteractive(true);
    const mp = makeMockPrompter({
      providerSelect: async () => "openai:gpt-4o",
    });
    try {
      writeFileSync(
        authPath,
        JSON.stringify({ providers: { anthropic: { key: "sk-a" }, openai: { key: "sk-o" } } }),
        "utf-8",
      );

      await captureStdout(() => runAuthSubcommand("default", { authPath }, mp));
      const written = readAuthJson(authPath);
      assert.equal(written.default, "openai:gpt-4o", "T-AuthI.5: default must match providerSelect return value");
    } finally {
      restore();
      cleanup();
    }
  });

  it("T-AuthI.5b (C-3): auth.json.default is set to the exact value returned by providerSelect (surfaces full-spec vs family-key write behavior)", async () => {
    // Given: no spec in opts; isInteractive()=true; auth.json has providers ["anthropic", "openai"]
    // When:  runAuthSubcommand("default", {}, mockPrompter) with providerSelect→"anthropic" (family key, not full spec)
    // Then:  auth.json.default === "anthropic" (write-path correctly stores whatever providerSelect returned)
    //        NOTE: This test surfaces C-3 — if the implementation stores "anthropic:claude-sonnet-4-5" instead
    //        of "anthropic", the assertion will fail, revealing the full-spec vs family-key mismatch.

    const { authPath, cleanup } = makeTmpAuthDir();
    const restore = stubInteractive(true);
    const mp = makeMockPrompter({
      providerSelect: async () => "anthropic", // family key — what realPrompter would return based on Object.keys
    });
    try {
      writeFileSync(
        authPath,
        JSON.stringify({ providers: { anthropic: { key: "sk-a" }, openai: { key: "sk-o" } } }),
        "utf-8",
      );

      await captureStdout(() => runAuthSubcommand("default", { authPath }, mp));
      const written = readAuthJson(authPath);
      // C-3 concern: the write-path must store providerSelect's EXACT return value.
      // If impl stores "anthropic" (family key returned by providerSelect), this passes.
      // If impl expands to "anthropic:claude-sonnet-4-5", this fails → surfaces C-3 bug.
      assert.equal(
        written.default,
        "anthropic",
        "T-AuthI.5b: default must be exactly what providerSelect returned (C-3 write-path verification)",
      );
    } finally {
      restore();
      cleanup();
    }
  });
});

// ─── T-AuthI.6 ───────────────────────────────────────────────────────────────

describe("runAuthSubcommand('set') — __NEW__ sentinel path (C-1 Option A)", () => {
  it("T-AuthI.6: when providerSelect returns '__NEW__', calls prompter.input for spec, writes new provider while preserving existing", async () => {
    // Given: stdin.isTTY=true; auth.json has anthropic; providerSelect→"__NEW__"; input→"openai:gpt-4o"; apiKeyInput→"sk-new-test"
    // When:  runAuthSubcommand("set", {}, mockPrompter)
    // Then:  auth.json has BOTH anthropic AND openai entries; stdout mentions new provider

    const { authPath, cleanup } = makeTmpAuthDir();
    const restore = stubInteractive(true);
    const mp = makeMockPrompter({
      providerSelect: async () => "__NEW__",
      input: async () => "openai:gpt-4o",
      apiKeyInput: async () => "sk-new-test",
    });
    try {
      writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "sk-existing" } } }), "utf-8");

      const stdout = await captureStdout(async () => {
        await runAuthSubcommand("set", { authPath }, mp);
      });

      const written = readAuthJson(authPath);
      assert.ok(written.providers?.anthropic, "T-AuthI.6: existing anthropic must be preserved");
      assert.ok(written.providers?.openai, "T-AuthI.6: new openai entry must be added");
      assert.equal(
        (written.providers as Record<string, { key: string }>)?.openai?.key,
        "sk-new-test",
        "T-AuthI.6: new key must be stored",
      );
      assert.ok(
        stdout.includes("openai") || stdout.includes("provider"),
        `T-AuthI.6: stdout mentions provider; got: "${stdout}"`,
      );
      assert.equal(mp.calls.input.length, 1, "T-AuthI.6: input() called once for spec collection");
    } finally {
      restore();
      cleanup();
    }
  });
});
