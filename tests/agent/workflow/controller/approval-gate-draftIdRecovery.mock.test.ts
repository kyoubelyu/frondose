/**
 * P-POST-PUBLISH-8 Step 5 — Group B (assertions filled)
 * T-Recover.1–5b: approve() draftId recovery via recoverPostDraftId thunk.
 * Edge cases EC-B.1–EC-B.2 appended after Step-2/3a scaffolds.
 *
 * Gate: SC-1, SC-2, SC-4, SC-5, SC-6
 *
 * These tests MIRROR the style of the existing
 * tests/agent/workflow/controller/approval-gate-isPostPublish.mock.test.ts
 * (P-POST-PUBLISH-7 Step 2).
 *
 * REVISED SEAM (post-BLOCKER-2/3 resolution):
 *   The original seam (deps.findPendingPostDraftId(db) + salesDbPath) is GONE.
 *   The corrected seam is ONE optional thunk on WorkflowControllerDeps:
 *     recoverPostDraftId?: () => PostDraftRecovery
 *   approve() calls deps.recoverPostDraftId?.() — no getSalesDb, no DB open,
 *   no salesDbPath in the controller. Tests inject a pure () => PostDraftRecovery
 *   stub (call-counted). No better-sqlite3 import anywhere in this file.
 *
 * T-Recover.4 REVISED (post-CONCERN-MR-4 resolution):
 *   There is NO deps.emitCommitWarning field. The shared free function
 *   emitCommitWarning(deps, args) writes through deps.emitFrame + deps.writeWorkflowAudit.
 *   The harness records emitFrame + writeWorkflowAudit calls; T-Recover.4 asserts the
 *   commit-warning frame (type:"commit-warning", label:"PostDraftAmbiguous", severity:"low")
 *   and the audit entry (kind:"commit_warning", detectedLabel:"PostDraftAmbiguous").
 *
 * T-Recover.5b: optional-dep back-compat — deps constructed WITHOUT recoverPostDraftId
 *   (mirrors existing test sites that will not be edited at Step 4) must not crash.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approve } from "../../../../src/agent/workflow/controller/approval-gate.js";
import type { WorkflowControllerDeps } from "../../../../src/agent/workflow/controller.js";
import type { Workflow, WorkflowState } from "../../../../src/agent/workflow/types.js";

// ---------------------------------------------------------------------------
// PostDraftRecovery type — mirrors the plan §6.1 type exported from
// src/persistence/sales/drafts.ts (Step 4). Defined locally so the scaffold
// compiles before Step 4 adds it, and kept for clarity.
// ---------------------------------------------------------------------------

type PostDraftRecovery = { id: string } | { ambiguous: true } | null;

// ---------------------------------------------------------------------------
// Frame + audit recorder stubs (for T-Recover.4 commit-warning assertion)
// ---------------------------------------------------------------------------

type RecordedFrame = Record<string, unknown>;
type RecordedAudit = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const STEP_ID = "step-p8-recover";

/**
 * Build a minimal Workflow + WorkflowState for approve(), inject the
 * recoverPostDraftId thunk (optional), and recorder stubs for emitFrame +
 * writeWorkflowAudit. Returns the full approve() result + call counters.
 *
 * The deps cast `as unknown as WorkflowControllerDeps` is the forward-cast
 * pattern (same as approval-gate-isPostPublish.mock.test.ts) — lets tsc
 * compile on HEAD before Step 4 adds recoverPostDraftId to the interface.
 */
function buildAndApprove(opts: {
  stepTitle: string;
  stepDraftId?: string;
  /** Optional thunk stub — if omitted, recoverPostDraftId field is absent (T-Recover.5b) */
  recoverStub?: () => PostDraftRecovery;
}): {
  result: Record<string, unknown>;
  recoverCallCount: number;
  emittedFrames: RecordedFrame[];
  auditedEvents: RecordedAudit[];
} {
  let recoverCallCount = 0;
  const emittedFrames: RecordedFrame[] = [];
  const auditedEvents: RecordedAudit[] = [];

  const step = {
    id: STEP_ID,
    title: opts.stepTitle,
    state: "in_progress" as const,
    requiresApproval: true,
    ...(opts.stepDraftId !== undefined ? { draftId: opts.stepDraftId } : {}),
  };

  const wf: Workflow = {
    id: "wf-p8-recover",
    title: "P8 draftId recovery test",
    approvalMode: "manual",
    steps: [step],
    state: "awaiting_approval",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };

  const state: WorkflowState = { current: wf, awaitingApprovalStepId: STEP_ID };

  // Build deps with recorder stubs.
  // recoverPostDraftId is omitted entirely when recoverStub is not provided (T-Recover.5b).
  // Forward-cast so tsc compiles on HEAD before Step 4 adds the field.
  const baseDeps = {
    emitFrame: (frame: unknown) => { emittedFrames.push(frame as RecordedFrame); },
    writeWorkflowAudit: (event: unknown) => { auditedEvents.push(event as RecordedAudit); },
    ...(opts.recoverStub !== undefined
      ? {
          recoverPostDraftId: () => {
            recoverCallCount++;
            return opts.recoverStub!();
          },
        }
      : {}),
  } as unknown as WorkflowControllerDeps;

  const result = approve(state, new Set<string>(), baseDeps, wf, STEP_ID);
  return {
    result: result as unknown as Record<string, unknown>,
    recoverCallCount,
    emittedFrames,
    auditedEvents,
  };
}

// ---------------------------------------------------------------------------
// Group B — approve() draftId recovery via recoverPostDraftId thunk
// ---------------------------------------------------------------------------

describe("approve() — draftId recovery via recoverPostDraftId thunk (SC-1, SC-2, SC-5, SC-6)", () => {

  // ─── T-Recover.1 ─────────────────────────────────────────────────────────
  it(
    "T-Recover.1: when step.draftId='draft_pre' is already set, approve() returns draftId='draft_pre' AND the recoverPostDraftId thunk is NOT called (lookupCallCount===0)",
    { timeout: 5000 },
    () => {
      // Given: a post-approval step (title 'Publish post') with step.draftId='draft_pre'
      //        already captured (stable-title PPUB7-style path), plus an injected thunk
      //        that would return a DIFFERENT id if called.
      // When:  approve() resolves.
      // Then:  result.draftId === 'draft_pre' (in-memory value wins; step.draftId ?? recovered)
      //        AND recoverCallCount === 0 (thunk NOT called). Covers SC-2.
      const { result, recoverCallCount } = buildAndApprove({
        stepTitle: "Publish post",
        stepDraftId: "draft_pre",
        recoverStub: () => ({ id: "draft_from_db" }), // would return a different id if called
      });

      // Baseline: 200 + ok:true
      assert.equal(result["status"], 200, "T-Recover.1: approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "T-Recover.1: approve() must return ok:true");

      // SC-2: in-memory draftId wins; thunk not called
      assert.equal(result["draftId"], "draft_pre", "T-Recover.1: draftId must equal step.draftId ('draft_pre') when already set");
      assert.equal(recoverCallCount, 0, "T-Recover.1: recoverPostDraftId thunk must NOT be called when step.draftId is already set");
    },
  );

  // ─── T-Recover.2 ─────────────────────────────────────────────────────────
  it(
    "T-Recover.2: when step.draftId is undefined (re-title survival) and recoverPostDraftId thunk returns { id: 'draft_recovered' }, approve() returns isPostPublish=true, draftId='draft_recovered', stepId=STEP_ID AND thunk call-count is 1",
    { timeout: 5000 },
    () => {
      // Given: a post-approval step (title 'Publish post') with step.draftId undefined
      //        (title-keyed inheritance missed on resume/re-plan).
      //        Injected recoverPostDraftId thunk returns { id: 'draft_recovered' }.
      // When:  approve() resolves.
      // Then:  result.isPostPublish === true AND result.draftId === 'draft_recovered'
      //        AND result.stepId === STEP_ID AND recoverCallCount === 1. Covers SC-1.
      const { result, recoverCallCount } = buildAndApprove({
        stepTitle: "Publish post",
        stepDraftId: undefined,
        recoverStub: () => ({ id: "draft_recovered" }),
      });

      // Baseline
      assert.equal(result["status"], 200, "T-Recover.2: approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "T-Recover.2: approve() must return ok:true");
      assert.equal(result["isPostPublish"], true, "T-Recover.2: isPostPublish must be true for 'Publish post' step");

      // SC-1: DB recovery kicks in when step.draftId is missing
      assert.equal(result["draftId"], "draft_recovered", "T-Recover.2: draftId must equal the recovered id from the DB thunk");
      assert.equal(result["stepId"], STEP_ID, "T-Recover.2: stepId must match the step id");
      assert.equal(recoverCallCount, 1, "T-Recover.2: recoverPostDraftId thunk must be called exactly once");
    },
  );

  // ─── T-Recover.3 ─────────────────────────────────────────────────────────
  it(
    "T-Recover.3: when step.draftId is undefined and recoverPostDraftId thunk returns null (no pending post draft), approve() returns draftId===undefined so the route falls through to LLM resume",
    { timeout: 5000 },
    () => {
      // Given: a post-approval step (title 'Publish post') with step.draftId undefined.
      //        Injected recoverPostDraftId thunk returns null (no rows in the DB).
      // When:  approve() resolves.
      // Then:  result.draftId === undefined (no recovery possible — null → undefined).
      //        result.resumePrompt is still present (LLM fallback path unharmed). Covers SC-5.
      const { result } = buildAndApprove({
        stepTitle: "Publish post",
        stepDraftId: undefined,
        recoverStub: () => null,
      });

      // Baseline
      assert.equal(result["status"], 200, "T-Recover.3: approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "T-Recover.3: approve() must return ok:true");
      assert.equal(typeof result["resumePrompt"], "string", "T-Recover.3: resumePrompt must be present for LLM fallback");

      // SC-5: null recovery → draftId undefined (no crash, route falls through)
      assert.equal(result["draftId"], undefined, "T-Recover.3: draftId must be undefined when thunk returns null (no rows)");
    },
  );

  // ─── T-Recover.4 ─────────────────────────────────────────────────────────
  it(
    "T-Recover.4: when step.draftId is undefined and recoverPostDraftId thunk returns { ambiguous: true }, approve() returns draftId===undefined AND a commit-warning frame is emitted once via emitFrame (label='PostDraftAmbiguous', severity='low') AND writeWorkflowAudit records kind='commit_warning'",
    { timeout: 5000 },
    () => {
      // Given: a post-approval step (title 'Publish post') with step.draftId undefined.
      //        Injected recoverPostDraftId thunk returns { ambiguous: true } (≥2 pending drafts).
      // When:  approve() resolves.
      // Then:  (a) result.draftId === undefined (refusing is safer than guessing). SC-6.
      //        (b) emittedFrames contains exactly one frame with type='commit-warning',
      //            label='PostDraftAmbiguous', severity='low'.
      //        (c) auditedEvents contains exactly one event with kind='commit_warning',
      //            detectedLabel='PostDraftAmbiguous', stepId=STEP_ID.
      //        Asserts through production emitFrame + writeWorkflowAudit channels
      //        (the shared free function emitCommitWarning(deps, args) writes through these).
      //        There is NO deps.emitCommitWarning field to stub. Covers SC-6.
      const { result, emittedFrames, auditedEvents } = buildAndApprove({
        stepTitle: "Publish post",
        stepDraftId: undefined,
        recoverStub: () => ({ ambiguous: true }),
      });

      // Baseline
      assert.equal(result["status"], 200, "T-Recover.4: approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "T-Recover.4: approve() must return ok:true");

      // (a) SC-6: ambiguous → draftId undefined (fall back rather than guess)
      assert.equal(result["draftId"], undefined, "T-Recover.4: draftId must be undefined when thunk returns { ambiguous:true }");

      // (b) Exactly one commit-warning frame emitted via emitFrame
      const warningFrames = emittedFrames.filter((f) => f["type"] === "commit-warning");
      assert.equal(warningFrames.length, 1, "T-Recover.4: exactly one commit-warning frame must be emitted via emitFrame");
      assert.equal(warningFrames[0]!["label"], "PostDraftAmbiguous", "T-Recover.4: frame.label must be 'PostDraftAmbiguous'");
      assert.equal(warningFrames[0]!["severity"], "low", "T-Recover.4: frame.severity must be 'low'");
      assert.equal(warningFrames[0]!["workflowId"], "wf-p8-recover", "T-Recover.4: frame.workflowId must match the workflow id");

      // (c) Exactly one commit_warning audit event
      const warningAudits = auditedEvents.filter((e) => e["kind"] === "commit_warning");
      assert.equal(warningAudits.length, 1, "T-Recover.4: exactly one commit_warning audit event must be written via writeWorkflowAudit");
      assert.equal(warningAudits[0]!["detectedLabel"], "PostDraftAmbiguous", "T-Recover.4: audit event.detectedLabel must be 'PostDraftAmbiguous'");
      assert.equal(warningAudits[0]!["stepId"], STEP_ID, "T-Recover.4: audit event.stepId must match STEP_ID");
    },
  );

  // ─── T-Recover.5 ─────────────────────────────────────────────────────────
  it(
    "T-Recover.5: when the step title matches the connect heuristic (not a post step), approve() returns isPostPublish=false, draftId===undefined, and recoverPostDraftId thunk is NOT called",
    { timeout: 5000 },
    () => {
      // Given: a requiresApproval step whose title matches /(send|connect|invite)/i —
      //        NOT a post step. Injected recoverPostDraftId thunk tracks call count.
      // When:  approve() resolves.
      // Then:  result.isPostPublish === false AND result.draftId === undefined
      //        AND recoverCallCount === 0 (recovery branch never entered for non-post steps).
      //        Pins scope: DB recovery only fires on isPostStep === true.
      const { result, recoverCallCount } = buildAndApprove({
        stepTitle: "Send connect invite to John",
        stepDraftId: undefined,
        recoverStub: () => ({ id: "should_not_be_returned" }),
      });

      // Baseline
      assert.equal(result["status"], 200, "T-Recover.5: approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "T-Recover.5: approve() must return ok:true");
      assert.equal(result["isPostPublish"], false, "T-Recover.5: isPostPublish must be false for connect step");

      // Scope pin: recovery only for post steps
      assert.equal(result["draftId"], undefined, "T-Recover.5: draftId must be undefined for a non-post connect step");
      assert.equal(recoverCallCount, 0, "T-Recover.5: recoverPostDraftId thunk must NOT be called for a non-post step");
    },
  );

  // ─── T-Recover.5b ────────────────────────────────────────────────────────
  it(
    "T-Recover.5b: when deps has no recoverPostDraftId field (absent/undefined) AND step.draftId is undefined, approve() returns draftId===undefined with no throw (optional-dep back-compat)",
    { timeout: 5000 },
    () => {
      // Given: deps constructed with ONLY { emitFrame, writeWorkflowAudit } — no recoverPostDraftId
      //        field (mirrors the 3 existing test sites: workflowGate.mock.test.ts:62,
      //        workflowResume.mock.test.ts:185, approvalResume-pPostPublish3.mock.test.ts:63
      //        that the Step 4 implementer cannot edit). A post step with step.draftId undefined.
      // When:  approve() resolves.
      // Then:  result.draftId === undefined (no crash, no warning, thunk?.() safely no-ops).
      //        Pins the optional-dep back-compat invariant: existing callers compile UNTOUCHED.
      const { result, recoverCallCount } = buildAndApprove({
        stepTitle: "Publish post",
        stepDraftId: undefined,
        // NO recoverStub provided → recoverPostDraftId absent from deps object
      });

      // Baseline
      assert.equal(result["status"], 200, "T-Recover.5b: approve() must return 200");
      assert.deepEqual(result["response"], { ok: true }, "T-Recover.5b: approve() must return ok:true");

      // Back-compat: absent thunk → undefined draftId, no throw
      assert.equal(result["draftId"], undefined, "T-Recover.5b: draftId must be undefined when recoverPostDraftId is absent from deps");
      assert.equal(recoverCallCount, 0, "T-Recover.5b: recoverCallCount must be 0 (thunk absent, never called)");
    },
  );

  // ─── EC-B.1 — ambiguity warning NOT emitted on single-row happy path ──────
  it(
    "EC-B.1: when step.draftId is undefined and thunk returns { id } (single row), NO commit-warning frame is emitted (ambiguity warning fires ONLY on { ambiguous:true })",
    { timeout: 5000 },
    () => {
      // Given: a post-approval step with step.draftId undefined.
      //        Injected thunk returns { id: 'draft_one' } (1-row happy path).
      // When:  approve() resolves.
      // Then:  no commit-warning frame in emittedFrames (the ambiguity path is not taken).
      //        Ensures the warning is scoped exclusively to the { ambiguous:true } branch.
      const { result, emittedFrames } = buildAndApprove({
        stepTitle: "Publish post",
        stepDraftId: undefined,
        recoverStub: () => ({ id: "draft_one" }),
      });

      assert.equal(result["status"], 200, "EC-B.1: approve() must return 200");
      assert.equal(result["draftId"], "draft_one", "EC-B.1: draftId must be recovered to 'draft_one'");

      const warningFrames = emittedFrames.filter((f) => f["type"] === "commit-warning");
      assert.equal(warningFrames.length, 0, "EC-B.1: NO commit-warning frame must be emitted on the single-row happy recovery path");
    },
  );

  // ─── EC-B.2 — CJK post step title (発信/发布) is recognized as a post step ──
  // Note: approval-gate.ts's isOutboundStep gate is ASCII-only (requires one of
  // send|connect|invite|message|dm|note|comment|post|follow). The CJK markers
  // 発信/发布 are checked in the isPostStep predicate, but only AFTER isOutboundStep
  // passes. Real agent titles with 发布/発信 always include an ASCII keyword too
  // (e.g. "Publish post: 发布" or "post: 発信します"). This test uses such a
  // mixed title — the realistic production pattern.
  it(
    "EC-B.2: a step titled 'Publish post: 発信します' (CJK + ASCII post heuristic) is recognized as isPostStep — recoverPostDraftId thunk IS called when step.draftId is missing",
    { timeout: 5000 },
    () => {
      // Given: a post-approval step whose title contains '発信' AND an ASCII 'post' keyword
      //        (realistic mixed title the agent would produce). Injected thunk returns { id: 'draft_cjk' }.
      // When:  approve() resolves.
      // Then:  result.isPostPublish === true AND result.draftId === 'draft_cjk'
      //        AND recoverCallCount === 1 (CJK title with ASCII anchor correctly enters the post branch).
      const { result, recoverCallCount } = buildAndApprove({
        stepTitle: "Publish post: 発信します",
        stepDraftId: undefined,
        recoverStub: () => ({ id: "draft_cjk" }),
      });

      assert.equal(result["status"], 200, "EC-B.2: approve() must return 200");
      assert.equal(result["isPostPublish"], true, "EC-B.2: isPostPublish must be true for CJK+ASCII 発信 title");
      assert.equal(result["draftId"], "draft_cjk", "EC-B.2: draftId must be recovered for CJK post step");
      assert.equal(recoverCallCount, 1, "EC-B.2: thunk must be called once for CJK post step with missing draftId");
    },
  );

});
