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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runAuthSubcommand } from "../../../src/cli/subcommands/auth.js";
import { readAuth } from "../../../src/persistence/auth.js";
import { captureStdout, makeMockPrompter, stubInteractive, stubProcessExit } from "./_mockPrompter.js";

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

// P-Z3: P-24 path-shift — writeAuth routes to secrets.json (co-located with authPath).
// Read back via the readAuth persistence shim (NOT a raw JSON.parse of authPath, which
// would only see a stale pre-write). The shim reads secrets.json, falling back to the
// legacy authPath on first read.
function readAuthJson(authPath: string): AuthJson {
  return (readAuth(authPath) ?? {}) as AuthJson;
}

// P-Z3 (plan §6.2 / OQ-Z3.2): defensive process.exit stub for the whole file.
// runAuthSubcommand calls process.exit(1) on missing-arg branches (auth.ts:140,168,191,…);
// without this, a single stale call collapses the entire file at :1:1 instead of failing
// one isolated test. The stub makes process.exit throw; tests that exercise the happy
// (interactive, all-prompts-answered) path never trip it.
let exitStub: ReturnType<typeof stubProcessExit>;
before(() => {
  exitStub = stubProcessExit();
});
after(() => {
  exitStub.restore();
});

// ─── T-AuthI.1 ───────────────────────────────────────────────────────────────

describe("runAuthSubcommand — args-present (non-interactive path)", () => {
  it("T-AuthI.1: when full positional args present (P-21 URL API), writes auth.json AND prompter is NOT called", async () => {
    // Given: url+key+model+name all present in opts (P-21 URL-based API, replacing the old spec:)
    // When:  runAuthSubcommand("set", { url, key, model, name, authPath }, mockPrompter) is called non-interactively
    // Then:  auth.json (secrets.json) written with the anthropic key; no prompter method invoked

    const { authPath, cleanup } = makeTmpAuthDir();
    const mp = makeMockPrompter();
    try {
      await captureStdout(() =>
        runAuthSubcommand(
          "set",
          {
            url: "https://api.anthropic.com/v1",
            key: "sk-test",
            model: "claude-sonnet-4-5",
            name: "anthropic",
            authPath,
          },
          mp,
        ),
      );
      const written = readAuthJson(authPath);
      assert.equal(written.providers?.anthropic?.key, "sk-test", "T-AuthI.1: key must be written");
      assert.equal(mp.calls.providerSelect.length, 0, "T-AuthI.1: providerSelect MUST NOT be called");
      assert.equal(mp.calls.apiKeyInput.length, 0, "T-AuthI.1: apiKeyInput MUST NOT be called");
      assert.equal(mp.calls.input.length, 0, "T-AuthI.1: input MUST NOT be called when all args present");
    } finally {
      cleanup();
    }
  });
});

// ─── T-AuthI.2 ───────────────────────────────────────────────────────────────

describe("runAuthSubcommand('set') — interactive path (no args)", () => {
  it("T-AuthI.2: when no args AND isInteractive() returns true, prompts URL→Key→Model→Name and writes auth.json", async () => {
    // Given: no url/key/model in opts; stdin.isTTY=true; MAI_NO_INTERACTIVE unset
    // When:  runAuthSubcommand("set", { authPath, fetchImpl }, mockPrompter) — P-21 URL flow;
    //        fetchImpl returns an empty model list so the flow falls to input("Model ID…") (no modelSelect)
    // Then:  auth.json (secrets.json) written with the deepseek provider key from apiKeyInput;
    //        input() prompts URL+Model+Name; apiKeyInput called once; providerSelect NOT used in set

    const { authPath, cleanup } = makeTmpAuthDir();
    const restore = stubInteractive(true);
    const emptyModelsFetch: typeof globalThis.fetch = async () =>
      ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as Response;
    const mp = makeMockPrompter({
      input: async (msg) => {
        if (msg.includes("URL")) return "https://api.deepseek.com/v1";
        if (msg.includes("Model")) return "deepseek-chat";
        return ""; // provider-name prompt → empty accepts the derived default "deepseek"
      },
      apiKeyInput: async () => "sk-mock-123",
    });
    try {
      await captureStdout(() => runAuthSubcommand("set", { authPath, fetchImpl: emptyModelsFetch }, mp));
      const written = readAuthJson(authPath);
      assert.equal(written.providers?.deepseek?.key, "sk-mock-123", "T-AuthI.2: key must be stored");
      assert.equal(
        (written.providers as Record<string, { baseUrl?: string }>)?.deepseek?.baseUrl,
        "https://api.deepseek.com/v1",
        "T-AuthI.2: baseUrl from URL prompt must be stored",
      );
      assert.equal(mp.calls.apiKeyInput.length, 1, "T-AuthI.2: apiKeyInput called once");
      assert.equal(mp.calls.providerSelect.length, 0, "T-AuthI.2: providerSelect is NOT used in the URL set flow");
      assert.equal(mp.calls.input.length, 3, "T-AuthI.2: input prompts URL + Model ID + provider-name");
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

describe("runAuthSubcommand('set') — interactive add preserves existing providers", () => {
  it("T-AuthI.6: when interactive set adds a new provider, it preserves existing entries", async () => {
    // Given: stdin.isTTY=true; auth.json already has anthropic; interactive URL flow for a new openai provider
    //        (P-21 removed the __NEW__ providerSelect sentinel from set — it now prompts URL/key/model/name directly)
    // When:  runAuthSubcommand("set", { authPath, fetchImpl }, mockPrompter) with url=openai, key=sk-new-test
    // Then:  auth.json has BOTH anthropic AND openai; new openai key stored; stdout mentions the new provider

    const { authPath, cleanup } = makeTmpAuthDir();
    const restore = stubInteractive(true);
    const emptyModelsFetch: typeof globalThis.fetch = async () =>
      ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as Response;
    const mp = makeMockPrompter({
      input: async (msg) => {
        if (msg.includes("URL")) return "https://api.openai.com/v1";
        if (msg.includes("Model")) return "gpt-4o";
        return ""; // name prompt → derived default "openai"
      },
      apiKeyInput: async () => "sk-new-test",
    });
    try {
      writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { key: "sk-existing" } } }), "utf-8");

      const stdout = await captureStdout(async () => {
        await runAuthSubcommand("set", { authPath, fetchImpl: emptyModelsFetch }, mp);
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
    } finally {
      restore();
      cleanup();
    }
  });
});
