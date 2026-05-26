/**
 * P-59 D-G6 Layer-2 round-4 — T-G6.6: Issue A CHECKPOINT clause scaffold
 *
 * Verifies that the new "After a Connect/Invite click" CHECKPOINT directive
 * (locked in plan §R4-3) is present in BOTH `CHECKPOINT` and `CHECKPOINT_RESUME`.
 *
 * Why CHECKPOINT_RESUME matters: `CHECKPOINT_RESUME = CHECKPOINT.replace(CHECKPOINT_TASK_START, …)`.
 * If the builder accidentally places the clause INSIDE `CHECKPOINT_TASK_START`, the
 * `.replace()` strips it from resume turns. The T-G6.6b assertion catches this mistake.
 *
 * Gate coverage:
 *   T-G6.6 → G-P59.1 (Issue A — llm_planning_failure fix: the round-3 agent called
 *             inspect(scope:"page") after click(@e33) because no CHECKPOINT directive
 *             named the overlay scope; this clause fixes that at the prompt tier)
 *
 * FAILS pre-builder: "After a Connect/Invite click:" is NOT yet in checkpoint.ts (L57).
 * PASSES post-builder: Codex Step 4b pastes §R4-3 locked clause verbatim into CHECKPOINT
 *   between the "Execute, don't just narrate:" paragraph and "Outbound check (P-Y1)."
 *
 * §11 failure class if live still fails after this: `llm_planning_failure` (round 5
 * escalates to tool-layer auto-rewrite per §R4-6).
 *
 * No Chrome, no LLM, no filesystem I/O — pure import assertion.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHECKPOINT, CHECKPOINT_RESUME } from "../../../src/agent/systemPrompt/checkpoint.js";

// ─── T-G6.6 ──────────────────────────────────────────────────────────────────

describe("T-G6.6 (P-59 round-4 Issue A): CHECKPOINT + CHECKPOINT_RESUME both contain the 'After a Connect/Invite click' inspect-overlay directive", () => {
  it("T-G6.6a: CHECKPOINT contains all 4 §R4-3 clause substrings — clause head, 'connect', correct-call form, negative-case", () => {
    // Given: CHECKPOINT imported from src/agent/systemPrompt/checkpoint.ts;
    //        builder Step 4b has inserted the §R4-3 clause OUTSIDE CHECKPOINT_TASK_START,
    //        between the "Execute, don't just narrate:" and "Outbound check (P-Y1)." paragraphs
    // When:  CHECKPOINT is inspected for each of the 4 required substrings per §R4-4
    // Then:  ALL 4 substrings are present:
    //        (1) "After a Connect/Invite click:" (exact clause head — locks placement + naming per C2/C3)
    //        (2) "connect" case-insensitive (C3 literal-word requirement)
    //        (3) 'inspect(scope:"overlay")' (the prescribed correct call)
    //        (4) 'scope:"page"' (the named negative case — what NOT to call)

    // (1) Exact clause head
    assert.ok(
      CHECKPOINT.includes("After a Connect/Invite click:"),
      `T-G6.6a-1: CHECKPOINT must contain "After a Connect/Invite click:" — FAILS pre-builder; CHECKPOINT.length=${CHECKPOINT.length}`,
    );

    // (2) "connect" case-insensitive (C3 explicit literal-word satisfaction)
    assert.ok(
      CHECKPOINT.toLowerCase().includes("connect"),
      `T-G6.6a-2: CHECKPOINT must contain "connect" (case-insensitive, C3 requirement); CHECKPOINT.length=${CHECKPOINT.length}`,
    );

    // (3) Exact correct call form
    assert.ok(
      CHECKPOINT.includes('inspect(scope:"overlay")'),
      `T-G6.6a-3: CHECKPOINT must contain 'inspect(scope:"overlay")' — the prescribed correct call; CHECKPOINT.length=${CHECKPOINT.length}`,
    );

    // (4) Named negative case
    assert.ok(
      CHECKPOINT.includes('scope:"page"'),
      `T-G6.6a-4: CHECKPOINT must contain 'scope:"page"' — the named wrong call (round-3 failure mode); CHECKPOINT.length=${CHECKPOINT.length}`,
    );
  });

  it("T-G6.6b: CHECKPOINT_RESUME also contains all 4 clause substrings — proves clause is in the SHARED CHECKPOINT body, NOT inside CHECKPOINT_TASK_START (which the v2-rev .replace() strips for resume turns)", () => {
    // Given: CHECKPOINT_RESUME = CHECKPOINT.replace(CHECKPOINT_TASK_START, CHECKPOINT_TASK_START_RESUME)
    //        (L61 of checkpoint.ts); the .replace() strips CHECKPOINT_TASK_START from resume turns
    // When:  CHECKPOINT_RESUME is inspected for the same 4 §R4-3 substrings
    // Then:  ALL 4 are present — the clause sits OUTSIDE CHECKPOINT_TASK_START as §R4-3 requires;
    //        if builder places it inside CHECKPOINT_TASK_START by mistake, this assertion catches it

    // (1) Clause head survives resume .replace()
    assert.ok(
      CHECKPOINT_RESUME.includes("After a Connect/Invite click:"),
      `T-G6.6b-1: CHECKPOINT_RESUME must contain "After a Connect/Invite click:" — FAILS pre-builder; proves clause not accidentally inside CHECKPOINT_TASK_START`,
    );

    // (2) "connect" survives
    assert.ok(
      CHECKPOINT_RESUME.toLowerCase().includes("connect"),
      `T-G6.6b-2: CHECKPOINT_RESUME must contain "connect" (case-insensitive)`,
    );

    // (3) Correct call form survives
    assert.ok(
      CHECKPOINT_RESUME.includes('inspect(scope:"overlay")'),
      `T-G6.6b-3: CHECKPOINT_RESUME must contain 'inspect(scope:"overlay")'`,
    );

    // (4) Negative case survives
    assert.ok(CHECKPOINT_RESUME.includes('scope:"page"'), `T-G6.6b-4: CHECKPOINT_RESUME must contain 'scope:"page"'`);
  });
});
