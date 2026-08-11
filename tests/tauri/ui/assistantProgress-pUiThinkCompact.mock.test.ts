/**
 * P-UI-THINK-COMPACT — Step 3a RED: app controller, interruption paths, compiled DOM, and layout.
 *
 * Run:
 *   npm run build:tauri-ui && node --import tsx --test --test-force-exit \
 *     tests/tauri/ui/assistantProgress-pUiThinkCompact.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import CDP from "chrome-remote-interface";
import { withOwnedChrome } from "../../_helpers/ownedBrowser.js";

type Frame =
  | { type: "assistant-progress"; turnId: string; text: string }
  | { type: "text"; turnId: string; chunk: string }
  | { type: "done"; turnId: string; finishReason: string; aborted?: boolean }
  | { type: "error"; turnId?: string; message: string };
type Outcome = "ignored" | "progress" | "final" | "terminal";
type TurnController = { handle: (frame: Frame) => Outcome };
type TurnControllerModule = {
  createAssistantTurnController: (deps: {
    document: unknown;
    conversationList: unknown;
    getCurrentTurnId: () => string | null;
    requestAnimationFrame: (callback: () => void) => number;
    scrollToBottom: () => void;
  }) => TurnController;
};
type InterruptOutcome = "stopped" | "already_stopped" | "rejected" | "stale";
type InterruptionController = {
  pause: () => Promise<InterruptOutcome>;
  stop: (text: string) => Promise<InterruptOutcome>;
  steer: (text: string) => Promise<InterruptOutcome>;
};
type InterruptionModule = {
  createTurnInterruptionController: (deps: {
    getCurrentTurnId: () => string | null;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    settleOwned: (turnId: string) => void;
    appendStoppedText: (text: string) => void;
    startReplacement: (text: string) => Promise<void>;
    reportFailure: (error: unknown) => void;
  }) => InterruptionController;
};
type RuntimeModule = {
  createAssistantTurnRuntime: (deps: {
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
  }) => {
    beginTurn: () => void;
    handleEvent: (frame: Frame) => Outcome;
    pause: () => Promise<InterruptOutcome>;
    stop: (text: string) => Promise<InterruptOutcome>;
    steer: (text: string) => Promise<InterruptOutcome>;
  };
};

interface FakeEl {
  tag: string;
  classes: Set<string>;
  attrs: Record<string, string>;
  children: FakeEl[];
  text: string | null;
}

function makeFakeEl(tag: string): FakeEl {
  return { tag, classes: new Set(), attrs: {}, children: [], text: null };
}

// biome-ignore lint/suspicious/noExplicitAny: fake structurally implements production DOM interfaces.
function wrap(fe: FakeEl): any {
  return {
    __fake: fe,
    get textContent() {
      return fe.text;
    },
    set textContent(value: string | null) {
      fe.text = value;
      fe.children = [];
    },
    classList: {
      add: (token: string) => void fe.classes.add(token),
      remove: (token: string) => void fe.classes.delete(token),
      toggle: (token: string, force?: boolean) => {
        const on = force ?? !fe.classes.has(token);
        if (on) fe.classes.add(token);
        else fe.classes.delete(token);
      },
      contains: (token: string) => fe.classes.has(token),
    },
    setAttribute: (key: string, value: string) => {
      fe.attrs[key] = value;
    },
    getAttribute: (key: string) => fe.attrs[key] ?? null,
    appendChild: (child: { __fake: FakeEl }) => {
      fe.children.push(child.__fake);
      return child;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: fake structurally implements DocumentLike.
function makeFakeDoc(): any {
  return {
    documentElement: wrap(makeFakeEl("html")),
    getElementById: () => null,
    createElement: (tag: string) => wrap(makeFakeEl(tag)),
    createElementNS: (_namespace: string, tag: string) => wrap(makeFakeEl(tag)),
  };
}

function findByClass(root: FakeEl, className: string): FakeEl[] {
  const found = root.classes.has(className) ? [root] : [];
  for (const child of root.children) found.push(...findByClass(child, className));
  return found;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function serialize(root: FakeEl): string {
  const classes = root.classes.size > 0 ? ` class="${escapeHtml([...root.classes].join(" "))}"` : "";
  const attrs = Object.entries(root.attrs)
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join("");
  const content = root.children.length > 0 ? root.children.map(serialize).join("") : escapeHtml(root.text ?? "");
  return `<${root.tag}${classes}${attrs}>${content}</${root.tag}>`;
}

async function loadTurnController(): Promise<TurnControllerModule> {
  return (await import(pathToFileURL(resolve("src/tauri/ui/assistantTurnController.js")).href)) as TurnControllerModule;
}

async function loadInterruptionController(): Promise<InterruptionModule> {
  return (await import(pathToFileURL(resolve("src/tauri/ui/app/turnInterruption.js")).href)) as InterruptionModule;
}

async function loadTurnRuntime(): Promise<RuntimeModule> {
  return (await import(pathToFileURL(resolve("src/tauri/ui/app/assistantTurnRuntime.js")).href)) as RuntimeModule;
}

describe("production app event controller owns turn gating and real final rendering", () => {
  it("T-FE.1: real current frames mutate in order while stale frames are ignored", async () => {
    // Given current and stale assistant frames, when the production composition executes, then only current content reaches its owned DOM/Markdown sinks.
    let current: string | null = "new";
    const doc = makeFakeDoc();
    const list = wrap(makeFakeEl("conversation-list"));
    const controller = (await loadTurnController()).createAssistantTurnController({
      document: doc,
      conversationList: list,
      getCurrentTurnId: () => current,
      requestAnimationFrame: (callback) => {
        callback();
        return 1;
      },
      scrollToBottom: () => undefined,
    });
    assert.equal(controller.handle({ type: "assistant-progress", turnId: "old", text: "STALE" }), "ignored");
    assert.equal(list.__fake.children.length, 0);
    assert.equal(controller.handle({ type: "assistant-progress", turnId: "new", text: "first" }), "progress");
    assert.equal(findByClass(list.__fake, "assistant-progress-text")[0]?.text, "first");
    assert.equal(controller.handle({ type: "assistant-progress", turnId: "new", text: "second" }), "progress");
    assert.equal(list.__fake.children.length, 1, "overwrite must reuse one bubble");
    assert.equal(findByClass(list.__fake, "assistant-progress-text")[0]?.text, "second");
    assert.equal(controller.handle({ type: "text", turnId: "old", chunk: "STALE-FINAL" }), "ignored");
    assert.equal(findByClass(list.__fake, "msg-agent-text")[0]?.children.length, 0);
    assert.equal(controller.handle({ type: "text", turnId: "new", chunk: "Final **Markdown**." }), "final");
    assert.equal(findByClass(list.__fake, "assistant-progress")[0]?.classes.has("hidden"), true);
    assert.equal(findByClass(list.__fake, "assistant-progress-text")[0]?.text, "");
    const bold = findByClass(list.__fake, "md-bold");
    assert.equal(bold.length, 1);
    assert.equal(bold[0]?.tag, "span");
    assert.doesNotMatch(JSON.stringify(list.__fake), /STALE|second/);
    current = "newer";
    assert.equal(controller.handle({ type: "done", turnId: "new", finishReason: "stop" }), "ignored");
  });

  it("T-FE.1/3: all owned terminals clear and final uses the real Markdown renderer", async () => {
    // Given every terminal class after visible progress, when the production composition executes, then its owned progress DOM is cleared.
    const module = await loadTurnController();
    const terminals: Frame[] = [
      { type: "done", turnId: "turn", finishReason: "stop" },
      { type: "done", turnId: "turn", finishReason: "max_steps" },
      { type: "done", turnId: "turn", finishReason: "aborted", aborted: true },
      { type: "error", turnId: "turn", message: "provider failed" },
    ];
    for (const terminal of terminals) {
      const doc = makeFakeDoc();
      const list = wrap(makeFakeEl("conversation-list"));
      const controller = module.createAssistantTurnController({
        document: doc,
        conversationList: list,
        getCurrentTurnId: () => "turn",
        requestAnimationFrame: (callback) => {
          callback();
          return 1;
        },
        scrollToBottom: () => undefined,
      });
      controller.handle({ type: "assistant-progress", turnId: "turn", text: "TEMP-SENTINEL" });
      assert.equal(controller.handle(terminal), "terminal");
      assert.equal(findByClass(list.__fake, "assistant-progress")[0]?.classes.has("hidden"), true);
      assert.equal(findByClass(list.__fake, "assistant-progress-text")[0]?.text, "");
      assert.equal(findByClass(list.__fake, "msg-agent-text")[0]?.children.length, 0);
    }
  });

  it("T-FE.1: stale and ownerless terminal matrix cannot clear current progress", async () => {
    // Given a newer current turn with visible progress, when every old/ownerless terminal arrives, then all are ignored and the newer DOM remains.
    const doc = makeFakeDoc();
    const list = wrap(makeFakeEl("conversation-list"));
    const controller = (await loadTurnController()).createAssistantTurnController({
      document: doc,
      conversationList: list,
      getCurrentTurnId: () => "new",
      requestAnimationFrame: (callback) => {
        callback();
        return 1;
      },
      scrollToBottom: () => undefined,
    });
    controller.handle({ type: "assistant-progress", turnId: "new", text: "CURRENT-PROGRESS" });
    const stale: Frame[] = [
      { type: "done", turnId: "old", finishReason: "stop" },
      { type: "done", turnId: "old", finishReason: "max_steps" },
      { type: "done", turnId: "old", finishReason: "aborted", aborted: true },
      { type: "error", turnId: "old", message: "old failure" },
      { type: "error", message: "ownerless failure" },
    ];
    for (const terminal of stale) {
      assert.equal(controller.handle(terminal), "ignored");
      assert.equal(findByClass(list.__fake, "assistant-progress")[0]?.classes.has("hidden"), false);
      assert.equal(findByClass(list.__fake, "assistant-progress-text")[0]?.text, "CURRENT-PROGRESS");
    }
  });

  it("T-FE.1: multiple final chunks coalesce into one pending rAF render with exact combined Markdown", async () => {
    // Given two final chunks before animation flush, when production composition handles them, then it schedules once and renders their combined raw buffer.
    const doc = makeFakeDoc();
    const list = wrap(makeFakeEl("conversation-list"));
    const pending: Array<() => void> = [];
    const controller = (await loadTurnController()).createAssistantTurnController({
      document: doc,
      conversationList: list,
      getCurrentTurnId: () => "turn",
      requestAnimationFrame: (callback) => {
        pending.push(callback);
        return pending.length;
      },
      scrollToBottom: () => undefined,
    });
    assert.equal(controller.handle({ type: "text", turnId: "turn", chunk: "Final **bo" }), "final");
    assert.equal(controller.handle({ type: "text", turnId: "turn", chunk: "ld**." }), "final");
    assert.equal(pending.length, 1);
    assert.equal(findByClass(list.__fake, "msg-agent-text")[0]?.children.length, 0);
    pending[0]?.();
    const bold = findByClass(list.__fake, "md-bold");
    assert.equal(bold.length, 1);
    assert.equal(bold[0]?.tag, "span");
    assert.equal(bold[0]?.text, "bold");
    const answer = findByClass(list.__fake, "msg-agent-text")[0];
    assert.equal(
      answer?.children.map((child) => child.text ?? child.children.map((part) => part.text ?? "").join("")).join(""),
      "Final bold.",
    );
  });

  it("T-FE.1: an old pending rAF flush cannot render into or suppress a replacement turn", async () => {
    // Given an old final render still queued when its turn ends and a replacement starts, when callbacks flush out of date, then the old answer is finalized and only the new callback can render the new sink.
    let current: string | null = "old";
    const doc = makeFakeDoc();
    const list = wrap(makeFakeEl("conversation-list"));
    const pending: Array<() => void> = [];
    const controller = (await loadTurnController()).createAssistantTurnController({
      document: doc,
      conversationList: list,
      getCurrentTurnId: () => current,
      requestAnimationFrame: (callback) => {
        pending.push(callback);
        return pending.length;
      },
      scrollToBottom: () => undefined,
    });
    assert.equal(controller.handle({ type: "text", turnId: "old", chunk: "Old **answer**." }), "final");
    assert.equal(pending.length, 1);
    assert.equal(controller.handle({ type: "done", turnId: "old", finishReason: "stop" }), "terminal");
    const oldAnswer = findByClass(list.__fake, "msg-agent-text")[0];
    assert.equal(findByClass(oldAnswer as FakeEl, "md-bold")[0]?.text, "answer");

    current = "new";
    assert.equal(controller.handle({ type: "text", turnId: "new", chunk: "New **answer**." }), "final");
    assert.equal(pending.length, 2);
    const answers = findByClass(list.__fake, "msg-agent-text");
    assert.equal(answers.length, 2);
    assert.equal(answers[1]?.children.length, 0);

    pending[0]?.();
    assert.equal(answers[1]?.children.length, 0, "stale callback must not touch the replacement sink");
    assert.equal(findByClass(answers[0] as FakeEl, "md-bold")[0]?.text, "answer");
    assert.equal(controller.handle({ type: "text", turnId: "new", chunk: " More." }), "final");
    assert.equal(pending.length, 2, "stale callback must not reset replacement coalescing state");

    pending[1]?.();
    assert.equal(findByClass(answers[1] as FakeEl, "md-bold")[0]?.text, "answer");
    assert.equal(
      answers[1]?.children
        .map((child) => child.text ?? child.children.map((part) => part.text ?? "").join(""))
        .join(""),
      "New answer. More.",
    );
  });
});

describe("one production interruption controller closes Pause, explicit stop, and steer", () => {
  it("T-FE.2: Pause success/not-found settles immediately, while rejection and throw preserve ownership", async () => {
    // Given all abort API outcomes, when Pause executes, then only success-like responses settle the captured turn without waiting for SSE.
    const module = await loadInterruptionController();
    for (const response of [{ ok: true }, { ok: false, reason: "not_found" }]) {
      let current: string | null = "turn";
      const calls: string[] = [];
      const controller = module.createTurnInterruptionController({
        getCurrentTurnId: () => current,
        invoke: async (command) => {
          calls.push(command);
          return response as never;
        },
        settleOwned: (turnId) => {
          calls.push(`settle:${turnId}`);
          current = null;
        },
        appendStoppedText: () => calls.push("unexpected-text"),
        startReplacement: async () => {
          calls.push("unexpected-replacement");
        },
        reportFailure: (error) => calls.push(`failure:${String(error)}`),
      });
      const outcome = await controller.pause();
      assert.equal(outcome, response.ok ? "stopped" : "already_stopped");
      assert.deepEqual(calls, ["frondose_agent_abort", "settle:turn"]);
    }

    for (const failure of [{ ok: false, reason: "denied" }, new Error("invoke failed")]) {
      const calls: string[] = [];
      const controller = module.createTurnInterruptionController({
        getCurrentTurnId: () => "turn",
        invoke: async () => {
          if (failure instanceof Error) throw failure;
          return failure as never;
        },
        settleOwned: () => calls.push("settled"),
        appendStoppedText: () => undefined,
        startReplacement: async () => undefined,
        reportFailure: (error) => calls.push(`failure:${String(error)}`),
      });
      assert.equal(await controller.pause(), "rejected");
      assert.deepEqual(calls, [`failure:${failure instanceof Error ? failure : "denied"}`]);
    }
  });

  it("T-FE.2: delayed abort response cannot settle a newer turn", async () => {
    // Given an abort response delayed until ownership changes, when it resolves, then the old request is stale and the newer turn stays untouched.
    const module = await loadInterruptionController();
    let current: string | null = "old";
    let resolveAbort!: (value: { ok: true }) => void;
    const pending = new Promise<{ ok: true }>((resolvePromise) => {
      resolveAbort = resolvePromise;
    });
    const calls: string[] = [];
    const controller = module.createTurnInterruptionController({
      getCurrentTurnId: () => current,
      invoke: async () => pending as never,
      settleOwned: (turnId) => calls.push(`settle:${turnId}`),
      appendStoppedText: () => undefined,
      startReplacement: async () => undefined,
      reportFailure: () => undefined,
    });
    const result = controller.pause();
    current = "new";
    resolveAbort({ ok: true });
    assert.equal(await result, "stale");
    assert.deepEqual(calls, []);
    assert.equal(current, "new");
  });

  it("T-FE.2: explicit stop annotates only after owned cleanup; steer cleans before replacement", async () => {
    // Given successful aborts for stop and steer, when each executes, then they share cleanup and preserve stop/replacement ordering.
    const module = await loadInterruptionController();
    let current: string | null = "stop-turn";
    const calls: string[] = [];
    const controller = module.createTurnInterruptionController({
      getCurrentTurnId: () => current,
      invoke: async () => ({ ok: true }) as never,
      settleOwned: (turnId) => {
        calls.push(`settle:${turnId}`);
        current = null;
      },
      appendStoppedText: (text) => calls.push(`stopped-text:${text}`),
      startReplacement: async (text) => {
        calls.push(`replacement:${text}`);
      },
      reportFailure: () => undefined,
    });
    assert.equal(await controller.stop("停止"), "stopped");
    assert.deepEqual(calls, ["settle:stop-turn", "stopped-text:停止"]);

    current = "steer-turn";
    calls.length = 0;
    assert.equal(await controller.steer("new task"), "stopped");
    assert.deepEqual(calls, ["settle:steer-turn", "replacement:new task"]);
  });

  it("T-FE.2: stop and steer reject or throw without settling or dispatching downstream work", async () => {
    // Given resolved rejection or thrown invoke on stop and steer, when each executes, then ownership stays intact and no downstream side effect occurs.
    const module = await loadInterruptionController();
    for (const method of ["stop", "steer"] as const) {
      for (const failure of [{ ok: false, reason: "denied" }, new Error("invoke failed")]) {
        const calls: string[] = [];
        const controller = module.createTurnInterruptionController({
          getCurrentTurnId: () => "turn",
          invoke: async () => {
            if (failure instanceof Error) throw failure;
            return failure as never;
          },
          settleOwned: () => calls.push("settled"),
          appendStoppedText: () => calls.push("stopped-text"),
          startReplacement: async () => {
            calls.push("replacement");
          },
          reportFailure: (error) => calls.push(`failure:${String(error)}`),
        });
        assert.equal(await controller[method]("payload"), "rejected");
        assert.deepEqual(calls, [`failure:${failure instanceof Error ? failure : "denied"}`]);
      }
    }
  });

  it("T-FE.2: stop and steer treat not-found as settled before their own downstream action", async () => {
    // Given backend not-found for an owned UI turn, when stop or steer executes, then each closes stale UI before annotating or replacing.
    const module = await loadInterruptionController();
    for (const method of ["stop", "steer"] as const) {
      let current: string | null = "turn";
      const calls: string[] = [];
      const controller = module.createTurnInterruptionController({
        getCurrentTurnId: () => current,
        invoke: async () => ({ ok: false, reason: "not_found" }) as never,
        settleOwned: (turnId) => {
          calls.push(`settle:${turnId}`);
          current = null;
        },
        appendStoppedText: (text) => calls.push(`stopped-text:${text}`),
        startReplacement: async (text) => {
          calls.push(`replacement:${text}`);
        },
        reportFailure: () => calls.push("failure"),
      });
      assert.equal(await controller[method]("payload"), "already_stopped");
      assert.deepEqual(calls, ["settle:turn", method === "stop" ? "stopped-text:payload" : "replacement:payload"]);
    }
  });

  it("T-FE.2: delayed stop/steer success or rejection cannot affect or report against a newer owner", async () => {
    // Given ownership changes before abort resolves, when stop/steer receive either success or rejection, then both outcomes are stale and side-effect free.
    const module = await loadInterruptionController();
    for (const method of ["stop", "steer"] as const) {
      for (const response of [{ ok: true }, { ok: false, reason: "denied" }]) {
        let current: string | null = "old";
        let resolveAbort!: (value: typeof response) => void;
        const pending = new Promise<typeof response>((resolvePromise) => {
          resolveAbort = resolvePromise;
        });
        const calls: string[] = [];
        const controller = module.createTurnInterruptionController({
          getCurrentTurnId: () => current,
          invoke: async () => pending as never,
          settleOwned: () => calls.push("settled"),
          appendStoppedText: () => calls.push("stopped-text"),
          startReplacement: async () => {
            calls.push("replacement");
          },
          reportFailure: () => calls.push("failure"),
        });
        const result = controller[method]("payload");
        current = "new";
        resolveAbort(response);
        assert.equal(await result, "stale");
        assert.deepEqual(calls, []);
        assert.equal(current, "new");
      }
    }
  });
});

describe("production app runtime composes event rendering and every interruption entrypoint", () => {
  it("T-FE.Runtime: real frames and Pause/stop/steer execute through one shipped composition factory", async () => {
    // Given the production runtime with concrete app dependencies, when all entrypoints run, then DOM rendering and interruption ordering are bound together.
    const doc = makeFakeDoc();
    const list = wrap(makeFakeEl("conversation-list"));
    let current: string | null = "turn";
    const calls: string[] = [];
    const runtime = (await loadTurnRuntime()).createAssistantTurnRuntime({
      document: doc,
      conversationList: list,
      getCurrentTurnId: () => current,
      requestAnimationFrame: (callback) => {
        callback();
        return 1;
      },
      scrollToBottom: () => undefined,
      invoke: async (command) => {
        calls.push(command);
        return { ok: true } as never;
      },
      settleOwned: (turnId) => {
        calls.push(`settle:${turnId}`);
        current = null;
      },
      appendStoppedText: (text) => calls.push(`stopped:${text}`),
      startReplacement: async (text) => {
        calls.push(`replacement:${text}`);
      },
      reportFailure: (error) => calls.push(`failure:${String(error)}`),
    });
    assert.equal(runtime.handleEvent({ type: "assistant-progress", turnId: "turn", text: "working" }), "progress");
    assert.equal(runtime.handleEvent({ type: "text", turnId: "turn", chunk: "Final **bound**." }), "final");
    assert.equal(findByClass(list.__fake, "md-bold")[0]?.text, "bound");

    assert.equal(await runtime.pause(), "stopped");
    assert.deepEqual(calls, ["frondose_agent_abort", "settle:turn"]);

    current = "stop-turn";
    calls.length = 0;
    assert.equal(await runtime.stop("停止"), "stopped");
    assert.deepEqual(calls, ["frondose_agent_abort", "settle:stop-turn", "stopped:停止"]);

    current = "steer-turn";
    calls.length = 0;
    assert.equal(await runtime.steer("replacement task"), "stopped");
    assert.deepEqual(calls, ["frondose_agent_abort", "settle:steer-turn", "replacement:replacement task"]);
  });
});

describe("compiled builder and complete shipped stylesheet enforce the physical contract", () => {
  it("T-DOM.1: compiled builder mounts one unlabeled live progress bubble with separate refs", async () => {
    // Given a recording DOM, when the compiled builder runs, then it exposes only the approved progress and answer surfaces.
    const module = (await import(pathToFileURL(resolve("src/tauri/ui/app/agentBubble.js")).href)) as {
      buildAgentBubble: (
        doc: unknown,
        list: unknown,
      ) => {
        textEl: { __fake: FakeEl };
        progressWrap: { __fake: FakeEl };
        progressTextEl: { __fake: FakeEl };
      };
    };
    const doc = makeFakeDoc();
    const list = wrap(makeFakeEl("conversation-list"));
    const refs = module.buildAgentBubble(doc, list);
    assert.notEqual(refs.textEl, refs.progressTextEl);
    assert.equal(findByClass(list.__fake, "assistant-progress").length, 1);
    assert.equal(findByClass(list.__fake, "thinking-line").length, 0);
    assert.equal(findByClass(list.__fake, "thinking-text").length, 0);
    assert.equal(refs.progressWrap.__fake.attrs["aria-live"], "polite");
    assert.equal(refs.progressWrap.__fake.attrs.role, "status");
  });

  it("T-DOM.2: real Chrome loads full shipped CSS and compiled hierarchy without moving the answer", async () => {
    // Given complete shipped style and production-builder markup, when progress changes and final inserts, then answer top stays fixed and height stays bounded.
    const htmlSource = readFileSync(resolve("src/tauri/ui/index.html"), "utf8");
    const shippedStyle = /<style>([\s\S]*?)<\/style>/u.exec(htmlSource)?.[1] ?? "";
    assert.match(shippedStyle, /\.msg-agent-body\s*\{[^}]*position:\s*relative/s);
    assert.match(shippedStyle, /\.assistant-progress\s*\{/);
    assert.match(shippedStyle, /position:\s*absolute/);
    assert.match(shippedStyle, /display:\s*-webkit-box/);
    assert.match(shippedStyle, /-webkit-box-orient:\s*vertical/);
    assert.match(shippedStyle, /-webkit-line-clamp:\s*2/);
    assert.match(shippedStyle, /overflow:\s*hidden/);
    assert.match(shippedStyle, /line-height:\s*1\.35rem/);
    assert.match(shippedStyle, /max-height:\s*2\.7rem/);

    const bubbleModule = (await import(pathToFileURL(resolve("src/tauri/ui/app/agentBubble.js")).href)) as {
      buildAgentBubble: (doc: unknown, list: unknown) => unknown;
    };
    const doc = makeFakeDoc();
    const list = wrap(makeFakeEl("conversation-list"));
    bubbleModule.buildAgentBubble(doc, list);
    const productionMarkup = list.__fake.children.map(serialize).join("");

    await withOwnedChrome(
      {
        chromeOptions: { chromeFlags: ["--headless=new", "--disable-gpu", "--no-sandbox"] },
        connect: (browser) => CDP({ port: browser.handle.port }),
        setup: async (connected) => connected.Page.enable(),
        close: (connected) => connected.close(),
      },
      async ({ client }) => {
        const { Page, Runtime } = client;
        const loaded = Page.loadEventFired();
        await Page.navigate({
          url: `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><style>${shippedStyle}</style><div id="conversation-list">${productionMarkup}</div>`)}`,
        });
        await loaded;
        const result = await Runtime.evaluate({
          returnByValue: true,
          expression: `(() => {
          const progress = document.querySelector(".assistant-progress");
          const progressText = document.querySelector(".assistant-progress-text");
          const body = document.querySelector(".msg-agent-body");
          const answer = document.querySelector(".msg-agent-text");
          const top = () => answer.getBoundingClientRect().top;
          const tops = [top()];
          progress.classList.remove("hidden");
          progressText.textContent = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
          tops.push(top());
          const computed = getComputedStyle(progress);
          const height = progress.getBoundingClientRect().height;
          const lineHeight = parseFloat(computed.lineHeight);
          const display = computed.display;
          const visibility = computed.visibility;
          const textMetrics = () => {
            const style = getComputedStyle(progressText);
            const range = document.createRange();
            range.selectNodeContents(progressText);
            const clip = progress.getBoundingClientRect();
            const visibleRects = [...range.getClientRects()].filter((rect) => {
              const visibleWidth =
                Math.min(rect.right, clip.right, window.innerWidth) -
                Math.max(rect.left, clip.left, 0);
              const visibleHeight =
                Math.min(rect.bottom, clip.bottom, window.innerHeight) -
                Math.max(rect.top, clip.top, 0);
              return visibleWidth > 0 && visibleHeight > 0;
            });
            const visibleGlyphWidth = visibleRects.reduce(
              (total, rect) =>
                total +
                Math.max(
                  0,
                  Math.min(rect.right, clip.right, window.innerWidth) -
                    Math.max(rect.left, clip.left, 0)
                ),
              0
            );
            let effectiveOpacity = 1;
            let ancestorsVisible = true;
            for (let node = progressText; node instanceof Element; node = node.parentElement) {
              const ancestorStyle = getComputedStyle(node);
              effectiveOpacity *= Number.parseFloat(ancestorStyle.opacity);
              if (ancestorStyle.display === "none" || ancestorStyle.visibility !== "visible") {
                ancestorsVisible = false;
              }
            }
            return {
              display: style.display,
              visibility: style.visibility,
              opacity: Number.parseFloat(style.opacity),
              effectiveOpacity,
              ancestorsVisible,
              color: style.color,
              width: progressText.getBoundingClientRect().width,
              visibleGlyphWidth,
              renderedLineRects: visibleRects.length
            };
          };
          const initialText = progressText.textContent;
          const initialTextHeight = progressText.getBoundingClientRect().height;
          const initialMetrics = textMetrics();
          const bodyRect = body.getBoundingClientRect();
          const progressRect = progress.getBoundingClientRect();
          const answerRect = answer.getBoundingClientRect();
          const positionedWithinBody = {
            left: progressRect.left >= bodyRect.left - 1,
            right: progressRect.right <= bodyRect.right + 1,
            top: progressRect.top >= bodyRect.top - 1,
            bottom: progressRect.bottom <= bodyRect.bottom + 1,
            answerLeft: Math.abs(progressRect.left - answerRect.left) <= 1,
            answerTop: Math.abs(progressRect.top - answerRect.top) <= 1
          };
          progressText.textContent = "replacement content intentionally longer than two rendered lines";
          tops.push(top());
          const replacementText = progressText.textContent;
          const replacementTextHeight = progressText.getBoundingClientRect().height;
          const replacementMetrics = textMetrics();
          progress.classList.add("hidden");
          tops.push(top());
          answer.innerHTML = "<p>Final <strong>answer</strong>.</p>";
          tops.push(top());
          return {
            tops,
            height,
            lineHeight,
            display,
            visibility,
            initialText,
            initialTextHeight,
            initialMetrics,
            replacementText,
            replacementTextHeight,
            replacementMetrics,
            positionedWithinBody,
            finalStrong: answer.querySelectorAll("strong").length
          };
        })()`,
        });
        const value = result.result.value as {
          tops: number[];
          height: number;
          lineHeight: number;
          display: string;
          visibility: string;
          initialText: string;
          initialTextHeight: number;
          initialMetrics: {
            display: string;
            visibility: string;
            opacity: number;
            effectiveOpacity: number;
            ancestorsVisible: boolean;
            color: string;
            width: number;
            visibleGlyphWidth: number;
            renderedLineRects: number;
          };
          replacementText: string;
          replacementTextHeight: number;
          replacementMetrics: {
            display: string;
            visibility: string;
            opacity: number;
            effectiveOpacity: number;
            ancestorsVisible: boolean;
            color: string;
            width: number;
            visibleGlyphWidth: number;
            renderedLineRects: number;
          };
          positionedWithinBody: {
            left: boolean;
            right: boolean;
            top: boolean;
            bottom: boolean;
            answerLeft: boolean;
            answerTop: boolean;
          };
          finalStrong: number;
        };
        assert.equal(new Set(value.tops).size, 1, `answer moved: ${value.tops.join(",")}`);
        assert.ok(value.height >= value.lineHeight, "visible progress must expose at least one readable line box");
        assert.ok(value.height <= value.lineHeight * 2 + 1);
        assert.notEqual(value.display, "none");
        assert.equal(value.visibility, "visible");
        assert.equal(
          value.initialText,
          "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
        );
        assert.ok(value.initialTextHeight >= value.lineHeight);
        assert.ok(value.initialTextHeight <= value.lineHeight * 2 + 1);
        assert.equal(value.replacementText, "replacement content intentionally longer than two rendered lines");
        assert.ok(value.replacementTextHeight >= value.lineHeight);
        assert.ok(value.replacementTextHeight <= value.lineHeight * 2 + 1);
        for (const metrics of [value.initialMetrics, value.replacementMetrics]) {
          assert.notEqual(metrics.display, "none");
          assert.equal(metrics.visibility, "visible");
          assert.ok(metrics.opacity > 0);
          assert.ok(metrics.effectiveOpacity > 0);
          assert.equal(metrics.ancestorsVisible, true);
          assert.notEqual(metrics.color, "transparent");
          assert.notEqual(metrics.color, "rgba(0, 0, 0, 0)");
          assert.ok(metrics.width > 0);
          assert.ok(metrics.visibleGlyphWidth > 0);
          assert.ok(metrics.renderedLineRects >= 1);
          assert.ok(metrics.renderedLineRects <= 2);
        }
        assert.deepEqual(value.positionedWithinBody, {
          left: true,
          right: true,
          top: true,
          bottom: true,
          answerLeft: true,
          answerTop: true,
        });
        assert.equal(value.finalStrong, 1);
      },
    );
  });
});
