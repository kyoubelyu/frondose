/**
 * P-59 Track A Step 4a — T-Resume.2, T-Frame.1, T-Frame.2 — SCAFFOLD
 * (assertion bodies are REAL + intentionally RED; all FAIL pre-builder)
 *
 * Tests the `approve()` / `decline()` contract in `src/agent/workflow/controller.ts`:
 *
 * T-Resume.2 (mock — FIX-1 resumePrompt). `approve()` for a valid pending step returns
 *   `resumePrompt` containing ALL of: "WORKFLOW RESUME", "Do not start this resume turn
 *   with search_memory or a new todo_write plan", "Continue from the existing in_progress
 *   step", "update the existing workflow state", the step title, and wf.title; AND return
 *   keys are exactly { status, response, resumePrompt } (shape unchanged).
 *   → currently FAILS: resumePrompt = `'Approved: proceed with the step "…".'` (L257)
 *
 * T-Frame.1 (mock — FIX-3). `approve()` AND `decline()` each emit
 *   `workflow-approval-resolved` with `turnId === undefined` (field omitted, NOT "").
 *   → currently FAILS: both emit `turnId: ""` (L250, L275)
 *
 * T-Frame.2 (source-structural — FIX-3/F4 type). `WorkflowSseFrame`'s
 *   `workflow-approval-resolved` member declares `turnId?: string` (optional).
 *   → currently FAILS: field is `turnId: string` (required) in types.ts:77
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * Gate/defect coverage:
 *   D-P59-1 (approve re-plans) ↦ T-Resume.2
 *   D-P59-4 (empty turnId sentinel) ↦ T-Frame.1, T-Frame.2
 *   §6.4(A) FIX-1 resumePrompt sketch ↦ T-Resume.2
 *   §6.4(D) FIX-3 types.ts optional turnId ↦ T-Frame.2
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/workflowResume.mock.test.ts
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
const TYPES_TS = readFileSync(join(REPO, "src/agent/workflow/types.ts"), "utf-8");

// ─── Helper: controller with a pending-approval in_progress step ──────────────────────────────────

function makeApproveSetup(stepTitle = "Send connection request") {
  const frames: WorkflowSseFrame[] = [];
  const c = createWorkflowController({
    emitFrame: (f) => frames.push(f),
    writeWorkflowAudit: () => {},
  });
  // Drive reconcileTodoWrite: one in_progress+requiresApproval step → checkApprovalGate fires,
  // sets state.awaitingApprovalStepId, emits workflow-approval-pending.
  c.onToolResults(
    [
      {
        toolName: "todo_write",
        result: {
          ok: true,
          workflowTitle: "Prospect Outreach",
          steps: [{ id: "step_abc", title: stepTitle, requiresApproval: true, state: "in_progress" }],
        },
      },
    ],
    { turnId: "t0", isCronTurn: false },
  );
  return { c, frames, stepId: "step_abc", stepTitle };
}

// ─── T-Resume.2 — approve() resumePrompt contains all required substrings ────────────────────────

describe("controller.approve() — resumePrompt contract (FIX-1 D-P59-1)", () => {
  it('T-Resume.2: when approve(wf, stepId) for a valid pending step, resumePrompt MUST contain: "WORKFLOW RESUME", "Do not start this resume turn with search_memory or a new todo_write plan", "Continue from the existing in_progress step", "update the existing workflow state", the step title, and wf.title; AND return keys are exactly { status, response, resumePrompt } (FIX-1 required — FAILS pre-builder)', () => {
    // Given: controller with a workflow paused at a requiresApproval step ("Send connection request")
    // When:  handleEndpoint("/workflow/approve", { stepId }) is called
    // Then:  result.resumePrompt contains all 6 required substrings; result has exactly 3 keys
    const { c, stepId, stepTitle } = makeApproveSetup();
    const result = c.handleEndpoint("/workflow/approve", { stepId });

    // ── Return shape: must have { status, response, resumePrompt } ───────────────────────────────
    assert.ok("status" in result, "result must have 'status' key");
    assert.ok("response" in result, "result must have 'response' key");
    assert.ok("resumePrompt" in result, "result must have 'resumePrompt' key (approve path must always return one)");
    assert.equal(result.status, 200, "status must be 200");

    const rp = result.resumePrompt ?? "";

    // ── Substring 1: WORKFLOW RESUME marker ──────────────────────────────────────────────────────
    assert.ok(
      rp.includes("WORKFLOW RESUME"),
      `resumePrompt must contain "WORKFLOW RESUME" — ` +
        `signals this is NOT a new task, suppresses task-start ritual. ` +
        `Current (pre-fix): "${rp.slice(0, 80)}…" (FIX-1 required — FAILS pre-builder)`,
    );

    // ── Substring 2: explicit ritual suppression ──────────────────────────────────────────────────
    assert.ok(
      rp.includes("Do not start this resume turn with search_memory or a new todo_write plan"),
      `resumePrompt must contain the explicit ritual-suppression instruction. ` +
        `Current (pre-fix): "${rp.slice(0, 80)}…" (FIX-1 required — FAILS pre-builder)`,
    );

    // ── Substring 3: continue existing step ──────────────────────────────────────────────────────
    assert.ok(
      rp.includes("Continue from the existing in_progress step"),
      `resumePrompt must instruct the agent to continue from the existing in_progress step. ` +
        `Current: "${rp.slice(0, 80)}…" (FIX-1 required — FAILS pre-builder)`,
    );

    // ── Substring 4: permit progress todo_write ([3b] narrowing — workflow model requires it) ─────
    assert.ok(
      rp.includes("update the existing workflow state"),
      `resumePrompt must explicitly permit todo_write progress updates ("update the existing ` +
        `workflow state") per [3b CONCERN-MR-1]. Current: "${rp.slice(0, 80)}…" (FIX-1 required — FAILS pre-builder)`,
    );

    // ── Substring 5: step title ──────────────────────────────────────────────────────────────────
    assert.ok(
      rp.includes(stepTitle),
      `resumePrompt must include the step title "${stepTitle}". ` +
        `Current: "${rp.slice(0, 80)}…" (FIX-1 required — FAILS pre-builder)`,
    );

    // ── Substring 6: workflow title ───────────────────────────────────────────────────────────────
    assert.ok(
      rp.includes("Prospect Outreach"),
      `resumePrompt must include the workflow title "Prospect Outreach". ` +
        `Current: "${rp.slice(0, 80)}…" (FIX-1 required — FAILS pre-builder)`,
    );
  });
});

// ─── T-Frame.1 — approve() + decline() emit turnId === undefined (not "") ────────────────────────

describe("controller.approve() / decline() — workflow-approval-resolved.turnId omitted (FIX-3 D-P59-4)", () => {
  it("T-Frame.1: approve() emits workflow-approval-resolved with turnId === undefined (not ''); decline() emits the same — (FIX-3 required — FAILS pre-builder)", () => {
    // Given: controller with a pending-approval workflow (approve path)
    // When:  approve() fires → emits workflow-approval-resolved
    // Then:  emitted frame's turnId field is undefined (omitted), NOT the "" sentinel
    const { c: ca, frames: fa, stepId: sa } = makeApproveSetup("Send invite A");
    ca.handleEndpoint("/workflow/approve", { stepId: sa });
    const approveResolved = fa.find((f) => f.type === "workflow-approval-resolved");
    assert.ok(approveResolved != null, "workflow-approval-resolved must be emitted by approve()");
    // biome-ignore lint/suspicious/noExplicitAny: runtime guard for optional-field contract (pre-F4 type has string, post-F4 has string|undefined)
    const approveTurnId = (approveResolved as unknown as Record<string, unknown>)["turnId"];
    assert.strictEqual(
      approveTurnId,
      undefined,
      `workflow-approval-resolved.turnId must be undefined (field omitted) on approve(). ` +
        `Current (pre-fix): "${String(approveTurnId)}" — FIX-3 changes this to omit the field. FAILS pre-builder.`,
    );

    // Given: controller with a pending-approval workflow (decline path)
    // When:  decline() fires → emits workflow-approval-resolved
    // Then:  emitted frame's turnId field is undefined (omitted), NOT the "" sentinel
    const { c: cd, frames: fd, stepId: sd } = makeApproveSetup("Send invite B");
    cd.handleEndpoint("/workflow/decline", { stepId: sd });
    const declineResolved = fd.find((f) => f.type === "workflow-approval-resolved");
    assert.ok(declineResolved != null, "workflow-approval-resolved must be emitted by decline()");
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    const declineTurnId = (declineResolved as unknown as Record<string, unknown>)["turnId"];
    assert.strictEqual(
      declineTurnId,
      undefined,
      `workflow-approval-resolved.turnId must be undefined (field omitted) on decline(). ` +
        `Current (pre-fix): "${String(declineTurnId)}" — FIX-3 changes this to omit the field. FAILS pre-builder.`,
    );
  });
});

// ─── T-Resume.5 — monotonic reconcile guard blocks Dn-1 regressions + edge cases ─────────────────

describe("controller.reconcileTodoWrite — monotonic guard blocks regressions, allows advances/new-steps/failed (FIX-1 v2-rev #2 §9.4(f) Dn-1)", () => {
  it("T-Resume.5: given step1=completed + step2=approved in_progress; when onToolResults submits step1=in_progress + step2=pending (Dn-1 exact regression); then step2 stays in_progress AND step1 stays completed AND no regression workflow-step-advanced frames emitted; plus new steps are allowed, advancement is allowed, failed is exempt (V6 required — FAILS pre-builder on Part 1 core)", () => {
    // Given: controller seeded to step1=completed + step2=approved in_progress
    // When:  onToolResults submits the exact Dn-1 regression (step1=in_progress, step2=pending)
    // Then:  both regressions are clamped to prior state; no regression frames emitted;
    //        edge cases — new steps, advancement, failed — are all correctly allowed

    // ── Part 1: core Dn-1 regression (FAILS pre-builder — V6 guard absent) ──────────────────
    {
      const frames: WorkflowSseFrame[] = [];
      const c = createWorkflowController({ emitFrame: (f) => frames.push(f), writeWorkflowAudit: () => {} });

      // Seed: step1=completed + step2=in_progress+requiresApproval
      // → checkApprovalGate fires, sets awaitingApprovalStepId="s2", returns {abort:true}
      c.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "Prospect Outreach",
              steps: [
                { id: "s1", title: "Step 1: research", requiresApproval: false, state: "completed" },
                { id: "s2", title: "Step 2: send connection", requiresApproval: true, state: "in_progress" },
              ],
            },
          },
        ],
        { turnId: "t0", isCronTurn: false },
      );

      // Approve step2 → adds "s2" to approvedStepIds; step2 stays in_progress; awaitingApprovalStepId←null
      const approveResult = c.handleEndpoint("/workflow/approve", { stepId: "s2" });
      assert.equal(
        approveResult.status,
        200,
        `setup: approve must return 200. Got: ${JSON.stringify(approveResult.response)}`,
      );

      const framesBefore = frames.length;

      // Dn-1 regression: fresh-plan todo_write resets step1→in_progress + step2→pending
      // WITHOUT V6: both state regressions happen + both workflow-step-advanced frames emitted
      // WITH V6: both regressions clamped to prior states (completed / in_progress); no frames
      c.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "Prospect Outreach",
              steps: [
                { id: "ns1", title: "Step 1: research", requiresApproval: false, state: "in_progress" },
                { id: "ns2", title: "Step 2: send connection", requiresApproval: true, state: "pending" },
              ],
            },
          },
        ],
        { turnId: "t1", isCronTurn: false },
      );

      // State assertions via getState() — V6 must clamp both regressions
      const stepsAfter = c.getState().current?.steps ?? [];
      const step1After = stepsAfter.find((s) => s.title === "Step 1: research");
      const step2After = stepsAfter.find((s) => s.title === "Step 2: send connection");

      assert.equal(
        step1After?.state,
        "completed",
        `V6 MONOTONIC: step1 completed→in_progress regression must be clamped to "completed". ` +
          `WITHOUT guard: reconcileTodoWrite sets step1.state="in_progress" (audit L11 regression). ` +
          `Got: ${JSON.stringify(step1After)}. FAILS pre-builder.`,
      );
      assert.equal(
        step2After?.state,
        "in_progress",
        `V6 MONOTONIC: step2 in_progress→pending regression (+ unapproval of approved step) ` +
          `must be clamped to "in_progress". ` +
          `WITHOUT guard: reconcileTodoWrite sets step2.state="pending" (audit L10 regression). ` +
          `Got: ${JSON.stringify(step2After)}. FAILS pre-builder.`,
      );

      // Frame assertions — no regression workflow-step-advanced frames emitted
      const newFrames = frames.slice(framesBefore);
      const regressionFrames = newFrames.filter((f) => {
        if (f.type !== "workflow-step-advanced") return false;
        return (f.stepId === "s1" && f.nextState === "in_progress") || (f.stepId === "s2" && f.nextState === "pending");
      });
      assert.equal(
        regressionFrames.length,
        0,
        `V6 guard must suppress both Dn-1 regression workflow-step-advanced frames. ` +
          `WITHOUT guard: 2 frames emitted (step1 completed→in_progress, step2 in_progress→pending). ` +
          `Found: ${JSON.stringify(regressionFrames)}. FAILS pre-builder.`,
      );
    }

    // ── Part 2: new step (no priorStep) IS allowed as pending (PASSES pre-builder) ────────────
    {
      const c2 = createWorkflowController({ emitFrame: () => {}, writeWorkflowAudit: () => {} });
      c2.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "WF",
              steps: [{ id: "e1", title: "Existing step", requiresApproval: false, state: "in_progress" }],
            },
          },
        ],
        { turnId: "t0", isCronTurn: false },
      );
      // Add a brand-new step (title has no prior → guard doesn't apply → allowed pending)
      c2.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "WF",
              steps: [
                { id: "e1", title: "Existing step", requiresApproval: false, state: "in_progress" },
                { id: "n1", title: "New step", requiresApproval: false, state: "pending" },
              ],
            },
          },
        ],
        { turnId: "t1", isCronTurn: false },
      );
      const newStep = c2.getState().current?.steps.find((s) => s.title === "New step");
      assert.equal(
        newStep?.state,
        "pending",
        `New steps (no priorStep) must be ALLOWED as pending — V6 guard must not block them. ` +
          `Found: ${JSON.stringify(newStep)}.`,
      );
    }

    // ── Part 3: same-title advancement (in_progress → completed) IS allowed (PASSES pre-builder) ──
    {
      const c3 = createWorkflowController({ emitFrame: () => {}, writeWorkflowAudit: () => {} });
      c3.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "WF",
              steps: [{ id: "a1", title: "Advance step", requiresApproval: false, state: "in_progress" }],
            },
          },
        ],
        { turnId: "t0", isCronTurn: false },
      );
      // Advance: in_progress → completed (RANK 1 → 2: not a regression → guard allows it)
      c3.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "WF",
              steps: [{ id: "na1", title: "Advance step", requiresApproval: false, state: "completed" }],
            },
          },
        ],
        { turnId: "t1", isCronTurn: false },
      );
      const advancedStep = c3.getState().current?.steps.find((s) => s.title === "Advance step");
      assert.equal(
        advancedStep?.state,
        "completed",
        `Advancement (in_progress → completed) must be ALLOWED by V6 guard. ` +
          `RANK[completed]=2 > RANK[in_progress]=1 — not a regression. ` +
          `Found: ${JSON.stringify(advancedStep)}.`,
      );
    }

    // ── Part 4: failed prior is exempt — failed → pending re-attempt allowed (PASSES pre-builder) ──
    {
      const c4 = createWorkflowController({ emitFrame: () => {}, writeWorkflowAudit: () => {} });
      // Seed: step with requiresApproval so decline() can set step.state = "failed" directly
      c4.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "WF",
              steps: [{ id: "f1", title: "Failed step", requiresApproval: true, state: "in_progress" }],
            },
          },
        ],
        { turnId: "t0", isCronTurn: false },
      );
      // Decline → controller mutates step.state = "failed" + clears awaitingApprovalStepId
      const declineResult = c4.handleEndpoint("/workflow/decline", { stepId: "f1" });
      assert.equal(
        declineResult.status,
        200,
        `setup: decline must return 200. Got: ${JSON.stringify(declineResult.response)}`,
      );

      // Re-plan: failed step re-attempted as pending (post-decline revise)
      // V6 guard condition: priorStep.state !== "failed" → FALSE → guard skipped → allowed
      c4.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "WF",
              steps: [{ id: "rf1", title: "Failed step", requiresApproval: true, state: "pending" }],
            },
          },
        ],
        { turnId: "t1", isCronTurn: false },
      );
      const retriedStep = c4.getState().current?.steps.find((s) => s.title === "Failed step");
      assert.equal(
        retriedStep?.state,
        "pending",
        `failed prior step must be EXEMPT from V6 guard — failed → pending re-attempt allowed ` +
          `(post-decline revise). priorStep.state="failed" → guard condition false → unrestricted. ` +
          `Found: ${JSON.stringify(retriedStep)}.`,
      );
    }
  });
});

// ─── T-Frame.2 — WorkflowSseFrame workflow-approval-resolved.turnId optional ─────────────────────

describe("WorkflowSseFrame — workflow-approval-resolved.turnId is optional (source/compile, FIX-3/F4 D-P59-4)", () => {
  it("T-Frame.2: types.ts workflow-approval-resolved member declares turnId as optional (turnId?: string) — emitting without turnId must typecheck after F4 — (FIX-3/F4 required — FAILS pre-builder)", () => {
    // Given: src/agent/workflow/types.ts source as a string
    // When:  the workflow-approval-resolved union member block is located and inspected
    // Then:  the turnId field is declared with the optional marker (turnId?: string)
    //
    // Source-structural proxy for a compile check: avoids a @ts-expect-error cast at Step 4a;
    // Step 5 fills a direct type-assign assertion once F4 makes turnId optional in types.ts.

    const resolvedIdx = TYPES_TS.indexOf('"workflow-approval-resolved"');
    assert.notEqual(resolvedIdx, -1, "types.ts must contain the workflow-approval-resolved union member discriminant");

    // Extract the block following the discriminant (up to 300 chars to cover the member body)
    const block = TYPES_TS.slice(resolvedIdx, resolvedIdx + 300);

    assert.ok(
      block.includes("turnId?:") || block.includes("turnId?: string"),
      `workflow-approval-resolved.turnId must be optional (turnId?: string). ` +
        `Current block: "${block.replace(/\n/g, " ").slice(0, 140)}" ` +
        `— field is currently required (turnId: string); FIX-3/F4 makes it optional. FAILS pre-builder.`,
    );
  });
});
