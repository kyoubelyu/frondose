/**
 * P-APP-9 Step 3 — Import-graph + build-output scaffold for dist/app/updateServerMain.js
 *
 * Covers:
 *   T-UpdateSrv.Imports.1 — compiled entry omits commander/dotenv/loadDotenv (comment-immune:
 *                            asserts against parsed static import specifiers, not a raw whole-file
 *                            includes() scan); DOES contain --port, --site-dir, runUpdateServerSubcommand
 *   T-UpdateSrv.Imports.2 — src top-level static import specifiers are EXACTLY { node:url,
 *                            ../cli/crashLogger.js } — the dynamic body specifier must NOT appear
 *                            in the static set
 *   T-UpdateSrv.Build.1   — dist/app/updateServerMain.js exists + has owner-execute bit set post-build
 *
 * Strategy:
 *   - Imports.1: reads dist/app/updateServerMain.js; strips block and line comments + quoted string
 *     literals before scanning for forbidden identifiers (comment-immune per BLOCKER-2 fix);
 *     also collects static import specifiers from the parsed lines (belt-and-suspenders).
 *   - Imports.2: reads src/app/updateServerMain.ts; collects top-level `import … from "…"` specifiers.
 *   - Build.1: stats dist/app/updateServerMain.js for existence + owner-execute bit (mode & 0o100).
 *
 * These tests are intentionally red pre-impl because dist/app/updateServerMain.js does not exist yet.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/app/updateServerImportGraph.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());
const DIST_ENTRY = resolve(REPO, "dist/app/updateServerMain.js");
const SRC_ENTRY = resolve(REPO, "src/app/updateServerMain.ts");

/**
 * Strip block comments (/* … * /), line comments (// …), and quoted string
 * literals (single and double-quoted) from JavaScript/TypeScript source.
 * This is the comment-immune model required by BLOCKER-2: tsc preserves all
 * source comments into dist/, so a raw file.includes("commander") scan can
 * false-fail on a header comment that names a forbidden token.
 */
function stripCommentsAndStrings(source: string): string {
  // Remove block comments first (non-greedy)
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Remove line comments
  stripped = stripped.replace(/\/\/[^\n]*/g, " ");
  // Remove double-quoted strings (no embedded escaped quotes handled conservatively)
  stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Remove single-quoted strings
  stripped = stripped.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Remove template literals (simple: not handling nested ${})
  stripped = stripped.replace(/`[^`]*`/g, "``");
  return stripped;
}

/**
 * Extract the string specifier from a static import declaration line.
 * Handles both:
 *   import { foo } from "specifier"
 *   import "specifier"
 */
function extractStaticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // Match top-level static import statements (lines starting with "import")
  const importLineRegex = /^import\s+[\s\S]*?from\s+["']([^"']+)["']\s*;?$/gm;
  let match: RegExpExecArray | null;
  while ((match = importLineRegex.exec(source)) !== null) {
    const spec = match[1];
    if (spec !== undefined) specifiers.push(spec);
  }
  // Also match bare side-effect imports: import "specifier";
  const sideEffectRegex = /^import\s+["']([^"']+)["']\s*;?$/gm;
  while ((match = sideEffectRegex.exec(source)) !== null) {
    const spec = match[1];
    if (spec !== undefined && !specifiers.includes(spec)) specifiers.push(spec);
  }
  return specifiers;
}

describe("T-UpdateSrv.Imports — entry import graph", () => {
  it(
    "T-UpdateSrv.Imports.1: dist/app/updateServerMain.js does NOT contain commander/dotenv/loadDotenv " +
      "in non-comment code; DOES contain --port, --site-dir, runUpdateServerSubcommand",
    () => {
      // Given: dist/app/updateServerMain.js exists after npm run build
      // When:  validator strips comments + string literals, then scans forbidden/required tokens
      // Then:  no forbidden token appears in non-comment code; required markers are present
      assert.ok(
        existsSync(DIST_ENTRY),
        `dist/app/updateServerMain.js must exist after build (pre-impl: intentional scaffold failure). ` +
          `Path: ${DIST_ENTRY}`,
      );

      const raw = readFileSync(DIST_ENTRY, "utf8");

      // --- Comment-immune forbidden-token check ---
      // Extract only the static import specifiers (the authoritative import-graph view)
      const staticSpecifiers = extractStaticImportSpecifiers(raw);

      const forbiddenSpecifierPatterns = ["commander", "dotenv"];
      for (const forbidden of forbiddenSpecifierPatterns) {
        const matching = staticSpecifiers.filter((s) => s.includes(forbidden));
        assert.equal(
          matching.length,
          0,
          `Static import specifiers must not include "${forbidden}"; found: ${JSON.stringify(matching)}`,
        );
      }

      // Also strip comments+strings from the full source for identifier-level checks
      const stripped = stripCommentsAndStrings(raw);

      // "loadDotenv" must not appear as a code identifier (not in comments, not in strings)
      assert.ok(
        !stripped.includes("loadDotenv"),
        'dist/app/updateServerMain.js must NOT contain "loadDotenv" outside comments/strings ' +
          "(the thin entry must not import the CLI env loader)",
      );

      // --- Required markers (these are in real code tokens, not just comments) ---
      assert.ok(
        raw.includes("--port"),
        'dist/app/updateServerMain.js must contain "--port" (the flag it parses)',
      );
      assert.ok(
        raw.includes("--site-dir"),
        'dist/app/updateServerMain.js must contain "--site-dir" (the flag it parses)',
      );
      assert.ok(
        raw.includes("runUpdateServerSubcommand"),
        'dist/app/updateServerMain.js must contain "runUpdateServerSubcommand" (the dynamic-import call site)',
      );
    },
  );

  it(
    "T-UpdateSrv.Imports.2: src/app/updateServerMain.ts top-level static import specifiers are exactly " +
      "{ node:url, ../cli/crashLogger.js } — dynamic body NOT in static set",
    () => {
      // Given: src/app/updateServerMain.ts exists
      // When:  validator collects top-level static import specifiers from the source
      // Then:  specifier set is exactly { "node:url", "../cli/crashLogger.js" };
      //        "../cli/subcommands/updateServer.js" must NOT appear in the static set
      assert.ok(
        existsSync(SRC_ENTRY),
        `src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure). ` +
          `Path: ${SRC_ENTRY}`,
      );

      const src = readFileSync(SRC_ENTRY, "utf8");
      const specifiers = extractStaticImportSpecifiers(src);
      const specSet = new Set(specifiers);

      // Exactly these two specifiers — no more, no less
      const expected = new Set(["node:url", "../cli/crashLogger.js"]);
      assert.deepEqual(
        specSet,
        expected,
        `Static import specifier set must be exactly { "node:url", "../cli/crashLogger.js" }. ` +
          `Got: ${JSON.stringify([...specSet])}`,
      );

      // The update-server body MUST be dynamic-import only (not in the static set)
      assert.ok(
        !specSet.has("../cli/subcommands/updateServer.js"),
        '"../cli/subcommands/updateServer.js" must NOT appear as a static import ' +
          "(it is dynamic-imported at runtime — that is the key that keeps the CLI graph out of static load order)",
      );

      // The body must appear via a dynamic import() expression somewhere in the source
      const bodyInDynamic =
        /await\s+import\s*\(\s*["'][^"']*updateServer[^"']*["']\s*\)/.test(src);
      assert.ok(
        bodyInDynamic,
        "updateServer.js must be referenced via a dynamic import() call, not a static import",
      );
    },
  );
});

describe("T-UpdateSrv.Build — dist output and executable bit", () => {
  it(
    "T-UpdateSrv.Build.1: dist/app/updateServerMain.js exists and has the owner-execute bit set after npm run build",
    () => {
      // Given: a clean npm run build has run (produces dist/app/updateServerMain.js)
      // When:  validator stats dist/app/updateServerMain.js
      // Then:  the file exists AND (stat.mode & 0o100) !== 0 (owner-execute bit set by the package.json chmod)
      assert.ok(
        existsSync(DIST_ENTRY),
        `dist/app/updateServerMain.js must exist after build (pre-impl: intentional scaffold failure). ` +
          `Path: ${DIST_ENTRY}`,
      );
      const st = statSync(DIST_ENTRY);
      // 0o100 = S_IXUSR (owner execute)
      assert.ok(
        (st.mode & 0o100) !== 0,
        `dist/app/updateServerMain.js must have owner-execute bit set (chmod +x in package.json); ` +
          `actual mode: ${(st.mode & 0o777).toString(8)}`,
      );
    },
  );
});
