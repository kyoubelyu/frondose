/**
 * P-UI-THINK-COMPACT — Step 3a RED: shipped app dependency composition.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/ui/assistantAppDependencies-pUiThinkCompact.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

type AppState = "idle" | "running" | "error";
type TurnResponse = { ok: true; turnId: string } | { ok: false; reason: string };
type LifecycleFrame = { type: "turn-started"; turnId: string; source: string };
type DoneFrame = { type: "done"; turnId: string; finishReason: string; aborted?: boolean };
type ErrorFrame = { type: "error"; turnId?: string; message: string; retryable?: boolean };
type AppDependencies = {
  getCurrentTurnId(): string | null;
  setCurrentTurnId(turnId: string | null): void;
  requestAnimationFrame(callback: () => void): number;
  scrollToBottom(): void;
  settleOwned(turnId: string): void;
  appendStoppedText(text: string): void;
  startReplacement(text: string): Promise<void>;
  reportFailure(error: unknown): void;
  onTurnStartedView(frame: LifecycleFrame): void;
  onDoneView(frame: DoneFrame): void;
  onErrorView(frame: ErrorFrame, preserveRunning?: boolean): void;
};
type AppDependenciesModule = {
  createAssistantAppDependencies(deps: {
    getCurrentTurnId: () => string | null;
    setCurrentTurnId: (turnId: string | null) => void;
    getLastTurnPrompt: () => string | null;
    setLastTurnPrompt: (prompt: string | null) => void;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    requestAnimationFrame: (callback: () => void) => number;
    scrollToBottom: () => void;
    endAgentBubble: () => void;
    appendUserBubble: (text: string) => void;
    setTicker: (text: string) => void;
    setError: (text: string) => void;
    setRetryVisible: (visible: boolean) => void;
    setCommand: (text: string) => void;
    transition: (state: AppState) => void;
    translate: (key: string, vars?: Record<string, string | number>) => string;
    surfaceFailure: (label: string, error: unknown) => void;
  }): AppDependencies;
};
type Runtime = {
  beginTurn(): void;
  handleEvent(frame: unknown): "ignored" | "progress" | "final" | "terminal";
  pause(): Promise<unknown>;
  stop(text: string): Promise<unknown>;
  steer(text: string): Promise<unknown>;
};
type RuntimeModule = {
  createAssistantTurnRuntime(deps: {
    document: unknown;
    conversationList: unknown;
    getCurrentTurnId: () => string | null;
    requestAnimationFrame: (callback: () => void) => number;
    scrollToBottom: () => void;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    settleOwned: (turnId: string) => void;
    appendStoppedText: (text: string) => void;
    startReplacement: (text: string) => Promise<void>;
    reportFailure: (error: unknown) => void;
  }): Runtime;
};
type CompositionModule = {
  createAssistantAppComposition(deps: {
    runtime: Runtime;
    getCurrentTurnId: () => string | null;
    setCurrentTurnId: (turnId: string | null) => void;
    getWorkflowId: () => string | null;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    onTurnStartedView: AppDependencies["onTurnStartedView"];
    onDoneView: AppDependencies["onDoneView"];
    onErrorView: AppDependencies["onErrorView"];
    reportFailure: AppDependencies["reportFailure"];
  }): {
    handleEvent(frame: LifecycleFrame | ErrorFrame): boolean;
    pause(): Promise<unknown>;
  };
};

interface FakeEl {
  classes: Set<string>;
  attrs: Record<string, string>;
  children: FakeEl[];
  text: string | null;
}

function makeEl(): FakeEl {
  return { classes: new Set(), attrs: {}, children: [], text: null };
}

// biome-ignore lint/suspicious/noExplicitAny: recording DOM structurally implements the production leaf contract.
function wrap(element: FakeEl): any {
  return {
    __fake: element,
    classList: {
      add: (...tokens: string[]) =>
        tokens.forEach((token) => {
          element.classes.add(token);
        }),
      remove: (...tokens: string[]) =>
        tokens.forEach((token) => {
          element.classes.delete(token);
        }),
      toggle: (token: string, force?: boolean) => {
        const enabled = force ?? !element.classes.has(token);
        if (enabled) element.classes.add(token);
        else element.classes.delete(token);
        return enabled;
      },
    },
    setAttribute: (name: string, value: string) => {
      element.attrs[name] = value;
    },
    appendChild: (child: { __fake: FakeEl }) => {
      element.children.push(child.__fake);
    },
    get textContent() {
      return element.text;
    },
    set textContent(value: string | null) {
      element.text = value;
    },
  };
}

function recordingDom(): { document: unknown; list: ReturnType<typeof wrap> } {
  const list = wrap(makeEl());
  return {
    document: { createElement: () => wrap(makeEl()) },
    list,
  };
}

async function loadModule(): Promise<AppDependenciesModule> {
  return (await import(
    pathToFileURL(resolve("src/tauri/ui/app/assistantAppDependencies.js")).href
  )) as AppDependenciesModule;
}

async function loadRuntime(): Promise<RuntimeModule> {
  return (await import(pathToFileURL(resolve("src/tauri/ui/app/assistantTurnRuntime.js")).href)) as RuntimeModule;
}

async function loadComposition(): Promise<CompositionModule> {
  return (await import(
    pathToFileURL(resolve("src/tauri/ui/app/assistantAppComposition.js")).href
  )) as CompositionModule;
}

function fixture(module: AppDependenciesModule, invokeImpl?: (command: string) => Promise<TurnResponse>) {
  let current: string | null = "turn";
  let lastPrompt: string | null = "original";
  let raf: (() => void) | null = null;
  const calls: string[] = [];
  const dependencies = module.createAssistantAppDependencies({
    getCurrentTurnId: () => current,
    setCurrentTurnId: (turnId) => {
      current = turnId;
      calls.push(`owner:${turnId ?? "null"}`);
    },
    getLastTurnPrompt: () => lastPrompt,
    setLastTurnPrompt: (prompt) => {
      lastPrompt = prompt;
      calls.push(`prompt:${prompt ?? "null"}`);
    },
    invoke: async (command, args) => {
      calls.push(`invoke:${command}:${JSON.stringify(args)}`);
      return (await (invokeImpl?.(command) ?? Promise.resolve({ ok: true, turnId: "replacement" }))) as never;
    },
    requestAnimationFrame: (callback) => {
      raf = callback;
      calls.push("raf");
      return 17;
    },
    scrollToBottom: () => calls.push("scroll"),
    endAgentBubble: () => calls.push("end"),
    appendUserBubble: (text) => calls.push(`user:${text}`),
    setTicker: (text) => calls.push(`ticker:${text}`),
    setError: (text) => calls.push(`error:${text}`),
    setRetryVisible: (visible) => calls.push(`retry:${visible}`),
    setCommand: (text) => calls.push(`command:${text}`),
    transition: (state) => calls.push(`state:${state}`),
    translate: (key, vars) => {
      if (key === "reason.aborted") return "aborted";
      if (key === "action.turn") return "Run turn";
      if (key === "action.pauseAbort") return "Pause/abort";
      return `${key}:${JSON.stringify(vars ?? {})}`;
    },
    surfaceFailure: (label, error) => calls.push(`failure:${label}:${String(error)}`),
  });
  return {
    dependencies,
    calls,
    getCurrent: () => current,
    setCurrent: (value: string | null) => {
      current = value;
    },
    getLastPrompt: () => lastPrompt,
    flushRaf: () => raf?.(),
  };
}

describe("shipped app dependencies preserve concrete lifecycle behavior", () => {
  it("T-AppDeps.1: start, done, and error callbacks drive the real view contract", async () => {
    // Given concrete app state/view adapters, when lifecycle callbacks run, then each visible and durable mutation occurs in exact order.
    const module = await loadModule();
    const f = fixture(module);
    assert.equal(f.dependencies.getCurrentTurnId(), "turn");
    f.dependencies.setCurrentTurnId("server");
    assert.equal(f.getCurrent(), "server");

    f.calls.length = 0;
    f.dependencies.onTurnStartedView({ type: "turn-started", turnId: "server", source: "cron" });
    assert.deepEqual(f.calls, ["ticker:ticker.cronRunning:{}", "state:running"]);

    f.calls.length = 0;
    f.dependencies.onDoneView({ type: "done", turnId: "server", finishReason: "stop" });
    assert.deepEqual(f.calls, [
      'ticker:ticker.done:{"reason":"stop"}',
      "retry:false",
      "error:",
      "prompt:null",
      "state:idle",
    ]);
    assert.equal(f.getLastPrompt(), null);

    f.calls.length = 0;
    f.dependencies.onDoneView({ type: "done", turnId: "server", finishReason: "aborted", aborted: true });
    assert.deepEqual(f.calls, ['ticker:ticker.done:{"reason":"aborted"}', "state:idle"]);

    f.calls.length = 0;
    f.dependencies.onErrorView({ type: "error", turnId: "server", message: "boom", retryable: true });
    assert.deepEqual(f.calls, ["retry:true", 'error:error.agent:{"msg":"boom"}', "state:error"]);

    f.calls.length = 0;
    f.dependencies.onErrorView({ type: "error", message: "ownerless" }, true);
    assert.deepEqual(f.calls, ["retry:false", "state:running", 'error:error.agent:{"msg":"ownerless"}']);
  });

  it("T-AppDeps.2: owned settlement, stopped annotation, rAF, scrolling, and failure reporting are real", async () => {
    // Given the exact callbacks consumed by runtime/interruption, when they execute, then ownership, rendering, scheduling, and error surfacing cannot be replaced by inert test doubles.
    const module = await loadModule();
    const f = fixture(module);
    assert.equal(
      f.dependencies.requestAnimationFrame(() => f.calls.push("paint")),
      17,
    );
    f.dependencies.scrollToBottom();
    f.flushRaf();
    assert.deepEqual(f.calls.slice(-3), ["raf", "scroll", "paint"]);

    f.calls.length = 0;
    f.dependencies.settleOwned("stale");
    assert.deepEqual(f.calls, []);
    f.dependencies.settleOwned("turn");
    assert.deepEqual(f.calls, ["end", "owner:null", "state:idle"]);
    assert.equal(f.getCurrent(), null);

    f.calls.length = 0;
    f.dependencies.appendStoppedText("停止");
    assert.deepEqual(f.calls, [
      "user:停止",
      "end",
      'ticker:ticker.done:{"reason":"aborted"}',
      "command:",
      "state:idle",
    ]);

    f.calls.length = 0;
    const error = new Error("abort failed");
    f.dependencies.reportFailure(error);
    assert.deepEqual(f.calls, ["failure:Pause/abort:Error: abort failed"]);
  });

  it("T-AppDeps.3: replacement dispatch owns exact command, success state, and rejection surface", async () => {
    // Given successful and rejected replacement turns, when steer starts them, then exact invoke arguments and all resulting view/owner mutations are observable.
    const module = await loadModule();
    const success = fixture(module);
    success.setCurrent(null);
    success.calls.length = 0;
    await success.dependencies.startReplacement("next task");
    assert.deepEqual(success.calls, [
      'invoke:frondose_agent_turn:{"prompt":"next task"}',
      "owner:replacement",
      "prompt:next task",
      "user:next task",
      "ticker:ticker.starting:{}",
      "command:",
      "state:running",
    ]);

    const rejected = fixture(module, async () => ({ ok: false, reason: "busy" }));
    rejected.setCurrent(null);
    rejected.calls.length = 0;
    await assert.rejects(rejected.dependencies.startReplacement("next task"), /busy/);
    assert.deepEqual(rejected.calls, [
      'invoke:frondose_agent_turn:{"prompt":"next task"}',
      "failure:Run turn:Error: busy",
    ]);
    assert.equal(rejected.getCurrent(), null);
  });
});

describe("complete shipped assistant graph has one turn-start owner", () => {
  it("T-AppDeps.Graph: one turn-started mounts exactly one bubble and invokes runtime start once", async () => {
    // Given the real dependency, runtime, and composition modules, when one turn starts, then the view updates state while only runtime owns bubble creation.
    const [dependenciesModule, runtimeModule, compositionModule] = await Promise.all([
      loadModule(),
      loadRuntime(),
      loadComposition(),
    ]);
    const dom = recordingDom();
    let current: string | null = null;
    let appState: AppState = "idle";
    let visibleError = "";
    const viewCalls: string[] = [];
    const invoke = async <T>(command: string) => {
      viewCalls.push(`invoke:${command}`);
      return { ok: true } as unknown as T;
    };
    const appDependencies = dependenciesModule.createAssistantAppDependencies({
      getCurrentTurnId: () => current,
      setCurrentTurnId: (turnId) => {
        current = turnId;
      },
      getLastTurnPrompt: () => null,
      setLastTurnPrompt: () => undefined,
      invoke,
      requestAnimationFrame: (callback) => {
        callback();
        return 1;
      },
      scrollToBottom: () => undefined,
      endAgentBubble: () => undefined,
      appendUserBubble: () => undefined,
      setTicker: (text) => viewCalls.push(`ticker:${text}`),
      setError: (text) => {
        visibleError = text;
        viewCalls.push(`error:${text}`);
      },
      setRetryVisible: (visible) => viewCalls.push(`retry:${visible}`),
      setCommand: () => undefined,
      transition: (state) => {
        appState = state;
        viewCalls.push(`state:${state}`);
      },
      translate: (key) => key,
      surfaceFailure: () => undefined,
    });
    const realRuntime = runtimeModule.createAssistantTurnRuntime({
      document: dom.document,
      conversationList: dom.list,
      getCurrentTurnId: appDependencies.getCurrentTurnId,
      requestAnimationFrame: appDependencies.requestAnimationFrame,
      scrollToBottom: appDependencies.scrollToBottom,
      invoke,
      settleOwned: appDependencies.settleOwned,
      appendStoppedText: appDependencies.appendStoppedText,
      startReplacement: appDependencies.startReplacement,
      reportFailure: appDependencies.reportFailure,
    });
    let startCalls = 0;
    const runtime: Runtime = {
      ...realRuntime,
      beginTurn: () => {
        startCalls += 1;
        realRuntime.beginTurn();
      },
    };
    const composition = compositionModule.createAssistantAppComposition({
      runtime,
      getCurrentTurnId: appDependencies.getCurrentTurnId,
      setCurrentTurnId: appDependencies.setCurrentTurnId,
      getWorkflowId: () => null,
      invoke,
      onTurnStartedView: appDependencies.onTurnStartedView,
      onDoneView: appDependencies.onDoneView,
      onErrorView: appDependencies.onErrorView,
      reportFailure: appDependencies.reportFailure,
    });

    assert.equal(composition.handleEvent({ type: "turn-started", turnId: "turn", source: "server" }), true);
    assert.equal(startCalls, 1);
    assert.equal(dom.list.__fake.children.length, 1);
    assert.equal(dom.list.__fake.children[0]?.classes.has("msg-agent"), true);
    assert.deepEqual(viewCalls, ["ticker:ticker.starting", "state:running"]);

    viewCalls.length = 0;
    assert.equal(composition.handleEvent({ type: "error", message: "ownerless" }), true);
    assert.equal(current, "turn");
    assert.equal(appState, "running");
    assert.equal(visibleError, "error.agent");
    assert.deepEqual(viewCalls, ["retry:false", "state:running", "error:error.agent"]);

    viewCalls.length = 0;
    assert.equal(await composition.pause(), "stopped");
    assert.equal(current, null);
    assert.equal(appState, "idle");
    assert.deepEqual(viewCalls, ["invoke:frondose_agent_abort", "state:idle"]);
  });
});

describe("app.ts binds every concrete assistant dependency to the executable production seam", () => {
  it("T-AppDeps.Wire: no assistant lifecycle or interruption dependency remains test-supplied only", () => {
    // Given the shipped composition root, when its factory calls are inspected, then actual owner, rAF, view, settlement, replacement, and failure callbacks all flow through assistantAppDependencies.
    const source = readFileSync(resolve("src/tauri/ui/app.ts"), "utf8");
    const factoryStart = source.indexOf("createAssistantAppDependencies({");
    const factoryEnd = source.indexOf("\n});", factoryStart);
    assert.ok(factoryStart >= 0 && factoryEnd > factoryStart, "real dependency factory call must exist");
    const factoryCall = source.slice(factoryStart, factoryEnd);
    assert.match(factoryCall, /getCurrentTurnId:\s*\(\)\s*=>\s*currentTurnId/);
    assert.match(factoryCall, /setCurrentTurnId:\s*\(turnId\)\s*=>\s*\{?\s*currentTurnId\s*=\s*turnId/);
    assert.match(factoryCall, /getLastTurnPrompt:\s*\(\)\s*=>\s*lastTurnPrompt/);
    assert.match(factoryCall, /setLastTurnPrompt:\s*\(prompt\)\s*=>\s*\{?\s*lastTurnPrompt\s*=\s*prompt/);
    assert.match(factoryCall, /\binvoke\s*,/);
    assert.match(factoryCall, /requestAnimationFrame:\s*windowRef\.requestAnimationFrame\.bind\(windowRef\)/);
    assert.match(factoryCall, /scrollToBottom:\s*scrollToBottomIfPinned/);
    assert.match(factoryCall, /endAgentBubble:\s*assistantTurnController\.endTurn/);
    assert.match(factoryCall, /appendUserBubble:\s*appendUserBubble/);
    assert.match(factoryCall, /setTicker:[\s\S]*tickerEl\.textContent/);
    assert.match(factoryCall, /setError:[\s\S]*errorBannerEl\.textContent[\s\S]*classList\.toggle\("hidden"/);
    assert.match(factoryCall, /setRetryVisible:[\s\S]*retryBtnEl\.classList/);
    assert.match(factoryCall, /setCommand:[\s\S]*commandEl\.value/);
    assert.match(factoryCall, /\btransition\s*,/);
    assert.match(factoryCall, /translate:\s*t/);
    assert.match(factoryCall, /surfaceFailure:\s*surfaceError/);
    assert.doesNotMatch(factoryCall, /beginAgentBubble/);
    assert.match(
      source,
      /createAssistantTurnRuntime\(\{[\s\S]*requestAnimationFrame:\s*assistantAppDependencies\.requestAnimationFrame/,
    );
    assert.match(source, /settleOwned:\s*assistantAppDependencies\.settleOwned/);
    assert.match(source, /appendStoppedText:\s*assistantAppDependencies\.appendStoppedText/);
    assert.match(source, /startReplacement:\s*assistantAppDependencies\.startReplacement/);
    assert.match(source, /reportFailure:\s*assistantAppDependencies\.reportFailure/);
    assert.match(
      source,
      /createAssistantAppComposition\(\{[\s\S]*onTurnStartedView:\s*assistantAppDependencies\.onTurnStartedView/,
    );
    assert.match(source, /onDoneView:\s*assistantAppDependencies\.onDoneView/);
    assert.match(source, /onErrorView:\s*assistantAppDependencies\.onErrorView/);
    assert.match(source, /if\s*\(assistantAppComposition\.handleEvent\(payload\)\)\s*return/);
    assert.match(source, /assistantAppComposition\.pause\(\)/);
    assert.match(source, /assistantAppComposition\.dispatchRunning\(/);
    assert.doesNotMatch(
      source,
      /case "(?:text|reasoning|turn-started|done|error)":|function (?:beginAgentBubble|endAgentBubble|appendAgentChunk|appendReasoningChunk|abortTurn|performSteer)|createRunningComposerController|runningComposerController|waitForDoneSse|invoke\("frondose_agent_abort"\)/,
    );
  });
});
