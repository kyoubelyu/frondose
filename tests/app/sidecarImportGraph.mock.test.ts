/**
 * P-APP-6 Step 3a — Import-graph scaffold for dist/app/sidecarMain.js
 *
 * Covers:
 *   T-Sidecar.Imports.1 — compiled entry omits "commander"; contains "--sock", "--token",
 *                          "runServeSubcommand"
 *   T-Sidecar.Imports.2 — top-level static imports in sidecarMain.ts are ONLY
 *                          crashLogger.js (static) + serve.js (dynamic); no CLI subcommands,
 *                          no main.js, no commander
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
  it("T-Sidecar.Imports.1: dist/app/sidecarMain.js does NOT contain 'commander'; DOES contain '--sock', '--token', 'runServeSubcommand'", () => {
    // Given: dist/app/sidecarMain.js exists after npm run build
    // When:  validator reads the file contents
    // Then:  "commander" does NOT appear; "--sock", "--token", "runServeSubcommand" DO appear
    assert.ok(
      existsSync(DIST_SIDECAR),
      `dist/app/sidecarMain.js must exist after build (pre-impl: intentional scaffold failure). Path: ${DIST_SIDECAR}`,
    );
    const contents = readFileSync(DIST_SIDECAR, "utf8");
    assert.ok(!contents.includes("commander"), "dist/app/sidecarMain.js must NOT contain 'commander'");
    assert.ok(contents.includes("--sock"), "dist/app/sidecarMain.js must contain '--sock'");
    assert.ok(contents.includes("--token"), "dist/app/sidecarMain.js must contain '--token'");
    assert.ok(
      contents.includes("runServeSubcommand"),
      "dist/app/sidecarMain.js must contain 'runServeSubcommand'",
    );
  });

  it("T-Sidecar.Imports.2: src/app/sidecarMain.ts top-level static imports are ONLY crashLogger; serve is dynamic-only", () => {
    // Given: src/app/sidecarMain.ts exists
    // When:  validator reads the source and collects static import declarations
    // Then:  static imports reference ONLY node:url + ../cli/crashLogger.js (and node:path);
    //        NO static import of serve, commander, or CLI subcommands;
    //        serve.js appears only inside a dynamic import() call
    assert.ok(
      existsSync(SRC_SIDECAR),
      `src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure). Path: ${SRC_SIDECAR}`,
    );
    const src = readFileSync(SRC_SIDECAR, "utf8");

    // Extract top-level static import lines (lines beginning with "import ")
    const staticImportLines = src
      .split("\n")
      .filter((line) => /^import\s+/.test(line.trim()));

    // None of the static imports should reference serve, commander, or main
    for (const line of staticImportLines) {
      assert.ok(
        !line.includes("serve"),
        `Static import must not reference 'serve' (use dynamic import); found: ${line}`,
      );
      assert.ok(
        !line.includes("commander"),
        `Static import must not reference 'commander'; found: ${line}`,
      );
      assert.ok(
        !line.includes("./main"),
        `Static import must not reference './main' (CLI entrypoint); found: ${line}`,
      );
    }

    // crashLogger must appear as a static import
    const hasCrashLoggerStatic = staticImportLines.some((line) => line.includes("crashLogger"));
    assert.ok(hasCrashLoggerStatic, "crashLogger must appear as a static import");

    // serve must appear only inside a dynamic import() expression
    const serveInDynamic = /await\s+import\s*\(\s*["'][^"']*serve[^"']*["']\s*\)/.test(src);
    assert.ok(
      serveInDynamic,
      "serve.js must be referenced only via a dynamic import() call, not a static import",
    );
  });
});
