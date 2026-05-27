/**
 * P-54 Step 4a scaffold — T-Soul.1 (G-P54.3).
 *
 * Failing-at-Step-4a scaffold for the Soul-band rewrite at `src/agent/systemPrompt/soul.ts:88`.
 * Per outside-in TDD + BDD-light (CLAUDE.md § Test Discipline):
 *   - Behavior-named test (`describe`/`it`) with a Given/When/Then intent comment.
 *   - All assertion bodies are `assert.fail("TODO Step 5: …")`. Validator fills at Step 5.
 *
 * Gate coverage: G-P54.3 — assembled Soul band contains the new single-call habit + negative
 *                conversational guard; the old triple-call substring is absent.
 *
 * Builder (Codex Step 4b) rewrites the final string in the `triggerHabits` array
 * (currently `soul.ts:88`) per plan §6.4. Until then, this test fails with
 * `assert.fail("TODO Step 5: …")` — the intentional Step-4a state.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeSoulBand } from "../../../src/agent/systemPrompt/soul.js";
import type { IdentityRecord } from "../../../src/persistence/identity.js";

/** Minimal identity record sufficient for `composeSoulBand` — drives Section 1's identity sentence. */
function makeMinimalIdentity(): IdentityRecord {
  return {
    fullName: "Test Operator",
    company: "TestCo",
    role: "BD",
    persona: "You do outbound sales, methodology is Solution Selling®",
    icp: {
      targetRole: ["VP Sales"],
      industry: ["SaaS"],
      companySize: { min: 50, max: 500 },
      geography: ["US"],
    },
    style: "Direct, technical, empathetic",
    freeAxes: {
      pain_chain_lean: "P1",
      lead_role: "L1",
      discovery_lean: "D1",
      story_shape: "S1",
    },
    updatedAt: new Date().toISOString(),
  } as unknown as IdentityRecord;
}

// ─── T-Soul.1 ────────────────────────────────────────────────────────────────

describe("composeSoulBand triggerHabits rewrite (G-P54.3)", () => {
  it("T-Soul.1: when composeSoulBand(identity) runs for a non-null identity, the Soul band contains the single-call escalate habit + retry anchoring + conversational guard AND does NOT contain the old triple-call substring", () => {
    // Given: a populated IdentityRecord (non-null) fed into composeSoulBand
    // When:  the returned Soul-band string is inspected
    // Then:  (a) it CONTAINS the substring "escalate_for_capability"
    //            in the trigger-habits section (single-call habit);
    //        (b) it CONTAINS a phrase signalling capability-gap retry anchoring;
    //        (c) it CONTAINS a phrase signalling the negative conversational guard
    //            (one of: "conversation, not escalation", "ask about your capabilities",
    //            "discusses features");
    //        (d) it does NOT contain the old substring
    //            'first report it to the operator via `telegram_notify`, then file a trackable issue with `gh_issue`'
    //            (the pre-P-54 triple-call teaching, soul.ts:88 before rewrite).
    const identity = makeMinimalIdentity();
    const soul = composeSoulBand(identity);

    // (a) Single-call habit: "escalate_for_capability" must appear in the trigger-habits section.
    assert.ok(
      soul.includes("escalate_for_capability"),
      "Soul band must mention `escalate_for_capability` (single-call habit)",
    );

    // (b) Capability-gap anchoring: current P-66 wording is behavior-level, not exact P-54 phrasing.
    const hasTaskExecAnchor =
      soul.includes("genuinely needed tool is missing after a reasonable retry") ||
      soul.includes("genuinely does not exist") ||
      soul.includes("reasonable retry");
    assert.ok(hasTaskExecAnchor, "Soul band must contain a capability-gap retry anchor");

    // (c) Negative conversational guard: one of the three accepted phrasings.
    const hasNegativeGuard =
      soul.includes("conversation, not escalation") ||
      soul.includes("ask about your capabilities") ||
      soul.includes("discusses features");
    assert.ok(
      hasNegativeGuard,
      "Soul band must contain a negative conversational guard (one of: 'conversation, not escalation', 'ask about your capabilities', 'discusses features')",
    );

    // (d) Old pre-P-54 triple-call substring must be absent.
    const OLD_TRIPLE_CALL =
      "first report it to the operator via `telegram_notify`, then file a trackable issue with `gh_issue`";
    assert.ok(
      !soul.includes(OLD_TRIPLE_CALL),
      `Soul band must NOT contain the old pre-P-54 triple-call teaching; offending substring is still present: ${OLD_TRIPLE_CALL}`,
    );
  });
});
