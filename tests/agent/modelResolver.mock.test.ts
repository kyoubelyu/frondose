import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import {
  DEFAULT_MODEL_SPEC,
  detectAnyModelKey,
  parseModelSpec,
  resolveModel,
  resolveModelSpec,
} from "../../src/agent/modelResolver.js";
import { makeAllTools } from "../../src/tools/index.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// T-M1..T-M4: FRONDOSE_MODEL precedence chain + parseModelSpec contract

/**
 * Helpers: save/restore process.env properties in try/finally for test isolation.
 * Implements NIT-4 discipline from docs/phase-1-critics.md.
 */
function saveEnv(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function setIsolatedHome(home: string): void {
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
}

// ─── T-M1: factory precedence ─────────────────────────────────────────────────

test("T-M1: factory takes precedence over cli/env/auth.json/default", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm1-"));
  const saved = saveEnv("HOME", "FRONDOSE_HOME_BASE", "FRONDOSE_MODEL");
  try {
    setIsolatedHome(tmpHome);
    process.env.FRONDOSE_MODEL = "openai:gpt-4o";
    const spec = resolveModelSpec({ factory: "anthropic:claude-sonnet-4-5", cli: "openai:deepseek-chat" });
    assert.equal(spec, "anthropic:claude-sonnet-4-5", "factory must beat cli/env/auth.json/default");
  } finally {
    restoreEnv(saved);
    cleanupTmpDir(tmpHome);
  }
});

// ─── T-M2: cli precedence ─────────────────────────────────────────────────────

test("T-M2: cli takes precedence over env/auth.json/default when factory absent", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm2-"));
  const saved = saveEnv("HOME", "FRONDOSE_HOME_BASE", "FRONDOSE_MODEL");
  try {
    setIsolatedHome(tmpHome);
    process.env.FRONDOSE_MODEL = "openai:gpt-4o";
    const spec = resolveModelSpec({ cli: "openai:deepseek-chat" });
    assert.equal(spec, "openai:deepseek-chat", "cli must beat env/auth.json/default");
  } finally {
    restoreEnv(saved);
    cleanupTmpDir(tmpHome);
  }
});

// ─── T-M3: exhaustive 5-case precedence chain (CONCERN-MR-1) ─────────────────

test("T-M3: resolveModelSpec precedence chain — all 5 levels (CONCERN-MR-1)", async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm3-"));
  const saved = saveEnv("HOME", "FRONDOSE_HOME_BASE", "FRONDOSE_MODEL");

  try {
    // (a) factory wins over cli + env + auth.json + default
    await t.test("(a) factory wins", () => {
      setIsolatedHome(tmpHome);
      process.env.FRONDOSE_MODEL = "openai:env-model";
      const result = resolveModelSpec({ factory: "anthropic:factory-model", cli: "openai:cli-model" });
      assert.equal(result, "anthropic:factory-model");
    });

    // (b) cli wins over env + auth.json + default (no factory)
    await t.test("(b) cli wins when factory absent", () => {
      setIsolatedHome(tmpHome);
      process.env.FRONDOSE_MODEL = "openai:env-model";
      const result = resolveModelSpec({ cli: "openai:cli-model" });
      assert.equal(result, "openai:cli-model");
    });

    // (c) env wins over auth.json + default (no factory, no cli)
    await t.test("(c) env wins when factory and cli absent", () => {
      setIsolatedHome(tmpHome); // no auth.json in tmpHome
      process.env.FRONDOSE_MODEL = "openai:env-model";
      const result = resolveModelSpec({});
      assert.equal(result, "openai:env-model");
    });

    // (d) auth.json default wins when factory/cli/env absent
    await t.test("(d) auth.json default wins when factory/cli/env absent", () => {
      setIsolatedHome(tmpHome);
      delete process.env.FRONDOSE_MODEL;
      const maiDir = join(tmpHome, ".frondose");
      mkdirSync(maiDir, { recursive: true });
      writeFileSync(join(maiDir, "auth.json"), '{"default":"openai:auth-model"}', "utf-8");
      const result = resolveModelSpec({});
      assert.equal(result, "openai:auth-model");
      // Remove auth.json so next sub-test (e) gets the hardcoded fallback.
      // P-24 path-shift: readSecrets migrated auth.json → secrets.json on first read above;
      // remove secrets.json too so sub-test (e) falls back to hardcoded DEFAULT_MODEL_SPEC.
      rmSync(join(maiDir, "auth.json"));
      const migratedSecretsPath = join(tmpHome, ".frondose", "agent", "secrets.json");
      if (existsSync(migratedSecretsPath)) rmSync(migratedSecretsPath);
    });

    // (e) hardcoded fallback when all sources absent
    // P-71: default changed from anthropic:claude-sonnet-4-5 to deepseek:deepseek-v4-flash
    await t.test("(e) hardcoded fallback deepseek:deepseek-v4-flash when all unset", () => {
      setIsolatedHome(tmpHome); // no auth.json (removed in (d))
      delete process.env.FRONDOSE_MODEL;
      const result = resolveModelSpec({});
      assert.equal(result, DEFAULT_MODEL_SPEC);
      assert.equal(DEFAULT_MODEL_SPEC, "deepseek:deepseek-v4-flash");
    });
  } finally {
    restoreEnv(saved);
    cleanupTmpDir(tmpHome);
  }
});

// ─── T-M4: parseModelSpec error cases + unknown-provider throw ────────────────

test("T-M4: parseModelSpec rejects malformed specs; resolveModel throws on unknown provider", async (t) => {
  await t.test("no colon throws", () => {
    assert.throws(
      () => parseModelSpec("invalid"),
      (err: Error) => err.message.includes("Invalid model spec"),
    );
  });

  await t.test("empty provider throws", () => {
    assert.throws(
      () => parseModelSpec(":foo"),
      (err: Error) => err.message.includes("empty provider"),
    );
  });

  await t.test("empty modelId throws", () => {
    assert.throws(
      () => parseModelSpec("foo:"),
      (err: Error) => err.message.includes("empty provider or modelId"),
    );
  });

  await t.test("valid anthropic spec parses correctly", () => {
    const { provider, modelId } = parseModelSpec("anthropic:claude-sonnet-4-5");
    assert.equal(provider, "anthropic");
    assert.equal(modelId, "claude-sonnet-4-5");
  });

  await t.test("valid openai spec parses correctly", () => {
    const { provider, modelId } = parseModelSpec("openai:deepseek-chat");
    assert.equal(provider, "openai");
    assert.equal(modelId, "deepseek-chat");
  });

  await t.test("unknown provider throws on resolveModel (before SDK call)", () => {
    const saved = saveEnv("HOME", "FRONDOSE_HOME_BASE");
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm4-"));
    try {
      setIsolatedHome(tmpHome);
      // P-21: error message changed from "Unknown provider" to "not configured in auth.json"
      // P-36 F-A: message changed again to "is not configured (model spec came from …)"
      assert.throws(
        () => resolveModel({ factory: "groq:llama-3" }),
        (err: Error) => err.message.includes("not configured") || err.message.includes("Unknown provider"),
      );
    } finally {
      restoreEnv(saved);
      cleanupTmpDir(tmpHome);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-21 scaffolds — T-BUILD.1..T-BUILD.8, T-DETECT.1..T-DETECT.2, T-CONTRACT
//
// NOTE: Several of these tests import `detectAnyModelKey` which already exists
// but whose behavior will change in Step 4b (from 3-hardcoded-name check to
// all-providers iteration).  T-BUILD.1..T-BUILD.8 test the new type-based
// `buildModel()` dispatch; the production code does NOT use type-based dispatch
// until builder Step 4b, so several tests will fail before Step 4b due to
// "Unknown provider" throws or wrong dispatch path.
//
// Gate coverage:
//   G-P21.3 — T-BUILD.1, T-BUILD.2, T-BUILD.3
//   G-P21.5 — T-BUILD.4, T-BUILD.5, T-BUILD.6, T-BUILD.7, T-BUILD.8
//   G-P21.6 — T-DETECT.1, T-DETECT.2
//   G-P21.8 — T-CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

// ─── T-BUILD: HOME isolation shared setup ─────────────────────────────────────

describe("buildModel — type-based dispatch via resolveModel (G-P21.3, G-P21.5)", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedHomeBase: string | undefined;
  let savedAnthropicKey: string | undefined;
  let savedOpenaiKey: string | undefined;
  let savedDeepseekKey: string | undefined;
  let savedDeepseekBase: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mai-home-p21-build-"));
    savedHome = process.env.HOME;
    savedHomeBase = process.env.FRONDOSE_HOME_BASE;
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenaiKey = process.env.OPENAI_API_KEY;
    savedDeepseekKey = process.env.DEEPSEEK_API_KEY;
    savedDeepseekBase = process.env.DEEPSEEK_BASE_URL;
    setIsolatedHome(tmpHome);
    mkdirSync(join(tmpHome, ".frondose"), { recursive: true });
    // Clear env-var key overrides so tests control key resolution explicitly
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = savedHomeBase;
    if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    if (savedOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenaiKey;
    if (savedDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedDeepseekKey;
    if (savedDeepseekBase === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = savedDeepseekBase;
    cleanupTmpDir(tmpHome);
  });

  it("T-BUILD.1: P-71 — direct Anthropic provider is scope-disabled; resolveModel throws scope-disabled error", () => {
    // Given: auth.json has providers.anthropic = { key: "sk-ant-xxx", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" }
    // When:  resolveModel({ factory: "anthropic:claude-sonnet-4-5" }) is called
    // Then:  throws with "scope-disabled" in message (P-71 blocks direct Anthropic runtime)
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          anthropic: { key: "sk-ant-xxx", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
        },
      }),
      "utf-8",
    );
    assert.throws(
      () => resolveModel({ factory: "anthropic:claude-sonnet-4-5" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("direct"),
      "T-BUILD.1: must throw scope-disabled error for reserved direct Anthropic provider",
    );
  });

  it("T-BUILD.2: when auth.json has type=openai for non-standard provider, resolveModel → openai dispatch path", () => {
    // Given: auth.json has providers.together = { key: "tapi-xxx", baseUrl: "https://api.together.xyz/v1", type: "openai" }
    // When:  resolveModel({ factory: "together:meta-llama/Llama-4" }) is called
    // Then:  returned model.provider does NOT contain "anthropic"; createOpenAI path taken with name="together"
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          together: { key: "tapi-xxx", baseUrl: "https://api.together.xyz/v1", type: "openai" },
        },
      }),
      "utf-8",
    );
    const model = resolveModel({ factory: "together:meta-llama/Llama-4" });
    // createOpenAI with name="together" yields model.provider === "together.chat"
    assert.ok(
      !model.provider.startsWith("anthropic"),
      `T-BUILD.2: model.provider must NOT start with "anthropic"; got "${model.provider}"`,
    );
    assert.ok(
      model.provider.includes("together"),
      `T-BUILD.2: model.provider must contain "together" (name-based provider); got "${model.provider}"`,
    );
  });

  it("T-BUILD.3: when provider is absent from auth.json, resolveModel throws with 'not configured' message", () => {
    // Given: auth.json has no provider "unknown-prov"
    // When:  resolveModel({ factory: "unknown-prov:some-model" }) is called
    // Then:  throws Error whose message contains "Provider 'unknown-prov' not configured" and Frondose Settings guidance
    // P-APP-11 b1: error guidance changed from "mai auth set" to "Frondose → Settings"
    writeFileSync(join(tmpHome, ".frondose", "auth.json"), JSON.stringify({ providers: {} }), "utf-8");
    assert.throws(
      () => resolveModel({ factory: "unknown-prov:some-model" }),
      (err: Error) => {
        const msg = err.message;
        return msg.includes("unknown-prov") && msg.includes("not configured") && msg.includes("Frondose");
      },
      "T-BUILD.3: must throw with provider name + 'not configured' + Frondose Settings guidance",
    );
  });

  it("T-BUILD.4: P-71 — ANTHROPIC_API_KEY env var is ignored; direct Anthropic provider throws scope-disabled", async () => {
    // Given: ANTHROPIC_API_KEY set; auth.json has providers.anthropic = { key: "sk-ant-file", type: "anthropic" }
    // When:  resolveModel({ factory: "anthropic:claude-sonnet-4-5" }) is called
    // Then:  throws scope-disabled (P-71 blocks direct Anthropic — env key is irrelevant)
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-test";
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          anthropic: { key: "sk-ant-file", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
        },
      }),
      "utf-8",
    );
    assert.throws(
      () => resolveModel({ factory: "anthropic:claude-sonnet-4-5" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("direct"),
      "T-BUILD.4: must throw scope-disabled; ANTHROPIC_API_KEY env does not bypass P-71 guard",
    );
  });

  it("T-BUILD.5: P-71 — OPENAI_API_KEY env var is ignored; reserved 'openai' provider name throws scope-disabled", async () => {
    // Given: OPENAI_API_KEY set; auth.json has providers.openai = { key: "sk-file", type: "openai" }
    // When:  resolveModel({ factory: "openai:gpt-4o" }) is called
    // Then:  throws scope-disabled (P-71 — 'openai' is a reserved direct-provider name)
    process.env.OPENAI_API_KEY = "sk-env-test";
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          openai: { key: "sk-file", baseUrl: "https://api.openai.com/v1", type: "openai" },
        },
      }),
      "utf-8",
    );
    assert.throws(
      () => resolveModel({ factory: "openai:gpt-4o" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("reserved"),
      "T-BUILD.5: must throw scope-disabled; 'openai' is a reserved name blocked by P-71",
    );
  });

  it("T-BUILD.6: when DEEPSEEK_BASE_URL is set without /v1, createOpenAI is called with /v1 appended", async () => {
    // Given: process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com" (no /v1); auth.json has providers.deepseek with type=openai
    // When:  resolveModel({ factory: "deepseek:deepseek-chat" }) is called
    // Then:  the actual HTTP request targets "https://api.deepseek.com/v1/chat/completions" (env normalized, /v1 added)
    process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          deepseek: { key: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
        },
      }),
      "utf-8",
    );
    const model = resolveModel({ factory: "deepseek:deepseek-chat" });
    // Intercept fetch to capture the URL after normalization
    let capturedUrl: string | undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, _init) => {
      capturedUrl = url.toString();
      throw new Error("TEST_ABORT");
    };
    try {
      await model.doGenerate({
        inputFormat: "messages",
        mode: { type: "regular" },
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
      });
    } catch (e) {
      if ((e as Error).message !== "TEST_ABORT") throw e;
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.ok(
      capturedUrl?.startsWith("https://api.deepseek.com/v1/"),
      `T-BUILD.6: request URL must include /v1 after normalization; got "${capturedUrl}"`,
    );
    assert.ok(!capturedUrl?.includes("/v1/v1"), `T-BUILD.6: URL must NOT have double /v1; got "${capturedUrl}"`);
  });

  it("T-BUILD.7: when DEEPSEEK_BASE_URL already has /v1, createOpenAI is NOT double-suffixed", async () => {
    // Given: process.env.DEEPSEEK_BASE_URL = "https://proxy.example.com/v1" (already has /v1)
    // When:  resolveModel({ factory: "deepseek:deepseek-chat" }) is called
    // Then:  request URL is "https://proxy.example.com/v1/chat/completions" (idempotent — no /v1/v1)
    process.env.DEEPSEEK_BASE_URL = "https://proxy.example.com/v1";
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          deepseek: { key: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
        },
      }),
      "utf-8",
    );
    const model = resolveModel({ factory: "deepseek:deepseek-chat" });
    let capturedUrl: string | undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, _init) => {
      capturedUrl = url.toString();
      throw new Error("TEST_ABORT");
    };
    try {
      await model.doGenerate({
        inputFormat: "messages",
        mode: { type: "regular" },
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
      });
    } catch (e) {
      if ((e as Error).message !== "TEST_ABORT") throw e;
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.ok(
      capturedUrl?.startsWith("https://proxy.example.com/v1/"),
      `T-BUILD.7: request URL must start with correct base; got "${capturedUrl}"`,
    );
    assert.ok(
      !capturedUrl?.includes("/v1/v1"),
      `T-BUILD.7: URL must NOT contain /v1/v1 double-suffix; got "${capturedUrl}"`,
    );
  });

  it("T-BUILD.8: when DEEPSEEK_BASE_URL is set but provider is NOT 'deepseek', env var is ignored", async () => {
    // Given: process.env.DEEPSEEK_BASE_URL = "https://proxy.example.com"; auth.json has providers.together with type=openai
    // When:  resolveModel({ factory: "together:foo" }) is called
    // Then:  request URL starts with "https://api.together.xyz/v1/" (DEEPSEEK_BASE_URL env var ignored for non-deepseek providers)
    process.env.DEEPSEEK_BASE_URL = "https://proxy.example.com";
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: {
          together: { key: "tapi-xxx", baseUrl: "https://api.together.xyz/v1", type: "openai" },
        },
      }),
      "utf-8",
    );
    const model = resolveModel({ factory: "together:foo" });
    let capturedUrl: string | undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, _init) => {
      capturedUrl = url.toString();
      throw new Error("TEST_ABORT");
    };
    try {
      await model.doGenerate({
        inputFormat: "messages",
        mode: { type: "regular" },
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
      });
    } catch (e) {
      if ((e as Error).message !== "TEST_ABORT") throw e;
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.ok(
      capturedUrl?.startsWith("https://api.together.xyz/v1/"),
      `T-BUILD.8: request URL must use together's baseUrl from auth.json; got "${capturedUrl}"`,
    );
    assert.ok(
      !capturedUrl?.includes("proxy.example.com"),
      `T-BUILD.8: URL must NOT use DEEPSEEK_BASE_URL for non-deepseek provider; got "${capturedUrl}"`,
    );
  });
});

// ─── T-DETECT: detectAnyModelKey iterates all providers (G-P21.6) ─────────────

describe("detectAnyModelKey — iterates all configured providers, not just 3 hardcoded (G-P21.6)", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedHomeBase: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mai-home-p21-detect-"));
    savedHome = process.env.HOME;
    savedHomeBase = process.env.FRONDOSE_HOME_BASE;
    setIsolatedHome(tmpHome);
    mkdirSync(join(tmpHome, ".frondose"), { recursive: true });
    // Ensure no env-var keys interfere
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = savedHomeBase;
    cleanupTmpDir(tmpHome);
  });

  it("T-DETECT.1: when auth.json has only a non-standard provider key, detectAnyModelKey returns true", () => {
    // Given: auth.json has providers.together = { key: "tapi-xxx", type: "openai" }; no env vars set
    // When:  detectAnyModelKey() is called
    // Then:  returns true (iterates ALL providers — finds "together" key; NOT just 3 hardcoded names)
    writeFileSync(
      join(tmpHome, ".frondose", "auth.json"),
      JSON.stringify({
        providers: { together: { key: "tapi-xxx", type: "openai", baseUrl: "https://api.together.xyz/v1" } },
      }),
      "utf-8",
    );
    const result = detectAnyModelKey();
    assert.equal(
      result,
      true,
      "T-DETECT.1: detectAnyModelKey must return true when a non-standard provider key exists in auth.json",
    );
  });

  it("T-DETECT.2: when no providers configured and no env vars, detectAnyModelKey returns false", () => {
    // Given: auth.json has empty providers {}; ANTHROPIC/OPENAI/DEEPSEEK_API_KEY all unset
    // When:  detectAnyModelKey() is called
    // Then:  returns false
    writeFileSync(join(tmpHome, ".frondose", "auth.json"), JSON.stringify({ providers: {} }), "utf-8");
    const result = detectAnyModelKey();
    assert.equal(
      result,
      false,
      "T-DETECT.2: detectAnyModelKey must return false when no providers configured and no env vars set",
    );
  });
});

// ─── T-CONTRACT: tool count unchanged (G-P21.8) ──────────────────────────────

describe("contract checks — tool count + no-bash boundary (G-P21.8)", () => {
  it("T-CONTRACT: exposed makeAllTools inventory matches P-Y3 worker/server tier counts", () => {
    // Given: isolated HOME/config/secrets paths and inert session/control deps.
    // When:  makeAllTools builds the exposed ToolSet for worker/server consumer+power tiers.
    // Then:  counts match the P-Y3 contract and only operator-output tools are power-only.
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-tools-contract-"));
    const saved = saveEnv("HOME", "FRONDOSE_HOME_BASE", "FRONDOSE_TIER");
    try {
      setIsolatedHome(tmpHome);
      delete process.env.FRONDOSE_TIER;
      const persistence = {
        memoryDbPath: join(tmpHome, "memory.sqlite"),
        identityPath: join(tmpHome, "identity.json"),
        configPath: join(tmpHome, "config.json"),
        secretsPath: join(tmpHome, "secrets.json"),
        schedulePath: join(tmpHome, "schedule.jsonl"),
        salesDbPath: join(tmpHome, "sales.sqlite"),
        personasDir: join(tmpHome, "personas"),
      };
      const session = {
        inputMode: "cdp" as const,
        getOrInitClient: async () => ({}),
        getClient: () => undefined,
        heartbeat: async () => true,
        setLastContext: () => undefined,
        getLastContext: () => undefined,
      } as Parameters<typeof makeAllTools>[0];
      const control = {
        requestStop: () => undefined,
        isStopRequested: () => false,
        resetStop: () => undefined,
        setInteractive: () => undefined,
      } as Parameters<typeof makeAllTools>[2];
      const names = (mode: "worker" | "server", tier: "consumer" | "power") =>
        Object.keys(
          makeAllTools(mode === "worker" ? session : undefined, persistence, control, undefined, {
            mode,
            tier,
            workerId: "p66-contract",
          }),
        ).sort();

      const workerConsumer = names("worker", "consumer");
      const workerPower = names("worker", "power");
      const serverConsumer = names("server", "consumer");
      const serverPower = names("server", "power");

      assert.equal(workerConsumer.length, 50, `worker consumer inventory drifted: ${workerConsumer.join(", ")}`);
      assert.equal(workerPower.length, 52, `worker power inventory drifted: ${workerPower.join(", ")}`);
      assert.equal(serverConsumer.length, 23, `server consumer inventory drifted: ${serverConsumer.join(", ")}`);
      assert.equal(serverPower.length, 25, `server power inventory drifted: ${serverPower.join(", ")}`);

      for (const [label, consumer, power] of [
        ["worker", workerConsumer, workerPower],
        ["server", serverConsumer, serverPower],
      ] as const) {
        const consumerSet = new Set(consumer);
        const powerOnly = power.filter((name) => !consumerSet.has(name)).sort();
        assert.deepEqual(powerOnly, ["gh_issue", "telegram_notify"], `${label} tier delta drifted`);
        assert.ok(consumer.includes("present_summary"), `${label} consumer inventory must expose present_summary`);
      }
    } finally {
      restoreEnv(saved);
      cleanupTmpDir(tmpHome);
    }
  });
});
