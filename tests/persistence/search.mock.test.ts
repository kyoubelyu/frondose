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
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_SEARCH_CONFIG,
  readSearchConfig,
  searchConfigSchema,
  writeSearchConfig,
} from "../../src/persistence/search.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p15-search-"));
  return {
    dir,
    path: join(dir, "search.json"),
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

function setIsolatedHome(home: string): void {
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
}

function restoreHome(home: string | undefined, homeBase: string | undefined): void {
  if (home !== undefined) process.env.HOME = home;
  else delete process.env.HOME;
  if (homeBase !== undefined) process.env.FRONDOSE_HOME_BASE = homeBase;
  else delete process.env.FRONDOSE_HOME_BASE;
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
    // Given: temp path with HOME-isolated environment (P-24 shim writes to co-located secrets.json)
    // When:  writeSearchConfig({ braveApiKey: "bsa-xxx" }, path) then readSearchConfig(path)
    // Then:  returns { braveApiKey: "bsa-xxx" }; secrets.json stat mode & 0o777 === 0o600

    // HOME override: prevents legacyMerged from reading the real operator auth.json
    // (which would trigger a secrets.json write attempt against a wrong path).
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
    const origHome = process.env.HOME;
    const origHomeBase = process.env.FRONDOSE_HOME_BASE;
    setIsolatedHome(tmpHome);
    const { path, cleanup } = makeTmpDir();
    try {
      writeSearchConfig({ braveApiKey: "bsa-xxx" }, path);
      const result = readSearchConfig(path);
      assert.deepEqual(result, { braveApiKey: "bsa-xxx" }, "must round-trip braveApiKey");

      // P-24 shim: data is in co-located secrets.json, NOT in search.json (search.json is never created).
      // Mode check must be on secrets.json.
      if (process.platform !== "win32") {
        const secretsPath = join(dirname(path), "secrets.json");
        const mode = statSync(secretsPath).mode & 0o777;
        assert.equal(mode, 0o600, `file mode must be 0o600 for secrets; got ${mode.toString(8)}`);
      }
    } finally {
      cleanup();
      restoreHome(origHome, origHomeBase);
      cleanupTmpDir(tmpHome);
    }
  });

  it("T-Search.3: readSearchConfig returns DEFAULT_SEARCH_CONFIG for missing file without throw", () => {
    // Given: nonexistent path with HOME-isolated environment
    // When:  readSearchConfig("/nonexistent/path.json")
    // Then:  returns DEFAULT_SEARCH_CONFIG ({}); no throw

    // HOME override: without this, legacyMerged reads real auth.json → tries to write
    // secrets.json to /nonexistent/ → mkdirSync("/nonexistent") → EACCES.
    const tmpHome = mkdtempSync(join(tmpdir(), "mai-p44-home-"));
    const origHome = process.env.HOME;
    const origHomeBase = process.env.FRONDOSE_HOME_BASE;
    setIsolatedHome(tmpHome);
    try {
      const result = readSearchConfig("/nonexistent/mai-test-search.json");
      assert.deepEqual(result, DEFAULT_SEARCH_CONFIG, "missing file must return DEFAULT_SEARCH_CONFIG");
      assert.equal(Object.keys(result).length, 0, "default config must be empty object");
    } finally {
      restoreHome(origHome, origHomeBase);
      cleanupTmpDir(tmpHome);
    }
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
