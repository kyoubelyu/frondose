/**
 * P-ZH-1 — T-Lang.1–3 — config persistence contract for the new `language` additive-optional field.
 *
 * `language: z.enum(["auto","en","zh"]).default("auto")` mirrors the P-58d.1 `updateServerUrl`
 * pattern: additive optional, NO schema_version bump — old (v1 or pre-P-ZH-1 v2) configs
 * Zod-fill "auto" and drive both the UI-chrome locale AND the agent reply-language override
 * unchanged from today's behavior.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/config-language.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig, writeConfig } from "../../src/persistence/config.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "mai-p-zh-1-cfg-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

// ─── T-Lang.1 ────────────────────────────────────────────────────────────────

describe("readConfig — language defaults to 'auto' when absent", () => {
  it("T-Lang.1: a v2 config.json written WITHOUT a language key → readConfig returns language:'auto' (Zod default), other fields unchanged", () => {
    // Given: a v2 config.json with no `language` key at all (pre-P-ZH-1 config on disk)
    // When:  readConfig(path)
    // Then:  result.language === "auto"; schema_version stays 2 (no migration); other fields preserved
    const { configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
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
          soul: { override: "sentinel-no-wipe" },
          // NO language key
        }),
        "utf-8",
      );
      const result = readConfig(configPath);
      assert.equal(result.language, "auto", "absent language key → Zod fills default('auto')");
      assert.equal(result.schema_version, 2, "schema_version stays 2 — no migration triggered by the missing field");
      assert.equal(result.soul.override, "sentinel-no-wipe", "soul.override NOT wiped (no whole-config reset)");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Lang.2 ────────────────────────────────────────────────────────────────

describe("readConfig — a config without language (v1 or bare v2) Zod-fills 'auto'", () => {
  it("T-Lang.2: DEFAULT_CONFIG_V2 (returned when config.json is missing) carries language:'auto'", () => {
    // Given: no config.json on disk at all
    // When:  readConfig(path)
    // Then:  result.language === "auto" (DEFAULT_CONFIG_V2 carries the new field)
    const { configPath, cleanup } = makeTmpDir();
    try {
      const result = readConfig(configPath);
      assert.equal(result.language, "auto");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Lang.3 ────────────────────────────────────────────────────────────────

describe("writeConfig + readConfig — language round-trips", () => {
  it("T-Lang.3: writeConfig({..., language:'zh'}) then readConfig returns language:'zh' verbatim", () => {
    // Given: a ConfigJsonV2 with language:"zh" written via writeConfig(cfg, path)
    // When:  readConfig(path)
    // Then:  result.language === "zh" (field preserved verbatim)
    const { configPath, cleanup } = makeTmpDir();
    try {
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
          language: "zh",
        },
        configPath,
      );
      const result = readConfig(configPath);
      assert.equal(result.language, "zh");
    } finally {
      cleanup();
    }
  });
});
