/**
 * P-POST-PUBLISH-7 Step 2 — Group B scaffold
 * T-Approve.PostStep / T-Approve.ConnectStep / T-Approve.RepostExcluded:
 * approve() surfaces isPostPublish + draftId; preserves resumePrompt/postExtra.
 *
 * Gate: G-P7.approve
 *
 * COMPILE APPROACH: approve() currently returns { status, response, resumePrompt? }.
 * P7 adds isPostPublish:boolean + draftId?:string to the return. These fields do NOT
 * exist yet on the return type. The scaffold uses a type-safe approach: call approve(),
 * cast the return to a loose Record<string,unknown>, then probe for the new fields.
 * TypeScript is satisfied because the cast is explicit — no static reference to a
 * missing field on the current return type. Tests fail at the assert.fail("TODO P7:…")
 * body → RED on HEAD.
 *
 * All 3 tests FAIL on HEAD (correct RED). No production-code edits.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/controller/approval-gate-isPostPublish.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approve } from "../../../../src/agent/workflow/controller/approval-gate.js";
import type { WorkflowControllerDeps } from "../../../../src/agent/workflow/controller.js";
import type { Workflow, WorkflowState } from "../../../../src/agent/workflow/types.js";

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * Build a Workflow with a single requiresApproval:true in_progress step,
 * set awaitingApprovalStepId, call approve(), and return the full result
 * cast to Record<string,unknown> so P7-new fields (isPostPublish, draftId)
 * can be probed without triggering tsc errors on the current (pre-Step-4) type.
 */
function approveAndGetFullResult(
  stepTitle: string,
  stepDraftId?: string,
): Record<string, unknown> {
  const stepId = "step-p7-approve";
  const step = {
    id: stepId,
    title: stepTitle,
    state: "in_progress" as const,
    requiresApproval: true,
    // draftId is the new field added by P7 — may or may not exist before Step 4
    ...(stepDraftId !== undefined ? { draftId: stepDraftId } : {}),
  };
  const wf: Workflow = {
    id: "wf-p7-approve",
    title: "Manual approved outbound",
    approvalMode: "manual",
    steps: [step],
    state: "awaiting_approval",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };
  const state: WorkflowState = { current: wf, awaitingApprovalStepId: stepId };
  const deps: WorkflowControllerDeps = {
    emitFrame: () => {},
    writeWorkflowAudit: () => {},
  };
  const result = approve(state, new Set<string>(), deps, wf, stepId);
  return result as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// T-Approve.PostStep
// ---------------------------------------------------------------------------

describe("approve() — surfaces isPostPublish=true and draftId for post steps (G-P7.approve)", () => {
  it(
    "T-Approve.PostStep: when step id='s-7', title 'Publish post', draftId='d-123', approve() returns isPostPublish===true AND draftId==='d-123' AND stepId==='s-7' AND resumePrompt still contains postExtra text",
    { timeout: 5000 },
    () => {
      // Given: an in-progress step with id="s-7", requiresApproval=true, title "Publish post",
      //        and step.draftId = "d-123" (captured by reconcile).
      // When:  approve() resolves.
      // Then:  result.isPostPublish === true AND result.draftId === "d-123"
      //        AND result.stepId === "s-7" (C-2: explicit stepId in return, not body.stepId)
      //        AND result.resumePrompt contains "OUTBOUND POST PUBLISH" (the postExtra text
      //        that serves as the fallback LLM-resume guidance).
      const stepId = "s-7";
      const step = {
        id: stepId,
        title: "Publish post",
        state: "in_progress" as const,
        requiresApproval: true,
        draftId: "d-123",
      };
      const wf = {
        id: "wf-p7-approve-post",
        title: "Post step",
        approvalMode: "manual" as const,
        steps: [step],
        state: "awaiting_approval" as const,
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z",
      };
      const state = { current: wf, awaitingApprovalStepId: stepId };
      const deps = { emitFrame: () => {}, writeWorkflowAudit: () => {} };
      const result = approve(state as never, new Set<string>(), deps, wf as never, stepId) as unknown as Record<string, unknown>;

      // Baseline: approve() still returns 200 + ok:true (unchanged contract)
      assert.equal(result["status"], 200, "approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "approve() must return ok:true");
      assert.equal(typeof result["resumePrompt"], "string", "resumePrompt must be a string");

      // T-Approve.PostStep P7 new fields
      assert.equal(result["isPostPublish"], true, "T-Approve.PostStep: isPostPublish must be true for a 'Publish post' title");
      assert.equal(result["draftId"], "d-123", "T-Approve.PostStep: draftId must be passed through from step.draftId");
      assert.equal(result["stepId"], "s-7", "T-Approve.PostStep: stepId must be the approved step id (C-2)");
      assert.ok(
        typeof result["resumePrompt"] === "string" &&
        (result["resumePrompt"] as string).includes("OUTBOUND POST PUBLISH"),
        `T-Approve.PostStep: resumePrompt must contain 'OUTBOUND POST PUBLISH' (postExtra text), got: ${String(result["resumePrompt"]).slice(0, 200)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Approve.ConnectStep
// ---------------------------------------------------------------------------

describe("approve() — isPostPublish=false for connect/message titles (G-P7.approve)", () => {
  it(
    "T-Approve.ConnectStep: when step title is 'Send connect invite', approve() returns isPostPublish===false AND draftId===undefined",
    { timeout: 5000 },
    () => {
      // Given: an in-progress step titled "Send connect invite" (no draftId).
      // When:  approve() resolves.
      // Then:  result.isPostPublish === false AND result.draftId === undefined
      //        (connect steps use the connectExtra path, NOT the post path).
      const result = approveAndGetFullResult("Send connect invite");

      // Baseline: approve() still returns 200 + ok:true
      assert.equal(result["status"], 200, "approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "approve() must return ok:true");

      // T-Approve.ConnectStep: isPostPublish must be false, draftId must be undefined
      assert.equal(result["isPostPublish"], false, "T-Approve.ConnectStep: isPostPublish must be false for connect steps");
      assert.equal(result["draftId"], undefined, "T-Approve.ConnectStep: draftId must be undefined for non-post steps");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Approve.RepostExcluded
// ---------------------------------------------------------------------------

describe("approve() — isPostPublish=false for 'Repost' titles (G-P7.approve — repost guard)", () => {
  it(
    "T-Approve.RepostExcluded: when step title is 'Repost article', approve() returns isPostPublish===false (the !/\\b(comment|react|repost)\\b/i guard from approval-gate.ts:70 survives)",
    { timeout: 5000 },
    () => {
      // Given: an in-progress step titled "Repost article" (matches the repost exclusion regex).
      // When:  approve() resolves.
      // Then:  result.isPostPublish === false (the exclusion guard !/\b(comment|react|repost)\b/i
      //        from line 70 of approval-gate.ts must be preserved in the new isPostPublish logic).
      const result = approveAndGetFullResult("Repost article");

      // Baseline
      assert.equal(result["status"], 200, "approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "approve() must return ok:true");

      // T-Approve.RepostExcluded: the !/\b(comment|react|repost)\b/i guard must prevent isPostPublish=true
      assert.equal(result["isPostPublish"], false, "T-Approve.RepostExcluded: isPostPublish must be false for 'Repost article' (exclusion guard)");
    },
  );
});
