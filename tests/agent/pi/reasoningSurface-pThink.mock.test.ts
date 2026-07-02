/**
 * P-THINK — BE mock tests: the Pi loop surfaces DeepSeek reasoning deltas via onReasoning,
 * keeps thinking OUT of the persisted CoreMessages, and the model config re-enables reasoning
 * (reasoning:true + deepseek compat + a reasoning level) with no thinking:disabled injection.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/agent/pi/reasoningSurface-pThink.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { CoreMessage, ToolSet } from "ai";

type RunPi = (opts: {
  model: unknown;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}) => Promise<void>;

type MockStream = AsyncIterable<AssistantMessageEvent> & { result: () => Promise<AssistantMessage> };

let runAgentLoopPi: RunPi | null = null;
let lastStreamOptions: Record<string, unknown> = {};
let streamHandler: () => MockStream;

before(async () => {
  const piAiUrl = import.meta.resolve("@earendil-works/pi-ai");
  mock.module(piAiUrl, {
    namedExports: {
      stream: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
        lastStreamOptions = options ?? {};
        return streamHandler();
      },
    },
  });

  const modelUrl = new URL("../../../src/agent/pi/model.js", import.meta.url).href;
  mock.module(modelUrl, {
    namedExports: {
      LLM_COMPLETE_TIMEOUT_MS: 120_000,
      LLM_STREAM_IDLE_MS: 30_000,
      LLM_STREAM_MAX_RETRIES: 2,
      resolvePiModel: () => ({
        model: { id: "deepseek-test", api: "openai-completions" },
        apiKey: "test-key",
        reasoningLevel: "low",
        timeoutMs: 120_000,
      }),
    },
  });

  const loopMod = await import("../../../src/agent/pi/loop.js");
  runAgentLoopPi = loopMod.runAgentLoopPi as RunPi;
});

beforeEach(() => {
  lastStreamOptions = {};
  streamHandler = () => thinkingThenDoneStream("reasoning-part", "final answer");
});

function assistantWith(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
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

/** A stream that emits a reasoning delta, then a text answer, then a `done` terminal event. */
function thinkingThenDoneStream(thinking: string, text: string): MockStream {
  // The native AssistantMessage keeps BOTH thinking + text parts (pi replays reasoning_content).
  const done = assistantWith([{ type: "thinking", thinking } as never, { type: "text", text }], "stop");
  return {
    [Symbol.asyncIterator]: () =>
      (async function* () {
        yield { type: "start", partial: assistantWith([], "stop") } as unknown as AssistantMessageEvent;
        yield { type: "thinking_delta", delta: thinking, contentIndex: 0, partial: done } as unknown as AssistantMessageEvent;
        yield { type: "done", reason: "stop", message: done } as unknown as AssistantMessageEvent;
      })(),
    result: async () => done,
  };
}

async function runOne(onReasoning?: (delta: string) => void, onText?: (delta: string) => void): Promise<CoreMessage[]> {
  assert.ok(runAgentLoopPi !== null, "runAgentLoopPi must be imported");
  const messages: CoreMessage[] = [{ role: "user", content: "go" }];
  await runAgentLoopPi({ model: {}, system: "system", messages, tools: {}, maxSteps: 1, onReasoning, onText });
  return messages;
}

describe("P-THINK — Pi loop surfaces reasoning deltas", () => {
  it("T-Reasoning.1: when the stream emits a thinking_delta, onReasoning is called with that delta", async () => {
    // Given: a stream that yields one thinking_delta then done.
    // When: runAgentLoopPi runs one step with an onReasoning sink (a no-tool-call turn also fires the
    //       D-22 stall continuation, so onReasoning may be called once per phase — >=1 delta total).
    // Then: onReasoning receives the reasoning delta text and nothing else.
    const reasoning: string[] = [];
    await runOne((d) => reasoning.push(d));
    assert.ok(reasoning.length >= 1, "onReasoning must be called at least once");
    assert.ok(reasoning.every((d) => d === "reasoning-part"), "onReasoning must receive the thinking_delta text");
  });

  it("T-Reasoning.2: reasoning/thinking is NOT persisted into the CoreMessages transcript", async () => {
    // Given: the assistant message carries both a thinking part and a text part.
    // When: the loop appends the assistant to opts.messages.
    // Then: the transcript contains the answer text but not the thinking text (adapter drops it).
    const messages = await runOne();
    const transcript = JSON.stringify(messages);
    assert.match(transcript, /final answer/, "the answer text must be persisted");
    assert.doesNotMatch(transcript, /reasoning-part/, "thinking must NOT be persisted to CoreMessages");
  });

  it("T-Reasoning.3: the loop passes reasoningEffort (the resolved level) into stream() to enable thinking", async () => {
    // Given: resolvePiModel returns reasoningLevel:"low".
    // When: the loop calls stream().
    // Then: the stream options carry reasoningEffort:"low" (NOT `reasoning`, which only streamSimple reads).
    await runOne();
    assert.equal(lastStreamOptions.reasoningEffort, "low", "reasoningEffort must be threaded into stream()");
  });

  it("T-Reasoning.4: onReasoning is optional — a run without the sink still completes", async () => {
    // Given: no onReasoning sink is provided.
    // When: the loop runs a reasoning-bearing turn.
    // Then: it completes and persists the answer without throwing.
    const messages = await runOne(undefined);
    assert.match(JSON.stringify(messages), /final answer/);
  });
});

describe("P-THINK — model config re-enables reasoning safely", () => {
  const modelSource = readFileSync(resolve(join(process.cwd(), "src/agent/pi/model.ts")), "utf8");

  it("T-ModelCfg.1: resolvePiModel sets reasoning:true (reverses the v0.4-fix1 disable)", () => {
    // Given/When/Then: the model literal declares reasoning true.
    assert.match(modelSource, /reasoning:\s*true/, "model.reasoning must be true");
  });

  it("T-ModelCfg.2: the deepseek compat fields are set explicitly", () => {
    // Given/When/Then: thinkingFormat "deepseek" + requiresReasoningContentOnAssistantMessages true.
    assert.match(modelSource, /thinkingFormat:\s*"deepseek"/, "compat.thinkingFormat must be deepseek");
    assert.match(
      modelSource,
      /requiresReasoningContentOnAssistantMessages:\s*true/,
      "compat.requiresReasoningContentOnAssistantMessages must be true (replays reasoning_content, avoids the turn-2 400)",
    );
  });

  it("T-ModelCfg.3: a reasoning level is exposed on the resolution", () => {
    // Given/When/Then: PiModelResolution carries reasoningLevel for the loop to pass to stream().
    assert.match(modelSource, /reasoningLevel:/, "resolution must expose reasoningLevel");
  });

  it("T-ModelCfg.4: the onPayload thinking:disabled injection is gone", () => {
    // Given/When/Then: the v0.4-fix1 thinking:{type:"disabled"} injection must no longer exist.
    assert.doesNotMatch(modelSource, /type:\s*"disabled"/, "thinking:disabled must not be injected anymore");
    assert.doesNotMatch(modelSource, /onPayload/, "the onPayload thinking-disable hook must be removed");
  });
});
