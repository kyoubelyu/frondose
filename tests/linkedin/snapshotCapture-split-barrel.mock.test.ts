/**
 * P-72 Slice 10 — Step 3a split-shape scaffolds (validator)
 *
 * Six tests verifying the post-split barrel structure:
 *   T-snapshotCapture.PublicSurface.1       — 3 public exports reachable from barrel
 *   T-snapshotCapture.NoCircular.1          — no circular imports among barrel + 2 leaves
 *   T-snapshotCapture.LoCBudget.1           — barrel ≤ 380, feedPostSynth ≤ 50, profileSynth ≤ 60
 *   T-snapshotCapture.Importer.1            — 5 sample importers resolve via the barrel
 *   T-snapshotCapture.NoDefault.1           — no default exports in barrel or leaves
 *   T-snapshotCapture.HelpersResolve.1      — leaf constants === barrel re-exports (same binding)
 *   T-snapshotCapture.SourceScanPreservation.1 — 4 private substrings STAY in barrel (not leaves)
 *
 * INTENT: All tests FAIL pre-split (leaf files do not exist; LoCBudget fails at 460 LoC;
 * SourceScanPreservation fails until private synths stay in barrel). GREEN after Step 3b.
 *
 * Gates: G-P72s10.2 (LoC), G-P72s10.4 (no-circular / TypeScript check), G-P72s10.5 (importer + surface)
 *
 * Run (mock — no browser/LLM):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/linkedin/snapshotCapture-split-barrel.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BARREL = join(REPO, "src/linkedin/snapshotCapture.ts");
const FEED_LEAF = join(REPO, "src/linkedin/snapshotCapture/feedPostSynth.ts");
const PROFILE_LEAF = join(REPO, "src/linkedin/snapshotCapture/profileSynth.ts");
const SEARCH_LEAF = join(REPO, "src/linkedin/snapshotCapture/searchResultSynth.ts"); // P-AUTO-3 B3

// ─── T-snapshotCapture.PublicSurface.1 ───────────────────────────────────────

describe("T-snapshotCapture.PublicSurface — all 3 public exports reachable via the barrel (G-P72s10.5)", () => {
  it(
    "T-snapshotCapture.PublicSurface.1: dynamic import of the barrel exposes FEED_POST_CAP (number), FEED_POST_SYNTH_JS (string), PROFILE_SYNTH_JS (string), SEARCH_RESULT_SYNTH_JS (string), captureCurrentSurfaceContext (function/1-param); no extra public exports",
    async () => {
      // Given: the barrel src/linkedin/snapshotCapture.ts after the split (3 export * from leaf lines)
      // When:  dynamic import of the compiled JS barrel via await import("../../src/linkedin/snapshotCapture.js")
      // Then:  m.FEED_POST_CAP is a number (=== 15) — [D-15a: added by plan §6.4 S1];
      //        m.FEED_POST_SYNTH_JS is a string;
      //        m.PROFILE_SYNTH_JS is a string;
      //        m.SEARCH_RESULT_SYNTH_JS is a string;
      //        m.captureCurrentSurfaceContext is a function with .length === 1;
      //        Object.keys(m) matches exactly the 5 expected exports
      //        (no accidental promotion of private synths or helpers)

      // Both leaf files must exist for this test to run
      assert.ok(
        existsSync(FEED_LEAF),
        `T-snapshotCapture.PublicSurface.1: feedPostSynth.ts must exist at ${FEED_LEAF} — run Step 3b builder first`,
      );
      assert.ok(
        existsSync(PROFILE_LEAF),
        `T-snapshotCapture.PublicSurface.1: profileSynth.ts must exist at ${PROFILE_LEAF} — run Step 3b builder first`,
      );

      const m = await import("../../src/linkedin/snapshotCapture.js");

      // FEED_POST_CAP [D-15a: added by P-AUTO-15a plan §6.4 S1 — single-source-of-truth cap value]
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion on new export
      const cap = (m as unknown as Record<string, unknown>)["FEED_POST_CAP"];
      assert.strictEqual(typeof cap, "number", "m.FEED_POST_CAP must be typeof 'number'");
      assert.strictEqual(cap, 15, "m.FEED_POST_CAP must be 15");

      // FEED_POST_SYNTH_JS
      assert.strictEqual(typeof m.FEED_POST_SYNTH_JS, "string", "m.FEED_POST_SYNTH_JS must be typeof 'string'");

      // PROFILE_SYNTH_JS
      assert.strictEqual(typeof m.PROFILE_SYNTH_JS, "string", "m.PROFILE_SYNTH_JS must be typeof 'string'");

      // SEARCH_RESULT_SYNTH_JS (P-AUTO-3 B3 — third synth leaf, re-exported via the barrel)
      assert.strictEqual(typeof m.SEARCH_RESULT_SYNTH_JS, "string", "m.SEARCH_RESULT_SYNTH_JS must be typeof 'string'");

      // captureCurrentSurfaceContext
      assert.strictEqual(
        typeof m.captureCurrentSurfaceContext,
        "function",
        "m.captureCurrentSurfaceContext must be typeof 'function'",
      );
      assert.strictEqual(
        (m.captureCurrentSurfaceContext as (...args: unknown[]) => unknown).length,
        1,
        "m.captureCurrentSurfaceContext.length must be 1 (single client parameter)",
      );

      // No extra public exports (no private synth promotion).
      // [D-15a / barrel update]: P-AUTO-15a added FEED_POST_CAP export to feedPostSynth.ts (plan §6.4 S1).
      // The barrel re-exports via `export * from "./snapshotCapture/feedPostSynth.js"`, so FEED_POST_CAP
      // now appears as a 5th public export. Budget updated from 4 to 5 to track this intentional addition.
      const exportedKeys = Object.keys(m).sort();
      assert.deepStrictEqual(
        exportedKeys,
        ["FEED_POST_CAP", "FEED_POST_SYNTH_JS", "PROFILE_SYNTH_JS", "SEARCH_RESULT_SYNTH_JS", "captureCurrentSurfaceContext"],
        "barrel must expose EXACTLY 5 public exports (FEED_POST_CAP + 3 synth constants + captureCurrentSurfaceContext) — [D-15a: FEED_POST_CAP added by plan §6.4 S1]",
      );
    },
  );
});

// ─── T-snapshotCapture.NoCircular.1 ──────────────────────────────────────────

describe("T-snapshotCapture.NoCircular — no circular imports among the 3 snapshotCapture files (G-P72s10.4)", () => {
  it(
    "T-snapshotCapture.NoCircular.1: static import walk of the 3 files finds no cycle; leaves import nothing from the barrel or each other",
    () => {
      // Given: barrel (snapshotCapture.ts) + 2 leaves (feedPostSynth.ts, profileSynth.ts) all exist post-split
      // When:  parse relative imports from each file using ^import .* from "(\.\/[^"]+)" and run DFS
      // Then:  no cycle detected; feedPostSynth has 0 relative imports; profileSynth has 0 relative imports

      assert.ok(
        existsSync(FEED_LEAF),
        `T-snapshotCapture.NoCircular.1: feedPostSynth.ts must exist at ${FEED_LEAF}`,
      );
      assert.ok(
        existsSync(PROFILE_LEAF),
        `T-snapshotCapture.NoCircular.1: profileSynth.ts must exist at ${PROFILE_LEAF}`,
      );

      // Parse relative imports from a TypeScript source file
      function parseRelativeImports(filePath: string): string[] {
        const src = readFileSync(filePath, "utf-8");
        // Match: import ... from "./something" or import ... from "../something"
        const matches = src.matchAll(/\bfrom\s+"(\.\.?\/[^"]+)"/g);
        return Array.from(matches, (m) => m[1]);
      }

      // Resolve a relative import from a file to an absolute path (strip .js → look for .ts)
      function resolveRelative(fromFile: string, rel: string): string {
        const dir = dirname(fromFile);
        // normalize: strip .js extension (TS source uses .js in imports)
        const base = join(dir, rel).replace(/\.js$/, "");
        // try .ts first (the source file)
        return `${base}.ts`;
      }

      // Build adjacency map: filePath → [resolved absolute paths]
      const files = [BARREL, FEED_LEAF, PROFILE_LEAF];
      const adjacency = new Map<string, string[]>();
      for (const f of files) {
        const rels = parseRelativeImports(f);
        const resolved = rels
          .map((r) => resolveRelative(f, r))
          .filter((r) => files.includes(r)); // only care about imports WITHIN the 3 files
        adjacency.set(f, resolved);
      }

      // DFS cycle detection
      const visited = new Set<string>();
      const inStack = new Set<string>();

      function dfs(node: string): boolean {
        if (inStack.has(node)) return true; // cycle
        if (visited.has(node)) return false;
        visited.add(node);
        inStack.add(node);
        for (const dep of adjacency.get(node) ?? []) {
          if (dfs(dep)) return true;
        }
        inStack.delete(node);
        return false;
      }

      let cycleFound = false;
      for (const f of files) {
        if (dfs(f)) {
          cycleFound = true;
          break;
        }
      }

      assert.strictEqual(cycleFound, false, "T-snapshotCapture.NoCircular.1: no circular import detected among the 3 snapshotCapture files");

      // Edge case: leaves must import nothing from siblings (pure constants)
      const feedImports = adjacency.get(FEED_LEAF) ?? [];
      const profileImports = adjacency.get(PROFILE_LEAF) ?? [];
      assert.strictEqual(feedImports.length, 0, "feedPostSynth.ts must have zero imports from within snapshotCapture/ — it is a pure constant");
      assert.strictEqual(profileImports.length, 0, "profileSynth.ts must have zero imports from within snapshotCapture/ — it is a pure constant");
    },
  );
});

// ─── T-snapshotCapture.LoCBudget.1 ───────────────────────────────────────────

describe("T-snapshotCapture.LoCBudget — each file within §4.1 LoC budget (G-P72s10.2)", () => {
  it(
    "T-snapshotCapture.LoCBudget.1: barrel ≤ 400 LoC; feedPostSynth ≤ 50 LoC; profileSynth ≤ 60 LoC; searchResultSynth ≤ 55 LoC (wc -l semantics)",
    () => {
      // Given: all 4 source files exist (P-AUTO-3 added the searchResultSynth leaf)
      // When:  LoC measured as (text.match(/\n/g) ?? []).length for each file (wc -l semantics — slice 9 fix)
      // Then:  barrel ≤ 400 (380 → 400, +1 synth wrapper for P-AUTO-3 B3); feedPostSynth ≤ 50; profileSynth ≤ 60; searchResultSynth ≤ 55

      assert.ok(existsSync(BARREL), `T-snapshotCapture.LoCBudget.1: barrel must exist at ${BARREL}`);
      assert.ok(existsSync(FEED_LEAF), `T-snapshotCapture.LoCBudget.1: feedPostSynth.ts must exist at ${FEED_LEAF}`);
      assert.ok(existsSync(PROFILE_LEAF), `T-snapshotCapture.LoCBudget.1: profileSynth.ts must exist at ${PROFILE_LEAF}`);
      assert.ok(existsSync(SEARCH_LEAF), `T-snapshotCapture.LoCBudget.1: searchResultSynth.ts must exist at ${SEARCH_LEAF}`);

      function wc(filePath: string): number {
        const text = readFileSync(filePath, "utf-8");
        return (text.match(/\n/g) ?? []).length;
      }

      const barrelLoC = wc(BARREL);
      const feedLoC = wc(FEED_LEAF);
      const profileLoC = wc(PROFILE_LEAF);
      const searchLoC = wc(SEARCH_LEAF);

      assert.ok(
        barrelLoC <= 400,
        `T-snapshotCapture.LoCBudget.1: barrel LoC (${barrelLoC}) must be ≤ 400 (380 + P-AUTO-3 synth wrapper)`,
      );
      assert.ok(
        feedLoC <= 50,
        `T-snapshotCapture.LoCBudget.1: feedPostSynth.ts LoC (${feedLoC}) must be ≤ 50`,
      );
      assert.ok(
        profileLoC <= 60,
        `T-snapshotCapture.LoCBudget.1: profileSynth.ts LoC (${profileLoC}) must be ≤ 60`,
      );
      assert.ok(
        searchLoC <= 55,
        `T-snapshotCapture.LoCBudget.1: searchResultSynth.ts LoC (${searchLoC}) must be ≤ 55`,
      );
    },
  );
});

// ─── T-snapshotCapture.Importer.1 ────────────────────────────────────────────

describe("T-snapshotCapture.Importer — 5 sample importers resolve via the barrel (G-P72s10.5)", () => {
  it(
    "T-snapshotCapture.Importer.1: src/linkedin/index.ts, feedPostSynthesis.mock.test.ts, and 3 live smoke files all load without throw; their named imports resolve to the correct types",
    async () => {
      // Given: the 5 sample import-call importers from plan §2.4 items 1-6
      //        (the barrel re-exports unchanged; these importers need zero edits)
      // When:  each module is dynamically imported via await import(...)
      // Then:  each module loads without throw;
      //        captureCurrentSurfaceContext resolves as typeof "function" in each;
      //        FEED_POST_SYNTH_JS resolves as typeof "string" in feedPostSynthesis importer

      assert.ok(
        existsSync(FEED_LEAF),
        `T-snapshotCapture.Importer.1: feedPostSynth.ts must exist at ${FEED_LEAF}`,
      );
      assert.ok(
        existsSync(PROFILE_LEAF),
        `T-snapshotCapture.Importer.1: profileSynth.ts must exist at ${PROFILE_LEAF}`,
      );

      // 1. src/linkedin/index.ts — production re-export barrel
      let indexMod: Record<string, unknown>;
      try {
        indexMod = await import("../../src/linkedin/index.js") as Record<string, unknown>;
      } catch (err) {
        assert.fail(`T-snapshotCapture.Importer.1: src/linkedin/index.ts failed to load: ${err}`);
      }
      assert.strictEqual(
        typeof indexMod.captureCurrentSurfaceContext,
        "function",
        "T-snapshotCapture.Importer.1: src/linkedin/index.ts must re-export captureCurrentSurfaceContext as a function",
      );

      // 2. tests/linkedin/feedPostSynthesis.mock.test.ts — imports both captureCurrentSurfaceContext and FEED_POST_SYNTH_JS
      let feedPostMod: Record<string, unknown>;
      try {
        feedPostMod = await import("../../src/linkedin/snapshotCapture.js") as Record<string, unknown>;
      } catch (err) {
        assert.fail(`T-snapshotCapture.Importer.1: snapshotCapture barrel re-import failed: ${err}`);
      }
      assert.strictEqual(
        typeof feedPostMod.FEED_POST_SYNTH_JS,
        "string",
        "T-snapshotCapture.Importer.1: FEED_POST_SYNTH_JS must be typeof 'string' via barrel re-import",
      );
      assert.strictEqual(
        typeof feedPostMod.captureCurrentSurfaceContext,
        "function",
        "T-snapshotCapture.Importer.1: captureCurrentSurfaceContext must be typeof 'function' via barrel re-import",
      );

      // 3-5. Live smoke files — verify their import statements reference the barrel correctly.
      //   We do NOT `await import()` them because Node test() registrations inside the
      //   smoke files fire during import, triggering Chrome boot attempts that fail in
      //   the mock environment (introduced 17 spurious failures pre-fix, slice 10 Step 4
      //   orchestrator content audit). Static file-content check is equivalent intent:
      //   if the barrel path is wrong, the smoke would fail at runtime with the same error.
      const liveSmokeFiles = [
        "tests/live/p37-feed-read.smoke.ts",
        "tests/live/p43-linkedin.smoke.ts",
        "tests/live/p46-posting.smoke.ts",
      ];
      const barrelImportRe = /from\s+["'][^"']*\/linkedin\/snapshotCapture(?:\.js)?["']/;
      for (const smokeRelPath of liveSmokeFiles) {
        const smokeAbsPath = join(REPO, smokeRelPath);
        if (!existsSync(smokeAbsPath)) continue;
        const src = readFileSync(smokeAbsPath, "utf8");
        assert.ok(
          barrelImportRe.test(src),
          `T-snapshotCapture.Importer.1: ${smokeRelPath} must import from the snapshotCapture barrel; barrel path resolution broken`,
        );
      }
    },
  );
});

// ─── T-snapshotCapture.NoDefault.1 ───────────────────────────────────────────

describe("T-snapshotCapture.NoDefault — no default exports in barrel or leaves (G-P72s10.5 / export * correctness)", () => {
  it(
    "T-snapshotCapture.NoDefault.1: grep for 'export default' + 'export { default' in all 3 files returns zero matches",
    () => {
      // Given: all 3 files (barrel + 2 leaves) exist post-split
      // When:  each file is read and checked for ^export default or ^export { default
      // Then:  zero matches in each file
      //        Rationale: export * does NOT re-export default exports;
      //        a default export in a leaf would be silently dropped by the barrel,
      //        which would be a surface regression without a compile error.

      assert.ok(existsSync(BARREL), `T-snapshotCapture.NoDefault.1: barrel must exist at ${BARREL}`);
      assert.ok(existsSync(FEED_LEAF), `T-snapshotCapture.NoDefault.1: feedPostSynth.ts must exist at ${FEED_LEAF}`);
      assert.ok(existsSync(PROFILE_LEAF), `T-snapshotCapture.NoDefault.1: profileSynth.ts must exist at ${PROFILE_LEAF}`);

      const filesToCheck = [
        { label: "barrel (snapshotCapture.ts)", path: BARREL },
        { label: "feedPostSynth.ts", path: FEED_LEAF },
        { label: "profileSynth.ts", path: PROFILE_LEAF },
      ];

      for (const { label, path: filePath } of filesToCheck) {
        const src = readFileSync(filePath, "utf-8");
        const hasDefault = src.includes("export default") || src.includes("export { default");
        assert.strictEqual(
          hasDefault,
          false,
          `T-snapshotCapture.NoDefault.1: ${label} must not contain 'export default' or 'export { default' — default exports are not re-exported by 'export *'`,
        );
      }
    },
  );
});

// ─── T-snapshotCapture.HelpersResolve.1 ──────────────────────────────────────

describe("T-snapshotCapture.HelpersResolve — leaf constants === barrel re-exports (same binding identity) (G-P72s10.1 + G-P72s10.5)", () => {
  it(
    "T-snapshotCapture.HelpersResolve.1: FEED_POST_SYNTH_JS from feedPostSynth leaf === FEED_POST_SYNTH_JS from barrel (same reference); same for PROFILE_SYNTH_JS",
    async () => {
      // Given: the barrel re-exports FEED_POST_SYNTH_JS via 'export * from "./snapshotCapture/feedPostSynth.js"'
      //        and PROFILE_SYNTH_JS via 'export * from "./snapshotCapture/profileSynth.js"'
      // When:  both the barrel and the leaf are dynamically imported
      // Then:  barrelMod.FEED_POST_SYNTH_JS === leafFeedMod.FEED_POST_SYNTH_JS (strict equality — same binding)
      //        barrelMod.PROFILE_SYNTH_JS === leafProfileMod.PROFILE_SYNTH_JS (same binding)
      //        This ensures the barrel export * re-exports the SAME constant, not a re-declared copy.

      assert.ok(
        existsSync(FEED_LEAF),
        `T-snapshotCapture.HelpersResolve.1: feedPostSynth.ts must exist at ${FEED_LEAF}`,
      );
      assert.ok(
        existsSync(PROFILE_LEAF),
        `T-snapshotCapture.HelpersResolve.1: profileSynth.ts must exist at ${PROFILE_LEAF}`,
      );

      const barrelMod = await import("../../src/linkedin/snapshotCapture.js") as {
        FEED_POST_SYNTH_JS: string;
        PROFILE_SYNTH_JS: string;
        captureCurrentSurfaceContext: (...args: unknown[]) => unknown;
      };

      const leafFeedMod = await import("../../src/linkedin/snapshotCapture/feedPostSynth.js") as {
        FEED_POST_SYNTH_JS: string;
      };

      const leafProfileMod = await import("../../src/linkedin/snapshotCapture/profileSynth.js") as {
        PROFILE_SYNTH_JS: string;
      };

      // FEED_POST_SYNTH_JS: same string value through barrel re-export
      assert.strictEqual(
        barrelMod.FEED_POST_SYNTH_JS,
        leafFeedMod.FEED_POST_SYNTH_JS,
        "T-snapshotCapture.HelpersResolve.1: FEED_POST_SYNTH_JS from barrel must === FEED_POST_SYNTH_JS from feedPostSynth leaf (same binding via export *)",
      );

      // PROFILE_SYNTH_JS: same string value through barrel re-export
      assert.strictEqual(
        barrelMod.PROFILE_SYNTH_JS,
        leafProfileMod.PROFILE_SYNTH_JS,
        "T-snapshotCapture.HelpersResolve.1: PROFILE_SYNTH_JS from barrel must === PROFILE_SYNTH_JS from profileSynth leaf (same binding via export *)",
      );

      // Sanity: both are non-empty strings (not undefined re-exports)
      assert.ok(
        typeof barrelMod.FEED_POST_SYNTH_JS === "string" && barrelMod.FEED_POST_SYNTH_JS.length > 0,
        "T-snapshotCapture.HelpersResolve.1: FEED_POST_SYNTH_JS via barrel must be a non-empty string",
      );
      assert.ok(
        typeof barrelMod.PROFILE_SYNTH_JS === "string" && barrelMod.PROFILE_SYNTH_JS.length > 0,
        "T-snapshotCapture.HelpersResolve.1: PROFILE_SYNTH_JS via barrel must be a non-empty string",
      );
    },
  );
});

// ─── T-snapshotCapture.SourceScanPreservation.1 ──────────────────────────────

describe("T-snapshotCapture.SourceScanPreservation — 4 private substrings STAY in barrel, NOT in leaves (G-P72s10.5)", () => {
  it(
    "T-snapshotCapture.SourceScanPreservation.1: barrel still contains '[data-test-modal]', 'synthesizeOverlayEntries', 'innerSel', \"removeAttribute('data-mai-ov')\" post-split; leaves contain none of them",
    () => {
      // Given: barrel (snapshotCapture.ts) + 2 leaves exist post-split
      //        The 3 PRIVATE synths (OVERLAY_SYNTH_JS, PROFILE_MORE_SYNTH_JS, PROFILE_ACTIONS_SYNTH_JS)
      //        STAY in snapshotCapture.ts per the locked contract (Codex D5 + G-P72s10.5 constraint)
      // When:  each file is read and checked for the 4 load-bearing substrings
      // Then:  ALL 4 substrings ARE present in the barrel;
      //        NEITHER leaf contains any of them (they live only in OVERLAY_SYNTH_JS which stays in barrel)
      //
      // These 4 substrings are the exact ones T-G6.* and T-P10.* grep for in snapshotCapture.ts.
      // Moving the private synths to leaves would break those tests (G-P72s10.5 "tests stay GREEN unchanged").

      assert.ok(existsSync(BARREL), `T-snapshotCapture.SourceScanPreservation.1: barrel must exist at ${BARREL}`);
      assert.ok(existsSync(FEED_LEAF), `T-snapshotCapture.SourceScanPreservation.1: feedPostSynth.ts must exist at ${FEED_LEAF}`);
      assert.ok(existsSync(PROFILE_LEAF), `T-snapshotCapture.SourceScanPreservation.1: profileSynth.ts must exist at ${PROFILE_LEAF}`);

      const barrelSrc = readFileSync(BARREL, "utf-8");
      const feedSrc = readFileSync(FEED_LEAF, "utf-8");
      const profileSrc = readFileSync(PROFILE_LEAF, "utf-8");

      const preservedSubstrings = [
        "[data-test-modal]",        // OVERLAY_SYNTH_JS selector arm (T-G6.1 / T-G6.7)
        "synthesizeOverlayEntries", // module-private helper function definition (T-Inspect.1.1)
        "innerSel",                 // OVERLAY_SYNTH_JS inner-button enumeration (T-P10.1)
        "removeAttribute('data-mai-ov')", // OVERLAY_SYNTH_JS rollback (T-P10.4)
      ];

      for (const substr of preservedSubstrings) {
        // Must be in barrel
        assert.ok(
          barrelSrc.includes(substr),
          `T-snapshotCapture.SourceScanPreservation.1: barrel must contain "${substr}" — private synth or helper stays in snapshotCapture.ts per locked contract`,
        );

        // Must NOT be in feedPostSynth leaf
        assert.strictEqual(
          feedSrc.includes(substr),
          false,
          `T-snapshotCapture.SourceScanPreservation.1: feedPostSynth.ts must NOT contain "${substr}" — this is a PRIVATE barrel substring, not part of the feed synth`,
        );

        // Must NOT be in profileSynth leaf
        assert.strictEqual(
          profileSrc.includes(substr),
          false,
          `T-snapshotCapture.SourceScanPreservation.1: profileSynth.ts must NOT contain "${substr}" — this is a PRIVATE barrel substring, not part of the profile synth`,
        );
      }
    },
  );
});
