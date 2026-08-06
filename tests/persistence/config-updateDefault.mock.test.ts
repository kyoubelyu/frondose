/**
 * P-OPEN-SOURCE-SPLIT adopted config persistence contract.
 *
 * The public App changes the absent/fresh/migrated updater default, so the old
 * P-UPDATE-INTRANET default-value assertions are intentionally retired. These
 * tests preserve the stable schema behavior: explicit null disables updates
 * and an explicit operator URL round-trips unchanged.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/config-updateDefault.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig, writeConfig } from "../../src/persistence/config.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "frondose-p-update-intranet-cfg-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

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
