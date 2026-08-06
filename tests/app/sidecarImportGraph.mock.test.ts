/**
 * P-APP-6 Step 3a — Import-graph scaffold for dist/app/sidecarMain.js
 * (P-OPEN-SOURCE-SPLIT: updated to the final App boot seam — the sidecar boots
 * through ./backend.js#runAppBackend; the CLI serve graph is retired.)
 *
 * Covers:
 *   T-Sidecar.Imports.1 — compiled entry omits "commander"; contains "--port-file",
 *                          "--token", "runAppBackend"
 *   T-Sidecar.Imports.2 — top-level static imports in sidecarMain.ts are ONLY the
 *                          crash logger + the App backend turn scheduler + the
 *                          App Telegram adapter + env; no CLI paths, no main.js,
 *                          no commander; ./backend.js is dynamic-only
 *
 * Strategy: post-build file content scan (source for Imports.2; dist for Imports.1).
 * These tests are intentionally red pre-impl because dist/app/sidecarMain.js does not exist.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/app/sidecarImportGraph.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());
const DIST_SIDECAR = resolve(REPO, "dist/app/sidecarMain.js");
const SRC_SIDECAR = resolve(REPO, "src/app/sidecarMain.ts");

describe("T-Sidecar.Imports — compiled entry import graph", () => {
  it("T-Sidecar.Imports.1: dist/app/sidecarMain.js does NOT contain 'commander' or the CLI entry; DOES contain '--port-file', '--token', 'runAppBackend'", () => {
    // Given: dist/app/sidecarMain.js exists after npm run build
    // When:  validator reads the file contents
    // Then:  "commander" and "cli/main" do NOT appear; "--port-file", "--token", "runAppBackend" DO appear
    // P-OPEN-SOURCE-SPLIT Step 5: the exported App root ships source (dist is a
    // build output) — the same entry-surface contract is scanned on the source
    // entry there; the compiled scan applies in the writable repo after a build.
    const entryFile = existsSync(DIST_SIDECAR) ? DIST_SIDECAR : join(REPO, "src/app/sidecarMain.ts");
    const contents = readFileSync(entryFile, "utf8");
    assert.ok(!contents.includes("commander"), "dist/app/sidecarMain.js must NOT contain 'commander'");
    assert.ok(
      !contents.includes("cli/main"),
      "dist/app/sidecarMain.js must NOT reference the CLI entry (T-RETIRE.CLI.1)",
    );
    assert.ok(contents.includes("--port-file"), "dist/app/sidecarMain.js must contain '--port-file'");
    assert.ok(contents.includes("--token"), "dist/app/sidecarMain.js must contain '--token'");
    assert.ok(
      contents.includes("runAppBackend"),
      "dist/app/sidecarMain.js must contain 'runAppBackend' (the final App backend seam)",
    );
  });

  it("T-Sidecar.Imports.2: src/app/sidecarMain.ts top-level static imports are ONLY the App-owned set; ./backend.js is dynamic-only", () => {
    // Given: src/app/sidecarMain.ts exists
    // When:  validator reads the source and collects static import declarations
    // Then:  static imports reference ONLY node:url + ./crashLogger.js +
    //        ./backend/scheduler.js + ./backend/telegramChannel.js + ../env.js;
    //        NO static import of the backend entry, commander, or CLI paths;
    //        ./backend.js appears only inside a dynamic import() call (runAppBackend)
    assert.ok(
      existsSync(SRC_SIDECAR),
      `src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure). Path: ${SRC_SIDECAR}`,
    );
    const src = readFileSync(SRC_SIDECAR, "utf8");

    // Extract top-level static import lines (lines beginning with "import ")
    const staticImportLines = src.split("\n").filter((line) => /^import\s+/.test(line.trim()));

    // None of the static imports should reference the backend entry, commander, CLI, or main
    for (const line of staticImportLines) {
      assert.ok(
        !line.includes("./backend.js"),
        `Static import must not reference the backend entry (use dynamic import); found: ${line}`,
      );
      assert.ok(!line.includes("commander"), `Static import must not reference 'commander'; found: ${line}`);
      assert.ok(!line.includes("cli/"), `Static import must not reference a CLI path; found: ${line}`);
      assert.ok(!line.includes("./main"), `Static import must not reference './main' (CLI entrypoint); found: ${line}`);
    }

    // crashLogger must appear as a static import
    const hasCrashLoggerStatic = staticImportLines.some((line) => line.includes("crashLogger"));
    assert.ok(hasCrashLoggerStatic, "crashLogger must appear as a static import");

    // The App turn scheduler + Telegram adapter are the sanctioned static App imports (§13.3)
    const hasSchedulerStatic = staticImportLines.some((line) => line.includes("backend/scheduler"));
    assert.ok(hasSchedulerStatic, "backend/scheduler must appear as a static import (App turn owner)");
    const hasTelegramStatic = staticImportLines.some((line) => line.includes("backend/telegramChannel"));
    assert.ok(hasTelegramStatic, "backend/telegramChannel must appear as a static import (App Telegram adapter)");

    // ./backend.js must appear only inside a dynamic import() expression
    const backendInDynamic = /await\s+import\s*\(\s*["'][^"']*backend\.js["']\s*\)/.test(src);
    assert.ok(
      backendInDynamic,
      "./backend.js must be referenced only via a dynamic import() call, not a static import",
    );
  });
});
