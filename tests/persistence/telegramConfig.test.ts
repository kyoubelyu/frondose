/**
 * P-11 Step 5 — T-Config.1..T-Config.7 (filled assertions)
 *
 * telegram.json schema + atomic read/write (src/persistence/telegramConfig.ts).
 * Gate coverage: G-P11.2 (all T-Config tests)
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_TELEGRAM_CONFIG,
  readTelegramConfig,
  writeTelegramConfig,
} from "../../src/persistence/telegramConfig.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cfgPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p11-tgcfg-"));
  return {
    dir,
    cfgPath: join(dir, "telegram.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
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
    // Given: a path that does not exist on disk
    // When: readTelegramConfig(nonExistentPath) is called
    // Then: returns { enabled:false, boundUserId:null, lastUpdateOffset:0, stickyFallbackIp:null, pollTimeoutSec:30, pollBackoffSec:5 }
    const { cfgPath, cleanup } = makeTmpDir();
    try {
      const nonExistent = `${cfgPath}.nonexistent`;
      const result = readTelegramConfig(nonExistent);
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
    // Given: file written with { enabled:true, boundUserId:12345, lastUpdateOffset:99, stickyFallbackIp:"149.154.166.110", pollTimeoutSec:30, pollBackoffSec:5 }
    // When: readTelegramConfig reads it
    // Then: parsed object deep-equals the written object
    const { cfgPath, cleanup } = makeTmpDir();
    try {
      const cfg = {
        enabled: true,
        boundUserId: 12345,
        lastUpdateOffset: 99,
        stickyFallbackIp: "149.154.166.110",
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      };
      writeFileSync(cfgPath, JSON.stringify(cfg), "utf-8");
      const result = readTelegramConfig(cfgPath);
      assert.deepEqual(result, cfg, "readTelegramConfig must return exact written values");
    } finally {
      cleanup();
    }
  });

  it("T-Config.3: when the file contains malformed JSON, readTelegramConfig returns DEFAULT_TELEGRAM_CONFIG AND emits a stderr warning containing the file path; does NOT throw", () => {
    // Given: file with content "{not json"
    // When: readTelegramConfig called; stderr captured
    // Then: returns DEFAULT_TELEGRAM_CONFIG; stderr contains file path + parse error; no throw
    const { cfgPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(cfgPath, "{not json", "utf-8");
      let result!: typeof DEFAULT_TELEGRAM_CONFIG;
      const stderr = captureStderr(() => {
        result = readTelegramConfig(cfgPath);
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
    // Given: file with { "enabled": true } (missing boundUserId and other required fields)
    // When: readTelegramConfig called; stderr captured
    // Then: returns DEFAULT_TELEGRAM_CONFIG; stderr contains Zod/validation error message; no throw
    const { cfgPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(cfgPath, JSON.stringify({ enabled: true }), "utf-8");
      let result!: typeof DEFAULT_TELEGRAM_CONFIG;
      const stderr = captureStderr(() => {
        result = readTelegramConfig(cfgPath);
      });
      assert.deepEqual(result, DEFAULT_TELEGRAM_CONFIG, "incomplete JSON must return defaults");
      assert.ok(stderr.length > 0, "stderr must contain a warning for invalid schema");
    } finally {
      cleanup();
    }
  });

  it("T-Config.5: when writeTelegramConfig(cfg, path) is called, file is written atomically via tmp+rename; no .tmp artifact remains; readTelegramConfig returns deep-equal to cfg", () => {
    // Given: a valid TelegramConfig object + fresh tmp dir
    // When: writeTelegramConfig called
    // Then: no .tmp artifact; readTelegramConfig returns same values; atomic write (existsSync(path.tmp) === false after return)
    const { cfgPath, cleanup } = makeTmpDir();
    try {
      const cfg = { ...DEFAULT_TELEGRAM_CONFIG, enabled: true, boundUserId: 42, lastUpdateOffset: 7 };
      writeTelegramConfig(cfg, cfgPath);

      // No .tmp artifact
      assert.ok(!existsSync(`${cfgPath}.tmp`), "no .tmp artifact must remain after writeTelegramConfig");
      // File exists
      assert.ok(existsSync(cfgPath), "telegram.json must exist after write");
      // Readback matches
      const result = readTelegramConfig(cfgPath);
      assert.deepEqual(result, cfg, "readTelegramConfig must return same values as written");
    } finally {
      cleanup();
    }
  });

  it("T-Config.6: when writeTelegramConfig is called 5 times in sequence with different lastUpdateOffset values, the final readTelegramConfig returns only the last value (full rewrite, not append)", () => {
    // Given: 5 sequential writes with offsets 1, 2, 3, 4, 5
    // When: readTelegramConfig after all 5 writes
    // Then: lastUpdateOffset === 5 (last write wins)
    const { cfgPath, cleanup } = makeTmpDir();
    try {
      for (let i = 1; i <= 5; i++) {
        writeTelegramConfig({ ...DEFAULT_TELEGRAM_CONFIG, lastUpdateOffset: i }, cfgPath);
      }
      const result = readTelegramConfig(cfgPath);
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
});
