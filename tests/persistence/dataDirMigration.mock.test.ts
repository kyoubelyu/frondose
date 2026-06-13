/**
 * F-REN-4a Step 5 — Assertion bodies filled
 *
 * Covers the data-dir migration helper contract (real-FS tests — no renameSync mocking):
 *   T-FREN4a.Constant.1 — DATA_DIR_NAME / LEGACY_DATA_DIR_NAME values
 *   T-FREN4a.Migrate.1  — happy path: old exists, new absent → atomic rename
 *   T-FREN4a.Migrate.2  — both exist → no-op + stderr warn
 *   T-FREN4a.Migrate.3  — neither exists → no_legacy
 *   T-FREN4a.Migrate.4  — only new exists → already_migrated
 *   T-FREN4a.Migrate.5  — idempotency: second call is a no-op
 *   T-FREN4a.Migrate.7  — FRONDOSE_HOME_BASE composition
 *   T-FREN4a.Migrate.8  — legacy MAI_HOME_BASE fallback still works
 *
 * Migrate.6 (EXDEV mock) + Race.1 (concurrent-winner mock) are in separate files
 * because they require mock.module("node:fs") BEFORE the first dynamic import of the
 * production module — once the module is cached by the ESM registry in this file,
 * mock.module cannot replace it. See dataDirMigration-exdev.mock.test.ts and
 * dataDirMigration-race.mock.test.ts.
 *
 * Gate coverage: B-3 race-safe, C-2 data-safety, data-loss prevention.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/persistence/dataDirMigration.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const MIGRATION_URL = pathToFileURL(resolve(process.cwd(), "src/persistence/dataDirMigration.ts")).href;
const PATHS_URL = pathToFileURL(resolve(process.cwd(), "src/persistence/paths.ts")).href;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MigrationResult =
  | { moved: false; reason: "no_legacy" | "already_migrated" | "both_exist" | "rename_failed"; error?: string }
  | { moved: true; reason: "renamed" };

type MigrationMod = {
  DATA_DIR_NAME: string;
  LEGACY_DATA_DIR_NAME: string;
  migrateDataDir(homeBase: string): MigrationResult;
  bootMigrateOrExit(homeBase: string): void;
};

async function loadMod(): Promise<MigrationMod> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import escape
  return (await import(MIGRATION_URL as string)) as any as MigrationMod;
}

function makeTempBase(prefix: string): { base: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), `fren4a-${prefix}-`));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function writeFixture(path: string, bytes: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes, "utf-8");
}

function saveEnv(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Capture stderr.write calls into an array, run fn, restore, return lines. */
async function captureStderr<T>(fn: () => T): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: mock escape
  (process.stderr as any).write = (chunk: string | Buffer) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    const result = fn();
    return { result, lines };
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = orig;
  }
}

// ---------------------------------------------------------------------------
// T-FREN4a.Constant.1 — DATA_DIR_NAME and LEGACY_DATA_DIR_NAME values
// ---------------------------------------------------------------------------

describe("dataDirMigration constants (T-FREN4a.Constant.1)", () => {
  it("T-FREN4a.Constant.1: DATA_DIR_NAME==='.frondose' AND LEGACY_DATA_DIR_NAME==='.mai'", async () => {
    // Given: the new src/persistence/dataDirMigration module exists
    // When:  DATA_DIR_NAME and LEGACY_DATA_DIR_NAME are imported
    // Then:  DATA_DIR_NAME===".frondose" AND LEGACY_DATA_DIR_NAME===".mai"
    const mod = await loadMod();
    assert.strictEqual(mod.DATA_DIR_NAME, ".frondose",
      `DATA_DIR_NAME must be ".frondose" (got "${mod.DATA_DIR_NAME}")`);
    assert.strictEqual(mod.LEGACY_DATA_DIR_NAME, ".mai",
      `LEGACY_DATA_DIR_NAME must be ".mai" (got "${mod.LEGACY_DATA_DIR_NAME}")`);
  });
});

// ---------------------------------------------------------------------------
// T-FREN4a.Migrate.1 — happy path: old exists, new absent → atomic rename
// ---------------------------------------------------------------------------

describe("migrateDataDir — happy path: old exists, new absent (T-FREN4a.Migrate.1)", () => {
  it("T-FREN4a.Migrate.1: when <base>/.mai/agent/secrets.json exists and <base>/.frondose absent, migrateDataDir(base) renames the dir, preserves bytes, leaves source gone, result.moved===true reason==='renamed'", async () => {
    // Given: a temp base with <base>/.mai/agent/secrets.json containing fixture bytes AND no <base>/.frondose
    // When:  migrateDataDir(base) is called
    // Then:  <base>/.frondose/agent/secrets.json contains same bytes; <base>/.mai absent; result={moved:true,reason:'renamed'}
    const { base, cleanup } = makeTempBase("migrate1");
    try {
      const mod = await loadMod();
      const fixtureBytes = "fixture-secret-bytes-abc123";
      writeFixture(join(base, ".mai", "agent", "secrets.json"), fixtureBytes);
      const result = mod.migrateDataDir(base);
      assert.strictEqual(result.moved, true, "result.moved must be true");
      assert.strictEqual(result.reason, "renamed", "result.reason must be 'renamed'");
      const destPath = join(base, ".frondose", "agent", "secrets.json");
      assert.ok(existsSync(destPath), `<base>/.frondose/agent/secrets.json must exist at ${destPath}`);
      assert.strictEqual(readFileSync(destPath, "utf-8"), fixtureBytes,
        "Bytes in destination must equal source fixture bytes (data-safety assertion)");
      assert.ok(!existsSync(join(base, ".mai")), "<base>/.mai must NOT exist after migration");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// T-FREN4a.Migrate.2 — both exist → no-op + stderr warn
// ---------------------------------------------------------------------------

describe("migrateDataDir — both exist → no-op (T-FREN4a.Migrate.2)", () => {
  it("T-FREN4a.Migrate.2: when both <base>/.mai and <base>/.frondose exist with distinct file bytes, migrateDataDir does NOT overwrite either, result.reason==='both_exist', stderr warns", async () => {
    // Given: <base>/.mai/agent/secrets.json = 'fixture-A' AND <base>/.frondose/agent/secrets.json = 'fixture-B'
    // When:  migrateDataDir(base) is called
    // Then:  both files unchanged; result={moved:false, reason:'both_exist'}; stderr has /both .mai and .frondose exist/i
    const { base, cleanup } = makeTempBase("migrate2");
    try {
      const mod = await loadMod();
      const maiPath = join(base, ".mai", "agent", "secrets.json");
      const frondosePath = join(base, ".frondose", "agent", "secrets.json");
      writeFixture(maiPath, "fixture-A");
      writeFixture(frondosePath, "fixture-B");
      const { result, lines } = await captureStderr(() => mod.migrateDataDir(base));
      assert.strictEqual(result.moved, false, "result.moved must be false");
      assert.strictEqual(result.reason, "both_exist", "result.reason must be 'both_exist'");
      assert.strictEqual(readFileSync(maiPath, "utf-8"), "fixture-A",
        "<base>/.mai/agent/secrets.json must still contain 'fixture-A'");
      assert.strictEqual(readFileSync(frondosePath, "utf-8"), "fixture-B",
        "<base>/.frondose/agent/secrets.json must still contain 'fixture-B' (destination is sacred)");
      const hasWarn = lines.some(l => /both.*and.*exist/i.test(l));
      assert.ok(hasWarn,
        `stderr must contain a line matching /both.*and.*exist/i. Got:\n  ${lines.join("  ")}`);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// T-FREN4a.Migrate.3 — neither exists → no_legacy
// ---------------------------------------------------------------------------

describe("migrateDataDir — neither exists → no_legacy (T-FREN4a.Migrate.3)", () => {
  it("T-FREN4a.Migrate.3: when neither <base>/.mai nor <base>/.frondose exist, migrateDataDir returns {moved:false, reason:'no_legacy'} with no fs change", async () => {
    // Given: a fresh temp base with neither .mai nor .frondose
    // When:  migrateDataDir(base) is called
    // Then:  no filesystem change; result={moved:false, reason:'no_legacy'}
    const { base, cleanup } = makeTempBase("migrate3");
    try {
      const mod = await loadMod();
      const result = mod.migrateDataDir(base);
      assert.strictEqual(result.moved, false, "result.moved must be false");
      assert.strictEqual(result.reason, "no_legacy", "result.reason must be 'no_legacy'");
      assert.ok(!existsSync(join(base, ".mai")), "<base>/.mai must not exist");
      assert.ok(!existsSync(join(base, ".frondose")), "<base>/.frondose must not exist");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// T-FREN4a.Migrate.4 — only new exists → already_migrated
// ---------------------------------------------------------------------------

describe("migrateDataDir — only .frondose exists → already_migrated (T-FREN4a.Migrate.4)", () => {
  it("T-FREN4a.Migrate.4: when only <base>/.frondose exists (post-migration steady state), migrateDataDir returns {moved:false, reason:'already_migrated'} with no fs change", async () => {
    // Given: <base>/.frondose/agent/secrets.json exists; <base>/.mai absent
    // When:  migrateDataDir(base) is called
    // Then:  no change; result={moved:false, reason:'already_migrated'}
    const { base, cleanup } = makeTempBase("migrate4");
    try {
      const mod = await loadMod();
      const frondosePath = join(base, ".frondose", "agent", "secrets.json");
      writeFixture(frondosePath, "steady-state-bytes");
      const result = mod.migrateDataDir(base);
      assert.strictEqual(result.moved, false, "result.moved must be false");
      assert.strictEqual(result.reason, "already_migrated", "result.reason must be 'already_migrated'");
      assert.ok(!existsSync(join(base, ".mai")), "<base>/.mai must not exist");
      assert.strictEqual(readFileSync(frondosePath, "utf-8"), "steady-state-bytes",
        "<base>/.frondose/agent/secrets.json must be unchanged");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// T-FREN4a.Migrate.5 — idempotency: second call is a no-op
// ---------------------------------------------------------------------------

describe("migrateDataDir — idempotency: second call after successful migration (T-FREN4a.Migrate.5)", () => {
  it("T-FREN4a.Migrate.5: calling migrateDataDir(base) twice returns already_migrated on the second call with no stderr noise", async () => {
    // Given: the post-condition of Migrate.1 (old absent, new exists) after a first successful migration
    // When:  migrateDataDir(base) is called a SECOND time
    // Then:  result2={moved:false, reason:'already_migrated'}; no stderr emitted on the second call
    const { base, cleanup } = makeTempBase("migrate5");
    try {
      const mod = await loadMod();
      writeFixture(join(base, ".mai", "agent", "secrets.json"), "idempotency-fixture");
      // First call (migrates)
      const result1 = mod.migrateDataDir(base);
      assert.strictEqual(result1.moved, true, "First call: result.moved must be true");
      // Second call — capture stderr to assert silence
      const { result: result2, lines } = await captureStderr(() => mod.migrateDataDir(base));
      assert.strictEqual(result2.moved, false, "Second call: result.moved must be false");
      assert.strictEqual(result2.reason, "already_migrated",
        "Second call: result.reason must be 'already_migrated'");
      assert.strictEqual(lines.length, 0,
        `Second call must emit no stderr (got ${lines.length} lines: ${lines.join("|")})`);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// T-FREN4a.Migrate.7 — FRONDOSE_HOME_BASE composition
// ---------------------------------------------------------------------------

describe("migrateDataDir — composes with FRONDOSE_HOME_BASE (T-FREN4a.Migrate.7)", () => {
  it("T-FREN4a.Migrate.7: when FRONDOSE_HOME_BASE points to a temp dir and the entrypoint calls migrateDataDir(getHomeBase()), migration runs relative to that temp dir", async () => {
    // Given: FRONDOSE_HOME_BASE=<tempBase>; <tempBase>/.mai/agent/secrets.json populated; <tempBase>/.frondose absent
    // When:  migrateDataDir(getHomeBase()) is called (getHomeBase() reads FRONDOSE_HOME_BASE)
    // Then:  <tempBase>/.frondose/agent/secrets.json exists with fixture bytes; <tempBase>/.mai absent
    const { base, cleanup } = makeTempBase("migrate7");
    const saved = saveEnv("FRONDOSE_HOME_BASE", "MAI_HOME_BASE");
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic-import escape
      const { getHomeBase } = (await import(PATHS_URL as string)) as any;
      const mod = await loadMod();
      writeFixture(join(base, ".mai", "agent", "secrets.json"), "frondose-home-base-fixture");
      process.env.FRONDOSE_HOME_BASE = base;
      delete process.env.MAI_HOME_BASE;
      const resolvedBase = getHomeBase();
      assert.strictEqual(resolvedBase, base,
        `getHomeBase() must return the FRONDOSE_HOME_BASE value (got "${resolvedBase}")`);
      const result = mod.migrateDataDir(resolvedBase);
      assert.strictEqual(result.moved, true, "result.moved must be true");
      assert.strictEqual(result.reason, "renamed", "result.reason must be 'renamed'");
      const destPath = join(base, ".frondose", "agent", "secrets.json");
      assert.ok(existsSync(destPath), "<tempBase>/.frondose/agent/secrets.json must exist after migration");
      assert.strictEqual(readFileSync(destPath, "utf-8"), "frondose-home-base-fixture",
        "Bytes preserved in destination");
      assert.ok(!existsSync(join(base, ".mai")), "<tempBase>/.mai must NOT exist after migration");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// T-FREN4a.Migrate.8 — legacy MAI_HOME_BASE fallback still works
// ---------------------------------------------------------------------------

describe("migrateDataDir — legacy MAI_HOME_BASE fallback (T-FREN4a.Migrate.8)", () => {
  it("T-FREN4a.Migrate.8: when FRONDOSE_HOME_BASE is unset and MAI_HOME_BASE points to a temp dir, getHomeBase() returns that temp dir and migration runs there correctly", async () => {
    // Given: FRONDOSE_HOME_BASE unset; MAI_HOME_BASE=<tempBase>; fixture under <tempBase>/.mai/...
    // When:  migrateDataDir(getHomeBase()) is called
    // Then:  migration uses <tempBase>; result equivalent to Migrate.1
    const { base, cleanup } = makeTempBase("migrate8");
    const saved = saveEnv("FRONDOSE_HOME_BASE", "MAI_HOME_BASE");
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic-import escape
      const { getHomeBase } = (await import(PATHS_URL as string)) as any;
      const mod = await loadMod();
      writeFixture(join(base, ".mai", "agent", "secrets.json"), "mai-home-base-fixture");
      delete process.env.FRONDOSE_HOME_BASE;
      process.env.MAI_HOME_BASE = base;
      const resolvedBase = getHomeBase();
      assert.strictEqual(resolvedBase, base,
        `getHomeBase() must return the MAI_HOME_BASE value (F-REN-3 ?? shim) (got "${resolvedBase}")`);
      const result = mod.migrateDataDir(resolvedBase);
      assert.strictEqual(result.moved, true, "result.moved must be true");
      assert.strictEqual(result.reason, "renamed", "result.reason must be 'renamed'");
      const destPath = join(base, ".frondose", "agent", "secrets.json");
      assert.ok(existsSync(destPath), "<tempBase>/.frondose/agent/secrets.json must exist after migration");
      assert.strictEqual(readFileSync(destPath, "utf-8"), "mai-home-base-fixture",
        "Bytes preserved in destination");
    } finally {
      restoreEnv(saved);
      cleanup();
    }
  });
});
