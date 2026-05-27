/**
 * P-SP-C scaffold — T-SP-C.ServeBoot.1 (F-11)
 * Serve boot-time soul mode: modeFromState → soulModeFragment composition
 * is correct for all 3 mode flag combinations.
 *
 * Step 4a: assertion bodies are TODO stubs — ALL FAIL pre-builder.
 * Step 5:  builder adds modeFromState call to serve.ts (F-4 §5.4) and
 *          modeFromState to mode.ts (F-1 §5.1) → assertions filled.
 *
 * REGRESSION GUARD for the hardcoded `soulModeFragment("manual")` removal in
 * serve.ts (F-4). Tests the composition chain independently without importing
 * serve.ts (which has deep boot-time side effects).
 *
 * SEAM: tests the three-function chain `modeFromState → soulModeFragment`
 * directly, mirroring the exact code the builder pastes at serve.ts:63-66 (§5.4.2):
 *   const bootMode = modeFromState({cronEnabled, passiveEnabled});
 *   const soulBand = `... ${soulModeFragment(bootMode)}`;
 * This seam is valid because serve.ts delegates both decisions to the imported
 * functions; testing those functions in combination is equivalent to testing
 * the serve.ts boot logic without importing the entire module.
 *
 * NOTE: modeFromState doesn't exist pre-builder. Dynamic import defers resolution.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/serve/serveBootSoulMode.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
// biome-ignore lint/suspicious/noExplicitAny: signature widened post-builder; runtime type-erasure is safe
import { soulModeFragment } from "../../src/agent/systemPrompt/soul.js";

// Dynamic import for modeFromState (doesn't exist in mode.ts pre-builder).
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder scaffold
let modeFromState: ((flags: { cronEnabled: boolean; passiveEnabled: boolean }) => string) | any;

describe("T-SP-C.ServeBoot — serve boot-time soul mode derivation (P-SP-C)", () => {
  before(async () => {
    // TODO (builder F-1 Step 4b): add modeFromState to src/tauri/ui/mode.ts.
    // TODO (builder F-4 Step 4b): update serve.ts boot to call modeFromState.
    const mod = await import("../../src/tauri/ui/mode.js").catch(() => null);
    if (mod && typeof mod.modeFromState === "function") {
      modeFromState = mod.modeFromState;
    }
  });

  // ─── T-SP-C.ServeBoot.1 ──────────────────────────────────────────────────────
  it("T-SP-C.ServeBoot.1: modeFromState → soulModeFragment composition produces correct soul fragment for all 3 boot flag combinations", () => {
    // Given: modeFromState (from mode.ts F-1) + soulModeFragment (from soul.ts F-3)
    // When:  composition chain for 3 flag combinations:
    //   {cronEnabled:true,  passiveEnabled:false} → bootMode="auto"
    //     → soulBand contains "AUTO mode"
    //   {cronEnabled:false, passiveEnabled:true}  → bootMode="magical"
    //     → soulBand contains "MAGICAL mode"
    //   {cronEnabled:false, passiveEnabled:false} → bootMode="manual"
    //     → soulBand contains "MANUAL mode"
    // Then:  all three assertions hold
    //   Covers G-SP-C.9 — regression guard for hardcoded-"manual" removal in serve.ts
    // The seam under test: serve.ts boot logic (lines 72-75):
    //   const bootMode = modeFromState({ cronEnabled: cronEnabledAtBoot, passiveEnabled: passiveEnabledAtBoot });
    //   const soulBand = `${resolveSoulBand(...)} \n\n${soulModeFragment(bootMode)}`;
    // We test the two-function composition directly (modeFromState → soulModeFragment),
    // mirroring the serve.ts boot chain without importing the runServe() side-effect bundle.
    assert.ok(typeof modeFromState === "function", "modeFromState must be exported from mode.ts (builder F-1)");

    // Case 1: cronEnabled=true → bootMode="auto" → soul fragment contains "AUTO mode"
    const autoMode = modeFromState({ cronEnabled: true, passiveEnabled: false });
    assert.equal(autoMode, "auto", "cron=true → 'auto'");
    const autoFragment = soulModeFragment(autoMode);
    assert.ok(
      autoFragment.includes("AUTO mode"),
      `soulModeFragment("auto") must contain "AUTO mode". Got: ${autoFragment.slice(0, 80)}`,
    );

    // Case 2: passiveEnabled=true, cron=false → bootMode="magical" → soul fragment contains "MAGICAL mode"
    const magicalMode = modeFromState({ cronEnabled: false, passiveEnabled: true });
    assert.equal(magicalMode, "magical", "passive=true, cron=false → 'magical'");
    const magicalFragment = soulModeFragment(magicalMode as any);
    assert.ok(
      magicalFragment.includes("MAGICAL mode"),
      `soulModeFragment("magical") must contain "MAGICAL mode". Got: ${magicalFragment.slice(0, 80)}`,
    );

    // Case 3: both false → bootMode="manual" → soul fragment contains "MANUAL mode"
    const manualMode = modeFromState({ cronEnabled: false, passiveEnabled: false });
    assert.equal(manualMode, "manual", "cron=false, passive=false → 'manual'");
    const manualFragment = soulModeFragment(manualMode);
    assert.ok(
      manualFragment.includes("MANUAL mode"),
      `soulModeFragment("manual") must contain "MANUAL mode". Got: ${manualFragment.slice(0, 80)}`,
    );
  });
});

// Expose soulModeFragment directly — it's used at Step 5 fill time.
void soulModeFragment;
