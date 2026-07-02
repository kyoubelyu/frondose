/**
 * P-ZH-1 — T-LangSettings.1–4 — Serve `/settings` surface for the new `language` field.
 *
 * Mirrors the P-58d.1 `updateServerUrl` settings-layer pattern:
 *  - T-LangSettings.1: readSettings() surfaces cfg.language.
 *  - T-LangSettings.2: applySettings({language:"zh"}) persists it; other fields unchanged.
 *  - T-LangSettings.3: parseSettingsPatch({language:"bad"}) → {ok:false} (enum rejects unknown values).
 *  - T-LangSettings.4: parseSettingsPatch({language:"en"}) → {ok:true}.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/cli/subcommands/serve-settings-language.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applySettings, parseSettingsPatch, readSettings } from "../../../src/cli/subcommands/serve/settings.js";
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "../../../src/persistence/config.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Run fn with MAI_HOME_BASE pointing at a fresh temp dir (DEFAULT_CONFIG_PATH resolves under it). */
function withTempHome<T>(fn: (home: string) => T): T {
  const prev = process.env.FRONDOSE_HOME_BASE;
  const home = mkdtempSync(join(tmpdir(), "p-zh-1-settings-"));
  process.env.FRONDOSE_HOME_BASE = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = prev;
    cleanupTmpDir(home);
  }
}

/** Seed a minimal v2 config.json with optional overrides. */
function seedConfig(over: Record<string, unknown> = {}): void {
  writeConfig(
    {
      schema_version: 2,
      server: {
        url: null,
        bind_address: null,
        poll_interval_s: 30,
        web_port: 8090,
        ssh_user: null,
        ssh_port: 22,
        rest_port: 3031,
      },
      worker: { id: null, hostname: null, label: null, input_mode: "cdp" },
      telegram: { enabled: false, boundUserId: null, proxyUrl: null },
      soul: { override: null },
      updateServerUrl: null,
      language: "auto",
      ...over,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ConfigJsonV2 fixture for test seeding
    } as any,
    DEFAULT_CONFIG_PATH(),
  );
}

// ─── T-LangSettings.1 ────────────────────────────────────────────────────────

describe("readSettings — surfaces cfg.language", () => {
  it("T-LangSettings.1: readSettings() returns view.language === cfg.language", () => {
    // Given: config.json with language:"zh"
    // When:  readSettings()
    // Then:  view.language === "zh"
    withTempHome(() => {
      seedConfig({ language: "zh" });
      const view = readSettings();
      assert.equal(view.language, "zh");
    });
  });
});

// ─── T-LangSettings.2 ────────────────────────────────────────────────────────

describe("applySettings — POST {language} persists it; other fields unchanged", () => {
  // Given: config with soul override set AND language:"auto"
  //        AND a valid patch {language:"zh"}
  // When:  parseSettingsPatch(patch) → ok:true → applySettings(patch)
  // Then:  readConfig(DEFAULT_CONFIG_PATH()).language === "zh"
  //        AND soul.override is unchanged from before the patch
  it("T-LangSettings.2: applySettings({language:'zh'}) writes the field; soul unchanged", () => {
    withTempHome(() => {
      seedConfig({ soul: { override: "my-soul" }, language: "auto" });
      const patchResult = parseSettingsPatch({ language: "zh" });
      assert.ok(patchResult.ok, `parseSettingsPatch must succeed: ${!patchResult.ok ? patchResult.error : ""}`);
      if (patchResult.ok) applySettings(patchResult.patch);
      const cfg = readConfig(DEFAULT_CONFIG_PATH());
      assert.equal(cfg.language, "zh", "language written");
      assert.equal(cfg.soul.override, "my-soul", "soul.override preserved — only language changed");
    });
  });
});

// ─── T-LangSettings.3 ────────────────────────────────────────────────────────

describe("parseSettingsPatch — invalid language value → {ok:false}; config left UNCHANGED", () => {
  // Given: a POST body {language: "bad"} (not one of "auto"|"en"|"zh")
  // When:  parseSettingsPatch(body)
  // Then:  returns {ok:false} (enum rejects the value) → the route 400s + writes NOTHING
  it("T-LangSettings.3: parseSettingsPatch({language:'bad'}) → {ok:false}; no write occurs", () => {
    withTempHome(() => {
      seedConfig({ language: "en" });
      const result = parseSettingsPatch({ language: "bad" });
      assert.equal(result.ok, false, "unknown enum value rejected");
      const cfg = readConfig(DEFAULT_CONFIG_PATH());
      assert.equal(cfg.language, "en", "config untouched — gate prevented write");
    });
  });
});

// ─── T-LangSettings.4 ────────────────────────────────────────────────────────

describe("parseSettingsPatch — a valid language value parses ok", () => {
  // Given: a POST body {language: "en"}
  // When:  parseSettingsPatch(body)
  // Then:  returns {ok:true, patch:{language:"en"}}
  it("T-LangSettings.4: parseSettingsPatch({language:'en'}) → {ok:true}", () => {
    const result = parseSettingsPatch({ language: "en" });
    assert.ok(result.ok, `parseSettingsPatch must accept a valid enum value: ${!result.ok ? result.error : ""}`);
    if (result.ok) assert.equal(result.patch.language, "en");
  });
});
