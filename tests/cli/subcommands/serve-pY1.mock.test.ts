/**
 * P-Y1 Step 5 — T-Reconcile.1, T-Gate.1, T-Gate.2, T-Coexist.1, T-Advisory.1, T-AlwaysAsk.1 — FILLED
 * (G-PY1.4, G-PY1.5, G-PY1.6, G-PY1.7, G-PY1.8, G-PY1.14)
 *
 * UNIT-TEST the workflow controller directly (src/agent/workflow/controller.ts). The controller is
 * PURE-DEP: createWorkflowController({emitFrame, writeWorkflowAudit}) → {onToolResults, handleEndpoint,
 * getState}. Each test instantiates with spy deps + drives onToolResults / handleEndpoint.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 tests/cli/subcommands/serve-pY1.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkflowController } from "../../../src/agent/workflow/controller.js";
import type { WorkflowAuditEntry, WorkflowSseFrame } from "../../../src/agent/workflow/types.js";

function makeController() {
  const frames: WorkflowSseFrame[] = [];
  const audits: Array<WorkflowAuditEntry["event"]> = [];
  const c = createWorkflowController({
    emitFrame: (f) => frames.push(f),
    writeWorkflowAudit: (e) => audits.push(e),
  });
  return { c, frames, audits };
}

// ─── T-Reconcile.1 — id preservation by title-match ─────────────────────────

describe("controller.onToolResults — reconcile preserves step ids by title across todo_write calls (G-PY1.4)", () => {
  it("T-Reconcile.1: given a controller seeded from todo_write [A,B], WHEN a second todo_write [A:completed, B:in_progress, C] arrives, THEN A keeps its id (completed), B keeps its id (in_progress), C gets a fresh id (pending), AND a workflow-step-advanced SSE is emitted for B", () => {
    const { c, frames } = makeController();
    c.onToolResults(
      [
        {
          toolName: "todo_write",
          result: {
            ok: true,
            workflowTitle: "W",
            steps: [
              { id: "p_a", title: "A", requiresApproval: false },
              { id: "p_b", title: "B", requiresApproval: false },
            ],
          },
        },
      ],
      { turnId: "t1", isCronTurn: false },
    );
    const after1 = c.getState().current;
    assert.ok(after1, "workflow created");
    const idA = after1.steps.find((s) => s.title === "A")?.id;
    const idB = after1.steps.find((s) => s.title === "B")?.id;
    assert.ok(idA && idB, "A and B have ids");

    c.onToolResults(
      [
        {
          toolName: "todo_write",
          result: {
            ok: true,
            workflowTitle: "W",
            steps: [
              { id: "x", title: "A", requiresApproval: false, state: "completed" },
              { id: "y", title: "B", requiresApproval: false, state: "in_progress" },
              { id: "step_c_provisional", title: "C", requiresApproval: false },
            ],
          },
        },
      ],
      { turnId: "t2", isCronTurn: false },
    );
    const after2 = c.getState().current;
    assert.ok(after2);
    const stepA = after2.steps.find((s) => s.title === "A");
    const stepB = after2.steps.find((s) => s.title === "B");
    const stepC = after2.steps.find((s) => s.title === "C");
    assert.equal(stepA?.id, idA, "A keeps its id (title-match)");
    assert.equal(stepA?.state, "completed", "A → completed");
    assert.equal(stepB?.id, idB, "B keeps its id (title-match)");
    assert.equal(stepB?.state, "in_progress", "B → in_progress");
    assert.ok(stepC && stepC.id !== idA && stepC.id !== idB && /^step_/.test(stepC.id), "C gets a fresh step_ id");
    assert.equal(stepC?.state, "pending", "C → pending");

    // workflow-step-advanced SSE for B (pending → in_progress).
    const advB = frames.find((f) => f.type === "workflow-step-advanced" && f.stepId === idB);
    assert.ok(advB, "workflow-step-advanced emitted for B");
    if (advB && advB.type === "workflow-step-advanced") {
      assert.equal(advB.prevState, "pending");
      assert.equal(advB.nextState, "in_progress");
    }
  });
});

// ─── T-Gate.1 — Manual gate fires (declare-then-abort) ──────────────────────

describe("controller.onToolResults — Manual gate fires on requiresApproval in_progress step (G-PY1.5)", () => {
  it("T-Gate.1: given Manual mode + todo_write with a {requiresApproval:true, state:'in_progress'} 'Send DM' step, WHEN onToolResults runs, THEN it returns {abort:true} + getState().awaitingApprovalStepId === that step id + wf.state==='awaiting_approval' + a workflow-approval-pending SSE (stepTitle 'Send DM') + an approval_pending audit row", () => {
    const { c, frames, audits } = makeController();
    const res = c.onToolResults(
      [
        {
          toolName: "todo_write",
          result: {
            ok: true,
            workflowTitle: "Outreach",
            steps: [{ id: "p1", title: "Send DM", requiresApproval: true, state: "in_progress" }],
          },
        },
      ],
      { turnId: "t1", isCronTurn: false },
    );
    assert.equal(res.abort, true, "Manual gate aborts");
    const state = c.getState();
    const stepId = state.current?.steps[0].id;
    assert.equal(state.awaitingApprovalStepId, stepId, "awaitingApprovalStepId === gate step id");
    assert.equal(state.current?.state, "awaiting_approval", "wf.state awaiting_approval");

    const pending = frames.find((f) => f.type === "workflow-approval-pending");
    assert.ok(pending, "workflow-approval-pending SSE emitted");
    if (pending && pending.type === "workflow-approval-pending") {
      assert.equal(pending.stepTitle, "Send DM", "stepTitle 'Send DM'");
      assert.equal(pending.stepId, stepId);
    }
    assert.ok(
      audits.some((e) => e.kind === "approval_pending"),
      "approval_pending audit row written",
    );
  });
});

// ─── T-Gate.2 — Auto mode skips gate ────────────────────────────────────────

describe("controller.onToolResults — Auto/cron mode does NOT gate requiresApproval step (G-PY1.6)", () => {
  it("T-Gate.2: given Auto mode (isCronTurn:true) + the same {requiresApproval:true, state:'in_progress'} step, WHEN onToolResults runs, THEN it returns {abort:false} + getState().awaitingApprovalStepId === null + NO workflow-approval-pending SSE", () => {
    const { c, frames } = makeController();
    const res = c.onToolResults(
      [
        {
          toolName: "todo_write",
          result: {
            ok: true,
            workflowTitle: "Outreach",
            steps: [{ id: "p1", title: "Send DM", requiresApproval: true, state: "in_progress" }],
          },
        },
      ],
      { turnId: "t1", isCronTurn: true },
    );
    assert.equal(res.abort, false, "Auto mode does not abort");
    assert.equal(c.getState().awaitingApprovalStepId, null, "no awaiting approval");
    assert.equal(c.getState().current?.approvalMode, "auto", "approvalMode auto (cron turn)");
    assert.ok(!frames.some((f) => f.type === "workflow-approval-pending"), "NO workflow-approval-pending SSE");
  });
});

// ─── T-Coexist.1 (R-7) — suggest_card + todo_write same onToolResults ───────

describe("controller.onToolResults — coexists with suggest_card in the same step (R-7) (G-PY1.7)", () => {
  it("T-Coexist.1: given onToolResults with BOTH a suggest_card result AND a todo_write result, WHEN it runs, THEN the controller processes todo_write (workflow-proposed frame) + ignores the suggest_card entry without error (sequential coexistence — serve.ts handles suggest_card separately)", () => {
    const { c, frames } = makeController();
    let threw = false;
    try {
      c.onToolResults(
        [
          { toolName: "suggest_card", result: { ok: true, title: "X" } },
          {
            toolName: "todo_write",
            result: { ok: true, workflowTitle: "W", steps: [{ id: "p1", title: "A", requiresApproval: false }] },
          },
        ],
        { turnId: "t1", isCronTurn: false },
      );
    } catch {
      threw = true;
    }
    assert.ok(!threw, "controller must not throw on the non-workflow suggest_card entry");
    assert.ok(
      frames.some((f) => f.type === "workflow-proposed"),
      "todo_write still processed → workflow-proposed emitted",
    );
    assert.ok(c.getState().current, "workflow created despite the coexisting suggest_card result");
  });
});

// ─── T-Advisory.1 (D-7) — commit-warning SSE + audit row ────────────────────

describe("controller.onToolResults — click commit-warning advisory: SSE + audit row (non-blocking) (G-PY1.8)", () => {
  it("T-Advisory.1: given onToolResults([{toolName:'click', result:{targetLabel:'Send'}}], ctx), WHEN the advisory branch runs, THEN BOTH a commit-warning SSE {label:'Send', severity:'low'} AND a commit_warning audit row {detectedLabel:'Send'} are emitted, AND the turn is NOT aborted; a non-committal label emits NEITHER", () => {
    const { c, frames, audits } = makeController();
    const res = c.onToolResults([{ toolName: "click", result: { targetLabel: "Send" } }], {
      turnId: "t1",
      isCronTurn: false,
    });
    assert.equal(res.abort, false, "advisory does not abort");

    const warn = frames.find((f) => f.type === "commit-warning");
    assert.ok(warn, "commit-warning SSE emitted");
    if (warn && warn.type === "commit-warning") {
      assert.equal(warn.label, "Send");
      assert.equal(warn.severity, "low");
    }
    assert.ok(
      audits.some((e) => e.kind === "commit_warning" && e.detectedLabel === "Send"),
      "commit_warning audit row written",
    );

    // A non-committal label → neither.
    const { c: c2, frames: f2, audits: a2 } = makeController();
    c2.onToolResults([{ toolName: "click", result: { targetLabel: "Profile photo" } }], {
      turnId: "t2",
      isCronTurn: false,
    });
    assert.ok(!f2.some((f) => f.type === "commit-warning"), "non-committal label → no commit-warning SSE");
    assert.ok(!a2.some((e) => e.kind === "commit_warning"), "non-committal label → no commit_warning audit");
  });
});

// ─── T-AlwaysAsk.1 (D-3) — telegram_notify/gh_issue always-ask (Manual only) ─

describe("controller.onToolResults — D-3 always-ask whitelist (telegram_notify/gh_issue, Manual only, retroactive) (G-PY1.14)", () => {
  it("T-AlwaysAsk.1: given Manual mode + onToolResults([{toolName:'telegram_notify'/'gh_issue', result:{ok:true}}], {isCronTurn:false}), WHEN the always-ask branch runs, THEN a workflow-approval-pending SSE (stepId 'alwaysask_<tool>') + an always_ask audit {toolName, turnId} are emitted, NO abort; AND Auto mode (isCronTurn:true) emits NO always-ask", () => {
    for (const toolName of ["telegram_notify", "gh_issue"] as const) {
      // Manual mode → always-ask fires.
      const { c, frames, audits } = makeController();
      const res = c.onToolResults([{ toolName, result: { ok: true } }], { turnId: "t1", isCronTurn: false });
      assert.equal(res.abort, false, `${toolName}: always-ask is retroactive — NO abort`);
      const pending = frames.find((f) => f.type === "workflow-approval-pending");
      assert.ok(pending, `${toolName}: always-ask workflow-approval-pending SSE emitted`);
      if (pending && pending.type === "workflow-approval-pending") {
        assert.equal(pending.stepId, `alwaysask_${toolName}`, `stepId alwaysask_${toolName}`);
      }
      const audit = audits.find((e) => e.kind === "always_ask");
      assert.ok(audit, `${toolName}: always_ask audit row`);
      if (audit && audit.kind === "always_ask") {
        assert.equal(audit.toolName, toolName);
        assert.equal(audit.turnId, "t1");
      }

      // Auto mode (isCronTurn:true) → NO always-ask.
      const { c: cAuto, frames: fAuto, audits: aAuto } = makeController();
      cAuto.onToolResults([{ toolName, result: { ok: true } }], { turnId: "t2", isCronTurn: true });
      assert.ok(
        !fAuto.some((f) => f.type === "workflow-approval-pending"),
        `${toolName}: Auto mode → NO always-ask SSE`,
      );
      assert.ok(!aAuto.some((e) => e.kind === "always_ask"), `${toolName}: Auto mode → NO always_ask audit`);
    }
  });
});
