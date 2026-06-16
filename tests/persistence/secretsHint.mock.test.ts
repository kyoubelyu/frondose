/**
 * P-36 Step 5 — T-FD1.1 (assertion body filled)
 *
 * Test for F-D1: corrupt/invalid secrets.json → tryReadJson stderr includes
 * the expected-shape hint.
 *
 * Gate coverage:
 *   G-P36.9 — T-FD1.1
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readSecrets } from "../../src/persistence/secrets.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── T-FD1.1 ──────────────────────────────────────────────────────────────────

describe("readSecrets — corrupt secrets.json emits expected-shape hint on stderr (G-P36.9)", () => {
  it(
    "T-FD1.1: given secrets.json with schema_version:99 (invalid), readSecrets returns empty shape; " +
      "captured stderr includes the minimum expected-shape hint substring",
    () => {
      // Given: secrets.json exists with {schema_version: 99} (Zod literal(1) rejects it)
      // When:  readSecrets(secretsPath) called
      // Then:  returns empty/default shape (does not throw);
      //        stderr includes the minimum hint:
      //          '{"schema_version":1,"providers":{"<name>":{"key":"...","type":"anthropic|openai"}}}'
      //        (key identifiers: "schema_version", "providers", "key", "type")
      const dir = mkdtempSync(join(tmpdir(), "mai-p36-fd1-"));
      const secretsPath = join(dir, "secrets.json");
      writeFileSync(secretsPath, JSON.stringify({ schema_version: 99 }), "utf-8");

      // Point legacy paths to non-existent files to avoid reading operator's real config
      // and to prevent the legacyMerged fallback from writing to the tmp path.
      const savedEnv: Record<string, string | undefined> = {
        MAI_LEGACY_AUTH_PATH: process.env.MAI_LEGACY_AUTH_PATH,
        MAI_LEGACY_GITHUB_PATH: process.env.MAI_LEGACY_GITHUB_PATH,
        MAI_LEGACY_SEARCH_PATH: process.env.MAI_LEGACY_SEARCH_PATH,
      };
      process.env.MAI_LEGACY_AUTH_PATH = join(dir, "no-auth.json");
      process.env.MAI_LEGACY_GITHUB_PATH = join(dir, "no-github.json");
      process.env.MAI_LEGACY_SEARCH_PATH = join(dir, "no-search.json");

      const cleanup = () => cleanupTmpDir(dir);

      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: test stderr mock
      (process.stderr as any).write = (chunk: string | Buffer) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      };

      let result: unknown;
      let threw = false;
      try {
        result = readSecrets(secretsPath);
      } catch {
        threw = true;
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (process.stderr as any).write = origWrite;
        for (const [k, v] of Object.entries(savedEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        cleanup();
      }

      assert.ok(!threw, "T-FD1.1: readSecrets must NOT throw on corrupt input");
      assert.ok(result !== null && result !== undefined, "T-FD1.1: readSecrets must return a value");

      const stderr = stderrChunks.join("");
      // The hint written by tryReadJson:
      //   '  Expected: {"schema_version":1,"providers":{"<name>":{"key":"...","type":"anthropic|openai"}}}\n'
      assert.ok(stderr.length > 0, "T-FD1.1: stderr must be non-empty when secrets.json is corrupt");
      assert.ok(
        stderr.includes("schema_version"),
        `T-FD1.1: stderr hint must include 'schema_version'; got: ${stderr}`,
      );
      assert.ok(stderr.includes("providers"), `T-FD1.1: stderr hint must include 'providers'; got: ${stderr}`);
      assert.ok(stderr.includes("key"), `T-FD1.1: stderr hint must include 'key'; got: ${stderr}`);
      assert.ok(
        stderr.includes("anthropic|openai"),
        `T-FD1.1: stderr hint must include 'anthropic|openai' type guidance; got: ${stderr}`,
      );
    },
  );
});
