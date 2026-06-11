/**
 * P-APP-11 stage (a) — Test Scaffold (Step 3a, outside-in TDD)
 *
 * Verifies the AFTER-state of the createMaiAgent / src/index.ts retirement.
 * All assertions target the post-deletion state; they FAIL in the current
 * pre-deletion state (red state is correct per outside-in TDD).
 *
 * Gate coverage: G-APP11a.1 .. G-APP11a.11
 *
 * DO NOT EDIT the rejection sentinel files named below:
 *   - scripts/app-validation-preflight.ts:97  (DIRECT_CLI_ROUTES — KEEP)
 *   - tests/tauri/appOnlyValidation-papp3.mock.test.ts:167  (rejection test — KEEP)
 *   - tests/tauri/presentSummarySurface-pY3.mock.test.ts:46  (rejection test — KEEP)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

// ─── helper: recursive .ts/.mts/.mjs source scan ────────────────────────────

// Directories to skip during recursive walks — Rust/Tauri build caches and
// node_modules contain thousands of vendored .ts/.d.ts files that are not
// maintained source and would produce irrelevant false hits.
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", "build", "web"]);

function collectSourceFiles(dir: string, exts: string[], skipDirs: Set<string> = SKIP_DIRS): string[] {
  const results: string[] = [];
  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

// Path of this scaffold file itself — excluded from T-App11a.4 scan because it
// intentionally contains the symbol names in comments/string literals.
const THIS_FILE = resolve(import.meta.dirname, "index-retirement-papp11a.mock.test.ts");

function scanFilesForSubstring(files: string[], substring: string): string[] {
  return files.filter((f) => {
    try {
      return readFileSync(f, "utf-8").includes(substring);
    } catch {
      return false;
    }
  });
}

// ─── Suite: deletion truth ────────────────────────────────────────────────────

describe("P-APP-11 stage (a): deletion truth", () => {
  it("T-App11a.1: when src/index.ts is deleted, fs.existsSync returns false", () => {
    // Given: the repository root src/ directory after stage (a) deletion.
    // When: fs.existsSync is called on src/index.ts.
    // Then: result is false — the programmatic factory source file no longer exists.
    const path = resolve(REPO_ROOT, "src/index.ts");
    // TODO: assert.equal(existsSync(path), false, `src/index.ts should not exist after deletion, found at ${path}`);
    assert.equal(
      existsSync(path),
      false,
      `src/index.ts should not exist after deletion, found at ${path}`,
    );
  });

  it("T-App11a.2: when p1-echo.smoke.ts is retired, fs.existsSync returns false", () => {
    // Given: the repository tests/live/ directory after stage (a) retirement.
    // When: fs.existsSync is called on tests/live/p1-echo.smoke.ts.
    // Then: result is false — the smoke consumer is deleted with the factory.
    const path = resolve(REPO_ROOT, "tests/live/p1-echo.smoke.ts");
    // TODO: assert.equal(existsSync(path), false, `tests/live/p1-echo.smoke.ts should not exist after retirement, found at ${path}`);
    assert.equal(
      existsSync(path),
      false,
      `tests/live/p1-echo.smoke.ts should not exist after retirement, found at ${path}`,
    );
  });
});

// ─── Suite: reference-absence ────────────────────────────────────────────────

describe("P-APP-11 stage (a): reference-absence in production source", () => {
  it("T-App11a.3: no src/ file contains createMaiAgent / CreateMaiAgentOpts / MaiAgentController", () => {
    // Given: the src/ tree after src/index.ts deletion.
    // When: every .ts file under src/ is scanned for the three deleted symbol names.
    // Then: zero matches — no production source references the retired API.
    const srcFiles = collectSourceFiles(resolve(REPO_ROOT, "src"), [".ts"]);
    const symbols = ["createMaiAgent", "CreateMaiAgentOpts", "MaiAgentController"];
    for (const symbol of symbols) {
      const hits = scanFilesForSubstring(srcFiles, symbol);
      // TODO: assert.deepEqual(hits, [], `src/ must have no reference to ${symbol}, found in: ${hits.join(", ")}`);
      assert.deepEqual(
        hits,
        [],
        `src/ must have no reference to ${symbol}, found in: ${hits.join(", ")}`,
      );
    }
  });

  it("T-App11a.4: no tests/ file contains createMaiAgent / CreateMaiAgentOpts / MaiAgentController", () => {
    // Given: the tests/ tree after p1-echo.smoke.ts retirement; this scaffold file is excluded
    //        from the scan because it intentionally contains the symbol names in comments.
    // When: every .ts/.mts/.mjs file under tests/ (excluding this scaffold) is scanned.
    // Then: zero matches — no test references the retired factory.
    const allTestFiles = collectSourceFiles(resolve(REPO_ROOT, "tests"), [".ts", ".mts", ".mjs"]);
    // Exclude this scaffold file (it mentions the symbols in comments / string literals)
    const testFiles = allTestFiles.filter((f) => f !== THIS_FILE);
    const symbols = ["createMaiAgent", "CreateMaiAgentOpts", "MaiAgentController"];
    for (const symbol of symbols) {
      const hits = scanFilesForSubstring(testFiles, symbol);
      // TODO: assert.deepEqual(hits, [], `tests/ must have no reference to ${symbol}, found in: ${hits.join(", ")}`);
      assert.deepEqual(
        hits,
        [],
        `tests/ must have no reference to ${symbol}, found in: ${hits.join(", ")}`,
      );
    }
  });

  it("T-App11a.5: no src/<dir>/<file>.ts contains from \"../index.js\" resolving to the deleted root barrel", () => {
    // Given: the src/ tree after deletion; deep barrels (tools/index.ts, linkedin/index.ts, etc.) still exist.
    // When: every .ts file at depth src/<dir>/<file>.ts is scanned for the literal from "../index.js".
    // Then: zero matches — no subdirectory file re-imports the deleted root barrel.
    const srcDir = resolve(REPO_ROOT, "src");
    const matches: string[] = [];
    // Only scan files one level deep inside src/ subdirectories (depth 2)
    let firstLevelDirs: string[];
    try {
      firstLevelDirs = readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => resolve(srcDir, e.name));
    } catch {
      firstLevelDirs = [];
    }
    for (const subdir of firstLevelDirs) {
      // files directly in src/<dir>/ (not deeper barrels)
      const files = collectSourceFiles(subdir, [".ts"]);
      for (const file of files) {
        try {
          const content = readFileSync(file, "utf-8");
          // Check for `from "../index.js"` — would resolve to src/index.ts from src/<dir>/<file>.ts
          if (content.includes('from "../index.js"')) {
            matches.push(file);
          }
        } catch {
          // skip unreadable
        }
      }
    }
    // TODO: assert.deepEqual(matches, [], `No src/<dir>/<file>.ts should import from "../index.js" (root barrel deleted), found: ${matches.join(", ")}`);
    assert.deepEqual(
      matches,
      [],
      `No src/<dir>/<file>.ts should import from "../index.js" (root barrel deleted), found: ${matches.join(", ")}`,
    );
  });
});

// ─── Suite: package.json published surface preservation ──────────────────────

describe("P-APP-11 stage (a): package.json published surface", () => {
  it("T-App11a.6: package.json has no bin, no exports, no main (Phase 13 contract preserved)", () => {
    // Given: the package.json at repo root, which had bin/exports/main removed in Phase 13.
    // When: the top-level keys are inspected.
    // Then: "bin", "exports", and "main" are all absent — no regression restoring the old contract.
    const pkgPath = resolve(REPO_ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    // TODO: assert.equal("bin" in pkg, false, 'package.json must not have a "bin" key');
    // TODO: assert.equal("exports" in pkg, false, 'package.json must not have an "exports" key');
    // TODO: assert.equal("main" in pkg, false, 'package.json must not have a "main" key');
    assert.equal("bin" in pkg, false, 'package.json must not have a "bin" key');
    assert.equal("exports" in pkg, false, 'package.json must not have an "exports" key');
    assert.equal("main" in pkg, false, 'package.json must not have a "main" key');
  });
});

// ─── Suite: tsc emission precondition ────────────────────────────────────────

describe("P-APP-11 stage (a): tsc emission precondition", () => {
  it("T-App11a.7: tsconfig.json include is src/**/* only (so tsc has no source to emit dist/index.js)", () => {
    // Given: tsconfig.json with include: ["src/**/*"]; src/index.ts is deleted.
    // When: the include array and rootDir/outDir config are inspected.
    // Then: include is ["src/**/*"] (no phantom dist source), confirming tsc cannot newly emit dist/index.js.
    const tscPath = resolve(REPO_ROOT, "tsconfig.json");
    const tsc = JSON.parse(readFileSync(tscPath, "utf-8")) as {
      include?: unknown[];
      compilerOptions?: { outDir?: unknown; rootDir?: unknown };
    };
    const include = tsc.include ?? [];
    // TODO: assert.ok(include.includes("src/**/*"), `tsconfig.json include must contain "src/**/*", got: ${JSON.stringify(include)}`);
    assert.ok(
      include.includes("src/**/*"),
      `tsconfig.json include must contain "src/**/*", got: ${JSON.stringify(include)}`,
    );
    // Also confirm src/index.ts is gone (precondition for this gate to be meaningful)
    // TODO: assert.equal(existsSync(resolve(REPO_ROOT, "src/index.ts")), false, "src/index.ts must be absent for tsc emission gate to apply");
    assert.equal(
      existsSync(resolve(REPO_ROOT, "src/index.ts")),
      false,
      "src/index.ts must be absent for tsc emission gate to apply",
    );
  });
});

// ─── Suite: guard preservation (DO-NOT-EDIT sentinels) ───────────────────────

describe("P-APP-11 stage (a): guard preservation", () => {
  it("T-App11a.8: app-validation-preflight.ts DIRECT_CLI_ROUTES still contains ./dist/index.js and dist/index.js", () => {
    // Given: scripts/app-validation-preflight.ts with DIRECT_CLI_ROUTES rejection set.
    // When: the file contents are scanned for the sentinel strings.
    // Then: both "./dist/index.js" and "dist/index.js" are present — rejection guards were NOT removed.
    const preflightPath = resolve(REPO_ROOT, "scripts/app-validation-preflight.ts");
    const content = readFileSync(preflightPath, "utf-8");
    // TODO: assert.ok(content.includes('"./dist/index.js"'), 'app-validation-preflight.ts must retain "./dist/index.js" in DIRECT_CLI_ROUTES');
    // TODO: assert.ok(content.includes('"dist/index.js"'), 'app-validation-preflight.ts must retain "dist/index.js" in DIRECT_CLI_ROUTES');
    assert.ok(
      content.includes('"./dist/index.js"'),
      'app-validation-preflight.ts must retain "./dist/index.js" in DIRECT_CLI_ROUTES',
    );
    assert.ok(
      content.includes('"dist/index.js"'),
      'app-validation-preflight.ts must retain "dist/index.js" in DIRECT_CLI_ROUTES',
    );
  });

  it("T-App11a.8b: appOnlyValidation-papp3.mock.test.ts rejection-test still contains ./dist/index.js", () => {
    // Given: tests/tauri/appOnlyValidation-papp3.mock.test.ts with its rejection sentinel array.
    // When: the file contents are scanned for the sentinel string.
    // Then: "./dist/index.js" is present — the rejection-test guard was NOT over-cleaned by builder.
    const testPath = resolve(REPO_ROOT, "tests/tauri/appOnlyValidation-papp3.mock.test.ts");
    const content = readFileSync(testPath, "utf-8");
    // TODO: assert.ok(content.includes('"./dist/index.js"'), 'appOnlyValidation-papp3.mock.test.ts must retain "./dist/index.js" in its rejected array');
    assert.ok(
      content.includes('"./dist/index.js"'),
      'appOnlyValidation-papp3.mock.test.ts must retain "./dist/index.js" in its rejected array',
    );
  });

  it("T-App11a.8c: presentSummarySurface-pY3.mock.test.ts rejection-test still contains ./dist/index.js", () => {
    // Given: tests/tauri/presentSummarySurface-pY3.mock.test.ts with its rejection sentinel array.
    // When: the file contents are scanned for the sentinel string.
    // Then: "./dist/index.js" is present — the rejection-test guard was NOT over-cleaned by builder.
    const testPath = resolve(REPO_ROOT, "tests/tauri/presentSummarySurface-pY3.mock.test.ts");
    const content = readFileSync(testPath, "utf-8");
    // TODO: assert.ok(content.includes('"./dist/index.js"'), 'presentSummarySurface-pY3.mock.test.ts must retain "./dist/index.js" in its rejected array');
    assert.ok(
      content.includes('"./dist/index.js"'),
      'presentSummarySurface-pY3.mock.test.ts must retain "./dist/index.js" in its rejected array',
    );
  });

  it("T-App11a.9: scripts/test-fast.mjs still excludes tests/live/ from fast test scope", () => {
    // Given: scripts/test-fast.mjs which excludes live tests from the fast suite.
    // When: the file contents are scanned for the tests/live/ exclusion filter.
    // Then: the filter is present — no accidental expansion of the fast test scope.
    const fastMjsPath = resolve(REPO_ROOT, "scripts/test-fast.mjs");
    const content = readFileSync(fastMjsPath, "utf-8");
    // TODO: assert.ok(content.includes("tests/live/"), 'scripts/test-fast.mjs must retain the tests/live/ exclusion filter');
    assert.ok(
      content.includes("tests/live/"),
      "scripts/test-fast.mjs must retain the tests/live/ exclusion filter",
    );
  });
});

// ─── Suite: comment cleanup landed ───────────────────────────────────────────

describe("P-APP-11 stage (a): loop.ts comment cleanup", () => {
  it("T-App11a.10: src/agent/loop.ts no longer cites src/index.ts in its call-site comment narrative", () => {
    // Given: src/agent/loop.ts after the two call-site comment lines at L5 and L143 are updated.
    // When: the file contents are scanned for the literal substring "src/index.ts".
    // Then: zero matches — the stale call-site enumeration no longer names the deleted file.
    const loopPath = resolve(REPO_ROOT, "src/agent/loop.ts");
    const content = readFileSync(loopPath, "utf-8");
    // TODO: assert.equal(content.includes("src/index.ts"), false, 'src/agent/loop.ts must not reference "src/index.ts" after the call-site comment update');
    assert.equal(
      content.includes("src/index.ts"),
      false,
      'src/agent/loop.ts must not reference "src/index.ts" after the call-site comment update',
    );
  });
});

// ─── Suite: stale dist artifact absence (G-APP11a.11 — BLOCKER gate) ────────

describe("P-APP-11 stage (a): stale dist artifact absence (post-build gate)", () => {
  it("T-App11a.11: after npm run build, dist/index.js, dist/index.d.ts, dist/index.js.map, dist/index.d.ts.map do NOT exist", () => {
    // Given: a completed `npm run build` after Step 1.5 rm -f cleaned the four stale artifacts.
    // When: fs.existsSync is called on each of the four dist/index.* paths.
    // Then: ALL four return false — no stale artifact can be copied by build-release.sh:67 into the shipped .app.
    //
    // NOTE: this test asserts the POST-BUILD state. It is valid only when invoked after a real
    // `npm run build` has been run AND after the builder has executed Step 1.5 `rm -f`.
    // At Step 3a (scaffold time), this test FAILS because the four files exist on disk.
    // At Step 4 (validation), the validator runs `npm run build` first, then runs the full suite.
    const staleFiles = [
      resolve(REPO_ROOT, "dist/index.js"),
      resolve(REPO_ROOT, "dist/index.d.ts"),
      resolve(REPO_ROOT, "dist/index.js.map"),
      resolve(REPO_ROOT, "dist/index.d.ts.map"),
    ];
    for (const f of staleFiles) {
      // TODO: assert.equal(existsSync(f), false, `Stale artifact must not exist after build: ${f}`);
      assert.equal(existsSync(f), false, `Stale artifact must not exist after build: ${f}`);
    }
  });
});
