/**
 * P-15 mock tests — T-Search.1..T-Search.4
 *
 * Tests for src/persistence/search.ts (CREATED by builder Step 4b).
 *
 * T-Search.1 — Schema validation: valid both keys passes, empty optional passes
 * T-Search.2 — Write→read round-trip preserves fields; mode is 0o600
 * T-Search.3 — Missing file → DEFAULT_SEARCH_CONFIG without throw
 * T-Search.4 — Corrupt file → DEFAULT_SEARCH_CONFIG without throw; stderr receives message
 *
 * Gate coverage: G-P15.2 (search.json persistence)
 *
 * NOTE: search.ts does NOT exist until builder Step 4b.
 * These scaffolds will fail to compile until then.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  searchConfigSchema,
  DEFAULT_SEARCH_CONFIG,
  readSearchConfig,
  writeSearchConfig,
} from "../../src/persistence/search.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p15-search-"));
  return {
    dir,
    path: join(dir, "search.json"),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("search.json persistence (G-P15.2)", () => {
  it("T-Search.1: searchConfigSchema validates valid config; both keys optional", () => {
    // Given: searchConfigSchema
    // When:  safeParse called with both keys, empty object, single key
    // Then:  all succeed (all fields optional)

    const both = searchConfigSchema.safeParse({ braveApiKey: "key1", tavilyApiKey: "key2" });
    assert.equal(both.success, true, "both keys must parse");

    const empty = searchConfigSchema.safeParse({});
    assert.equal(empty.success, true, "empty config must parse (all optional)");

    const single = searchConfigSchema.safeParse({ braveApiKey: "brave-only" });
    assert.equal(single.success, true, "single key must parse");
  });

  it("T-Search.2: writeSearchConfig then readSearchConfig round-trips fields; file mode is 0o600", () => {
    // Given: temp path
    // When:  writeSearchConfig({ braveApiKey: "bsa-xxx" }, path) then readSearchConfig(path)
    // Then:  returns { braveApiKey: "bsa-xxx" }; file stat mode & 0o777 === 0o600

    const { path, cleanup } = makeTmpDir();
    try {
      writeSearchConfig({ braveApiKey: "bsa-xxx" }, path);
      const result = readSearchConfig(path);
      assert.deepEqual(result, { braveApiKey: "bsa-xxx" }, "must round-trip braveApiKey");

      // File mode must be 0o600 (secret)
      const mode = statSync(path).mode & 0o777;
      assert.equal(mode, 0o600, `file mode must be 0o600 for secrets; got ${mode.toString(8)}`);
    } finally {
      cleanup();
    }
  });

  it("T-Search.3: readSearchConfig returns DEFAULT_SEARCH_CONFIG for missing file without throw", () => {
    // Given: nonexistent path
    // When:  readSearchConfig("/nonexistent/path.json")
    // Then:  returns DEFAULT_SEARCH_CONFIG ({}); no throw

    const result = readSearchConfig("/nonexistent/mai-test-search.json");
    assert.deepEqual(result, DEFAULT_SEARCH_CONFIG, "missing file must return DEFAULT_SEARCH_CONFIG");
    assert.equal(Object.keys(result).length, 0, "default config must be empty object");
  });

  it("T-Search.4: readSearchConfig returns DEFAULT_SEARCH_CONFIG for corrupt file; stderr has path", () => {
    // Given: file with invalid JSON content
    // When:  readSearchConfig(corruptPath)
    // Then:  returns DEFAULT_SEARCH_CONFIG; stderr contains file path; no throw

    const { path, cleanup } = makeTmpDir();
    try {
      writeFileSync(path, "{not valid json", "utf-8");
      let result: ReturnType<typeof readSearchConfig> | undefined;
      let stderr = "";
      assert.doesNotThrow(() => {
        stderr = captureStderr(() => {
          result = readSearchConfig(path);
        });
      }, "must not throw on corrupt JSON");
      assert.ok(result, "result must be defined");
      assert.deepEqual(result, DEFAULT_SEARCH_CONFIG, "corrupt file must return DEFAULT_SEARCH_CONFIG");
      assert.ok(
        stderr.includes(path) || stderr.includes("search.json"),
        `stderr must contain file reference; got: "${stderr}"`,
      );
    } finally {
      cleanup();
    }
  });
});
