/**
 * P-UI-THINK-COMPACT — Step 3a RED: executable app binding and running-input ownership.
 *
 * Run:
 *   npm run build:tauri-ui && node --import tsx --test --test-force-exit \
 *     tests/tauri/ui/assistantAppBindings-pUiThinkCompact.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { SseFrame as CanonicalSseFrame } from "../../../src/app/backend/context.js";

type PresentationFrame =
  | { type: "assistant-progress"; turnId: string; text: string }
  | { type: "text"; turnId: string; chunk: string }
  | { type: "done"; turnId: string; finishReason: string; aborted?: boolean }
  | { type: "error"; turnId?: string; message: string };
type LifecycleFrame = { type: "turn-started"; turnId: string; source: string };
type AppFrame = CanonicalSseFrame | PresentationFrame | LifecycleFrame;
type CanonicalAssistantProgressCompileContract = {
  type: "assistant-progress";
  turnId: string;
  text: string;
};
const CANONICAL_ASSISTANT_PROGRESS_PAYLOAD = {
  type: "assistant-progress",
  turnId: "compile-turn",
  text: "compile-progress",
} as const satisfies CanonicalAssistantProgressCompileContract;
void CANONICAL_ASSISTANT_PROGRESS_PAYLOAD;
type AssistantBindingDiscriminator = "assistant-progress" | "text" | "reasoning" | "turn-started" | "done" | "error";
type CanonicalNonAssistantDiscriminator = Exclude<CanonicalSseFrame["type"], AssistantBindingDiscriminator>;
const CANONICAL_NON_ASSISTANT_TYPES = [
  "tool-call",
  "step-done",
  "overlay-reconnected",
  "overlay-event",
  "suggestion-card",
  "next-actions",
  "profile-nav",
  "dialog-mode",
  "cron-mode",
  "passive-mode",
  "cron-tick",
  "cron-done",
  "workflow-proposed",
  "workflow-step-advanced",
  "workflow-approval-pending",
  "workflow-approval-resolved",
  "workflow-mode-changed",
  "workflow-completed",
  "auto-run-completed",
  "auto-session-started",
  "auto-session-completed",
  "passive-fired",
  "passive-skipped",
  "auto-run-started",
  "auto-run-progress",
  "commit-warning",
] as const satisfies readonly CanonicalNonAssistantDiscriminator[];
const CANONICAL_MISSING_ASSERTION: Record<
  Exclude<CanonicalNonAssistantDiscriminator, (typeof CANONICAL_NON_ASSISTANT_TYPES)[number]>,
  never
> = {};
const CANONICAL_EXTRA_ASSERTION: Record<
  Exclude<(typeof CANONICAL_NON_ASSISTANT_TYPES)[number], CanonicalNonAssistantDiscriminator>,
  never
> = {};
void CANONICAL_MISSING_ASSERTION;
void CANONICAL_EXTRA_ASSERTION;
type PresentationOutcome = "ignored" | "progress" | "final" | "terminal";
type InterruptOutcome = "stopped" | "already_stopped" | "rejected" | "stale";
type DispatchOutcome = "empty" | "busy" | "steer" | InterruptOutcome;
type PauseOutcome = InterruptOutcome | "workflow_cancelled" | "workflow_cancel_rejected";
type Runtime = {
  beginTurn(): void;
  handleEvent(frame: PresentationFrame): PresentationOutcome;
  pause(): Promise<InterruptOutcome>;
  stop(text: string): Promise<InterruptOutcome>;
  steer(text: string): Promise<InterruptOutcome>;
};
type InterruptionModule = {
  createTurnInterruptionController(deps: {
    getCurrentTurnId: () => string | null;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    settleOwned: (turnId: string) => void;
    appendStoppedText: (text: string) => void;
    startReplacement: (text: string) => Promise<void>;
    reportFailure: (error: unknown) => void;
  }): {
    pause(): Promise<InterruptOutcome>;
    stop(text: string): Promise<InterruptOutcome>;
    steer(text: string): Promise<InterruptOutcome>;
  };
};
type AppBindings = {
  handleEvent(frame: AppFrame): boolean;
  pause(): Promise<PauseOutcome>;
  dispatchRunning(input: string): Promise<DispatchOutcome>;
};
type AppBindingsModule = {
  createAssistantAppBindings(deps: {
    runtime: Runtime;
    getCurrentTurnId: () => string | null;
    cancelWorkflow: () => Promise<void>;
    onTurnStarted: (frame: LifecycleFrame) => void;
    onDone: (frame: Extract<PresentationFrame, { type: "done" }>) => void;
    onError: (frame: Extract<PresentationFrame, { type: "error" }>, preserveRunning: boolean) => void;
    reportFailure: (error: unknown) => void;
  }): AppBindings;
};
type WorkflowCancelResult = { ok: true } | { ok: false; reason: string };
type CompositionModule = {
  createAssistantAppComposition(deps: {
    runtime: Runtime;
    getCurrentTurnId: () => string | null;
    setCurrentTurnId: (turnId: string | null) => void;
    getWorkflowId: () => string | null;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    onTurnStartedView: (frame: LifecycleFrame) => void;
    onDoneView: (frame: Extract<PresentationFrame, { type: "done" }>) => void;
    onErrorView: (frame: Extract<PresentationFrame, { type: "error" }>, preserveRunning?: boolean) => void;
    reportFailure: (error: unknown) => void;
  }): AppBindings;
};

async function loadAppBindings(): Promise<AppBindingsModule> {
  return (await import(pathToFileURL(resolve("src/tauri/ui/app/assistantAppBindings.js")).href)) as AppBindingsModule;
}

async function loadAppComposition(): Promise<CompositionModule> {
  return (await import(
    pathToFileURL(resolve("src/tauri/ui/app/assistantAppComposition.js")).href
  )) as CompositionModule;
}

async function loadInterruptionController(): Promise<InterruptionModule> {
  return (await import(pathToFileURL(resolve("src/tauri/ui/app/turnInterruption.js")).href)) as InterruptionModule;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function inertRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    beginTurn: () => undefined,
    handleEvent: () => "ignored",
    pause: async () => "stopped",
    stop: async () => "stopped",
    steer: async () => "stopped",
    ...overrides,
  };
}

function createBindings(
  module: AppBindingsModule,
  input: {
    runtime?: Runtime;
    getCurrentTurnId?: () => string | null;
    cancelWorkflow?: () => Promise<void>;
    onTurnStarted?: (frame: LifecycleFrame) => void;
    onDone?: (frame: Extract<PresentationFrame, { type: "done" }>) => void;
    onError?: (frame: Extract<PresentationFrame, { type: "error" }>, preserveRunning: boolean) => void;
    reportFailure?: (error: unknown) => void;
  } = {},
): AppBindings {
  return module.createAssistantAppBindings({
    runtime: input.runtime ?? inertRuntime(),
    getCurrentTurnId: input.getCurrentTurnId ?? (() => "turn"),
    cancelWorkflow: input.cancelWorkflow ?? (async () => undefined),
    onTurnStarted: input.onTurnStarted ?? (() => undefined),
    onDone: input.onDone ?? (() => undefined),
    onError: input.onError ?? (() => undefined),
    reportFailure: input.reportFailure ?? (() => undefined),
  });
}

describe("canonical backend contract owns the assistant progress frame", () => {
  it("T-Binding.Canonical: assistant-progress is an explicit exact-payload SseFrame member", () => {
    // Given the backend source and compile payload above, when the canonical union is inspected, then the new frame exists independently of the test-local presentation union.
    const source = readFileSync(resolve("src/app/backend/context.ts"), "utf8");
    const declarationStart = source.indexOf("export type SseFrame =");
    const declarationEnd = source.indexOf("\nexport interface SuggestionCardPayload", declarationStart);
    assert.ok(declarationStart >= 0 && declarationEnd > declarationStart, "exported SseFrame declaration must exist");
    const declaration = source.slice(declarationStart, declarationEnd);
    assert.match(declaration, /\|\s*\{\s*type:\s*"assistant-progress";\s*turnId:\s*string;\s*text:\s*string;?\s*\}/s);
  });
});

describe("executable app binding owns only assistant frames and preserves lifecycle ordering", () => {
  it("T-Binding.0: turn start owns lifecycle before runtime and presentation frames route once", async () => {
    // Given one new turn plus progress and final frames, when the binding handles them, then ownership starts before the runtime and each presentation frame is dispatched exactly once.
    const module = await loadAppBindings();
    const calls: string[] = [];
    const binding = createBindings(module, {
      runtime: inertRuntime({
        beginTurn: () => calls.push("begin-runtime"),
        handleEvent: (frame) => {
          calls.push(`runtime:${frame.type}`);
          return frame.type === "assistant-progress" ? "progress" : "final";
        },
      }),
      onTurnStarted: (frame) => calls.push(`own:${frame.turnId}`),
    });
    assert.equal(binding.handleEvent({ type: "turn-started", turnId: "turn", source: "server" }), true);
    assert.equal(binding.handleEvent({ type: "assistant-progress", turnId: "turn", text: "working" }), true);
    assert.equal(binding.handleEvent({ type: "text", turnId: "turn", chunk: "final" }), true);
    assert.deepEqual(calls, ["own:turn", "begin-runtime", "runtime:assistant-progress", "runtime:text"]);
  });

  it("T-Binding.1: non-assistant frames fall through untouched", async () => {
    // Given every current non-assistant SSE discriminator, when the binding sees it, then it returns false without invoking assistant runtime or lifecycle hooks.
    const module = await loadAppBindings();
    const calls: string[] = [];
    const binding = createBindings(module, {
      runtime: inertRuntime({
        beginTurn: () => calls.push("begin"),
        handleEvent: (frame) => {
          calls.push(`runtime:${frame.type}`);
          return "ignored";
        },
      }),
      onTurnStarted: () => calls.push("turn-started"),
      onDone: () => calls.push("done"),
      onError: () => calls.push("error"),
    });
    const frames = [
      { type: "tool-call", turnId: "turn", toolName: "inspect_page" },
      { type: "step-done", turnId: "turn" },
      { type: "overlay-reconnected" },
      {
        type: "overlay-event",
        event: { kind: "overlay-event", ts: 1, event_type: "hello", t0: 1, latency_ms: 0 },
      },
      { type: "suggestion-card" },
      { type: "next-actions" },
      { type: "profile-nav", profileHandle: "operator" },
      { type: "dialog-mode", dialogMode: "expand" },
      { type: "cron-mode", cronEnabled: true },
      { type: "passive-mode", passiveEnabled: true },
      { type: "cron-tick", cronRunId: "cron", ts: 1 },
      { type: "cron-done", cronRunId: "cron", ts: 2 },
      {
        type: "workflow-proposed",
        turnId: "turn",
        workflowId: "workflow",
        title: "title",
        approvalMode: "manual",
        steps: [],
        ts: 1,
      },
      {
        type: "workflow-step-advanced",
        turnId: "turn",
        workflowId: "workflow",
        stepId: "step",
        prevState: "in_progress",
        nextState: "completed",
        ts: 1,
      },
      {
        type: "workflow-approval-pending",
        turnId: "turn",
        workflowId: "workflow",
        stepId: "step",
        stepTitle: "step",
        ts: 1,
      },
      {
        type: "workflow-approval-resolved",
        workflowId: "workflow",
        stepId: "step",
        decision: "approved",
        ts: 1,
      },
      { type: "workflow-mode-changed", workflowId: "workflow", approvalMode: "manual", ts: 1 },
      { type: "workflow-completed", workflowId: "workflow", finalState: "completed", ts: 1 },
      {
        type: "auto-run-completed",
        runId: "run",
        status: "completed",
        summary: null,
        finalCounters: {},
        endedAt: 1,
        ts: 2,
      },
      { type: "auto-session-started", sessionId: "session", prompt: "go", intervalMinutes: 5, ts: 1 },
      { type: "auto-session-completed", sessionId: "session", reason: "terminated", ts: 2 },
      { type: "passive-fired", turnId: "turn", ts: 1, reason: "observed" },
      { type: "passive-skipped", ts: 1, reason: "busy" },
      {
        type: "auto-run-started",
        runId: "run",
        maxDurationMinutes: 60,
        maxConnects: null,
        startedAt: 1,
        ts: 1,
      },
      { type: "auto-run-progress", runId: "run", elapsedMinutes: 1, counters: {}, ts: 1 },
      { type: "commit-warning", workflowId: null, label: "warning", severity: "low", ts: 1 },
    ] satisfies CanonicalSseFrame[];
    for (const frame of frames) assert.equal(binding.handleEvent(frame), false);
    assert.deepEqual(calls, []);
  });

  it("T-Binding.1b: legacy reasoning frames are consumed without entering presentation", async () => {
    // Given a defensive legacy reasoning frame, when the binding sees it, then privacy handling consumes it without calling the presentation runtime.
    const module = await loadAppBindings();
    const calls: string[] = [];
    const binding = createBindings(module, {
      runtime: inertRuntime({
        handleEvent: (frame) => {
          calls.push(frame.type);
          return "ignored";
        },
      }),
    });
    assert.equal(binding.handleEvent({ type: "reasoning", turnId: "turn", chunk: "PRIVATE" }), true);
    assert.deepEqual(calls, []);
  });

  it("T-Binding.2: only current terminals clear presentation before lifecycle settlement", async () => {
    // Given visible current progress plus stale and ownerless terminals, when the binding dispatches them, then stale frames cannot settle and current cleanup precedes ownership callbacks.
    const module = await loadAppBindings();
    let current: string | null = "new";
    let visible = true;
    const calls: string[] = [];
    const runtime = inertRuntime({
      handleEvent: (frame) => {
        if (!("turnId" in frame) || frame.turnId !== current) return "ignored";
        if (frame.type === "done" || frame.type === "error") {
          visible = false;
          calls.push(`clear:${frame.type}`);
          return "terminal";
        }
        return frame.type === "assistant-progress" ? "progress" : "final";
      },
    });
    const binding = createBindings(module, {
      runtime,
      getCurrentTurnId: () => current,
      onDone: () => {
        calls.push(`done:visible=${visible}`);
        current = null;
      },
      onError: (frame, preserveRunning) => {
        calls.push(`error:visible=${visible}:preserve=${preserveRunning}`);
        if (frame.turnId === current) current = null;
      },
    });
    const stale: PresentationFrame[] = [
      { type: "done", turnId: "old", finishReason: "stop" },
      { type: "done", turnId: "old", finishReason: "max_steps" },
      { type: "done", turnId: "old", finishReason: "aborted", aborted: true },
      { type: "error", turnId: "old", message: "old" },
    ];
    for (const frame of stale) assert.equal(binding.handleEvent(frame), true);
    assert.equal(visible, true);
    assert.deepEqual(calls, []);

    assert.equal(binding.handleEvent({ type: "error", message: "ownerless" }), true);
    assert.equal(visible, true);
    assert.equal(current, "new");
    assert.deepEqual(calls, ["error:visible=true:preserve=true"]);

    const currentTerminals: PresentationFrame[] = [
      { type: "done", turnId: "new", finishReason: "stop" },
      { type: "done", turnId: "new", finishReason: "max_steps" },
      { type: "done", turnId: "new", finishReason: "aborted", aborted: true },
      { type: "error", turnId: "new", message: "failed" },
    ];
    for (const terminal of currentTerminals) {
      current = "new";
      visible = true;
      calls.length = 0;
      assert.equal(binding.handleEvent(terminal), true);
      const kind = terminal.type;
      assert.deepEqual(calls, [
        `clear:${kind}`,
        kind === "error" ? "error:visible=false:preserve=false" : "done:visible=false",
      ]);
    }
  });
});

describe("one running-input owner preserves stop classification and serialization", () => {
  it("T-Binding.3: raw stop and ordinary text route exclusively through the existing semantics", async () => {
    // Given the established positive and adverse classifier corpus, when dispatchRunning classifies it, then only stop or steer runs and empty input remains inert.
    const module = await loadAppBindings();
    const bindingSource = readFileSync(resolve("src/tauri/ui/app/assistantAppBindings.ts"), "utf8");
    assert.match(bindingSource, /import\s*\{\s*isExplicitStopIntent\s*\}\s*from\s*["']\.\/runningComposer\.js["']/);
    assert.match(bindingSource, /isExplicitStopIntent\(text\)/);
    const calls: string[] = [];
    const binding = createBindings(module, {
      runtime: inertRuntime({
        stop: async (text) => {
          calls.push(`stop:${text}`);
          return "stopped";
        },
        steer: async (text) => {
          calls.push(`steer:${text}`);
          return "stopped";
        },
      }),
    });
    for (const empty of ["", " \n\t "]) assert.equal(await binding.dispatchRunning(empty), "empty");
    const exactStops = [
      "stop",
      "STOP   NOW!",
      "STOP NOW?!?!",
      "please stop",
      "cancel",
      "abort",
      "halt",
      "pause",
      "停",
      "停止。",
      "停下来",
      "别做了！",
      "不要继续",
      "先停",
      "暂停",
      "中止",
      "终止",
      "取消",
      "kill chrome",
      "close Chrome!",
      "quit the browser",
      "关闭浏览器",
      "关掉 chrome",
      "退出浏览器。",
    ];
    const ordinaryPrompts = [
      "don't stop",
      "do not stop",
      "不要停",
      "stop researching Acme and continue with Contoso",
      '"stop"',
      "“停”",
      'tell me what "kill chrome" means',
      "please close chrome after saving the draft",
      "stop; then continue",
      "stop: explain why",
      "stop,",
      "停，",
      "(stop)",
      "pause for a moment and then continue",
      "the cancel button is broken",
    ];
    for (const text of exactStops) assert.equal(await binding.dispatchRunning(text), "stopped", text);
    for (const text of ordinaryPrompts) assert.equal(await binding.dispatchRunning(text), "steer", text);
    assert.deepEqual(calls, [
      ...exactStops.map((text) => `stop:${text}`),
      ...ordinaryPrompts.map((text) => `steer:${text}`),
    ]);
  });

  it("T-Binding.4: stop and steer share one in-flight owner", async () => {
    // Given pending steer or stop dispatch, when another stop arrives, then it returns busy and no second abort path begins.
    const module = await loadAppBindings();

    const steerGate = deferred<InterruptOutcome>();
    const steerCalls: string[] = [];
    const steering = createBindings(module, {
      runtime: inertRuntime({
        steer: (text) => {
          steerCalls.push(`steer:${text}`);
          return steerGate.promise;
        },
        stop: async (text) => {
          steerCalls.push(`stop:${text}`);
          return "stopped";
        },
      }),
    });
    const pendingSteer = steering.dispatchRunning("new task");
    assert.equal(await steering.dispatchRunning("停止"), "busy");
    assert.equal(await steering.dispatchRunning("second task"), "busy");
    assert.deepEqual(steerCalls, ["steer:new task"]);
    steerGate.resolve("stopped");
    assert.equal(await pendingSteer, "steer");

    const stopGate = deferred<InterruptOutcome>();
    const stopCalls: string[] = [];
    const stopping = createBindings(module, {
      runtime: inertRuntime({
        stop: (text) => {
          stopCalls.push(`stop:${text}`);
          return stopGate.promise;
        },
      }),
    });
    const pendingStop = stopping.dispatchRunning("停止");
    assert.equal(await stopping.dispatchRunning("停止"), "busy");
    assert.equal(await stopping.dispatchRunning("second task"), "busy");
    assert.deepEqual(stopCalls, ["stop:停止"]);
    stopGate.resolve("stopped");
    assert.equal(await pendingStop, "stopped");
  });
});

describe("production app composition owns lifecycle and concrete workflow cancellation", () => {
  it("T-Composition.1: active lifecycle state changes are ordered around the presentation runtime", async () => {
    // Given the production composition seam, when a turn starts and each current terminal arrives, then concrete ownership and presentation cleanup precede view callbacks.
    const module = await loadAppComposition();
    let current: string | null = null;
    const calls: string[] = [];
    const runtime = inertRuntime({
      beginTurn: () => calls.push("begin-runtime"),
      handleEvent: (frame) => {
        calls.push(`runtime:${frame.type}`);
        return frame.type === "done" || frame.type === "error" ? "terminal" : "progress";
      },
    });
    const composition = module.createAssistantAppComposition({
      runtime,
      getCurrentTurnId: () => current,
      setCurrentTurnId: (turnId) => {
        current = turnId;
        calls.push(`owner:${turnId ?? "null"}`);
      },
      getWorkflowId: () => "workflow",
      invoke: async () => ({ ok: true }) as never,
      onTurnStartedView: () => calls.push("view:start"),
      onDoneView: () => calls.push("view:done"),
      onErrorView: (_frame, preserveRunning) => calls.push(`view:error:preserve=${preserveRunning}`),
      reportFailure: () => undefined,
    });
    assert.equal(composition.handleEvent({ type: "turn-started", turnId: "turn", source: "server" }), true);
    assert.deepEqual(calls, ["owner:turn", "view:start", "begin-runtime"]);

    calls.length = 0;
    assert.equal(composition.handleEvent({ type: "error", message: "ownerless" }), true);
    assert.equal(current, "turn");
    assert.deepEqual(calls, ["runtime:error", "view:error:preserve=true"]);

    for (const terminal of [
      { type: "done", turnId: "turn", finishReason: "stop" },
      { type: "done", turnId: "turn", finishReason: "max_steps" },
      { type: "done", turnId: "turn", finishReason: "aborted", aborted: true },
      { type: "error", turnId: "turn", message: "failed" },
    ] satisfies PresentationFrame[]) {
      current = "turn";
      calls.length = 0;
      assert.equal(composition.handleEvent(terminal), true);
      assert.deepEqual(calls, [
        `runtime:${terminal.type}`,
        "owner:null",
        terminal.type === "error" ? "view:error:preserve=false" : "view:done",
      ]);
    }
  });

  it("T-Composition.2: Pause selects live abort or exact workflow cancellation and rejects false envelopes", async () => {
    // Given live, successful no-live, false-envelope, and thrown cancellation states, when Pause runs, then exact command/arguments and failure outcomes are preserved.
    const module = await loadAppComposition();
    for (const scenario of [
      { current: "turn", response: { ok: true } as WorkflowCancelResult, expected: "stopped" },
      { current: null, response: { ok: true } as WorkflowCancelResult, expected: "workflow_cancelled" },
      {
        current: null,
        response: { ok: false, reason: "no_workflow" } as WorkflowCancelResult,
        expected: "workflow_cancel_rejected",
      },
    ] as const) {
      const calls: string[] = [];
      const composition = module.createAssistantAppComposition({
        runtime: inertRuntime({
          pause: async () => {
            calls.push("runtime-pause");
            return "stopped";
          },
        }),
        getCurrentTurnId: () => scenario.current,
        setCurrentTurnId: () => undefined,
        getWorkflowId: () => "wf-123",
        invoke: async (command, args) => {
          calls.push(`invoke:${command}:${JSON.stringify(args)}`);
          return scenario.response as never;
        },
        onTurnStartedView: () => undefined,
        onDoneView: () => undefined,
        onErrorView: () => undefined,
        reportFailure: (error) => calls.push(`failure:${String(error)}`),
      });
      assert.equal(await composition.pause(), scenario.expected);
      assert.deepEqual(
        calls,
        scenario.current === "turn"
          ? ["runtime-pause"]
          : [
              'invoke:frondose_workflow_cancel:{"workflowId":"wf-123"}',
              ...(scenario.response.ok ? [] : ["failure:no_workflow"]),
            ],
      );
    }

    const thrownCalls: string[] = [];
    const thrown = module.createAssistantAppComposition({
      runtime: inertRuntime(),
      getCurrentTurnId: () => null,
      setCurrentTurnId: () => undefined,
      getWorkflowId: () => null,
      invoke: async (command, args) => {
        thrownCalls.push(`invoke:${command}:${JSON.stringify(args)}`);
        throw new Error("cancel failed");
      },
      onTurnStartedView: () => undefined,
      onDoneView: () => undefined,
      onErrorView: () => undefined,
      reportFailure: (error) => thrownCalls.push(`failure:${String(error)}`),
    });
    assert.equal(await thrown.pause(), "workflow_cancel_rejected");
    assert.deepEqual(thrownCalls, [
      'invoke:frondose_workflow_cancel:{"workflowId":""}',
      "failure:Error: cancel failed",
    ]);
  });
});

describe("owned abort rejection remains generation-safe", () => {
  it("T-FE.2: delayed Pause/stop/steer promise rejection is stale after ownership changes", async () => {
    // Given each abort path rejects only after a replacement owns the UI, when the rejection arrives, then it is stale and cannot report or dispatch any old-turn side effect.
    const module = await loadInterruptionController();
    for (const method of ["pause", "stop", "steer"] as const) {
      let current: string | null = "old";
      let rejectAbort!: (error: Error) => void;
      const pendingAbort = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const calls: string[] = [];
      const controller = module.createTurnInterruptionController({
        getCurrentTurnId: () => current,
        invoke: async () => pendingAbort,
        settleOwned: () => calls.push("settled"),
        appendStoppedText: () => calls.push("stopped-text"),
        startReplacement: async () => {
          calls.push("replacement");
        },
        reportFailure: () => calls.push("failure"),
      });
      const result = method === "pause" ? controller.pause() : controller[method]("payload");
      current = "new";
      rejectAbort(new Error("late failure"));
      assert.equal(await result, "stale");
      assert.deepEqual(calls, []);
      assert.equal(current, "new");
    }
  });
});
