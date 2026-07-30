import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type AbortResponse = { ok: true } | { ok: false; reason: string };
type DispatchOutcome = "empty" | "busy" | "steer" | "stopped" | "already_stopped" | "rejected";
type ControllerDeps = {
  invoke<T>(command: string): Promise<T>;
  steer(text: string): Promise<void>;
  settleStopped(text: string): void;
  reportStopFailure(error: unknown): void;
};
type StopIntentModule = {
  isExplicitStopIntent(input: string): boolean;
  createRunningComposerController(deps: ControllerDeps): {
    dispatch(input: string): Promise<DispatchOutcome>;
  };
};

const APP_PATH = fileURLToPath(new URL("../../../src/tauri/ui/app.ts", import.meta.url));
const RUNNING_COMPOSER_PATH = fileURLToPath(new URL("../../../src/tauri/ui/app/runningComposer.ts", import.meta.url));

async function loadProductionModule(): Promise<StopIntentModule> {
  return (await import(pathToFileURL(RUNNING_COMPOSER_PATH).href)) as StopIntentModule;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeHarness(overrides: Partial<ControllerDeps> = {}): {
  deps: ControllerDeps;
  calls: { invoke: string[]; steer: string[]; settled: string[]; failures: unknown[] };
} {
  const calls = { invoke: [] as string[], steer: [] as string[], settled: [] as string[], failures: [] as unknown[] };
  return {
    calls,
    deps: {
      async invoke<T>(command: string) {
        calls.invoke.push(command);
        return { ok: true } as T;
      },
      async steer(text) {
        calls.steer.push(text);
      },
      settleStopped(text) {
        calls.settled.push(text);
      },
      reportStopFailure(error) {
        calls.failures.push(error);
      },
      ...overrides,
    },
  };
}

describe("explicit stop intent classification", () => {
  it("T-Stop.Classifier.1: exact English, Chinese, and reported browser-close controls are terminal", async () => {
    // Given exact stop utterances; When the real classifier runs; Then each is consumed as stop control.
    const { isExplicitStopIntent } = await loadProductionModule();
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
    for (const input of exactStops) assert.equal(isExplicitStopIntent(input), true, input);
  });

  it("T-Stop.Classifier.2: negated, quoted, compound, and suffix-bearing prompts remain ordinary", async () => {
    // Given stop words used as data or within a compound task; When classified; Then none is consumed.
    const { isExplicitStopIntent } = await loadProductionModule();
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
    for (const input of ordinaryPrompts) assert.equal(isExplicitStopIntent(input), false, input);
  });

  it("T-Stop.Classifier.3: empty and whitespace-only input remain the distinct empty-abort path", async () => {
    // Given no utterance; When classified; Then the new explicit-stop classifier does not claim it.
    const { isExplicitStopIntent } = await loadProductionModule();
    assert.equal(isExplicitStopIntent(""), false);
    assert.equal(isExplicitStopIntent(" \n\t "), false);
  });
});

describe("real running-composer controller", () => {
  it("T-Stop.Dispatch.1: exact kill chrome performs one abort, zero steers, and one terminal settlement", async () => {
    // Given a running controller; When exact reported stop intent is dispatched; Then no replacement turn can start.
    const { createRunningComposerController } = await loadProductionModule();
    const h = makeHarness();
    const result = await createRunningComposerController(h.deps).dispatch("kill chrome");
    assert.equal(result, "stopped");
    assert.deepEqual(h.calls.invoke, ["frondose_agent_abort"]);
    assert.deepEqual(h.calls.steer, []);
    assert.deepEqual(h.calls.settled, ["kill chrome"]);
    assert.deepEqual(h.calls.failures, []);
  });

  it("T-Stop.Dispatch.2: compound text steers once without aborting or settling stop state", async () => {
    // Given a compound prompt containing stop; When dispatched; Then it remains ordinary steer only.
    const { createRunningComposerController } = await loadProductionModule();
    const h = makeHarness();
    const text = "stop researching Acme and continue with Contoso";
    assert.equal(await createRunningComposerController(h.deps).dispatch(text), "steer");
    assert.deepEqual(h.calls.invoke, []);
    assert.deepEqual(h.calls.steer, [text]);
    assert.deepEqual(h.calls.settled, []);
  });

  it("T-Stop.Dispatch.3: not_found settles only after the generation-safe backend reports no owner", async () => {
    // Given a truthful not_found response; When stop runs; Then it reports already-stopped and settles once.
    const { createRunningComposerController } = await loadProductionModule();
    const h = makeHarness({ invoke: async () => ({ ok: false, reason: "not_found" }) });
    assert.equal(await createRunningComposerController(h.deps).dispatch("停"), "already_stopped");
    assert.deepEqual(h.calls.settled, ["停"]);
    assert.deepEqual(h.calls.steer, []);
  });

  it("T-Stop.Dispatch.4: rejected and thrown aborts never settle or steer and report the failure", async () => {
    // Given server rejection and IPC failure; When stop runs; Then live UI ownership is preserved for retry.
    const { createRunningComposerController } = await loadProductionModule();
    const rejected = makeHarness({ invoke: async () => ({ ok: false, reason: "conflict" }) });
    assert.equal(await createRunningComposerController(rejected.deps).dispatch("stop"), "rejected");
    assert.deepEqual(rejected.calls.settled, []);
    assert.deepEqual(rejected.calls.steer, []);
    assert.equal(rejected.calls.failures.length, 1);

    const thrown = makeHarness({
      invoke: async () => {
        throw new Error("ipc down");
      },
    });
    assert.equal(await createRunningComposerController(thrown.deps).dispatch("stop"), "rejected");
    assert.deepEqual(thrown.calls.settled, []);
    assert.deepEqual(thrown.calls.steer, []);
    assert.match(String(thrown.calls.failures[0]), /ipc down/);
  });

  it("T-Stop.Dispatch.5: a second submission while stop is pending is busy and cannot double-abort", async () => {
    // Given a pending abort; When stop is submitted twice; Then the controller performs exactly one abort.
    const { createRunningComposerController } = await loadProductionModule();
    const gate = deferred<AbortResponse>();
    const h = makeHarness({
      invoke: async (command) => {
        h.calls.invoke.push(command);
        return gate.promise;
      },
    });
    const controller = createRunningComposerController(h.deps);
    const first = controller.dispatch("stop");
    assert.equal(await controller.dispatch("停"), "busy");
    assert.deepEqual(h.calls.invoke, ["frondose_agent_abort"]);
    gate.resolve({ ok: true });
    assert.equal(await first, "stopped");
    assert.deepEqual(h.calls.invoke, ["frondose_agent_abort"]);
  });

  it("T-Stop.Dispatch.6: empty input is reported empty without consuming the legacy empty-abort action", async () => {
    // Given whitespace input; When the controller is called; Then it performs no stop or steer side effect.
    const { createRunningComposerController } = await loadProductionModule();
    const h = makeHarness();
    assert.equal(await createRunningComposerController(h.deps).dispatch("  "), "empty");
    assert.deepEqual(h.calls.invoke, []);
    assert.deepEqual(h.calls.steer, []);
  });

  it("T-Stop.Dispatch.7: a stop submitted while ordinary steer is pending is busy and cannot race a replacement turn", async () => {
    // Given a pending ordinary steer; When exact stop is submitted; Then the controller keeps one owner and performs no abort settlement.
    const { createRunningComposerController } = await loadProductionModule();
    const gate = deferred<void>();
    const h = makeHarness({
      async steer(text) {
        h.calls.steer.push(text);
        await gate.promise;
      },
    });
    const controller = createRunningComposerController(h.deps);
    const first = controller.dispatch("continue with Contoso");
    assert.equal(await controller.dispatch("kill chrome"), "busy");
    assert.deepEqual(h.calls.steer, ["continue with Contoso"]);
    assert.deepEqual(h.calls.invoke, []);
    assert.deepEqual(h.calls.settled, []);
    gate.resolve();
    assert.equal(await first, "steer");
    assert.deepEqual(h.calls.invoke, []);
    assert.deepEqual(h.calls.settled, []);
  });
});

describe("app production wiring", () => {
  it("T-Stop.Wiring.1: only the running non-empty branch delegates once and returns before idle turn dispatch", () => {
    // Given app.ts; When its send path is audited; Then one running controller call is terminal for that branch.
    const source = readFileSync(APP_PATH, "utf8");
    const running =
      /if \(appState === "running" && currentTurnId !== null\) \{([\s\S]*?)\n {2}\}/.exec(source)?.[1] ?? "";
    assert.match(running, /await runningComposerController\.dispatch\(text\);\s*return;/);
    assert.doesNotMatch(running, /performSteer\(/);
    const idleTurn = source.indexOf('invoke<TurnResp>("frondose_agent_turn"');
    assert.ok(idleTurn > source.indexOf('if (appState === "running"'), "idle kill chrome remains on normal turn path");
  });

  it("T-Stop.Wiring.2: accepted settlement owns all terminal UI mutation; failure callback does not", () => {
    // Given controller callbacks in app.ts; When inspected; Then cleanup is confined to settleStopped.
    const source = readFileSync(APP_PATH, "utf8");
    const settle = /settleStopped:\s*\(text\)\s*=>\s*\{([\s\S]*?)\n\s*\},/.exec(source)?.[1] ?? "";
    const failure = /reportStopFailure:\s*\(error\)\s*=>\s*\{([\s\S]*?)\n\s*\},/.exec(source)?.[1] ?? "";
    assert.match(settle, /currentTurnId = null/);
    assert.match(settle, /endAgentBubble\(\)/);
    assert.match(settle, /transition\("idle"\)/);
    assert.match(settle, /commandEl\.value = ""/);
    assert.doesNotMatch(failure, /currentTurnId = null|endAgentBubble|transition\("idle"\)|commandEl\.value = ""/);
  });

  it("T-Stop.Wiring.3: controller construction passes raw invoke and maps steer only to performSteer", () => {
    // Given the complete controller construction; When audited; Then stop cannot be wired to steer as a side effect.
    const source = readFileSync(APP_PATH, "utf8");
    const construction =
      /createRunningComposerController\(\{([\s\S]*?)\n\}\);/.exec(source)?.[1] ?? "";
    assert.equal((source.match(/createRunningComposerController\(/g) ?? []).length, 1);
    assert.match(construction, /^\s*invoke,\s*$/m);
    assert.match(construction, /steer:\s*\(text\)\s*=>\s*performSteer\(text\)/);
    assert.doesNotMatch(construction, /abort:|frondose_agent_abort|frondose_agent_turn/);
    assert.equal((source.match(/runningComposerController\.dispatch\(/g) ?? []).length, 1);
  });

  it("T-Stop.Wiring.4: stale tagged errors are rejected by exact turn ownership; untagged errors still surface", () => {
    // Given the SSE error arm; When inspected; Then mismatched tagged errors break before the global path.
    const source = readFileSync(APP_PATH, "utf8");
    const arm = /case "error":([\s\S]*?)case "overlay-reconnected":/.exec(source)?.[1] ?? "";
    assert.match(arm, /if \(payload\.turnId !== undefined && payload\.turnId !== currentTurnId\) break;/);
    assert.match(arm, /errorBannerEl\.textContent/);
  });

  it("T-Stop.Wiring.5: app.ts remains at or below 800 lines with or without final newline", () => {
    // Given completed wiring; When exact logical lines are counted; Then the manual source cap holds.
    const source = readFileSync(APP_PATH, "utf8");
    const lines = source.length === 0 ? 0 : source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
    assert.ok(lines <= 800, `app.ts exceeds 800 lines: ${lines}`);
  });
});
