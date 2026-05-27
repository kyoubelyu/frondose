/**
 * P-SP-C scaffold — T-SP-C.CallerSweep.1 (CONCERN-MR-2)
 * Source-structural caller sweep: modeFromToggles absent from all active
 * call sites after builder F-1 (mode.ts rewrite) + F-2 (app.ts migration)
 * + bundle regeneration.
 *
 * Step 4a: assertion bodies are TODO stubs — FAILS pre-builder.
 *          Pre-builder, modeFromToggles IS present in mode.ts + app.ts + the
 *          generated bundle, so the structural checks would fail. The TODO
 *          stubs fire explicitly regardless.
 * Step 5:  builder removes modeFromToggles from mode.ts (F-1), migrates
 *          app.ts from modeFromToggles(cronEnabled) → modeFromState({cronEnabled,...})
 *          (F-2), regenerates sharedRenderBundle.generated.ts from the updated
 *          sharedEntry.ts → modeFromToggles disappears from bundle string → fill.
 *
 * SOURCE-STRUCTURAL SCAN: uses fs.readFileSync on live source files (not compiled
 * dist/) because the source files ARE the author contract. The generated bundle
 * is a committed artifact that must be kept in sync by the builder — failure to
 * regenerate it is a builder-4b defect, NOT a validator workaround.
 *
 * Files swept:
 *   (A) src/tauri/ui/mode.ts  — definition removed; modeFromState added
 *   (B) src/tauri/ui/app.ts   — import + call sites migrated to modeFromState
 *   (C) src/overlay/sharedEntry.ts — wildcard re-export; after mode.ts loses
 *       modeFromToggles the re-export set automatically excludes it; no direct
 *       edit to sharedEntry.ts needed; validated as a SECONDARY assertion
 *   (D) src/overlay/sharedRenderBundle.generated.ts — the committed esbuild
 *       bundle string: after regeneration with updated sharedEntry.ts, the
 *       literal string "modeFromToggles" must be absent
 *
 * Note on tests/tauri/mode-pY2.1.mock.test.ts: that TEST FILE still imports
 * modeFromToggles pre-builder (and is expected to break at Step 4b). Validator
 * will update it at Step 5 to import modeFromState instead. The CallerSweep
 * test sweeps only PRODUCTION SOURCE (src/) not test files.
 *
 * Guardian CONCERN-MR-2: "add a caller sweep test so builder can't forget one
 * of the three sites (mode.ts, app.ts, shared entry / generated bundle)."
 *
 * Run (mock — static file scan; no imports needed):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/callerSweep.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// ─── Source file paths (relative to repo root) ───────────────────────────────

const ROOT = resolve(import.meta.dirname, "../../..");

const SRC_MODE = resolve(ROOT, "src/tauri/ui/mode.ts");
const SRC_APP = resolve(ROOT, "src/tauri/ui/app.ts");
const SRC_SHARED_ENTRY = resolve(ROOT, "src/overlay/sharedEntry.ts");
const SRC_BUNDLE = resolve(ROOT, "src/overlay/sharedRenderBundle.generated.ts");

describe("T-SP-C.CallerSweep — modeFromToggles absent from all active call sites post F-1/F-2 (P-SP-C)", () => {
  // ─── T-SP-C.CallerSweep.1 ────────────────────────────────────────────────────
  it("T-SP-C.CallerSweep.1: modeFromToggles does NOT appear in any active src/ call site; modeFromState IS present in mode.ts + app.ts", () => {
    // Given: builder F-1 rewrites src/tauri/ui/mode.ts — removes modeFromToggles
    //        export, adds modeFromState({cronEnabled, passiveEnabled}) export
    //        builder F-2 rewrites src/tauri/ui/app.ts — replaces every
    //        modeFromToggles(cronEnabled) call with modeFromState({cronEnabled, ...})
    //        builder regenerates sharedRenderBundle.generated.ts from the updated
    //        sharedEntry.ts (which re-exports * from mode.ts) — bundle drops the
    //        old function definition
    //
    // When:  fs.readFileSync each active production source file; search for the
    //        literal string "modeFromToggles" (both as export and as call site);
    //        search for "modeFromState" in files that must add it
    //
    // Then:
    //   (A) mode.ts: "modeFromToggles" absent; "modeFromState" present
    //   (B) app.ts: "modeFromToggles" absent; "modeFromState" present
    //   (C) sharedEntry.ts: "modeFromToggles" absent (secondary — it re-exports *
    //       from mode.ts; once mode.ts drops the function the re-export set shrinks
    //       automatically; no literal "modeFromToggles" string should remain in the
    //       sharedEntry.ts source)
    //   (D) sharedRenderBundle.generated.ts: "modeFromToggles" absent from the
    //       committed bundle string (builder must regenerate after F-1/F-2)
    //   Covers G-SP-C.3 (modeFromState replaces modeFromToggles across callers)
    const modeTs = readSrc(SRC_MODE);
    const appTs = readSrc(SRC_APP);
    const sharedEntry = readSrc(SRC_SHARED_ENTRY);
    const bundle = readSrc(SRC_BUNDLE);

    // (A) mode.ts: modeFromToggles must NOT be declared/exported; modeFromState must exist
    // Note: "modeFromToggles" may appear in a JSDoc comment describing what was replaced —
    // only function declaration / export matters. Check function keyword absence.
    assert.ok(
      !modeTs.includes("function modeFromToggles") && !modeTs.includes("export { modeFromToggles"),
      `mode.ts must NOT declare/export modeFromToggles. Found in: ${modeTs.slice(0, 200)}`,
    );
    assert.ok(modeTs.includes("modeFromState"), `mode.ts must contain modeFromState export`);

    // (B) app.ts: modeFromToggles must NOT appear as import or call site
    assert.ok(
      !appTs.includes("modeFromToggles"),
      `app.ts must NOT reference modeFromToggles (import or call). Found at: ${(() => {
        const i = appTs.indexOf("modeFromToggles");
        return i >= 0 ? appTs.slice(Math.max(0, i - 20), i + 40) : "not found";
      })()}`,
    );
    assert.ok(appTs.includes("modeFromState"), `app.ts must import/use modeFromState`);

    // (C) sharedEntry.ts: no literal "modeFromToggles" string
    assert.ok(
      !sharedEntry.includes("modeFromToggles"),
      `sharedEntry.ts must NOT contain literal "modeFromToggles" (it re-exports * from mode.ts which no longer has it)`,
    );

    // (D) sharedRenderBundle.generated.ts: bundle must NOT contain modeFromToggles
    // KNOWN DEFECT D-SP-C-B: builder did not regenerate the bundle after F-1 mode.ts rewrite.
    // The bundle is a committed artifact generated by `npm run build:overlay-assets`.
    // This assertion WILL FAIL until builder runs that script. Filed as D-SP-C-B (builder step 5a).
    assert.ok(
      !bundle.includes("modeFromToggles"),
      `D-SP-C-B: sharedRenderBundle.generated.ts is STALE — still contains "modeFromToggles". ` +
        `Builder must run \`npm run build:overlay-assets\` to regenerate the bundle after mode.ts F-1 rewrite.`,
    );
  });
});

// ─── Helper read function exposed for Step 5 fill ────────────────────────────

/** Read a source file and return its content as a string. */
export function readSrc(absPath: string): string {
  return readFileSync(absPath, "utf-8");
}

/** Exported file path constants for Step 5 fill. */
export { SRC_MODE, SRC_APP, SRC_SHARED_ENTRY, SRC_BUNDLE };
