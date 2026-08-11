import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig, writeConfig, writeTelegramConfigFields } from "../../src/persistence/config.js";
import {
  DEFAULT_TELEGRAM_CONFIG,
  readTelegramConfig,
  writeTelegramConfig,
} from "../../src/persistence/telegramConfig.js";
import { cleanupTmpDir, makeTmpDir } from "../_helpers/tmp";

function paths() {
  const dir = makeTmpDir("frondose-config-current");
  return { dir, config: join(dir, "config.json"), telegram: join(dir, "telegram.json") };
}

describe("current schema-v2 config", () => {
  it("T-CONFIG.1: missing config returns current defaults without writing", () => {
    // Given no config; When read; Then current defaults return in memory without disk mutation.
    const p = paths();
    try {
      const result = readConfig(p.config);
      assert.equal(result.schema_version, 2);
      assert.equal(result.telegram.enabled, false);
      assert.equal(existsSync(p.config), false);
    } finally {
      cleanupTmpDir(p.dir);
    }
  });

  it("T-CONFIG.2: minimal current config fills every current default", () => {
    // Given minimal schema v2; When read; Then current nested defaults are populated.
    const p = paths();
    try {
      writeFileSync(p.config, JSON.stringify({ schema_version: 2 }), "utf8");
      const result = readConfig(p.config);
      assert.equal(result.server.rest_port, 3031);
      assert.equal(result.worker.input_mode, "cdp");
      assert.equal(result.auto.intervalMinutes, 15);
    } finally {
      cleanupTmpDir(p.dir);
    }
  });

  it("T-CONFIG.3: writeConfig uses tmp plus rename and round-trips", () => {
    // Given a current config; When written; Then JSON round-trips and no tmp remains.
    const p = paths();
    try {
      const cfg = readConfig(p.config);
      writeConfig(cfg, p.config);
      assert.deepEqual(readConfig(p.config), cfg);
      assert.equal(existsSync(`${p.config}.tmp`), false);
      assert.notEqual(statSync(p.config).mode & 0o777, 0o600);
    } finally {
      cleanupTmpDir(p.dir);
    }
  });
});

describe("Telegram runtime state stays separate from config-level settings", () => {
  it("T-TG.SPLIT.READ.1: runtime offset and current config fields merge", () => {
    // Given current config fields and Telegram runtime offset; When read; Then both projections merge.
    const p = paths();
    try {
      writeConfig({ ...readConfig(p.config), telegram: { enabled: true, boundUserId: 42, proxyUrl: null } }, p.config);
      writeFileSync(
        p.telegram,
        JSON.stringify({
          lastUpdateOffset: 7,
          stickyFallbackIp: null,
          pollTimeoutSec: 30,
          pollBackoffSec: 5,
          lastReceivedAt: null,
        }),
        "utf8",
      );
      const result = readTelegramConfig(p.telegram, p.config);
      assert.equal(result.enabled, true);
      assert.equal(result.boundUserId, 42);
      assert.equal(result.lastUpdateOffset, 7);
    } finally {
      cleanupTmpDir(p.dir);
    }
  });

  it("T-TG.SPLIT.WRITE.1: config-field write leaves runtime bytes untouched", () => {
    // Given current config and runtime bytes; When enabled changes; Then only config changes.
    const p = paths();
    try {
      writeConfig(readConfig(p.config), p.config);
      const runtime = JSON.stringify({ lastUpdateOffset: 3 });
      writeFileSync(p.telegram, runtime, "utf8");
      writeTelegramConfigFields({ enabled: true }, p.config);
      assert.equal(readConfig(p.config).telegram.enabled, true);
      assert.equal(readFileSync(p.telegram, "utf8"), runtime);
    } finally {
      cleanupTmpDir(p.dir);
    }
  });

  it("T-TG.SPLIT.WRITE.2: runtime write excludes config-level fields", () => {
    // Given a merged Telegram view; When runtime writes; Then config fields are absent from runtime JSON.
    const p = paths();
    try {
      writeTelegramConfig(
        { ...DEFAULT_TELEGRAM_CONFIG, enabled: true, boundUserId: 42, lastUpdateOffset: 100 },
        p.telegram,
      );
      const runtime = JSON.parse(readFileSync(p.telegram, "utf8")) as Record<string, unknown>;
      assert.equal(runtime.lastUpdateOffset, 100);
      assert.equal(runtime.enabled, undefined);
      assert.equal(runtime.boundUserId, undefined);
    } finally {
      cleanupTmpDir(p.dir);
    }
  });
});
