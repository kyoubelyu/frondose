/**
 * P-72 slice 4 — salesDb.ts split barrel validation (Step 4 — assertions filled).
 *
 * Assertion bodies filled by validator at Step 4 per plan §5 + CLAUDE.md BDD-light.
 *
 * Tests in this file:
 *   T-P72s4.Resolve.1   — per-module files each export their §3.1 symbol set
 *   T-P72s4.Barrel.1    — 32 value symbols still importable from salesDb.js
 *   T-P72s4.NoCircular.1 — no circular imports among the 9 sales modules
 *   T-P72s4.Schema.1    — openSalesDatabase creates same tables/indexes/version
 *   T-P72s4.Importer.1  — 5-importer representative sample still resolves
 *   T-P72s4.LoCBudget.1 — per-domain modules <= §3.1 budgets; barrel <= 80 LoC
 *   T-P72s4.UrlNormalize.1 — normalizeProfileUrl callable via raw-candidates AND leads paths
 *   T-P72s4.NoDefault.1 — no `default` export in sales/** or barrel
 *
 * Run in isolation:
 *   node --import tsx --test --test-force-exit \
 *     tests/persistence/salesDb-split-barrel.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../..");

// ─── Module path constants ────────────────────────────────────────────────────

const SALES_DIR = resolve(repoRoot, "src/persistence/sales");
const BARREL_PATH = resolve(repoRoot, "src/persistence/salesDb.ts");

const MODULE_PATHS = {
  schema: resolve(SALES_DIR, "schema.ts"),
  urlNormalize: resolve(SALES_DIR, "url-normalize.ts"),
  rawCandidates: resolve(SALES_DIR, "raw-candidates.ts"),
  leads: resolve(SALES_DIR, "leads.ts"),
  drafts: resolve(SALES_DIR, "drafts.ts"),
  timeline: resolve(SALES_DIR, "timeline.ts"),
  accounts: resolve(SALES_DIR, "accounts.ts"),
  scores: resolve(SALES_DIR, "scores.ts"),
  autoRun: resolve(SALES_DIR, "auto-run.ts"),
} as const;

// JS extensions for runtime dynamic import (Node ESM)
const MODULE_IMPORT_PATHS = {
  schema: "../../src/persistence/sales/schema.js",
  urlNormalize: "../../src/persistence/sales/url-normalize.js",
  rawCandidates: "../../src/persistence/sales/raw-candidates.js",
  leads: "../../src/persistence/sales/leads.js",
  drafts: "../../src/persistence/sales/drafts.js",
  timeline: "../../src/persistence/sales/timeline.js",
  accounts: "../../src/persistence/sales/accounts.js",
  scores: "../../src/persistence/sales/scores.js",
  autoRun: "../../src/persistence/sales/auto-run.js",
} as const;

// §3.2 — value symbols (consts + fns) per module — 32 total (50 - 18 type-only)
// Type-only symbols are validated via the barrel's `export type { ... }` blocks
// which are checked by `npm run check` (tsc). See plan §5 T-P72s4.Barrel.1.
const VALUE_SYMBOLS_BY_MODULE: Record<string, string[]> = {
  schema: ["DEFAULT_SALES_DB_PATH", "CURRENT_SCHEMA_VERSION", "CURRENT_SALES_SCHEMA_VERSION", "openSalesDatabase", "closeSalesDatabase"],
  urlNormalize: ["normalizeProfileUrl"],
  rawCandidates: ["upsertRawCandidate", "getRawCandidate", "setCandidateStatus"],
  leads: ["insertLead", "getLeadByCandidate", "getLead", "updateLeadStage", "setLeadFollowUp", "listDueFollowUps"],
  drafts: ["insertDraft", "getDraft", "listDraftsByLead", "markDraftSent"],
  timeline: ["appendTimelineEvent", "listTimelineByLead", "listTimelineByAccount"],
  accounts: ["getAccount", "countLeadsByAccount"],
  scores: ["getLatestScoreByCandidate"],
  autoRun: ["getCurrentAutoRun", "getAutoRun", "appendAutoLedger", "countAutoLedgerByAction", "insertAutoRun", "updateAutoRunStatus", "endAutoRun"],
};

// ─── T-P72s4.Resolve.1 ────────────────────────────────────────────────────────

describe("T-P72s4.Resolve — per-module files export their §3.1 symbol sets", () => {
  it("T-P72s4.Resolve.1: when the 9 sales modules exist after builder Step 3b, each dynamically-imported module exposes its value-symbol set", async () => {
    // Given: the 9 module files exist under src/persistence/sales/
    // When:  each module is `await import`-ed and Object.keys() is inspected
    // Then:  for each module, Object.keys() is a superset of the value symbols in §3.1
    for (const [moduleKey, importPath] of Object.entries(MODULE_IMPORT_PATHS)) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import for runtime inspection
      const mod = await import(importPath) as Record<string, any>;
      const keys = Object.keys(mod);
      const expectedSymbols = VALUE_SYMBOLS_BY_MODULE[moduleKey] ?? [];
      for (const sym of expectedSymbols) {
        assert.ok(
          keys.includes(sym),
          `Module '${moduleKey}' (${importPath}) must export value symbol '${sym}'; got keys: [${keys.join(", ")}]`,
        );
      }
    }
  });

  it("T-P72s4.Resolve.1 edge: when auto-run module is imported, endAutoRun is exported as a top-level name without collision", async () => {
    // Given: sales/auto-run.ts exists
    // When:  module is dynamically imported
    // Then:  typeof module.endAutoRun === 'function' and AutoRunStatus is NOT a runtime key
    //        (AutoRunStatus is a string-literal type; it vanishes at runtime — no collision)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for runtime inspection
    const mod = await import("../../src/persistence/sales/auto-run.js") as Record<string, any>;
    assert.strictEqual(
      typeof mod.endAutoRun,
      "function",
      "auto-run module must export endAutoRun as a function",
    );
    // AutoRunStatus is a type alias (string literal union) — it has no runtime artifact
    assert.strictEqual(
      mod.AutoRunStatus,
      undefined,
      "AutoRunStatus is a type-only export; it must not appear as a runtime key",
    );
  });
});

// ─── T-P72s4.Barrel.1 ─────────────────────────────────────────────────────────

describe("T-P72s4.Barrel — every pre-split value symbol importable from salesDb.js", () => {
  it("T-P72s4.Barrel.1: when salesDb.js barrel is dynamically imported, all 32 value symbols resolve with the correct typeof", async () => {
    // Given: the barrel src/persistence/salesDb.ts re-exports all 9 modules via `export *`
    // When:  `const m = await import('../../src/persistence/salesDb.js')` runs
    // Then:  for every value symbol in VALUE_SYMBOLS_BY_MODULE, typeof m[name] is 'function' or 'string'/'number'
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for runtime inspection
    const m = await import("../../src/persistence/salesDb.js") as Record<string, any>;

    // Constants from schema module
    assert.strictEqual(typeof m.DEFAULT_SALES_DB_PATH, "function", "DEFAULT_SALES_DB_PATH must be a function");
    assert.strictEqual(typeof m.CURRENT_SCHEMA_VERSION, "number", "CURRENT_SCHEMA_VERSION must be a number");
    assert.strictEqual(typeof m.CURRENT_SALES_SCHEMA_VERSION, "number", "CURRENT_SALES_SCHEMA_VERSION must be a number");
    // Lifecycle fns
    assert.strictEqual(typeof m.openSalesDatabase, "function", "openSalesDatabase must be a function");
    assert.strictEqual(typeof m.closeSalesDatabase, "function", "closeSalesDatabase must be a function");
    // url-normalize
    assert.strictEqual(typeof m.normalizeProfileUrl, "function", "normalizeProfileUrl must be a function");
    // raw-candidates
    assert.strictEqual(typeof m.upsertRawCandidate, "function", "upsertRawCandidate must be a function");
    assert.strictEqual(typeof m.getRawCandidate, "function", "getRawCandidate must be a function");
    assert.strictEqual(typeof m.setCandidateStatus, "function", "setCandidateStatus must be a function");
    // leads
    assert.strictEqual(typeof m.insertLead, "function", "insertLead must be a function");
    assert.strictEqual(typeof m.getLeadByCandidate, "function", "getLeadByCandidate must be a function");
    assert.strictEqual(typeof m.getLead, "function", "getLead must be a function");
    assert.strictEqual(typeof m.updateLeadStage, "function", "updateLeadStage must be a function");
    assert.strictEqual(typeof m.setLeadFollowUp, "function", "setLeadFollowUp must be a function");
    assert.strictEqual(typeof m.listDueFollowUps, "function", "listDueFollowUps must be a function");
    // drafts
    assert.strictEqual(typeof m.insertDraft, "function", "insertDraft must be a function");
    assert.strictEqual(typeof m.getDraft, "function", "getDraft must be a function");
    assert.strictEqual(typeof m.listDraftsByLead, "function", "listDraftsByLead must be a function");
    assert.strictEqual(typeof m.markDraftSent, "function", "markDraftSent must be a function");
    // timeline
    assert.strictEqual(typeof m.appendTimelineEvent, "function", "appendTimelineEvent must be a function");
    assert.strictEqual(typeof m.listTimelineByLead, "function", "listTimelineByLead must be a function");
    assert.strictEqual(typeof m.listTimelineByAccount, "function", "listTimelineByAccount must be a function");
    // accounts
    assert.strictEqual(typeof m.getAccount, "function", "getAccount must be a function");
    assert.strictEqual(typeof m.countLeadsByAccount, "function", "countLeadsByAccount must be a function");
    // scores
    assert.strictEqual(typeof m.getLatestScoreByCandidate, "function", "getLatestScoreByCandidate must be a function");
    // auto-run (7 symbols)
    assert.strictEqual(typeof m.getCurrentAutoRun, "function", "getCurrentAutoRun must be a function");
    assert.strictEqual(typeof m.getAutoRun, "function", "getAutoRun must be a function");
    assert.strictEqual(typeof m.appendAutoLedger, "function", "appendAutoLedger must be a function");
    assert.strictEqual(typeof m.countAutoLedgerByAction, "function", "countAutoLedgerByAction must be a function");
    assert.strictEqual(typeof m.insertAutoRun, "function", "insertAutoRun must be a function");
    assert.strictEqual(typeof m.updateAutoRunStatus, "function", "updateAutoRunStatus must be a function");
    assert.strictEqual(typeof m.endAutoRun, "function", "endAutoRun must be a function");

    // Verify count: 32 value symbols total
    const allValueSymbols = Object.values(VALUE_SYMBOLS_BY_MODULE).flat();
    assert.strictEqual(allValueSymbols.length, 32, "VALUE_SYMBOLS_BY_MODULE must enumerate exactly 32 value symbols");
  });

  it("T-P72s4.Barrel.1 edge: Phase 16 import block — the 11 symbols used by the characterization test all resolve at runtime via the barrel", async () => {
    // Given: the Phase 16 test imports these 11 symbols from ../../src/persistence/salesDb.js:
    //        appendTimelineEvent, getDraft, getLead, getRawCandidate, insertDraft,
    //        insertLead, listTimelineByLead, normalizeProfileUrl, openSalesDatabase,
    //        updateLeadStage, upsertRawCandidate
    // When:  barrel is imported and each name is accessed
    // Then:  all 11 are typeof 'function'; none is undefined
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for runtime inspection
    const m = await import("../../src/persistence/salesDb.js") as Record<string, any>;

    // Exact 11 symbols from Phase 16 characterization test (lines 35-47)
    const phase16Symbols = [
      "appendTimelineEvent",
      "getDraft",
      "getLead",
      "getRawCandidate",
      "insertDraft",
      "insertLead",
      "listTimelineByLead",
      "normalizeProfileUrl",
      "openSalesDatabase",
      "updateLeadStage",
      "upsertRawCandidate",
    ];

    for (const sym of phase16Symbols) {
      assert.notStrictEqual(m[sym], undefined, `Phase 16 symbol '${sym}' must not be undefined via barrel`);
      assert.strictEqual(typeof m[sym], "function", `Phase 16 symbol '${sym}' must be a function; got typeof=${typeof m[sym]}`);
    }
  });
});

// ─── T-P72s4.NoCircular.1 ────────────────────────────────────────────────────

describe("T-P72s4.NoCircular — no circular imports between the 9 sales modules", () => {
  it("T-P72s4.NoCircular.1: when relative imports in each sales module file are parsed, the resulting directed graph contains no cycle", () => {
    // Given: the 9 source files under src/persistence/sales/**
    // When:  a static dependency walk (parseImports + DFS) runs on relative './...' imports
    // Then:  no cycle is detected; every module reaches url-normalize or has no sales/ dep

    // Parse relative imports (./...) from a TypeScript source file
    function parseRelativeImports(filePath: string): string[] {
      const src = readFileSync(filePath, "utf8");
      const matches = [...src.matchAll(/from\s+"(\.[^"]+)"/g)];
      return matches
        .map((m) => m[1] as string)
        .filter((p) => p.startsWith("./") || p.startsWith("../"));
    }

    // Resolve a relative import path to a canonical module key within sales/
    function resolveToKey(fromFile: string, importPath: string): string | null {
      // Normalize: strip .js extension, resolve relative to SALES_DIR
      const stripped = importPath.replace(/\.js$/, "");
      if (stripped === "./url-normalize" || stripped.endsWith("/url-normalize")) return "urlNormalize";
      if (stripped === "./schema" || stripped.endsWith("/schema")) return "schema";
      if (stripped === "./raw-candidates" || stripped.endsWith("/raw-candidates")) return "rawCandidates";
      if (stripped === "./leads" || stripped.endsWith("/leads")) return "leads";
      if (stripped === "./drafts" || stripped.endsWith("/drafts")) return "drafts";
      if (stripped === "./timeline" || stripped.endsWith("/timeline")) return "timeline";
      if (stripped === "./accounts" || stripped.endsWith("/accounts")) return "accounts";
      if (stripped === "./scores" || stripped.endsWith("/scores")) return "scores";
      if (stripped === "./auto-run" || stripped.endsWith("/auto-run")) return "autoRun";
      // Not a sales/ module import (e.g. node:*, better-sqlite3, ../paths.js)
      return null;
    }

    // Build adjacency map: moduleKey -> [moduleKey, ...]
    const moduleKeys = Object.keys(MODULE_PATHS) as Array<keyof typeof MODULE_PATHS>;
    const adjacency: Record<string, string[]> = {};

    for (const key of moduleKeys) {
      const filePath = MODULE_PATHS[key];
      const imports = parseRelativeImports(filePath);
      adjacency[key] = imports
        .map((p) => resolveToKey(filePath, p))
        .filter((k): k is string => k !== null);
    }

    // DFS cycle detection — returns the cycle path if found, null if acyclic
    function findCycle(
      node: string,
      visited: Set<string>,
      stack: Set<string>,
      path: string[],
    ): string[] | null {
      visited.add(node);
      stack.add(node);
      path.push(node);
      for (const neighbor of adjacency[node] ?? []) {
        if (!visited.has(neighbor)) {
          const cycle = findCycle(neighbor, visited, stack, path);
          if (cycle) return cycle;
        } else if (stack.has(neighbor)) {
          // Found a back-edge -> cycle
          return [...path, neighbor];
        }
      }
      stack.delete(node);
      path.pop();
      return null;
    }

    const visited = new Set<string>();
    for (const key of moduleKeys) {
      if (!visited.has(key)) {
        const cycle = findCycle(key, visited, new Set<string>(), []);
        assert.strictEqual(
          cycle,
          null,
          `Circular import detected in sales modules: ${cycle?.join(" -> ")}`,
        );
      }
    }

    // Verify the only cross-module dependencies are the expected ones:
    // raw-candidates -> url-normalize, leads -> url-normalize
    assert.deepStrictEqual(
      adjacency.rawCandidates?.sort(),
      ["urlNormalize"],
      "raw-candidates must only import url-normalize from sales/",
    );
    assert.deepStrictEqual(
      adjacency.leads?.sort(),
      ["urlNormalize"],
      "leads must only import url-normalize from sales/",
    );
    // All others have no intra-sales imports
    for (const key of ["schema", "urlNormalize", "drafts", "timeline", "accounts", "scores", "autoRun"]) {
      assert.deepStrictEqual(
        adjacency[key] ?? [],
        [],
        `Module '${key}' must have no intra-sales/ imports; got: [${(adjacency[key] ?? []).join(", ")}]`,
      );
    }
  });

  it("T-P72s4.NoCircular.1 edge: barrel salesDb.ts imports all 9 modules; none of the 9 modules imports the barrel", () => {
    // Given: src/persistence/salesDb.ts is the barrel
    // When:  each sales/* file is read and checked for an import of '../salesDb.js'
    // Then:  zero matches (one-directional: barrel -> modules only)
    const BARREL_BACK_IMPORT_RE = /from\s+"\.\.\/salesDb\.js"/;

    for (const [key, filePath] of Object.entries(MODULE_PATHS)) {
      const src = readFileSync(filePath, "utf8");
      assert.ok(
        !BARREL_BACK_IMPORT_RE.test(src),
        `Module '${key}' (${filePath}) must NOT import the barrel '../salesDb.js' — no back-edges allowed`,
      );
    }

    // Confirm the barrel itself imports all 9 modules
    const barrelSrc = readFileSync(BARREL_PATH, "utf8");
    const expectedBarrelImports = [
      "./sales/schema.js",
      "./sales/url-normalize.js",
      "./sales/raw-candidates.js",
      "./sales/leads.js",
      "./sales/drafts.js",
      "./sales/timeline.js",
      "./sales/accounts.js",
      "./sales/scores.js",
      "./sales/auto-run.js",
    ];
    for (const imp of expectedBarrelImports) {
      assert.ok(
        barrelSrc.includes(imp),
        `Barrel must import '${imp}'; not found in salesDb.ts`,
      );
    }
  });
});

// ─── T-P72s4.Schema.1 ─────────────────────────────────────────────────────────

describe("T-P72s4.Schema — openSalesDatabase creates same tables, indexes, and schema_version", () => {
  it("T-P72s4.Schema.1: when openSalesDatabase(':memory:') is called post-split, sqlite_master deep-equals the pre-split snapshot fixture", async () => {
    // Given: the canonical pre-split snapshot at tests/persistence/_fixtures/salesDb-schema-snapshot.json
    // When:  a fresh :memory: DB is opened via the post-split openSalesDatabase
    // Then:  SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name
    //        deep-equals snapshot.tables_and_indexes
    const snapshotPath = resolve(repoRoot, "tests/persistence/_fixtures/salesDb-schema-snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      tables_and_indexes: Array<{ name: string; type: string; sql: string | null }>;
      schema_version_max: number;
    };

    // Use a unique temp file to avoid cache collision with other tests in the same process
    const { openSalesDatabase, closeSalesDatabase } = await import("../../src/persistence/salesDb.js");
    const tmpPath = join(tmpdir(), `p72s4-schema1-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(tmpPath);

    const rows = db
      .prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as Array<{ name: string; type: string; sql: string | null }>;

    assert.deepStrictEqual(
      rows,
      snapshot.tables_and_indexes,
      "sqlite_master tables+indexes must deep-equal the pre-split snapshot fixture",
    );

    closeSalesDatabase(tmpPath);
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
  });

  it("T-P72s4.Schema.1 edge: schema_version MAX(version) is 2 after open (applyV1 + applyV2 both ran)", async () => {
    // Given: fresh :memory: DB opened post-split
    // When:  SELECT MAX(version) FROM schema_version
    // Then:  result is 2
    const { openSalesDatabase, closeSalesDatabase } = await import("../../src/persistence/salesDb.js");
    const tmpPath = join(tmpdir(), `p72s4-schema2-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(tmpPath);

    const row = db.prepare("SELECT MAX(version) AS maxVersion FROM schema_version").get() as { maxVersion: number };
    // P-AUTO-5: applyV3 added (icp_qualification column) — max version is now 3
    assert.strictEqual(row.maxVersion, 3, "schema_version MAX(version) must be 3 — applyV1 + applyV2 + applyV3 must have run");

    closeSalesDatabase(tmpPath);
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
  });

  it("T-P72s4.Schema.1 edge: message_drafts.lead_id is nullable AND kind CHECK includes 'post' (applyV2 invariant)", async () => {
    // Given: fresh :memory: DB opened post-split
    // When:  the DDL for message_drafts is read from sqlite_master
    // Then:  lead_id column has no NOT NULL constraint; kind CHECK includes 'post'
    const { openSalesDatabase, closeSalesDatabase } = await import("../../src/persistence/salesDb.js");
    const tmpPath = join(tmpdir(), `p72s4-schema3-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(tmpPath);

    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_drafts'")
      .get() as { sql: string };

    assert.ok(row, "message_drafts table must exist in sqlite_master");
    // Verify lead_id is nullable (absence of NOT NULL after lead_id column)
    assert.ok(
      !row.sql.match(/lead_id\s+TEXT\s+NOT NULL/),
      `message_drafts.lead_id must be nullable (no NOT NULL); DDL: ${row.sql}`,
    );
    // Verify 'post' is in the kind CHECK enum (applyV2 invariant)
    assert.ok(
      row.sql.includes("'post'"),
      `message_drafts.kind CHECK must include 'post' (applyV2); DDL: ${row.sql}`,
    );

    closeSalesDatabase(tmpPath);
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
  });

  it("T-P72s4.Schema.1 edge: named partial indexes idx_drafts_lead, idx_drafts_status, idx_timeline_lead (partial), idx_leads_due (partial), idx_ledger_lead (partial) all exist", async () => {
    // Given: fresh :memory: DB opened post-split
    // When:  SELECT name FROM sqlite_master WHERE type='index' ORDER BY name
    // Then:  all 5 named indexes appear in the result set
    const { openSalesDatabase, closeSalesDatabase } = await import("../../src/persistence/salesDb.js");
    const tmpPath = join(tmpdir(), `p72s4-schema4-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(tmpPath);

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as Array<{ name: string }>;
    const indexNames = rows.map((r) => r.name);

    const requiredIndexes = [
      "idx_drafts_lead",
      "idx_drafts_status",
      "idx_timeline_lead",
      "idx_leads_due",
      "idx_ledger_lead",
    ];

    for (const idx of requiredIndexes) {
      assert.ok(
        indexNames.includes(idx),
        `Index '${idx}' must exist in sqlite_master; found: [${indexNames.filter((n) => !n.startsWith("sqlite_")).join(", ")}]`,
      );
    }

    closeSalesDatabase(tmpPath);
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
  });
});

// ─── T-P72s4.Importer.1 ──────────────────────────────────────────────────────

describe("T-P72s4.Importer — representative importer sample compiles and resolves post-split", () => {
  it("T-P72s4.Importer.1: when 5 representative importers are dynamically imported, each resolves without throw and its imported functions are callable", async () => {
    // Given: the 5-importer sample from plan §5:
    //   src/cli/subcommands/analytics.ts        (CLI; DEFAULT_SALES_DB_PATH, closeSalesDatabase, openSalesDatabase)
    //   src/tools/sales/recordRawCandidate.ts   (sales tool; appendTimelineEvent, getRawCandidate, upsertRawCandidate)
    //   src/tools/sales/endAutoRun.ts           (sales tool; countAutoLedgerByAction, endAutoRun, getAutoRun)
    //   tests/sales/leadContext.test.ts         (test; multi-line type + repo import)
    //   tests/sales/salesDb.schema.test.ts      (test; closeSalesDatabase, openSalesDatabase, CURRENT_SCHEMA_VERSION)
    // When:  each file is dynamically imported via tsx
    // Then:  no ERR_MODULE_NOT_FOUND or TypeError; each imported function is typeof 'function'

    // Analytics CLI — imports DEFAULT_SALES_DB_PATH, closeSalesDatabase, openSalesDatabase
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for resolution check
    const analyticsMod = await import("../../src/cli/subcommands/analytics.js") as Record<string, any>;
    assert.strictEqual(typeof analyticsMod.runAnalyticsSubcommand, "function",
      "analytics.ts must export runAnalyticsSubcommand as a function");

    // recordRawCandidate.ts — imports appendTimelineEvent, getRawCandidate, upsertRawCandidate from barrel
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for resolution check
    const recordRawMod = await import("../../src/tools/sales/recordRawCandidate.js") as Record<string, any>;
    assert.strictEqual(typeof recordRawMod.makeRecordRawCandidateTool, "function",
      "recordRawCandidate.ts must export makeRecordRawCandidateTool as a function");

    // endAutoRun.ts — imports countAutoLedgerByAction, endAutoRun, getAutoRun from barrel
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for resolution check
    const endAutoRunMod = await import("../../src/tools/sales/endAutoRun.js") as Record<string, any>;
    assert.strictEqual(typeof endAutoRunMod.makeEndAutoRunTool, "function",
      "endAutoRun.ts must export makeEndAutoRunTool as a function");

    // tests/sales/salesDb.schema.test.ts — verify the import block (CURRENT_SCHEMA_VERSION etc.) resolves
    // via the barrel by statically reading the import lines + confirming the barrel exports match.
    // NOTE: we do NOT dynamic-import test files here because that would register their it.skip() blocks
    // as side effects, inflating the skip count in the full test:fast suite run.
    // Instead, verify the key symbol (CURRENT_SCHEMA_VERSION) directly via the barrel:
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for resolution check
    const barrelForSchemaCheck = await import("../../src/persistence/salesDb.js") as Record<string, any>;
    // P-AUTO-5: CURRENT_SCHEMA_VERSION bumped from 1 to 3 (reflects actual max after applyV3)
    assert.strictEqual(
      barrelForSchemaCheck.CURRENT_SCHEMA_VERSION,
      3,
      "CURRENT_SCHEMA_VERSION must be 3 via barrel (P-AUTO-5 bump — runner now reaches v3)",
    );
    assert.strictEqual(typeof barrelForSchemaCheck.closeSalesDatabase, "function",
      "closeSalesDatabase must be callable via barrel (salesDb.schema.test.ts imports this)");
    assert.strictEqual(typeof barrelForSchemaCheck.openSalesDatabase, "function",
      "openSalesDatabase must be callable via barrel (salesDb.schema.test.ts imports this)");

    // tests/sales/leadContext.test.ts — verify its imports resolve via the barrel
    // (appendTimelineEvent, closeSalesDatabase, insertLead, openSalesDatabase)
    // Again: do NOT dynamic-import the test file — it would register tests as side effects.
    assert.strictEqual(typeof barrelForSchemaCheck.appendTimelineEvent, "function",
      "appendTimelineEvent must be callable via barrel (leadContext.test.ts imports this)");
    assert.strictEqual(typeof barrelForSchemaCheck.insertLead, "function",
      "insertLead must be callable via barrel (leadContext.test.ts imports this)");
  });

  it("T-P72s4.Importer.1 edge: tests/sales/_fixtures/salesDb.ts dynamic import resolves openSalesDatabase through the barrel", async () => {
    // Given: tests/sales/_fixtures/salesDb.ts does `await import('../../../src/persistence/salesDb.js')`
    // When:  the fixture module is loaded
    // Then:  openSalesDatabase is a function and mkTestSalesDb can be called without throw
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import for resolution check
    const fixtureMod = await import("../../tests/sales/_fixtures/salesDb.js") as Record<string, any>;
    assert.strictEqual(
      typeof fixtureMod.mkTestSalesDb,
      "function",
      "tests/sales/_fixtures/salesDb.ts must export mkTestSalesDb as a function",
    );

    // mkTestSalesDb internally does a dynamic import of salesDb.js — calling it proves
    // the barrel-chained dynamic import resolves at runtime
    const handles = await fixtureMod.mkTestSalesDb();
    assert.ok(handles.db, "mkTestSalesDb must return a db handle");
    assert.ok(typeof handles.candidateId === "string", "mkTestSalesDb must return a candidateId string");
    assert.ok(typeof handles.leadId === "string", "mkTestSalesDb must return a leadId string");
  });
});

// ─── T-P72s4.LoCBudget.1 ─────────────────────────────────────────────────────

describe("T-P72s4.LoCBudget — per-domain modules are within §3.1 LoC budgets", () => {
  it("T-P72s4.LoCBudget.1: when all 10 files (9 modules + barrel) are on disk, each is within its §3.1 LoC budget", () => {
    // Given: the 9 modules under src/persistence/sales/ + the barrel src/persistence/salesDb.ts
    // When:  fs.readFileSync(path).split('\n').length is computed for each
    // Then:  schema<=250, url-normalize<=15, raw-candidates<=90, leads<=140,
    //        drafts<=75, timeline<=75, accounts<=45, scores<=40, auto-run<=165,
    //        barrel<=80 (raised from 50 by [2a-r2] for the named export type blocks)
    //        [P-AUTO-5] schema 240→250 for the v3 applyV3 migration (icp_qualification column)
    const LOC_BUDGETS: Record<string, number> = {
      schema: 250,
      urlNormalize: 15,
      rawCandidates: 90,
      leads: 140,
      drafts: 75,
      timeline: 75,
      accounts: 45,
      scores: 40,
      autoRun: 165,
      barrel: 80,
    };

    const fileMap: Record<string, string> = {
      ...MODULE_PATHS,
      barrel: BARREL_PATH,
    };

    for (const [key, filePath] of Object.entries(fileMap)) {
      assert.ok(existsSync(filePath), `File must exist: ${filePath} (key: ${key})`);

      const lineCount = readFileSync(filePath, "utf8").split("\n").length;
      const budget = LOC_BUDGETS[key];
      assert.ok(
        budget !== undefined,
        `No LoC budget defined for key '${key}' — update LOC_BUDGETS`,
      );
      assert.ok(
        lineCount <= budget!,
        `Module '${key}' (${filePath}) has ${lineCount} lines but budget is ${budget!}`,
      );
    }
  });
});

// ─── T-P72s4.UrlNormalize.1 ──────────────────────────────────────────────────

describe("T-P72s4.UrlNormalize — normalizeProfileUrl callable via raw-candidates AND leads paths", () => {
  it("T-P72s4.UrlNormalize.1: when upsertRawCandidate and insertLead are both called with a URL containing a query string, both stored profile_url values are identical normalized forms", async () => {
    // Given: a fresh :memory: DB; raw URL = 'https://www.linkedin.com/in/alice/?utm=src'
    // When:  upsertRawCandidate is called with the raw URL (raw-candidates path)
    //        then insertLead is called with the same raw URL (leads path)
    // Then:  both stored profile_url values === normalizeProfileUrl(rawUrl)
    //        (confirms both modules correctly import from url-normalize.ts)
    const { openSalesDatabase, closeSalesDatabase, upsertRawCandidate, insertLead, normalizeProfileUrl,
            getRawCandidate, getLead } = await import("../../src/persistence/salesDb.js");

    // Use a temp file path to guarantee isolation from other tests in the same process
    const tmpPath = join(tmpdir(), `p72s4-urlnorm1-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(tmpPath);

    const rawUrl = "https://www.linkedin.com/in/alice/?utm=src";
    const expectedNormalized = normalizeProfileUrl(rawUrl);

    // Raw-candidates path: upsertRawCandidate normalizes via url-normalize.ts
    const { candidateId } = upsertRawCandidate(db, {
      personName: "Alice Test",
      profileUrl: rawUrl,
      source: "search",
    });
    const candidateRow = getRawCandidate(db, candidateId);
    assert.ok(candidateRow, "candidate row must be readable after upsert");
    assert.strictEqual(
      candidateRow!.profileUrl,
      expectedNormalized,
      `raw_candidates.profile_url must equal normalizeProfileUrl(rawUrl); got '${candidateRow!.profileUrl}' expected '${expectedNormalized}'`,
    );

    // Leads path: insertLead normalizes via url-normalize.ts
    const leadId = insertLead(db, {
      candidateId,
      personName: "Alice Test",
      profileUrl: rawUrl,
      stage: "qualified",
      ownerMode: "manual",
    });
    const leadRow = getLead(db, leadId);
    assert.ok(leadRow, "lead row must be readable after insert");
    assert.strictEqual(
      leadRow!.profileUrl,
      expectedNormalized,
      `leads.profile_url must equal normalizeProfileUrl(rawUrl); got '${leadRow!.profileUrl}' expected '${expectedNormalized}'`,
    );

    // Both paths must produce the identical normalized form
    assert.strictEqual(
      candidateRow!.profileUrl,
      leadRow!.profileUrl,
      "raw_candidates.profile_url and leads.profile_url must be identical normalized forms",
    );

    closeSalesDatabase(tmpPath);
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
  });

  it("T-P72s4.UrlNormalize.1 edge: normalizeProfileUrl imported directly from url-normalize module produces same result as via barrel", async () => {
    // Given: the shared URL 'https://www.linkedin.com/in/bob'
    // When:  normalizeProfileUrl is called from the direct url-normalize module import
    //        AND from the barrel import
    // Then:  both return 'https://www.linkedin.com/in/bob/' (trailing slash normalized)
    const { normalizeProfileUrl: directFn } = await import("../../src/persistence/sales/url-normalize.js");
    const { normalizeProfileUrl: barrelFn } = await import("../../src/persistence/salesDb.js");

    const testUrl = "https://www.linkedin.com/in/bob";
    const expected = "https://www.linkedin.com/in/bob/";

    assert.strictEqual(directFn(testUrl), expected, "direct url-normalize import must append trailing slash");
    assert.strictEqual(barrelFn(testUrl), expected, "barrel-routed normalizeProfileUrl must append trailing slash");
    assert.strictEqual(
      directFn(testUrl),
      barrelFn(testUrl),
      "direct and barrel normalizeProfileUrl must produce identical results",
    );
  });
});

// ─── T-P72s4.NoDefault.1 ─────────────────────────────────────────────────────

describe("T-P72s4.NoDefault — no default export in sales/** or barrel", () => {
  it("T-P72s4.NoDefault.1: when all 10 files are read, none contains 'export default' or 'export { default'", () => {
    // Given: the 9 module files + barrel exist (after builder Step 3b)
    // When:  each file's text is checked for /^export default|^export \{ default/m
    // Then:  zero matches (pre-split salesDb.ts had no default export; post-split files inherit this)
    const DEFAULT_EXPORT_RE = /^export default|^export \{ default/m;

    const allFiles: Record<string, string> = {
      ...MODULE_PATHS,
      barrel: BARREL_PATH,
    };

    for (const [key, filePath] of Object.entries(allFiles)) {
      assert.ok(existsSync(filePath), `File must exist for NoDefault check: ${filePath} (key: ${key})`);
      const src = readFileSync(filePath, "utf8");
      assert.ok(
        !DEFAULT_EXPORT_RE.test(src),
        `File '${key}' (${filePath}) must not contain 'export default' or 'export { default' — found match`,
      );
    }
  });
});
