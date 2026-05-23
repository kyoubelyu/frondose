/**
 * P-Y2.2b Step 5 — T-Dispatch.1..7 — FILLED.
 *
 * F8 transport routing (plan §6.4-C): the 3 dispatch cases before the emitOverlayEvent fallthrough —
 * workflow-approve/decline/handoff → controller.handleEndpoint + resumeWorkflowTurn; mode → cronEnabled flip
 * + cron-mode frame; abort → abortController.abort(); unknown → emitOverlayEvent.
 *
 * Gate coverage: G-PY2.2b.5 (dispatch routing), G-PY2.2b.6 (handoff distinct), OQ-2.2b.6 (no-resume path).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/cli/subcommands/serve-dispatch-pY2.2b.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOverlayDispatcher } from "../../../src/cli/subcommands/serve/dispatch.js";

type Call = { args: unknown[] };
function spy() {
  const calls: Call[] = [];
  const fn = (...args: unknown[]) => {
    calls.push({ args });
  };
  return Object.assign(fn, { calls });
}

// biome-ignore lint/suspicious/noExplicitAny: minimal mock harness cast to the dispatcher arg types.
function makeHarness(opts: { resumePrompt?: string; cronEnabled?: boolean; hasTurn?: boolean } = {}): any {
  const handleEndpoint = spy();
  const handleEndpointReturning = (...a: unknown[]) => {
    handleEndpoint(...a);
    return { status: 200, response: { ok: true }, resumePrompt: opts.resumePrompt };
  };
  const emitFrame = spy();
  const emitOverlayEvent = spy();
  const resumeWorkflowTurn = spy();
  const abort = spy();
  const state = {
    cronEnabled: opts.cronEnabled ?? false,
    currentTurn: opts.hasTurn === false ? null : { turnId: "x", abortController: { abort } },
    overlayContextId: 7,
  };
  const deps = { workflow: { handleEndpoint: handleEndpointReturning }, emitFrame, emitOverlayEvent };
  const turn = { resumeWorkflowTurn };
  const passive = { handlePassiveProfileNav: spy(), handlePassiveObservation: spy() };
  return {
    state,
    deps,
    turn,
    passive,
    spies: { handleEndpoint, emitFrame, emitOverlayEvent, resumeWorkflowTurn, abort },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: event payload shape varies per case.
function ev(event_type: string, payload: Record<string, unknown> = {}): any {
  return { kind: "overlay-event", event_type, payload: { type: event_type, ...payload }, ts: 0 };
}
// biome-ignore lint/suspicious/noExplicitAny: harness cast
function dispatcher(h: any) {
  return createOverlayDispatcher(h.state, h.deps, h.turn, h.passive);
}

describe("dispatch — workflow-approve → handleEndpoint(/workflow/approve) + resume (G-PY2.2b.5)", () => {
  it("T-Dispatch.1: workflow-approve → handleEndpoint('/workflow/approve', {stepId:'s2', reason:undefined}) + resumeWorkflowTurn('R')", () => {
    const h = makeHarness({ resumePrompt: "R" });
    dispatcher(h).dispatchOverlayEvent(ev("workflow-approve", { workflowId: "wf1", stepId: "s2" }));
    assert.deepEqual(h.spies.handleEndpoint.calls[0].args, ["/workflow/approve", { stepId: "s2", reason: undefined }]);
    assert.equal(h.spies.resumeWorkflowTurn.calls.length, 1);
    assert.equal(h.spies.resumeWorkflowTurn.calls[0].args[0], "R");
  });
});

describe("dispatch — workflow-decline passes reason; resumes (G-PY2.2b.5)", () => {
  it("T-Dispatch.2: workflow-decline → handleEndpoint('/workflow/decline', {stepId:'s2', reason:'operator_declined'}) + resumeWorkflowTurn('D')", () => {
    const h = makeHarness({ resumePrompt: "D" });
    dispatcher(h).dispatchOverlayEvent(
      ev("workflow-decline", { workflowId: "wf1", stepId: "s2", reason: "operator_declined" }),
    );
    assert.deepEqual(h.spies.handleEndpoint.calls[0].args, [
      "/workflow/decline",
      { stepId: "s2", reason: "operator_declined" },
    ]);
    assert.equal(h.spies.resumeWorkflowTurn.calls[0].args[0], "D");
  });
});

describe("dispatch — workflow-handoff → handleEndpoint(/workflow/handoff) + resume (G-PY2.2b.5, .6)", () => {
  it("T-Dispatch.3: workflow-handoff → handleEndpoint('/workflow/handoff', {stepId:undefined, reason:undefined}) + resumeWorkflowTurn('H')", () => {
    const h = makeHarness({ resumePrompt: "H" });
    dispatcher(h).dispatchOverlayEvent(ev("workflow-handoff", { workflowId: "wf1" }));
    assert.deepEqual(h.spies.handleEndpoint.calls[0].args, [
      "/workflow/handoff",
      { stepId: undefined, reason: undefined },
    ]);
    assert.equal(h.spies.resumeWorkflowTurn.calls[0].args[0], "H");
  });
});

describe("dispatch — no resume when handleEndpoint returns no resumePrompt (G-PY2.2b.5; OQ-2.2b.6)", () => {
  it("T-Dispatch.4: no resumePrompt → handleEndpoint called but resumeWorkflowTurn NOT (always_ask advisory no-op)", () => {
    const h = makeHarness({}); // resumePrompt undefined
    dispatcher(h).dispatchOverlayEvent(ev("workflow-approve", { workflowId: "wf1", stepId: "alwaysask_send_message" }));
    assert.equal(h.spies.handleEndpoint.calls.length, 1);
    assert.equal(h.spies.resumeWorkflowTurn.calls.length, 0, "no resumePrompt → no resume (advisory always_ask)");
  });
});

describe("dispatch — mode flips cronEnabled + emits cron-mode (G-PY2.2b.5)", () => {
  it("T-Dispatch.5: mode 'auto' → cronEnabled=true + emitFrame{type:'cron-mode',cronEnabled:true}; later 'manual' → false", () => {
    const h = makeHarness({ cronEnabled: false });
    const d = dispatcher(h);
    d.dispatchOverlayEvent(ev("mode", { mode: "auto" }));
    assert.equal(h.state.cronEnabled, true);
    assert.deepEqual(h.spies.emitFrame.calls[0].args[0], { type: "cron-mode", cronEnabled: true });
    d.dispatchOverlayEvent(ev("mode", { mode: "manual" }));
    assert.equal(h.state.cronEnabled, false);
    assert.deepEqual(h.spies.emitFrame.calls[1].args[0], { type: "cron-mode", cronEnabled: false });
  });
});

describe("dispatch — abort aborts the current turn; no-op when none (G-PY2.2b.5)", () => {
  it("T-Dispatch.6: abort → abortController.abort() once; with currentTurn=null, no throw + nothing called", () => {
    const h = makeHarness({ hasTurn: true });
    dispatcher(h).dispatchOverlayEvent(ev("abort"));
    assert.equal(h.spies.abort.calls.length, 1);
    const h2 = makeHarness({ hasTurn: false });
    assert.doesNotThrow(() => dispatcher(h2).dispatchOverlayEvent(ev("abort")));
    assert.equal(h2.spies.abort.calls.length, 0);
  });
});

describe("dispatch — unknown event falls through to emitOverlayEvent (G-PY2.2b.5)", () => {
  it("T-Dispatch.7: unknown event_type still falls through to deps.emitOverlayEvent(event)", () => {
    const h = makeHarness();
    const e = ev("some-other");
    dispatcher(h).dispatchOverlayEvent(e);
    assert.equal(h.spies.emitOverlayEvent.calls.length, 1);
    assert.equal((h.spies.emitOverlayEvent.calls[0].args[0] as { event_type: string }).event_type, "some-other");
    // and the new cases did NOT fire for an unrelated event
    assert.equal(h.spies.handleEndpoint.calls.length, 0);
  });
});
