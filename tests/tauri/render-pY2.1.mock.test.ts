/**
 * P-Y2.1 Step 5 — T-Render.1..3 (pure render-data helpers) — FILLED.
 *
 * Pure-unit tests: import `src/tauri/ui/render.ts` and assert the side-effect-free render-data helpers
 * computeProgress / stepChipLabel / stepVisualState that drive the iwf-card (Manual) + Auto stage chips/dots.
 *
 * NOTE (shipped vs §6.4 sketch): render.ts orders the chip/visual guards pendingStepId-FIRST, failed-LAST
 * (the sketch listed failed-first). Behaviorally IDENTICAL for all 6 specified cases (none is both failed
 * AND pending). The failed+pending combo (unspecified by §6.1) is pinned as an edge case below = shipped
 * "needs you"/"needs-you" (pending guard wins). Informational, not a defect.
 *
 * Gate coverage:
 *   G-PY2.1.4 — iwf-card Manual fidelity: progress + chip/visual states (T-Render.1..3)
 *   G-PY2.1.5 — Auto stage fidelity: chip/visual states incl. auto-approved (T-Render.2, .3)
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *   --test-timeout=30000 tests/tauri/render-pY2.1.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeProgress, stepChipLabel, stepVisualState } from "../../src/tauri/ui/render.js";

type StepState = "pending" | "in_progress" | "completed" | "failed";
const step = (id: string, state: StepState, requiresApproval = false) => ({ id, title: id, state, requiresApproval });

describe("render.computeProgress (G-PY2.1.4)", () => {
  it("T-Render.1: when 7 steps with exactly 2 completed, returns { done:2, total:7, fraction:2/7 }; empty → {0,0,0}", () => {
    // Given: computeProgress
    // When:  called with 7 steps (2 completed, rest in_progress/pending), then with []
    // Then:  { done:2, total:7, fraction:2/7 } (matches desktop_manual "2 / 7"); computeProgress([]) → {0,0,0} (no ÷0)
    const steps = [
      step("a", "completed"),
      step("b", "completed"),
      step("c", "in_progress"),
      step("d", "pending"),
      step("e", "pending"),
      step("f", "pending"),
      step("g", "pending"),
    ];
    assert.deepEqual(computeProgress(steps), { done: 2, total: 7, fraction: 2 / 7 });
    assert.deepEqual(computeProgress([]), { done: 0, total: 0, fraction: 0 });
  });
});

describe("render.stepChipLabel (G-PY2.1.4, G-PY2.1.5)", () => {
  it("T-Render.2: when fed the 6 step cases, returns the mapped chip label (working / needs you / auto-approved / done / failed / '')", () => {
    // Given: stepChipLabel(step, pendingStepId, mode)
    // When:  in_progress(not pending) · id===pendingStepId · completed+requiresApproval+auto · completed(other) · failed · pending
    // Then:  'working' · 'needs you' · 'auto-approved' · 'done' · 'failed' · '' (design-doc §6 L212-219; desktop_auto chips)
    assert.equal(stepChipLabel(step("s1", "in_progress"), null, "manual"), "working");
    assert.equal(stepChipLabel(step("s2", "pending"), "s2", "manual"), "needs you");
    assert.equal(stepChipLabel(step("s3", "completed", true), null, "auto"), "auto-approved");
    assert.equal(stepChipLabel(step("s4", "completed", true), null, "manual"), "done");
    assert.equal(stepChipLabel(step("s5", "failed"), null, "manual"), "failed");
    assert.equal(stepChipLabel(step("s6", "pending"), null, "manual"), "");
  });

  it("T-Render.2b (edge): a completed+requiresApproval step in MANUAL is 'done' (auto-approved only in Auto); failed+pending → 'needs you' (pending guard wins, shipped order)", () => {
    // Given: stepChipLabel
    // When:  completed+approval in manual; and a step both failed AND id===pendingStepId
    // Then:  'done' (manual never auto-approves); 'needs you' (shipped checks pendingStepId before failed — §6.4 deviation, behaviorally equiv for spec cases)
    assert.equal(stepChipLabel(step("m", "completed", true), null, "manual"), "done");
    assert.equal(stepChipLabel(step("fp", "failed"), "fp", "manual"), "needs you");
  });
});

describe("render.stepVisualState (G-PY2.1.4, G-PY2.1.5)", () => {
  it("T-Render.3: when fed the same 6 cases, returns the CSS-state token (current / needs-you / auto-approved / success / failed / idle)", () => {
    // Given: stepVisualState(step, pendingStepId, mode)
    // When:  the same six cases as T-Render.2
    // Then:  'current' · 'needs-you' · 'auto-approved' · 'success' · 'failed' · 'idle' (drives dot fill + border, design-doc §6)
    assert.equal(stepVisualState(step("s1", "in_progress"), null, "manual"), "current");
    assert.equal(stepVisualState(step("s2", "pending"), "s2", "manual"), "needs-you");
    assert.equal(stepVisualState(step("s3", "completed", true), null, "auto"), "auto-approved");
    assert.equal(stepVisualState(step("s4", "completed", true), null, "manual"), "success");
    assert.equal(stepVisualState(step("s5", "failed"), null, "manual"), "failed");
    assert.equal(stepVisualState(step("s6", "pending"), null, "manual"), "idle");
  });
});
