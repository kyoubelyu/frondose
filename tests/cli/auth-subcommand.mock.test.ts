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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Prompter } from "../../src/cli/subcommands/_prompts.js";
import { type AuthSubcommandOpts, runAuthSubcommand } from "../../src/cli/subcommands/auth.js";
import { readAuth } from "../../src/persistence/auth.js";

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
    // When:  runAuthSubcommand("set", { url, key, model, name, authPath }) — P-21 URL-based API
    // Then:  auth.json written with anthropic key; function returns normally (no prompter invoked)
    // NOTE: P-21 replaced spec: + key: with url: + key: + model: + name: for the "set" action.

    const { authPath, cleanup } = makeTmpAuthDir();
    try {
      await captureStdout(() =>
        runAuthSubcommand("set", {
          url: "https://api.anthropic.com/v1",
          key: "sk-nonint-test",
          model: "claude-sonnet-4-5",
          name: "anthropic",
          authPath,
        }),
      );
      // P-24 path-shift: writeAuth now routes to secrets.json; use readAuth to read back
      const written = readAuth(authPath);
      assert.equal(
        written?.providers?.anthropic?.key,
        "sk-nonint-test",
        "T-Nonint.1a: key must be written correctly with URL-based call",
      );
    } finally {
      cleanup();
    }
  });

  it("T-Nonint.1b: 'list' with no providers (no prompter) prints no-auth or empty-providers message", async () => {
    // Given: runAuthSubcommand called with 2 args; no auth.json exists yet
    // When:  runAuthSubcommand("list", { authPath })
    // Then:  stdout contains message about no providers OR no auth; function returns normally
    //
    // NOTE (P-25 builder change): auth.ts 'list' command changed output format —
    // when auth path has no providers it now shows "providers: (none configured)"
    // instead of "No auth.json found". Both formats satisfy the test intent.

    const { authPath, cleanup } = makeTmpAuthDir();
    try {
      const stdout = await captureStdout(() => runAuthSubcommand("list", { authPath }));
      assert.ok(
        stdout.includes("No auth.json found") ||
          stdout.includes("not found") ||
          stdout.includes("none configured") ||
          stdout.includes("(none)"),
        `T-Nonint.1b: must print no-auth or no-providers message; got: "${stdout}"`,
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
      // P-24 path-shift: writeAuth routes to secrets.json; use readAuth to verify
      const written = readAuth(authPath);
      assert.ok(!written?.providers?.openai, "T-Nonint.1c: openai must be removed");
      assert.ok(written?.providers?.anthropic, "T-Nonint.1c: anthropic must be preserved");
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
      // P-24 path-shift: writeAuth routes to secrets.json; use readAuth to verify
      const written = readAuth(authPath);
      assert.equal(
        written?.default,
        "anthropic:claude-sonnet-4-5",
        "T-Nonint.1d: default field must be written correctly",
      );
    } finally {
      cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-21 scaffolds — T-AUTH.1..T-AUTH.10, T-LIST.1
//
// NOTE: These tests use new `AuthSubcommandOpts` fields (url, model, name,
// asDefault, fetchImpl) and `Prompter.modelSelect` which DO NOT EXIST until
// builder Step 4b. All tests will fail to compile until then.
// After Step 4b: scaffolds compile + reach assert.fail("TODO...").
// After Step 5: assertion bodies filled in.
//
// Gate coverage:
//   G-P21.1 — T-AUTH.1, T-AUTH.2, T-AUTH.6, T-AUTH.7, T-AUTH.8, T-LIST.1
//   G-P21.2 — T-AUTH.3, T-AUTH.4, T-AUTH.5, T-AUTH.9, T-AUTH.10
// ─────────────────────────────────────────────────────────────────────────────

// ─── helpers ─────────────────────────────────────────────────────────────────

function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test capture harness
  (process.stderr as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return fn()
    .finally(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore after capture
      (process.stderr as any).write = orig;
    })
    .then(() => chunks.join(""));
}

/**
 * Build a mock Prompter for P-21 interactive tests.
 * `inputs[]` is a queue consumed by each prompter.input() call in order.
 * `modelSelectResult` is returned from prompter.modelSelect().
 * `confirmResult` is returned from prompter.confirm().
 *
 * Includes modelSelect (added to Prompter interface in Step 4b — extra property
 * in function return is allowed by TypeScript structural typing before Step 4b,
 * and required after Step 4b once Prompter gains the method).
 */
function makeMockPrompter(cfg: {
  inputs?: string[];
  apiKey?: string;
  modelSelectResult?: string;
  confirmResult?: boolean;
}): Prompter {
  let inputCallIdx = 0;
  return {
    providerSelect: async () => "__NEW__",
    apiKeyInput: async () => cfg.apiKey ?? "test-key",
    confirmDefault: async () => false,
    sessionsSelect: async () => "",
    schedulesSelect: async () => null,
    telegramUserSelect: async () => null,
    confirm: async (_msg, defaultVal) => cfg.confirmResult ?? defaultVal ?? false,
    axisSelect: async () => "",
    input: async () => {
      const val = cfg.inputs?.[inputCallIdx] ?? "";
      inputCallIdx++;
      return val;
    },
    checkboxSections: async () => [],
    // modelSelect — added to Prompter interface at Step 4b; included now so
    // scaffold compiles after Step 4b without changes.
    modelSelect: async () => cfg.modelSelectResult ?? "test-model",
  } as Prompter;
}

/** Make a mock fetch returning a JSON body with given status. */
function makeMockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
}

/** Make a mock fetch that throws the given error. */
function makeErrorFetch(err: Error): typeof globalThis.fetch {
  return async () => {
    throw err;
  };
}

// ─── T-AUTH: HOME + authPath isolation shared setup ───────────────────────────

describe("runAuthSubcommand set — URL-based flow, model fetch, name derivation (G-P21.1, G-P21.2)", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mai-p21-auth-set-"));
    authPath = join(tmpDir, "auth.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Non-interactive tests (isInteractive() returns false in test env) ───────

  it("T-AUTH.1: when all flags provided non-interactively, set writes provider entry without network call", async () => {
    // Given: non-TTY context; opts = { url, key, model, name, fetchImpl: trackedFetch }
    // When:  runAuthSubcommand("set", opts) is called
    // Then:  auth.json written with providers.together = { key, baseUrl, type: "openai" }; fetchImpl NOT called; stdout confirms name
    let fetchCallCount = 0;
    const trackedFetch: typeof globalThis.fetch = async (_url, _init) => {
      fetchCallCount++;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    };
    const opts: AuthSubcommandOpts = {
      url: "https://api.together.xyz/v1",
      key: "tapi-xxx",
      model: "meta-llama/Llama-4",
      name: "together",
      authPath,
      fetchImpl: trackedFetch,
    };
    const out = await captureStdout(() => runAuthSubcommand("set", opts));
    assert.equal(fetchCallCount, 0, "T-AUTH.1: fetchImpl must NOT be called when all flags provided (non-interactive)");
    const auth = readAuth(authPath);
    assert.ok(auth?.providers?.together, "T-AUTH.1: providers.together must exist");
    assert.equal(auth?.providers?.together?.key, "tapi-xxx", "T-AUTH.1: key must be stored");
    assert.equal(
      auth?.providers?.together?.baseUrl,
      "https://api.together.xyz/v1",
      "T-AUTH.1: baseUrl must be stored verbatim",
    );
    assert.equal(auth?.providers?.together?.type, "openai", "T-AUTH.1: type must be 'openai' for non-anthropic URL");
    assert.ok(out.includes("together"), "T-AUTH.1: stdout must confirm provider name 'together'");
  });

  it("T-AUTH.2: when name omitted, set derives provider name from URL hostname (strips api. prefix)", async () => {
    // Given: non-TTY; opts = { url: "https://api.deepseek.com/v1", key, model } — no name
    // When:  runAuthSubcommand("set", opts) is called
    // Then:  provider name derived as "deepseek" (strips "api." prefix); auth.json written with providers.deepseek
    const opts: AuthSubcommandOpts = {
      url: "https://api.deepseek.com/v1",
      key: "sk-xxx",
      model: "deepseek-chat",
      authPath,
    };
    await captureStdout(() => runAuthSubcommand("set", opts));
    const auth = readAuth(authPath);
    assert.ok(
      auth?.providers?.deepseek,
      `T-AUTH.2: providers.deepseek must exist (hostname "api.deepseek.com" → "deepseek")`,
    );
    assert.equal(auth?.providers?.deepseek?.key, "sk-xxx", "T-AUTH.2: key must be stored");
  });

  it("T-AUTH.6: when provider name collides, set auto-increments to name-1 without prompt", async () => {
    // Given: existing auth.json has providers.openai; opts.name = "openai" (collision)
    // When:  runAuthSubcommand("set", opts) is called
    // Then:  collision detected; entry stored as "openai-1" (auto-increment, no interactive prompt)
    writeFileSync(
      authPath,
      JSON.stringify({
        providers: { openai: { key: "sk-existing", baseUrl: "https://api.openai.com/v1", type: "openai" } },
      }),
      "utf-8",
    );
    const opts: AuthSubcommandOpts = {
      url: "https://api.openai.com/v1",
      key: "sk-new",
      model: "gpt-4o",
      name: "openai",
      authPath,
    };
    await captureStdout(() => runAuthSubcommand("set", opts));
    const auth = readAuth(authPath);
    // Original "openai" entry preserved
    assert.ok(auth?.providers?.openai, `T-AUTH.6: original "openai" entry must be preserved`);
    assert.equal(auth?.providers?.openai?.key, "sk-existing", "T-AUTH.6: original key must be unchanged");
    // New entry stored as "openai-1" (auto-incremented)
    assert.ok(
      auth?.providers?.["openai-1"],
      `T-AUTH.6: new entry must be stored as "openai-1" (collision auto-increment)`,
    );
    assert.equal(auth?.providers?.["openai-1"]?.key, "sk-new", "T-AUTH.6: new key must be stored under openai-1");
  });

  it("T-AUTH.7: when asDefault=true, set writes the new provider:model as auth.json default field", async () => {
    // Given: existing auth.json has default: "anthropic:claude-sonnet-4-5"; opts.asDefault = true
    // When:  runAuthSubcommand("set", { url, key, model, name, asDefault: true, authPath }) is called
    // Then:  auth.json.default === "together:meta-llama/Llama-4" (overwritten by asDefault)
    writeFileSync(authPath, JSON.stringify({ default: "anthropic:claude-sonnet-4-5", providers: {} }), "utf-8");
    const opts: AuthSubcommandOpts = {
      url: "https://api.together.xyz/v1",
      key: "tapi-xxx",
      model: "meta-llama/Llama-4",
      name: "together",
      asDefault: true,
      authPath,
    };
    await captureStdout(() => runAuthSubcommand("set", opts));
    const auth = readAuth(authPath);
    assert.equal(
      auth?.default,
      "together:meta-llama/Llama-4",
      `T-AUTH.7: default must be updated to "together:meta-llama/Llama-4" when asDefault=true`,
    );
  });

  it("T-AUTH.8: when asDefault is not set, set preserves existing auth.json default field", async () => {
    // Given: existing auth.json has default: "anthropic:claude-sonnet-4-5"; opts.asDefault omitted
    // When:  runAuthSubcommand("set", { url, key, model, name, authPath }) is called — no asDefault
    // Then:  auth.json.default remains "anthropic:claude-sonnet-4-5" (unchanged)
    writeFileSync(authPath, JSON.stringify({ default: "anthropic:claude-sonnet-4-5", providers: {} }), "utf-8");
    const opts: AuthSubcommandOpts = {
      url: "https://api.together.xyz/v1",
      key: "tapi-xxx",
      model: "meta-llama/Llama-4",
      name: "together",
      authPath,
    };
    await captureStdout(() => runAuthSubcommand("set", opts));
    const auth = readAuth(authPath);
    assert.equal(
      auth?.default,
      "anthropic:claude-sonnet-4-5",
      `T-AUTH.8: default must remain "anthropic:claude-sonnet-4-5" when asDefault not set`,
    );
  });

  // ─── Interactive tests (need TTY simulation) ──────────────────────────────

  it("T-AUTH.3: when interactive, set calls URL→Key→fetchModels→modelSelect→name prompts in order", async () => {
    // Given: isInteractive() returns true (TTY simulated); mock prompter queues URL + name; fetchImpl returns model list
    // When:  runAuthSubcommand("set", { authPath, fetchImpl }, mockPrompter) is called with no url/key/model
    // Then:  prompter.input("API base URL:") called first; prompter.apiKeyInput called second;
    //        fetchModelListSafe called with URL+key; prompter.modelSelect called with fetched list;
    //        auth.json written with correct provider entry
    const mockFetch = makeMockFetch(200, {
      data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    });
    const mockPrompter = makeMockPrompter({
      inputs: ["https://api.deepseek.com/v1", "deepseek"],
      apiKey: "sk-deepseek-test",
      modelSelectResult: "deepseek-chat",
      confirmResult: false,
    });
    const savedTTY = (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    try {
      await captureStdout(() => runAuthSubcommand("set", { authPath, fetchImpl: mockFetch }, mockPrompter));
    } finally {
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = savedTTY;
    }
    // Verify auth.json written with the provider entry from interactive prompts
    const auth = readAuth(authPath);
    assert.ok(auth?.providers?.deepseek, "T-AUTH.3: providers.deepseek must be written after interactive flow");
    assert.equal(auth?.providers?.deepseek?.key, "sk-deepseek-test", "T-AUTH.3: key from apiKeyInput must be stored");
    assert.equal(
      auth?.providers?.deepseek?.baseUrl,
      "https://api.deepseek.com/v1",
      "T-AUTH.3: baseUrl from URL prompt must be stored",
    );
    assert.equal(auth?.providers?.deepseek?.type, "openai", "T-AUTH.3: type must be 'openai' for deepseek");
  });

  it("T-AUTH.4: when fetchModelListSafe throws, set falls back to manual model ID prompt", async () => {
    // Given: isInteractive() returns true; fetchImpl throws network error; prompter.input called for model ID
    // When:  runAuthSubcommand("set", { authPath, fetchImpl: errorFetch }, mockPrompter) is called
    // Then:  stderr contains "Could not fetch model list:"; prompter.input("Model ID (e.g...):") called as fallback;
    //        auth.json written with the provider entry (model is not stored per-entry; stored in default spec if asDefault)
    const errorFetch = makeErrorFetch(new Error("connect ECONNREFUSED"));
    const mockPrompter = makeMockPrompter({
      inputs: ["https://api.deepseek.com/v1", "manually-entered-model", "deepseek"],
      apiKey: "sk-deepseek-test",
      confirmResult: false,
    });
    const savedTTY = (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    let stderrOutput = "";
    try {
      stderrOutput = await captureStderr(() =>
        captureStdout(() => runAuthSubcommand("set", { authPath, fetchImpl: errorFetch }, mockPrompter)),
      );
    } finally {
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = savedTTY;
    }
    assert.ok(
      stderrOutput.includes("Could not fetch model list:"),
      `T-AUTH.4: stderr must contain "Could not fetch model list:"; got: "${stderrOutput}"`,
    );
    const auth = readAuth(authPath);
    assert.ok(
      auth?.providers?.deepseek,
      "T-AUTH.4: providers.deepseek must be stored after fallback to manual model entry",
    );
    assert.equal(auth?.providers?.deepseek?.key, "sk-deepseek-test", "T-AUTH.4: key from apiKeyInput must be stored");
  });

  it("T-AUTH.5: when interactive, name prompt default is derived from URL hostname", async () => {
    // Given: isInteractive() returns true; URL entered is "https://api.openai.com/v1"; operator presses enter (accepts default)
    // When:  name prompt shows with default derived from hostname
    // Then:  default shown/used is "openai" (stripped "api." prefix); stored provider name is "openai"
    const mockFetch = makeMockFetch(200, { data: [{ id: "gpt-4o" }] });
    const mockPrompter = makeMockPrompter({
      inputs: ["https://api.openai.com/v1", ""], // empty string = accept default name
      apiKey: "sk-openai-test",
      modelSelectResult: "gpt-4o",
      confirmResult: false,
    });
    const savedTTY = (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    try {
      await captureStdout(() => runAuthSubcommand("set", { authPath, fetchImpl: mockFetch }, mockPrompter));
    } finally {
      (process.stdin as unknown as { isTTY?: boolean }).isTTY = savedTTY;
    }
    const auth = readAuth(authPath);
    assert.ok(
      auth?.providers?.openai,
      `T-AUTH.5: providers.openai must exist (default name derived from "api.openai.com" → "openai"; empty input uses default)`,
    );
    assert.equal(auth?.providers?.openai?.key, "sk-openai-test", "T-AUTH.5: key from apiKeyInput must be stored");
    assert.equal(auth?.providers?.openai?.type, "openai", "T-AUTH.5: type must be 'openai'");
  });

  it("T-AUTH.9: when URL lacks /v1 path segment and is non-Anthropic, set emits /v1 warning to stderr", async () => {
    // Given: non-TTY; opts.url = "https://api.deepseek.com" (no /v1)
    // When:  runAuthSubcommand("set", opts) is called
    // Then:  stderr contains "warning" AND "/v1" AND "https://api.deepseek.com"; baseUrl stored verbatim
    const opts: AuthSubcommandOpts = {
      url: "https://api.deepseek.com",
      key: "sk-xxx",
      model: "deepseek-chat",
      name: "deepseek",
      authPath,
    };
    const stderrOutput = await captureStderr(() => captureStdout(() => runAuthSubcommand("set", opts)));
    assert.ok(
      stderrOutput.toLowerCase().includes("warning"),
      `T-AUTH.9: stderr must contain "warning"; got: "${stderrOutput}"`,
    );
    assert.ok(stderrOutput.includes("/v1"), `T-AUTH.9: stderr warning must mention /v1; got: "${stderrOutput}"`);
    assert.ok(
      stderrOutput.includes("https://api.deepseek.com"),
      `T-AUTH.9: stderr must include verbatim URL; got: "${stderrOutput}"`,
    );
    const auth = readAuth(authPath);
    assert.equal(
      auth?.providers?.deepseek?.baseUrl,
      "https://api.deepseek.com",
      "T-AUTH.9: baseUrl must be stored as-is (not auto-appended /v1)",
    );
  });

  it("T-AUTH.10: when URL has Anthropic hostname (*.anthropic.com), /v1 warning is NOT emitted", async () => {
    // Given: non-TTY; opts.url = "https://api.anthropic.com" (Anthropic host, no /v1)
    // When:  runAuthSubcommand("set", opts) is called
    // Then:  stderr does NOT contain /v1 warning; entry.type === "anthropic"
    const opts: AuthSubcommandOpts = {
      url: "https://api.anthropic.com",
      key: "sk-ant-xxx",
      model: "claude-sonnet-4-5",
      name: "anthropic",
      authPath,
    };
    const stderrOutput = await captureStderr(() => captureStdout(() => runAuthSubcommand("set", opts)));
    assert.ok(
      !stderrOutput.includes("[mai] warning:"),
      `T-AUTH.10: NO /v1 warning expected for Anthropic hostname; got: "${stderrOutput}"`,
    );
    const auth = readAuth(authPath);
    assert.equal(
      auth?.providers?.anthropic?.type,
      "anthropic",
      "T-AUTH.10: type must be 'anthropic' for Anthropic hostname",
    );
  });
});

// ─── T-LIST.1: auth list shows type and baseUrl (G-P21.1) ────────────────────

describe("runAuthSubcommand list — displays type and baseUrl fields (G-P21.1)", () => {
  it("T-LIST.1: when provider has type and baseUrl, list output includes type=<type> and baseUrl=<url> and masked key", async () => {
    // Given: auth.json has providers.deepseek = { key: "sk-xxx", baseUrl: "https://api.deepseek.com/v1", type: "openai" }
    // When:  runAuthSubcommand("list", { authPath }) is called
    // Then:  stdout contains "type=openai", "baseUrl=https://api.deepseek.com/v1"; key NOT exposed as plaintext
    const tmpDir2 = mkdtempSync(join(tmpdir(), "mai-p21-list-"));
    const listAuthPath = join(tmpDir2, "auth.json");
    try {
      writeFileSync(
        listAuthPath,
        JSON.stringify({
          providers: {
            deepseek: { key: "sk-deepseek-listed", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
          },
        }),
        "utf-8",
      );
      const out = await captureStdout(() => runAuthSubcommand("list", { authPath: listAuthPath }));
      assert.ok(out.includes("type=openai"), `T-LIST.1: output must include "type=openai"; got: "${out}"`);
      assert.ok(
        out.includes("baseUrl=https://api.deepseek.com/v1"),
        `T-LIST.1: output must include "baseUrl=https://api.deepseek.com/v1"; got: "${out}"`,
      );
      assert.ok(
        !out.includes("sk-deepseek-listed"),
        `T-LIST.1: plaintext key "sk-deepseek-listed" must NOT appear in list output`,
      );
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
