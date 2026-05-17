/**
 * P-24 Step 5 — config.ts + telegram config split assertions
 *
 * Test names follow BDD-light: "T-Component.N: when <preconditions>, <action> → <expected>"
 * Assertion bodies filled at Step 5.
 *
 * Gate coverage:
 *   G-P24.4 — T-CONFIG.1, T-CONFIG.2, T-MIGRATE.TELEGRAM.1, T-MIGRATE.TELEGRAM.2, T-TG.SPLIT.READ.1, T-TG.PROXY.MIGRATE.1
 *   G-P24.5 — T-CONFIG.3, T-TG.SPLIT.WRITE.2
 *   G-P24.6 — T-TG.SPLIT.WRITE.1
 *   G-P24.8 — T-CONFIG.1, T-CONFIG.2
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  migrateTelegramIntoConfig,
  readConfig,
  writeConfig,
  writeTelegramConfigFields,
} from "../../src/persistence/config.js";
import {
  DEFAULT_TELEGRAM_CONFIG,
  readTelegramConfig,
  writeTelegramConfig,
} from "../../src/persistence/telegramConfig.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "mai-p24-config-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    tcPath: join(dir, "telegram.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── T-CONFIG.1 ──────────────────────────────────────────────────────────────

describe("readConfig — missing file → full default shape (G-P24.8)", () => {
  it("T-CONFIG.1: when no config.json on disk (no legacy telegram.json either), readConfig returns default {schema_version:1, server:{url:null}, worker:{...null}, telegram:{...false}}", () => {
    // Given: config.json does not exist; no telegram.json (HOME points to empty tmpDir)
    // When:  readConfig(configPath)
    // Then:  returns {schema_version:1, server:{url:null}, worker:{id:null,hostname:null,label:null},
    //        telegram:{enabled:false,boundUserId:null,proxyUrl:null}}; no file written
    const { dir, configPath, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    try {
      // HOME → tmpDir so migrateTelegramIntoConfig finds no telegram.json
      process.env.HOME = dir;
      const result = readConfig(configPath);
      assert.equal(result.schema_version, 2, "T-CONFIG.1: schema_version must be 2 (P-28: DEFAULT_CONFIG_V2)"); // P-28 update: default is v2
      assert.deepEqual(result.server, { url: null, bind_address: null, poll_interval_s: 30, web_port: 8090 }, "T-CONFIG.1: server must be {url:null, bind_address:null, poll_interval_s:30, web_port:8090} (P-29 adds web_port default:8090)");
      assert.deepEqual(result.worker, { id: null, hostname: null, label: null, input_mode: "cdp" }, "T-CONFIG.1: worker must be all-null with input_mode default");
      assert.deepEqual(
        result.telegram,
        { enabled: false, boundUserId: null, proxyUrl: null },
        "T-CONFIG.1: telegram must be all-default",
      );
      assert.ok(!existsSync(configPath), "T-CONFIG.1: no config.json must be written when all telegram fields are default");
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      cleanup();
    }
  });
});

// ─── T-CONFIG.2 ──────────────────────────────────────────────────────────────

describe("readConfig — minimal {schema_version:1} → Zod fills defaults (G-P24.8)", () => {
  it("T-CONFIG.2: when config.json contains minimal {schema_version:1}, readConfig returns fully-populated default tree", () => {
    // Given: config.json = '{"schema_version":1}'
    // When:  readConfig(configPath)
    // Then:  returns full default tree with server:{url:null}, worker:{...}, telegram:{...}
    const { configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, JSON.stringify({ schema_version: 1 }), "utf-8");
      const result = readConfig(configPath);
      assert.equal(result.schema_version, 2, "T-CONFIG.2: schema_version must be 2 (P-28: v1 file migrated to v2)"); // P-28 update: v1 input → v2 output after migration
      assert.deepEqual(result.server, { url: null, bind_address: null, poll_interval_s: 30, web_port: 8090 }, "T-CONFIG.2: server default must be {url:null, bind_address:null, poll_interval_s:30, web_port:8090} (P-29 adds web_port default:8090)");
      assert.deepEqual(result.worker, { id: null, hostname: null, label: null, input_mode: "cdp" }, "T-CONFIG.2: worker default must be all-null with input_mode default");
      assert.deepEqual(
        result.telegram,
        { enabled: false, boundUserId: null, proxyUrl: null },
        "T-CONFIG.2: telegram default must be all-false/null",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONFIG.3 ──────────────────────────────────────────────────────────────

describe("writeConfig — tmp+rename; no chmod (G-P24.5)", () => {
  it("T-CONFIG.3: when writeConfig(cfg, path) called, file written via tmp+rename; no chmod 0o600 (config has no secrets)", () => {
    // Given: valid ConfigJson; fresh tmp dir (config.json pre-written to avoid migration)
    // When:  writeConfig called
    // Then:  path exists; .tmp artifact gone; mode is NOT 0o600 (umask-derived); JSON round-trips
    const { configPath, cleanup } = makeTmpDir();
    try {
      // Pre-write minimal config so readConfig reads directly (no migration HOME pollution)
      writeFileSync(configPath, JSON.stringify({ schema_version: 1 }), "utf-8");
      const cfg = readConfig(configPath);
      writeConfig(cfg, configPath);

      assert.ok(existsSync(configPath), "T-CONFIG.3: config.json must exist after writeConfig");
      assert.ok(!existsSync(configPath + ".tmp"), "T-CONFIG.3: .tmp artifact must be gone");
      const mode = statSync(configPath).mode & 0o777;
      assert.notEqual(mode, 0o600, `T-CONFIG.3: config.json mode must NOT be 0o600 (umask-derived); got ${mode.toString(8)}`);
      assert.deepEqual(
        JSON.parse(readFileSync(configPath, "utf-8")),
        JSON.parse(JSON.stringify(cfg)),
        "T-CONFIG.3: JSON must round-trip (JSON.parse(JSON.stringify) normalizes away any undefined own properties such as identity:undefined from v1→v2 migration)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-TG.SPLIT.READ.1 ───────────────────────────────────────────────────────

describe("readTelegramConfig split — merges runtime + config.json.telegram (G-P24.4)", () => {
  it("T-TG.SPLIT.READ.1: when telegram.json has runtime fields and config.json.telegram has {enabled:true, boundUserId:42, proxyUrl:null}, readTelegramConfig returns merged TelegramConfig", () => {
    // Given: telegram.json = {lastUpdateOffset:7, stickyFallbackIp:null, pollTimeoutSec:30, pollBackoffSec:5, lastReceivedAt:null}
    //        config.json = {schema_version:1, telegram:{enabled:true, boundUserId:42, proxyUrl:null}, ...}
    // When:  readTelegramConfig(tcPath, configPath)
    // Then:  result.enabled === true; result.boundUserId === 42; result.lastUpdateOffset === 7
    //        shape matches pre-P-24 TelegramConfig (backward-compat)
    const { tcPath, configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        tcPath,
        JSON.stringify({
          lastUpdateOffset: 7,
          stickyFallbackIp: null,
          pollTimeoutSec: 30,
          pollBackoffSec: 5,
          lastReceivedAt: null,
        }),
        "utf-8",
      );
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 1,
          server: { url: null },
          worker: { id: null, hostname: null, label: null },
          telegram: { enabled: true, boundUserId: 42, proxyUrl: null },
        }),
        "utf-8",
      );
      const result = readTelegramConfig(tcPath, configPath);
      assert.equal(result.enabled, true, "T-TG.SPLIT.READ.1: enabled must be true (from config.json)");
      assert.equal(result.boundUserId, 42, "T-TG.SPLIT.READ.1: boundUserId must be 42 (from config.json)");
      assert.equal(result.lastUpdateOffset, 7, "T-TG.SPLIT.READ.1: lastUpdateOffset must be 7 (from telegram.json)");
      assert.equal(result.proxyUrl, null, "T-TG.SPLIT.READ.1: proxyUrl must be null");
      // Shape-check: all TelegramConfig fields present (backward-compat)
      assert.ok("pollTimeoutSec" in result, "T-TG.SPLIT.READ.1: pollTimeoutSec must be present");
      void DEFAULT_TELEGRAM_CONFIG; // reference export used in other tests
    } finally {
      cleanup();
    }
  });
});

// ─── T-TG.SPLIT.WRITE.1 ──────────────────────────────────────────────────────

describe("writeTelegramConfigFields — writes config.json; telegram.json untouched (G-P24.5 + G-P24.6)", () => {
  it("T-TG.SPLIT.WRITE.1: when writeTelegramConfigFields({enabled:true}, configPath) called, config.json updated; telegram.json untouched", () => {
    // Given: existing config.json with telegram:{enabled:false,...}; existing telegram.json
    // When:  writeTelegramConfigFields({enabled:true}, configPath)
    // Then:  config.json.telegram.enabled === true; telegram.json content unchanged
    const { tcPath, configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 1,
          server: { url: null },
          worker: { id: null, hostname: null, label: null },
          telegram: { enabled: false, boundUserId: null, proxyUrl: null },
        }),
        "utf-8",
      );
      const tcContent = JSON.stringify({ lastUpdateOffset: 3, stickyFallbackIp: null, pollTimeoutSec: 30, pollBackoffSec: 5, lastReceivedAt: null });
      writeFileSync(tcPath, tcContent, "utf-8");

      writeTelegramConfigFields({ enabled: true }, configPath);

      // config.json must be updated
      const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as { telegram: { enabled: boolean } };
      assert.equal(cfg.telegram.enabled, true, "T-TG.SPLIT.WRITE.1: config.json.telegram.enabled must be true");
      // telegram.json must be untouched
      assert.equal(readFileSync(tcPath, "utf-8"), tcContent, "T-TG.SPLIT.WRITE.1: telegram.json must be unchanged");
    } finally {
      cleanup();
    }
  });
});

// ─── T-TG.SPLIT.WRITE.2 ──────────────────────────────────────────────────────

describe("writeTelegramConfig — writes runtime fields to telegram.json only; config.json untouched (G-P24.5)", () => {
  it("T-TG.SPLIT.WRITE.2: when writeTelegramConfig(cfg, tcPath) called with lastUpdateOffset=100, telegram.json reflects offset; config.json untouched", () => {
    // Given: config.json with telegram:{enabled:true, boundUserId:42, proxyUrl:null}
    //        writeTelegramConfig called with lastUpdateOffset:100
    // When:  write completes
    // Then:  telegram.json.lastUpdateOffset === 100; config.json.telegram UNCHANGED (no enabled/boundUserId in telegram.json)
    const { tcPath, configPath, cleanup } = makeTmpDir();
    try {
      const origCfgContent = JSON.stringify({
        schema_version: 1,
        server: { url: null },
        worker: { id: null, hostname: null, label: null },
        telegram: { enabled: true, boundUserId: 42, proxyUrl: null },
      });
      writeFileSync(configPath, origCfgContent, "utf-8");

      const runtimeCfg = {
        ...DEFAULT_TELEGRAM_CONFIG,
        enabled: true,
        boundUserId: 42,
        proxyUrl: null,
        lastUpdateOffset: 100,
      };
      writeTelegramConfig(runtimeCfg, tcPath);

      // telegram.json must have the new offset
      const tcWritten = JSON.parse(readFileSync(tcPath, "utf-8")) as Record<string, unknown>;
      assert.equal(tcWritten.lastUpdateOffset, 100, "T-TG.SPLIT.WRITE.2: lastUpdateOffset must be 100 in telegram.json");
      // telegram.json must NOT have config-level fields
      assert.equal(tcWritten.enabled, undefined, "T-TG.SPLIT.WRITE.2: telegram.json must NOT have enabled field");
      assert.equal(tcWritten.boundUserId, undefined, "T-TG.SPLIT.WRITE.2: telegram.json must NOT have boundUserId field");
      assert.equal(tcWritten.proxyUrl, undefined, "T-TG.SPLIT.WRITE.2: telegram.json must NOT have proxyUrl field");
      // config.json must be untouched
      assert.equal(readFileSync(configPath, "utf-8"), origCfgContent, "T-TG.SPLIT.WRITE.2: config.json must be unchanged");
    } finally {
      cleanup();
    }
  });
});

// ─── T-TG.PROXY.MIGRATE.1 ────────────────────────────────────────────────────

describe("migrateTelegramIntoConfig — migrates proxyUrl from legacy telegram.json (G-P24.4)", () => {
  it("T-TG.PROXY.MIGRATE.1: when pre-P-24 telegram.json has proxyUrl='http://127.0.0.1:7890', migrateTelegramIntoConfig(tcPath) returns ConfigJson with telegram.proxyUrl set", () => {
    // Given: telegram.json with {enabled:false, boundUserId:null, proxyUrl:'http://127.0.0.1:7890', lastUpdateOffset:0, ...}
    //        config.json absent
    // When:  migrateTelegramIntoConfig(tcPath) called directly with tcPath injection
    // Then:  returned ConfigJson.telegram.proxyUrl === 'http://127.0.0.1:7890'
    const { tcPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        tcPath,
        JSON.stringify({
          enabled: false,
          boundUserId: null,
          proxyUrl: "http://127.0.0.1:7890",
          lastUpdateOffset: 0,
          stickyFallbackIp: null,
          pollTimeoutSec: 30,
          pollBackoffSec: 5,
          lastReceivedAt: null,
        }),
        "utf-8",
      );
      const migrated = migrateTelegramIntoConfig(tcPath);
      assert.equal(
        migrated.telegram.proxyUrl,
        "http://127.0.0.1:7890",
        "T-TG.PROXY.MIGRATE.1: proxyUrl must be carried from telegram.json",
      );
      assert.equal(migrated.telegram.enabled, false, "T-TG.PROXY.MIGRATE.1: enabled must be false");
      assert.equal(migrated.telegram.boundUserId, null, "T-TG.PROXY.MIGRATE.1: boundUserId must be null");
    } finally {
      cleanup();
    }
  });
});
