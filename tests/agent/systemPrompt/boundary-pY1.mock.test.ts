/**
 * P-Y1 Step 5 — T-Boundary.1 — FILLED
 * (G-PY1.9)
 *
 * System-prompt band changes: boundary.ts BOUNDARY Plan-first paragraph; checkpoint.ts Outbound check;
 * soul.ts soulModeFragment("manual"|"auto").
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 tests/agent/systemPrompt/boundary-pY1.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../../src/agent/systemPrompt/checkpoint.js";
import { soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

// ─── T-Boundary.1 — Plan-first + Outbound-check + Soul mode fragments ────────

describe("system prompt — Boundary Plan-first + Checkpoint outbound-check + Soul mode fragments (G-PY1.9)", () => {
  // Given: BOUNDARY + CHECKPOINT + soulModeFragment.
  // When:  substring searches + placement check.
  // Then:  BOUNDARY has Plan-first (P-Y1) + todo_write + requiresApproval: true (between Web-automation
  //        + Replies); CHECKPOINT has Outbound check (P-Y1); soulModeFragment manual/auto fragments.
  it("T-Boundary.1: given BOUNDARY + CHECKPOINT + soulModeFragment, WHEN substring-searched, THEN BOUNDARY contains 'Plan-first discipline (P-Y1)' + 'todo_write' + 'requiresApproval: true' (between 'Web automation scope' and 'Replies and tool failures'); CHECKPOINT contains 'Outbound check (P-Y1)'; soulModeFragment('manual')⊇'MANUAL mode'; soulModeFragment('auto')⊇'AUTO mode'", () => {
    assert.ok(BOUNDARY.includes("Plan-first discipline (P-Y1)"), "BOUNDARY must contain 'Plan-first discipline (P-Y1)'");
    assert.ok(BOUNDARY.includes("todo_write"), "BOUNDARY Plan-first must mention todo_write");
    assert.ok(BOUNDARY.includes("requiresApproval: true"), "BOUNDARY Plan-first must mention requiresApproval: true");

    // Placement: Plan-first between "Web automation scope" and "Replies and tool failures".
    const webIdx = BOUNDARY.indexOf("Web automation scope");
    const planIdx = BOUNDARY.indexOf("Plan-first discipline (P-Y1)");
    const repliesIdx = BOUNDARY.indexOf("Replies and tool failures");
    assert.ok(webIdx >= 0 && planIdx >= 0 && repliesIdx >= 0, "all 3 anchors present");
    assert.ok(webIdx < planIdx && planIdx < repliesIdx, "Plan-first inserted between Web-automation-scope and Replies");

    assert.ok(CHECKPOINT.includes("Outbound check (P-Y1)"), "CHECKPOINT must contain 'Outbound check (P-Y1)'");

    assert.ok(soulModeFragment("manual").includes("MANUAL mode"), "soulModeFragment('manual') must mention MANUAL mode");
    assert.ok(soulModeFragment("auto").includes("AUTO mode"), "soulModeFragment('auto') must mention AUTO mode");
  });
});
