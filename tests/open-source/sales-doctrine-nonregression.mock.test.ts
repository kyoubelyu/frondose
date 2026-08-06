import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeSystemPrompt } from "../../src/agent/systemPrompt/compose.js";
import { composeSoulBand } from "../../src/agent/systemPrompt/soul.js";
import { METHODOLOGY_DISTILLATION } from "../../src/methodology/distill.js";

const lowerDoctrine = METHODOLOGY_DISTILLATION.toLowerCase();

describe("public sales doctrine preserves behavior without private or book-derived expression", () => {
  it("T-OS.Sales.1: Boundary, Soul and Checkpoint order remains invariant while stable phase tokens survive", () => {
    // Given a candidate Soul and sentinel outer bands, when composed, then order and compatibility tokens remain exact.
    const soul = composeSoulBand({
      fullName: "Synthetic Seller",
      company: "Example Co",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const composed = composeSystemPrompt({ boundary: "BOUNDARY", soul, checkpoint: "CHECKPOINT" });
    assert.deepEqual(composed.split("\n\n---\n\n"), ["BOUNDARY", soul, "CHECKPOINT"]);
    for (const token of [
      "precall",
      "spark-interest",
      "R1-open",
      "R2-controlled",
      "R3-confirming",
      "I1-open",
      "C3-confirming",
      "validate",
      "close",
      "post",
      "disqualified",
    ]) {
      assert.ok(METHODOLOGY_DISTILLATION.includes(token), `missing stable phase token: ${token}`);
    }
  });

  it("T-OS.Sales.2: doctrine requires causal evidence before capability pitching", () => {
    // Given an unexplained prospect symptom, when the doctrine is inspected, then cause-first discovery precedes capability guidance.
    assert.match(lowerDoctrine, /cause.*before.*capability|causal evidence.*before.*capability/);
    assert.match(lowerDoctrine, /test one hypothesis at a time/);
    assert.match(lowerDoctrine, /observed facts.*buyer-confirmed.*hypotheses/);
  });

  it("T-OS.Sales.3: doctrine maps both decision stakeholders and operational impact before qualification or scoring", () => {
    // Given operational friction, when the doctrine guides discovery, then upstream owners, downstream roles and measurable impact remain explicit.
    assert.match(lowerDoctrine, /affected stakeholders/);
    assert.match(lowerDoctrine, /upstream.*decision|decision owner/);
    assert.match(lowerDoctrine, /downstream.*execution|operational role/);
    assert.match(lowerDoctrine, /measurable business consequence|business impact/);
  });

  it("T-OS.Sales.4: doctrine elicits buyer-owned outcomes and forbids invented value evidence", () => {
    // Given cause and impact evidence, when progressing discovery, then outcomes come from the buyer and quantities cannot be fabricated.
    assert.match(lowerDoctrine, /buyer-owned desired capability|buyer-owned outcome/);
    assert.match(lowerDoctrine, /buyer-confirmed quantities/);
    assert.match(lowerDoctrine, /never invent numbers|do not invent numbers/);
    assert.match(lowerDoctrine, /validate.*outcome|outcome validation/);
  });

  it("T-OS.Sales.5: doctrine reduces pressure and reopens discovery when the buyer resists", () => {
    // Given short replies, pushback or deflection, when the doctrine chooses a next move, then it regresses to open discovery without outbound escalation.
    assert.match(lowerDoctrine, /short replies/);
    assert.match(lowerDoctrine, /pushback/);
    assert.match(lowerDoctrine, /deflection/);
    assert.match(lowerDoctrine, /reduce pressure/);
    assert.match(lowerDoctrine, /reopen discovery|return.*open discovery/);
  });

  it("T-OS.Sales.6: doctrine preserves contextual selling modes under generic labels", () => {
    // Given four evidence patterns, when method posture is selected, then exploratory, insight-led, causal and enterprise mapping modes remain available.
    for (const label of ["exploratory", "insight-led", "causal", "enterprise-mapping"]) {
      assert.ok(lowerDoctrine.includes(label), `missing generic method label: ${label}`);
    }
    assert.match(lowerDoctrine, /record.*selected.*label/);
  });

  it("T-OS.Sales.7: public doctrine contains no private reference pointer, branded default, copied role skeleton or fixed performance ratio", () => {
    // Given the public doctrine, when scanned for excluded expression, then every banned book/private marker is absent.
    const banned = [
      "references/methodology",
      "solution selling",
      "pain chain",
      "key players list",
      "value cycle",
      "book base 7-role skeleton",
      "controlled:open ≈ 3:1",
    ];
    for (const token of banned) assert.ok(!lowerDoctrine.includes(token), `banned public doctrine token: ${token}`);
  });
});
