/**
 * P-Y2.2b Step 5 — T-Snapshot.1..9 + T-Push.1..3 — FILLED.
 *
 * F7 live workflow drive (plan §6.4-A): the PURE `toOverlayWorkflowSnapshot(state, frame) → WorkflowLike|null`
 * mapper (frame-aware notice/pendingStepId, VERBATIM-desktop strings vs app.ts L509/516/524/536, null on
 * completed/no-workflow, deterministic) + the thin `pushWorkflowToOverlay` (pushes `__frondoseShowWorkflow` via
 * `callInOverlay` when an overlay context exists; no-op headless; null → `"null"` hide signal).
 *
 * `callInOverlay` is spied via `mock.module("…/overlay/inject.js")` BEFORE the dynamic import of
 * workflowOverlay.js (serve-p57f pattern); the module is imported in before().
 *
 * Gate coverage: G-PY2.2b.1 (mapper), G-PY2.2b.2 (push), G-PY2.2b.3 (null-tolerance), G-PY2.2b.6 (handoff/approvalMode).
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit --test-timeout=30000 \
 *   tests/cli/subcommands/serve-workflowOverlay-pY2.2b.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// WorkflowState fixture (plan §5.1): a Manual workflow, 1 completed + 1 in_progress(requiresApproval) step.
function makeWfState(overrides: Record<string, unknown> = {}) {
  return {
    current: {
      id: "wf1",
      title: "Bulk outreach",
      approvalMode: "manual",
      steps: [
        { id: "s1", title: "A", state: "completed", requiresApproval: false },
        { id: "s2", title: "B", state: "in_progress", requiresApproval: true },
      ],
      state: "active",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
    awaitingApprovalStepId: null,
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: dynamically imported fns (workflowOverlay.ts).
let toOverlayWorkflowSnapshot: ((s: any, frame: any) => any) | undefined;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import.
let pushWorkflowToOverlay: ((state: any, deps: any, workflow: any, frame: any) => void) | undefined;
let callInOverlayCalls: Array<[unknown, number, string]> = [];

before(async () => {
  const injectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      OVERLAY_BOOTSTRAP_JS: "",
      installOverlay: async () => "id",
      subscribeContextId: async () => () => undefined,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      callInOverlay: async (handle: any, ctxId: number, fn: string) => {
        callInOverlayCalls.push([handle, ctxId, fn]);
      },
    },
  });
  const mod = await import("../../../src/cli/subcommands/serve/workflowOverlay.js");
  toOverlayWorkflowSnapshot = (mod as { toOverlayWorkflowSnapshot?: typeof toOverlayWorkflowSnapshot })
    .toOverlayWorkflowSnapshot;
  pushWorkflowToOverlay = (mod as { pushWorkflowToOverlay?: typeof pushWorkflowToOverlay }).pushWorkflowToOverlay;
});

// Extract the snapshot object embedded in a callInOverlay fn string (double-encoded, mirrors __frondoseShowCard).
function snapshotFromPushFn(fn: string): unknown {
  const m = /__frondoseShowWorkflow\((".*")\); }/.exec(fn);
  assert.ok(m?.[1], `push fn must embed __frondoseShowWorkflow("<json>"); got ${fn.slice(0, 120)}`);
  return JSON.parse(JSON.parse(m[1]) as string); // outer literal → inner json string → object
}

// ─── 5.1 Pure mapper (T-Snapshot.1-9) ────────────────────────────────────────

describe("toOverlayWorkflowSnapshot — workflow-proposed (G-PY2.2b.1)", () => {
  // Given: WF_STATE. When: {type:"workflow-proposed"}. Then: notice "", pendingStepId null, steps mapped ×2.
  it("T-Snapshot.1: workflow-proposed → notice empty, pendingStepId null, steps mapped to {id,title,requiresApproval,state}×2", () => {
    assert.ok(toOverlayWorkflowSnapshot, "builder 4b must export toOverlayWorkflowSnapshot");
    const r = toOverlayWorkflowSnapshot(makeWfState(), {
      type: "workflow-proposed",
      workflowId: "wf1",
      title: "Bulk outreach",
      approvalMode: "manual",
      stepCount: 2,
      ts: 0,
    });
    assert.equal(r.workflowId, "wf1");
    assert.equal(r.title, "Bulk outreach");
    assert.equal(r.approvalMode, "manual");
    assert.equal(r.notice, "");
    assert.equal(r.pendingStepId, null);
    assert.deepEqual(r.steps, [
      { id: "s1", title: "A", requiresApproval: false, state: "completed" },
      { id: "s2", title: "B", requiresApproval: true, state: "in_progress" },
    ]);
  });
});

describe("toOverlayWorkflowSnapshot — workflow-approval-pending (G-PY2.2b.1)", () => {
  // Given: WF_STATE awaitingApprovalStepId="s2". When: approval-pending {stepId:"s2"}.
  // Then: pendingStepId "s2" + verbatim app.ts:509 notice.
  it("T-Snapshot.2: workflow-approval-pending → pendingStepId=frame.stepId + 'Approval required before outbound action.'", () => {
    const r = toOverlayWorkflowSnapshot?.(makeWfState({ awaitingApprovalStepId: "s2" }), {
      type: "workflow-approval-pending",
      workflowId: "wf1",
      stepId: "s2",
      stepTitle: "B",
      ts: 0,
    });
    assert.equal(r.pendingStepId, "s2");
    assert.equal(r.notice, "Approval required before outbound action.");
  });
});

describe("toOverlayWorkflowSnapshot — workflow-approval-resolved approved (G-PY2.2b.1)", () => {
  it("T-Snapshot.3: workflow-approval-resolved approved → pendingStepId null + 'Approved. Resuming workflow.'", () => {
    const r = toOverlayWorkflowSnapshot?.(makeWfState({ awaitingApprovalStepId: "s2" }), {
      type: "workflow-approval-resolved",
      workflowId: "wf1",
      stepId: "s2",
      decision: "approved",
      ts: 0,
    });
    assert.equal(r.pendingStepId, null);
    assert.equal(r.notice, "Approved. Resuming workflow.");
  });
});

describe("toOverlayWorkflowSnapshot — workflow-approval-resolved declined (G-PY2.2b.1)", () => {
  it("T-Snapshot.4: workflow-approval-resolved declined → 'Declined.' + pendingStepId null", () => {
    const r = toOverlayWorkflowSnapshot?.(makeWfState(), {
      type: "workflow-approval-resolved",
      workflowId: "wf1",
      stepId: "s2",
      decision: "declined",
      ts: 0,
    });
    assert.equal(r.notice, "Declined.");
    assert.equal(r.pendingStepId, null);
  });
});

describe("toOverlayWorkflowSnapshot — workflow-mode-changed (G-PY2.2b.1, .6)", () => {
  it("T-Snapshot.5: workflow-mode-changed → 'Auto mode enabled.' + approvalMode 'auto' (hides handoff)", () => {
    const st = makeWfState();
    (st.current as { approvalMode: string }).approvalMode = "auto";
    const r = toOverlayWorkflowSnapshot?.(st, {
      type: "workflow-mode-changed",
      workflowId: "wf1",
      approvalMode: "auto",
      ts: 0,
    });
    assert.equal(r.notice, "Auto mode enabled.");
    assert.equal(r.pendingStepId, null);
    assert.equal(r.approvalMode, "auto");
  });
});

describe("toOverlayWorkflowSnapshot — commit-warning (G-PY2.2b.1)", () => {
  it("T-Snapshot.6: commit-warning → 'Advisory: possible outbound click (Send).'", () => {
    const r = toOverlayWorkflowSnapshot?.(makeWfState(), {
      type: "commit-warning",
      workflowId: "wf1",
      label: "Send",
      severity: "low",
      ts: 0,
    });
    assert.equal(r.notice, "Advisory: possible outbound click (Send).");
  });
});

describe("toOverlayWorkflowSnapshot — workflow-completed → null (G-PY2.2b.1, .3)", () => {
  it("T-Snapshot.7: workflow-completed → null regardless of state", () => {
    assert.equal(
      toOverlayWorkflowSnapshot?.(makeWfState(), {
        type: "workflow-completed",
        workflowId: "wf1",
        finalState: "completed",
        ts: 0,
      }),
      null,
    );
  });
});

describe("toOverlayWorkflowSnapshot — no current workflow → null (G-PY2.2b.1, .3)", () => {
  it("T-Snapshot.8: no current workflow → null", () => {
    assert.equal(
      toOverlayWorkflowSnapshot?.(
        { current: null, awaitingApprovalStepId: null },
        { type: "commit-warning", workflowId: null, label: "X", severity: "low", ts: 0 },
      ),
      null,
    );
  });
});

describe("toOverlayWorkflowSnapshot — deterministic/pure (G-PY2.2b.1)", () => {
  it("T-Snapshot.9: deterministic — two calls deep-equal", () => {
    const f = { type: "workflow-approval-pending", workflowId: "wf1", stepId: "s2", stepTitle: "B", ts: 0 };
    assert.deepEqual(
      toOverlayWorkflowSnapshot?.(makeWfState({ awaitingApprovalStepId: "s2" }), f),
      toOverlayWorkflowSnapshot?.(makeWfState({ awaitingApprovalStepId: "s2" }), f),
    );
  });
});

// ─── 5.2 Push (T-Push.1-3) ───────────────────────────────────────────────────

describe("pushWorkflowToOverlay — pushes __frondoseShowWorkflow when an overlay context exists (G-PY2.2b.2)", () => {
  it("T-Push.1: with overlayContextId + a client, pushes callInOverlay(handle, 7, fn) embedding the mapped snapshot", () => {
    assert.ok(pushWorkflowToOverlay, "builder 4b must export pushWorkflowToOverlay");
    callInOverlayCalls = [];
    const handle = { h: 1 };
    const session = { getClient: () => ({ handle }) };
    const workflow = { getState: () => makeWfState({ awaitingApprovalStepId: "s2" }) };
    pushWorkflowToOverlay({ overlayContextId: 7 }, session, workflow, {
      type: "workflow-approval-pending",
      workflowId: "wf1",
      stepId: "s2",
      stepTitle: "B",
      ts: 0,
    });
    assert.equal(callInOverlayCalls.length, 1, "callInOverlay must be called once");
    assert.equal(callInOverlayCalls[0]?.[0], handle, "handle threaded through");
    assert.equal(callInOverlayCalls[0]?.[1], 7, "overlayContextId threaded through");
    const fn = callInOverlayCalls[0]?.[2] ?? "";
    assert.ok(fn.includes("window.__frondoseShowWorkflow("), "fn calls __frondoseShowWorkflow");
    const snap = snapshotFromPushFn(fn) as { notice: string; pendingStepId: string };
    assert.equal(
      snap.notice,
      "Approval required before outbound action.",
      "embedded snapshot is the mapped WorkflowLike",
    );
    assert.equal(snap.pendingStepId, "s2");
  });
});

describe("pushWorkflowToOverlay — no-op headless (no overlay context) (G-PY2.2b.2)", () => {
  it("T-Push.2: with overlayContextId undefined, callInOverlay is NOT called (headless no-op guard)", () => {
    callInOverlayCalls = [];
    pushWorkflowToOverlay?.(
      { overlayContextId: undefined },
      { getClient: () => ({ handle: {} }) },
      { getState: () => makeWfState() },
      { type: "workflow-proposed", workflowId: "wf1", title: "X", approvalMode: "manual", stepCount: 2, ts: 0 },
    );
    assert.equal(callInOverlayCalls.length, 0);
  });
});

describe('pushWorkflowToOverlay — null snapshot pushes __frondoseShowWorkflow("null") (G-PY2.2b.2, .3)', () => {
  it('T-Push.3: a null snapshot (workflow-completed) pushes __frondoseShowWorkflow("null") (the hide signal)', () => {
    callInOverlayCalls = [];
    pushWorkflowToOverlay?.(
      { overlayContextId: 7 },
      { getClient: () => ({ handle: {} }) },
      { getState: () => makeWfState() },
      { type: "workflow-completed", workflowId: "wf1", finalState: "completed", ts: 0 },
    );
    assert.equal(callInOverlayCalls.length, 1);
    assert.ok(
      (callInOverlayCalls[0]?.[2] ?? "").includes('window.__frondoseShowWorkflow("null")'),
      'null snapshot → __frondoseShowWorkflow("null")',
    );
  });
});
