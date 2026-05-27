/**
 * P-SP-A mock tests — T-SP-A.Soul.1
 * composeSoulBand system-prompt fragment — kernel-tool nudge paragraph present.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeSoulBand } from "../../src/agent/systemPrompt/soul.js";
import type { IdentityRecord } from "../../src/persistence/identity.js";

describe("T-SP-A.Soul — composeSoulBand system-prompt fragment", () => {
  // ─── T-SP-A.Soul.1 ───────────────────────────────────────────────────────────
  it("T-SP-A.Soul.1: composeSoulBand output contains record_raw_candidate kernel-tool nudge", async () => {
    // Given: a minimal identity record (name, role, company)
    // When:  composeSoulBand(identity) invoked
    // Then:  returned string contains the substring 'record_raw_candidate';
    //        also contains 'get_lead_context' and 'list_due_followups'
    //        (all three are named in the §6.4-O soul paragraph)
    const minimalIdentity: IdentityRecord = {
      fullName: "Test Operator",
      role: "VP Sales",
      company: "TestCo",
      persona: "Direct outbound sales for B2B SaaS",
      style: "Direct and empathetic",
      icp: {
        targetRole: ["VP Engineering", "CTO"],
        industry: ["SaaS"],
      },
      freeAxes: {
        pain_chain_lean: "business",
        lead_role: "economic_buyer",
        discovery_lean: "insight_led",
        story_shape: "problem_agitate_solve",
      },
    };

    const soulBand = composeSoulBand(minimalIdentity);

    assert.ok(typeof soulBand === "string" && soulBand.length > 0, "composeSoulBand must return a non-empty string");
    assert.ok(
      soulBand.includes("record_raw_candidate"),
      "Soul band must contain 'record_raw_candidate' kernel-tool nudge (§6.4-O soul paragraph)",
    );
    assert.ok(soulBand.includes("get_lead_context"), "Soul band must contain 'get_lead_context' kernel-tool nudge");
    assert.ok(soulBand.includes("list_due_followups"), "Soul band must contain 'list_due_followups' kernel-tool nudge");

    // Also verify identity sentence is present (basic composition smoke)
    assert.ok(soulBand.includes("Test Operator"), "Soul band must include operator name from identity");
  });
});
