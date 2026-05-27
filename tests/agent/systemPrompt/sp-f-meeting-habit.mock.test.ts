/**
 * P-SP-F Step 5 — T-F.SoulHabit.1/2/3 + T-F.SoulBand.Regression — assertions (filled).
 *
 * Assertion bodies FILLED at Step 5.
 *
 * Gates covered:
 *   G-PSPF.12 — T-F.SoulHabit.1a, .1b, .1c, .2a, .2b, .3
 *   G-PSPF.13 — T-F.SoulBand.Regression
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemPrompt/sp-f-meeting-habit.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Use static named imports (same pattern as soul-sp-d-habit.mock.test.ts in this directory).
// Path: ../../../src/ (3 levels up from tests/agent/systemPrompt/) = frondose repo root.
import { composeSoulBand, soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

// ─── T-F.SoulHabit.1 ────────────────────────────────────────────────────────────

describe("T-F.SoulHabit.1 — soulModeFragment('manual') contains meeting_booked + sales_intent detection habit (G-PSPF.12)", () => {
  it("T-F.SoulHabit.1a: soulModeFragment('manual') contains 'update_lead_stage' tool name (Sketch F.6.1)", () => {
    // Given: src/agent/systemPrompt/soul.ts post-builder (Sketch F.6.1 pasted into manual fragment)
    // When:  soulModeFragment("manual") called
    // Then:  returned string contains 'update_lead_stage'
    const fragment = soulModeFragment("manual");
    assert.ok(
      fragment.includes("update_lead_stage"),
      "soulModeFragment('manual') must contain 'update_lead_stage' (Sketch F.6.1 outcome-tracking habit)",
    );
  });

  it("T-F.SoulHabit.1b: soulModeFragment('manual') contains stage:'meeting_booked' and stage:'sales_intent' outcome strings (Sketch F.6.1)", () => {
    // Given: src/agent/systemPrompt/soul.ts post-builder (Sketch F.6.1 pasted)
    // When:  soulModeFragment("manual") called
    // Then:  returned string contains both 'meeting_booked' and 'sales_intent'
    const fragment = soulModeFragment("manual");
    assert.ok(
      fragment.includes("meeting_booked"),
      "soulModeFragment('manual') must contain 'meeting_booked' (north-star outcome)",
    );
    assert.ok(
      fragment.includes("sales_intent"),
      "soulModeFragment('manual') must contain 'sales_intent' (interest-without-meeting outcome)",
    );
  });

  it("T-F.SoulHabit.1c: soulModeFragment('manual') warns against record_lead_event double-count and uses param name 'stage' not 'newStage' (Sketch F.6.1)", () => {
    // Given: src/agent/systemPrompt/soul.ts post-builder (Sketch F.6.1 pasted)
    // When:  soulModeFragment("manual") called
    // Then:  returned string contains 'record_lead_event' (the do-NOT-double-count warning)
    //        AND contains 'stage:' (correct Zod param name)
    //        AND does NOT contain 'newStage' (wrong param name — would indicate a stale copy)
    const fragment = soulModeFragment("manual");
    assert.ok(
      fragment.includes("record_lead_event"),
      "soulModeFragment('manual') must contain 'record_lead_event' (double-count warning)",
    );
    assert.ok(
      fragment.includes("stage:"),
      "soulModeFragment('manual') must contain 'stage:' (correct Zod param name; not 'newStage')",
    );
    assert.ok(
      !fragment.includes("newStage"),
      "soulModeFragment('manual') must NOT contain 'newStage' (stale wrong param name)",
    );
  });
});

// ─── T-F.SoulHabit.2 ────────────────────────────────────────────────────────────

describe("T-F.SoulHabit.2 — soulModeFragment('auto') contains meeting_booked + sales_intent detection habit (G-PSPF.12)", () => {
  it("T-F.SoulHabit.2a: soulModeFragment('auto') contains 'update_lead_stage' and 'meeting_booked' (Sketch F.6.2 appended to P-SP-E fragment)", () => {
    // Given: src/agent/systemPrompt/soul.ts post-builder (Sketch F.6.2 appended AFTER
    //        P-SP-E expansion of the auto fragment — SEQUENCING: requires P-SP-E first)
    // When:  soulModeFragment("auto") called
    // Then:  returned string contains both 'update_lead_stage' and 'meeting_booked'
    const fragment = soulModeFragment("auto");
    assert.ok(
      fragment.includes("update_lead_stage"),
      "soulModeFragment('auto') must contain 'update_lead_stage' (outcome tracking habit)",
    );
    assert.ok(
      fragment.includes("meeting_booked"),
      "soulModeFragment('auto') must contain 'meeting_booked' (north-star Auto outcome)",
    );
  });

  it("T-F.SoulHabit.2b: soulModeFragment('auto') contains 'sales_intent' and warns against double-count (Sketch F.6.2)", () => {
    // Given: src/agent/systemPrompt/soul.ts post-builder (Sketch F.6.2 appended)
    // When:  soulModeFragment("auto") called
    // Then:  returned string contains 'sales_intent' AND 'record_lead_event'
    //        (the warning text referencing record_lead_event appears in the auto fragment)
    const fragment = soulModeFragment("auto");
    assert.ok(
      fragment.includes("sales_intent"),
      "soulModeFragment('auto') must contain 'sales_intent' (interest detection in Auto mode)",
    );
    assert.ok(
      fragment.includes("record_lead_event"),
      "soulModeFragment('auto') must contain 'record_lead_event' (double-count warning matches manual)",
    );
  });
});

// ─── T-F.SoulHabit.3 ────────────────────────────────────────────────────────────

describe("T-F.SoulHabit.3 — soulModeFragment('magical') does NOT contain 'meeting_booked' (G-PSPF.12)", () => {
  it("T-F.SoulHabit.3: soulModeFragment('magical') does not contain 'meeting_booked' (Magical never initiates outbound — Sketch F.6.3 UNCHANGED per OQ-F1)", () => {
    // Given: src/agent/systemPrompt/soul.ts — soulModeFragment("magical") path
    //        (UNCHANGED by Sketch F per OQ-F1 architect decision: Magical = read-only observe mode)
    // When:  soulModeFragment("magical") called
    // Then:  returned string does NOT contain 'meeting_booked'
    //        (Magical = passive background observation; no outbound → no meeting detection habit)
    const fragment = soulModeFragment("magical");
    assert.ok(
      !fragment.includes("meeting_booked"),
      "soulModeFragment('magical') must NOT contain 'meeting_booked' (OQ-F1: Magical is read-only, no outbound)",
    );
  });
});

// ─── T-F.SoulBand.Regression ─────────────────────────────────────────────────────

describe("T-F.SoulBand.Regression — composeSoulBand(null).length <= 8000 after Sketch F (G-PSPF.13)", () => {
  it("T-F.SoulBand.Regression: composeSoulBand(null).length is at most 8000 (Sketch F edits soulModeFragment OUTSIDE composeSoulBand — ZERO cap impact per plan §5.6)", () => {
    // Given: soul.ts post-builder with Sketch F.6.1 + F.6.2 applied
    //        (soulModeFragment edits are OUTSIDE composeSoulBand — no change to SOUL band length)
    // When:  composeSoulBand(null) called (no identity override; all defaults)
    // Then:  returned string length <= 8000 (checkpoint.ts cap)
    //        Pre-Sketch-F measurement: composeSoulBand(null).length === 7987 (plan §5.6)
    //        Post-Sketch-F: identical length (soulModeFragment not used inside composeSoulBand)
    const band = composeSoulBand(null);
    assert.equal(typeof band, "string", "composeSoulBand(null) must return a string");
    assert.ok(
      band.length <= 8000,
      `composeSoulBand(null).length must be <= 8000 (checkpoint.ts cap); got ${band.length}`,
    );
  });
});
