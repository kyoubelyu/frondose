/**
 * P-POST Step 2 — T-Post.Prompt.1–3
 *
 * System-prompt strings: Soul outbound chain + Checkpoint post-flow nudge +
 * Manual mode fragment post mention.
 *
 * Gate: G-POST.Prompt
 *
 * All assertion bodies are TODO (assert.fail); all tests intentionally fail until
 * Step 4 (builder) edits soul.ts:92 and checkpoint.ts.
 *
 * Mirrors the pattern from tests/agent/systemPrompt/soul.test.ts:
 *   - import composeSoulBand, soulModeFragment from soul.ts
 *   - import CHECKPOINT from checkpoint.ts
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/systemPrompt/postFlow.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKPOINT } from "../../../src/agent/systemPrompt/checkpoint.js";
import { composeSoulBand, soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

// ─── Group F — system-prompt strings present (gate G-POST.Prompt) ─────────────

describe("T-Post.Prompt.1 (G-POST.Prompt): Soul outbound chain mentions 'post'", () => {
  it(
    "given composeSoulBand(null) is called, when the band string is searched for the outbound-chain habit, then it contains the literal substring '(connect note, DM, post, comment, follow-up)'",
    () => {
      // Given: composeSoulBand called with null identity (default, bootstrap-not-yet-run placeholder).
      // When:  the resulting soul band string is searched.
      // Then:  contains the literal substring "(connect note, DM, post, comment, follow-up)"
      //        as part of the "Your habit: for outbound (…)" line at soul.ts:92.
      //        Pre-Step-4: soul.ts:92 reads "(connect note, DM, comment, follow-up)"
      //        (NO "post"). This assertion FAILS until Step 4 adds "post" to the chain.
      const soul = composeSoulBand(null);

      // Pre-Step-4: the outbound chain is "(connect note, DM, comment, follow-up)"
      // This check FAILS pre-Step-4 (expected substring not found).
      assert.ok(
        soul.includes("(connect note, DM, post, comment, follow-up)"),
        `T-Post.Prompt.1: Soul band must contain the literal substring "(connect note, DM, post, comment, follow-up)". ` +
          `Got band (truncated): ${soul.slice(0, 300)}…`,
      );
    },
  );
});

describe("T-Post.Prompt.2 (G-POST.Prompt): Checkpoint contains the post-flow nudge", () => {
  it(
    "given the CHECKPOINT constant, when the string is searched, then it contains the literal substring '**Post (feed)**:'",
    () => {
      // Given: the CHECKPOINT constant from checkpoint.ts.
      // When:  the string is searched for the post-flow nudge.
      // Then:  contains the literal substring "**Post (feed)**:" (markdown bold label for the nudge).
      //        Pre-Step-4: checkpoint.ts does NOT have this nudge. This assertion FAILS
      //        until Step 4 adds the post-compose flow paragraph after the DM/message send line.
      assert.ok(
        CHECKPOINT.includes("**Post (feed)**:"),
        `T-Post.Prompt.2: CHECKPOINT must contain the literal substring "**Post (feed)**:". ` +
          `Got CHECKPOINT (truncated): ${CHECKPOINT.slice(0, 400)}…`,
      );
    },
  );
});

describe("T-Post.Prompt.3 (G-POST.Prompt): Manual mode prompt still mentions 'post' (regression guard)", () => {
  it(
    "given soulModeFragment('manual') is called, when the string is searched, then it contains the literal substring 'DM, connection request with note, post, comment' (pre-existing text at soul.ts:175)",
    () => {
      // Given: soulModeFragment("manual") returns the Manual mode fragment string.
      // When:  the string is searched.
      // Then:  contains the literal substring "DM, connection request with note, post, comment"
      //        — pre-existing line at soul.ts:175 (operator-frozen direction relies on this).
      //        Regression guard: P-POST must NOT accidentally break the manual fragment.
      //        This assertion PASSES pre-Step-4 (the string already exists at soul.ts:175).
      //        It remains in the scaffold to explicitly verify no regression post-Step-4.
      const manualFragment = soulModeFragment("manual");

      // Pre-Step-4: this assertion PASSES (soul.ts:175 already has the string).
      // Post-Step-4: must continue to pass (no regression from soul.ts:92 edit).
      assert.ok(
        manualFragment.includes("DM, connection request with note, post, comment"),
        `T-Post.Prompt.3: Manual mode fragment must contain "DM, connection request with note, post, comment". ` +
          `Got fragment (truncated): ${manualFragment.slice(0, 300)}…`,
      );
      // Step 5 confirmation: T-Post.Prompt.1 (soul outbound chain) and T-Post.Prompt.2
      // (checkpoint nudge) both pass. This regression guard passes as well.
      // All three G-POST.Prompt assertions are now verified together.
    },
  );
});
