/**
 * P-72 slice 7 — T-turn characterization tests (8 behaviors).
 *
 * These tests pin the observable behavior of the 5 closures inside
 * createTurnRunner. They are GREEN today (against pre-split turn.ts) and
 * MUST REMAIN GREEN after the Strategy A split (Step 3b) — that is the
 * load-bearing G-P72s7.1 gate.
 *
 * Critical mock setup note: turn.ts calls runAgentLoopPi from
 * src/agent/pi/loop.js (NOT src/agent/loop.js via the delegate). The mock
 * target is pathToFileURL(.../src/agent/pi/loop.js). Any test that uses a
 * loop stub must mock THAT module.
 *
 * C-MR1 compliance: per the Step 2 critic, spying on the returned object's
 * methods (e.g. replacing turn.steerThenTrigger after createTurnRunner) does
 * NOT intercept the lexical closure calls. All assertions are on OBSERVABLE
 * state (ServeState fields) and SSE frames, not on stub call counts of the
 * public turn object methods.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=15000 \
 *     tests/cli/subcommands/serve/turn-characterization.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/cli/subcommands/serve/context.js";

// ── Mock state ──────────────────────────────────────────────────────────────

// Spy on writeLlmErrorAudit calls. Reset per-test.
const llmErrorAuditCalls: Array<{ auditPath: string; row: unknown }> = [];

// Spy on callInOverlay calls. Reset per-test.
const overlayCalls: Array<{ functionDeclaration: string }> = [];

// biome-ignore lint/suspicious/noExplicitAny: mock captures opts loosely
let capturedRunLoopOpts: any | null = null;
let runLoopCallCount = 0;

// Controls the behaviour of the runAgentLoopPi stub per test.
type LoopMode = "resolve" | "reject" | "aborted" | "workflow-abort";
let loopMode: LoopMode = "resolve";

// The error thrown when loopMode === "reject".
let loopRejectError: Error = new Error("mock-llm-error");

// When loopMode === "workflow-abort", the onToolResults mock returns {abort:true}.
// We control it via a flag the stub checks.
let workflowAbortOnFirstStep = false;

// ── Factory refs ────────────────────────────────────────────────────────────

let createTurnRunner:
  | ((
      state: ServeState,
      deps: ServeDeps,
    ) => {
      runOneTurn: (args: {
        turnId: string;
        abortController: AbortController;
        userPrompt: string;
        isRetryable: boolean;
        maxSteps?: number;
        isCronTurn?: boolean;
        isWorkflowResume?: boolean;
      }) => Promise<void>;
      triggerAnalyzeProfile: (pageUrl: string, turnId: string, abortController: AbortController) => Promise<void>;
      steerThenTrigger: (newPrompt: string, isWorkflowResume?: boolean) => Promise<void>;
      triggerCardActionTurn: (actionPrompt: string, isWorkflowResume?: boolean) => Promise<void>;
      resumeWorkflowTurn: (prompt: string) => Promise<void>;
    })
  | null = null;

// ── File-level mock registration ────────────────────────────────────────────

before(async () => {
  // 1. Mock src/agent/pi/loop.js — the actual import target in turn.ts (NOT the
  //    loop.js delegate). We provide runAgentLoopPi + the 5 transitive re-exports
  //    that pi/loop.js re-imports from loop.js to keep the module chain valid.
  const piLoopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: opts shape varies by test mode
      runAgentLoopPi: async (opts: any) => {
        capturedRunLoopOpts = opts;
        runLoopCallCount++;
        const mode = loopMode;
        if (mode === "resolve") {
          // Emit one synthetic step so onStepFinish fires and we get step-done + done.
          await opts.onStepFinish({
            toolCalls: [],
            toolResults: [],
          });
          return;
        }
        if (mode === "reject") {
          throw loopRejectError;
        }
        if (mode === "aborted") {
          // Respect the abort signal — check before doing anything.
          if (opts?.abortSignal?.aborted) {
            return; // SDK contract: resolves when already-aborted; catch sees aborted=true.
          }
          await new Promise<void>((resolve) => {
            opts?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(() => resolve(), 3000);
          });
          return;
        }
        if (mode === "workflow-abort") {
          // Drive one step where onToolResults returns {abort:true}.
          await opts.onStepFinish({
            toolCalls: [{ toolName: "suggest_card" }],
            toolResults: [{ toolName: "suggest_card", result: {} }],
          });
          return;
        }
      },
    },
  });

  // 2. Mock src/persistence/audit.js — captures writeLlmErrorAudit calls.
  const auditUrl = pathToFileURL(resolve(process.cwd(), "src/persistence/audit.js")).href;
  mock.module(auditUrl, {
    namedExports: {
      writeLlmErrorAudit: (auditPath: string, row: unknown) => {
        llmErrorAuditCalls.push({ auditPath, row });
      },
      makeAuditWriter: (_auditPath: string) => async () => undefined,
      writeAuditRow: () => undefined,
      writeWorkflowAudit: () => undefined,
    },
  });

  // 3. Mock src/overlay/inject.js — captures callInOverlay calls.
  const injectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      OVERLAY_BOOTSTRAP_JS: "",
      installOverlay: async () => "id-overlay",
      subscribeContextId: async () => () => undefined,
      callInOverlay: async (_handle: unknown, _ctxId: number, fn: string) => {
        overlayCalls.push({ functionDeclaration: fn });
      },
    },
  });

  // 4. Mock src/persistence/salesDb.js — getCurrentAutoRun returns null (no auto-run).
  const salesDbUrl = pathToFileURL(resolve(process.cwd(), "src/persistence/salesDb.js")).href;
  mock.module(salesDbUrl, {
    namedExports: {
      getCurrentAutoRun: () => null,
      initSalesDb: () => ({ run: () => undefined, prepare: () => ({ all: () => [], get: () => null, run: () => undefined }) }),
    },
  });

  // 5. Mock src/tools/sales/_dbHandle.js — getSalesDb returns a stub.
  const dbHandleUrl = pathToFileURL(resolve(process.cwd(), "src/tools/sales/_dbHandle.js")).href;
  mock.module(dbHandleUrl, {
    namedExports: {
      getSalesDb: () => ({
        run: () => undefined,
        prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
      }),
    },
  });

  // 5b. P-AUTO-7: mock the reaper to a no-op — these tests pin runOneTurn's frame/audit behavior,
  // not the auto-run reaper (which has its own test, tests/tools/sales/pAuto7-reaper.mock.test.ts).
  const reaperUrl = pathToFileURL(resolve(process.cwd(), "src/cli/subcommands/serve/turn/reaper.js")).href;
  mock.module(reaperUrl, {
    namedExports: {
      reapExpiredAutoRun: () => undefined,
    },
  });

  // 6. Dynamic import createTurnRunner AFTER mocks are registered.
  const turnMod = await import("../../../../src/cli/subcommands/serve/turn.js");
  createTurnRunner = turnMod.createTurnRunner as typeof createTurnRunner;
});

// ── Stub factories ───────────────────────────────────────────────────────────

function makeState(overrides?: Partial<ServeState>): ServeState {
  return {
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    cronEnabled: false,
    passiveEnabled: false,
    autoRunId: null,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [],
    passiveProfileCache: new Map(),
    passiveLimiter: { check: () => ({ ok: true }) },
    sseClients: new Set(),
    ...overrides,
  } as unknown as ServeState;
}

function makeDeps(frames: unknown[], workflowOnToolResultsOverride?: () => { abort: boolean }): ServeDeps {
  return {
    model: {},
    system: "sys",
    systemResume: "sysResume",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: {
      setTurnAbortSignal: () => undefined,
      getClient: () => null,
    },
    schedulePath: "/dev/null",
    salesDbPath: "/dev/null",
    auditPath: "/dev/null",
    expectedToken: Buffer.from("t"),
    workflow: {
      onToolResults: workflowOnToolResultsOverride ?? (() => ({ abort: false })),
      handleEndpoint: () => ({ status: 200, response: { ok: true } }),
      getState: () => ({ current: null, awaitingApprovalStepId: null }),
    },
    emitFrame: (frame: unknown) => frames.push(frame),
    emitOverlayEvent: () => undefined,
    composeOperatorSystem: (mode: string) => `<SYS:${mode}>`,
  } as unknown as ServeDeps;
}

function resetSpies() {
  llmErrorAuditCalls.length = 0;
  overlayCalls.length = 0;
  capturedRunLoopOpts = null;
  runLoopCallCount = 0;
  loopMode = "resolve";
  loopRejectError = new Error("mock-llm-error");
  workflowAbortOnFirstStep = false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createTurnRunner — runOneTurn happy path", () => {
  it("T-turn.OneTurn.1: when runAgentLoopPi resolves, step-done + done frames emitted in order; state.lastFailedTurnPrompt cleared; no LLM-error audit", async () => {
    // Given: a fresh runner; runAgentLoopPi mock resolves with one synthetic step.
    // When:  runOneTurn with isRetryable:false + no abort.
    // Then:  frames in order [step-done, done/stop]; state.lastFailedTurnPrompt===null; writeLlmErrorAudit not called.
    assert.ok(createTurnRunner, "createTurnRunner must be loaded in before()");
    resetSpies();
    loopMode = "resolve";
    const frames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    await turn.runOneTurn({
      turnId: "t1",
      abortController: new AbortController(),
      userPrompt: "hi",
      isRetryable: false,
      isCronTurn: false,
    });

    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);

    // step-done appears before done
    const stepDoneIdx = frameTypes.indexOf("step-done");
    const doneIdx = frameTypes.indexOf("done");
    assert.ok(stepDoneIdx >= 0, "step-done frame expected");
    assert.ok(doneIdx >= 0, "done frame expected");
    assert.ok(stepDoneIdx < doneIdx, "step-done must precede done");

    // done frame has finishReason:"stop" + aborted:false
    const doneFrame = frames[doneIdx] as { type: string; turnId: string; finishReason: string; aborted: boolean };
    assert.equal(doneFrame.turnId, "t1");
    assert.equal(doneFrame.finishReason, "stop");
    assert.equal(doneFrame.aborted, false);

    // step-done frame has turnId + toolNames
    const stepDoneFrame = frames[stepDoneIdx] as { type: string; turnId: string; toolNames: string[] };
    assert.equal(stepDoneFrame.turnId, "t1");
    assert.deepEqual(stepDoneFrame.toolNames, []);

    // success-path state resets
    assert.equal(state.lastFailedTurnPrompt, null, "success path must clear lastFailedTurnPrompt");
    assert.equal(state.retryAttempts, 0, "success path must reset retryAttempts to 0");

    // no LLM-error audit
    assert.equal(llmErrorAuditCalls.length, 0, "writeLlmErrorAudit must NOT be called on happy path");

    // runAgentLoopPi called exactly once; operator turn uses composeOperatorSystem (not raw deps.system, not systemResume)
    assert.equal(runLoopCallCount, 1);
    // P-AUTO-8: operator turns now call deps.composeOperatorSystem(liveMode) instead of deps.system directly.
    // default state has cronEnabled=false, passiveEnabled=false → liveMode="manual" → stub returns "<SYS:manual>".
    assert.equal(capturedRunLoopOpts?.system, "<SYS:manual>", "non-resume operator turn must use composeOperatorSystem result");
    assert.notEqual(capturedRunLoopOpts?.system, "sys", "must NOT pass raw deps.system for operator turn post-P-AUTO-8");
    assert.notEqual(capturedRunLoopOpts?.system, "sysResume", "must NOT pass deps.systemResume for non-resume operator turn");
  });
});

describe("createTurnRunner — runOneTurn abort path", () => {
  it("T-turn.OneTurn.2: when abortController is pre-aborted, done{aborted:true} emitted; no LLM-error audit; lastFailedTurnPrompt null", async () => {
    // Given: a fresh runner; abortController.abort() called BEFORE runOneTurn.
    // When:  runOneTurn with isRetryable:true (so catch's non-abort branch would set the prompt).
    // Then:  done{finishReason:"aborted", aborted:true} emitted; writeLlmErrorAudit NOT called.
    assert.ok(createTurnRunner);
    resetSpies();
    loopMode = "aborted";
    const frames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    const abortController = new AbortController();
    abortController.abort(); // pre-abort

    await turn.runOneTurn({
      turnId: "t2",
      abortController,
      userPrompt: "hi",
      isRetryable: true,
      isCronTurn: false,
    });

    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);
    const doneIdx = frameTypes.indexOf("done");
    assert.ok(doneIdx >= 0, "done frame expected even on abort");
    const doneFrame = frames[doneIdx] as { type: string; turnId: string; finishReason: string; aborted: boolean };
    assert.equal(doneFrame.finishReason, "aborted");
    assert.equal(doneFrame.aborted, true);

    // aborted path — lastFailedTurnPrompt stays null
    assert.equal(state.lastFailedTurnPrompt, null, "aborted path must leave lastFailedTurnPrompt null");

    // no LLM-error audit on abort
    assert.equal(llmErrorAuditCalls.length, 0, "writeLlmErrorAudit must NOT be called on abort");

    // no exception thrown
    // (the await above would have thrown if the promise rejected)
  });
});

describe("createTurnRunner — runOneTurn LLM-error path (D-25 contract)", () => {
  it("T-turn.OneTurn.3: when runAgentLoopPi rejects (non-abort), writeLlmErrorAudit fires; lastFailedTurnPrompt=prompt if isRetryable; error frame emitted (G-P72s7.1, LOAD-BEARING) [2a]", async () => {
    // Given: runAgentLoopPi mock rejects with a typed LLM error; not pre-aborted; isRetryable:true.
    // When:  runOneTurn called.
    // Then:  writeLlmErrorAudit called once; state.lastFailedTurnPrompt===userPrompt; error frame with retryable:true.
    assert.ok(createTurnRunner);
    resetSpies();
    loopMode = "reject";
    loopRejectError = Object.assign(new Error("LLM API timeout"), {
      name: "AI_APICallError",
      status: 504,
    });
    const frames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    await turn.runOneTurn({
      turnId: "t-llm-err",
      abortController: new AbortController(),
      userPrompt: "trigger an LLM failure",
      isRetryable: true,
      isCronTurn: false,
    });

    // writeLlmErrorAudit called exactly once
    assert.equal(llmErrorAuditCalls.length, 1, "writeLlmErrorAudit must be called exactly once on LLM error");
    const auditRow = llmErrorAuditCalls[0].row as {
      turnId: string;
      errorMessage: string;
      errorName: string;
      turnKind: string;
      status?: number;
    };
    assert.equal(auditRow.turnId, "t-llm-err");
    assert.equal(auditRow.errorMessage, "LLM API timeout");
    assert.equal(auditRow.errorName, "AI_APICallError");
    assert.equal(auditRow.turnKind, "operator", "non-cron non-resume turn must have turnKind='operator'");
    assert.equal(auditRow.status, 504);

    // lastFailedTurnPrompt set to userPrompt (retryable branch, L274-275 pre-split)
    assert.equal(state.lastFailedTurnPrompt, "trigger an LLM failure", "isRetryable:true must set lastFailedTurnPrompt");

    // error frame emitted with retryable:true
    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);
    const errIdx = frameTypes.indexOf("error");
    assert.ok(errIdx >= 0, "error frame expected");
    const errFrame = frames[errIdx] as { type: string; turnId: string; message: string; retryable: boolean };
    assert.equal(errFrame.turnId, "t-llm-err");
    assert.equal(errFrame.message, "LLM API timeout");
    assert.equal(errFrame.retryable, true, "retryable must be true when lastFailedTurnPrompt is non-null");

    // done/stop frame NOT emitted (success path did not run)
    const doneFrame = (frames as Array<{ type: string; finishReason?: string }>).find(
      (f) => f.type === "done" && f.finishReason === "stop",
    );
    assert.equal(doneFrame, undefined, "success-path done/stop frame must NOT be emitted on LLM error");

    // no exception thrown by the awaited call
    // (the await above would have thrown if the promise rejected uncaught)
  });

  it("T-turn.OneTurn.3 (edge — non-retryable): when isRetryable:false, lastFailedTurnPrompt stays null; error frame has retryable:false", async () => {
    // Given: same as above but isRetryable:false.
    // When:  runOneTurn with isRetryable:false and LLM error.
    // Then:  state.lastFailedTurnPrompt===null; error frame with retryable:false.
    assert.ok(createTurnRunner);
    resetSpies();
    loopMode = "reject";
    loopRejectError = new Error("non-retryable LLM error");
    const frames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    await turn.runOneTurn({
      turnId: "t-llm-noretry",
      abortController: new AbortController(),
      userPrompt: "will not retry",
      isRetryable: false,
      isCronTurn: false,
    });

    assert.equal(state.lastFailedTurnPrompt, null, "isRetryable:false must leave lastFailedTurnPrompt null");
    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);
    const errIdx = frameTypes.indexOf("error");
    assert.ok(errIdx >= 0, "error frame expected");
    const errFrame = frames[errIdx] as { type: string; retryable: boolean };
    assert.equal(errFrame.retryable, false, "retryable must be false when isRetryable:false");
  });
});

describe("createTurnRunner — runOneTurn workflow-gate abort path (D-25 / G-P72s7.1) [2a]", () => {
  it("T-turn.OneTurn.4: when workflow.onToolResults returns {abort:true}, abortController fires; done{aborted:true}; lastFailedTurnPrompt preserved (not cleared); writeLlmErrorAudit NOT called (G-P72s7.1, LOAD-BEARING)", async () => {
    // Given: onToolResults returns {abort:true} on first step; runAgentLoopPi resolves; state.lastFailedTurnPrompt===null at entry.
    // When:  runOneTurn called.
    // Then:  abortController.abort() fired inside onStepFinish; done{finishReason:"aborted"}; lastFailedTurnPrompt still null; no llm_error audit.
    assert.ok(createTurnRunner);
    resetSpies();
    loopMode = "workflow-abort";

    const frames: unknown[] = [];
    const state = makeState({ lastFailedTurnPrompt: null });
    const abortController = new AbortController();

    // Workflow stub: on first call return {abort:true}.
    let workflowCallCount = 0;
    const workflowAbortStub = () => {
      workflowCallCount++;
      return { abort: true };
    };
    const deps = makeDeps(frames, workflowAbortStub);
    const turn = createTurnRunner(state, deps);

    await turn.runOneTurn({
      turnId: "t-wf-abort",
      abortController,
      userPrompt: "drive a workflow approval gate",
      isRetryable: true,
      isCronTurn: false,
    });

    // workflow.onToolResults was called
    assert.ok(workflowCallCount >= 1, "workflow.onToolResults must be called at least once");

    // abortController was fired (L223 pre-split)
    assert.equal(abortController.signal.aborted, true, "abortController.abort() must have fired");

    // done frame with finishReason:"aborted"
    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);
    const doneIdx = frameTypes.indexOf("done");
    assert.ok(doneIdx >= 0, "done frame expected");
    const doneFrame = frames[doneIdx] as { type: string; turnId: string; finishReason: string; aborted: boolean };
    assert.equal(doneFrame.finishReason, "aborted", "workflow-abort must emit finishReason:'aborted'");
    assert.equal(doneFrame.aborted, true);

    // lastFailedTurnPrompt preserved (success-path reset guarded out by if(!aborted))
    assert.equal(state.lastFailedTurnPrompt, null, "workflow-abort: lastFailedTurnPrompt must remain null (preserved, not cleared by success path)");

    // no LLM-error audit (catch path not entered; LLM resolved normally)
    assert.equal(llmErrorAuditCalls.length, 0, "writeLlmErrorAudit must NOT be called on workflow-gate abort");
  });
});

describe("createTurnRunner — triggerAnalyzeProfile", () => {
  it("T-turn.Triggers.1: with a profile URL + pre-supplied turnId, emits turn-started first; pushes analyzePrompt onto messages; calls runOneTurn (G-P72s7.1, LOAD-BEARING)", async () => {
    // Given: runAgentLoopPi resolves; state.messages empty.
    // When:  triggerAnalyzeProfile("https://linkedin.com/in/jane", "t3", new AbortController()).
    // Then:  turn-started frame emitted (source:"server"); state.messages[0] starts with analyzePrompt; step-done + done frames after.
    assert.ok(createTurnRunner);
    resetSpies();
    loopMode = "resolve";
    const frames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    const ac = new AbortController();
    await turn.triggerAnalyzeProfile("https://linkedin.com/in/jane", "t3", ac);

    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);

    // turn-started is the FIRST frame
    assert.equal(frameTypes[0], "turn-started", "turn-started must be the first frame");
    const tsFrame = frames[0] as { type: string; turnId: string; source: string };
    assert.equal(tsFrame.turnId, "t3");
    assert.equal(tsFrame.source, "server");

    // analyzePrompt pushed onto messages (L333 pre-split)
    assert.equal(state.messages.length, 1, "exactly one message must be pushed");
    const msg = state.messages[0] as { role: string; content: string };
    assert.equal(msg.role, "user");
    assert.ok(
      msg.content.startsWith("Operator is on profile https://linkedin.com/in/jane"),
      "analyzePrompt must start with the profile URL sentence",
    );

    // state.lastTurnUserPrompt set (L334 pre-split)
    assert.equal(state.lastTurnUserPrompt, msg.content);

    // step-done + done frames appear AFTER turn-started
    assert.ok(frameTypes.includes("step-done"), "step-done frame expected");
    assert.ok(frameTypes.includes("done"), "done frame expected");
    const tsIdx = 0;
    const stepDoneIdx = frameTypes.indexOf("step-done");
    const doneIdx = frameTypes.indexOf("done");
    assert.ok(tsIdx < stepDoneIdx, "turn-started must precede step-done");
    assert.ok(stepDoneIdx < doneIdx, "step-done must precede done");
  });
});

describe("createTurnRunner — triggerCardActionTurn", () => {
  it("T-turn.Triggers.2: with action prompt + state.currentTurn===null, mints turnId; emits turn-started; pushes message; calls runOneTurn; finally clears currentTurn (G-P72s7.1, LOAD-BEARING)", async () => {
    // Given: state.currentTurn===null; runAgentLoopPi resolves.
    // When:  triggerCardActionTurn("Send a connect request", false).
    // Then:  currentTurn was set during call (non-null); turn-started emitted; message pushed; done frame; currentTurn===null after.
    assert.ok(createTurnRunner);
    resetSpies();
    loopMode = "resolve";
    const frames: unknown[] = [];
    const state = makeState({ currentTurn: null });
    let observedCurrentTurnDuringLoop: { turnId: string } | null = null;

    // Intercept inside the loop to observe state mid-call.
    const piLoopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/pi/loop.js")).href;
    // We use a local capture via a helper — we can't re-register mock.module, but
    // we can observe state.currentTurn from within our existing mock by delegating:
    // The existing mock just calls opts.onStepFinish; state.currentTurn is set before
    // runOneTurn is called (L385 pre-split), so we observe it after the call.

    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    await turn.triggerCardActionTurn("Send a connect request", false);

    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);

    // turn-started emitted (L386 pre-split)
    assert.ok(frameTypes.includes("turn-started"), "turn-started frame expected");
    const tsFrame = frames[frameTypes.indexOf("turn-started")] as {
      type: string;
      turnId: string;
      source: string;
    };
    assert.equal(tsFrame.source, "server");
    // turnId must be 8 hex chars (randomBytes(4).toString("hex"))
    assert.match(tsFrame.turnId, /^[0-9a-f]{8}$/, "minted turnId must be 8 hex chars");

    // message pushed (L387 pre-split)
    assert.equal(state.messages.length, 1);
    const msg = state.messages[0] as { role: string; content: string };
    assert.equal(msg.role, "user");
    assert.equal(msg.content, "Send a connect request");

    // lastTurnUserPrompt set (L388 pre-split)
    assert.equal(state.lastTurnUserPrompt, "Send a connect request");

    // finally: currentTurn cleared (L405 pre-split)
    assert.equal(state.currentTurn, null, "state.currentTurn must be null after triggerCardActionTurn resolves");

    // done frame present
    assert.ok(frameTypes.includes("done"), "done frame expected");

    // Edge: current-turn-in-progress guard (L376-381 pre-split)
    // If state.currentTurn is non-null, must emit error and NOT call runOneTurn.
    resetSpies();
    const frames2: unknown[] = [];
    const state2 = makeState({ currentTurn: { turnId: "existing-turn", abortController: new AbortController() } });
    const deps2 = makeDeps(frames2);
    const turn2 = createTurnRunner(state2, deps2);
    runLoopCallCount = 0;

    await turn2.triggerCardActionTurn("should be blocked", false);

    const frameTypes2 = (frames2 as Array<{ type: string }>).map((f) => f.type);
    assert.ok(frameTypes2.includes("error"), "in-progress guard must emit error frame");
    assert.equal(runLoopCallCount, 0, "runAgentLoopPi must NOT be called when a turn is in progress");
    // state.currentTurn must NOT have been mutated
    assert.ok(state2.currentTurn !== null, "state.currentTurn must remain non-null when blocked");
  });
});

describe("createTurnRunner — steerThenTrigger", () => {
  it("T-turn.Steer.1: with active turn in state + new prompt, aborts the current turn; waits for clear; calls void triggerCardActionTurn (G-P72s7.1, LOAD-BEARING)", async () => {
    // Given: state.currentTurn is set to a prev turn; a setTimeout clears it after 50ms to simulate runOneTurn finally.
    // When:  steerThenTrigger("New prompt after steer", true).
    // Then:  prev abortController.signal.aborted after steer returns; state.currentTurn was null at the point steer unblocked.
    //
    // NOTE: steerThenTrigger calls `void triggerCardActionTurn(newPrompt, isWorkflowResume)` (L355/L372 pre-split) —
    // fire-and-forget. steerThenTrigger resolves BEFORE triggerCardActionTurn's async body completes.
    // The test therefore asserts the abort + unblock semantics, then waits a tick for the
    // card-action turn to start so we can observe the message push.
    assert.ok(createTurnRunner);
    resetSpies();
    loopMode = "resolve";
    const frames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    // Install a prev active turn
    const prevAc = new AbortController();
    state.currentTurn = { turnId: "prev-turn", abortController: prevAc };

    // Simulate runOneTurn's finally clearing state.currentTurn after 50ms.
    setTimeout(() => {
      state.currentTurn = null;
    }, 50);

    await turn.steerThenTrigger("New prompt after steer", true);

    // prev turn was aborted (L359 pre-split)
    assert.equal(prevAc.signal.aborted, true, "prev abortController must have been aborted by steerThenTrigger");

    // After steer resolves, state.currentTurn was null (the deadline loop unblocked).
    // The void triggerCardActionTurn call is fire-and-forget; wait a brief tick for it to start.
    await new Promise((r) => setTimeout(r, 50));

    // turn-started and message push happen inside triggerCardActionTurn (started via void)
    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);
    assert.ok(frameTypes.includes("turn-started"), "steer must have triggered a turn-started frame (via fire-and-forget triggerCardActionTurn)");

    // Messages: steerThenTrigger → void triggerCardActionTurn → message pushed
    assert.ok(state.messages.length >= 1, "steer must eventually push a message via the card-action turn");
    const msg = state.messages[0] as { role: string; content: string };
    assert.equal(msg.content, "New prompt after steer");

    // Edge: no active turn → fires immediately via void triggerCardActionTurn + returns
    resetSpies();
    const frames3: unknown[] = [];
    const state3 = makeState({ currentTurn: null });
    const deps3 = makeDeps(frames3);
    const turn3 = createTurnRunner(state3, deps3);

    await turn3.steerThenTrigger("No-prev-turn prompt", false);
    // wait a tick for the fire-and-forget triggerCardActionTurn to start
    await new Promise((r) => setTimeout(r, 50));
    const frameTypes3 = (frames3 as Array<{ type: string }>).map((f) => f.type);
    assert.ok(frameTypes3.includes("turn-started"), "steer with no current turn must fire immediately (turn-started from triggered card-action)");
  });
});

describe("createTurnRunner — resumeWorkflowTurn", () => {
  it("T-turn.Resume.1: resumeWorkflowTurn(prompt) invokes steerThenTrigger(prompt, true) which fires triggerCardActionTurn with isWorkflowResume:true (G-P72s7.1, LOAD-BEARING — workflow-resume contract)", async () => {
    // Given: state.currentTurn===null; runAgentLoopPi resolves; no active turn to abort.
    // When:  resumeWorkflowTurn("Continue the outbound step").
    // Then:  runAgentLoopPi eventually called with system==="sysResume" (deps.systemResume, not deps.system).
    //        This proves the full chain: resumeWorkflowTurn(prompt) → await steerThenTrigger(prompt, true)
    //        → (no current turn) → void triggerCardActionTurn(prompt, true)
    //        → runOneTurn({ ..., isWorkflowResume: true })
    //        → runAgentLoopPi({ system: deps.systemResume }) at L162 pre-split.
    //
    // NOTE: resumeWorkflowTurn AWAITS steerThenTrigger (L410 pre-split: await steerThenTrigger(prompt, true)).
    // steerThenTrigger with no current turn calls `void triggerCardActionTurn(...)` — fire-and-forget — then returns.
    // So resumeWorkflowTurn resolves BEFORE triggerCardActionTurn's body completes.
    // We wait a small tick for the fire-and-forget portion to run.
    assert.ok(createTurnRunner);
    resetSpies();
    loopMode = "resolve";
    const frames: unknown[] = [];
    const state = makeState({ currentTurn: null });
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    await turn.resumeWorkflowTurn("Continue the outbound step");

    // Wait for the fire-and-forget triggerCardActionTurn chain to complete.
    await new Promise((r) => setTimeout(r, 50));

    // runAgentLoopPi called with systemResume (isWorkflowResume:true → L162 pre-split)
    assert.equal(runLoopCallCount, 1, "runAgentLoopPi must be called exactly once by resumeWorkflowTurn");
    assert.equal(
      capturedRunLoopOpts?.system,
      "sysResume",
      "resumeWorkflowTurn must use deps.systemResume (isWorkflowResume===true path at L162 pre-split) — proves steerThenTrigger was called with true",
    );

    // turn-started frame emitted (via triggerCardActionTurn)
    const frameTypes = (frames as Array<{ type: string }>).map((f) => f.type);
    assert.ok(frameTypes.includes("turn-started"), "turn-started frame expected");

    // message was pushed with the prompt
    assert.equal(state.messages.length, 1);
    const msg = state.messages[0] as { role: string; content: string };
    assert.equal(msg.content, "Continue the outbound step");

    // system must NOT be the non-resume path
    assert.notEqual(capturedRunLoopOpts?.system, "sys", "must NOT use deps.system (non-resume) on resumeWorkflowTurn");
  });
});
