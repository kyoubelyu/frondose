/**
 * P-AUTO-L3FIX-2 — W1 mock tests: Pi stream idle timeout + bounded retry.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/agent/pi/streamIdleRetry-pAutoL3fix2.mock.test.ts
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
}) => Promise<void>;

type MockStream = AsyncIterable<AssistantMessageEvent> & { result: () => Promise<AssistantMessage> };
type StreamHandler = (callIndex: number, options: { signal?: AbortSignal }) => MockStream;

let runAgentLoopPi: RunPi | null = null;
let streamHandler: StreamHandler;
let streamCalls = 0;

const SHORT_IDLE_MS = 20;
const MAX_RETRIES = 2;

before(async () => {
  const piAiUrl = import.meta.resolve("@earendil-works/pi-ai");
  mock.module(piAiUrl, {
    namedExports: {
      stream: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        streamCalls++;
        return streamHandler(streamCalls, options ?? {});
      },
    },
  });

  const modelUrl = new URL("../../../src/agent/pi/model.js", import.meta.url).href;
  mock.module(modelUrl, {
    namedExports: {
      LLM_COMPLETE_TIMEOUT_MS: 120_000,
      LLM_STREAM_IDLE_MS: SHORT_IDLE_MS,
      LLM_STREAM_MAX_RETRIES: MAX_RETRIES,
      resolvePiModel: () => ({
        model: { id: "deepseek-test", api: "openai-completions" },
        apiKey: "test-key",
        onPayload: (payload: unknown) => payload,
        timeoutMs: 120_000,
      }),
    },
  });

  const loopMod = await import("../../../src/agent/pi/loop.js");
  runAgentLoopPi = loopMod.runAgentLoopPi as RunPi;
});

beforeEach(() => {
  streamCalls = 0;
  streamHandler = () => normalDoneStream("ok");
});

function assistant(stopReason: AssistantMessage["stopReason"], text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
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

function streamFrom(generator: AsyncGenerator<AssistantMessageEvent>, result: AssistantMessage): MockStream {
  return {
    [Symbol.asyncIterator]: () => generator,
    result: async () => result,
  };
}

function normalDoneStream(text: string): MockStream {
  const done = {
    ...assistant("toolUse", text),
    content: [
      { type: "text" as const, text },
      { type: "toolCall" as const, id: `tc-${text}`, name: "mock_tool", arguments: {} },
    ],
  };
  return streamFrom(
    (async function* () {
      yield { type: "start", partial: assistant("stop", "") };
      yield { type: "done", reason: "toolUse", message: done };
    })(),
    done,
  );
}

function idleThenThrowStream(signal?: AbortSignal): MockStream {
  const aborted = assistant("aborted", "partial-throw");
  return streamFrom(
    (async function* () {
      yield { type: "start", partial: assistant("stop", "") };
      await waitForAbort(signal);
      throw new Error("mock stream aborted");
    })(),
    aborted,
  );
}

function idleThenAbortedAssistantStream(signal?: AbortSignal, partialText = "partial-aborted"): MockStream {
  const aborted = assistant("aborted", partialText);
  return streamFrom(
    (async function* () {
      yield { type: "start", partial: assistant("stop", "") };
      await waitForAbort(signal);
      yield { type: "error", reason: "aborted", error: aborted };
    })(),
    aborted,
  );
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => {
    signal?.addEventListener("abort", () => resolveAbort(), { once: true });
  });
}

async function runOne(messages: CoreMessage[] = [{ role: "user", content: "go" }], abortSignal?: AbortSignal) {
  assert.ok(runAgentLoopPi !== null, "runAgentLoopPi must be imported");
  await runAgentLoopPi({
    model: {},
    system: "system",
    messages,
    tools: {},
    maxSteps: 1,
    abortSignal,
  });
  return messages;
}

describe("W1 — Pi stream idle-timeout and retry", () => {
  it("W1.a: when a stream emits start then no further events, idle abort retries the call", async () => {
    // Given: call 1 emits start then stalls until the helper aborts it; call 2 finishes normally.
    // When: runAgentLoopPi performs one model step.
    // Then: the stream is called twice and the successful second assistant is appended.
    streamHandler = (callIndex, options) =>
      callIndex === 1 ? idleThenThrowStream(options.signal) : normalDoneStream("after-retry");

    const messages = await runOne();

    assert.equal(streamCalls, 2, "idle-aborted first call must be retried exactly once");
    assert.equal(messages.filter((message) => message.role === "assistant").length, 1, "successful retry assistant must be appended once");
    assert.match(JSON.stringify(messages), /after-retry/);
  });

  it("W1.b: when the stream reaches done normally, no retry occurs", async () => {
    // Given: the stream emits start and done in one attempt.
    // When: runAgentLoopPi completes.
    // Then: exactly one stream call is made and the assistant is appended.
    streamHandler = () => normalDoneStream("normal");

    const messages = await runOne();

    assert.equal(streamCalls, 1, "normal completion must not retry");
    assert.match(JSON.stringify(messages), /normal/);
  });

  it("W1.c: when the turn signal aborts mid-stream, the helper propagates without retry", async () => {
    // Given: the stream waits for an abort and the caller aborts the turn signal.
    // When: runAgentLoopPi observes the turn abort.
    // Then: it returns without retrying and without appending an assistant.
    const ac = new AbortController();
    streamHandler = (_callIndex, options) => idleThenAbortedAssistantStream(options.signal, "turn-partial");

    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    const pending = runOne(messages, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await pending;

    assert.equal(streamCalls, 1, "turn abort must not be retried");
    assert.equal(messages.length, 1, "turn-aborted partial assistant must not be appended");
  });

  it("W1.d: when pi-ai returns stopReason='aborted' for an idle abort, that assistant is retried, not returned", async () => {
    // Given: the first idle-aborted call yields an assistant with stopReason='aborted' and partial text.
    // When: the retry succeeds.
    // Then: the partial aborted assistant is discarded and only the retry result reaches messages.
    streamHandler = (callIndex, options) =>
      callIndex === 1 ? idleThenAbortedAssistantStream(options.signal, "discard-me") : normalDoneStream("kept");

    const messages = await runOne();
    const transcript = JSON.stringify(messages);

    assert.equal(streamCalls, 2, "returned aborted assistant must trigger retry");
    assert.doesNotMatch(transcript, /discard-me/, "aborted partial assistant must not be appended");
    assert.match(transcript, /kept/);
  });

  it("W1.e: when every idle retry is exhausted, the loop throws instead of returning an assistant", async () => {
    // Given: every attempt stalls and returns an aborted assistant after the idle abort.
    // When: the retry budget is exhausted.
    // Then: runAgentLoopPi throws an idle-timeout error after initial call + 2 retries.
    streamHandler = (_callIndex, options) => idleThenAbortedAssistantStream(options.signal, "never-append");

    await assert.rejects(() => runOne(), /LLM stream idle timeout/);
    assert.equal(streamCalls, MAX_RETRIES + 1, "must attempt initial call plus bounded retries");
  });

  it("W1.f: no idle-aborted partial assistant reaches the append path", async () => {
    // Given: the first call produces a text-bearing aborted assistant and the second call succeeds.
    // When: runAgentLoopPi completes after retry.
    // Then: opts.messages contains only the successful assistant content.
    streamHandler = (callIndex, options) =>
      callIndex === 1 ? idleThenAbortedAssistantStream(options.signal, "partial-should-not-append") : normalDoneStream("final-only");

    const messages = await runOne();
    const transcript = JSON.stringify(messages);

    assert.equal(messages.filter((message) => message.role === "assistant").length, 1, "only one assistant should be appended");
    assert.doesNotMatch(transcript, /partial-should-not-append/);
    assert.match(transcript, /final-only/);
  });

  it("W1.g: production constants keep the idle window at 30000ms and retry budget at 2", () => {
    // Given: src/agent/pi/model.ts is the production source for the idle constants.
    // When: the source is inspected.
    // Then: it exports LLM_STREAM_IDLE_MS=30_000 and LLM_STREAM_MAX_RETRIES=2.
    const modelSource = readFileSync(resolve(join(process.cwd(), "src/agent/pi/model.ts")), "utf8");

    assert.match(modelSource, /LLM_STREAM_IDLE_MS\s*=\s*30_000/);
    assert.match(modelSource, /LLM_STREAM_MAX_RETRIES\s*=\s*2/);
  });
});
