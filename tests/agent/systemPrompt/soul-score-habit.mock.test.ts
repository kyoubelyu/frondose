/**
 * P-SP-B Step 5 — T-SP-B.SoulHabit.1: soul.ts score_lead trigger habit.
 *
 * FILLED at Step 5. Pre-builder stub replaced with real assertions.
 *
 * Gates covered: §4 T-SP-B.SoulHabit.1 (soul band contains score_lead + record_raw_candidate
 * pairing + candidateId FK pre-condition mention).
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

    const soulBand = composeSoulBand(FIXTURE_IDENTITY);

    assert.ok(typeof soulBand === "string" && soulBand.length > 0, "composeSoulBand must return a non-empty string");

    assert.ok(
      soulBand.includes("score_lead"),
      `Soul band must mention "score_lead" (P-SP-B §6.4(G) trigger habit). ` +
        `Current soul band does NOT contain "score_lead". Builder must add the score_lead habit to triggerHabits.`,
    );

    assert.ok(
      soulBand.includes("record_raw_candidate"),
      `Soul band must mention "record_raw_candidate" (the FK gate before score_lead). ` +
        `Missing from soul band — §6.4(G) habit not yet added.`,
    );

    assert.ok(
      soulBand.includes("candidateId"),
      `Soul band must mention "candidateId" (the FK pre-condition: candidateId gates score_lead). ` +
        `Missing from soul band — §6.4(G) habit not yet added.`,
    );

    console.log(
      `T-SP-B.SoulHabit.1 PASS: soul band contains score_lead + record_raw_candidate + candidateId ` +
        `(§6.4(G) trigger habit present; soul band length = ${soulBand.length} chars).`,
    );
  });
});
