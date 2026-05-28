/**
 * P-36 Step 5 — T-FA.1..T-FA.4, T-FB.1..T-FB.2 (assertion bodies filled)
 *
 * Tests for F-A (actionable buildModel error) and F-B (resolveModelOrNull).
 *
 * Gate coverage:
 *   G-P36.1 — T-FA.1, T-FA.2 (provider list in error)
 *   G-P36.2 — T-FA.1         (pre-P-21 hint + --model-id in error)
 *   G-P36.3 — T-FA.3, T-FA.4 (spec-source naming)
 *   G-P36.5 — T-FB.1, T-FB.2 (resolveModelOrNull never throws; returns null on fail)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type ResolveModelOpts,
  readAuthJsonDefault,
  resolveModel,
  resolveModelOrNull,
} from "../../src/agent/modelResolver.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Save / restore env keys around a test. */
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

/**
 * Create a tmp HOME dir, write secrets.json at $HOME/.mai/agent/secrets.json
 * with the given providers, and set process.env.HOME.
 * Returns tmpHome path + cleanup fn.
 */
function setupTmpHome(
  providers: Record<string, { key: string; type: string; baseUrl: string }>,
  extra?: Record<string, unknown>,
): { tmpHome: string; cleanup: () => void } {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-p36-fa-"));
  const secretsDir = join(tmpHome, ".mai", "agent");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "secrets.json"), JSON.stringify({ schema_version: 1, providers, ...extra }), "utf-8");
  return {
    tmpHome,
    cleanup: () => rmSync(tmpHome, { recursive: true, force: true }),
  };
}

/** Standard env vars to save/restore around model-resolution tests. */
const MODEL_ENV_KEYS = ["HOME", "MAI_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] as const;

/** Clear keys that could short-circuit provider-resolution and confuse tests. */
function clearModelEnv(): void {
  delete process.env.MAI_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
}

// ─── T-FA.1 ───────────────────────────────────────────────────────────────────

describe("buildModel error — provider list + pre-P-21 hint + --model-id (G-P36.1/.2)", () => {
  it(
    "T-FA.1: when providers={anthropic,deepseek} and spec='openai:deepseek-v4-flash', " +
      "buildModel throws listing 'anthropic, deepseek', the pre-P-21 hint, and '--model-id'",
    () => {
      // Given: auth state with providers {anthropic, deepseek}; spec from factory param
      // When:  resolveModel({factory: "openai:deepseek-v4-flash"}) called
      // Then:  error lists "anthropic, deepseek" AND pre-P-21 hint AND "--model-id"
      const saved = saveEnv(...MODEL_ENV_KEYS);
      const { tmpHome, cleanup } = setupTmpHome({
        anthropic: { key: "sk-fake-ant", type: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
        deepseek: { key: "sk-fake-ds", type: "openai", baseUrl: "https://api.deepseek.com/v1" },
      });
      process.env.HOME = tmpHome;
      clearModelEnv();
      try {
        assert.throws(
          () => resolveModel({ factory: "openai:deepseek-v4-flash" }),
          (err: unknown) => {
            assert.ok(err instanceof Error, "T-FA.1: must throw an Error instance");
            assert.ok(
              err.message.includes("anthropic"),
              `T-FA.1: error must mention configured provider 'anthropic'; got: ${err.message}`,
            );
            assert.ok(
              err.message.includes("deepseek"),
              `T-FA.1: error must mention configured provider 'deepseek'; got: ${err.message}`,
            );
            // Pre-P-21 stale-spec hint — triggered when provider === "openai"
            assert.ok(
              err.message.includes("pre-P-21"),
              `T-FA.1: error must include 'pre-P-21' hint (openai provider); got: ${err.message}`,
            );
            // --model-id in the configure guidance (F-E)
            assert.ok(
              err.message.includes("--model-id"),
              `T-FA.1: error must include '--model-id' in guidance; got: ${err.message}`,
            );
            return true;
          },
        );
      } finally {
        restoreEnv(saved);
        cleanup();
      }
    },
  );
});

// ─── T-FA.2 ───────────────────────────────────────────────────────────────────

describe("buildModel error — generic provider list (no pre-P-21 hint) (G-P36.1)", () => {
  it(
    "T-FA.2: when provider='together' not configured and providers={anthropic}, " +
      "buildModel throws listing 'anthropic' but NOT the pre-P-21 stale-spec hint",
    () => {
      // Given: auth state with only {anthropic}; spec provider="together" (not openai)
      // When:  resolveModel({factory: "together:x"}) called
      // Then:  error lists "anthropic" as configured; does NOT contain the pre-P-21 hint;
      //        does contain "--model-id"
      const saved = saveEnv(...MODEL_ENV_KEYS);
      const { tmpHome, cleanup } = setupTmpHome({
        anthropic: { key: "sk-fake-ant", type: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
      });
      process.env.HOME = tmpHome;
      clearModelEnv();
      try {
        assert.throws(
          () => resolveModel({ factory: "together:x" }),
          (err: unknown) => {
            assert.ok(err instanceof Error, "T-FA.2: must throw an Error instance");
            assert.ok(
              err.message.includes("anthropic"),
              `T-FA.2: error must list 'anthropic' (configured provider); got: ${err.message}`,
            );
            // No pre-P-21 hint for "together" — only fires when provider === "openai"
            assert.ok(
              !err.message.includes("pre-P-21"),
              `T-FA.2: error must NOT include pre-P-21 hint for non-openai provider; got: ${err.message}`,
            );
            assert.ok(
              err.message.includes("--model-id"),
              `T-FA.2: error must include '--model-id' in guidance; got: ${err.message}`,
            );
            return true;
          },
        );
      } finally {
        restoreEnv(saved);
        cleanup();
      }
    },
  );
});

// ─── T-FA.3 ───────────────────────────────────────────────────────────────────

describe("buildModel error — spec-source naming: MAI_MODEL env var (G-P36.3)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = saveEnv(...MODEL_ENV_KEYS);
  });
  afterEach(() => {
    restoreEnv(saved);
  });

  it(
    "T-FA.3: when process.env.MAI_MODEL='openai:bad' and spec equals that env value, " +
      "buildModel error names 'the MAI_MODEL env var' as the source",
    () => {
      // Given: MAI_MODEL env var set to failing spec; no matching provider configured
      // When:  resolveModel({}) → resolveModelSpec picks up MAI_MODEL → buildModel throws
      // Then:  error message contains "MAI_MODEL"
      const tmpHome = mkdtempSync(join(tmpdir(), "mai-p36-fa3-"));
      // Empty HOME → no secrets.json → no providers
      process.env.HOME = tmpHome;
      process.env.MAI_MODEL = "openai:bad-model-fa3";
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
      try {
        assert.throws(
          () => resolveModel({}),
          (err: unknown) => {
            assert.ok(err instanceof Error, "T-FA.3: must throw an Error instance");
            assert.ok(
              err.message.includes("MAI_MODEL"),
              `T-FA.3: error must name 'MAI_MODEL' as the spec source; got: ${err.message}`,
            );
            return true;
          },
        );
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );
});

// ─── T-FA.4 ───────────────────────────────────────────────────────────────────

describe("buildModel error — spec-source naming: auth/secrets default (G-P36.3)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = saveEnv(...MODEL_ENV_KEYS);
  });
  afterEach(() => {
    restoreEnv(saved);
  });

  it(
    "T-FA.4: when spec equals readAuthJsonDefault() (and MAI_MODEL not set), " +
      "buildModel error names 'the auth.json / secrets.json default' as the source",
    () => {
      // Given: MAI_MODEL unset; secrets.json default is the failing spec
      // When:  resolveModel({}) → resolveModelSpec picks up auth default → buildModel throws
      // Then:  error message contains "auth.json / secrets.json default"
      const { tmpHome, cleanup } = setupTmpHome(
        {
          // No "openai" provider — spec will fail
        },
        { default: "openai:bad-model-fa4" },
      );
      process.env.HOME = tmpHome;
      delete process.env.MAI_MODEL; // ensure MAI_MODEL is unset so auth default wins
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
      try {
        // Confirm readAuthJsonDefault() returns the bad spec from the tmp secrets
        const authDefault = readAuthJsonDefault();
        assert.equal(
          authDefault,
          "openai:bad-model-fa4",
          "T-FA.4: readAuthJsonDefault() must return the default from tmp secrets.json",
        );

        assert.throws(
          () => resolveModel({}),
          (err: unknown) => {
            assert.ok(err instanceof Error, "T-FA.4: must throw an Error instance");
            assert.ok(
              err.message.includes("auth.json / secrets.json default"),
              `T-FA.4: error must name 'auth.json / secrets.json default' as the spec source; got: ${err.message}`,
            );
            return true;
          },
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-FB.1 ───────────────────────────────────────────────────────────────────

describe("resolveModelOrNull — returns null + stderr on resolution failure (G-P36.5)", () => {
  it("T-FB.1: given no-auth state, resolveModelOrNull() returns null; one stderr line written; does not throw", () => {
    // Given: no auth state / broken provider config (no real API keys needed)
    // When:  resolveModelOrNull() called
    // Then:  returns null (type LanguageModel | null); one stderr line captured;
    //        no thrown exception; no process.exit called
    void (resolveModelOrNull as (o?: ResolveModelOpts) => unknown);
    const saved = saveEnv(...MODEL_ENV_KEYS);
    // Point HOME to empty tmp dir — no secrets.json → no providers
    // → DEFAULT_MODEL_SPEC "anthropic:claude-sonnet-4-5" → no "anthropic" provider → throws
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-p36-fb1-"));
    process.env.HOME = tmpHome;
    delete process.env.MAI_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stderr as any).write = (chunk: string | Buffer) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    let result: unknown;
    let threw = false;
    try {
      result = resolveModelOrNull({});
    } catch {
      threw = true;
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = origStderrWrite;
      restoreEnv(saved);
      rmSync(tmpHome, { recursive: true, force: true });
    }

    assert.ok(!threw, "T-FB.1: resolveModelOrNull must NOT throw");
    assert.equal(result, null, "T-FB.1: resolveModelOrNull must return null on failure");
    const stderr = stderrChunks.join("");
    assert.ok(stderrChunks.length > 0, "T-FB.1: at least one stderr chunk must be written");
    assert.ok(stderr.includes("[mai]"), `T-FB.1: stderr must contain '[mai]' prefix; got: ${stderr}`);
  });
});

// ─── T-FB.2 ───────────────────────────────────────────────────────────────────

describe("resolveModelOrNull — returns LanguageModel on success (G-P36.5)", () => {
  it("T-FB.2: given valid auth state, resolveModelOrNull() returns a non-null LanguageModel; no stderr written", () => {
    // Given: valid provider configured (tmp secrets.json with real provider shape)
    // When:  resolveModelOrNull() called with factory pointing to configured provider
    // Then:  returns a non-null LanguageModel object; stderr empty; no throw
    const saved = saveEnv(...MODEL_ENV_KEYS);
    // P-71: must use a non-official baseUrl; official OpenAI/Anthropic URLs are scope-disabled
    const { tmpHome, cleanup } = setupTmpHome({
      myprovider: {
        key: "sk-test-key-placeholder",
        type: "openai",
        baseUrl: "https://api.deepseek.com/v1",
      },
    });
    process.env.HOME = tmpHome;
    delete process.env.MAI_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stderr as any).write = (chunk: string | Buffer) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    let result: unknown;
    let threw = false;
    try {
      // factory overrides the default spec so it resolves "myprovider"
      result = resolveModelOrNull({ factory: "myprovider:gpt-4o" });
    } catch {
      threw = true;
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = origStderrWrite;
      restoreEnv(saved);
      cleanup();
    }

    assert.ok(!threw, "T-FB.2: resolveModelOrNull must NOT throw even on success path");
    assert.ok(result !== null && result !== undefined, "T-FB.2: resolveModelOrNull must return non-null LanguageModel");
    assert.equal(typeof result, "object", "T-FB.2: returned value must be an object (LanguageModel)");
    assert.equal(stderrChunks.join(""), "", "T-FB.2: no stderr must be written on successful model resolution");
  });
});
