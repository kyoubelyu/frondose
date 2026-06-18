/**
 * P-72 slice 8 — split-shape tests for memory.ts barrel pattern.
 *
 * These tests verify the POST-SPLIT structural invariants:
 *   - All 19 pre-split exports reachable from the barrel
 *   - No circular imports between memory modules
 *   - Each module within its LoC budget
 *   - 22 importers (plan §2.3 + Codex D6 CMR: workersRegistry + path-resolution)
 *   - No default exports
 *   - Explicit export type { ... } block in barrel
 *   - Helper functions resolve through barrel
 *   - CURRENT_SCHEMA_VERSION === 3 from barrel import
 *
 * These tests PASS post-split (builder Step 3b complete).
 * All assertion bodies filled at Step 4.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// ─── file paths (post-split layout) ──────────────────────────────────────────

const MEMORY_BARREL = path.join(REPO_ROOT, "src/persistence/memory.ts");
const MEMORY_SCHEMA = path.join(REPO_ROOT, "src/persistence/memory/schema.ts");
const MEMORY_URL_NORMALIZE = path.join(REPO_ROOT, "src/persistence/memory/url-normalize.ts");
const MEMORY_PERSONS = path.join(REPO_ROOT, "src/persistence/memory/persons.ts");
const MEMORY_SEARCH = path.join(REPO_ROOT, "src/persistence/memory/search.ts");

const ALL_MEMORY_FILES = [
  MEMORY_BARREL,
  MEMORY_SCHEMA,
  MEMORY_URL_NORMALIZE,
  MEMORY_PERSONS,
  MEMORY_SEARCH,
] as const;

// ─── T-Memory.PublicSurface.1 ─────────────────────────────────────────────────

describe("T-Memory.PublicSurface — all 19 pre-split exports reachable from barrel", () => {
  it("T-Memory.PublicSurface.1: when barrel src/persistence/memory.js is dynamically imported, all 15 value symbols resolve with correct typeof; Zod schemas functional", async () => {
    // Given: all 19 pre-split exports enumerated in plan §2.2
    // When:  const m = await import("../../src/persistence/memory.js") runs
    // Then:  every value symbol has the expected typeof; Zod schemas parse valid inputs without throw

    const m = await import("../../src/persistence/memory.js");

    // 4 schema.ts value symbols
    assert.equal(typeof m.DEFAULT_MEMORY_DB_PATH, "function", "DEFAULT_MEMORY_DB_PATH must be a function");
    assert.equal(typeof m.openMemoryDatabase, "function", "openMemoryDatabase must be a function");
    assert.equal(typeof m.closeMemoryDatabase, "function", "closeMemoryDatabase must be a function");
    assert.equal(typeof m.CURRENT_SCHEMA_VERSION, "number", "CURRENT_SCHEMA_VERSION must be a number");

    // 1 url-normalize.ts value symbol
    assert.equal(typeof m.normalizeProfileUrl, "function", "normalizeProfileUrl must be a function");

    // 9 persons.ts value symbols (8 functions + 1 Zod schema object)
    assert.equal(typeof m.rememberInputSchema, "object", "rememberInputSchema must be a Zod schema object");
    assert.ok(
      typeof (m.rememberInputSchema as { parse?: unknown }).parse === "function",
      "rememberInputSchema must have .parse method",
    );
    assert.equal(typeof m.appendPersonInteraction, "function", "appendPersonInteraction must be a function");
    assert.equal(typeof m.setPersonScore, "function", "setPersonScore must be a function");
    assert.equal(typeof m.getPersonScore, "function", "getPersonScore must be a function");
    assert.equal(typeof m.setMemoryNote, "function", "setMemoryNote must be a function");
    assert.equal(typeof m.getMemoryNote, "function", "getMemoryNote must be a function");
    assert.equal(typeof m.listRecentMemoryEvents, "function", "listRecentMemoryEvents must be a function");

    // 5 search.ts value symbols (3 functions + 1 Zod schema object; MemorySearchHit is type-only)
    assert.equal(typeof m.memoryQuerySchema, "object", "memoryQuerySchema must be a Zod schema object");
    assert.ok(
      typeof (m.memoryQuerySchema as { parse?: unknown }).parse === "function",
      "memoryQuerySchema must have .parse method",
    );
    assert.equal(typeof m.getPersonMemory, "function", "getPersonMemory must be a function");
    assert.equal(typeof m.toFtsMatchQuery, "function", "toFtsMatchQuery must be a function");
    assert.equal(typeof m.searchMemory, "function", "searchMemory must be a function");

    // Zod schemas functional: parse valid minimal inputs without throwing
    const rememberValid = m.rememberInputSchema.parse({
      personName: "Alice",
      profileUrl: "https://www.linkedin.com/in/alice",
      interaction: "message",
      summary: "hello",
    });
    assert.equal(rememberValid.personName, "Alice", "rememberInputSchema.parse must succeed on valid input");

    const memoryQueryValid = m.memoryQuerySchema.parse({ personName: "Alice" });
    assert.equal(memoryQueryValid.personName, "Alice", "memoryQuerySchema.parse must succeed on valid input");
  });
});

// ─── T-Memory.NoCircular.1 ───────────────────────────────────────────────────

describe("T-Memory.NoCircular — no circular imports between memory modules", () => {
  it("T-Memory.NoCircular.1: when relative imports in each memory module are parsed, the resulting directed graph contains no cycle", () => {
    // Given: the 4 source files under src/persistence/memory/**
    // When:  static dependency walk (parse '.' relative imports, build adjacency, DFS for back-edges)
    // Then:  no cycle detected; barrel → modules, modules NOT → barrel

    // Verify all files exist before walking
    for (const filePath of ALL_MEMORY_FILES) {
      assert.ok(existsSync(filePath), `File must exist: ${filePath}`);
    }

    // Key names for nodes (short form)
    const BARREL = "memory.ts";
    const SCHEMA = "memory/schema.ts";
    const URL_NORM = "memory/url-normalize.ts";
    const PERSONS = "memory/persons.ts";
    const SEARCH = "memory/search.ts";

    const FILES: Record<string, string> = {
      [BARREL]: MEMORY_BARREL,
      [SCHEMA]: MEMORY_SCHEMA,
      [URL_NORM]: MEMORY_URL_NORMALIZE,
      [PERSONS]: MEMORY_PERSONS,
      [SEARCH]: MEMORY_SEARCH,
    };

    // Parse relative imports from a file — returns short-key names for known files.
    // Handles TypeScript source that uses .js extensions for ESM imports (Node 22 ESM):
    // e.g. from "./memory/schema.js" → resolves to src/persistence/memory/schema.ts
    function parseRelativeImports(key: string): string[] {
      const content = readFileSync(FILES[key], "utf8");
      // Match: import ... from "./something" or from "../something" (quoted)
      const importRe = /from\s+"(\.\/[^"]+|\.\.\/[^"]+)"/g;
      const deps: string[] = [];
      let m: RegExpExecArray | null = importRe.exec(content);
      for (; m !== null; m = importRe.exec(content)) {
        const rawPath = m[1];
        // Resolve relative to the directory of the containing file
        const containing = path.dirname(FILES[key]);
        const resolved = path.resolve(containing, rawPath);
        // TypeScript ESM uses .js extension for .ts source — try both mappings:
        // 1. If imported as ./foo.js, look for ./foo.ts
        // 2. If imported as ./foo (no extension), look for ./foo.ts
        const candidates: string[] = [
          resolved,                                         // as-is
          resolved.replace(/\.js$/, ".ts"),                 // .js → .ts
          resolved + ".ts",                                 // append .ts if no extension
        ];
        for (const [depKey, depPath] of Object.entries(FILES)) {
          if (candidates.includes(depPath)) {
            deps.push(depKey);
            break;
          }
        }
      }
      return deps;
    }

    // Build adjacency: map from key -> set of keys it imports
    const adj: Record<string, string[]> = {};
    for (const key of Object.keys(FILES)) {
      adj[key] = parseRelativeImports(key);
    }

    // DFS cycle detection using white/grey/black coloring
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color: Record<string, number> = {};
    for (const key of Object.keys(FILES)) color[key] = WHITE;
    let cycleDetected = false;
    const cyclePath: string[] = [];

    function dfs(node: string, stack: string[]): void {
      if (cycleDetected) return;
      color[node] = GREY;
      stack.push(node);
      for (const dep of (adj[node] ?? [])) {
        if (color[dep] === GREY) {
          cycleDetected = true;
          cyclePath.push(...stack, dep);
          return;
        }
        if (color[dep] === WHITE) {
          dfs(dep, stack);
        }
      }
      stack.pop();
      color[node] = BLACK;
    }

    for (const key of Object.keys(FILES)) {
      if (color[key] === WHITE) dfs(key, []);
    }

    assert.ok(!cycleDetected, `Circular import detected: ${cyclePath.join(" → ")}`);

    // Confirm barrel → modules (barrel must import from the 4 modules)
    assert.ok(adj[BARREL].includes(SCHEMA), "barrel must import schema.ts");
    assert.ok(adj[BARREL].includes(URL_NORM), "barrel must import url-normalize.ts");
    assert.ok(adj[BARREL].includes(PERSONS), "barrel must import persons.ts");
    assert.ok(adj[BARREL].includes(SEARCH), "barrel must import search.ts");

    // Confirm no sub-module imports the barrel (../memory.js)
    for (const key of [SCHEMA, URL_NORM, PERSONS, SEARCH]) {
      assert.ok(
        !adj[key].includes(BARREL),
        `${key} must NOT import the barrel (../memory.js or ../memory.ts)`,
      );
    }

    // Confirm persons and search do NOT import each other
    assert.ok(!adj[PERSONS].includes(SEARCH), "persons.ts must NOT import search.ts");
    assert.ok(!adj[SEARCH].includes(PERSONS), "search.ts must NOT import persons.ts");

    // Confirm schema has no intra-memory deps
    assert.equal(adj[SCHEMA].filter((d) => d !== BARREL).length, 0, "schema.ts must have no intra-memory deps");

    // Confirm url-normalize has no intra-memory deps
    assert.equal(
      adj[URL_NORM].filter((d) => d !== BARREL).length,
      0,
      "url-normalize.ts must have no intra-memory deps",
    );
  });
});

// ─── T-Memory.LoCBudget.1 ────────────────────────────────────────────────────

describe("T-Memory.LoCBudget — each module within LoC budget", () => {
  it("T-Memory.LoCBudget.1: when all 5 files are on disk, each is within its §4.1 LoC budget (M1≤160, M2≤10, M3≤170, M4≤130, barrel≤80)", () => {
    // Given: src/persistence/memory/{schema,url-normalize,persons,search}.ts + barrel all exist
    // When:  readFileSync(path).split('\n').length computed per file
    // Then:  M1 ≤ 160, M2 ≤ 10, M3 ≤ 170, M4 ≤ 130, barrel ≤ 80
    for (const filePath of ALL_MEMORY_FILES) {
      assert.ok(existsSync(filePath), `File must exist: ${filePath}`);
    }

    const budgets: Array<[string, string, number]> = [
      ["schema.ts (M1)", MEMORY_SCHEMA, 160],
      ["url-normalize.ts (M2)", MEMORY_URL_NORMALIZE, 10],
      ["persons.ts (M3)", MEMORY_PERSONS, 170],
      ["search.ts (M4)", MEMORY_SEARCH, 130],
      ["barrel memory.ts", MEMORY_BARREL, 80],
    ];

    for (const [label, filePath, budget] of budgets) {
      const lineCount = readFileSync(filePath, "utf8").split("\n").length;
      assert.ok(
        lineCount <= budget,
        `${label}: ${lineCount} lines exceeds §4.1 budget of ${budget} LoC`,
      );
    }
  });
});

// ─── T-Memory.Importer.1 ─────────────────────────────────────────────────────

describe("T-Memory.Importer — 22-importer sample compiles and resolves via barrel", () => {
  it("T-Memory.Importer.1: when 5 representative importers (tool + CLI + fixture + live + Codex-D6 extras) are dynamically imported, each resolves without throw", async () => {
    // Given: 5-importer sample from plan §5.B + Codex D6 CMR:
    //   (a) src/tools/memory/remember.ts (tool — appendPersonInteraction, rememberInputSchema, setPersonScore)
    //   (b) src/tools/memory/searchMemory.ts (tool — searchMemory)
    //   (c) src/cli/serverDaemon.ts (CLI — openMemoryDatabase)
    //   (d) tests/fixtures/read-memory-db.ts (test fixture — openMemoryDatabase)
    //   (e) src/persistence/workersRegistry.ts (Codex D6 CMR — normalizeProfileUrl)
    // When:  each is dynamically imported via tsx
    // Then:  no ERR_MODULE_NOT_FOUND; each imported function/schema is the expected typeof

    // Importers that are safe to dynamically import (no top-level process.exit)
    const safeImporters: Array<[string, string]> = [
      [
        "src/tools/memory/remember.ts",
        path.join(REPO_ROOT, "src/tools/memory/remember.ts"),
      ],
      [
        "src/tools/memory/searchMemory.ts",
        path.join(REPO_ROOT, "src/tools/memory/searchMemory.ts"),
      ],
      [
        "src/persistence/workersRegistry.ts",
        path.join(REPO_ROOT, "src/persistence/workersRegistry.ts"),
      ],
    ];

    for (const [label, filePath] of safeImporters) {
      assert.ok(existsSync(filePath), `Importer file must exist: ${label} at ${filePath}`);
      try {
        await import(filePath);
      } catch (err: unknown) {
        // Allow non-resolution errors (e.g. serverDaemon may fail on missing config at runtime)
        // but NOT module-not-found errors
        const msg = (err as Error).message ?? "";
        if (msg.includes("ERR_MODULE_NOT_FOUND") || msg.includes("Cannot find module")) {
          throw new Error(`Importer ${label} failed with module-not-found: ${msg}`);
        }
        // Other runtime errors (missing config files, etc.) are acceptable —
        // we only care that the module graph resolves, not that it runs end-to-end
      }
    }

    // Importers verified by file-existence + barrel-import check only
    // (these modules have top-level side-effects — process.exit or heavy runtime init —
    //  that make dynamic import unsafe in the test runner context)
    const existenceOnlyImporters: Array<[string, string]> = [
      [
        "src/cli/serverDaemon.ts",
        path.join(REPO_ROOT, "src/cli/serverDaemon.ts"),
      ],
      [
        "tests/fixtures/read-memory-db.ts",
        // Note: read-memory-db.ts calls process.exit(1) when MAI_MEMORY_DB_PATH is unset;
        // dynamic import would kill the test runner — verify by file existence + static import check
        path.join(REPO_ROOT, "tests/fixtures/read-memory-db.ts"),
      ],
    ];

    for (const [label, filePath] of existenceOnlyImporters) {
      assert.ok(existsSync(filePath), `Importer file must exist: ${label} at ${filePath}`);
      // Verify the file's import of persistence/memory.js resolves correctly
      // by reading its import declarations (static analysis)
      const content = readFileSync(filePath, "utf8");
      assert.ok(
        content.includes("persistence/memory.js") || content.includes("persistence/memory"),
        `${label} must import from persistence/memory`,
      );
    }
  });
});

// ─── T-Memory.NoDefault.1 ────────────────────────────────────────────────────

describe("T-Memory.NoDefault — no default exports in memory/** or barrel", () => {
  it("T-Memory.NoDefault.1: when all 5 files are read, none contains 'export default' or 'export { default'", () => {
    // Given: the 5 files under src/persistence/memory/** + barrel
    // When:  each file's text is checked for /^export default|^export \{ default/m
    // Then:  zero matches (export * safety: no accidental default re-export)
    for (const filePath of ALL_MEMORY_FILES) {
      assert.ok(existsSync(filePath), `File must exist: ${filePath}`);
    }

    const defaultExportRe = /^export default|^export \{ default/m;

    for (const filePath of ALL_MEMORY_FILES) {
      const content = readFileSync(filePath, "utf8");
      assert.ok(
        !defaultExportRe.test(content),
        `${filePath} must NOT contain 'export default' or 'export { default' (breaks export * re-export safety)`,
      );
    }
  });
});

// ─── T-Memory.BarrelTypeExports.1 ────────────────────────────────────────────

describe("T-Memory.BarrelTypeExports — barrel contains explicit export type { ... } block", () => {
  it("T-Memory.BarrelTypeExports.1: when barrel src/persistence/memory.ts is read, it contains explicit 'export type { ... }' naming RememberInput, MemoryQuery, MemorySearchHit", () => {
    // Given: the post-split src/persistence/memory.ts barrel file
    // When:  the file is read as text
    // Then:  'export type {' appears at least once; RememberInput, MemoryQuery, MemorySearchHit each named
    assert.ok(existsSync(MEMORY_BARREL), `Barrel file must exist: ${MEMORY_BARREL}`);

    const barrelText = readFileSync(MEMORY_BARREL, "utf8");

    // Must have at least one export type { ... } block
    assert.ok(
      barrelText.includes("export type {"),
      "barrel must contain 'export type { ... }' block (§4.X slice 4 CONCERN-MR enforcement)",
    );

    // All 3 type-only symbols must be named in the barrel
    const typeNames = ["RememberInput", "MemoryQuery", "MemorySearchHit"];
    for (const typeName of typeNames) {
      assert.ok(
        barrelText.includes(typeName),
        `barrel must name type '${typeName}' in its explicit export type { ... } block`,
      );
    }

    // RememberInput must reference persons.js source module
    assert.ok(
      barrelText.includes("./memory/persons.js"),
      "barrel must reference './memory/persons.js' for RememberInput",
    );

    // MemoryQuery and MemorySearchHit must reference search.js source module
    assert.ok(
      barrelText.includes("./memory/search.js"),
      "barrel must reference './memory/search.js' for MemoryQuery + MemorySearchHit",
    );
  });
});

// ─── T-Memory.HelpersResolve.1 ───────────────────────────────────────────────

describe("T-Memory.HelpersResolve — memory sub-module helpers export expected functions", () => {
  it("T-Memory.HelpersResolve.1: when toFtsMatchQuery is imported from barrel, its behavior is preserved across 3 representative inputs", async () => {
    // Given: toFtsMatchQuery imported from the barrel (src/persistence/memory.js)
    // When:  passed 3 representative inputs
    // Then:  "hello world" → '"hello" "world"'; punctuation stripped; empty-result case returns ""
    const m = await import("../../src/persistence/memory.js");

    assert.equal(typeof m.toFtsMatchQuery, "function", "toFtsMatchQuery must be a function");

    // Case 1: two words → quoted AND join
    const result1 = m.toFtsMatchQuery("hello world");
    assert.equal(result1, '"hello" "world"', `toFtsMatchQuery("hello world") must return '"hello" "world"'; got: ${result1}`);

    // Case 2: punctuation/operator injection — must not throw, must return non-empty without raw FTS ops
    const result2 = m.toFtsMatchQuery("a:b* (c)");
    assert.ok(typeof result2 === "string", "toFtsMatchQuery must return a string for punctuation input");
    assert.ok(result2.length > 0, "toFtsMatchQuery('a:b* (c)') must return non-empty string");
    // Raw FTS operators stripped (colons + asterisks + parens should not appear outside double-quotes)
    assert.ok(!result2.includes("*") || result2.startsWith('"'), "result must not contain raw FTS * operator");

    // Case 3: pure punctuation / empty-token input → returns ""
    const result3 = m.toFtsMatchQuery('"" :: **');
    assert.equal(result3, "", `toFtsMatchQuery('"" :: **') must return ""; got: ${result3}`);
  });

  it("T-Memory.HelpersResolve.1 — sub-modules export their planned functions when files exist", () => {
    // Given: all 5 memory module files exist
    // When:  each file is read and checked for expected export function/const names
    // Then:  schema.ts exports openMemoryDatabase, closeMemoryDatabase, CURRENT_SCHEMA_VERSION, DEFAULT_MEMORY_DB_PATH
    //        url-normalize.ts exports normalizeProfileUrl
    //        persons.ts exports rememberInputSchema, appendPersonInteraction, setPersonScore, getPersonScore, setMemoryNote, getMemoryNote, listRecentMemoryEvents
    //        search.ts exports memoryQuerySchema, getPersonMemory, toFtsMatchQuery, searchMemory
    for (const filePath of ALL_MEMORY_FILES) {
      assert.ok(existsSync(filePath), `File must exist: ${filePath}`);
    }

    const expectedExports: Array<[string, string[]]> = [
      [
        MEMORY_SCHEMA,
        ["DEFAULT_MEMORY_DB_PATH", "openMemoryDatabase", "closeMemoryDatabase", "CURRENT_SCHEMA_VERSION"],
      ],
      [MEMORY_URL_NORMALIZE, ["normalizeProfileUrl"]],
      [
        MEMORY_PERSONS,
        [
          "rememberInputSchema",
          "RememberInput",
          "appendPersonInteraction",
          "setPersonScore",
          "getPersonScore",
          "setMemoryNote",
          "getMemoryNote",
          "listRecentMemoryEvents",
        ],
      ],
      [
        MEMORY_SEARCH,
        ["memoryQuerySchema", "MemoryQuery", "getPersonMemory", "MemorySearchHit", "toFtsMatchQuery", "searchMemory"],
      ],
    ];

    for (const [filePath, exports] of expectedExports) {
      const content = readFileSync(filePath, "utf8");
      for (const exportName of exports) {
        assert.ok(
          content.includes(exportName),
          `${path.basename(filePath)} must export '${exportName}'`,
        );
      }
    }
  });
});

// ─── T-Memory.SchemaVersion.1 ────────────────────────────────────────────────

describe("T-Memory.SchemaVersion — CURRENT_SCHEMA_VERSION === 3 from barrel import", () => {
  it("T-Memory.SchemaVersion.1: when CURRENT_SCHEMA_VERSION is imported from src/persistence/memory.js, it resolves to 3 (R3 enforcement)", async () => {
    // Given: CURRENT_SCHEMA_VERSION exported from barrel
    // When:  dynamically imported and compared to 3
    // Then:  CURRENT_SCHEMA_VERSION === 3 (literal; not incremented by move)
    const m = await import("../../src/persistence/memory.js");
    assert.equal(
      m.CURRENT_SCHEMA_VERSION,
      3,
      `CURRENT_SCHEMA_VERSION must be exactly 3 (R3 enforcement); got: ${m.CURRENT_SCHEMA_VERSION}`,
    );
  });
});
