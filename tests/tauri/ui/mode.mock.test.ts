/**
 * P-SP-C scaffold — T-SP-C.Mode.1..4 (F-7)
 * src/tauri/ui/mode.ts 3-mode model: AppMode union, modeFromState, togglesForMode,
 * statusForMode with "magical" branch.
 *
 * Step 4a: assertion bodies are TODO stubs — ALL FAIL pre-builder.
 * Step 5:  builder rewrites mode.ts (F-1 paste-verbatim §5.1) → assertions filled.
 *
 * NOTE: src/tauri/ui/mode.ts currently only has AppMode = "manual" | "auto" and
 * exports `modeFromToggles` (single-arg). The new exports (`modeFromState`,
 * `"magical"` in the union, etc.) don't exist pre-builder. Dynamic import
 * inside `before()` defers resolution to test-run time.
 *
 * Guardian CONCERN-MR: the existing `tests/tauri/mode-pY2.1.mock.test.ts` imports
 * `modeFromToggles` which builder will REMOVE. Validator updates that file at Step 5
 * (after builder ships the new shape). Pre-builder, it continues to pass (using the
 * old shape). Post-builder, it will need updating — tracked in phase-sp-c-test.md.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/mode.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Dynamic import — defers resolution of modeFromState / "magical" mode which
// don't exist in mode.ts pre-builder.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let modeFromState: ((flags: { cronEnabled: boolean; passiveEnabled: boolean }) => string) | any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let togglesForMode: ((mode: string) => { cronEnabled: boolean; passiveEnabled: boolean }) | any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let statusForMode: ((mode: string) => { label: string; tone: string }) | any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let MODE_LABELS: Record<string, string> | any;

describe("T-SP-C.Mode — mode.ts 3-mode model (P-SP-C)", () => {
  before(async () => {
    // TODO (builder F-1 Step 4b): rewrite src/tauri/ui/mode.ts to 3-mode shape.
    const mod = await import("../../../src/tauri/ui/mode.js").catch(() => null);
    if (mod) {
      modeFromState = mod.modeFromState;
      togglesForMode = mod.togglesForMode;
      statusForMode = mod.statusForMode;
      MODE_LABELS = mod.MODE_LABELS;
    }
  });

  // ─── T-SP-C.Mode.1 ───────────────────────────────────────────────────────────
  it("T-SP-C.Mode.1: AppMode union includes 'magical'; MODE_LABELS.magical === 'Magical'", () => {
    // Given: the mode.ts module (post-builder: AppMode = "manual" | "magical" | "auto")
    // When:  MODE_LABELS.magical is read
    // Then:  MODE_LABELS.magical === "Magical" (proves the 3-mode union is complete)
    //   Covers G-SP-C.1
    assert.ok(MODE_LABELS, "MODE_LABELS must be exported");
    assert.equal(MODE_LABELS.magical, "Magical", "MODE_LABELS.magical must be 'Magical'");
    assert.equal(MODE_LABELS.manual, "Manual", "MODE_LABELS.manual must be 'Manual'");
    assert.equal(MODE_LABELS.auto, "Auto", "MODE_LABELS.auto must be 'Auto'");
  });

  // ─── T-SP-C.Mode.2 ───────────────────────────────────────────────────────────
  it("T-SP-C.Mode.2: modeFromState derivation precedence is correct for all 4 flag combinations", () => {
    // Given: modeFromState({cronEnabled, passiveEnabled})
    // When:  called with all 4 flag combinations:
    //   {false, false} → "manual"
    //   {false, true}  → "magical"
    //   {true,  false} → "auto"
    //   {true,  true}  → "auto" (cron wins)
    // Then:  all four return values match expectations
    //   Covers G-SP-C.2
    assert.ok(typeof modeFromState === "function", "modeFromState must be exported");
    assert.equal(
      modeFromState({ cronEnabled: false, passiveEnabled: false }),
      "manual",
      "{cron:false, passive:false} → 'manual'",
    );
    assert.equal(
      modeFromState({ cronEnabled: false, passiveEnabled: true }),
      "magical",
      "{cron:false, passive:true} → 'magical'",
    );
    assert.equal(
      modeFromState({ cronEnabled: true, passiveEnabled: false }),
      "auto",
      "{cron:true, passive:false} → 'auto'",
    );
    assert.equal(
      modeFromState({ cronEnabled: true, passiveEnabled: true }),
      "auto",
      "{cron:true, passive:true} → 'auto' (cron wins over passive)",
    );
  });

  // ─── T-SP-C.Mode.3 ───────────────────────────────────────────────────────────
  it("T-SP-C.Mode.3: togglesForMode round-trips through modeFromState for all 3 modes", () => {
    // Given: modeFromState + togglesForMode for all 3 modes
    // When:  modeFromState(togglesForMode(m)) for m in ["manual", "magical", "auto"]
    // Then:  identity holds for all three: result === m
    //   Covers G-SP-C.3 (derivation consistency)
    assert.ok(typeof togglesForMode === "function", "togglesForMode must be exported");
    for (const mode of ["manual", "magical", "auto"] as const) {
      const flags = togglesForMode(mode);
      const derived = modeFromState(flags);
      assert.equal(derived, mode, `modeFromState(togglesForMode("${mode}")) must round-trip back to "${mode}"`);
    }
  });

  // ─── T-SP-C.Mode.4 ───────────────────────────────────────────────────────────
  it("T-SP-C.Mode.4: statusForMode('magical') returns {label:'Observing', tone:'observing'}", () => {
    // Given: statusForMode
    // When:  called with "magical"
    // Then:  { label: "Observing", tone: "observing" }
    //   Covers G-SP-C.4
    assert.ok(typeof statusForMode === "function", "statusForMode must be exported");
    assert.deepEqual(
      statusForMode("magical"),
      { label: "Observing", tone: "observing" },
      "statusForMode('magical') must return {label:'Observing', tone:'observing'}",
    );
    // Regression: manual + auto unchanged
    assert.deepEqual(statusForMode("manual"), { label: "Listening", tone: "listening" });
    assert.deepEqual(statusForMode("auto"), { label: "Working", tone: "working" });
  });
});
