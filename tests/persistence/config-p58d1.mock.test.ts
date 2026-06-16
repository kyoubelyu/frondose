/**
 * P-58d.1 Step 4a — T-UpdCfg.1–4 — [Step 5: assertion bodies FILLED]
 *
 * Config persistence contract for the new `updateServerUrl` additive-optional field (plan §6.4-F3):
 * - LENIENT at persistence: z.string().trim().nullable().default(null), NO .url() — a hand-edit
 *   typo in this one field must NEVER reset the rest of config.json to DEFAULT_CONFIG_V2.
 * - URL-shape validation lives ONLY at: the Settings write path (serve/settings.ts settingsPatchSchema)
 *   + the Rust endpoint.parse() guard.
 * - Additive-optional: old v2 configs without the key Zod-fill null (no schema_version bump).
 * - .trim(): stray whitespace around the URL is stripped on read.
 *
 * Gate coverage: G-P58d.1.1 (T-UpdCfg.1–4 — round-trip + backward-compat + null-valid + CMR-1 leniency).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/config-p58d1.mock.test.ts
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
  const dir = mkdtempSync(join(tmpdir(), "mai-p58d1-cfg-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

// ─── T-UpdCfg.1 ──────────────────────────────────────────────────────────────

describe("readConfig — updateServerUrl round-trip (G-P58d.1.1)", () => {
  // Given: a ConfigJsonV2 with updateServerUrl "http://192.168.1.50:8765" written via writeConfig(cfg, path)
  // When:  readConfig(path)
  // Then:  result.updateServerUrl === "http://192.168.1.50:8765" (field preserved verbatim)
  it("T-UpdCfg.1: when config is written with updateServerUrl 'http://192.168.1.50:8765', readConfig returns it verbatim", () => {
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
          updateServerUrl: "http://192.168.1.50:8765",
        },
        configPath,
      );
      const result = readConfig(configPath);
      assert.equal(result.updateServerUrl, "http://192.168.1.50:8765");
    } finally {
      cleanup();
    }
  });
});

// ─── T-UpdCfg.2 ──────────────────────────────────────────────────────────────

describe("readConfig — backward-compat: v2 config missing updateServerUrl → null, no v1→v2 migration, no field wipe (G-P58d.1.1)", () => {
  // Given: config.json with schema_version:2 AND NO updateServerUrl key, but populated server/telegram/soul fields
  // When:  readConfig(path)
  // Then:  result.updateServerUrl === null (Zod default)
  //        AND result.schema_version === 2 (no v1→v2 migration fired — the file is already v2)
  //        AND result.server / result.telegram / result.soul are preserved byte-for-byte (NOT wiped to DEFAULT_CONFIG_V2)
  it("T-UpdCfg.2: old v2 config without updateServerUrl → null; schema_version stays 2; server/telegram/soul fields preserved unchanged", () => {
    const { configPath, cleanup } = makeTmpDir();
    try {
      // Write raw JSON WITHOUT updateServerUrl key (simulates a pre-P-58d.1 v2 config)
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 2,
          server: {
            url: "http://myserver:8080",
            bind_address: null,
            poll_interval_s: 45,
            web_port: 8090,
            ssh_user: null,
            ssh_port: 22,
            rest_port: 3031,
          },
          worker: { id: "w1", hostname: "myhost", label: null, input_mode: "cdp" },
          telegram: { enabled: true, boundUserId: 12345, proxyUrl: null },
          soul: { override: "my-soul" },
          // NO updateServerUrl key
        }),
        "utf-8",
      );
      const result = readConfig(configPath);
      assert.equal(result.updateServerUrl, null, "absent key → Zod fills default(null)");
      assert.equal(result.schema_version, 2, "schema_version stays 2 — no v1→v2 migration triggered");
      assert.equal(result.server.url, "http://myserver:8080", "server.url preserved");
      assert.equal(result.server.poll_interval_s, 45, "server.poll_interval_s preserved (non-default value)");
      assert.equal(result.telegram.enabled, true, "telegram.enabled preserved");
      assert.equal(result.telegram.boundUserId, 12345, "telegram.boundUserId preserved");
      assert.equal(result.soul.override, "my-soul", "soul.override preserved");
    } finally {
      cleanup();
    }
  });
});

// ─── T-UpdCfg.3 ──────────────────────────────────────────────────────────────

describe("readConfig — updateServerUrl: null is valid and safe (G-P58d.1.1)", () => {
  // Given: config.json with updateServerUrl: null (explicit null — updater disabled)
  // When:  readConfig(path)
  // Then:  result.updateServerUrl === null (no stderr warning, no fallback to DEFAULT_CONFIG_V2)
  it("T-UpdCfg.3: explicit updateServerUrl:null in config.json → readConfig returns null cleanly (no warning, no wipe)", () => {
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
          soul: { override: "sentinel-no-wipe" }, // sentinel: would be null if wiped to DEFAULT_CONFIG_V2
          updateServerUrl: null,
        }),
        "utf-8",
      );
      const result = readConfig(configPath);
      assert.equal(result.updateServerUrl, null, "explicit null is valid and returned cleanly");
      assert.equal(
        result.soul.override,
        "sentinel-no-wipe",
        "soul.override NOT reset to null (NOT wiped to DEFAULT_CONFIG_V2)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-UpdCfg.4 ──────────────────────────────────────────────────────────────

describe("readConfig — malformed updateServerUrl string PRESERVED verbatim, no whole-config wipe (CMR-1) (G-P58d.1.1)", () => {
  // Given: config.json (schema_version:2) with updateServerUrl:"not-a-url" (a hand-edit typo, but a string)
  //        AND populated server/telegram/identity/soul fields (values distinct from DEFAULT_CONFIG_V2)
  // When:  readConfig(path)
  // Then:  result.updateServerUrl === "not-a-url" (persistence schema is z.string().trim().nullable() — NO .url();
  //          the typo is kept verbatim, never validated here)
  //        AND result.server / result.telegram / result.soul are preserved unchanged
  //        AND the result is NOT DEFAULT_CONFIG_V2 (no whole-config wipe — the CMR-1 guarantee)
  //
  // ALSO assert .trim(): "  http://h:1  " (leading + trailing spaces) → "http://h:1" (whitespace stripped on parse)
  it("T-UpdCfg.4: malformed updateServerUrl 'not-a-url' is kept verbatim (CMR-1: lenient no-.url() schema, no whole-config wipe); '  http://h:1  ' → trimmed 'http://h:1'", () => {
    const { configPath, cleanup } = makeTmpDir();
    try {
      // (a) malformed URL string — must be kept verbatim with no whole-config wipe
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 2,
          server: {
            url: "http://real-server:9000",
            bind_address: null,
            poll_interval_s: 60,
            web_port: 8090,
            ssh_user: null,
            ssh_port: 22,
            rest_port: 3031,
          },
          worker: { id: null, hostname: null, label: null, input_mode: "cdp" },
          telegram: { enabled: false, boundUserId: null, proxyUrl: null },
          soul: { override: "sentinel-cmr1" },
          updateServerUrl: "not-a-url",
        }),
        "utf-8",
      );
      const resultA = readConfig(configPath);
      assert.equal(resultA.updateServerUrl, "not-a-url", "malformed URL string preserved verbatim (no .url() guard)");
      assert.equal(resultA.server.url, "http://real-server:9000", "server.url NOT wiped — CMR-1 guarantee");
      assert.equal(resultA.server.poll_interval_s, 60, "server.poll_interval_s NOT wiped (distinct from DEFAULT 30)");
      assert.equal(
        resultA.soul.override,
        "sentinel-cmr1",
        "soul.override NOT wiped to DEFAULT_CONFIG_V2 null — whole-config reset did NOT occur",
      );

      // (b) leading + trailing whitespace → trimmed by z.string().trim()
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
          soul: { override: null },
          updateServerUrl: "  http://h:1  ",
        }),
        "utf-8",
      );
      const resultB = readConfig(configPath);
      assert.equal(resultB.updateServerUrl, "http://h:1", ".trim() strips leading + trailing whitespace");
    } finally {
      cleanup();
    }
  });
});
