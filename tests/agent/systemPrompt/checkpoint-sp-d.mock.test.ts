/**
 * P-SP-D Step 5 — T-SP-D.Checkpoint.1, T-SP-D.Checkpoint.2, T-SP-D.Checkpoint.3 (assertions filled)
 *
 * Checkpoint band text assertions for the P-SP-D Manual Conversation Sales Workflow
 * prompt-engineering changes:
 *   F-3.1 — Outbound-check block extended with draft-before-in_progress invariant
 *            (Sketch B: "Before marking an outbound step in_progress, call `save_message_draft`
 *             first so the operator sees the draft at approval.")
 *   F-3.2 — New DM-send-verify directive added adjacent to existing L59 Connect-verify
 *            (Sketch B: "After a DM/message send: `inspect(scope:"page")` to confirm
 *             it appears in the thread.")
 *
 * Gates covered:
 *   G-PSPD.3 (T-SP-D.Checkpoint.1) — Checkpoint Outbound-check contains draft-before-in_progress
 *   G-PSPD.4 (T-SP-D.Checkpoint.2) — Checkpoint has DM-send-verify; Connect-verify L59 preserved
 *   G-PSPD.5 (T-SP-D.Checkpoint.3) — CHECKPOINT_RESUME derivation preserved after P-SP-D edits
 *
 * Run (mock only, no Chrome, no LLM, no DB):
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/systemPrompt/checkpoint-sp-d.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHECKPOINT,
  CHECKPOINT_RESUME,
  CHECKPOINT_TASK_START,
  CHECKPOINT_TASK_START_RESUME,
} from "../../../src/agent/systemPrompt/checkpoint.js";

describe("T-SP-D.Checkpoint — draft-before-outbound invariant + DM-send-verify (P-SP-D §4.2)", () => {
  // ─── T-SP-D.Checkpoint.1 ─────────────────────────────────────────────────────

  it("T-SP-D.Checkpoint.1: when CHECKPOINT is rendered after P-SP-D Sketch B F-3.1 paste, the Outbound-check block contains the draft-before-in_progress invariant ('save_message_draft' before 'in_progress')", () => {
    // Given: src/agent/systemPrompt/checkpoint.ts after P-SP-D Sketch B F-3.1 edit —
    //        the Outbound-check clause (formerly ending "...pause and reconsider — sending
    //        without operator awareness breaks trust.") is replaced with a version that
    //        adds "Before marking an outbound step in_progress, call `save_message_draft`
    //        first so the operator sees the draft at approval."
    // When:  CHECKPOINT constant is imported and inspected
    // Then:  CHECKPOINT contains "save_message_draft" in the Outbound-check clause context
    //        AND contains the verbatim Sketch B bold directive
    //        AND CHECKPOINT.length ≤ 4400 (soft cap; builder measured: 4394 chars)

    assert.ok(
      CHECKPOINT.includes("save_message_draft"),
      `CHECKPOINT must include save_message_draft in the Outbound-check block (F-3.1, G-PSPD.3). Length=${CHECKPOINT.length}`,
    );

    // Verbatim Sketch B directive (F-3.1)
    assert.ok(
      CHECKPOINT.includes("Before marking an outbound step in_progress, call `save_message_draft` first"),
      "CHECKPOINT must contain the verbatim Sketch B draft-before-gate directive (F-3.1, G-PSPD.3)",
    );

    // Soft cap invariant (Phase 9 2026-06-08: raised from 4400 → 5100 to fit the
    // no-note autonomous fallback directive — a load-bearing safety contract).
    // P-POST raised 5100→5400 to fit the **Post (feed)** compose nudge.
    assert.ok(
      CHECKPOINT.length <= 5400,
      `CHECKPOINT.length must be ≤ 5400 chars (got ${CHECKPOINT.length}) — P-POST cap, raised from 5100 (G-PSPD.3)`,
    );
  });

  // ─── T-SP-D.Checkpoint.2 ─────────────────────────────────────────────────────

  it("T-SP-D.Checkpoint.2: when CHECKPOINT is rendered after P-SP-D Sketch B F-3.2 paste, it contains the DM-send-verify directive; AND the pre-existing Connect/Invite L59 verify directive is preserved", () => {
    // Given: src/agent/systemPrompt/checkpoint.ts after P-SP-D Sketch B F-3.2 edit —
    //        a new single-line directive is added after the existing L59 Connect/Invite clause:
    //        "After a DM/message send: `inspect(scope:"page")` to confirm it appears in the thread."
    // When:  CHECKPOINT constant is imported and inspected
    // Then:  CHECKPOINT contains the DM-verify phrase
    //        AND the pre-existing L59 Connect-verify phrase is preserved

    // New DM-verify directive (F-3.2) — verbatim Sketch B wording
    assert.ok(
      CHECKPOINT.includes("After a DM/message send:"),
      "CHECKPOINT must include the DM-send-verify directive (F-3.2, G-PSPD.4)",
    );
    assert.ok(
      CHECKPOINT.includes('inspect(scope:"page")'),
      'CHECKPOINT DM-verify must reference inspect(scope:"page") (F-3.2, G-PSPD.4)',
    );

    // Pre-existing Connect/Invite verify directive must be preserved (was L59 before edit)
    assert.ok(
      CHECKPOINT.includes("After a Connect/Invite click:"),
      "CHECKPOINT must preserve the pre-existing Connect/Invite click verify directive (G-PSPD.4 regression guard)",
    );
    assert.ok(
      CHECKPOINT.includes('inspect(scope:"overlay")'),
      'CHECKPOINT must preserve inspect(scope:"overlay") from the Connect/Invite clause (G-PSPD.4 regression guard)',
    );
  });

  // ─── T-SP-D.Checkpoint.3 ─────────────────────────────────────────────────────

  it("T-SP-D.Checkpoint.3: when CHECKPOINT_RESUME is derived after P-SP-D Sketch B edits, the .replace(CHECKPOINT_TASK_START, CHECKPOINT_TASK_START_RESUME) substitution is preserved AND the new P-SP-D directives appear in BOTH CHECKPOINT and CHECKPOINT_RESUME", () => {
    // Given: src/agent/systemPrompt/checkpoint.ts after P-SP-D Sketch B F-3.1 + F-3.2 edits;
    //        CHECKPOINT_RESUME is derived via CHECKPOINT.replace(CHECKPOINT_TASK_START, CHECKPOINT_TASK_START_RESUME)
    //        at file:63 (the `.replace(...)` mechanism is pre-existing — P-SP-D must not break it)
    // When:  CHECKPOINT_RESUME constant is imported and compared to CHECKPOINT
    // Then:  CHECKPOINT_RESUME has CHECKPOINT_TASK_START_RESUME, not CHECKPOINT_TASK_START;
    //        both CHECKPOINT and CHECKPOINT_RESUME contain the P-SP-D directives
    //        (they live outside the TASK_START block, so .replace() preserves them in RESUME)

    // The substitution must have occurred: TASK_START text gone, TASK_START_RESUME present
    assert.ok(
      CHECKPOINT_RESUME.includes(CHECKPOINT_TASK_START_RESUME),
      "CHECKPOINT_RESUME must contain CHECKPOINT_TASK_START_RESUME text (substitution applied, G-PSPD.5)",
    );
    assert.ok(
      !CHECKPOINT_RESUME.includes(CHECKPOINT_TASK_START),
      "CHECKPOINT_RESUME must NOT contain the original CHECKPOINT_TASK_START text (replaced by RESUME variant, G-PSPD.5)",
    );

    // F-3.1 directive must appear in BOTH (lives outside TASK_START block)
    assert.ok(
      CHECKPOINT_RESUME.includes("save_message_draft"),
      "CHECKPOINT_RESUME must contain save_message_draft (F-3.1 preserved outside TASK_START block, G-PSPD.5)",
    );
    assert.ok(
      CHECKPOINT.includes("save_message_draft"),
      "CHECKPOINT must also contain save_message_draft (F-3.1 sanity check, G-PSPD.5)",
    );

    // F-3.2 directive must appear in BOTH (lives outside TASK_START block)
    assert.ok(
      CHECKPOINT_RESUME.includes("After a DM/message send:"),
      "CHECKPOINT_RESUME must contain DM-verify directive (F-3.2 preserved outside TASK_START block, G-PSPD.5)",
    );
    assert.ok(
      CHECKPOINT.includes("After a DM/message send:"),
      "CHECKPOINT must also contain DM-verify directive (F-3.2 sanity check, G-PSPD.5)",
    );
  });
});
