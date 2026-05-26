/**
 * P-SP-B Step 4a scaffold — T-SP-B.Methodology.1: distill.ts methodology-repertoire block.
 *
 * Assertion body is a TODO stub that intentionally fails pre-builder (Step 4a).
 * Pre-builder failure: METHODOLOGY_DISTILLATION (which exists now) does NOT yet contain
 * "SPIN", "Challenger", or "MEDDIC" — those 3 strings are added by the P-SP-B §6.4(F)
 * slim-then-add edit. The budget guard (≤800 tok) re-uses the existing T-M_p5.1 invariant.
 *
 * Gates covered: §4 T-SP-B.Methodology.1 (4 methodology name substrings + ≤800 tok budget).
 *
 * Note: METHODOLOGY_DISTILLATION is already exported from src/methodology/distill.js
 * (file exists pre-builder), so the static import SUCCEEDS at Step 4a. The scaffold
 * fails because the assertion immediately calls assert.ok(false, "TODO …").
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
    // Given: src/methodology/distill.ts METHODOLOGY_DISTILLATION after P-SP-B §6.4(F) slim-then-add edit
    //        (remove qualify_profile habit anchor −81 tok; add methodology repertoire block +68 tok; net 776 tok)
    // When:  the exported METHODOLOGY_DISTILLATION string is inspected
    // Then:  includes "Solution Selling" (case-sensitive) AND "SPIN" AND "Challenger" AND "MEDDIC";
    //        Math.ceil(METHODOLOGY_DISTILLATION.length / 4) <= 800 (≤800-tok budget guard,
    //        mirroring T-M_p5.1 in tests/methodology/soul-band.mock.test.ts)
    //
    // Pre-builder state: "SPIN", "Challenger", "MEDDIC" are NOT present in the current
    // METHODOLOGY_DISTILLATION → this assertion fails pre-builder.
    assert.ok(
      false,
      [
        "T-SP-B.Methodology.1 TODO: fill at Step 5 — FAILS pre-builder:",
        "'SPIN', 'Challenger', 'MEDDIC' not yet in METHODOLOGY_DISTILLATION.",
        `Current string length: ${METHODOLOGY_DISTILLATION.length} chars / ~${Math.ceil(METHODOLOGY_DISTILLATION.length / 4)} tok.`,
        "After P-SP-B §6.4(F): assert 4 methodology names present + budget ≤800 tok.",
      ].join(" "),
    );
  });
});
