import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applySettings, parseSettingsPatch, readSettings, type SettingsView } from "../../../src/app/backend/settings.js";
import { maskKey } from "../../../src/persistence/auth.js";
import { readSecrets, writeSecrets } from "../../../src/persistence/secrets.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

const RAW_BRAVE_KEY = "bsa_live_value_1234567890";

async function withSettingsHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "frondose-p-ext-settings-"));
  const saved = { HOME: process.env.HOME, FRONDOSE_HOME_BASE: process.env.FRONDOSE_HOME_BASE };
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
  try {
    return await fn();
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.FRONDOSE_HOME_BASE === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = saved.FRONDOSE_HOME_BASE;
    cleanupTmpDir(home);
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

describe("P-EXT-SEARCH settings backend — search.brave view + write-only key", () => {
  it("T-Settings.Search.1: readSettings exposes search.brave.hasKey/maskedKey only — the raw key never appears in the view", async () => {
    // Given: secrets seeded with a Brave key.
    await withSettingsHome(async () => {
      seedSecrets({ braveApiKey: RAW_BRAVE_KEY });
      // When: the settings view is read.
      const view: SettingsView = readSettings();
      // Then: the view carries hasKey + maskedKey under search.brave, and the raw key is absent from the whole view JSON.
      assert.equal(view.search.brave.hasKey, true);
      assert.equal(view.search.brave.maskedKey, maskKey(RAW_BRAVE_KEY));
      assert.ok(!JSON.stringify(view).includes(RAW_BRAVE_KEY), "raw Brave key must not appear in the settings view");
    });
  });

  it("T-Settings.Search.2: parseSettingsPatch accepts search.brave.key and rejects non-object search shapes", async () => {
    // Given: a patch body with search.brave.key and a malformed one.
    // When: parseSettingsPatch is called.
    const ok = parseSettingsPatch({ search: { brave: { key: RAW_BRAVE_KEY } } });
    const bad = parseSettingsPatch({ search: "nope" });
    // Then: the valid shape parses; the malformed shape fails.
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.patch.search?.brave?.key, RAW_BRAVE_KEY);
    assert.equal(bad.ok, false);
  });

  it("T-Settings.Search.3: applySettings persists a fresh key via writeSearchConfig preserving sibling secrets", async () => {
    // Given: secrets with providers/github/server/tavily and no Brave key.
    await withSettingsHome(async () => {
      seedSecrets({ tavilyApiKey: "tavily-keep" });
      // When: a fresh Brave key is applied.
      applySettings({ search: { brave: { key: RAW_BRAVE_KEY } } });
      // Then: the key persists in secrets.search.braveApiKey and all sibling secrets survive.
      const s = readSecrets();
      assert.equal(s.search?.braveApiKey, RAW_BRAVE_KEY);
      assert.equal(s.search?.tavilyApiKey, "tavily-keep");
      assert.equal(s.providers?.deepseek?.key, "deepseek-key");
      assert.equal(s.github?.token, "gh-token");
      assert.equal(s.server?.token, "server-token");
      // And: the view now reports the masked key.
      assert.equal(readSettings().search.brave.maskedKey, maskKey(RAW_BRAVE_KEY));
    });
  });

  it("T-Settings.Search.4: masked echo, empty, and whitespace-only submissions are no-ops WITHOUT rewriting secrets.json", async () => {
    // Given: secrets with an existing Brave key.
    await withSettingsHome(async () => {
      seedSecrets({ braveApiKey: RAW_BRAVE_KEY });
      const existing = readSettings().search.brave.maskedKey;
      const secretsPath = join(process.env.HOME ?? "", ".frondose", "agent", "secrets.json");
      const mtimeBefore = statSync(secretsPath).mtimeMs;
      // When: masked echo / empty / whitespace patches are applied.
      applySettings({ search: { brave: { key: existing ?? "" } } });
      applySettings({ search: { brave: { key: "" } } });
      applySettings({ search: { brave: { key: "   " } } });
      // Then: the stored key is unchanged AND the file was not rewritten (audit MR: no-op must not write).
      assert.equal(readSecrets().search?.braveApiKey, RAW_BRAVE_KEY);
      assert.equal(statSync(secretsPath).mtimeMs, mtimeBefore, "a no-op submission must not rewrite secrets.json");
    });
  });

  it("T-Settings.Search.5: a fresh key replaces the old key; the old value never survives", async () => {
    // Given: secrets with an existing Brave key.
    await withSettingsHome(async () => {
      seedSecrets({ braveApiKey: "bsa_old_key_1" });
      // When: a fresh key is applied.
      applySettings({ search: { brave: { key: RAW_BRAVE_KEY } } });
      // Then: the stored key is the new one only.
      assert.equal(readSecrets().search?.braveApiKey, RAW_BRAVE_KEY);
      assert.ok(!JSON.stringify(readSecrets()).includes("bsa_old_key_1"), "old key must be replaced, not merged");
    });
  });
});
