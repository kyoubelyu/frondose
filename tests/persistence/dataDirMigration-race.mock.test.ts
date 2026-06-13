/**
 * F-REN-4a Step 5 — T-FREN4a.Race.1: B-3 concurrent-winner race scenario
 *
 * STANDALONE FILE: Must be isolated from dataDirMigration.mock.test.ts because the
 * mock.module("node:fs") intercept must be registered BEFORE the first import of
 * dataDirMigration.ts. Once a module is cached in the ESM registry, mock.module
 * cannot replace it in the same process.
 *
 * Covers:
 *   T-FREN4a.Race.1 — B-3: ENOENT throw + source already moved → already_migrated
 *
 * Gate coverage: B-3 (race-safe — concurrent boot loser classified as already_migrated,
 *   NOT rename_failed, so B-2's process.exit(1) is not triggered for a healthy race loser)
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/persistence/dataDirMigration-race.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
// T-FREN4a.Race.1 — B-3: concurrent winner scenario
//
// mock.module("node:fs") registered BEFORE dynamic import of dataDirMigration.ts.
// The mocked renameSync:
//   1. Physically moves src → dst on the real filesystem (the "winner" action)
//   2. Throws ENOENT — simulating the case where the source vanished before our rename(2)
//      (i.e. a concurrent winner already moved it)
//
// The catch block re-checks: !existsSync(legacy) && existsSync(target)
//   → legacy is gone (the "winner" moved it)
//   → target exists
//   → returns already_migrated (NOT rename_failed)
// ---------------------------------------------------------------------------

describe("migrateDataDir — B-3 race-loser: ENOENT throw + source already moved → already_migrated (T-FREN4a.Race.1)", () => {
  let modRace: MigrationMod;
  let base: string;
  let cleanup: () => void;

  before(async () => {
    // Import real fs to get the real renameSync for the "winner" action inside the mock.
    const realFs = await import("node:fs");
    const realRenameSync = realFs.renameSync;
    mock.module("node:fs", {
      namedExports: {
        ...realFs,
        renameSync: (src: string, dst: string) => {
          // Simulate concurrent winner: physically perform the rename so that
          // the catch block's existsSync re-check sees the success post-condition.
          realRenameSync(src, dst);
          // Then throw ENOENT — as if we observed a race: source was already gone
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        },
      },
    });
    // Dynamic import AFTER mock registration
    // biome-ignore lint/suspicious/noExplicitAny: escape
    modRace = (await import(MIGRATION_URL as string)) as any as MigrationMod;
  });

  beforeEach(() => {
    const tmp = makeTempBase("race1");
    base = tmp.base;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("T-FREN4a.Race.1: when renameSync throws {code:'ENOENT'} because a concurrent winner already moved the dir, catch re-check sees !legacyExists&&targetExists → returns already_migrated, not rename_failed", () => {
    // Given: <base>/.mai/agent/secrets.json populated; renameSync stubbed to:
    //        (a) actually move the dir to .frondose on the real fs (simulating the concurrent winner)
    //        THEN (b) throw ENOENT — so the catch sees legacy gone and target present
    // When:  migrateDataDir(base) is called (calling the stubbed renameSync)
    // Then:  result={moved:false, reason:'already_migrated'}; no stderr error message; no process.exit
    writeFixture(join(base, ".mai", "agent", "secrets.json"), "race-fixture");

    const { result, lines } = captureStderr(() => modRace.migrateDataDir(base));

    assert.strictEqual(result.moved, false, "result.moved must be false (race-loser path)");
    assert.strictEqual(result.reason, "already_migrated",
      "result.reason must be 'already_migrated' (NOT 'rename_failed') — B-3 re-check");
    // No 'FAILED' error in stderr (the race-loser is a silent no-op, not a failure)
    const hasFailLine = lines.some(l => /FAILED/i.test(l));
    assert.ok(!hasFailLine,
      `stderr must NOT contain 'FAILED' for a race-loser. Got:\n  ${lines.join("  ")}`);
    // Target exists (the "winner" rename physically moved it)
    assert.ok(existsSync(join(base, ".frondose")),
      "<base>/.frondose must exist (the winner moved it)");
  });
});
