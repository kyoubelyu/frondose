/**
 * F-REN-4a Step 5 — T-FREN4a.Migrate.6: EXDEV rename failure
 *
 * STANDALONE FILE: Must be isolated from dataDirMigration.mock.test.ts because the
 * mock.module("node:fs") intercept must be registered BEFORE the first import of
 * dataDirMigration.ts. Once a module is cached in the ESM registry, mock.module
 * cannot replace it in the same process. This file contains ONLY the EXDEV test so
 * the mock.module + dynamic-import pattern (serve-p57f) works correctly.
 *
 * Covers:
 *   T-FREN4a.Migrate.6 — EXDEV: source preserved, rename_failed, B-3 catch re-check
 *
 * Gate coverage: B-3 (genuine-failure path — legacy still present → rename_failed)
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/persistence/dataDirMigration-exdev.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, afterEach, describe, it, mock } from "node:test";

const MIGRATION_URL = pathToFileURL(resolve(process.cwd(), "src/persistence/dataDirMigration.ts")).href;

type MigrationResult =
  | { moved: false; reason: "no_legacy" | "already_migrated" | "both_exist" | "rename_failed"; error?: string }
  | { moved: true; reason: "renamed" };

type MigrationMod = {
  DATA_DIR_NAME: string;
  LEGACY_DATA_DIR_NAME: string;
  migrateDataDir(homeBase: string): MigrationResult;
  bootMigrateOrExit(homeBase: string): void;
};

function makeTempBase(prefix: string): { base: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), `fren4a-${prefix}-`));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function writeFixture(path: string, bytes: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes, "utf-8");
}

/** Capture stderr.write calls, run fn, restore, return lines. */
function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
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
// T-FREN4a.Migrate.6 — EXDEV: source preserved, rename_failed, B-3 catch re-check
//
// mock.module("node:fs") registered BEFORE dynamic import of dataDirMigration.ts.
// The mocked renameSync throws EXDEV but does NOT move the directory, so the
// post-throw existsSync re-check sees legacy=present → genuine rename_failed.
// ---------------------------------------------------------------------------

describe("migrateDataDir — EXDEV rename failure: source preserved (T-FREN4a.Migrate.6)", () => {
  let mod: MigrationMod;
  let base: string;
  let cleanup: () => void;

  before(async () => {
    // Import the real fs FIRST to spread all other named exports.
    // Then override renameSync to throw EXDEV without moving anything.
    // CRITICAL: this mock.module call must happen BEFORE `import(MIGRATION_URL)`.
    const realFs = await import("node:fs");
    mock.module("node:fs", {
      namedExports: {
        ...realFs,
        renameSync: (_src: string, _dst: string) => {
          // Do NOT actually move the directory — legacy still present after throw
          throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
        },
      },
    });
    // Dynamic import AFTER mock registration — gets mocked renameSync
    // biome-ignore lint/suspicious/noExplicitAny: escape
    mod = (await import(MIGRATION_URL as string)) as any as MigrationMod;
  });

  beforeEach(() => {
    const tmp = makeTempBase("migrate6");
    base = tmp.base;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("T-FREN4a.Migrate.6: when renameSync throws {code:'EXDEV'} and legacy still exists, source is UNCHANGED, no .frondose created, result.reason==='rename_failed', stderr contains remediation cue", () => {
    // Given: <base>/.mai/... populated; <base>/.frondose absent; renameSync mocked to throw EXDEV
    //        The mock does NOT physically move the dir → legacy is still present after throw
    // When:  migrateDataDir(base) is called
    // Then:  <base>/.mai unchanged; <base>/.frondose NOT created; result={moved:false,reason:'rename_failed'}; stderr has /FAILED to migrate/i
    writeFixture(join(base, ".mai", "agent", "secrets.json"), "exdev-fixture");

    const { result, lines } = captureStderr(() => mod.migrateDataDir(base));

    assert.strictEqual(result.moved, false, "result.moved must be false on EXDEV");
    assert.strictEqual(result.reason, "rename_failed", "result.reason must be 'rename_failed'");
    // Source byte-intact (B-3 data-safety assertion)
    const sourcePath = join(base, ".mai", "agent", "secrets.json");
    assert.ok(existsSync(sourcePath), "<base>/.mai must still exist (source preserved)");
    assert.strictEqual(readFileSync(sourcePath, "utf-8"), "exdev-fixture",
      "<base>/.mai/agent/secrets.json bytes must be unchanged");
    // No new .frondose created
    assert.ok(!existsSync(join(base, ".frondose")), "<base>/.frondose must NOT be created on EXDEV");
    // Stderr has remediation cue
    const hasFailed = lines.some(l => /FAILED to migrate/i.test(l));
    assert.ok(hasFailed,
      `stderr must contain /FAILED to migrate/i. Got:\n  ${lines.join("  ")}`);
  });
});
