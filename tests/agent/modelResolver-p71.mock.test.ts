import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectAnyModelKey, resolveModel, resolveModelSpec } from "../../src/agent/modelResolver.js";
import { readAuth, writeAuth } from "../../src/persistence/auth.js";

const MODEL_ENV_KEYS = [
  "HOME",
  "MAI_HOME_BASE",
  "MAI_MODEL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
] as const;

type ModelEnvKey = (typeof MODEL_ENV_KEYS)[number];

function saveEnv(): Record<ModelEnvKey, string | undefined> {
  const saved = {} as Record<ModelEnvKey, string | undefined>;
  for (const key of MODEL_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<ModelEnvKey, string | undefined>): void {
  for (const key of MODEL_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withIsolatedModelHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "mai-p71-model-"));
  const saved = saveEnv();
  process.env.HOME = home;
  process.env.MAI_HOME_BASE = home;
  delete process.env.MAI_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  try {
    return fn(home);
  } finally {
    restoreEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
}

function isP71ProviderPolicyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(scope|disabled|direct|reserved|migration|migrate|custom|DeepSeek|configured|baseUrl)/i.test(error.message) &&
    !/Set ANTHROPIC_API_KEY|Set OPENAI_API_KEY/i.test(error.message)
  );
}

describe("P-71 provider scope consolidation", () => {
  it("T-P71.Provider.1: all unset resolves to the DeepSeek default spec and fails with configuration-needed, not Anthropic", () => {
    withIsolatedModelHome(() => {
      // Given: isolated HOME with no MAI_MODEL, no auth/secrets default, and no provider keys.
      // When: resolveModelSpec({}) and resolveModel({}) run.
      // Then: the default is DeepSeek and model resolution asks for configuration without Anthropic fallback text.
      assert.equal(resolveModelSpec({}), "deepseek:deepseek-v4-flash");
      assert.throws(
        () => resolveModel({}),
        (error: unknown) =>
          error instanceof Error &&
          /config|key|provider|DeepSeek/i.test(error.message) &&
          !error.message.includes("anthropic:claude-sonnet-4-5"),
      );
    });
  });

  it("T-P71.Provider.2: direct Anthropic specs are blocked even when a legacy Anthropic provider entry exists", () => {
    withIsolatedModelHome(() => {
      // Given: legacy secrets include providers.anthropic with type:"anthropic" and a key.
      // When: resolveModel({factory:"anthropic:claude-sonnet-4-5"}) runs.
      // Then: resolution fails before a direct Anthropic SDK model can be used.
      writeAuth({
        providers: {
          anthropic: { key: "sk-ant-legacy", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
        },
      });

      assert.throws(() => resolveModel({ factory: "anthropic:claude-sonnet-4-5" }), isP71ProviderPolicyError);
    });
  });

  it("T-P71.Provider.3: reserved OpenAI specs are blocked even when pointed at DeepSeek", () => {
    withIsolatedModelHome(() => {
      // Given: legacy providers.openai points at DeepSeek with a key.
      // When: resolveModel({factory:"openai:deepseek-v4-flash"}) runs.
      // Then: resolution rejects the reserved provider name and tells the operator to use deepseek:<model>.
      writeAuth({
        providers: {
          openai: { key: "sk-deepseek-legacy", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
        },
      });

      assert.throws(
        () => resolveModel({ factory: "openai:deepseek-v4-flash" }),
        (error: unknown) =>
          isP71ProviderPolicyError(error) &&
          error instanceof Error &&
          /deepseek/i.test(error.message) &&
          /openai/i.test(error.message),
      );
    });
  });

  it("T-P71.Provider.4: official OpenAI and Anthropic base URLs are blocked under custom names", () => {
    const officialUrls = [
      "https://api.openai.com",
      "https://api.openai.com/v1",
      "https://api.openai.com/v1/",
      "https://API.OPENAI.COM/v1/",
      "https://api.anthropic.com",
      "https://api.anthropic.com/v1",
      "https://api.anthropic.com/v1/",
      "https://API.ANTHROPIC.COM/v1/",
    ];

    for (const baseUrl of officialUrls) {
      withIsolatedModelHome(() => {
        // Given: providers.custom uses an official direct-vendor host variant.
        // When: resolveModel({factory:"custom:<model>"}) runs.
        // Then: host normalization rejects the direct vendor regardless of case, /v1, or trailing slash.
        writeAuth({
          providers: {
            custom: { key: "sk-custom", baseUrl, type: "openai" },
          },
        });

        assert.throws(
          () => resolveModel({ factory: "custom:test-model" }),
          (error: unknown) =>
            isP71ProviderPolicyError(error) &&
            error instanceof Error &&
            /openai|anthropic|official|direct/i.test(error.message),
        );
      });
    }
  });

  it("T-P71.Provider.5: custom OpenAI-compatible entries without baseUrl cannot fall back to official OpenAI", () => {
    withIsolatedModelHome(() => {
      // Given: providers.custom has a key and type:"openai" but no usable baseUrl.
      // When: resolveModel({factory:"custom:<model>"}) runs.
      // Then: resolution fails before createOpenAI can receive an undefined base URL.
      writeAuth({
        providers: {
          custom: { key: "sk-custom", type: "openai" },
        },
      });

      assert.throws(() => resolveModel({ factory: "custom:test-model" }), isP71ProviderPolicyError);
    });
  });

  it("T-P71.Provider.6: DeepSeek env-only configuration resolves through the custom OpenAI-compatible path", () => {
    withIsolatedModelHome(() => {
      // Given: no persisted secrets, MAI_MODEL=deepseek:<model>, DEEPSEEK_API_KEY, and DEEPSEEK_BASE_URL.
      // When: resolveModel({}) runs.
      // Then: a DeepSeek OpenAI-compatible LanguageModel is returned without writing secrets.
      process.env.MAI_MODEL = "deepseek:deepseek-v4-flash";
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-env";
      process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";

      const model = resolveModel({});
      assert.match(model.provider, /deepseek/i);
      assert.equal(readAuth(), null, "env-only DeepSeek must not write auth/secrets");
    });
  });

  it("T-P71.Provider.7: persisted custom OpenAI-compatible providers still resolve", () => {
    withIsolatedModelHome(() => {
      // Given: providers.together has a non-official custom baseUrl and key.
      // When: resolveModel({factory:"together:<model>"}) runs.
      // Then: a LanguageModel is returned through the custom OpenAI-compatible adapter path.
      writeAuth({
        providers: {
          together: { key: "sk-together", baseUrl: "https://api.together.xyz/v1", type: "openai" },
        },
      });

      const model = resolveModel({ factory: "together:meta-llama/Llama-4" });
      assert.match(model.provider, /together/i);
    });
  });

  it("T-P71.Provider.8: model readiness ignores direct vendor env vars and legacy direct provider entries", () => {
    withIsolatedModelHome(() => {
      // Given: only direct Anthropic/OpenAI env vars or only legacy direct provider entries exist.
      // When: detectAnyModelKey() runs for each case.
      // Then: direct vendors are ignored while DeepSeek env and allowed custom providers still count as ready.
      process.env.ANTHROPIC_API_KEY = "sk-ant-env";
      assert.equal(detectAnyModelKey(), false, "ANTHROPIC_API_KEY must not count as model readiness");
      delete process.env.ANTHROPIC_API_KEY;

      process.env.OPENAI_API_KEY = "sk-openai-env";
      assert.equal(detectAnyModelKey(), false, "OPENAI_API_KEY must not count as model readiness");
      delete process.env.OPENAI_API_KEY;

      writeAuth({
        providers: {
          anthropic: { key: "sk-ant-legacy", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
        },
      });
      assert.equal(detectAnyModelKey(), false, "legacy direct provider entries must not count as readiness");

      process.env.DEEPSEEK_API_KEY = "sk-deepseek-env";
      assert.equal(detectAnyModelKey(), true, "DEEPSEEK_API_KEY remains in scope");
      delete process.env.DEEPSEEK_API_KEY;

      writeAuth({
        providers: {
          together: { key: "sk-together", baseUrl: "https://api.together.xyz/v1", type: "openai" },
        },
      });
      assert.equal(detectAnyModelKey(), true, "allowed custom provider keys remain in scope");
    });
  });

  it("T-P71.Provider.9: legacy direct provider data remains readable but not executable", () => {
    withIsolatedModelHome(() => {
      // Given: secrets contain direct Anthropic/OpenAI legacy providers.
      // When: readAuth() and resolveModel() run.
      // Then: legacy entries remain readable, but runtime execution is blocked.
      writeAuth({
        default: "anthropic:claude-sonnet-4-5",
        providers: {
          anthropic: { key: "sk-ant-legacy", baseUrl: "https://api.anthropic.com/v1", type: "anthropic" },
          openai: { key: "sk-openai-legacy", baseUrl: "https://api.openai.com/v1", type: "openai" },
        },
      });

      const auth = readAuth();
      assert.equal(auth?.providers?.anthropic?.key, "sk-ant-legacy");
      assert.equal(auth?.providers?.openai?.key, "sk-openai-legacy");
      assert.throws(() => resolveModel({ factory: "anthropic:claude-sonnet-4-5" }), isP71ProviderPolicyError);
      assert.throws(() => resolveModel({ factory: "openai:gpt-4o" }), isP71ProviderPolicyError);
    });
  });

  it("T-P71.Provider.10: bare legacy direct defaults are blocked with migration guidance", () => {
    for (const bareProvider of ["anthropic", "openai"]) {
      withIsolatedModelHome(() => {
        // Given: a persisted default or factory override is the bare legacy provider name.
        // When: resolveModelSpec({}) and resolveModel({}) run against that value.
        // Then: runtime fails with direct-provider-disabled or migration guidance, not a silent fallback.
        writeAuth({
          default: bareProvider,
          providers: {
            [bareProvider]: {
              key: "sk-legacy",
              baseUrl: bareProvider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1",
              type: bareProvider === "anthropic" ? "anthropic" : "openai",
            },
          },
        });

        assert.equal(resolveModelSpec({}), bareProvider);
        assert.throws(
          () => resolveModel({}),
          (error: unknown) =>
            isP71ProviderPolicyError(error) &&
            error instanceof Error &&
            /migration|migrate|provider|direct|disabled/i.test(error.message),
        );
        assert.throws(
          () => resolveModel({ factory: bareProvider }),
          (error: unknown) =>
            isP71ProviderPolicyError(error) &&
            error instanceof Error &&
            /migration|migrate|provider|direct|disabled/i.test(error.message),
        );
      });
    }
  });

  // ─── Edge cases added at Step 5 ────────────────────────────────────────────

  it("T-P71.Provider.EC1: mixed-case reserved provider names ('ANTHROPIC', 'OpenAI') are blocked via normalizeProviderName", () => {
    // Given: specs with uppercase or mixed-case reserved provider names
    // When: parseModelSpec + buildModel run
    // Then: P-71 normalizes to lowercase before checking reserved names → blocked
    withIsolatedModelHome(() => {
      for (const upperSpec of ["ANTHROPIC:claude-sonnet-4-5", "OpenAI:gpt-4o", "OPENAI:gpt-4o-mini"]) {
        assert.throws(
          () => resolveModel({ factory: upperSpec }),
          (error: unknown) =>
            error instanceof Error &&
            (error.message.includes("scope-disabled") ||
              error.message.includes("P-71") ||
              error.message.includes("reserved") ||
              error.message.includes("Invalid model spec")),
          `T-P71.Provider.EC1: '${upperSpec}' must be blocked (reserved name normalized case-insensitively)`,
        );
      }
    });
  });

  it("T-P71.Provider.EC2: DeepSeek env-only works without DEEPSEEK_BASE_URL (defaults to api.deepseek.com/v1)", () => {
    // Given: DEEPSEEK_API_KEY set, DEEPSEEK_BASE_URL absent, MAI_MODEL=deepseek:deepseek-v4-flash
    // When: resolveModel({}) runs
    // Then: defaults to https://api.deepseek.com/v1 without throwing
    withIsolatedModelHome(() => {
      process.env.MAI_MODEL = "deepseek:deepseek-v4-flash";
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-only";
      // DEEPSEEK_BASE_URL intentionally unset — should use DEFAULT_DEEPSEEK_BASE_URL
      const model = resolveModel({});
      assert.match(model.provider, /deepseek/i, "T-P71.Provider.EC2: must resolve to DeepSeek provider");
    });
  });
});
