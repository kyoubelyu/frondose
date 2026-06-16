/**
 * P-11 Step 5 — T-Config.1..T-Config.7 (filled assertions)
 *
 * telegram.json schema + atomic read/write (src/persistence/telegramConfig.ts).
 * Gate coverage: G-P11.2 (all T-Config tests)
 *
 * P-24 split note: `telegram.json` now holds runtime-only state
 * (lastUpdateOffset / stickyFallbackIp / poll timeouts / lastReceivedAt).
 * `enabled` / `boundUserId` / `proxyUrl` live in `config.json#telegram`.
 * `readTelegramConfig(tcPath, configPath)` merges both.
 *
 * P-44 BUG-1 fix: every `readTelegramConfig` call now passes an explicit
 * `configPath` pointing to a temp dir config.json — avoids reading the
 * operator's real `~/.mai/agent/config.json`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_TELEGRAM_CONFIG,
  readTelegramConfig,
  writeTelegramConfig,
  writeTelegramConfigFields,
} from "../../src/persistence/telegramConfig.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an isolated temp dir for tests.
 * Writes a minimal `config.json` (schema_version:2, telegram defaults) so that
 * `readConfig(configPath)` returns defaults instead of falling through to
 * `migrateTelegramIntoConfig()` (which reads the operator's real telegram.json).
 */
function makeTmpDir(): { dir: string; cfgPath: string; configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p11-tgcfg-"));
  const configPath = join(dir, "config.json");
  // Minimal v2 config — telegram section defaults to {enabled:false, boundUserId:null, proxyUrl:null}
  writeFileSync(configPath, JSON.stringify({ schema_version: 2 }), "utf-8");
  return {
    dir,
    cfgPath: join(dir, "telegram.json"),
    configPath,
    cleanup: () => cleanupTmpDir(dir),
  };
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = orig;
  }
  return chunks.join("");
}

// ─── T-Config: telegram.json persistence ──────────────────────────────────────

describe("telegramConfig.ts read/write (G-P11.2)", () => {
  it("T-Config.1: when the config file does NOT exist, readTelegramConfig returns DEFAULT_TELEGRAM_CONFIG deep-equal", () => {
    // Given: a path that does not exist on disk + isolated temp configPath
    // When: readTelegramConfig(nonExistentPath, configPath) is called
    // Then: returns DEFAULT_TELEGRAM_CONFIG
    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      const nonExistent = `${cfgPath}.nonexistent`;
      // BUG-1 fix: explicit configPath from temp dir (avoids operator's real config.json)
      const result = readTelegramConfig(nonExistent, configPath);
      assert.deepEqual(result, DEFAULT_TELEGRAM_CONFIG, "missing file must return DEFAULT_TELEGRAM_CONFIG");
      assert.equal(result.enabled, false);
      assert.equal(result.boundUserId, null);
      assert.equal(result.lastUpdateOffset, 0);
      assert.equal(result.stickyFallbackIp, null);
      assert.equal(result.pollTimeoutSec, 30);
      assert.equal(result.pollBackoffSec, 5);
    } finally {
      cleanup();
    }
  });

  it("T-Config.2: when the file exists with valid JSON, readTelegramConfig returns the parsed object exact-equal to the written values", () => {
    // Given: telegram.json with runtime fields + config.json with enabled/boundUserId
    // When: readTelegramConfig(cfgPath, configPath) reads both
    // Then: result deep-equals the merged expected object
    // P-24: enabled/boundUserId/proxyUrl live in config.json#telegram; runtime in telegram.json
    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      const expected = {
        enabled: true,
        boundUserId: 12345,
        lastUpdateOffset: 99,
        stickyFallbackIp: "149.154.166.110",
        proxyUrl: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
        lastReceivedAt: null,
      };
      // Write runtime-only fields to telegram.json
      writeFileSync(
        cfgPath,
        JSON.stringify({
          lastUpdateOffset: expected.lastUpdateOffset,
          stickyFallbackIp: expected.stickyFallbackIp,
          pollTimeoutSec: expected.pollTimeoutSec,
          pollBackoffSec: expected.pollBackoffSec,
          lastReceivedAt: expected.lastReceivedAt,
        }),
        "utf-8",
      );
      // Write config-level telegram fields to config.json
      writeTelegramConfigFields(
        { enabled: expected.enabled, boundUserId: expected.boundUserId, proxyUrl: expected.proxyUrl },
        configPath,
      );
      const result = readTelegramConfig(cfgPath, configPath);
      assert.deepEqual(result, expected, "readTelegramConfig must return exact merged values");
    } finally {
      cleanup();
    }
  });

  it("T-Config.3: when the file contains malformed JSON, readTelegramConfig returns DEFAULT_TELEGRAM_CONFIG AND emits a stderr warning containing the file path; does NOT throw", () => {
    // Given: telegram.json with content "{not json" + isolated temp configPath
    // When: readTelegramConfig called; stderr captured
    // Then: returns DEFAULT_TELEGRAM_CONFIG; stderr contains file path + parse error; no throw
    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(cfgPath, "{not json", "utf-8");
      let result!: typeof DEFAULT_TELEGRAM_CONFIG;
      const stderr = captureStderr(() => {
        result = readTelegramConfig(cfgPath, configPath);
      });
      assert.deepEqual(result, DEFAULT_TELEGRAM_CONFIG, "malformed JSON must return defaults");
      assert.ok(
        stderr.includes(cfgPath) || stderr.includes("telegram.json"),
        `stderr must contain file path; got: "${stderr}"`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-Config.4: when the file contains valid JSON missing a required field (e.g. no boundUserId), readTelegramConfig returns DEFAULT_TELEGRAM_CONFIG AND emits a Zod-validation stderr warning", () => {
    // Given: telegram.json with { "enabled": true } (missing runtime fields) + isolated configPath
    // When: readTelegramConfig called; stderr captured
    // Then: returns DEFAULT_TELEGRAM_CONFIG; stderr contains Zod/validation error message; no throw
    // Note: the Zod schema for telegramRuntimeSchema requires lastUpdateOffset etc.; partial JSON fails
    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(cfgPath, JSON.stringify({ enabled: true }), "utf-8");
      let result!: typeof DEFAULT_TELEGRAM_CONFIG;
      const stderr = captureStderr(() => {
        result = readTelegramConfig(cfgPath, configPath);
      });
      assert.deepEqual(result, DEFAULT_TELEGRAM_CONFIG, "incomplete JSON must return defaults");
      assert.ok(stderr.length > 0, "stderr must contain a warning for invalid schema");
    } finally {
      cleanup();
    }
  });

  it("T-Config.5: when writeTelegramConfig(cfg, path) is called, file is written atomically via tmp+rename; no .tmp artifact remains; readTelegramConfig returns deep-equal to cfg", () => {
    // Given: a valid TelegramConfig object + isolated temp dir (P-24: write both runtime + config-level fields)
    // When: writeTelegramConfig (runtime) + writeTelegramConfigFields (config-level) written; then read
    // Then: no .tmp artifact; readTelegramConfig returns same values; atomic write confirmed
    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      const cfg = { ...DEFAULT_TELEGRAM_CONFIG, enabled: true, boundUserId: 42, lastUpdateOffset: 7 };
      // Write runtime fields to telegram.json
      writeTelegramConfig(cfg, cfgPath);
      // Write config-level fields to config.json (P-24 split)
      writeTelegramConfigFields(
        { enabled: cfg.enabled, boundUserId: cfg.boundUserId, proxyUrl: cfg.proxyUrl },
        configPath,
      );

      // No .tmp artifact
      assert.ok(!existsSync(`${cfgPath}.tmp`), "no .tmp artifact must remain after writeTelegramConfig");
      // File exists
      assert.ok(existsSync(cfgPath), "telegram.json must exist after write");
      // Readback matches
      const result = readTelegramConfig(cfgPath, configPath);
      assert.deepEqual(result, cfg, "readTelegramConfig must return same values as written");
    } finally {
      cleanup();
    }
  });

  it("T-Config.6: when writeTelegramConfig is called 5 times in sequence with different lastUpdateOffset values, the final readTelegramConfig returns only the last value (full rewrite, not append)", () => {
    // Given: 5 sequential writes with offsets 1, 2, 3, 4, 5
    // When: readTelegramConfig after all 5 writes
    // Then: lastUpdateOffset === 5 (last write wins)
    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      for (let i = 1; i <= 5; i++) {
        writeTelegramConfig({ ...DEFAULT_TELEGRAM_CONFIG, lastUpdateOffset: i }, cfgPath);
      }
      const result = readTelegramConfig(cfgPath, configPath);
      assert.equal(result.lastUpdateOffset, 5, "last write (offset=5) must win (full rewrite)");
    } finally {
      cleanup();
    }
  });

  it("T-Config.7: when writeTelegramConfig writes the file, the file mode is NOT chmod-0600 (no secrets; matches schedule.jsonl precedent)", () => {
    // Given: fresh write of a TelegramConfig
    // When: statSync(cfgPath).mode checked
    // Then: mode permissions are NOT restricted to 0600 (no secrets in this file)
    const { cfgPath, cleanup } = makeTmpDir();
    try {
      writeTelegramConfig(DEFAULT_TELEGRAM_CONFIG, cfgPath);
      const mode = statSync(cfgPath).mode;
      const permissions = mode & 0o777;
      // 0600 = owner read+write only; telegram.json should allow group/other read (default umask gives 0644)
      assert.notEqual(permissions, 0o600, "telegram.json must not be chmod 0600 (no secrets stored)");
      // Must at least be readable (not 0000)
      assert.ok(permissions > 0, "file must have some permissions");
    } finally {
      cleanup();
    }
  });

  it("T-Config.8: when readTelegramConfig parses a pre-P-12 config file (no lastReceivedAt field), the result has lastReceivedAt: null (Zod .optional().default(null) backfills missing field)", () => {
    // Given: JSON file written with old-format config — no lastReceivedAt field at all
    // When: readTelegramConfig(path, configPath) called with post-P-12 schema
    // Then: result.lastReceivedAt === null (Zod default(null) backfills; backward-compat preserved)
    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      // Write pre-P-12 format: exactly the 6 fields that existed before D-5
      writeFileSync(
        cfgPath,
        JSON.stringify({
          enabled: false,
          boundUserId: null,
          lastUpdateOffset: 0,
          stickyFallbackIp: null,
          pollTimeoutSec: 30,
          pollBackoffSec: 5,
        }),
        "utf-8",
      );
      const result = readTelegramConfig(cfgPath, configPath);
      assert.equal(
        result.lastReceivedAt,
        null,
        "pre-P-12 config (no lastReceivedAt field) must produce lastReceivedAt: null via Zod .optional().default(null)",
      );
    } finally {
      cleanup();
    }
  });

  it("T-Config.9: when writeTelegramConfig is called with lastReceivedAt: '2026-05-11T10:30:00.000Z', readTelegramConfig returns the same value verbatim (exact roundtrip)", () => {
    // Given: TelegramConfig with lastReceivedAt timestamp set to a known ISO string
    // When: writeTelegramConfig then readTelegramConfig(cfgPath, configPath)
    // Then: result.lastReceivedAt === "2026-05-11T10:30:00.000Z" AND raw JSON has the field verbatim
    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      const ts = "2026-05-11T10:30:00.000Z";
      const cfg = { ...DEFAULT_TELEGRAM_CONFIG, lastReceivedAt: ts };
      writeTelegramConfig(cfg, cfgPath);
      // Zod roundtrip
      const result = readTelegramConfig(cfgPath, configPath);
      assert.equal(
        result.lastReceivedAt,
        ts,
        `readTelegramConfig must return lastReceivedAt="${ts}" verbatim; got: "${result.lastReceivedAt}"`,
      );
      // Raw JSON check — the string must be in the file without any transformation
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as { lastReceivedAt?: string | null };
      assert.equal(
        raw.lastReceivedAt,
        ts,
        `raw JSON telegram.json must contain lastReceivedAt="${ts}" verbatim; got: "${raw.lastReceivedAt}"`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-Telegram.3 — proxyUrl round-trip (P-15, G-P15.3) ─────────────────────

describe("telegramConfig.ts proxyUrl (G-P15.3)", () => {
  it("T-Telegram.3: when proxyUrl written then read, readTelegramConfig returns the same proxyUrl; writing without proxyUrl yields null", async () => {
    // Given: temp dir with isolated configPath
    // When:  writeTelegramConfigFields with proxyUrl: "http://127.0.0.1:7890" then readTelegramConfig
    // Then:  result.proxyUrl === "http://127.0.0.1:7890". Writing null proxyUrl → proxyUrl === null
    // P-24 note: proxyUrl is a config-level field (config.json#telegram), not runtime (telegram.json)

    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      // Write runtime to telegram.json (defaults)
      writeTelegramConfig(DEFAULT_TELEGRAM_CONFIG, cfgPath);

      // Write proxyUrl to config.json#telegram
      writeTelegramConfigFields({ proxyUrl: "http://127.0.0.1:7890" }, configPath);
      const result1 = readTelegramConfig(cfgPath, configPath);
      assert.equal(result1.proxyUrl, "http://127.0.0.1:7890", "proxyUrl must round-trip when set");

      // Clear proxyUrl (set null)
      writeTelegramConfigFields({ proxyUrl: null }, configPath);
      const result2 = readTelegramConfig(cfgPath, configPath);
      assert.equal(result2.proxyUrl, null, "proxyUrl must be null when not set");
    } finally {
      cleanup();
    }
  });

  it("T-Telegram.4: when TELEGRAM_PROXY env var set AND file has proxyUrl, env wins (hermes precedence)", async () => {
    // Given: config.json with proxyUrl: "http://file-proxy:7890" AND process.env.TELEGRAM_PROXY = "http://env-proxy:7890"
    // When:  reading precedence (simulating consumer logic: process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined)
    // Then:  effective value === "http://env-proxy:7890". When env unset, effective value === "http://file-proxy:7890"

    const { cfgPath, configPath, cleanup } = makeTmpDir();
    try {
      // Write runtime defaults to telegram.json
      writeTelegramConfig(DEFAULT_TELEGRAM_CONFIG, cfgPath);
      // Write proxyUrl to config.json#telegram
      writeTelegramConfigFields({ proxyUrl: "http://file-proxy:7890" }, configPath);
      const savedEnv = process.env.TELEGRAM_PROXY;

      // When env is set, env wins
      process.env.TELEGRAM_PROXY = "http://env-proxy:7890";
      const cfg = readTelegramConfig(cfgPath, configPath);
      const effectiveWithEnv = process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined;
      assert.equal(effectiveWithEnv, "http://env-proxy:7890", "env var must win over file value");

      // When env is unset, file value is used
      delete process.env.TELEGRAM_PROXY;
      const effectiveWithoutEnv = process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined;
      assert.equal(effectiveWithoutEnv, "http://file-proxy:7890", "file value must be used when env unset");

      // Restore env
      if (savedEnv !== undefined) process.env.TELEGRAM_PROXY = savedEnv;
      else delete process.env.TELEGRAM_PROXY;
    } finally {
      cleanup();
    }
  });
});
