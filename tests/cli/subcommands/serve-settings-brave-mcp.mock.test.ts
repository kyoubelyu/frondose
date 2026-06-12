import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handlePostSettings } from "../../../src/cli/subcommands/serve/routes/settings.js";
import { applySettings, parseSettingsPatch, readSettings } from "../../../src/cli/subcommands/serve/settings.js";
import { maskKey } from "../../../src/persistence/auth.js";
import { DEFAULT_SECRETS_PATH, readSecrets, writeSecrets } from "../../../src/persistence/secrets.js";

const RAW_BRAVE_KEY = "bsa_live_value_1234567890";

async function withSettingsHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "mai-pbrave-settings-"));
  const saved = { HOME: process.env.HOME, MAI_HOME_BASE: process.env.MAI_HOME_BASE };
  process.env.HOME = home;
  process.env.MAI_HOME_BASE = home;
  try {
    return await fn();
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.MAI_HOME_BASE === undefined) delete process.env.MAI_HOME_BASE;
    else process.env.MAI_HOME_BASE = saved.MAI_HOME_BASE;
    rmSync(home, { recursive: true, force: true });
  }
}

function seedSecrets(search: { braveApiKey?: string; tavilyApiKey?: string } = {}): void {
  writeSecrets({
    schema_version: 1,
    default: "deepseek:deepseek-chat",
    visionModel: "custom:vision",
    providers: {
      deepseek: { key: "deepseek-key", baseUrl: "https://api.deepseek.com/v1", type: "openai" },
      custom: { key: "custom-key", baseUrl: "https://llm.example/v1", type: "openai" },
    },
    github: { token: "gh-token", repo: "kyoube/frondose" },
    server: { token: "server-token", webToken: "web-token" },
    search,
  });
}

function jsonContains(obj: unknown, needle: string): boolean {
  return JSON.stringify(obj).includes(needle);
}

function reqWithJson(body: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}

function captureResponse() {
  const state: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return {
    state,
    res: {
      writeHead(status: number, headers: Record<string, string>) {
        state.status = status;
        state.headers = headers;
      },
      end(body: string) {
        state.body = body;
      },
    },
  };
}

describe("P-BRAVE-MCP settings backend read/parse contract", () => {
  it("T-PBrave.Settings.1: readSettings returns only masked search.brave key state and never the raw key", async () => {
    await withSettingsHome(() => {
      // Given: secrets.json.search.braveApiKey contains a raw Brave key.
      // When: readSettings() builds the app settings view.
      // Then: the view exposes hasKey/maskedKey only, and a deep JSON scan never sees the raw key.
      seedSecrets({ braveApiKey: RAW_BRAVE_KEY, tavilyApiKey: "legacy-tavily" });

      const view = readSettings() as {
        search?: { brave?: { hasKey?: boolean; maskedKey?: string | null; key?: string } };
      };

      assert.equal(view.search?.brave?.hasKey, true);
      assert.equal(view.search?.brave?.maskedKey, maskKey(RAW_BRAVE_KEY));
      assert.ok(!("key" in (view.search?.brave ?? {})), "raw search.brave.key must never be returned");
      assert.ok(!jsonContains(view, RAW_BRAVE_KEY), "settings JSON view must not contain the raw Brave key");
    });
  });

  it("T-PBrave.Settings.2: parseSettingsPatch accepts search.brave.key while still rejecting direct providers", () => {
    // Given: a Brave search key patch and the existing direct-provider guardrails.
    // When: parseSettingsPatch runs.
    // Then: search.brave.key survives parsing, while direct Anthropic/OpenAI scope remains rejected.
    const parsed = parseSettingsPatch({ search: { brave: { key: "fresh-brave-key" } } }) as {
      ok: boolean;
      patch?: { search?: { brave?: { key?: string } } };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.patch?.search?.brave?.key, "fresh-brave-key");

    assert.equal(parseSettingsPatch({ llm: { provider: "anthropic" } }).ok, false);
    assert.equal(parseSettingsPatch({ llm: { provider: "openai" } }).ok, false);
    assert.equal(parseSettingsPatch({ llm: { provider: "custom", baseUrl: "https://api.openai.com/v1" } }).ok, false);
    assert.equal(
      parseSettingsPatch({ llm: { provider: "custom", baseUrl: "https://api.anthropic.com/v1" } }).ok,
      false,
    );
  });
});

describe("P-BRAVE-MCP settings backend write contract", () => {
  it("T-PBrave.Settings.3: fresh search.brave.key writes search.braveApiKey and preserves root/search siblings", async () => {
    await withSettingsHome(() => {
      // Given: secrets.json has provider/default/vision/github/server siblings and an existing Tavily search key.
      // When: applySettings receives a fresh Brave key.
      // Then: only search.braveApiKey is updated and all siblings are preserved.
      seedSecrets({ tavilyApiKey: "legacy-tavily" });
      const parsed = parseSettingsPatch({ search: { brave: { key: "fresh-brave-key" } } });
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      applySettings(parsed.patch);
      const secrets = readSecrets(DEFAULT_SECRETS_PATH());

      assert.equal(secrets.search?.braveApiKey, "fresh-brave-key");
      assert.equal(secrets.search?.tavilyApiKey, "legacy-tavily");
      assert.equal(secrets.default, "deepseek:deepseek-chat");
      assert.equal(secrets.visionModel, "custom:vision");
      assert.equal(secrets.providers?.deepseek.key, "deepseek-key");
      assert.deepEqual(secrets.github, { token: "gh-token", repo: "kyoube/frondose" });
      assert.deepEqual(secrets.server, { token: "server-token", webToken: "web-token" });
    });
  });

  it("T-PBrave.Settings.4: omitted, empty, exact mask, mask-shaped, and whitespace-only Brave submissions are no-op", async () => {
    for (const key of [undefined, "", maskKey(RAW_BRAVE_KEY), "***7890", "****7890", "   "]) {
      await withSettingsHome(() => {
        // Given: an existing Brave key.
        // When: the submitted search.brave.key is omitted, blank, masked, mask-shaped, or whitespace-only.
        // Then: the existing key is preserved and not overwritten by UI placeholder values.
        seedSecrets({ braveApiKey: RAW_BRAVE_KEY, tavilyApiKey: "legacy-tavily" });
        const body =
          key === undefined ? { search: { brave: {} } } : { search: { brave: { key: key as string } } };
        const parsed = parseSettingsPatch(body) as {
          ok: boolean;
          patch?: { search?: { brave?: { key?: string } } };
        };
        assert.equal(parsed.ok, true, `patch should parse for key=${JSON.stringify(key)}`);
        assert.ok(parsed.patch?.search?.brave, "search.brave patch must be preserved for applySettings");
        if (!parsed.ok) return;

        applySettings(parsed.patch);
        const secrets = readSecrets(DEFAULT_SECRETS_PATH());
        assert.equal(secrets.search?.braveApiKey, RAW_BRAVE_KEY, `existing key preserved for ${JSON.stringify(key)}`);
        assert.equal(secrets.search?.tavilyApiKey, "legacy-tavily");
      });
    }
  });

  it("T-PBrave.Settings.5: POST /settings responds with masked Brave state and no raw key", async () => {
    await withSettingsHome(async () => {
      // Given: a POST /settings request that submits a fresh Brave key.
      // When: handlePostSettings applies the patch and responds.
      // Then: the response contains only masked search.brave state and never the raw key.
      seedSecrets();
      const { state, res } = captureResponse();
      const deps = { system: "old", systemResume: "old-resume", model: { old: true } };

      await handlePostSettings(
        deps as never,
        reqWithJson({ search: { brave: { key: RAW_BRAVE_KEY } } }) as never,
        res as never,
      );

      assert.equal(state.status, 200);
      const payload = JSON.parse(state.body ?? "{}") as {
        ok?: boolean;
        search?: { brave?: { hasKey?: boolean; maskedKey?: string | null } };
      };
      assert.equal(payload.ok, true);
      assert.equal(payload.search?.brave?.hasKey, true);
      assert.equal(payload.search?.brave?.maskedKey, maskKey(RAW_BRAVE_KEY));
      assert.ok(!JSON.stringify(payload).includes(RAW_BRAVE_KEY), "POST response must not leak raw Brave key");
    });
  });
});
