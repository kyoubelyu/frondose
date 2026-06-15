import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applySettings, parseSettingsPatch } from "../../../src/cli/subcommands/serve/settings.js";
import { readAuth, writeAuth } from "../../../src/persistence/auth.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETTINGS_ENV_KEYS = ["HOME", "MAI_HOME_BASE"] as const;
type SettingsEnvKey = (typeof SETTINGS_ENV_KEYS)[number];

function saveEnv(): Record<SettingsEnvKey, string | undefined> {
  const saved = {} as Record<SettingsEnvKey, string | undefined>;
  for (const key of SETTINGS_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<SettingsEnvKey, string | undefined>): void {
  for (const key of SETTINGS_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withSettingsHome<T>(fn: () => T): T {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "mai-p71-settings-"));
  const saved = saveEnv();
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
  try {
    return fn();
  } finally {
    restoreEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
}

function seedLegacyDirectDefault(provider: "anthropic" | "openai"): void {
  writeAuth({
    default: provider === "anthropic" ? "anthropic:claude-sonnet-4-5" : "openai:gpt-4o",
    providers: {
      [provider]: {
        key: "sk-legacy",
        baseUrl: provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1",
        type: provider === "anthropic" ? "anthropic" : "openai",
      },
    },
  });
}

describe("P-71 app settings provider scope", () => {
  it("T-P71.Settings.1: settings patch rejects reserved provider names", () => {
    for (const provider of ["anthropic", "openai"]) {
      // Given: POST body llm.provider is a reserved direct provider name.
      // When: parseSettingsPatch(body) runs.
      // Then: validation fails before any settings write can happen.
      const result = parseSettingsPatch({ llm: { provider, baseUrl: "https://custom.example/v1", model: "m" } });
      assert.equal(result.ok, false, `${provider} must be rejected as a reserved provider name`);
    }
  });

  it("T-P71.Settings.2: settings patch rejects official vendor base URLs", () => {
    const officialUrls = [
      "https://api.openai.com",
      "https://api.openai.com/v1/",
      "https://API.OPENAI.COM/v1/",
      "https://api.anthropic.com",
      "https://api.anthropic.com/v1/",
      "https://API.ANTHROPIC.COM/v1/",
    ];

    for (const baseUrl of officialUrls) {
      // Given: POST body llm.baseUrl is an official Anthropic/OpenAI host variant.
      // When: parseSettingsPatch(body) runs.
      // Then: validation fails and existing secrets/config would remain unchanged.
      const result = parseSettingsPatch({ llm: { provider: "custom", baseUrl, model: "m" } });
      assert.equal(result.ok, false, `${baseUrl} must be rejected as a direct-vendor URL`);
    }
  });

  it("T-P71.Settings.3: app settings cannot inherit a legacy direct default when saving", () => {
    withSettingsHome(() => {
      // Given: the current default/provider is legacy direct Anthropic and UI sends baseUrl/model/key with no provider.
      // When: applySettings handles the UI-style patch.
      // Then: the written default/provider is allowed custom/DeepSeek, never anthropic/openai.
      seedLegacyDirectDefault("anthropic");
      const parsed = parseSettingsPatch({
        llm: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", key: "sk-deepseek" },
      });
      assert.equal(parsed.ok, true, "DeepSeek/custom URL patch shape should parse");
      if (!parsed.ok) return;

      applySettings(parsed.patch);
      const auth = readAuth();
      assert.ok(auth?.providers?.anthropic, "legacy direct entry remains readable for non-destructive compatibility");
      assert.ok(!auth?.default?.startsWith("anthropic:"), `default must not stay direct; got ${auth?.default}`);
      assert.ok(!auth?.default?.startsWith("openai:"), `default must not become direct OpenAI; got ${auth?.default}`);
      assert.ok(
        Object.keys(auth?.providers ?? {}).some((provider) => !["anthropic", "openai"].includes(provider)),
        "saving should create or use an allowed custom/DeepSeek provider",
      );
    });
  });

  it("T-P71.Settings.4: blank or missing baseUrl does not inherit a legacy direct provider", () => {
    withSettingsHome(() => {
      // Given: current settings point at a legacy direct OpenAI provider.
      // When: a blank or missing baseUrl patch is parsed/applied.
      // Then: blank baseUrl fails, and missing baseUrl cannot rewrite or activate openai/anthropic.
      seedLegacyDirectDefault("openai");

      const blank = parseSettingsPatch({ llm: { baseUrl: " ", model: "gpt-4o", key: "sk-new" } });
      assert.equal(blank.ok, false, "blank baseUrl must not activate a legacy direct provider");

      const missing = parseSettingsPatch({ llm: { model: "deepseek-v4-flash", key: "sk-new" } });
      assert.equal(missing.ok, true, "missing baseUrl reaches applySettings so inheritance behavior is covered");
      if (!missing.ok) return;

      applySettings(missing.patch);
      const auth = readAuth();
      assert.ok(!auth?.default?.startsWith("openai:"), `missing baseUrl must not inherit openai; got ${auth?.default}`);
      assert.ok(
        !auth?.providers?.openai || auth.providers.openai.baseUrl === "https://api.openai.com/v1",
        "missing baseUrl must not rewrite the legacy direct provider as an active custom provider",
      );
    });
  });

  it("T-P71.Settings.5: Tauri settings UI remains custom-URL-only for LLMs and allows only Brave MCP search", () => {
    // Given: src/tauri/ui/index.html and src/tauri/ui/settings.ts.
    // When: the settings UI source is scanned.
    // Then: it exposes base URL/model/key controls, may expose Brave MCP key storage, and has no Tavily/direct-provider presets.
    const html = readFileSync(join(REPO, "src", "tauri", "ui", "index.html"), "utf8");
    const ts = readFileSync(join(REPO, "src", "tauri", "ui", "settings.ts"), "utf8");
    const combined = `${html}\n${ts}`;

    assert.match(combined, /baseUrl|Base URL/i, "settings UI must keep custom URL baseUrl control");
    assert.match(combined, /model/i, "settings UI must keep model control");
    assert.match(combined, /key|API key/i, "settings UI must keep key control");
    assert.doesNotMatch(combined, /Anthropic preset|OpenAI preset|Tavily|api\.search\.brave\.com|api\.tavily\.com/i);
  });
});
