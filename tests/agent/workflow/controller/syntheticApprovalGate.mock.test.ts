import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkflowReconcileCtx } from "../../../../src/agent/workflow/controller/reconcile.js";
import type { ToolResultLike } from "../../../../src/agent/workflow/controller/types-internal.js";
import {
  createWorkflowController,
  type WorkflowController,
  type WorkflowControllerDeps,
} from "../../../../src/agent/workflow/controller.js";
import type { WorkflowAuditEntry, WorkflowSseFrame } from "../../../../src/agent/workflow/types.js";

type RecordedAudit = WorkflowAuditEntry["event"];

interface Harness {
  controller: WorkflowController;
  frames: WorkflowSseFrame[];
  audits: RecordedAudit[];
}

function makeHarness(): Harness {
  const frames: WorkflowSseFrame[] = [];
  const audits: RecordedAudit[] = [];
  const deps: WorkflowControllerDeps = {
    emitFrame: (frame) => {
      frames.push(frame);
    },
    writeWorkflowAudit: (event) => {
      audits.push(event);
    },
  };
  return { controller: createWorkflowController(deps), frames, audits };
}

function makeCtx(overrides: Partial<WorkflowReconcileCtx> = {}): WorkflowReconcileCtx {
  return {
    turnId: "turn-d14-synthetic-gate",
    isCronTurn: false,
    resolvedMode: "manual",
    ...overrides,
  };
}

function makeSaveDraftResult(draftId = "draft-d14-synthetic"): ToolResultLike {
  return {
    toolName: "save_message_draft",
    args: { kind: "dm", leadId: "lead-joyce-d14" },
    result: {
      ok: true,
      command: "save_message_draft",
      data: {
        draftId,
        leadId: "lead-joyce-d14",
        status: "draft",
      },
    },
  };
}

describe("D-14 synthetic Manual workflow reaches the existing approval gate", () => {
  // Given no workflow and a successful non-Auto draft save, when the real observer processes Manual, Magical, or omitted mode, then each captures the draft and aborts at one pending approval.
  it("T-D14G.1: every non-Auto direct save synthesizes one gated in-progress step and aborts", () => {
    const contexts: Array<[string, WorkflowReconcileCtx]> = [
      ["manual", makeCtx()],
      ["magical", makeCtx({ resolvedMode: "magical" })],
      [
        "omitted",
        {
          turnId: "turn-d14-synthetic-gate-omitted",
          isCronTurn: false,
        },
      ],
    ];

    for (const [label, ctx] of contexts) {
      const { controller } = makeHarness();
      const result = controller.onToolResults([makeSaveDraftResult()], ctx);
      const state = controller.getState();

      assert.equal(result.abort, true, `${label}: observer must abort`);
      assert.ok(state.current, `${label}: workflow must exist`);
      assert.equal(state.current.state, "awaiting_approval", label);
      assert.equal(state.current.steps.length, 1, label);
      assert.equal(state.current.steps[0]?.state, "in_progress", label);
      assert.equal(state.current.steps[0]?.requiresApproval, true, label);
      assert.equal(state.current.steps[0]?.draftId, "draft-d14-synthetic", label);
      assert.equal(state.awaitingApprovalStepId, state.current.steps[0]?.id, label);
      assert.equal(
        controller.hasApprovedOutboundStep(),
        false,
        `${label}: authorization must remain closed before approval`,
      );
    }
  });

  // Given the Manual fallback, when its observer transaction completes, then proposed-pending, one advance, and one approval-pending share one workflow and step.
  it("T-D14G.2: frame and audit chronology is proposed, one advance, one gate", () => {
    const { controller, frames, audits } = makeHarness();

    controller.onToolResults([makeSaveDraftResult()], makeCtx());

    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["workflow-proposed", "workflow-step-advanced", "workflow-approval-pending"],
    );
    assert.deepEqual(
      audits.map((audit) => audit.kind),
      ["proposed", "step_advance", "approval_pending"],
    );

    const proposed = frames[0];
    const advanced = frames[1];
    const pending = frames[2];
    assert.equal(proposed?.type, "workflow-proposed");
    assert.equal(advanced?.type, "workflow-step-advanced");
    assert.equal(pending?.type, "workflow-approval-pending");
    if (
      proposed?.type !== "workflow-proposed" ||
      advanced?.type !== "workflow-step-advanced" ||
      pending?.type !== "workflow-approval-pending"
    ) {
      assert.fail("expected the exact synthetic-gate frame sequence");
    }
    assert.equal(proposed.steps.length, 1);
    assert.equal(proposed.steps[0]?.state, "pending");
    assert.equal(advanced.prevState, "pending");
    assert.equal(advanced.nextState, "in_progress");
    assert.equal(advanced.workflowId, proposed.workflowId);
    assert.equal(pending.workflowId, proposed.workflowId);
    assert.equal(advanced.stepId, proposed.steps[0]?.id);
    assert.equal(pending.stepId, proposed.steps[0]?.id);

    const proposedAudit = audits[0];
    const advancedAudit = audits[1];
    const pendingAudit = audits[2];
    if (
      proposedAudit?.kind !== "proposed" ||
      advancedAudit?.kind !== "step_advance" ||
      pendingAudit?.kind !== "approval_pending"
    ) {
      assert.fail("expected the exact synthetic-gate audit sequence");
    }
    assert.equal(proposedAudit.workflowId, proposed.workflowId);
    assert.equal(advancedAudit.workflowId, proposed.workflowId);
    assert.equal(pendingAudit.workflowId, proposed.workflowId);
    assert.equal(advancedAudit.stepId, proposed.steps[0]?.id);
    assert.equal(pendingAudit.stepId, proposed.steps[0]?.id);
    assert.equal(pendingAudit.turnIdAborted, "turn-d14-synthetic-gate");
  });

  // Given a duplicate delivery of the same successful save, when one observer batch processes both, then synthesis, advance, and gate each occur once.
  it("T-D14G.3: duplicate save observation cannot duplicate the approval gate", () => {
    const { controller, frames, audits } = makeHarness();
    const save = makeSaveDraftResult();

    const result = controller.onToolResults([save, save], makeCtx());

    assert.equal(result.abort, true);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["workflow-proposed", "workflow-step-advanced", "workflow-approval-pending"],
    );
    assert.deepEqual(
      audits.map((audit) => audit.kind),
      ["proposed", "step_advance", "approval_pending"],
    );
    assert.equal(controller.getState().current?.steps[0]?.draftId, "draft-d14-synthetic");
  });
});

describe("D-14 synthetic gate preserves negative and mode boundaries", () => {
  // Given an unsuccessful save envelope, when the observer processes it, then it creates no workflow, frame, audit, or abort.
  it("T-D14G.4: unsuccessful save does not synthesize or gate", () => {
    const { controller, frames, audits } = makeHarness();
    const failed: ToolResultLike = {
      ...makeSaveDraftResult(),
      result: {
        ok: false,
        command: "save_message_draft",
        error: "persistence_failed",
      },
    };

    const result = controller.onToolResults([failed], makeCtx());

    assert.equal(result.abort, false);
    assert.equal(controller.getState().current, null);
    assert.deepEqual(frames, []);
    assert.deepEqual(audits, []);
  });

  // Given a cron save with no workflow, when the observer processes it, then the Manual fallback remains disabled.
  it("T-D14G.5: cron save does not synthesize a Manual workflow", () => {
    const { controller, frames, audits } = makeHarness();

    const result = controller.onToolResults(
      [makeSaveDraftResult()],
      makeCtx({ isCronTurn: true, resolvedMode: "auto" }),
    );

    assert.equal(result.abort, false);
    assert.equal(controller.getState().current, null);
    assert.deepEqual(frames, []);
    assert.deepEqual(audits, []);
  });

  // Given an operator-started Auto save, when the observer processes it, then the existing non-aborting synthetic carrier remains outside Manual approval.
  it("T-D14G.6: operator-started Auto does not enter the Manual approval gate", () => {
    const { controller, frames, audits } = makeHarness();

    const result = controller.onToolResults([makeSaveDraftResult()], makeCtx({ resolvedMode: "auto" }));
    const state = controller.getState();

    assert.equal(result.abort, false);
    assert.ok(state.current);
    assert.equal(state.current.approvalMode, "manual");
    assert.equal(state.current.steps[0]?.state, "in_progress");
    assert.equal(state.current.steps[0]?.draftId, "draft-d14-synthetic");
    assert.equal(state.awaitingApprovalStepId, null);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["workflow-proposed"],
    );
    assert.deepEqual(
      audits.map((audit) => audit.kind),
      ["proposed"],
    );
  });
});

describe("D-14 synthetic gate opens step-scoped authorization after one decision", () => {
  // Given the fallback is awaiting approval, when the exact step is approved twice, then only the first decision resolves and opens the existing step-scoped authorization.
  it("T-D14G.7: exact approval resolves once, opens step authorization, and duplicate decision is inert", () => {
    const { controller, frames, audits } = makeHarness();
    const saveResult = controller.onToolResults([makeSaveDraftResult()], makeCtx());
    const stepId = controller.getState().awaitingApprovalStepId;

    assert.equal(saveResult.abort, true);
    assert.ok(stepId);
    assert.equal(controller.hasApprovedOutboundStep(), false);

    const first = controller.handleEndpoint("/workflow/approve", { stepId });
    const second = controller.handleEndpoint("/workflow/approve", { stepId });

    assert.deepEqual(first.response, { ok: true });
    assert.deepEqual(second.response, {
      ok: false,
      reason: "no_pending_approval",
    });
    assert.equal(controller.getState().awaitingApprovalStepId, null);
    assert.equal(controller.getState().current?.state, "active");
    assert.equal(controller.hasApprovedOutboundStep(), true);
    assert.equal(frames.filter((frame) => frame.type === "workflow-approval-resolved").length, 1);
    assert.equal(audits.filter((audit) => audit.kind === "approval_resolved").length, 1);
  });
});
