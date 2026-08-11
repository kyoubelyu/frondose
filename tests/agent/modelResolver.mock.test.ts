import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function seedSecrets(home: string, value: Record<string, unknown>): void {
  const agentDir = join(home, ".frondose", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "secrets.json"), JSON.stringify({ schema_version: 1, ...value }), "utf-8");
}

// ─── T-M1: factory precedence ─────────────────────────────────────────────────

test("T-M1: factory takes precedence over cli/env/current-secrets/default", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm1-"));
  const saved = saveEnv("HOME", "FRONDOSE_HOME_BASE", "FRONDOSE_MODEL");
  try {
    setIsolatedHome(tmpHome);
    process.env.FRONDOSE_MODEL = "openai:gpt-4o";
    const spec = resolveModelSpec({ factory: "anthropic:claude-sonnet-4-5", cli: "openai:deepseek-chat" });
    assert.equal(spec, "anthropic:claude-sonnet-4-5", "factory must beat cli/env/current-secrets/default");
  } finally {
    restoreEnv(saved);
    cleanupTmpDir(tmpHome);
  }
});

// ─── T-M2: cli precedence ─────────────────────────────────────────────────────

test("T-M2: cli takes precedence over env/current-secrets/default when factory absent", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-tm2-"));
  const saved = saveEnv("HOME", "FRONDOSE_HOME_BASE", "FRONDOSE_MODEL");
  try {
    setIsolatedHome(tmpHome);
    process.env.FRONDOSE_MODEL = "openai:gpt-4o";
    const spec = resolveModelSpec({ cli: "openai:deepseek-chat" });
    assert.equal(spec, "openai:deepseek-chat", "cli must beat env/current-secrets/default");
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
    // (a) factory wins over cli + env + current secrets + default
    await t.test("(a) factory wins", () => {
      setIsolatedHome(tmpHome);
      process.env.FRONDOSE_MODEL = "openai:env-model";
      const result = resolveModelSpec({ factory: "anthropic:factory-model", cli: "openai:cli-model" });
      assert.equal(result, "anthropic:factory-model");
    });

    // (b) cli wins over env + current secrets + default (no factory)
    await t.test("(b) cli wins when factory absent", () => {
      setIsolatedHome(tmpHome);
      process.env.FRONDOSE_MODEL = "openai:env-model";
      const result = resolveModelSpec({ cli: "openai:cli-model" });
      assert.equal(result, "openai:cli-model");
    });

    // (c) env wins over the current secrets default (no factory, no cli)
    await t.test("(c) env wins when factory and cli absent", () => {
      setIsolatedHome(tmpHome); // no secrets.json in tmpHome
      process.env.FRONDOSE_MODEL = "openai:env-model";
      const result = resolveModelSpec({});
      assert.equal(result, "openai:env-model");
    });

    // (d) secrets.json default wins when factory/cli/env absent
    await t.test("(d) secrets.json default wins when factory/cli/env absent", () => {
      setIsolatedHome(tmpHome);
      delete process.env.FRONDOSE_MODEL;
      const secretsPath = join(tmpHome, ".frondose", "agent", "secrets.json");
      seedSecrets(tmpHome, { default: "openai:auth-model" });
      const result = resolveModelSpec({});
      assert.equal(result, "openai:auth-model");
      // Remove current secrets so next sub-test (e) gets the hardcoded fallback.
      rmSync(secretsPath);
    });

    // (e) hardcoded fallback when all sources absent
    // P-71: default changed from anthropic:claude-sonnet-4-5 to deepseek:deepseek-v4-flash
    await t.test("(e) hardcoded fallback deepseek:deepseek-v4-flash when all unset", () => {
      setIsolatedHome(tmpHome); // no secrets.json (removed in (d))
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
      // P-21: error message changed from "Unknown provider" to "not configured".
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
    // Given current secrets contain a reserved Anthropic provider.
    // When:  resolveModel({ factory: "anthropic:claude-sonnet-4-5" }) is called
    // Then:  throws with "scope-disabled" in message (P-71 blocks direct Anthropic runtime)
    seedSecrets(tmpHome, {
      providers: {
        anthropic: { key: "sk-ant-xxx", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
      },
    });
    assert.throws(
      () => resolveModel({ factory: "anthropic:claude-sonnet-4-5" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("direct"),
      "T-BUILD.1: must throw scope-disabled error for reserved direct Anthropic provider",
    );
  });

  it("T-BUILD.2: when current secrets use type=openai for a non-standard provider, resolveModel uses openai dispatch", () => {
    // Given current secrets contain a custom OpenAI-compatible provider.
    // When:  resolveModel({ factory: "together:meta-llama/Llama-4" }) is called
    // Then:  returned model.provider does NOT contain "anthropic"; createOpenAI path taken with name="together"
    seedSecrets(tmpHome, {
      providers: {
        together: { key: "tapi-xxx", baseUrl: "https://api.together.xyz/v1", type: "openai" },
      },
    });
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

  it("T-BUILD.3: when provider is absent from current secrets, resolveModel throws with 'not configured' message", () => {
    // Given current secrets have no provider "unknown-prov".
    // When:  resolveModel({ factory: "unknown-prov:some-model" }) is called
    // Then:  throws Error whose message contains "Provider 'unknown-prov' not configured" and Frondose Settings guidance
    // P-APP-11 b1: error guidance changed from "mai auth set" to "Frondose → Settings"
    seedSecrets(tmpHome, { providers: {} });
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
    // Given ANTHROPIC_API_KEY and a reserved provider in current secrets.
    // When:  resolveModel({ factory: "anthropic:claude-sonnet-4-5" }) is called
    // Then:  throws scope-disabled (P-71 blocks direct Anthropic — env key is irrelevant)
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-test";
    seedSecrets(tmpHome, {
      providers: {
        anthropic: { key: "sk-ant-file", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
      },
    });
    assert.throws(
      () => resolveModel({ factory: "anthropic:claude-sonnet-4-5" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("direct"),
      "T-BUILD.4: must throw scope-disabled; ANTHROPIC_API_KEY env does not bypass P-71 guard",
    );
  });

  it("T-BUILD.5: P-71 — OPENAI_API_KEY env var is ignored; reserved 'openai' provider name throws scope-disabled", async () => {
    // Given OPENAI_API_KEY and a reserved provider in current secrets.
    // When:  resolveModel({ factory: "openai:gpt-4o" }) is called
    // Then:  throws scope-disabled (P-71 — 'openai' is a reserved direct-provider name)
    process.env.OPENAI_API_KEY = "sk-env-test";
    seedSecrets(tmpHome, {
      providers: {
        openai: { key: "sk-file", baseUrl: "https://api.openai.com/v1", type: "openai" },
      },
    });
    assert.throws(
      () => resolveModel({ factory: "openai:gpt-4o" }),
      (err: Error) =>
        err.message.includes("scope-disabled") || err.message.includes("P-71") || err.message.includes("reserved"),
      "T-BUILD.5: must throw scope-disabled; 'openai' is a reserved name blocked by P-71",
    );
  });

  it("T-BUILD.6: when DEEPSEEK_BASE_URL is set without /v1, createOpenAI is called with /v1 appended", async () => {
    // Given DEEPSEEK_BASE_URL without /v1 and a current DeepSeek provider.
    // When:  resolveModel({ factory: "deepseek:deepseek-chat" }) is called
    // Then:  the actual HTTP request targets "https://api.deepseek.com/v1/chat/completions" (env normalized, /v1 added)
    process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
    seedSecrets(tmpHome, {
      providers: {
        deepseek: { key: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
      },
    });
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
    seedSecrets(tmpHome, {
      providers: {
        deepseek: { key: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
      },
    });
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
    // Given DEEPSEEK_BASE_URL and a different current custom provider.
    // When:  resolveModel({ factory: "together:foo" }) is called
    // Then:  request URL starts with "https://api.together.xyz/v1/" (DEEPSEEK_BASE_URL env var ignored for non-deepseek providers)
    process.env.DEEPSEEK_BASE_URL = "https://proxy.example.com";
    seedSecrets(tmpHome, {
      providers: {
        together: { key: "tapi-xxx", baseUrl: "https://api.together.xyz/v1", type: "openai" },
      },
    });
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
      `T-BUILD.8: request URL must use together's baseUrl from current secrets; got "${capturedUrl}"`,
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

  it("T-DETECT.1: when current secrets have only a non-standard provider key, detectAnyModelKey returns true", () => {
    // Given current secrets have a Together provider and no env keys.
    // When:  detectAnyModelKey() is called
    // Then:  returns true (iterates ALL providers — finds "together" key; NOT just 3 hardcoded names)
    seedSecrets(tmpHome, {
      providers: { together: { key: "tapi-xxx", type: "openai", baseUrl: "https://api.together.xyz/v1" } },
    });
    const result = detectAnyModelKey();
    assert.equal(
      result,
      true,
      "T-DETECT.1: detectAnyModelKey must return true when a non-standard provider key exists in current secrets",
    );
  });

  it("T-DETECT.2: when no providers configured and no env vars, detectAnyModelKey returns false", () => {
    // Given current secrets have no providers and all direct vendor env keys are unset.
    // When:  detectAnyModelKey() is called
    // Then:  returns false
    seedSecrets(tmpHome, { providers: {} });
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
  it("T-CONTRACT: exposed makeAllTools inventory matches the single-mode App contract", () => {
    // Given: isolated HOME/config/secrets paths and inert session/control deps.
    // When:  makeAllTools builds the exposed ToolSet for the App power/consumer tiers.
    // Then:  power = 51, consumer = 49, and only operator-output tools are power-only
    //        (P-OPEN-SOURCE-SPLIT §10.2: retired fleet mode; delta = telegram_notify + gh_issue).
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
      const names = (tier: "consumer" | "power") =>
        Object.keys(makeAllTools(session, persistence, control, undefined, { tier })).sort();

      const consumer = names("consumer");
      const power = names("power");

      assert.equal(power.length, 51, `power inventory drifted: ${power.join(", ")}`);
      assert.equal(consumer.length, 49, `consumer inventory drifted: ${consumer.join(", ")}`);

      const consumerSet = new Set(consumer);
      const powerOnly = power.filter((name) => !consumerSet.has(name)).sort();
      assert.deepEqual(powerOnly, ["gh_issue", "telegram_notify"], "tier delta drifted");
      // Retired fleet tools are absent (T-RETIRE.Report.1 + T-RETIRE.Fleet.2)
      for (const retired of ["report_issue", "publish_event", "query_lead_globally", "clear_cookies"]) {
        assert.ok(!power.includes(retired), `${retired} must not be in the power inventory`);
      }
    } finally {
      restoreEnv(saved);
      cleanupTmpDir(tmpHome);
    }
  });
});
