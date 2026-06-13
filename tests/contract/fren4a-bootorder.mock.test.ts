/**
 * F-REN-4a Step 5 — Assertion bodies filled: boot-order static analysis
 *
 * Covers:
 *   T-FREN4a.BootOrder.1 — B-1: static scan each of the 5 entrypoint files and assert
 *     that the first `migrateDataDir(` / `bootMigrateOrExit(` line appears STRICTLY BEFORE
 *     the first `registerCrashHandlers(` call (in the 3 entrypoints that call it) and
 *     STRICTLY BEFORE the first `runStartupAutoUpdate(` call (in cli/main.ts).
 *     For telegramDaemon + server.ts: `bootMigrateOrExit(` appears before any
 *     `path.join(getHomeBase(),` / `getHomeBase()` path-construction call.
 *
 * Gate coverage: B-1 (migrate-before-crash-handler ordering invariant)
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/contract/fren4a-bootorder.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the 1-based line number of the FIRST non-comment line in `text` that matches
 * `pattern`. Comment lines (starting with optional whitespace + `//`) are skipped.
 * Returns Infinity if not found.
 *
 * Skipping comment lines prevents false positives from prose like:
 *   //   - registerCrashHandlers() FIRST (static import) ...
 * which would otherwise match before the actual function call.
 */
function firstMatchLine(text: string, pattern: RegExp): number {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip single-line comments
    if (/^\s*\/\//.test(line)) continue;
    if (pattern.test(line)) return i + 1;
  }
  return Infinity;
}

function readFile(relPath: string): string {
  return readFileSync(join(REPO, relPath), "utf-8");
}

// ---------------------------------------------------------------------------
// T-FREN4a.BootOrder.1 — migration is the FIRST data-dir-touching call in every entrypoint
// ---------------------------------------------------------------------------

describe("B-1 boot-order invariant: bootMigrateOrExit precedes registerCrashHandlers + runStartupAutoUpdate in all 5 entrypoints (T-FREN4a.BootOrder.1)", () => {
  // ── sidecarMain ──────────────────────────────────────────────────────────

  it("T-FREN4a.BootOrder.1-sidecarMain: in src/app/sidecarMain.ts, first bootMigrateOrExit( line < first registerCrashHandlers( line", () => {
    // Given: src/app/sidecarMain.ts after Step 4 (bootMigrateOrExit call inserted per §6.4 S-3)
    // When:  first-match line numbers are extracted with grep-equivalent scan
    // Then:  firstMatchLine(bootMigrateOrExit|migrateDataDir) < firstMatchLine(registerCrashHandlers)
    const text = readFile("src/app/sidecarMain.ts");
    const migrateLine = firstMatchLine(text, /bootMigrateOrExit\(|migrateDataDir\(/);
    const crashLine = firstMatchLine(text, /registerCrashHandlers\(/);

    assert.notStrictEqual(migrateLine, Infinity,
      "src/app/sidecarMain.ts must contain bootMigrateOrExit( or migrateDataDir( (Step 4 not applied if Infinity)");
    assert.ok(migrateLine < crashLine,
      `B-1 violation in sidecarMain.ts: migrateLine (${migrateLine}) must be < crashLine (${crashLine})`);
  });

  // ── updateServerMain ─────────────────────────────────────────────────────

  it("T-FREN4a.BootOrder.1-updateServerMain: in src/app/updateServerMain.ts, first bootMigrateOrExit( line < first registerCrashHandlers( line", () => {
    // Given: src/app/updateServerMain.ts after Step 4
    // When:  first-match line numbers scanned
    // Then:  migrateLine < crashLine
    const text = readFile("src/app/updateServerMain.ts");
    const migrateLine = firstMatchLine(text, /bootMigrateOrExit\(|migrateDataDir\(/);
    const crashLine = firstMatchLine(text, /registerCrashHandlers\(/);

    assert.notStrictEqual(migrateLine, Infinity,
      "src/app/updateServerMain.ts must contain bootMigrateOrExit( (Step 4 not applied if Infinity)");
    assert.ok(migrateLine < crashLine,
      `B-1 violation in updateServerMain.ts: migrateLine (${migrateLine}) must be < crashLine (${crashLine})`);
  });

  // ── cli/main.ts ───────────────────────────────────────────────────────────

  it("T-FREN4a.BootOrder.1-cliMain: in src/cli/main.ts, first bootMigrateOrExit( line < first registerCrashHandlers( line AND < first runStartupAutoUpdate( line", () => {
    // Given: src/cli/main.ts after Step 4
    // When:  first-match lines scanned for all three targets
    // Then:  migrateLine < crashLine AND migrateLine < autoUpdateLine
    const text = readFile("src/cli/main.ts");
    const migrateLine = firstMatchLine(text, /bootMigrateOrExit\(|migrateDataDir\(/);
    const crashLine = firstMatchLine(text, /registerCrashHandlers\(/);
    const autoUpdateLine = firstMatchLine(text, /runStartupAutoUpdate\(/);

    assert.notStrictEqual(migrateLine, Infinity,
      "src/cli/main.ts must contain bootMigrateOrExit( (Step 4 not applied if Infinity)");
    assert.ok(migrateLine < crashLine,
      `B-1 violation in cli/main.ts: migrateLine (${migrateLine}) must be < crashLine (${crashLine})`);
    assert.ok(migrateLine < autoUpdateLine,
      `B-1 violation in cli/main.ts: migrateLine (${migrateLine}) must be < autoUpdateLine (${autoUpdateLine})`);
  });

  // ── telegramDaemon ────────────────────────────────────────────────────────

  it("T-FREN4a.BootOrder.1-telegramDaemon: in src/cli/subcommands/telegramDaemon.ts, first bootMigrateOrExit( line appears as the FIRST body statement of runTelegramDaemon() (before any TELEGRAM_PID() call or path.join(getHomeBase() inside the function body)", () => {
    // Given: src/cli/subcommands/telegramDaemon.ts after Step 4
    // When:  first-match lines scanned for bootMigrateOrExit and the first path CALL inside the function
    // Then:  migrateLine < firstPathCallInsideFunction
    //
    // Note: TELEGRAM_PID and REPL_PID are module-level lazy getters (arrow functions). Their
    // DEFINITIONS do not execute getHomeBase() at module load time — only the CALLS inside
    // runTelegramDaemon() do. We find the function body start line (export async function
    // runTelegramDaemon()) and then search only within the function body.
    const text = readFile("src/cli/subcommands/telegramDaemon.ts");
    const lines = text.split("\n");

    // Find the start of runTelegramDaemon's body (the opening brace line)
    const funcStart = lines.findIndex(l => /export\s+(async\s+)?function\s+runTelegramDaemon/.test(l));
    assert.ok(funcStart >= 0,
      "runTelegramDaemon function must exist in telegramDaemon.ts");

    // Search from the function start for migrate call and first path invocation
    // within the function body (NOT module-level const definitions before the function).
    let migrateLine = Infinity;
    let firstPathCall = Infinity;
    for (let i = funcStart; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^\s*\/\//.test(line)) continue; // skip comments
      if (migrateLine === Infinity && /bootMigrateOrExit\(|migrateDataDir\(/.test(line)) {
        migrateLine = i + 1;
      }
      // First path call inside function: TELEGRAM_PID() as an invocation (not definition),
      // or path.join(getHomeBase() as an inline call
      if (firstPathCall === Infinity && /TELEGRAM_PID\(\)|REPL_PID\(\)|path\.join\s*\(\s*getHomeBase\s*\(\)/.test(line)) {
        firstPathCall = i + 1;
      }
      if (migrateLine !== Infinity && firstPathCall !== Infinity) break;
    }

    assert.notStrictEqual(migrateLine, Infinity,
      "runTelegramDaemon() must contain bootMigrateOrExit( in its body (Step 4 not applied if Infinity)");
    assert.ok(migrateLine < firstPathCall,
      `B-1 violation in telegramDaemon.ts: bootMigrateOrExit (line ${migrateLine}) must appear before first path call inside function body (line ${firstPathCall})`);
  });

  // ── server.ts (runServerSubcommand) ───────────────────────────────────────

  it("T-FREN4a.BootOrder.1-serverSubcommand: in src/cli/subcommands/server.ts, first bootMigrateOrExit( line appears before the action-dispatch switch and before any path.join(getHomeBase() call", () => {
    // Given: src/cli/subcommands/server.ts after Step 4
    // When:  first-match lines scanned for bootMigrateOrExit and the switch statement
    // Then:  migrateLine < firstSwitchLine AND migrateLine < firstPathResolutionLine
    const text = readFile("src/cli/subcommands/server.ts");
    const migrateLine = firstMatchLine(text, /bootMigrateOrExit\(|migrateDataDir\(/);
    // Look for the switch(action) dispatch in runServerSubcommand
    const switchLine = firstMatchLine(text, /switch\s*\(action\)/);
    const firstPathCall = firstMatchLine(text, /path\.join\(getHomeBase\(\)/);

    assert.notStrictEqual(migrateLine, Infinity,
      "src/cli/subcommands/server.ts must contain bootMigrateOrExit( (Step 4 not applied if Infinity)");
    assert.ok(migrateLine < switchLine,
      `B-1 violation in server.ts: migrateLine (${migrateLine}) must be < switchLine (${switchLine})`);
    assert.ok(migrateLine < firstPathCall,
      `B-1 violation in server.ts: migrateLine (${migrateLine}) must be < firstPathCall (${firstPathCall})`);
  });
});
