/**
 * P-SP-C scaffold — T-SP-C.SuggestCard.1..3 (F-10)
 * suggest_card Zod schema extension: totalScore + evidenceSummary optional fields;
 * backward compatibility; range validation.
 *
 * Step 4a: assertion bodies are TODO stubs — ALL FAIL pre-builder.
 * Step 5:  builder inserts totalScore + evidenceSummary in suggestCard.ts (F-6 §5.6)
 *          → assertions filled.
 *
 * Uses static import since suggestCardTool already exists. The new fields
 * don't exist in the schema pre-builder, so the TODO assertions fire correctly.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/control/suggestCardSchema.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestCardTool } from "../../../src/tools/control/suggestCard.js";

/** Minimal valid pre-P-SP-C suggest_card input. */
const BASE_VALID_INPUT = {
  title: "Alice — scaling outbound",
  icpMatch: {
    qualified: true,
    matched: ["VP Sales", "hiring"],
    missing: [],
  },
  painChainHypothesis: "VP Sales at Acme, hiring 5 SDRs — scaling outbound",
  painChainStage: "precall" as const,
  suggestedMove: {
    kind: "connect" as const,
    text: "Would love to learn how you're building the SDR team at Acme",
  },
};

describe("T-SP-C.SuggestCard — suggest_card schema extension (P-SP-C)", () => {
  // ─── T-SP-C.SuggestCard.1 ────────────────────────────────────────────────────
  it("T-SP-C.SuggestCard.1: schema accepts new fields totalScore + evidenceSummary alongside existing required fields", () => {
    // Given: a valid suggest_card input including:
    //   totalScore: 72, evidenceSummary: "VP Sales at Acme, hiring 5 SDRs"
    //   (plus existing required-shape fields)
    // When:  parsed via suggestCardTool.parameters.safeParse(...)
    // Then:  parse succeeds; result.totalScore === 72;
    //        result.evidenceSummary === "VP Sales at Acme, hiring 5 SDRs"
    //   Covers G-SP-C.8 (schema acceptance of new fields)
    const input = {
      ...BASE_VALID_INPUT,
      totalScore: 72,
      evidenceSummary: "VP Sales at Acme, hiring 5 SDRs",
    };
    const result = suggestCardTool.parameters.safeParse(input);
    assert.ok(result.success, `Schema must accept new fields. Error: ${JSON.stringify((result as any).error?.issues)}`);
    assert.equal((result as any).data.totalScore, 72, "totalScore must be 72");
    assert.equal(
      (result as any).data.evidenceSummary,
      "VP Sales at Acme, hiring 5 SDRs",
      "evidenceSummary must be preserved",
    );
  });

  // ─── T-SP-C.SuggestCard.2 ────────────────────────────────────────────────────
  it("T-SP-C.SuggestCard.2: backward compatibility — schema accepts inputs that omit totalScore + evidenceSummary; both default to undefined", () => {
    // Given: a pre-P-SP-C-shape input (no totalScore, no evidenceSummary)
    //   e.g. BASE_VALID_INPUT (which doesn't include the new fields)
    // When:  parsed via suggestCardTool.parameters.safeParse(...)
    // Then:  parse succeeds; result.totalScore === undefined;
    //        result.evidenceSummary === undefined
    //   Covers G-SP-C.8 (backward compatibility — existing callers unaffected)
    const result = suggestCardTool.parameters.safeParse(BASE_VALID_INPUT);
    assert.ok(
      result.success,
      `Schema must accept inputs without new fields (backward compat). Error: ${JSON.stringify((result as any).error?.issues)}`,
    );
    assert.equal((result as any).data.totalScore, undefined, "totalScore must be undefined when omitted");
    assert.equal((result as any).data.evidenceSummary, undefined, "evidenceSummary must be undefined when omitted");
  });

  // ─── T-SP-C.SuggestCard.3 ────────────────────────────────────────────────────
  it("T-SP-C.SuggestCard.3: range validation — totalScore rejects >100, <0, decimals; evidenceSummary rejects >280 chars", () => {
    // Given: inputs with out-of-range values:
    //   {totalScore: 150} — exceeds max 100
    //   {totalScore: -1} — below min 0
    //   {totalScore: 50.5} — decimal (not int)
    //   {evidenceSummary: "x".repeat(300)} — exceeds max 280 chars
    // When:  each parsed via suggestCardTool.parameters.safeParse(...)
    // Then:  each returns success:false with a clear Zod error message
    //   Covers G-SP-C.8 (range validation; z.number().int().min(0).max(100)
    //   + z.string().max(280))
    const over100 = suggestCardTool.parameters.safeParse({ ...BASE_VALID_INPUT, totalScore: 150 });
    assert.ok(!over100.success, "totalScore: 150 must be rejected (max 100)");

    const belowZero = suggestCardTool.parameters.safeParse({ ...BASE_VALID_INPUT, totalScore: -1 });
    assert.ok(!belowZero.success, "totalScore: -1 must be rejected (min 0)");

    const decimal = suggestCardTool.parameters.safeParse({ ...BASE_VALID_INPUT, totalScore: 50.5 });
    assert.ok(!decimal.success, "totalScore: 50.5 must be rejected (int required)");

    const longEvidence = suggestCardTool.parameters.safeParse({
      ...BASE_VALID_INPUT,
      evidenceSummary: "x".repeat(300),
    });
    assert.ok(!longEvidence.success, "evidenceSummary with 300 chars must be rejected (max 280)");

    // Edge: valid boundaries accepted
    const atMax = suggestCardTool.parameters.safeParse({ ...BASE_VALID_INPUT, totalScore: 100 });
    assert.ok(atMax.success, "totalScore: 100 must be accepted (at max boundary)");
    const atMin = suggestCardTool.parameters.safeParse({ ...BASE_VALID_INPUT, totalScore: 0 });
    assert.ok(atMin.success, "totalScore: 0 must be accepted (at min boundary)");
    const atEvMax = suggestCardTool.parameters.safeParse({
      ...BASE_VALID_INPUT,
      evidenceSummary: "x".repeat(280),
    });
    assert.ok(atEvMax.success, "evidenceSummary with exactly 280 chars must be accepted");
  });
});

// Suppress unused-variable warning for the helper used at Step 5.
void BASE_VALID_INPUT;
