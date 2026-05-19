/**
 * P-32 Step 4a — T-CFG.1, T-CFG.2, T-CFG.3
 *
 * Tests: `workerSubSchema` `input_mode` field parsing via readConfig.
 *
 * Gate coverage:
 *   G-P32.1 — T-CFG.1, T-CFG.2, T-CFG.3
 *
 * No Chrome, no LLM, no native addon required.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig } from "../../src/persistence/config.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "mai-p32-cfg-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── T-CFG.1 ──────────────────────────────────────────────────────────────────

describe("workerSubSchema input_mode — G-P32.1", () => {
  it('T-CFG.1: when config.json has worker.input_mode:"hardware", readConfig().worker.input_mode === "hardware"', () => {
    // Given: config.json at a tmp path with worker.input_mode set to "hardware"
    // When:  readConfig(configPath) is called
    // Then:  result.worker.input_mode === "hardware"
    const { configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(configPath, JSON.stringify({ schema_version: 2, worker: { input_mode: "hardware" } }), "utf-8");
      const result = readConfig(configPath);
      assert.equal(result.worker.input_mode, "hardware", "T-CFG.1: input_mode must be 'hardware'");
    } finally {
      cleanup();
    }
  });

  it('T-CFG.2: when config.json has no input_mode field, readConfig().worker.input_mode === "cdp" (Zod default)', () => {
    // Given: config.json at a tmp path with no worker.input_mode field
    // When:  readConfig(configPath) is called
    // Then:  result.worker.input_mode === "cdp" (Zod fills the default)
    const { configPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(
        configPath,
        JSON.stringify({ schema_version: 2, worker: { id: null, hostname: null, label: null } }),
        "utf-8",
      );
      const result = readConfig(configPath);
      assert.equal(result.worker.input_mode, "cdp", "T-CFG.2: absent input_mode must default to 'cdp'");
    } finally {
      cleanup();
    }
  });

  it('T-CFG.3: when input_mode is an invalid value "bogus", readConfig returns default config (Zod parse-fail path) with stderr warning', () => {
    // Given: config.json with worker.input_mode set to "bogus" (not "cdp"|"hardware")
    // When:  readConfig(configPath) is called
    // Then:  returns the DEFAULT_CONFIG_V2 shape; a stderr warning is emitted
    const { configPath, cleanup } = makeTmpDir();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: spy patching
    (process.stderr as any).write = (chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    };
    try {
      writeFileSync(configPath, JSON.stringify({ schema_version: 2, worker: { input_mode: "bogus" } }), "utf-8");
      const result = readConfig(configPath);
      // Zod parse fails → returns default; default has input_mode: "cdp"
      assert.equal(result.worker.input_mode, "cdp", "T-CFG.3: invalid input_mode must return default 'cdp'");
      assert.ok(stderrChunks.length > 0, "T-CFG.3: must emit a stderr warning");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore spy
      (process.stderr as any).write = origWrite;
      cleanup();
    }
  });
});
