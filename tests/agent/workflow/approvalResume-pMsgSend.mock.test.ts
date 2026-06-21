/**
 * P-MSG-SEND follow-up — approval resume prompt branches message replies away
 * from connection-invite guidance.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/approvalResume-pMsgSend.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approve } from "../../../src/agent/workflow/controller/approval-gate.js";
import type { WorkflowControllerDeps } from "../../../src/agent/workflow/controller.js";
import type { Workflow, WorkflowState } from "../../../src/agent/workflow/types.js";

function approvePromptForStepTitle(stepTitle: string): string {
  const stepId = "step-approval";
  const wf: Workflow = {
    id: "wf-approval",
    title: "Manual approved outbound",
    approvalMode: "manual",
    steps: [
      {
        id: stepId,
        title: stepTitle,
        state: "in_progress",
        requiresApproval: true,
      },
    ],
    state: "awaiting_approval",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
  const state: WorkflowState = { current: wf, awaitingApprovalStepId: stepId };
  const deps: WorkflowControllerDeps = {
    emitFrame: () => {},
    writeWorkflowAudit: () => {},
  };

  const result = approve(state, new Set<string>(), deps, wf, stepId);

  assert.equal(result.status, 200, "approve() must return 200 for a pending approval");
  assert.deepEqual(result.response, { ok: true }, "approve() must accept the pending approval");
  assert.equal(typeof result.resumePrompt, "string", "approve() must return a resume prompt");
  return result.resumePrompt;
}

describe("approval resume prompt outbound guidance", () => {
  // Given: an approved in-progress step titled as a message reply; When: approve() builds the resume prompt; Then: it directs a thread Send and omits connection-invite guidance.
  it("T-MsgResume.1: approve() on a 'Send reply: ...' message step returns message-reply guidance without connection-invite actions", () => {
    const prompt = approvePromptForStepTitle("Send reply: Alice after her LinkedIn response");

    assert.match(prompt, /message reply/i, "message approval resume must identify the step as a message reply");
    assert.match(prompt, /thread's "Send" button/, "message approval resume must target the thread Send button");
    assert.match(prompt, /mark_message_sent\(draftId\)/, "message approval resume must record mark_message_sent");
    assert.doesNotMatch(prompt, /Add a note/, "message approval resume must not include connect-note guidance");
    assert.doesNotMatch(prompt, /Send invite/, "message approval resume must not include invite-send guidance");
    assert.doesNotMatch(
      prompt,
      /connect_sent/,
      "message approval resume must not include the connect_sent stage token",
    );
  });

  // Given: an approved in-progress step titled as a connection invite; When: approve() builds the resume prompt; Then: the existing connect guidance is still present.
  it("T-MsgResume.2: approve() on a 'Connect with ...' step keeps Add-a-note / Send-invite / connect_sent guidance", () => {
    const prompt = approvePromptForStepTitle("Invite Alice to connect");

    assert.match(prompt, /Add a note/, "connect approval resume must still include Add-a-note guidance");
    assert.match(prompt, /Send invite/, "connect approval resume must still include Send-invite guidance");
    assert.match(prompt, /connect_sent/, "connect approval resume must still close the loop with connect_sent");
  });
});
