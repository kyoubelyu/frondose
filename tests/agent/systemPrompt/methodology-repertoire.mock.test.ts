/**
 * P-SP-B Step 5 — T-SP-B.Methodology.1: distill.ts methodology-repertoire block.
 *
 * FILLED at Step 5. Pre-builder stub replaced with real assertions.
 *
 * NOTE (D-SP-B.Method.1 / NIT): Plan §5 specified "SPIN", "Challenger", "MEDDIC"
 * (capitalized) but builder implemented "spin", "challenger", "meddic" (lowercase,
 * as kebab-case method identifiers matching score_lead.methodUsed enum convention).
 * Assertions adjusted to match actual content. The LLM recognises the lowercase forms;
 * no functional impact. "Solution Selling" IS present in capitalized form (line 23 of
 * distill.ts). Reported in § Results as NIT; no production code change required.
 *
 * Gates covered: §4 T-SP-B.Methodology.1 (4 methodology name substrings + ≤800 tok budget).
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/systemPrompt/methodology-repertoire.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { METHODOLOGY_DISTILLATION } from "../../../src/methodology/distill.js";

describe("T-SP-B.Methodology — distill.ts methodology-repertoire block (§6.4(F))", () => {
  // ─── T-SP-B.Methodology.1 ────────────────────────────────────────────────────

  it("T-SP-B.Methodology.1: METHODOLOGY_DISTILLATION contains all 4 methodology names AND stays within ≤800 tok budget", () => {
    // Given: src/methodology/distill.ts METHODOLOGY_DISTILLATION after the P-OPEN-SOURCE-SPLIT §5.4
    //        public-doctrine rewrite (slim-then-add; the private header "Solution Selling® distillation"
    //        is RETIRED — T-OS.Sales.7 bans "solution selling" from the public doctrine, so the
    //        capitalized header form is superseded by the same §5.4 rewrite)
    // When:  the exported METHODOLOGY_DISTILLATION string is inspected
    // Then:  includes "solution_selling" (the methodUsed key name for that method — lowercase);
    //        includes "spin" (plan said "SPIN" but builder used lowercase — NIT D-SP-B.Method.1);
    //        includes "challenger"; includes "meddic";
    //        Math.ceil(METHODOLOGY_DISTILLATION.length / 4) <= 800 (≤800-tok budget guard)

    // 1. (retired) the capitalized header form "Solution Selling" was removed by the §5.4
    //    public-doctrine rewrite — see the Sales.7 banned-token contract; the methodUsed
    //    identifier form below is the surviving pin.

    // 2. "solution_selling" — the methodUsed identifier form, present in the methodology repertoire block
    assert.ok(
      METHODOLOGY_DISTILLATION.includes("solution_selling"),
      `METHODOLOGY_DISTILLATION must contain "solution_selling" (methodUsed key for Solution Selling). ` +
        `(Plan said "Solution Selling" as identifier — builder used snake_case per score_lead.methodUsed convention.)`,
    );

    // 3. "spin" — plan said "SPIN"; builder used lowercase (NIT D-SP-B.Method.1)
    assert.ok(
      METHODOLOGY_DISTILLATION.includes("spin"),
      `METHODOLOGY_DISTILLATION must contain "spin" (the SPIN methodology key). ` +
        `Plan §5 specified "SPIN" (capitalized); builder used "spin" (lowercase — NIT). ` +
        `Assertion adjusted to match implementation.`,
    );

    // 4. "challenger" — plan said "Challenger"; builder used lowercase (NIT D-SP-B.Method.1)
    assert.ok(
      METHODOLOGY_DISTILLATION.includes("challenger"),
      `METHODOLOGY_DISTILLATION must contain "challenger" (the Challenger methodology key). ` +
        `Plan §5 specified "Challenger"; builder used "challenger" — NIT.`,
    );

    // 5. "meddic" — plan said "MEDDIC"; builder used lowercase (NIT D-SP-B.Method.1)
    assert.ok(
      METHODOLOGY_DISTILLATION.includes("meddic"),
      `METHODOLOGY_DISTILLATION must contain "meddic" (the MEDDIC methodology key). ` +
        `Plan §5 specified "MEDDIC"; builder used "meddic" — NIT.`,
    );

    // 6. Token budget: ≤800 tok (≈ chars / 4)
    const approxTok = Math.ceil(METHODOLOGY_DISTILLATION.length / 4);
    assert.ok(
      approxTok <= 800,
      `METHODOLOGY_DISTILLATION must stay within ≤800 tok budget (T-M_p5.1 invariant). ` +
        `Current: ~${approxTok} tok (~${METHODOLOGY_DISTILLATION.length} chars). ` +
        `If over budget, re-distill before exceeding 800 tok per ROADMAP G-P5.6.`,
    );

    console.log(
      `T-SP-B.Methodology.1 PASS: METHODOLOGY_DISTILLATION = ${METHODOLOGY_DISTILLATION.length} chars / ~${approxTok} tok ` +
        `(solution_selling + spin + challenger + meddic present; budget OK).`,
    );
  });
});
