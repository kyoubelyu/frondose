/**
 * P-UPDATE-INTRANET Step 2 — T-Config.1–3 — config persistence contract for the
 * hardcoded intranet default `updateServerUrl` (plan §6.C T-Config.1).
 *
 * Builder Step 4 bakes `http://192.0.2.105:4875` in THREE spots in
 * `src/persistence/config.ts`: the Zod `.default(...)` (currently `null`, line
 * 72), `DEFAULT_CONFIG_V2.updateServerUrl` (currently `null`, line 107), and the
 * v1→v2 migration map (currently `null`, line 204). The field SHAPE is
 * unchanged (still `z.string().trim().nullable()`) — only the default VALUE
 * changes, so an explicit `null` on disk still round-trips as `null` (the
 * operator "clear the field" path is preserved) and an explicit override URL
 * is untouched. Mirrors the `tests/persistence/config-language.mock.test.ts`
 * (P-ZH-1) pattern.
 *
 * T-Config.1a/1b/1c are RED against today's source (all three spots are
 * currently `null`); T-Config.2/3 are already-green regression pins.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/config-updateDefault.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig, writeConfig } from "../../src/persistence/config.js";
import { cleanupTmpDir } from "../_helpers/tmp";

const DEFAULT_UPDATE_SERVER_URL = "http://192.0.2.105:4875";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "frondose-p-update-intranet-cfg-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

// ─── T-Config.1a ─────────────────────────────────────────────────────────────

describe("readConfig — updateServerUrl bakes the intranet default when the key is absent (P-UPDATE-INTRANET T-Config.1a)", () => {
  it("T-Config.1a: a v2 config.json written WITHOUT an updateServerUrl key → readConfig returns the baked default, other fields unchanged", () => {
    // Given: a v2 config.json with no `updateServerUrl` key at all (pre-P-UPDATE-INTRANET config on disk)
    // When:  readConfig(path)
    // Then:  result.updateServerUrl === "http://192.0.2.105:4875" (Zod default); other fields preserved
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
          // NO updateServerUrl key
        }),
        "utf-8",
      );
      const result = readConfig(configPath);
      assert.equal(result.updateServerUrl, DEFAULT_UPDATE_SERVER_URL, "absent updateServerUrl key → Zod fills the baked default");
      assert.equal(result.schema_version, 2, "schema_version stays 2 — no migration triggered by the missing field");
      assert.equal(result.soul.override, "sentinel-no-wipe", "soul.override NOT wiped (no whole-config reset)");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Config.1b ─────────────────────────────────────────────────────────────

describe("readConfig — DEFAULT_CONFIG_V2 (no config.json at all) carries the baked default (P-UPDATE-INTRANET T-Config.1b)", () => {
  it("T-Config.1b: no config.json on disk → readConfig returns updateServerUrl === the baked default", () => {
    // Given: no config.json on disk at all (fresh install — exercises DEFAULT_CONFIG_V2 via
    //        migrateTelegramIntoConfig(), same code path T-Lang.2 uses for `language`)
    // When:  readConfig(path)
    // Then:  result.updateServerUrl === "http://192.0.2.105:4875"
    const { configPath, cleanup } = makeTmpDir();
    try {
      const result = readConfig(configPath);
      assert.equal(result.updateServerUrl, DEFAULT_UPDATE_SERVER_URL);
    } finally {
      cleanup();
    }
  });
});

// ─── T-Config.1c ─────────────────────────────────────────────────────────────

describe("readConfig — a v1→v2-migrated config also yields the baked default (P-UPDATE-INTRANET T-Config.1c)", () => {
  it("T-Config.1c: a v1 config.json (schema_version:1, never carried updateServerUrl) migrated to v2 → updateServerUrl === the baked default", () => {
    // Given: a v1 config.json on disk (schema_version:1 — v1 never had an updateServerUrl field)
    // When:  readConfig(path) — triggers migrateV1toV2 + persists the migrated v2 config
    // Then:  the migrated result carries updateServerUrl === "http://192.0.2.105:4875" (not null)
    const { configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, JSON.stringify({ schema_version: 1 }), "utf-8");
      const result = readConfig(configPath);
      assert.equal(result.schema_version, 2, "v1 config is migrated to v2 on read");
      assert.equal(
        result.updateServerUrl,
        DEFAULT_UPDATE_SERVER_URL,
        "v1→v2 migration map must bake the default, not null (v1 configs never carried the field)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-Config.2 (regression pin) ────────────────────────────────────────────

describe("readConfig — explicit null updateServerUrl on disk STAYS null (P-UPDATE-INTRANET T-Config.2, already-green pin)", () => {
  it("T-Config.2: writeConfig({..., updateServerUrl: null}) then readConfig returns updateServerUrl === null (explicit clear preserved — default only fills ABSENT)", () => {
    // Given: a ConfigJsonV2 with updateServerUrl EXPLICITLY null, written via writeConfig
    // When:  readConfig(path)
    // Then:  result.updateServerUrl === null verbatim — the field stays nullable (`.default()` only
    //        fills an ABSENT key, never overrides an explicit null) so the operator "clear the
    //        field to disable auto-update" path is preserved
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
          language: "auto",
        },
        configPath,
      );
      const result = readConfig(configPath);
      assert.equal(result.updateServerUrl, null);
    } finally {
      cleanup();
    }
  });
});

// ─── T-Config.3 (regression pin) ────────────────────────────────────────────

describe("readConfig — explicit override updateServerUrl round-trips unchanged (P-UPDATE-INTRANET T-Config.3, already-green pin)", () => {
  it("T-Config.3: writeConfig({..., updateServerUrl:'http://other:9999'}) then readConfig returns the override verbatim", () => {
    // Given: a ConfigJsonV2 with an explicit override updateServerUrl, written via writeConfig
    // When:  readConfig(path)
    // Then:  result.updateServerUrl === "http://other:9999" (operator override untouched by the default change)
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
          updateServerUrl: "http://other:9999",
          language: "auto",
        },
        configPath,
      );
      const result = readConfig(configPath);
      assert.equal(result.updateServerUrl, "http://other:9999");
    } finally {
      cleanup();
    }
  });
});
