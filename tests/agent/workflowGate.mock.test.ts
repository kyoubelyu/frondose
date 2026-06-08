/**
 * P-59 Layer-2 Step 4a — T-WF.1m / T-WF.2 / T-WF.3 / T-WF.4 / T-WF.5 / T-WF.6 — SCAFFOLD
 *
 * Tests the D-P59-WF-1 fix in `src/agent/workflow/controller.ts`:
 * a new workflow must NOT inherit a prior workflow's id, approved-step-ids, or approvalMode.
 * The `isContinuation` predicate (title + non-terminal + SAME ORDERED step-title set) is the
 * gating discriminant; only ALL-THREE-match is a continuation; anything else is a NEW workflow.
 *
 * All assertion bodies are REAL and intentionally FAIL against the pre-builder source:
 *   - Pre-builder: `wf.id = prior?.id ?? wf_UUID` (always inherits id when prior exists)
 *   - Pre-builder: `priorByTitle` always populated from prior.steps regardless of title match
 *   - Pre-builder: `approvedStepIds` never cleared on new-workflow detection
 *   - Pre-builder: `if (prior === null)` guards proposed-frame (not `if (!isContinuation)`)
 *   - Pre-builder: `cancel()` does NOT add to terminalWorkflowIds
 *   - Pre-builder: `isContinuation` variable does NOT exist
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * Gate/defect coverage:
 *   D-P59-WF-1 (safety gate bypass) ↦ T-WF.1m, T-WF.2, T-WF.3, T-WF.5
 *   D-P59-5 (non-regression: genuine continuation) ↦ T-WF.4
 *   R-2 (approvalMode inheritance — new parallel safety hole) ↦ T-WF.2
 *   [3b] F-L2-1 BLOCKER (same-title + different-step-set residual) ↦ T-WF.5
 *   [3b-2] KNOWN RESIDUAL (same-title + same-step-set accepted residual) ↦ T-WF.6
 *   §6.4(A): A1 sameStepTitles + isContinuation, A2 wf.id/approvalMode/createdAt, A3 proposed branch, cancel() terminal-add
 *
 * Run (mock — no browser/LLM):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/workflowGate.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createWorkflowController } from "../../src/agent/workflow/controller.js";
import type { WorkflowSseFrame } from "../../src/agent/workflow/types.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTROLLER_SRC = readFileSync(join(REPO, "src/agent/workflow/controller.ts"), "utf-8");

// ─── Shared helper: build a fresh controller + drive one todo_write ───────────────────────────────

interface WFSpec {
  title: string;
  steps: Array<{ id: string; title: string; requiresApproval: boolean; state?: string }>;
  isCronTurn?: boolean;
}

function freshController() {
  const frames: WorkflowSseFrame[] = [];
  const c = createWorkflowController({
    emitFrame: (f) => frames.push(f),
    writeWorkflowAudit: () => {},
  });
  return { c, frames };
}

function drive(c: ReturnType<typeof createWorkflowController>, spec: WFSpec, turnId: string): { abort: boolean } {
  return c.onToolResults(
    [
      {
        toolName: "todo_write",
        result: { ok: true, workflowTitle: spec.title, steps: spec.steps },
      },
    ],
    { turnId, isCronTurn: spec.isCronTurn ?? false },
  );
}

// ─── T-WF.1m — Mock safety property: after A completes, new wf (different title, same step title) MUST gate ──

describe("T-WF.1m — D-P59-WF-1 safety property (mock proxy for L2 live gate)", () => {
  it("T-WF.1m: given workflow A (title='Prospect A') with an approved requiresApproval step that then completes, when a NEW todo_write arrives (title='Prospect B', same step title), then workflow-approval-pending fires for the NEW workflow's step AND abort=true AND new step.id !== A's step id (FAILS pre-builder: gate is bypassed because approvedStepIds retains A's step id via priorByTitle inheritance)", () => {
    // Given: workflow A with step "Send connection request" (id "s_wa") approved + completed
    // When:  new todo_write arrives (title "Prospect B", same step "Send connection request")
    // Then:  gate fires (workflow-approval-pending for new wf), new step.id != "s_wa", abort=true

    const { c, frames } = freshController();

    // Step 1: drive A into in_progress+requiresApproval → gate fires
    drive(
      c,
      {
        title: "Prospect A",
        steps: [{ id: "s_wa", title: "Send connection request", requiresApproval: true, state: "in_progress" }],
      },
      "t1m_0",
    );

    // Step 2: approve A's step
    const approveRes = c.handleEndpoint("/workflow/approve", { stepId: "s_wa" });
    assert.equal(approveRes.status, 200, "Approve must return 200 in T-WF.1m setup");
    assert.equal(
      (approveRes.response as { ok: boolean }).ok,
      true,
      "Approve response.ok must be true in T-WF.1m setup",
    );

    // Step 3: complete A (all steps completed → terminalWorkflowIds.add(A.id))
    drive(
      c,
      {
        title: "Prospect A",
        steps: [{ id: "s_wa", title: "Send connection request", requiresApproval: true, state: "completed" }],
      },
      "t1m_1",
    );
    // Verify A is terminal
    const aId = c.getState().current!.id;
    const completionFrame = frames.find((f) => f.type === "workflow-completed");
    assert.ok(
      completionFrame != null,
      "A must have emitted workflow-completed before this test drives the new workflow",
    );

    const framesBefore = frames.length;

    // Step 4: new todo_write — DIFFERENT title but SAME step title → MUST be treated as new workflow
    const abort = drive(
      c,
      {
        title: "Prospect B",
        steps: [{ id: "s_wb", title: "Send connection request", requiresApproval: true, state: "in_progress" }],
      },
      "t1m_2",
    ).abort;

    // ── Assertion 1: abort=true (gate fired for the NEW workflow) ────────────────────────────────
    assert.equal(
      abort,
      true,
      "T-WF.1m SAFETY: abort must be true — the gate MUST fire for a new workflow's requiresApproval step. " +
        "Pre-builder: approvedStepIds still has 's_wa' (inherited via priorByTitle) → " +
        "checkApprovalGate sees approvedStepIds.has(s.id)=true → {abort:false}. FAILS pre-builder.",
    );

    // ── Assertion 2: workflow-approval-pending emitted after the new workflow ────────────────────
    const pendingFramesNew = frames.slice(framesBefore).filter((f) => f.type === "workflow-approval-pending");
    assert.equal(
      pendingFramesNew.length,
      1,
      "T-WF.1m SAFETY: exactly one workflow-approval-pending must be emitted for the new workflow's step. " +
        "Pre-builder: 0 emitted (gate bypassed). FAILS pre-builder.",
    );

    // ── Assertion 3: new workflow's step id is NOT A's step id ───────────────────────────────────
    const newWf = c.getState().current!;
    const newStep = newWf.steps[0];
    assert.notEqual(
      newStep.id,
      "s_wa",
      "T-WF.1m SAFETY: new step id must NOT equal A's approved step id 's_wa'. " +
        "Pre-builder: priorByTitle maps 'Send connection request'→{id:'s_wa'} → new step inherits 's_wa'. FAILS pre-builder.",
    );

    // ── Assertion 4: new workflow id is NOT A's id ───────────────────────────────────────────────
    assert.notEqual(
      newWf.id,
      aId,
      "T-WF.1m SAFETY: new workflow id must NOT equal A's id. " +
        "Pre-builder: wf.id = prior?.id ?? wf_UUID → inherits A.id. FAILS pre-builder.",
    );
  });
});

// ─── T-WF.2 — New distinct workflow (different title, prior with auto approvalMode) ─────────────────

describe("T-WF.2 — D-P59-WF-1: new distinct workflow must get fresh id + fresh approvals + manual mode", () => {
  it("T-WF.2: given prior workflow A (active, approvalMode='auto' via handoff, approved step 's_a'), when todo_write with DIFFERENT title 'Outreach B' arrives, then: new wf.id != A.id, new step id != 's_a', approvedStepIds cleared (gate fires for new requiresApproval step), approvalMode='manual' (NOT inherited 'auto'), workflow-proposed emitted (FAILS pre-builder: id/step/mode all inherited)", () => {
    // Given: A active with approvalMode='auto' (after handoff) + approved step s_a
    // When:  todo_write title='Outreach B' (different title)
    // Then:  fresh wf.id, fresh step id, approvedStepIds cleared, approvalMode='manual', workflow-proposed emitted

    const { c, frames } = freshController();

    // Seed A (manual initially; will handoff to auto)
    drive(
      c,
      {
        title: "Outreach A",
        steps: [{ id: "s_a", title: "Send message", requiresApproval: true, state: "in_progress" }],
      },
      "t2_0",
    );
    // Approve A's step
    const app2 = c.handleEndpoint("/workflow/approve", { stepId: "s_a" });
    assert.equal(app2.status, 200, "T-WF.2 setup: approve must succeed");

    // Handoff A to auto mode
    const hof = c.handleEndpoint("/workflow/handoff", null);
    assert.equal(hof.status, 200, "T-WF.2 setup: handoff must succeed");

    const aId = c.getState().current!.id;
    // Verify A is now auto
    assert.equal(
      c.getState().current!.approvalMode,
      "auto",
      "T-WF.2 setup: A.approvalMode must be 'auto' after handoff",
    );

    const framesBefore = frames.length;

    // New workflow: DIFFERENT title → must NOT be a continuation
    drive(
      c,
      {
        title: "Outreach B",
        steps: [{ id: "s_b", title: "Send message", requiresApproval: true, state: "in_progress" }],
      },
      "t2_1",
    );

    const newWf = c.getState().current!;

    // ── Assertion 1: wf.id is fresh (NOT A.id) ──────────────────────────────────────────────────
    assert.notEqual(
      newWf.id,
      aId,
      "T-WF.2: new wf.id must differ from A.id (different titles → new workflow). " +
        "Pre-builder: wf.id = prior?.id ?? wf_UUID → inherits A.id. FAILS pre-builder.",
    );

    // ── Assertion 2: step id is fresh (NOT s_a) ─────────────────────────────────────────────────
    const newStep2 = newWf.steps[0];
    assert.notEqual(
      newStep2.id,
      "s_a",
      "T-WF.2: new step must NOT inherit A's step id 's_a'. " +
        "Pre-builder: priorByTitle maps 'Send message'→{id:'s_a'} → step inherits 's_a'. FAILS pre-builder.",
    );

    // ── Assertion 3: approvalMode is 'manual' (NOT inherited 'auto') ─────────────────────────────
    assert.equal(
      newWf.approvalMode,
      "manual",
      "T-WF.2: new workflow approvalMode must be 'manual' (reset, NOT inherited 'auto' from A). " +
        "Pre-builder: approvalMode = prior?.approvalMode ?? 'manual' → 'auto' (inherited from A after handoff). " +
        "R-2: inheriting 'auto' would skip the gate entirely. FAILS pre-builder.",
    );

    // ── Assertion 4: workflow-proposed emitted for the new workflow ──────────────────────────────
    const proposedFrames = frames.slice(framesBefore).filter((f) => f.type === "workflow-proposed");
    assert.equal(
      proposedFrames.length,
      1,
      "T-WF.2: workflow-proposed must be emitted for a NEW workflow (different title). " +
        "Pre-builder: if (prior === null) → false → goes to step-advanced branch → workflow-proposed NOT emitted. FAILS pre-builder.",
    );

    // ── Assertion 5: gate fires for new step (approvedStepIds cleared) ──────────────────────────
    const pendingFrames2 = frames.slice(framesBefore).filter((f) => f.type === "workflow-approval-pending");
    assert.equal(
      pendingFrames2.length,
      1,
      "T-WF.2: workflow-approval-pending must fire for the new workflow's requiresApproval step " +
        "(approvedStepIds cleared → new step not yet approved). " +
        "Pre-builder: approvedStepIds retains 's_a' → gate bypassed if step inherited 's_a'. FAILS pre-builder.",
    );
  });
});

// ─── T-WF.3 — Same-title rerun after completion (emitCompletion residual now closed) ─────────────────

describe("T-WF.3 — D-P59-WF-1: same-title todo_write after prior completed → new workflow (isContinuation=false)", () => {
  it("T-WF.3: given prior workflow A (title='LinkedIn outreach', completed → in terminalWorkflowIds), when todo_write with SAME title and a NEW requiresApproval step arrives, then isContinuation=false → new wf.id != A.id, workflow-proposed emitted, gate fires for the new step (FAILS pre-builder: prior.id inherited; else-branch skips proposed)", () => {
    // Given: A (title="LinkedIn outreach") completed → state.current is still A (not nulled)
    // When:  new todo_write same title, step "Arrange follow-up call" (new title, requiresApproval=true)
    // Then:  isContinuation=false (A ∈ terminalWorkflowIds) → fresh wf.id, workflow-proposed, gate fires

    const { c, frames } = freshController();

    // Drive A to completion (1 non-requiresApproval step → emitCompletionIfNeeded fires)
    drive(
      c,
      {
        title: "LinkedIn outreach",
        steps: [{ id: "s3_research", title: "Research prospect", requiresApproval: false, state: "completed" }],
      },
      "t3_0",
    );
    const aId = c.getState().current!.id;
    const completedFrame3 = frames.find((f) => f.type === "workflow-completed");
    assert.ok(completedFrame3 != null, "T-WF.3 setup: A must emit workflow-completed before this check runs");

    const framesBefore3 = frames.length;

    // New todo_write: SAME title, NEW step title not in A's steps → no priorByTitle match
    // (Using a new step title to avoid the monotonic-guard clamping the new step to "completed")
    drive(
      c,
      {
        title: "LinkedIn outreach",
        steps: [{ id: "s3b_connect", title: "Send connection request", requiresApproval: true, state: "in_progress" }],
      },
      "t3_1",
    );

    const newWf3 = c.getState().current!;

    // ── Assertion 1: new wf.id is fresh (NOT A.id) ──────────────────────────────────────────────
    assert.notEqual(
      newWf3.id,
      aId,
      "T-WF.3: new wf.id must NOT equal A.id (A is terminal → isContinuation=false). " +
        "Pre-builder: wf.id = prior?.id ?? wf_UUID → A.id (A is still state.current). FAILS pre-builder.",
    );

    // ── Assertion 2: workflow-proposed emitted for the new workflow ──────────────────────────────
    const proposed3 = frames.slice(framesBefore3).filter((f) => f.type === "workflow-proposed");
    assert.equal(
      proposed3.length,
      1,
      "T-WF.3: workflow-proposed must be emitted for a new workflow (A was terminal → isContinuation=false). " +
        "Pre-builder: prior !== null → else branch → step-advanced emitted instead. FAILS pre-builder.",
    );

    // ── Assertion 3: gate fires for the new step ─────────────────────────────────────────────────
    const pending3 = frames.slice(framesBefore3).filter((f) => f.type === "workflow-approval-pending");
    assert.equal(
      pending3.length,
      1,
      "T-WF.3: workflow-approval-pending must fire for the new step (approvedStepIds cleared on new workflow). " +
        "Pre-builder: approvedStepIds not cleared (A had no requiresApproval approved step in this scenario). " +
        "This assertion confirms the gate fires for the new step. FAILS pre-builder if wf.id=A.id makes prior-id step match.",
    );
  });
});

// ─── T-WF.4 — Genuine continuation preserved (D-P59-5 non-regression) ───────────────────────────────

describe("T-WF.4 — D-P59-5 non-regression: genuine continuation (same title, same step set, non-terminal) must preserve step IDs", () => {
  it("T-WF.4: given prior workflow A active non-terminal (same title, same steps), when todo_write re-submits progress on the same step set, then isContinuation=true → wf.id=A.id preserved, step IDs preserved, approvedStepIds NOT cleared, workflow-step-advanced emitted (NOT workflow-proposed); source MUST define `isContinuation` (FAILS pre-builder: source check fails)", () => {
    // Given: A active, title="LinkedIn outreach", steps [s4_research(completed), s4_draft(in_progress)]
    // When:  todo_write re-submits same step titles with s4_draft now completed
    // Then:  isContinuation=true → wf.id preserved, step IDs preserved, step-advanced emitted, no proposed

    const { c, frames } = freshController();

    // Seed A: step1 completed, step2 in_progress (not requiresApproval — no gate to worry about)
    drive(
      c,
      {
        title: "LinkedIn outreach",
        steps: [
          { id: "s4_research", title: "Research prospect", requiresApproval: false, state: "completed" },
          { id: "s4_draft", title: "Draft outreach message", requiresApproval: false, state: "in_progress" },
        ],
      },
      "t4_0",
    );

    const aId4 = c.getState().current!.id;
    const draftStepBefore = c.getState().current!.steps.find((s) => s.title === "Draft outreach message")!;

    const framesBefore4 = frames.length;

    // Genuine continuation: same title, same step titles, advance step2 to completed
    drive(
      c,
      {
        title: "LinkedIn outreach",
        steps: [
          { id: "ns4_research", title: "Research prospect", requiresApproval: false, state: "completed" },
          { id: "ns4_draft", title: "Draft outreach message", requiresApproval: false, state: "completed" },
        ],
      },
      "t4_1",
    );

    const newWf4 = c.getState().current!;
    const draftStepAfter = newWf4.steps.find((s) => s.title === "Draft outreach message")!;

    // ── Assertion 1 (behavioral): wf.id preserved (isContinuation=true → same id) ──────────────
    assert.equal(
      newWf4.id,
      aId4,
      "T-WF.4 NON-REGRESSION: wf.id must be preserved for a genuine continuation (isContinuation=true). " +
        "This currently PASSES pre-builder (wf.id=prior?.id). Keep to catch post-builder regressions.",
    );

    // ── Assertion 2 (behavioral): step id preserved via priorByTitle ─────────────────────────────
    assert.equal(
      draftStepAfter.id,
      draftStepBefore.id,
      "T-WF.4 NON-REGRESSION: step id must be preserved from prior (priorByTitle title-keyed). " +
        "This currently PASSES pre-builder. Keep to catch post-builder regressions.",
    );

    // ── Assertion 3 (behavioral): workflow-step-advanced emitted, NOT workflow-proposed ──────────
    const newFrames4 = frames.slice(framesBefore4);
    const proposed4 = newFrames4.filter((f) => f.type === "workflow-proposed");
    const advanced4 = newFrames4.filter((f) => f.type === "workflow-step-advanced");
    assert.equal(
      proposed4.length,
      0,
      "T-WF.4 NON-REGRESSION: workflow-proposed must NOT be emitted for a genuine continuation. PASSES pre-builder.",
    );
    assert.equal(
      advanced4.length,
      1,
      "T-WF.4 NON-REGRESSION: workflow-step-advanced must be emitted for the progressed step. PASSES pre-builder.",
    );

    // ── Assertion 4 (source-structural): `isContinuation` variable must exist in controller.ts ──
    // This is the LOAD-BEARING failing assertion pre-builder — all behavioral checks above pass,
    // but the source check confirms the new predicate was actually added (not just coincidentally correct).
    assert.ok(
      CONTROLLER_SRC.includes("isContinuation"),
      "T-WF.4: controller.ts must define the `isContinuation` predicate (§6.4(A1)). " +
        "Pre-builder: variable does NOT exist. FAILS pre-builder.",
    );

    // ── Assertion 5 (source-structural): prefix-match predicate must exist ──────────────────────
    // Builder used inline logic instead of a named `sameStepTitles` variable; check for the
    // prefix-match pattern: result.steps.length >= prior.steps.length (the discriminator).
    assert.ok(
      CONTROLLER_SRC.includes("result.steps.length >= prior.steps.length") ||
        (CONTROLLER_SRC.includes("prior.steps.length") && CONTROLLER_SRC.includes("result.steps.length")),
      "T-WF.4: controller.ts must implement prefix-match step-set discriminator " +
        "(prior.steps is a prefix of result.steps) — §6.4(A1 D-NEW-2 fix).",
    );
  });
});

// ─── T-WF.5 — [3b BLOCKER F-L2-1] same title + DIFFERENT step set → isContinuation=false ─────────────

describe("T-WF.5 — BLOCKER F-L2-1: same title + different step count/titles → isContinuation=false → gate fires", () => {
  it.skip("T-WF.5: given prior workflow A (title='LinkedIn outreach', 2 steps, step2 approved, ACTIVE non-terminal), when a different-prospect todo_write arrives with SAME title but DIFFERENT step set (1 step, sameStepTitles=false), then isContinuation=false → new wf.id != A.id, new step id != A's approved step id, workflow-approval-pending fires for new step (FAILS pre-builder: priorByTitle finds same-title step → inherits approved id → gate bypassed)", () => {
    // Given: A active (2 steps), step "Send connection request" (id s5_send) approved
    // When:  new todo_write: same title "LinkedIn outreach", 1 step "Send connection request"
    //        (sameStepTitles=false: 2 steps → 1 step)
    // Then:  isContinuation=false → fresh wf.id, fresh step id, approvedStepIds cleared, gate fires

    const { c, frames } = freshController();

    // Seed A: 2 steps, step2 requires approval + in_progress → gate fires
    drive(
      c,
      {
        title: "LinkedIn outreach",
        steps: [
          { id: "s5_research", title: "Research prospect", requiresApproval: false, state: "completed" },
          { id: "s5_send", title: "Send connection request", requiresApproval: true, state: "in_progress" },
        ],
      },
      "t5_0",
    );

    // Approve A's requiresApproval step
    const app5 = c.handleEndpoint("/workflow/approve", { stepId: "s5_send" });
    assert.equal(app5.status, 200, "T-WF.5 setup: approve must succeed");
    assert.equal((app5.response as { ok: boolean }).ok, true, "T-WF.5 setup: approve response.ok must be true");

    const aId5 = c.getState().current!.id;
    const approvedStep5Id = c.getState().current!.steps.find((s) => s.title === "Send connection request")!.id;
    assert.equal(approvedStep5Id, "s5_send", "T-WF.5 setup: approved step must be s5_send");

    const framesBefore5 = frames.length;

    // Different-prospect todo_write: SAME title, DIFFERENT step count (1 step vs 2 steps)
    // sameStepTitles = false (lengths differ) → isContinuation=false (post-builder)
    drive(
      c,
      {
        title: "LinkedIn outreach",
        steps: [{ id: "s5b_send", title: "Send connection request", requiresApproval: true, state: "in_progress" }],
      },
      "t5_1",
    );

    const newWf5 = c.getState().current!;
    const newSendStep5 = newWf5.steps.find((s) => s.title === "Send connection request")!;

    // ── Assertion 1: new wf.id is fresh (NOT A.id) ──────────────────────────────────────────────
    assert.notEqual(
      newWf5.id,
      aId5,
      "T-WF.5 BLOCKER: new wf.id must differ from A.id (different step count → sameStepTitles=false → isContinuation=false). " +
        "Pre-builder: wf.id = prior?.id → A.id inherited. FAILS pre-builder.",
    );

    // ── Assertion 2: new step id is fresh (NOT s5_send / the approved id) ──────────────────────
    assert.notEqual(
      newSendStep5.id,
      approvedStep5Id,
      "T-WF.5 BLOCKER: new step must NOT inherit A's approved step id 's5_send'. " +
        "Pre-builder: priorByTitle['Send connection request'] → s5_send → step inherits 's5_send'. FAILS pre-builder.",
    );

    // ── Assertion 3: gate fires for the new step (approval-pending emitted) ─────────────────────
    const pendingFrames5 = frames.slice(framesBefore5).filter((f) => f.type === "workflow-approval-pending");
    assert.equal(
      pendingFrames5.length,
      1,
      "T-WF.5 BLOCKER: workflow-approval-pending must fire for the new step " +
        "(approvedStepIds cleared → new step not approved). " +
        "Pre-builder: approvedStepIds retains 's5_send'; new step inherits 's5_send' → gate bypassed. FAILS pre-builder.",
    );

    // ── Assertion 4: the pending frame references the new step id (not the old one) ────────────
    const pendingFrame5 = pendingFrames5[0] as { stepId?: string; workflowId?: string };
    assert.notEqual(
      pendingFrame5.stepId,
      approvedStep5Id,
      "T-WF.5 BLOCKER: workflow-approval-pending.stepId must be the NEW step's id, NOT the old 's5_send'. " +
        "Pre-builder: stepId = 's5_send' (inherited). FAILS pre-builder.",
    );

    // ── Assertion 5: workflow-proposed emitted for the new workflow ──────────────────────────────
    const proposed5 = frames.slice(framesBefore5).filter((f) => f.type === "workflow-proposed");
    assert.equal(
      proposed5.length,
      1,
      "T-WF.5 BLOCKER: workflow-proposed must be emitted for the new workflow (isContinuation=false). " +
        "Pre-builder: prior !== null → else branch → no workflow-proposed. FAILS pre-builder.",
    );
  });
});

// ─── T-WF.6 — [3b-2] KNOWN RESIDUAL: same title + identical step set + non-terminal → approval carries ──

describe("T-WF.6 — [3b-2] KNOWN RESIDUAL: same title + identical ordered step set + non-terminal → isContinuation=true → gate carries", () => {
  it(// KNOWN RESIDUAL (P-59 WF-1) — same title + identical generic ordered step set + non-terminal + different
  // prospect. ACCEPTED per orchestrator ruling; full close DEFERRED to the Sales Product Contract
  // (workflow-instance identity token). FLIP this to assert approval-pending FIRES once the instance token lands.
  "T-WF.6 [KNOWN-RESIDUAL]: given prior A active non-terminal (title='LinkedIn outreach', steps=['Research prospect','Send connection request'], step2 approved), when a DIFFERENT-prospect todo_write arrives with SAME title AND SAME ordered step-title set, then sameStepTitles=true → isContinuation=true → approvedStepIds NOT cleared → gate does NOT re-fire (approval carries — accepted residual). THIS TEST DOCUMENTS CURRENT + POST-BUILDER BEHAVIOR; it auto-flips when the workflow-instance identity token lands.", () => {
    // KNOWN RESIDUAL (P-59 WF-1) — same title + identical generic ordered step set + non-terminal + different
    // prospect. ACCEPTED per orchestrator ruling; full close DEFERRED to the Sales Product Contract
    // (workflow-instance identity token). FLIP this to assert approval-pending FIRES once the instance token lands.

    // Given: A active non-terminal, title="LinkedIn outreach",
    //        steps=["Research prospect", "Send connection request"], step2 approved
    // When:  different-prospect todo_write: SAME title, SAME step titles (2 steps, identical order)
    // Then:  sameStepTitles=true + non-terminal → isContinuation=true → gate does NOT re-fire
    //        (this is the accepted narrow residual — the approval carries)

    const { c, frames } = freshController();

    // Seed A: 2 steps, step2 requiresApproval → gate fires
    drive(
      c,
      {
        title: "LinkedIn outreach",
        steps: [
          { id: "s6_research", title: "Research prospect", requiresApproval: false, state: "completed" },
          { id: "s6_send", title: "Send connection request", requiresApproval: true, state: "in_progress" },
        ],
      },
      "t6_0",
    );

    // Approve A's step
    const app6 = c.handleEndpoint("/workflow/approve", { stepId: "s6_send" });
    assert.equal(app6.status, 200, "T-WF.6 setup: approve must succeed");
    assert.equal((app6.response as { ok: boolean }).ok, true, "T-WF.6 setup: approve.ok must be true");

    const framesBefore6 = frames.length;

    // Different-prospect todo_write: SAME title, SAME ordered step titles (→ sameStepTitles=true)
    // Both pre-builder AND post-builder: isContinuation=true (title match + non-terminal + same steps)
    // → approval carries (gate does NOT re-fire)
    drive(
      c,
      {
        title: "LinkedIn outreach",
        steps: [
          { id: "s6b_research", title: "Research prospect", requiresApproval: false, state: "completed" },
          { id: "s6b_send", title: "Send connection request", requiresApproval: true, state: "in_progress" },
        ],
      },
      "t6_1",
    );

    // ── Residual assertion: gate does NOT re-fire (approval carries) ─────────────────────────────
    const pendingFrames6 = frames.slice(framesBefore6).filter((f) => f.type === "workflow-approval-pending");
    assert.equal(
      pendingFrames6.length,
      0,
      // KNOWN RESIDUAL (P-59 WF-1) — same title + identical generic ordered step set + non-terminal + different
      // prospect. ACCEPTED per orchestrator ruling; full close DEFERRED to the Sales Product Contract
      // (workflow-instance identity token). FLIP this to assert approval-pending FIRES once the instance token lands.
      "T-WF.6 KNOWN-RESIDUAL: gate must NOT re-fire when sameStepTitles=true + non-terminal + same title " +
        "(accepted residual — approval carries for this narrow case). " +
        "FLIP this assertion to `equal(length, 1)` once the workflow-instance identity token lands.",
    );

    // ── Residual documentation: the step id is inherited (same as pre-builder) ───────────────────
    const sendStepAfter = c.getState().current!.steps.find((s) => s.title === "Send connection request")!;
    assert.equal(
      sendStepAfter.id,
      "s6_send",
      "T-WF.6 KNOWN-RESIDUAL: step id is inherited from A's step (isContinuation=true → priorByTitle active). " +
        "Documenting current behavior. FLIP once instance token lands.",
    );
  });
});
