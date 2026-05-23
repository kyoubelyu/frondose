/**
 * P-Y2.1 Step 5 — T-Mode.1..5 (app-level Manual/Auto mode model) — FILLED.
 *
 * Pure-unit tests: import `src/tauri/ui/mode.ts` and assert the cron→mode derivation, the mode→toggles
 * mapping (R-3 = Option II: passive OFF in BOTH modes), and the status microcopy.
 *
 * Gate coverage:
 *   G-PY2.1.2 — mode model folds cron(+passive) correctly; microcopy correct (T-Mode.1..5)
 *   G-PY2.1.3 — auto ⇒ cron-on (drives the approvalMode='auto' chain) (T-Mode.4)
 *   G-PY2.1.7 — manual ⇒ cron-off (supervised boot default) (T-Mode.3)
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *   --test-timeout=30000 tests/tauri/mode-pY2.1.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODE_LABELS, modeFromToggles, statusForMode, togglesForMode } from "../../src/tauri/ui/mode.js";

describe("mode — cron→mode derivation (G-PY2.1.2)", () => {
  it("T-Mode.1: when modeFromToggles(false), returns 'manual'", () => {
    // Given: modeFromToggles
    // When:  called with cronEnabled=false
    // Then:  returns 'manual'
    assert.equal(modeFromToggles(false), "manual");
  });

  it("T-Mode.2: when modeFromToggles(true), returns 'auto'", () => {
    // Given: modeFromToggles
    // When:  called with cronEnabled=true
    // Then:  returns 'auto'
    assert.equal(modeFromToggles(true), "auto");
  });
});

describe("mode — mode→toggles mapping (R-3 Option II: passive OFF both modes) (G-PY2.1.2)", () => {
  it("T-Mode.3: when togglesForMode('manual'), returns { cronEnabled:false, passiveEnabled:false }", () => {
    // Given: togglesForMode (R-3 Option II — supervised = no autonomous cron + passive OFF per P-57g safety)
    // When:  called with 'manual'
    // Then:  { cronEnabled:false, passiveEnabled:false } (passive-ON-in-Manual is the deferred end-state)
    assert.deepEqual(togglesForMode("manual"), { cronEnabled: false, passiveEnabled: false });
  });

  it("T-Mode.4: when togglesForMode('auto'), returns { cronEnabled:true, passiveEnabled:false }", () => {
    // Given: togglesForMode
    // When:  called with 'auto'
    // Then:  { cronEnabled:true, passiveEnabled:false } (autonomous cron drives approvalMode='auto'; passive still OFF)
    assert.deepEqual(togglesForMode("auto"), { cronEnabled: true, passiveEnabled: false });
  });

  it("T-Mode.4b (edge): passive is OFF in BOTH modes (P-57g safety invariant)", () => {
    // Given: togglesForMode
    // When:  called with 'manual' and 'auto'
    // Then:  passiveEnabled is false in both — the locked Option II invariant; only cronEnabled differs by mode
    assert.equal(togglesForMode("manual").passiveEnabled, false, "manual passive must be OFF");
    assert.equal(togglesForMode("auto").passiveEnabled, false, "auto passive must be OFF");
    assert.notEqual(
      togglesForMode("manual").cronEnabled,
      togglesForMode("auto").cronEnabled,
      "only cron differs by mode",
    );
  });
});

describe("mode — status microcopy + labels (G-PY2.1.2)", () => {
  it("T-Mode.5: when statusForMode('manual') then ('auto'), returns 'Listening'/'listening' then 'Working'/'working'; MODE_LABELS = Manual/Auto", () => {
    // Given: statusForMode + MODE_LABELS (design-doc §6 L205-208, §12 L395)
    // When:  called with 'manual' then 'auto'
    // Then:  { label:'Listening', tone:'listening' } then { label:'Working', tone:'working' }; MODE_LABELS={manual:'Manual',auto:'Auto'}
    assert.deepEqual(statusForMode("manual"), { label: "Listening", tone: "listening" });
    assert.deepEqual(statusForMode("auto"), { label: "Working", tone: "working" });
    assert.equal(MODE_LABELS.manual, "Manual");
    assert.equal(MODE_LABELS.auto, "Auto");
  });
});
