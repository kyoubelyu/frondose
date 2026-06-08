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
  it("T-P64.4 (G-P64.2): CHECKPOINT.length is within [4900, 5100] — Phase 9 raised the cap from [4350, 4400] to fit the no-note fallback directive", () => {
    // Given: CHECKPOINT imported from checkpoint.ts.
    //        Phase-9 (2026-06-08) added the No-note autonomous fallback directive
    //        (operator pre-authorizes degradation when with-note Send fails) — this
    //        is a load-bearing safety contract that earned a cap raise. Post-edit:
    //        ~5014 chars. New band [4900, 5100] — same regression-bracket pattern
    //        as the pre-Phase-9 [4350, 4400] band, just centered around the new mass.
    // When:  CHECKPOINT.length measured
    // Then:  4900 <= CHECKPOINT.length <= 5100
    const len = CHECKPOINT.length;
    assert.ok(len >= 4900, `T-P64.4: CHECKPOINT.length must be >= 4900 (lower regression bracket); got ${len}`);
    assert.ok(len <= 5100, `T-P64.4: CHECKPOINT.length must be <= 5100 (upper budget cap, post-Phase-9 raise); got ${len}`);
  });

  // ─── T-P9.1 + T-P9.2: no-note autonomous fallback (Phase 9) ─────────────────
  it("T-P9.1 (Phase 9): CHECKPOINT contains 'No-note fallback' directive — agent autonomously sends without-a-note when with-note path fails", () => {
    // Given: operator's outbound approval is meant to cover BOTH the with-note send
    //        AND the no-note fallback (per operator directive 2026-06-08). The agent
    //        must not block the lead on humans-in-loop when quota/modal issues defeat
    //        the personalized path.
    // When:  CHECKPOINT searched for the fallback directive
    // Then:  the substring 'No-note fallback' is present
    assert.ok(
      CHECKPOINT.includes("No-note fallback"),
      `T-P9.1: CHECKPOINT must contain 'No-note fallback' directive — operator pre-authorizes the degradation path; CHECKPOINT.length=${CHECKPOINT.length}`,
    );
  });

  it("T-P9.2 (Phase 9): no-note fallback names the specific failure triggers (Send invitation not findable / quota / modal variant) and the recovery actions (mark_message_sent + update_lead_stage + telegram_notify)", () => {
    // Given: the fallback directive must be specific enough that an LLM can recognize
    //        the failure mode AND knows what to do post-recovery. Loose hand-waving like
    //        "try harder" would not unblock the actual hazards (quota, modal variant).
    // When:  CHECKPOINT inspected for the specific failure-recovery vocabulary
    // Then:  all three failure triggers + all three recovery actions are present
    const triggers = ["not findable", "quota", "unfamiliar variant"];
    const recoveries = ["mark_message_sent", "update_lead_stage", "telegram_notify"];
    for (const t of triggers) {
      assert.ok(
        CHECKPOINT.includes(t),
        `T-P9.2: CHECKPOINT must name failure trigger "${t}" — vague directives don't reliably activate the fallback`,
      );
    }
    for (const r of recoveries) {
      assert.ok(
        CHECKPOINT.includes(r),
        `T-P9.2: CHECKPOINT must name recovery action "${r}" — without it the agent could send the invite and forget to close the DB loop`,
      );
    }
  });

  it("T-P9.3 (Phase 9): no-note fallback explicitly forbids paraphrased / agent-rewritten text via raw type+click (preserves the brand-safety fence)", () => {
    // Given: the type-fidelity guard at src/tools/browser/type.ts is the load-bearing
    //        defense against the Linfeng-class rewrite hazard. The fallback directive
    //        could be misread as "anything goes once with-note fails" — explicitly
    //        forbid the paraphrase path in the same paragraph.
    // When:  CHECKPOINT inspected for the explicit forbid
    // Then:  the paraphrase-forbid clause is present
    assert.ok(
      CHECKPOINT.includes("paraphrased") || CHECKPOINT.includes("agent-rewritten"),
      `T-P9.3: CHECKPOINT must explicitly forbid paraphrased/agent-rewritten text in the fallback paragraph — without this the fallback could be misread as license to rewrite`,
    );
    assert.ok(
      CHECKPOINT.includes("text-fidelity guard"),
      `T-P9.3: CHECKPOINT must reference the text-fidelity guard as the load-bearing fence — connects the directive to the actual enforcement code`,
    );
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
