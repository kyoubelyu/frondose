/**
 * P-UI-THINK-COMPACT — Step 3a RED: Pi classification, completion, and app history.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/agent/pi/assistantPhaseText-pUiThinkCompact.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { CoreMessage, ToolSet } from "ai";

type Phase = "intermediate" | "final";
type Completion = { finishReason: "stop" | "max_steps" | "aborted" };
type RunPi = (opts: {
  model: unknown;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (toolName: string) => void;
  onAssistantPhaseText?: (text: string, phase: Phase) => void;
  assistantHistory?: "all" | "final-only";
}) => Promise<Completion>;
type MockStream = AsyncIterable<AssistantMessageEvent> & { result: () => Promise<AssistantMessage> };

let runAgentLoopPi: RunPi | null = null;
let runAgentLoopCompat: RunPi | null = null;
let queued: AssistantMessage[] = [];
let streamIndex = 0;
let modelInputs: unknown[] = [];
let throwAfterMessages: number | null = null;

const LEGACY_D12_CONTINUATION: CoreMessage = {
  role: "user",
  content:
    "Continue — execute the action you just announced. Call the next tool NOW; do not narrate further. " +
    "If you said you'd plan, call `todo_write`. If you said you'd draft, call `save_message_draft`. " +
    "If you said you'd click/type/inspect, call that tool. No more 'Let me…' or 'I'll…' prose this turn.",
};
const LEGACY_D22_CONTINUATION: CoreMessage = {
  role: "user",
  content:
    "You stopped without completing the task. Call your next planned tool NOW. " +
    "Look at the workflow plan you declared with `todo_write` (if any) and execute the next in_progress step. " +
    "If the page is blank, call `navigate_to_url` to my LinkedIn feed. " +
    "If you don't know what to do next, call `escalate_for_capability` with a clear question OR call `end_auto_run` (if an auto run is active) OR `stop`. " +
    "Do NOT respond with text only — call a tool.",
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function doneStream(message: AssistantMessage): MockStream {
  return {
    [Symbol.asyncIterator]: () =>
      (async function* () {
        yield { type: "start", partial: assistant([], "stop") } as unknown as AssistantMessageEvent;
        yield { type: "done", reason: message.stopReason, message } as unknown as AssistantMessageEvent;
      })(),
    result: async () => message,
  };
}

function toolPhase(text: string, index: number, name = "mock_tool"): AssistantMessage {
  return assistant(
    [
      { type: "text", text },
      { type: "toolCall", id: `tc-${index}`, name, arguments: {} },
    ],
    "toolUse",
  );
}

function multiTextToolPhase(index: number): AssistantMessage {
  return assistant(
    [
      { type: "text", text: "work-1a" },
      { type: "text", text: "work-1b" },
      { type: "toolCall", id: `tc-${index}`, name: "mock_tool", arguments: {} },
    ],
    "toolUse",
  );
}

function textPhase(text: string): AssistantMessage {
  return assistant([{ type: "text", text }], "stop");
}

function multiTextFinalPhase(first: string, second: string): AssistantMessage {
  return assistant(
    [
      { type: "text", text: first },
      { type: "text", text: second },
    ],
    "stop",
  );
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function multiToolPhase(): AssistantMessage {
  return assistant(
    [
      { type: "text", text: "MULTI-PRIVATE" },
      { type: "toolCall", id: "tc-first", name: "first_tool", arguments: {} },
      { type: "toolCall", id: "tc-second", name: "second_tool", arguments: {} },
    ],
    "toolUse",
  );
}

function coreToolAssistant(id: string, text?: string): CoreMessage {
  return {
    role: "assistant",
    content: [
      ...(text === undefined ? [] : [{ type: "text" as const, text }]),
      { type: "tool-call", toolCallId: id, toolName: "mock_tool", args: {} },
    ],
  };
}

function coreUnknownToolResult(id: string): CoreMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "mock_tool",
        result: { ok: false, error: "unknown tool: mock_tool" },
        isError: true,
      },
    ],
  };
}

function coreSuccessfulToolResult(id: string, toolName: string, marker: string): CoreMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName,
        result: { ok: true, marker },
        isError: false,
      },
    ],
  };
}

function coreText(text: string): CoreMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

before(async () => {
  mock.module(import.meta.resolve("@earendil-works/pi-ai"), {
    namedExports: {
      stream: (_model: unknown, context: unknown) => {
        modelInputs.push(JSON.parse(JSON.stringify(context)));
        if (throwAfterMessages !== null && streamIndex >= throwAfterMessages) {
          throw new Error("PROVIDER_FAILURE");
        }
        const message = queued[Math.min(streamIndex, queued.length - 1)];
        streamIndex += 1;
        assert.ok(message, "test must queue at least one assistant message");
        return doneStream(message);
      },
    },
  });
  mock.module(new URL("../../../src/agent/pi/model.js", import.meta.url).href, {
    namedExports: {
      LLM_COMPLETE_TIMEOUT_MS: 120_000,
      LLM_STREAM_IDLE_MS: 5_000,
      LLM_STREAM_MAX_RETRIES: 1,
      resolvePiModel: () => ({
        model: { id: "deepseek-test", api: "openai-completions" },
        apiKey: "test-key",
        reasoningLevel: "low",
        timeoutMs: 120_000,
      }),
    },
  });
  const loop = await import("../../../src/agent/pi/loop.js");
  runAgentLoopPi = loop.runAgentLoopPi as unknown as RunPi;
  const compatLoop = await import("../../../src/agent/loop.js");
  runAgentLoopCompat = compatLoop.runAgentLoop as unknown as RunPi;
});

beforeEach(() => {
  queued = [];
  streamIndex = 0;
  modelInputs = [];
  throwAfterMessages = null;
});

async function run(args: {
  maxSteps: number;
  messages?: CoreMessage[];
  abortSignal?: AbortSignal;
  assistantHistory?: "all" | "final-only";
  tools?: ToolSet;
  onText?: (text: string) => void;
  onToolCall?: (toolName: string) => void;
  onAssistantPhaseText?: (text: string, phase: Phase) => void;
}): Promise<{ completion: Completion; messages: CoreMessage[] }> {
  assert.ok(runAgentLoopPi, "real Pi loop must import");
  const messages = args.messages ?? [{ role: "user", content: "go" }];
  const completion = await runAgentLoopPi({
    model: {},
    system: "system",
    messages,
    tools: args.tools ?? {},
    maxSteps: args.maxSteps,
    abortSignal: args.abortSignal,
    assistantHistory: args.assistantHistory,
    onText: args.onText,
    onToolCall: args.onToolCall,
    onAssistantPhaseText: args.onAssistantPhaseText,
  });
  return { completion, messages };
}

describe("Pi classifies only after every continuation decision", () => {
  it("T-PhaseText.1: ordinary tool-use phases are intermediate and the terminal phase is final", async () => {
    // Given enough steps to avoid D-22, when the real loop stops naturally, then only its last no-tool phase is final.
    queued = [
      multiTextToolPhase(1),
      toolPhase("work-2", 2),
      toolPhase("work-3", 3),
      toolPhase("work-4", 4),
      multiTextFinalPhase("FINAL-A", "FINAL-B"),
    ];
    const classified: Array<[string, Phase]> = [];
    const legacy: string[] = [];
    const { completion } = await run({
      maxSteps: 5,
      onText: (text) => legacy.push(text),
      onAssistantPhaseText: (text, phase) => classified.push([text, phase]),
    });
    assert.deepEqual(classified, [
      ["work-1awork-1b", "intermediate"],
      ["work-2", "intermediate"],
      ["work-3", "intermediate"],
      ["work-4", "intermediate"],
      ["FINAL-AFINAL-B", "final"],
    ]);
    assert.deepEqual(legacy, ["work-1a", "work-1b", "work-2", "work-3", "work-4", "FINAL-A", "FINAL-B"]);
    assert.deepEqual(completion, { finishReason: "stop" });
  });

  it("T-PhaseText.2: D-12 announcement is reclassified intermediate before retry", async () => {
    // Given an action announcement with no tool and a held retry tool, when D-12 retries, then the announcement is already intermediate before that tool executes.
    const toolStarted = deferred<void>();
    const releaseTool = deferred<{ ok: true }>();
    queued = [textPhase("Let me now open the page."), toolPhase("D12-TOOL", 1, "held_tool"), textPhase("D12-FINAL")];
    const classified: Array<[string, Phase]> = [];
    const legacy: string[] = [];
    const pending = run({
      maxSteps: 3,
      tools: {
        held_tool: {
          execute: async () => {
            toolStarted.resolve();
            return releaseTool.promise;
          },
        },
      } as unknown as ToolSet,
      onText: (text) => legacy.push(text),
      onAssistantPhaseText: (text, phase) => classified.push([text, phase]),
    });
    await toolStarted.promise;
    const beforeRelease = classified.slice();
    releaseTool.resolve({ ok: true });
    await pending;
    assert.deepEqual(beforeRelease.slice(0, 1), [["Let me now open the page.", "intermediate"]]);
    assert.deepEqual(classified, [
      ["Let me now open the page.", "intermediate"],
      ["D12-TOOL", "intermediate"],
      ["D12-FINAL", "final"],
    ]);
    assert.deepEqual(legacy, ["Let me now open the page.", "D12-TOOL", "D12-FINAL"]);
  });

  it("T-PhaseText.1b: tool-use progress emits before a slow tool finishes", async () => {
    // Given a tool-use phase whose tool promise is held, when execution starts, then its aggregated intermediate text is already observable.
    const toolStarted = deferred<void>();
    const releaseTool = deferred<{ ok: true }>();
    queued = [
      toolPhase("VISIBLE-BEFORE-TOOL", 1, "held_tool"),
      toolPhase("work-2", 2),
      toolPhase("work-3", 3),
      toolPhase("work-4", 4),
      textPhase("FINAL"),
    ];
    const classified: Array<[string, Phase]> = [];
    const pending = run({
      maxSteps: 5,
      tools: {
        held_tool: {
          execute: async () => {
            toolStarted.resolve();
            return releaseTool.promise;
          },
        },
      } as unknown as ToolSet,
      onAssistantPhaseText: (text, phase) => classified.push([text, phase]),
    });
    await toolStarted.promise;
    const beforeRelease = classified.slice();
    releaseTool.resolve({ ok: true });
    await pending;
    assert.deepEqual(beforeRelease, [["VISIBLE-BEFORE-TOOL", "intermediate"]]);
  });

  it("T-PhaseText.3/4: D-22 stalled text is intermediate and legacy ordering survives retry", async () => {
    // Given prior tool use and an early no-tool stall, when D-22 retries, then stalled prose is temporary and onText stays byte-compatible.
    queued = [toolPhase("D22-FIRST", 1), textPhase("D22-STALLED"), toolPhase("D22-RETRY", 2), textPhase("D22-FINAL")];
    const classified: Array<[string, Phase]> = [];
    const legacy: string[] = [];
    await run({
      maxSteps: 4,
      onText: (text) => legacy.push(text),
      onAssistantPhaseText: (text, phase) => classified.push([text, phase]),
    });
    assert.deepEqual(classified, [
      ["D22-FIRST", "intermediate"],
      ["D22-STALLED", "intermediate"],
      ["D22-RETRY", "intermediate"],
      ["D22-FINAL", "final"],
    ]);
    assert.deepEqual(legacy, ["D22-FIRST", "D22-STALLED", "D22-RETRY", "D22-FINAL"]);
  });

  it("T-PhaseText.5: max-step and abort results are explicit and never fabricate final", async () => {
    // Given cap exhaustion and a pre-aborted turn, when each real loop returns, then their terminal reasons differ and neither emits final.
    queued = [toolPhase("AT-LIMIT", 1)];
    const capped: Array<[string, Phase]> = [];
    const cappedRun = await run({
      maxSteps: 1,
      onAssistantPhaseText: (text, phase) => capped.push([text, phase]),
    });
    assert.deepEqual(cappedRun.completion, { finishReason: "max_steps" });
    assert.deepEqual(capped, [["AT-LIMIT", "intermediate"]]);

    const controller = new AbortController();
    controller.abort();
    queued = [textPhase("MUST-NOT-RUN")];
    const aborted: Array<[string, Phase]> = [];
    const abortedRun = await run({
      maxSteps: 1,
      abortSignal: controller.signal,
      onAssistantPhaseText: (text, phase) => aborted.push([text, phase]),
    });
    assert.deepEqual(abortedRun.completion, { finishReason: "aborted" });
    assert.deepEqual(aborted, []);
  });

  it("T-PhaseText.6: compatibility wrapper returns the Pi completion unchanged", async () => {
    // Given the public compatibility delegate, when Pi completes normally, then the wrapper returns the exact structured completion instead of discarding it.
    assert.ok(runAgentLoopCompat, "compatibility loop must import");
    queued = [textPhase("WRAPPER-FINAL")];
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    const completion = await runAgentLoopCompat({
      model: {},
      system: "system",
      messages,
      tools: {},
      maxSteps: 1,
    });
    assert.deepEqual(completion, { finishReason: "stop" });
  });
});

describe("app-only final history excludes temporary assistant text", () => {
  it("T-History.1/2: committed and subsequent-turn inputs retain tool structure and final text only", async () => {
    // Given D-12 continuation under final-only history, when a second turn reuses messages, then no temporary/synthetic prose crosses turns.
    queued = [
      textPhase("Let me now open the page."),
      toolPhase("PRIVATE-TOOL-NARRATION", 1),
      multiTextFinalPhase("PUBLIC-FINAL-A", "PUBLIC-FINAL-B"),
    ];
    const first = await run({ maxSteps: 3, assistantHistory: "final-only" });
    assert.deepEqual(first.messages, [
      { role: "user", content: "go" },
      coreToolAssistant("tc-1"),
      coreUnknownToolResult("tc-1"),
      coreText("PUBLIC-FINAL-APUBLIC-FINAL-B"),
    ]);
    const committed = JSON.stringify(first.messages);
    assert.doesNotMatch(committed, /Let me now open the page|PRIVATE-TOOL-NARRATION|Continue — execute/);
    assert.match(committed, /PUBLIC-FINAL-APUBLIC-FINAL-B/);
    assert.match(committed, /tool-call/);
    assert.match(committed, /tool-result/);

    first.messages.push({ role: "user", content: "second turn" });
    queued = [textPhase("SECOND-FINAL")];
    streamIndex = 0;
    modelInputs = [];
    await run({ maxSteps: 1, messages: first.messages, assistantHistory: "final-only" });
    const subsequentInput = JSON.stringify(modelInputs[0]);
    assert.doesNotMatch(subsequentInput, /Let me now open the page|PRIVATE-TOOL-NARRATION|Continue — execute/);
    assert.match(subsequentInput, /PUBLIC-FINAL-APUBLIC-FINAL-B/);
    assert.match(subsequentInput, /toolCall|toolResult/);
  });

  it("T-History.1: D-22 stalled and synthetic continuation text are absent from final-only history", async () => {
    // Given an early tool phase followed by a D-22 stall, when final-only history commits, then every temporary retry artifact is excluded.
    queued = [
      toolPhase("D22-PRIVATE-FIRST", 1),
      textPhase("D22-PRIVATE-STALL"),
      toolPhase("D22-PRIVATE-RETRY", 2),
      textPhase("D22-PUBLIC-FINAL"),
    ];
    const { messages } = await run({ maxSteps: 4, assistantHistory: "final-only" });
    assert.deepEqual(messages, [
      { role: "user", content: "go" },
      coreToolAssistant("tc-1"),
      coreUnknownToolResult("tc-1"),
      coreToolAssistant("tc-2"),
      coreUnknownToolResult("tc-2"),
      coreText("D22-PUBLIC-FINAL"),
    ]);
    const committed = JSON.stringify(messages);
    assert.doesNotMatch(committed, /D22-PRIVATE-FIRST|D22-PRIVATE-STALL|D22-PRIVATE-RETRY|You stopped without/);
    assert.match(committed, /D22-PUBLIC-FINAL/);
  });

  it("T-History.3: in-flight abort projects only exactly matched tool-call/result pairs", async () => {
    // Given two calls where the first tool aborts in flight, when final-only history commits, then the undispatched second call is not orphaned.
    const controller = new AbortController();
    queued = [multiToolPhase()];
    const tools = {
      first_tool: {
        execute: async () => {
          controller.abort();
          return { ok: true, marker: "FIRST-RESULT" };
        },
      },
      second_tool: {
        execute: async () => ({ ok: true, marker: "MUST-NOT-RUN" }),
      },
    } as unknown as ToolSet;
    const { completion, messages } = await run({
      maxSteps: 1,
      abortSignal: controller.signal,
      assistantHistory: "final-only",
      tools,
    });
    assert.deepEqual(messages, [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-first", toolName: "first_tool", args: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-first",
            toolName: "first_tool",
            result: { ok: true, marker: "FIRST-RESULT" },
            isError: false,
          },
        ],
      },
    ]);
    assert.deepEqual(completion, { finishReason: "aborted" });
  });

  it("T-History.3b: successful multi-tool phase retains every matched pair in exact order", async () => {
    // Given two successful calls in one phase, when final-only history commits, then both call/result pairs survive before later phases.
    queued = [
      multiToolPhase(),
      toolPhase("EXTRA-2", 2),
      toolPhase("EXTRA-3", 3),
      toolPhase("EXTRA-4", 4),
      textPhase("MULTI-FINAL"),
    ];
    const tools = {
      first_tool: {
        execute: async () => ({ ok: true, marker: "FIRST-RESULT" }),
      },
      second_tool: {
        execute: async () => ({ ok: true, marker: "SECOND-RESULT" }),
      },
    } as unknown as ToolSet;
    const { completion, messages } = await run({
      maxSteps: 5,
      assistantHistory: "final-only",
      tools,
    });
    assert.deepEqual(messages, [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc-first", toolName: "first_tool", args: {} },
          { type: "tool-call", toolCallId: "tc-second", toolName: "second_tool", args: {} },
        ],
      },
      coreSuccessfulToolResult("tc-first", "first_tool", "FIRST-RESULT"),
      coreSuccessfulToolResult("tc-second", "second_tool", "SECOND-RESULT"),
      coreToolAssistant("tc-2"),
      coreUnknownToolResult("tc-2"),
      coreToolAssistant("tc-3"),
      coreUnknownToolResult("tc-3"),
      coreToolAssistant("tc-4"),
      coreUnknownToolResult("tc-4"),
      coreText("MULTI-FINAL"),
    ]);
    assert.deepEqual(completion, { finishReason: "stop" });
  });

  it("T-History.5: max-step terminal projects exact final-only history without a final", async () => {
    // Given cap exhaustion after one tool phase, when final-only cleanup runs, then matched structure survives without narration or fabricated final text.
    queued = [toolPhase("CAP-PRIVATE", 1)];
    const capped = await run({ maxSteps: 1, assistantHistory: "final-only" });
    assert.deepEqual(capped.completion, { finishReason: "max_steps" });
    assert.deepEqual(capped.messages, [
      { role: "user", content: "go" },
      coreToolAssistant("tc-1"),
      coreUnknownToolResult("tc-1"),
    ]);
  });

  it("T-History.6: provider throw projects completed tool structure through finally", async () => {
    // Given a provider throw after one completed tool phase, when final-only cleanup runs in finally, then matched structure survives without intermediate prose or fabricated final text.
    const erroredMessages: CoreMessage[] = [{ role: "user", content: "go" }];
    queued = [toolPhase("ERROR-PRIVATE", 1)];
    streamIndex = 0;
    throwAfterMessages = 1;
    await assert.rejects(
      run({
        maxSteps: 5,
        messages: erroredMessages,
        assistantHistory: "final-only",
      }),
      /PROVIDER_FAILURE/,
    );
    assert.deepEqual(erroredMessages, [
      { role: "user", content: "go" },
      coreToolAssistant("tc-1"),
      coreUnknownToolResult("tc-1"),
    ]);
  });

  it("T-History.4: default non-app history retains retry prose, synthetic continuation, and tool structure", async () => {
    // Given D-12 and D-22 continuations with no history option, when real loops commit, then legacy all-history behavior remains intact.
    queued = [
      textPhase("Let me now open DEFAULT-D12-ANNOUNCE."),
      toolPhase("DEFAULT-D12-TOOL", 9),
      textPhase("DEFAULT-D12-FINAL"),
    ];
    const d12Messages: CoreMessage[] = [{ role: "user", content: "go" }];
    await run({ maxSteps: 3, messages: d12Messages });
    assert.deepEqual(d12Messages, [
      { role: "user", content: "go" },
      coreText("Let me now open DEFAULT-D12-ANNOUNCE."),
      LEGACY_D12_CONTINUATION,
      coreToolAssistant("tc-9", "DEFAULT-D12-TOOL"),
      coreUnknownToolResult("tc-9"),
      coreText("DEFAULT-D12-FINAL"),
    ]);
    const d12Committed = JSON.stringify(d12Messages);
    assert.match(d12Committed, /DEFAULT-D12-ANNOUNCE/);
    assert.match(d12Committed, /DEFAULT-D12-TOOL/);
    assert.match(d12Committed, /DEFAULT-D12-FINAL/);
    assert.match(d12Committed, /Continue — execute the action you just announced/);

    queued = [
      toolPhase("DEFAULT-FIRST", 1),
      textPhase("DEFAULT-STALL"),
      toolPhase("DEFAULT-RETRY", 2),
      textPhase("DEFAULT-FINAL"),
    ];
    streamIndex = 0;
    const legacy: string[] = [];
    const { messages } = await run({ maxSteps: 4, onText: (text) => legacy.push(text) });
    assert.deepEqual(messages, [
      { role: "user", content: "go" },
      coreToolAssistant("tc-1", "DEFAULT-FIRST"),
      coreUnknownToolResult("tc-1"),
      coreText("DEFAULT-STALL"),
      LEGACY_D22_CONTINUATION,
      coreToolAssistant("tc-2", "DEFAULT-RETRY"),
      coreUnknownToolResult("tc-2"),
      coreText("DEFAULT-FINAL"),
    ]);
    const committed = JSON.stringify(messages);
    assert.match(committed, /DEFAULT-FIRST/);
    assert.match(committed, /DEFAULT-STALL/);
    assert.match(committed, /DEFAULT-RETRY/);
    assert.match(committed, /DEFAULT-FINAL/);
    assert.match(committed, /You stopped without completing the task/);
    assert.deepEqual(legacy, ["DEFAULT-FIRST", "DEFAULT-STALL", "DEFAULT-RETRY", "DEFAULT-FINAL"]);
  });
});
