/**
 * P-SP-B Step 4a scaffold — T-SP-B.SoulHabit.1: soul.ts score_lead trigger habit.
 *
 * Assertion body is a TODO stub that intentionally fails pre-builder (Step 4a).
 * Pre-builder failure: composeSoulBand output does NOT yet contain "score_lead" or
 * the "record_raw_candidate → score_lead" muscle-memory pairing — those are added by
 * the P-SP-B §6.4(G) trigger-habit edit in src/agent/systemPrompt/soul.ts.
 *
 * Gates covered: §4 T-SP-B.SoulHabit.1 (soul band contains score_lead + record_raw_candidate
 * pairing + candidateId FK pre-condition mention).
 *
 * Note: composeSoulBand already exists (pre-builder), so the static import SUCCEEDS.
 * The scaffold fails because the assertion immediately calls assert.ok(false, "TODO …").
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/systemPrompt/soul-score-habit.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeSoulBand } from "../../../src/agent/systemPrompt/soul.js";
import type { IdentityRecord } from "../../../src/persistence/identity.js";

/** Minimal identity fixture for soul band rendering (no DB required). */
const FIXTURE_IDENTITY: IdentityRecord = {
  fullName: "Test Operator",
  company: "TestCo",
  updatedAt: new Date().toISOString(),
};

describe("T-SP-B.SoulHabit — soul.ts score_lead trigger habit (§6.4(G))", () => {
  // ─── T-SP-B.SoulHabit.1 ──────────────────────────────────────────────────────

  it("T-SP-B.SoulHabit.1: rendered Soul band contains the score_lead + record_raw_candidate muscle-memory pairing AND mentions the candidateId FK pre-condition", () => {
    // Given: src/agent/systemPrompt/soul.ts after P-SP-B §6.4(G) trigger-habit edit
    //        (new entry appended to triggerHabits array: '...call `score_lead`...'
    //         '...muscle memory is: `record_raw_candidate` first, then `score_lead`...'
    //         '...passing the same candidateId links the person to their account...')
    // When:  composeSoulBand(identity) called with a minimal identity fixture
    // Then:  output string contains "score_lead" AND "record_raw_candidate" AND "candidateId"
    //        (the FK pre-condition mention in the habit text per §6.4(G) sketch)
    //
    // Pre-builder state: triggerHabits does NOT yet contain the score_lead pairing
    // → the assertion fails pre-builder (assert.ok(false, "TODO …")).
    const soulBand = composeSoulBand(FIXTURE_IDENTITY);
    void soulBand; // available for Step 5 assertion bodies
    assert.ok(
      false,
      [
        "T-SP-B.SoulHabit.1 TODO: fill at Step 5 — FAILS pre-builder:",
        "'score_lead' and 'record_raw_candidate' pairing not yet in soul.ts triggerHabits.",
        "After P-SP-B §6.4(G): assert soulBand contains 'score_lead', 'record_raw_candidate', 'candidateId'.",
      ].join(" "),
    );
  });
});
