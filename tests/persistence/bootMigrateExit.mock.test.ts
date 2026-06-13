/**
 * F-REN-4a Step 5 — Assertion bodies filled: bootMigrateOrExit fail-closed behavior
 *
 * Covers:
 *   T-FREN4a.FailClosed.1 — B-2: bootMigrateOrExit + rename_failed → process.exit(1),
 *                            stderr matches /FAILED to migrate/i, NO new files created
 *                            under <base>/.frondose before the exit.
 *
 * Mock strategy: Because dataDirMigration.ts uses destructured `import { renameSync }`,
 * we must use mock.module("node:fs", ...) BEFORE the dynamic import of the module under
 * test so the mocked renameSync reaches the local binding. This describe block uses a
 * before() hook to set up the mock and do the dynamic import (serve-p57f pattern).
 *
 * process.exit is stubbed via mock.method(process, "exit") — process.exit IS a
 * configurable property and mock.method works on it in Node v25. The stub throws a
 * sentinel Error so we can assert no further writes occur.
 *
 * Gate coverage: B-2 (fail-closed policy)
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/persistence/bootMigrateExit.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, afterEach, describe, it, mock } from "node:test";

const MIGRATION_SRC = resolve(process.cwd(), "src/persistence/dataDirMigration.ts");
const MIGRATION_URL = pathToFileURL(MIGRATION_SRC).href;

type MigrationMod = {
  DATA_DIR_NAME: string;
  LEGACY_DATA_DIR_NAME: string;
  migrateDataDir(homeBase: string): { moved: boolean; reason: string; error?: string };
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

// ---------------------------------------------------------------------------
// T-FREN4a.FailClosed.1 — B-2: rename_failed → process.exit(1), no .frondose writes
// ---------------------------------------------------------------------------

describe("bootMigrateOrExit — B-2 fail-closed: rename_failed exits with code 1 (T-FREN4a.FailClosed.1)", () => {
  let mod: MigrationMod;
  let base: string;
  let cleanup: () => void;

  before(async () => {
    // Register the node:fs mock with renameSync throwing EXDEV BEFORE dynamic import.
    const realFs = await import("node:fs");
    mock.module("node:fs", {
      namedExports: {
        ...realFs,
        renameSync: (_src: string, _dst: string) => {
          throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
        },
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: mock escape
    mod = (await import(MIGRATION_URL as string)) as any as MigrationMod;
  });

  beforeEach(() => {
    const tmp = makeTempBase("failclosed1");
    base = tmp.base;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("T-FREN4a.FailClosed.1: when renameSync throws EXDEV, bootMigrateOrExit calls process.exit(1), stderr=/FAILED to migrate/i, and NO files are created under <base>/.frondose", async () => {
    // Given: <base>/.mai/... populated; <base>/.frondose absent; renameSync mocked to throw EXDEV
    //        process.exit stubbed to capture exit code
    // When:  bootMigrateOrExit(base) is invoked
    // Then:  process.exit called with code 1; stderr contains /FAILED to migrate/i;
    //        existsSync(<base>/.frondose/agent/secrets.json) === false (no boot proceeds)
    //        existsSync(<base>/.frondose/agent/logs/crash.log) === false (crash handler never ran)
    //        existsSync(<base>/.frondose/agent/update.lock) === false (auto-update never ran)
    writeFixture(join(base, ".mai", "agent", "secrets.json"), "failclosed-fixture");

    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: mock
    (process.stderr as any).write = (chunk: string | Buffer) => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    // Stub process.exit: capture the code and throw a sentinel so no further code runs
    mock.method(process, "exit", (code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code}) captured`);
    });

    let caughtExitSignal = false;
    try {
      mod.bootMigrateOrExit(base);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("process.exit(")) {
        caughtExitSignal = true;
      } else {
        throw err;
      }
    } finally {
      mock.method(process, "exit", origExit);
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = origStderrWrite;
    }

    // B-2 assertions
    assert.ok(caughtExitSignal, "process.exit must have been called (caughtExitSignal must be true)");
    assert.strictEqual(exitCode, 1, `process.exit must be called with code 1 (got ${exitCode})`);

    const hasFailedLine = stderrLines.some(l => /FAILED to migrate/i.test(l));
    assert.ok(hasFailedLine,
      `stderr must contain /FAILED to migrate/i. Got:\n  ${stderrLines.join("  ")}`);

    // No .frondose files created before the exit (data-safety: no fresh empty profile boot)
    assert.ok(!existsSync(join(base, ".frondose", "agent", "secrets.json")),
      "<base>/.frondose/agent/secrets.json must NOT exist (no boot proceeded)");
    assert.ok(!existsSync(join(base, ".frondose", "agent", "logs", "crash.log")),
      "<base>/.frondose/agent/logs/crash.log must NOT exist (crash handler never ran)");
    assert.ok(!existsSync(join(base, ".frondose", "agent", "update.lock")),
      "<base>/.frondose/agent/update.lock must NOT exist (auto-update never ran)");
    // Source preserved (the migrator never deletes source unless rename succeeds)
    assert.ok(existsSync(join(base, ".mai", "agent", "secrets.json")),
      "<base>/.mai/agent/secrets.json must still exist (source is INTACT)");
  });
});
