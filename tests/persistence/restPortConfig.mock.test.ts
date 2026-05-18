/**
 * P-36 Step 5 — T-FD2.1..T-FD2.3 (assertion bodies filled)
 *
 * Tests for F-D2: server.rest_port config field (additive Zod default 3031).
 *
 * Gate coverage:
 *   G-P36.10 — T-FD2.1 (explicit rest_port parses), T-FD2.2 (default 3031 filled),
 *              T-FD2.3 (out-of-range value rejected → default config)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig } from "../../src/persistence/config.js";

function makeTmpConfig(obj: Record<string, unknown>): { configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p36-fd2-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(obj), "utf-8");
  return { configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── T-FD2.1 ──────────────────────────────────────────────────────────────────

describe("readConfig — explicit server.rest_port parsed correctly (G-P36.10)", () => {
  it(
    "T-FD2.1: given config.json with server.rest_port:4040, readConfig().server.rest_port === 4040",
    () => {
      // Given: config.json v2 with server.rest_port:4040 (within 1024-65535 range)
      // When:  readConfig(configPath) called
      // Then:  result.server.rest_port === 4040
      const { configPath, cleanup } = makeTmpConfig({
        schema_version: 2,
        server: { url: null, rest_port: 4040 },
        worker: {},
        telegram: {},
        soul: {},
      });
      try {
        const cfg = readConfig(configPath);
        assert.equal(
          cfg.server.rest_port,
          4040,
          "T-FD2.1: server.rest_port must be 4040 (explicit value from config.json)",
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-FD2.2 ──────────────────────────────────────────────────────────────────

describe("readConfig — missing server.rest_port Zod-filled with default 3031 (G-P36.10)", () => {
  it(
    "T-FD2.2: given config.json with no rest_port field, readConfig().server.rest_port === 3031",
    () => {
      // Given: config.json v2 without a rest_port field in server sub-object
      // When:  readConfig(configPath) called
      // Then:  result.server.rest_port === 3031 (Zod .default(3031) fills it)
      const { configPath, cleanup } = makeTmpConfig({
        schema_version: 2,
        server: { url: null },
        worker: {},
        telegram: {},
        soul: {},
      });
      try {
        const cfg = readConfig(configPath);
        assert.equal(
          cfg.server.rest_port,
          3031,
          "T-FD2.2: server.rest_port must default to 3031 when not in config.json",
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ─── T-FD2.3 ──────────────────────────────────────────────────────────────────

describe("readConfig — rest_port:80 (below floor) → corrupt-config path → default returned (G-P36.10)", () => {
  it(
    "T-FD2.3: given config.json with server.rest_port:80 (below min 1024), " +
      "readConfig returns the default config (not the invalid value)",
    () => {
      // Given: config.json v2 with server.rest_port:80 (fails Zod .min(1024) constraint)
      // When:  readConfig(configPath) called
      // Then:  Zod parse fails → readConfig falls back to DEFAULT_CONFIG_V2;
      //        result.server.rest_port === 3031 (not 80)
      const { configPath, cleanup } = makeTmpConfig({
        schema_version: 2,
        server: { url: null, rest_port: 80 },
        worker: {},
        telegram: {},
        soul: {},
      });

      // Capture stderr to avoid noise from the expected Zod error log
      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: test stderr mock
      (process.stderr as any).write = (chunk: string | Buffer) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      };

      try {
        const cfg = readConfig(configPath);
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (process.stderr as any).write = origWrite;
        assert.equal(
          cfg.server.rest_port,
          3031,
          `T-FD2.3: server.rest_port must be 3031 (default fallback) when 80 fails validation; got ${cfg.server.rest_port}`,
        );
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (process.stderr as any).write = origWrite;
        cleanup();
      }
    },
  );
});
