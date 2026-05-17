/**
 * P-30 Step 4a — T-WNC.1-4
 *
 * Mock tests for src/persistence/workerNodeConfig.ts — readWorkerNodeConfig.
 * Strategy: write JSON files to a tmp dir; assert the reader's behavior.
 * No DB, no network required.
 *
 * Gate coverage:
 *   T-WNC.1 — G-P30.3: valid JSON + valid schema → parsed object
 *   T-WNC.2 — G-P30.3: missing file → null (no throw)
 *   T-WNC.3 — G-P30.3: malformed JSON → null + stderr warning (no throw)
 *   T-WNC.4 — G-P30.3: schema-invalid value (e.g. vnc_port: 99999) → null + stderr warning (no throw)
 *
 * Scaffold: assertion bodies are TODO — all tests intentionally fail.
 * Assertion bodies will be filled at Step 5.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readWorkerNodeConfig } from "../../src/persistence/workerNodeConfig.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p30-wnc-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeWorkerJson(dir: string, workerId: string, content: string): void {
  writeFileSync(join(dir, `${workerId}.json`), content, "utf-8");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("T-WNC: readWorkerNodeConfig (G-P30.3)", () => {
  it(
    "T-WNC.1: when a valid <id>.json exists with correct schema, readWorkerNodeConfig returns the parsed object",
    () => {
      // Given: tmp dir containing 'w1.json' = {vnc_host:'10.0.0.1', vnc_port:5900, vnc_password:'pw', ssh_user:'op', ssh_port:22}
      // When:  readWorkerNodeConfig(dir, 'w1')
      // Then:  result.vnc_port===5900; result.vnc_password==='pw'; result.ssh_user==='op'; result.ssh_port===22

      const { dir, cleanup } = makeTmpDir();
      try {
        writeWorkerJson(dir, "w1", JSON.stringify({
          vnc_host: "10.0.0.1",
          vnc_port: 5900,
          vnc_password: "secret",
          ssh_user: "op",
          ssh_port: 22,
        }));

        const result = readWorkerNodeConfig(dir, "w1");
        assert.ok(result !== null, "T-WNC.1: must return a non-null object");
        assert.equal(result.vnc_host, "10.0.0.1", "T-WNC.1: vnc_host must match");
        assert.equal(result.vnc_port, 5900, "T-WNC.1: vnc_port must match");
        assert.equal(result.vnc_password, "secret", "T-WNC.1: vnc_password must match");
        assert.equal(result.ssh_user, "op", "T-WNC.1: ssh_user must match");
        assert.equal(result.ssh_port, 22, "T-WNC.1: ssh_port must match");
      } finally {
        cleanup();
      }
    },
  );

  it(
    "T-WNC.2: when <id>.json does not exist, readWorkerNodeConfig returns null without throwing",
    () => {
      // Given: tmp dir with no 'w99.json' file
      // When:  readWorkerNodeConfig(dir, 'w99')
      // Then:  result === null; no exception thrown

      const { dir, cleanup } = makeTmpDir();
      try {
        const result = readWorkerNodeConfig(dir, "w99");
        assert.equal(result, null, "T-WNC.2: missing file must return null");
      } finally {
        cleanup();
      }
    },
  );

  it(
    "T-WNC.3: when <id>.json exists but contains malformed JSON (not parseable), returns null and writes stderr warning",
    () => {
      // Given: tmp dir containing 'w2.json' = 'not valid json!!{'
      // When:  readWorkerNodeConfig(dir, 'w2')
      // Then:  result === null; process.stderr received a warning message (no throw)

      const { dir, cleanup } = makeTmpDir();
      try {
        writeWorkerJson(dir, "w2", "not valid json!!{");

        // Capture stderr
        const stderrLines: string[] = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (s: string | Uint8Array, ...args: unknown[]) => {
          stderrLines.push(typeof s === "string" ? s : s.toString());
          // biome-ignore lint/suspicious/noExplicitAny: compat
          return (origWrite as (...a: unknown[]) => boolean)(s, ...args as any);
        };
        let result: ReturnType<typeof readWorkerNodeConfig> = null;
        try {
          result = readWorkerNodeConfig(dir, "w2");
        } finally {
          process.stderr.write = origWrite;
        }

        assert.equal(result, null, "T-WNC.3: malformed JSON must return null");
        assert.ok(
          stderrLines.some((l) => l.includes("w2.json") && l.includes("invalid")),
          `T-WNC.3: stderr must contain a warning about w2.json; got: ${JSON.stringify(stderrLines)}`,
        );
      } finally {
        cleanup();
      }
    },
  );

  it(
    "T-WNC.4: when <id>.json has a schema-invalid field (vnc_port: 99999 exceeds max 65535), returns null and writes stderr warning",
    () => {
      // Given: tmp dir containing 'w3.json' = {vnc_port: 99999} (exceeds max)
      // When:  readWorkerNodeConfig(dir, 'w3')
      // Then:  result === null (Zod parse fails); stderr contains a warning

      const { dir, cleanup } = makeTmpDir();
      try {
        writeWorkerJson(dir, "w3", JSON.stringify({ vnc_port: 99999 }));

        const stderrLines: string[] = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (s: string | Uint8Array, ...args: unknown[]) => {
          stderrLines.push(typeof s === "string" ? s : s.toString());
          // biome-ignore lint/suspicious/noExplicitAny: compat
          return (origWrite as (...a: unknown[]) => boolean)(s, ...args as any);
        };
        let result: ReturnType<typeof readWorkerNodeConfig> = null;
        try {
          result = readWorkerNodeConfig(dir, "w3");
        } finally {
          process.stderr.write = origWrite;
        }

        assert.equal(result, null, "T-WNC.4: schema-invalid JSON must return null");
        assert.ok(
          stderrLines.some((l) => l.includes("w3.json") && l.includes("invalid")),
          `T-WNC.4: stderr must contain a warning about w3.json; got: ${JSON.stringify(stderrLines)}`,
        );
      } finally {
        cleanup();
      }
    },
  );
});
