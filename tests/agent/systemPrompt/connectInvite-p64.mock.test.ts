/**
 * P-64 Step 5 — T-P64.1..5 (G-P64.1 + G-P64.2) — assertions filled.
 * Verifies that checkpoint.ts contains the F1 "Connect invite (profile)" directive
 * teaching the preload-URL workflow (CDP-blocked connect link workaround).
 *
 * Gates covered:
 *   G-P64.1 — Checkpoint directive teaches preload URL + "Send without a note" button
 *   G-P64.2 — Checkpoint char cap respected + CHECKPOINT_RESUME inherits F1
 *
 * No Chrome, no LLM, no filesystem I/O — pure import assertion.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=15000 \
 *     tests/agent/systemPrompt/connectInvite-p64.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHECKPOINT, CHECKPOINT_RESUME } from "../../../src/agent/systemPrompt/checkpoint.js";

describe("T-P64 — P-64 checkpoint F1 directive: preload-URL connect-invite workflow (G-P64.1 + G-P64.2)", () => {
  // ─── T-P64.1 ─────────────────────────────────────────────────────────────────
  it("T-P64.1 (G-P64.1): CHECKPOINT contains 'preload/custom-invite/?vanityName=' substring — locks the preload URL pattern teaching", () => {
    // Given: CHECKPOINT exported from src/agent/systemPrompt/checkpoint.ts
    //        Builder Step 4b inserted F1 directive at L57→L59 boundary (Sketch A.4)
    // When:  CHECKPOINT string searched for the preload URL path-pattern substring
    // Then:  'preload/custom-invite/?vanityName=' is present
    //        (regardless of protocol prefix — T-P64.2 tests the full HTTPS URL)
    assert.ok(
      CHECKPOINT.includes("preload/custom-invite/?vanityName="),
      `T-P64.1: CHECKPOINT must contain 'preload/custom-invite/?vanityName='; length=${CHECKPOINT.length}\nFirst 200 chars: ${CHECKPOINT.slice(0, 200)}`,
    );
  });

  // ─── T-P64.2 ─────────────────────────────────────────────────────────────────
  it("T-P64.2 (G-P64.1): CHECKPOINT contains the FULL https:// URL 'https://www.linkedin.com/preload/custom-invite/?vanityName=' — navigate_to_url requires HTTPS-absolute URL", () => {
    // Given: CHECKPOINT imported from checkpoint.ts
    //        navigate_to_url (src/tools/browser/navigateToUrl.ts L17-18) rejects relative URLs
    //        F1 directive must use the full HTTPS-prefixed URL to be actionable
    // When:  CHECKPOINT searched for the full HTTPS URL prefix
    // Then:  'https://www.linkedin.com/preload/custom-invite/?vanityName=' is present
    assert.ok(
      CHECKPOINT.includes("https://www.linkedin.com/preload/custom-invite/?vanityName="),
      `T-P64.2: CHECKPOINT must contain full https URL 'https://www.linkedin.com/preload/custom-invite/?vanityName='; got length=${CHECKPOINT.length}`,
    );
  });

  // ─── T-P64.3 ─────────────────────────────────────────────────────────────────
  it("T-P64.3 (G-P64.1): CHECKPOINT contains 'Send without a note' — the canonical dialog-button label the agent must click", () => {
    // Given: CHECKPOINT imported from checkpoint.ts
    //        F1 directive ends with '→ inspect overlay → "Send without a note"'
    //        The agent must click this button (NOT "Add a note") per plan §9.2 criterion 4
    // When:  CHECKPOINT searched for the canonical button label
    // Then:  'Send without a note' substring is present (exact case per LinkedIn dialog label)
    assert.ok(
      CHECKPOINT.includes("Send without a note"),
      `T-P64.3: CHECKPOINT must contain 'Send without a note'; length=${CHECKPOINT.length}`,
    );
  });

  // ─── T-P64.4 ─────────────────────────────────────────────────────────────────
  it("T-P64.4 (G-P64.2): CHECKPOINT.length is within [4350, 4400] — post-edit estimate 4392 (4350-4400 band; upper cap load-bearing)", () => {
    // Given: CHECKPOINT imported from checkpoint.ts
    //        Pre-edit baseline: 4386 chars (post-P-SP-E cherry-pick; 2026-05-27)
    //        Net delta: TRIM A (−42) + TRIM B (−71) + TRIM C (−63) + INSERT F1 (+182) = +6
    //        Post-edit estimate: 4392 (architect-measured 2026-05-27 via live probe)
    //        Upper cap 4400: Boundary band design intent — keeps Checkpoint readable at every turn
    //        Lower bound 4350: loose-bracket regression catch (accidental content deletion)
    // When:  CHECKPOINT.length measured
    // Then:  4350 <= CHECKPOINT.length <= 4400
    const len = CHECKPOINT.length;
    assert.ok(len >= 4350, `T-P64.4: CHECKPOINT.length must be >= 4350 (lower regression bracket); got ${len}`);
    assert.ok(len <= 4400, `T-P64.4: CHECKPOINT.length must be <= 4400 (upper budget cap); got ${len}`);
  });

  // ─── T-P64.5 ─────────────────────────────────────────────────────────────────
  it("T-P64.5 (G-P64.2): CHECKPOINT_RESUME also contains 'preload/custom-invite/?vanityName=' — F1 directive sits OUTSIDE CHECKPOINT_TASK_START (not stripped by .replace() for resume turns)", () => {
    // Given: CHECKPOINT_RESUME = CHECKPOINT.replace(CHECKPOINT_TASK_START, CHECKPOINT_TASK_START_RESUME)
    //        The .replace() strips CHECKPOINT_TASK_START for resume turns
    //        F1 directive is inserted at L57→L59 boundary (OUTSIDE CHECKPOINT_TASK_START lines 19-20)
    //        So F1 must survive in CHECKPOINT_RESUME too (preload URL workflow applies on resume turns)
    // When:  CHECKPOINT_RESUME searched for the preload URL substring
    // Then:  'preload/custom-invite/?vanityName=' is present in CHECKPOINT_RESUME
    //        (mirror of T-G6.6b-1 invariant for the F1 directive)
    assert.ok(
      CHECKPOINT_RESUME.includes("preload/custom-invite/?vanityName="),
      `T-P64.5: CHECKPOINT_RESUME must contain 'preload/custom-invite/?vanityName=' — proves F1 sits outside CHECKPOINT_TASK_START; CHECKPOINT_RESUME.length=${CHECKPOINT_RESUME.length}`,
    );
  });
});
