/**
 * P-SP-D Step 5 — T-SP-D.Soul.1, T-SP-D.Soul.2, T-SP-D.Soul.3 (assertions filled)
 *
 * Soul band text assertions for the P-SP-D Manual Conversation Sales Workflow
 * prompt-engineering changes:
 *   F-1 — new outbound-chain trigger habit added to `triggerHabits` array in soul.ts
 *          (Sketch A: record_raw_candidate → score_lead → promote → save_message_draft →
 *           todo_write(requiresApproval) → [gate] → click → mark_message_sent +
 *           update_lead_stage("connect_sent") for connect; mark_message_sent-only for DM)
 *   F-2 — `soulModeFragment("manual")` extended with draft-first discipline
 *
 * Gates covered:
 *   G-PSPD.1 (T-SP-D.Soul.1 + T-SP-D.Soul.2) — Soul band contains draft-first chain habit
 *   G-PSPD.2 (T-SP-D.Soul.3)                  — soulModeFragment("manual") references draft-first
 *
 * Run (mock only, no Chrome, no LLM, no DB):
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/systemPrompt/soul-sp-d-habit.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeSoulBand, soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

describe("T-SP-D.Soul — outbound-chain trigger habit + soulModeFragment draft-first (P-SP-D §4.1)", () => {
  // ─── T-SP-D.Soul.1 ───────────────────────────────────────────────────────────

  it("T-SP-D.Soul.1: when composeSoulBand(null) is called after P-SP-D F-1 paste, the soul band contains all 5 chained tool names + the ordered chain phrase (promote…save_message_draft…todo_write)", () => {
    // Given: src/agent/systemPrompt/soul.ts after P-SP-D Sketch A F-1 edit —
    //        the new trigger habit is added to the triggerHabits array between the
    //        existing record_raw_candidate habit (pre-L93) and the escalate habit (L94)
    // When:  composeSoulBand(null) is called (null = no identity = placeholder defaults)
    // Then:  the returned string contains ALL of:
    //        "save_message_draft", "promote_candidate_to_lead", "todo_write",
    //        "requiresApproval", "mark_message_sent"
    //        AND a phrase matching /promote_candidate_to_lead.*save_message_draft.*todo_write/s
    //        (the ordered chain: promote first → draft → declare requiresApproval)

    const band = composeSoulBand(null);

    // All 5 tool names must appear in the trigger habit (F-1)
    assert.ok(
      band.includes("save_message_draft"),
      "soul band must include save_message_draft (F-1 trigger habit, G-PSPD.1)",
    );
    assert.ok(
      band.includes("promote_candidate_to_lead"),
      "soul band must include promote_candidate_to_lead (F-1 trigger habit, G-PSPD.1)",
    );
    assert.ok(band.includes("todo_write"), "soul band must include todo_write (F-1 trigger habit, G-PSPD.1)");
    assert.ok(
      band.includes("requiresApproval"),
      "soul band must include requiresApproval (F-1 trigger habit, G-PSPD.1)",
    );
    assert.ok(
      band.includes("mark_message_sent"),
      "soul band must include mark_message_sent (F-1 trigger habit, G-PSPD.1)",
    );

    // Ordered chain phrase: promote_candidate_to_lead → save_message_draft → todo_write
    assert.match(
      band,
      /promote_candidate_to_lead.*save_message_draft.*todo_write/s,
      "soul band must contain the ordered chain phrase: promote_candidate_to_lead → save_message_draft → todo_write (G-PSPD.1)",
    );
  });

  // ─── T-SP-D.Soul.2 ───────────────────────────────────────────────────────────

  it("T-SP-D.Soul.2: when composeSoulBand(null) is called after P-SP-D F-1 paste, the soul band names the post-outbound close pair with the connect_note-vs-DM asymmetry", () => {
    // Given: src/agent/systemPrompt/soul.ts after P-SP-D Sketch A F-1 edit
    // When:  composeSoulBand(null) called
    // Then:  contains ALL of: "mark_message_sent", "update_lead_stage", "connect_sent"
    //        AND the DM-asymmetry note ("for a DM, mark_message_sent only" or equivalent)
    //        soul cap invariant: composeSoulBand(null).length ≤ 9600 (T-ICP-PRECISION raised 8000→8500;
    //        P-ONBOARD-CONVERSATIONAL-IDENTITY raised 8500→9600)

    const band = composeSoulBand(null);

    // Post-outbound close pair: both calls named
    assert.ok(
      band.includes("mark_message_sent"),
      "soul band must include mark_message_sent for post-outbound close (G-PSPD.1)",
    );
    assert.ok(
      band.includes("update_lead_stage"),
      "soul band must include update_lead_stage for connect-note close (G-PSPD.1)",
    );
    assert.ok(band.includes("connect_sent"), "soul band must include connect_sent stage (G-PSPD.1)");

    // DM-asymmetry: "for a DM, mark_message_sent only (no stage advance)"
    assert.match(
      band,
      /for a DM.*mark_message_sent.*only/s,
      "soul band must include the DM-asymmetry note 'for a DM, mark_message_sent only' (G-PSPD.1)",
    );

    // Soul cap invariant (builder measured: 7987 chars; P-39 raised 6000→8000;
    // T-ICP-PRECISION raised 8000→8500 for the own_company + icp-override habit lines, actual ~8380;
    // P-ONBOARD-CONVERSATIONAL-IDENTITY raised 8500→9600 for the conditional first-contact
    // onboarding directive, identity===null-only, actual ~9480)
    assert.ok(
      band.length <= 9600,
      `composeSoulBand(null).length must be ≤ 9600 chars (got ${band.length}) — P-SP-D Sketch A must not push over cap (G-PSPD.1)`,
    );
  });

  // ─── T-SP-D.Soul.3 ───────────────────────────────────────────────────────────

  it("T-SP-D.Soul.3: soulModeFragment('manual') contains 'save_message_draft' + 'requiresApproval' + 'in_progress' (F-2 draft-first); soulModeFragment('auto') contains 'AUTO mode' AND now (P-AUTO-14) 'save_message_draft' via CONVERT THE BEST", () => {
    // Given: src/agent/systemPrompt/soul.ts after P-SP-D Sketch A F-2 edit (manual draft-first)
    //        + P-AUTO-14 (auto CONVERT THE BEST adds promote→save_message_draft to the auto arm)
    // When:  soulModeFragment("manual") and soulModeFragment("auto") are called
    // Then:  manual fragment contains "save_message_draft" AND "requiresApproval" AND "in_progress"
    //        auto fragment contains "AUTO mode" AND "save_message_draft" ([D-A14.1] supersedes F-2 pass-through)

    const manualFragment = soulModeFragment("manual");

    // Manual fragment must have the draft-first discipline (F-2)
    assert.ok(
      manualFragment.includes("save_message_draft"),
      `manual fragment must include save_message_draft (F-2 draft-first discipline, G-PSPD.2). Got: '${manualFragment.slice(0, 120)}'`,
    );
    assert.ok(
      manualFragment.includes("requiresApproval"),
      "manual fragment must include requiresApproval (F-2 draft-first discipline, G-PSPD.2)",
    );
    assert.ok(
      manualFragment.includes("in_progress"),
      "manual fragment must include in_progress (F-2 draft-first discipline, G-PSPD.2)",
    );

    // Auto fragment still carries the 'AUTO mode' declaration. [D-A14.1] The original P-SP-D
    // assertion that the auto arm does NOT contain save_message_draft (it was "pass-through" at
    // F-2 time) is SUPERSEDED by P-AUTO-14: the auto fragment's "★ CONVERT THE BEST" directive
    // now intentionally references promote_candidate_to_lead → save_message_draft (the durable
    // capture-then-convert step). The P-SP-D intent (F-2 only touched the MANUAL branch's
    // draft-first discipline) is preserved by the manual assertions above.
    const autoFragment = soulModeFragment("auto");
    assert.ok(
      autoFragment.includes("AUTO mode"),
      "auto fragment must still include 'AUTO mode' (G-PSPD.2)",
    );
    assert.ok(
      autoFragment.includes("save_message_draft"),
      "auto fragment now includes save_message_draft via P-AUTO-14 CONVERT THE BEST (supersedes the F-2 pass-through assertion)",
    );
  });
});
