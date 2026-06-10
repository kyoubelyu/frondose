/**
 * P-Y1 Step 5 — T-Boundary.1 — FILLED
 * P-75.D6.1 Step 3a scaffold — T-D6.1.M3 + T-D6.1.M4 (Edit 1 JSON example in BOUNDARY + BOUNDARY_RESUME).
 * (G-PY1.9)
 *
 * System-prompt band changes: boundary.ts BOUNDARY Plan-first paragraph; checkpoint.ts Outbound check;
 * soul.ts soulModeFragment("manual"|"auto").
 *
 * T-D6.1.M3: asserts BOUNDARY contains the strict-JSON example anchors from Edit 1 (§3.1),
 *   placed inside the Plan-first paragraph (after Plan-first and before Draft-before-gate).
 *
 * T-D6.1.M4: asserts BOUNDARY_RESUME carries the same anchors through (they live OUTSIDE
 *   BOUNDARY_RITUAL_CLAUSE so the .replace() carries them unchanged), AND confirms the
 *   ritual clause swap happened (BOUNDARY_RITUAL_CLAUSE_RESUME present, BOUNDARY_RITUAL_CLAUSE
 *   absent in BOUNDARY_RESUME).
 *
 * Both T-D6.1.M3 and T-D6.1.M4 are INTENTIONALLY FAILING at HEAD until Edit 1 lands at Step 4.
 *
 * Outside-in TDD + BDD-light per CLAUDE.md § Test Discipline.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 tests/agent/systemPrompt/boundary-pY1.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOUNDARY,
  BOUNDARY_RESUME,
  BOUNDARY_RITUAL_CLAUSE,
  BOUNDARY_RITUAL_CLAUSE_RESUME,
} from "../../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../../src/agent/systemPrompt/checkpoint.js";
import { soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

// ─── T-Boundary.1 — Plan-first + Outbound-check + Soul mode fragments ────────

describe("system prompt — Boundary Plan-first + Checkpoint outbound-check + Soul mode fragments (G-PY1.9)", () => {
  // Given: BOUNDARY + CHECKPOINT + soulModeFragment.
  // When:  substring searches + placement check.
  // Then:  BOUNDARY has Plan-first (P-Y1) + todo_write + requiresApproval: true (between Web-automation
  //        + Replies); CHECKPOINT has Outbound check (P-Y1); soulModeFragment manual/auto fragments.
  it("T-Boundary.1: given BOUNDARY + CHECKPOINT + soulModeFragment, WHEN substring-searched, THEN BOUNDARY contains 'Plan-first discipline (P-Y1)' + 'todo_write' + 'requiresApproval: true' (between 'Web automation scope' and 'Replies and tool failures'); CHECKPOINT contains 'Outbound check (P-Y1)'; soulModeFragment('manual')⊇'MANUAL mode'; soulModeFragment('auto')⊇'AUTO mode'", () => {
    assert.ok(
      BOUNDARY.includes("Plan-first discipline (P-Y1)"),
      "BOUNDARY must contain 'Plan-first discipline (P-Y1)'",
    );
    assert.ok(BOUNDARY.includes("todo_write"), "BOUNDARY Plan-first must mention todo_write");
    assert.ok(BOUNDARY.includes("requiresApproval: true"), "BOUNDARY Plan-first must mention requiresApproval: true");

    // Placement: Plan-first between "Web automation scope" and "Replies and tool failures".
    const webIdx = BOUNDARY.indexOf("Web automation scope");
    const planIdx = BOUNDARY.indexOf("Plan-first discipline (P-Y1)");
    const repliesIdx = BOUNDARY.indexOf("Replies and tool failures");
    assert.ok(webIdx >= 0 && planIdx >= 0 && repliesIdx >= 0, "all 3 anchors present");
    assert.ok(webIdx < planIdx && planIdx < repliesIdx, "Plan-first inserted between Web-automation-scope and Replies");

    assert.ok(CHECKPOINT.includes("Outbound check (P-Y1)"), "CHECKPOINT must contain 'Outbound check (P-Y1)'");

    assert.ok(
      soulModeFragment("manual").includes("MANUAL mode"),
      "soulModeFragment('manual') must mention MANUAL mode",
    );
    assert.ok(soulModeFragment("auto").includes("AUTO mode"), "soulModeFragment('auto') must mention AUTO mode");
  });
});

// ─── T-D6.1.M3 — Edit 1 JSON example present in BOUNDARY (P-75.D6.1) ──────────

describe("T-D6.1.M3 — BOUNDARY contains Edit-1 strict-JSON arming example inside Plan-first paragraph (P-75.D6.1)", () => {
  // Given: BOUNDARY export from src/agent/systemPrompt/boundary.ts.
  // When:  the string is read at import time and substring-searched.
  // Then:  it contains all three anchors from §3.1, and the example is placed
  //        inside the Plan-first paragraph (after "Plan-first discipline (P-Y1)"
  //        and before "Draft-before-gate (P-59 D-P59-10)").
  it('T-D6.1.M3: BOUNDARY contains "The exact call shape to arm L2 approval is:" + "\\"workflowTitle\\": \\"Send connect note to <person>\\"" + "\\"requiresApproval\\": true, \\"state\\": \\"in_progress\\"" — all inside the Plan-first paragraph', () => {
    const anchor1 = "The exact call shape to arm L2 approval is:";
    const anchor2 = '"workflowTitle": "Send connect note to <person>"';
    const anchor3 = '"requiresApproval": true, "state": "in_progress"';

    assert.ok(BOUNDARY.includes(anchor1), `BOUNDARY must contain: ${anchor1}`);
    assert.ok(BOUNDARY.includes(anchor2), `BOUNDARY must contain: ${anchor2}`);
    assert.ok(BOUNDARY.includes(anchor3), `BOUNDARY must contain: ${anchor3}`);

    // Placement: the example must be inside the Plan-first paragraph —
    // after "Plan-first discipline (P-Y1)" and before "Draft-before-gate (P-59 D-P59-10)".
    const planFirstIdx = BOUNDARY.indexOf("Plan-first discipline (P-Y1)");
    const exampleIdx = BOUNDARY.indexOf(anchor1);
    const draftBeforeIdx = BOUNDARY.indexOf("Draft-before-gate (P-59 D-P59-10)");

    assert.ok(planFirstIdx >= 0, '"Plan-first discipline (P-Y1)" anchor must exist in BOUNDARY');
    assert.ok(draftBeforeIdx >= 0, '"Draft-before-gate (P-59 D-P59-10)" anchor must exist in BOUNDARY');
    assert.ok(exampleIdx > planFirstIdx, 'example must appear AFTER "Plan-first discipline (P-Y1)"');
    assert.ok(exampleIdx < draftBeforeIdx, 'example must appear BEFORE "Draft-before-gate (P-59 D-P59-10)"');
  });
});

// ─── T-D6.1.M4 — Edit 1 carries through to BOUNDARY_RESUME (P-75.D6.1) ────────

describe("T-D6.1.M4 — BOUNDARY_RESUME carries Edit-1 example through (resume-variant ruling, P-75.D6.1)", () => {
  // Given: BOUNDARY_RESUME export (= BOUNDARY.replace(BOUNDARY_RITUAL_CLAUSE, BOUNDARY_RITUAL_CLAUSE_RESUME)).
  // When:  the string is read at import time and substring-searched.
  // Then:  BOUNDARY_RESUME contains all three §3.1 example anchors (the JSON example lives
  //        OUTSIDE BOUNDARY_RITUAL_CLAUSE, so the .replace() does NOT remove it);
  //        AND BOUNDARY_RESUME.includes(BOUNDARY_RITUAL_CLAUSE_RESUME) === true (swap happened);
  //        AND BOUNDARY_RESUME.includes(BOUNDARY_RITUAL_CLAUSE) === false (original clause gone).
  it("T-D6.1.M4: BOUNDARY_RESUME contains the three Edit-1 anchors AND includes BOUNDARY_RITUAL_CLAUSE_RESUME AND does NOT include BOUNDARY_RITUAL_CLAUSE", () => {
    const anchor1 = "The exact call shape to arm L2 approval is:";
    const anchor2 = '"workflowTitle": "Send connect note to <person>"';
    const anchor3 = '"requiresApproval": true, "state": "in_progress"';

    // The example must survive the ritual-clause swap.
    assert.ok(BOUNDARY_RESUME.includes(anchor1), `BOUNDARY_RESUME must still contain: ${anchor1}`);
    assert.ok(BOUNDARY_RESUME.includes(anchor2), `BOUNDARY_RESUME must still contain: ${anchor2}`);
    assert.ok(BOUNDARY_RESUME.includes(anchor3), `BOUNDARY_RESUME must still contain: ${anchor3}`);

    // Confirm the ritual-clause swap happened correctly.
    assert.ok(
      BOUNDARY_RESUME.includes(BOUNDARY_RITUAL_CLAUSE_RESUME),
      "BOUNDARY_RESUME must include BOUNDARY_RITUAL_CLAUSE_RESUME (resume variant)",
    );
    assert.ok(
      !BOUNDARY_RESUME.includes(BOUNDARY_RITUAL_CLAUSE),
      "BOUNDARY_RESUME must NOT include BOUNDARY_RITUAL_CLAUSE (must have been swapped out)",
    );
  });
});
