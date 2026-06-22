/**
 * P-SP-E Step 5 — T-E.Soul.1..3 + T-E.Checkpoint.1..2 (G-PSPE.13..14) — assertions filled.
 * soulModeFragment("auto") expansion + CHECKPOINT 4-stop-condition reminder.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemPrompt/sp-e-auto-habits.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Direct imports — these modules EXIST pre-builder (only their content changes)
let soulModeFragment: ((mode: "manual" | "magical" | "auto") => string) | undefined;
let CHECKPOINT: string | undefined;

// Load via dynamic import at top-level (ESM module; top-level await supported).
const soulMod = await import("../../../src/agent/systemPrompt/soul.js").catch(() => null);
soulModeFragment = soulMod?.soulModeFragment;

const checkpointMod = await import("../../../src/agent/systemPrompt/checkpoint.js").catch(() => null);
CHECKPOINT = checkpointMod?.CHECKPOINT;

describe("T-E.Soul — soulModeFragment('auto') expansion (P-SP-E Sketch G)", () => {
  // ─── T-E.Soul.1 ──────────────────────────────────────────────────────────────
  it("T-E.Soul.1: soulModeFragment('auto') contains all required tool names: start_auto_run, list_due_followups, get_auto_run_state, record_auto_action, end_auto_run", () => {
    // Given: soulModeFragment imported from soul.ts (builder has pasted Sketch G)
    // When:  soulModeFragment("auto") called
    // Then:  returned string contains each of the 5 required tool names as substrings
    assert.ok(soulModeFragment !== undefined, "T-E.Soul.1: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      typeof fragment === "string" && fragment.length > 0,
      "T-E.Soul.1: soulModeFragment('auto') must return a non-empty string",
    );
    assert.ok(
      fragment.includes("start_auto_run"),
      `T-E.Soul.1: must contain 'start_auto_run'; fragment starts: ${fragment.slice(0, 100)}`,
    );
    assert.ok(fragment.includes("list_due_followups"), "T-E.Soul.1: must contain 'list_due_followups'");
    assert.ok(fragment.includes("get_auto_run_state"), "T-E.Soul.1: must contain 'get_auto_run_state'");
    assert.ok(fragment.includes("record_auto_action"), "T-E.Soul.1: must contain 'record_auto_action'");
    assert.ok(fragment.includes("end_auto_run"), "T-E.Soul.1: must contain 'end_auto_run'");
  });

  // ─── T-E.Soul.2 ──────────────────────────────────────────────────────────────
  it("T-E.Soul.2: soulModeFragment('auto') mentions all 4 stop conditions (cap / no-more-leads / blocked / user-stop)", () => {
    // Given: soulModeFragment("auto") returned string (Sketch G expanded ~700 chars)
    // When:  string searched for 4 stop-condition patterns
    // Then:  /cap/i matches (cap condition);
    //        /no.*(leads|actionable|next)/i matches (no-more-leads condition);
    //        /blocked|abnormal/i matches (abnormal page condition);
    //        /user.*(stop|cancel)|cancel/i matches (user stop condition)
    //
    // NOTE: The 4th pattern (/user.*(stop|cancel)|cancel/i) is the spec requirement.
    // The current implementation uses "no clear next action" as condition (4) rather
    // than an explicit user-stop mention. This test will FAIL on the 4th assertion
    // — recorded as DEFECT D-SP-E-Soul.2 (missing user-stop mention in auto soul).
    assert.ok(soulModeFragment !== undefined, "T-E.Soul.2: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(/cap/i.test(fragment), "T-E.Soul.2: /cap/i must match (cap condition present)");
    assert.ok(
      /no.*(leads|actionable|next)/i.test(fragment),
      "T-E.Soul.2: /no.*(leads|actionable|next)/i must match (no-more-leads condition)",
    );
    assert.ok(
      /blocked|abnormal/i.test(fragment),
      "T-E.Soul.2: /blocked|abnormal/i must match (abnormal page condition)",
    );
    // 4th pattern: user-stop condition — EXPECTED TO FAIL if implementation uses "no clear next action"
    assert.ok(
      /user.*(stop|cancel)|cancel/i.test(fragment),
      "T-E.Soul.2: /user.*(stop|cancel)|cancel/i must match (user stop condition) [DEFECT D-SP-E-Soul.2: builder implemented 'no clear next action' as 4th condition instead of user-stop]",
    );
  });

  // ─── T-E.Soul.3 ──────────────────────────────────────────────────────────────
  it("T-E.Soul.3: soulModeFragment('manual') UNCHANGED — still contains 'save_message_draft' directive (regression vs P-SP-D edits)", () => {
    // Given: soulModeFragment("manual") (P-SP-D added save_message_draft to manual mode)
    // When:  string inspected for regression
    // Then:  soulModeFragment("manual") contains 'save_message_draft' substring;
    //        P-SP-E Sketch G MUST NOT touch the manual branch
    assert.ok(soulModeFragment !== undefined, "T-E.Soul.3: soulModeFragment must be importable");
    const fragment = soulModeFragment!("manual");
    assert.ok(
      typeof fragment === "string" && fragment.length > 0,
      "T-E.Soul.3: soulModeFragment('manual') must return a non-empty string",
    );
    assert.ok(
      fragment.includes("save_message_draft"),
      "T-E.Soul.3: manual fragment must still contain 'save_message_draft' (P-SP-D regression check)",
    );
  });
});

describe("T-E.Checkpoint — CHECKPOINT 4-stop-condition reminder (P-SP-E Sketch H)", () => {
  // ─── T-E.Checkpoint.1 ────────────────────────────────────────────────────────
  it("T-E.Checkpoint.1: CHECKPOINT contains the 4-stop-condition reminder sentence (regex /Auto.*4.*(stop|exit)/i)", () => {
    // Given: CHECKPOINT exported from checkpoint.ts (builder pasted Sketch H)
    // When:  CHECKPOINT string searched
    // Then:  /Auto.*4.*(stop|exit)/i matches somewhere in CHECKPOINT
    //   The expected text is: "**Auto 4-stop**: `end_auto_run` on cap, no leads, blocked page, or no next action."
    assert.ok(CHECKPOINT !== undefined, "T-E.Checkpoint.1: CHECKPOINT must be importable from checkpoint.ts");
    assert.ok(
      typeof CHECKPOINT === "string" && CHECKPOINT.length > 0,
      "T-E.Checkpoint.1: CHECKPOINT must be a non-empty string",
    );
    assert.ok(
      /Auto.*4.*(stop|exit)/i.test(CHECKPOINT!),
      `T-E.Checkpoint.1: CHECKPOINT must match /Auto.*4.*(stop|exit)/i; got first 200 chars: ${CHECKPOINT!.slice(0, 200)}`,
    );
  });

  // ─── T-E.Checkpoint.2 ────────────────────────────────────────────────────────
  it("T-E.Checkpoint.2 (NIT-2): CHECKPOINT.length <= 5400 (P-POST raised cap for **Post (feed)** compose nudge)", () => {
    // Given: CHECKPOINT after Sketch H addition (~85 chars added → estimated ~4344);
    //        Phase 9 2026-06-08 added the No-note autonomous fallback directive
    //        (~620 chars) — a load-bearing safety contract that earned a cap raise.
    //        P-POST raised 5100→5400 to fit the **Post (feed)** compose nudge (~5279 post-edit).
    // When:  CHECKPOINT.length measured
    // Then:  CHECKPOINT.length <= 5400 (cap raised from 5100 to 5400 in P-POST);
    //        no lower-bound assertion (round-0 ≥4310 was brittle per NIT-2)
    // P-POST raised 5100→5400 to fit the **Post (feed)** compose nudge.
    assert.ok(CHECKPOINT !== undefined, "T-E.Checkpoint.2: CHECKPOINT must be importable");
    const len = CHECKPOINT!.length;
    assert.ok(len <= 5400, `T-E.Checkpoint.2: CHECKPOINT.length must be <= 5400; got ${len}`);
  });
});
