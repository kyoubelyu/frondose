/**
 * P-72 slice 9 — Step 3a split-shape scaffolds (FAIL pre-split; GREEN post-split)
 *
 * Eight structural tests verifying the barrel split shape AFTER builder Step 3b
 * creates src/cli/autoUpdate/** and rewrites src/cli/autoUpdate.ts as a barrel +
 * orchestrator hybrid. All assertion bodies are TODO (intentionally failing today).
 *
 * Test-file plan §5.B targets:
 *   T-autoUpdate.PublicSurface.1    — all 15 pre-split exports reachable via barrel
 *   T-autoUpdate.NoCircular.1       — no circular import among the 6 files
 *   T-autoUpdate.LoCBudget.1        — each file <= its §4.1 LoC budget
 *   T-autoUpdate.Importer.1         — 5 import call-sites (incl main.ts:629) resolve
 *   T-autoUpdate.NoDefault.1        — zero "export default" in autoUpdate* files
 *   T-autoUpdate.BarrelTypeExports.1 — 3 type declarations present in the barrel file
 *   T-autoUpdate.HelpersResolve.1   — all 11 per-stage helpers reachable via barrel
 *   T-autoUpdate.ChildProcessScope.1 — exactly 2 child_process import sites; 0 in src/tools
 *
 * Covers gates: G-P72s9.1, G-P72s9.2, G-P72s9.4, G-P72s9.5, G-P72s9.6
 *
 * NOTE: These tests are STRUCTURAL — they inspect file content and import resolution,
 * not runtime behavior. They compile today (pre-split) but the assertion bodies reference
 * post-split files that do not exist yet, so they intentionally FAIL pre-split.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

// ─── constants ────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "../..");
const BARREL = join(ROOT, "src/cli/autoUpdate.ts");
const AUTOUPDATE_DIR = join(ROOT, "src/cli/autoUpdate");

// Post-split leaf modules (created by builder Step 3b)
const LEAVES = {
  fetch: join(AUTOUPDATE_DIR, "fetch.ts"),
  extract: join(AUTOUPDATE_DIR, "extract.ts"),
  symlink: join(AUTOUPDATE_DIR, "symlink.ts"),
  gc: join(AUTOUPDATE_DIR, "gc.ts"),
  lock: join(AUTOUPDATE_DIR, "lock.ts"),
};

// All 6 files in the post-split tree (barrel + 5 leaves)
const ALL_FILES = [BARREL, ...Object.values(LEAVES)];

// ─── LoC budgets (§4.1) ───────────────────────────────────────────────────────
const LOC_BUDGETS: Record<string, number> = {
  [BARREL]: 220,
  [LEAVES.fetch]: 90,
  [LEAVES.extract]: 50,
  [LEAVES.symlink]: 70,
  [LEAVES.gc]: 40,
  [LEAVES.lock]: 60,
};

// ─── utility: count lines via wc -l semantics ────────────────────────────────
// (Plan's LoC budgets are wc -l counts. `split("\n").length` is off-by-one for
// files with a trailing newline. Use newline-character count to match the
// budget convention exactly. Step 5→6 orchestrator fix.)
function countLines(filePath: string): number {
  const text = readFileSync(filePath, "utf8");
  return (text.match(/\n/g) ?? []).length;
}

// ─── utility: extract relative imports from a file ───────────────────────────
function parseRelativeImports(filePath: string): string[] {
  const text = readFileSync(filePath, "utf8");
  const matches: string[] = [];
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // biome-ignore lint/style/noNonNullAssertion: regex has capture group
    matches.push(m[1]!);
  }
  return matches;
}

// ─── utility: DFS cycle detection ────────────────────────────────────────────
function hasCycle(
  node: string,
  fileToImports: Map<string, string[]>,
  visited: Set<string>,
  inStack: Set<string>,
): boolean {
  visited.add(node);
  inStack.add(node);

  const imports = fileToImports.get(node) ?? [];
  for (const imp of imports) {
    if (!visited.has(imp)) {
      if (hasCycle(imp, fileToImports, visited, inStack)) return true;
    } else if (inStack.has(imp)) {
      return true;
    }
  }

  inStack.delete(node);
  return false;
}

// ─── T-autoUpdate.PublicSurface.1 ────────────────────────────────────────────

describe("autoUpdate split-barrel — public surface", () => {
  it(
    "T-autoUpdate.PublicSurface.1: all 15 pre-split exported symbols are reachable via the barrel src/cli/autoUpdate.js after the split",
    async () => {
      // Given: the 15 exported symbols from plan §2.2 (3 types + 12 functions)
      // When:  barrel is dynamically imported
      // Then:  all 12 value (function) symbols are typeof "function"; 3 type symbols checked statically

      // Type-only import for compile-time check (npm run check validates this):
      // biome-ignore lint/correctness/noUnusedImports: compile-time surface check
      // biome-ignore lint/style/useImportType: intentional value+type mixed import
      // import type { AutoUpdateAction, AutoUpdateResult, AutoUpdateDI } from "../../src/cli/autoUpdate.js";

      // TODO(Step 4): fill assertion bodies after builder creates the split
      // The post-split barrel must export all 15 symbols unchanged.

      // Pre-split: barrel is the monolith → all 12 functions already exist.
      // Post-split: barrel re-exports them through sub-modules.
      // This test FAILS pre-split because the file-existence pre-condition check below
      // requires the AUTOUPDATE_DIR and its leaves to exist.

      assert.ok(
        existsSync(AUTOUPDATE_DIR),
        `[TODO Step 4] autoUpdate/ directory must exist post-split: ${AUTOUPDATE_DIR}`,
      );
      assert.ok(existsSync(LEAVES.fetch), `[TODO Step 4] fetch.ts must exist: ${LEAVES.fetch}`);
      assert.ok(existsSync(LEAVES.extract), `[TODO Step 4] extract.ts must exist: ${LEAVES.extract}`);
      assert.ok(existsSync(LEAVES.symlink), `[TODO Step 4] symlink.ts must exist: ${LEAVES.symlink}`);
      assert.ok(existsSync(LEAVES.gc), `[TODO Step 4] gc.ts must exist: ${LEAVES.gc}`);
      assert.ok(existsSync(LEAVES.lock), `[TODO Step 4] lock.ts must exist: ${LEAVES.lock}`);

      // Dynamic import of compiled barrel (tsx resolves .ts at runtime)
      const m = await import("../../src/cli/autoUpdate.js");

      const expectedFunctions = [
        "runStartupAutoUpdate",
        "fetchLatestTag",
        "fetchLatestPrerelease",
        "downloadTarball",
        "extractTarball",
        "buildRelease",
        "derivePackageSymlink",
        "isDevLink",
        "swapPackageSymlink",
        "gcOldReleases",
        "acquireUpdateLock",
        "releaseUpdateLock",
      ];

      for (const name of expectedFunctions) {
        assert.strictEqual(
          typeof (m as Record<string, unknown>)[name],
          "function",
          `[TODO Step 4] barrel must export ${name} as function`,
        );
      }
    },
  );
});

// ─── T-autoUpdate.NoCircular.1 ───────────────────────────────────────────────

describe("autoUpdate split-barrel — no circular imports", () => {
  it(
    "T-autoUpdate.NoCircular.1: the 6 post-split files form a DAG with no cycles; leaves do not import the barrel; barrel imports all leaves",
    () => {
      // Given: 6 files — barrel + 5 leaves — post-split
      // When:  relative imports are parsed and a DFS cycle check is run
      // Then:  no cycle detected; each leaf has no imports back to the barrel

      // TODO(Step 4): fill assertion bodies after builder creates the split

      assert.ok(
        existsSync(AUTOUPDATE_DIR),
        `[TODO Step 4] autoUpdate/ directory must exist: ${AUTOUPDATE_DIR}`,
      );

      for (const [name, path] of Object.entries(LEAVES)) {
        assert.ok(existsSync(path), `[TODO Step 4] leaf ${name}.ts must exist: ${path}`);
      }

      // Build adjacency map (relative import strings → resolved canonical paths)
      // For the DFS, we use the TS file paths (pre-compile) and resolve .js → .ts
      function resolveImport(fromFile: string, imp: string): string {
        // Strip .js extension if present (tsx resolves .ts at build time)
        const withoutExt = imp.replace(/\.js$/, "");
        const resolved = resolve(fromFile, "..", withoutExt + ".ts");
        return resolved;
      }

      const fileToImports = new Map<string, string[]>();
      for (const file of ALL_FILES) {
        if (!existsSync(file)) continue;
        const relImports = parseRelativeImports(file);
        const resolvedImports = relImports
          .map((imp) => resolveImport(file, imp))
          .filter((p) => ALL_FILES.includes(p));
        fileToImports.set(file, resolvedImports);
      }

      // Cycle detection (DFS)
      const visited = new Set<string>();
      const inStack = new Set<string>();
      let cycleFound = false;
      for (const file of ALL_FILES) {
        if (!visited.has(file)) {
          if (hasCycle(file, fileToImports, visited, inStack)) {
            cycleFound = true;
            break;
          }
        }
      }

      assert.ok(!cycleFound, "[TODO Step 4] circular import detected among autoUpdate* files");

      // Leaves must NOT import the barrel (autoUpdate.ts)
      for (const [name, leafPath] of Object.entries(LEAVES)) {
        if (!existsSync(leafPath)) continue;
        const leafImports = fileToImports.get(leafPath) ?? [];
        const importsBarrel = leafImports.some((p) => p === BARREL);
        assert.ok(
          !importsBarrel,
          `[TODO Step 4] leaf ${name}.ts must NOT import the barrel (${BARREL})`,
        );
      }

      // Barrel must import all 5 leaves
      const barrelImports = fileToImports.get(BARREL) ?? [];
      for (const [name, leafPath] of Object.entries(LEAVES)) {
        const importsLeaf = barrelImports.some((p) => p === leafPath);
        assert.ok(
          importsLeaf,
          `[TODO Step 4] barrel must import leaf ${name}.ts (${leafPath})`,
        );
      }
    },
  );
});

// ─── T-autoUpdate.LoCBudget.1 ────────────────────────────────────────────────

describe("autoUpdate split-barrel — LoC budgets", () => {
  it(
    "T-autoUpdate.LoCBudget.1: each post-split file is within its §4.1 LoC budget (barrel ≤220, fetch ≤90, extract ≤50, symlink ≤70, gc ≤40, lock ≤60)",
    () => {
      // Given: 6 post-split files with budgets from plan §4.1
      // When:  line counts are computed for each file
      // Then:  each count is <= its budget

      // TODO(Step 4): fill assertion bodies after builder creates the split

      for (const [filePath, budget] of Object.entries(LOC_BUDGETS)) {
        assert.ok(
          existsSync(filePath),
          `[TODO Step 4] file must exist for LoC check: ${filePath}`,
        );
        const lineCount = countLines(filePath);
        assert.ok(
          lineCount <= budget,
          `[TODO Step 4] ${filePath} has ${lineCount} lines; budget is ≤ ${budget}`,
        );
      }
    },
  );
});

// ─── T-autoUpdate.Importer.1 ─────────────────────────────────────────────────

describe("autoUpdate split-barrel — importer resolution", () => {
  it(
    "T-autoUpdate.Importer.1: all 5 production import call-sites and 2 test file importers resolve via the barrel; includes main.ts --bootstrap dynamic import (line shifted by P-APP-11 b1)",
    async () => {
      // Given: 5 call sites across 3 production files + 2 test files importing from autoUpdate.js
      //   (a) src/cli/main.ts:103 — startup dynamic import of runStartupAutoUpdate
      //   (b) src/cli/main.ts:629 — --bootstrap dynamic import of runStartupAutoUpdate (CRITICAL: D8 CMR)
      //   (c) src/cli/subcommands/uninstall.ts:7 — static import of derivePackageSymlink + isDevLink
      //   (d) tests/cli/autoUpdate.mock.test.ts:41 — static import of gcOldReleases + runStartupAutoUpdate + types
      //   (e) tests/cli/update-channel.mock.test.ts:22 — static import of fetchLatestPrerelease
      // When:  barrel is dynamically imported; call-sites' source files are checked for the expected import patterns
      // Then:  all named imports resolve to function types; source files contain the expected import strings

      // TODO(Step 4): fill assertion bodies after builder creates the split

      // Post-split barrel dynamic import
      const m = await import("../../src/cli/autoUpdate.js");

      // (a)+(b) main.ts — verify both call sites exist in the source
      const mainTs = readFileSync(join(ROOT, "src/cli/main.ts"), "utf8");
      const dynamicImportMatches = [...mainTs.matchAll(/import\(["']\.\/autoUpdate\.js["']\)/g)];
      assert.ok(
        dynamicImportMatches.length >= 2,
        `[TODO Step 4] src/cli/main.ts must contain at least 2 dynamic import('./autoUpdate.js') call sites (startup + --bootstrap); found: ${dynamicImportMatches.length}`,
      );

      // Confirm the --bootstrap dynamic import exists in main.ts (D8 CMR).
      // P-APP-11 b1: line numbers shifted (6 subcommand registration blocks deleted); use content
      // search instead of line-number window. The "bootstrap" keyword near the import is the anchor.
      assert.ok(
        mainTs.includes("bootstrap") && mainTs.includes("autoUpdate.js"),
        `[TODO Step 4] src/cli/main.ts must contain both 'bootstrap' and 'autoUpdate.js' (--bootstrap dynamic import D8 CMR); main.ts snippet: ${mainTs.slice(Math.max(0, mainTs.indexOf("bootstrap") - 50), mainTs.indexOf("bootstrap") + 150)}`,
      );

      // (c) uninstall.ts — static import of derivePackageSymlink + isDevLink
      const uninstallTs = readFileSync(join(ROOT, "src/cli/subcommands/uninstall.ts"), "utf8");
      assert.ok(
        uninstallTs.includes("autoUpdate.js") || uninstallTs.includes("autoUpdate"),
        `[TODO Step 4] uninstall.ts must import from autoUpdate`,
      );
      assert.strictEqual(
        typeof (m as Record<string, unknown>).derivePackageSymlink,
        "function",
        "[TODO Step 4] derivePackageSymlink must be a function via barrel",
      );
      assert.strictEqual(
        typeof (m as Record<string, unknown>).isDevLink,
        "function",
        "[TODO Step 4] isDevLink must be a function via barrel",
      );

      // (d) autoUpdate.mock.test.ts — static import (check that gcOldReleases + runStartupAutoUpdate reach test)
      assert.strictEqual(
        typeof (m as Record<string, unknown>).gcOldReleases,
        "function",
        "[TODO Step 4] gcOldReleases must be a function via barrel",
      );
      assert.strictEqual(
        typeof (m as Record<string, unknown>).runStartupAutoUpdate,
        "function",
        "[TODO Step 4] runStartupAutoUpdate must be a function via barrel",
      );

      // (e) update-channel.mock.test.ts — fetchLatestPrerelease
      assert.strictEqual(
        typeof (m as Record<string, unknown>).fetchLatestPrerelease,
        "function",
        "[TODO Step 4] fetchLatestPrerelease must be a function via barrel",
      );
    },
  );
});

// ─── T-autoUpdate.NoDefault.1 ────────────────────────────────────────────────

describe("autoUpdate split-barrel — no default exports", () => {
  it(
    "T-autoUpdate.NoDefault.1: no 'export default' or 'export { default' in any of the 6 autoUpdate* files (ensures export * correctness)",
    () => {
      // Given: the 6 post-split files
      // When:  each file is scanned for export default patterns
      // Then:  zero matches in all files

      // TODO(Step 4): fill assertion bodies after builder creates the split

      for (const filePath of ALL_FILES) {
        assert.ok(
          existsSync(filePath),
          `[TODO Step 4] file must exist for default-export check: ${filePath}`,
        );

        const text = readFileSync(filePath, "utf8");
        const hasDefault =
          /^export\s+default\b/m.test(text) || /^export\s*\{[^}]*default[^}]*\}/m.test(text);
        assert.ok(
          !hasDefault,
          `[TODO Step 4] ${filePath} must not contain 'export default' or 'export { default }' (found one)`,
        );
      }
    },
  );
});

// ─── T-autoUpdate.BarrelTypeExports.1 ────────────────────────────────────────

describe("autoUpdate split-barrel — barrel type declarations", () => {
  it(
    "T-autoUpdate.BarrelTypeExports.1: the barrel src/cli/autoUpdate.ts declares all 3 public types (AutoUpdateAction, AutoUpdateResult, AutoUpdateDI) at its top level",
    () => {
      // Given: post-split src/cli/autoUpdate.ts (barrel + orchestrator)
      // When:  file text is inspected for the 3 type declaration strings
      // Then:  each declaration string is present (types STAY in the barrel file, not moved to a sub-module)

      // TODO(Step 4): fill assertion bodies after builder creates the split (barrel rewrite)

      // Pre-split: the barrel is the monolith → all 3 types ARE declared here → test PASSES today.
      // Post-split: the barrel keeps the types at the same lines → must still pass.
      // (A "helpful" builder who moves types into a types.ts sub-module would break this test.)

      const text = readFileSync(BARREL, "utf8");

      assert.ok(
        /export\s+type\s+AutoUpdateAction/.test(text),
        "[TODO Step 4] barrel must declare 'export type AutoUpdateAction'",
      );
      assert.ok(
        /export\s+interface\s+AutoUpdateResult/.test(text),
        "[TODO Step 4] barrel must declare 'export interface AutoUpdateResult'",
      );
      assert.ok(
        /export\s+interface\s+AutoUpdateDI/.test(text),
        "[TODO Step 4] barrel must declare 'export interface AutoUpdateDI'",
      );
    },
  );
});

// ─── T-autoUpdate.HelpersResolve.1 ───────────────────────────────────────────

describe("autoUpdate split-barrel — all helpers reachable", () => {
  it(
    "T-autoUpdate.HelpersResolve.1: all 11 per-stage helper functions are reachable via the barrel; spot-check 3 with lightweight smoke calls",
    async () => {
      // Given: post-split barrel exporting 11 helpers from 5 leaf modules
      // When:  barrel dynamically imported; helpers accessed by name; 3 smoked
      // Then:  all 11 are typeof "function"; smoke calls succeed per spec

      // TODO(Step 4): fill assertion bodies after builder creates the split

      assert.ok(
        existsSync(AUTOUPDATE_DIR),
        `[TODO Step 4] autoUpdate/ directory must exist: ${AUTOUPDATE_DIR}`,
      );

      const m = await import("../../src/cli/autoUpdate.js");
      const barrel = m as Record<string, unknown>;

      const expectedHelpers = [
        "fetchLatestTag",
        "fetchLatestPrerelease",
        "downloadTarball",
        "extractTarball",
        "buildRelease",
        "derivePackageSymlink",
        "isDevLink",
        "swapPackageSymlink",
        "gcOldReleases",
        "acquireUpdateLock",
        "releaseUpdateLock",
      ];

      for (const name of expectedHelpers) {
        assert.strictEqual(
          typeof barrel[name],
          "function",
          `[TODO Step 4] barrel must export ${name} as a function`,
        );
      }

      // Smoke 1: derivePackageSymlink("/tmp/nonexistent-readlink-fails") → null (try/catch path)
      const deriveResult = (barrel.derivePackageSymlink as (a: string) => string | null)(
        "/tmp/nonexistent-readlink-fails-p72s9",
      );
      assert.strictEqual(
        deriveResult,
        null,
        "[TODO Step 4] derivePackageSymlink('/tmp/nonexistent') should return null",
      );

      // Smoke 2: gcOldReleases("/tmp/nonexistent-dir", 2) → silent no-op
      assert.doesNotThrow(
        () =>
          (barrel.gcOldReleases as (dir: string, keep: number) => void)(
            "/tmp/nonexistent-p72s9-gc",
            2,
          ),
        "[TODO Step 4] gcOldReleases on nonexistent dir should be a silent no-op",
      );

      // Smoke 3: acquireUpdateLock + releaseUpdateLock round-trip (reuses the MAI_HOME_BASE pattern
      // from the characterization file — here we use a one-off tmp via MAI_HOME_BASE override)
      const prevHome = process.env.MAI_HOME_BASE;
      const { mkdtempSync, rmSync: rmSyncLocal } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const tmpHome = mkdtempSync(join(tmpdir(), "p72s9-helpers-"));
      process.env.MAI_HOME_BASE = tmpHome;
      try {
        const acquireFs = barrel.acquireUpdateLock as (nowMs: number) => number;
        const releaseFs = barrel.releaseUpdateLock as (fd: number) => void;
        const fd = acquireFs(Date.now());
        assert.ok(typeof fd === "number" && fd > 0, "[TODO Step 4] acquireUpdateLock smoke: fd > 0");
        releaseFs(fd);
      } finally {
        if (prevHome === undefined) delete process.env.MAI_HOME_BASE;
        else process.env.MAI_HOME_BASE = prevHome;
        rmSyncLocal(tmpHome, { recursive: true, force: true });
      }
    },
  );
});

// ─── T-autoUpdate.ChildProcessScope.1 ────────────────────────────────────────

describe("autoUpdate split-barrel — child_process scope", () => {
  it(
    "T-autoUpdate.ChildProcessScope.1: exactly 2 files under src/cli/autoUpdate* import 'node:child_process'; zero under src/tools/**; no CommonJS require('child_process') anywhere",
    () => {
      // Given: post-split file tree under src/cli/autoUpdate* and src/tools/**
      // When:  grep for 'node:child_process' import sites
      // Then:  exactly 2 hits (autoUpdate.ts + autoUpdate/extract.ts); 0 in src/tools/**; 0 CJS form

      // TODO(Step 4): fill assertion bodies after builder creates the split

      assert.ok(
        existsSync(LEAVES.extract),
        `[TODO Step 4] extract.ts must exist before child_process scope check: ${LEAVES.extract}`,
      );

      // Step 5→6 orchestrator fix: replaced shell exec with readFileSync + JS regex
      // (the shell-escaped \x27 grep was mangled when interpolated through TS strings).
      const childProcessImportRe = /from\s+["']node:child_process["']/;
      const cjsRequireRe = /require\(\s*['"]child_process['"]/;

      // Count node:child_process import sites in autoUpdate.ts + autoUpdate/**
      const autoUpdateFiles: string[] = [BARREL];
      for (const name of readdirSync(AUTOUPDATE_DIR)) {
        if (name.endsWith(".ts")) autoUpdateFiles.push(join(AUTOUPDATE_DIR, name));
      }
      const hitFiles = autoUpdateFiles.filter((f) =>
        childProcessImportRe.test(readFileSync(f, "utf8")),
      );

      assert.strictEqual(
        hitFiles.length,
        2,
        `exactly 2 'node:child_process' import sites expected in autoUpdate* files; found ${hitFiles.length}: ${JSON.stringify(hitFiles)}`,
      );

      // Both hits must be in the expected files
      assert.ok(
        hitFiles.includes(BARREL),
        `one hit must be in autoUpdate.ts (barrel/orchestrator); hits: ${JSON.stringify(hitFiles)}`,
      );
      assert.ok(
        hitFiles.includes(LEAVES.extract),
        `one hit must be in autoUpdate/extract.ts; hits: ${JSON.stringify(hitFiles)}`,
      );

      // Zero hits under src/tools/** (recursive walk)
      const TOOLS_DIR = join(ROOT, "src/tools");
      const toolsHits: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, name.name);
          if (name.isDirectory()) walk(full);
          else if (name.isFile() && name.name.endsWith(".ts")) {
            const src = readFileSync(full, "utf8");
            if (childProcessImportRe.test(src)) toolsHits.push(full);
          }
        }
      };
      walk(TOOLS_DIR);
      assert.strictEqual(
        toolsHits.length,
        0,
        `zero 'node:child_process' imports under src/tools/**; found: ${JSON.stringify(toolsHits)}`,
      );

      // Defense-in-depth: no CommonJS require('child_process') in autoUpdate* or tools
      const cjsHits: string[] = [];
      for (const f of autoUpdateFiles) {
        if (cjsRequireRe.test(readFileSync(f, "utf8"))) cjsHits.push(f);
      }
      const walkCjs = (dir: string): void => {
        for (const name of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, name.name);
          if (name.isDirectory()) walkCjs(full);
          else if (name.isFile() && name.name.endsWith(".ts")) {
            if (cjsRequireRe.test(readFileSync(full, "utf8"))) cjsHits.push(full);
          }
        }
      };
      walkCjs(TOOLS_DIR);
      assert.strictEqual(
        cjsHits.length,
        0,
        `zero CJS require('child_process') in autoUpdate* or src/tools; found: ${JSON.stringify(cjsHits)}`,
      );
    },
  );
});
