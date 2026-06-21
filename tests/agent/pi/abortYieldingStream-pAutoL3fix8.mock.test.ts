/**
 * P-AUTO-L3FIX-8 — Pi stream abort backstop mock test.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/agent/pi/abortYieldingStream-pAutoL3fix8.mock.test.ts
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
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
}) => Promise<void>;

type MockStream = AsyncIterable<AssistantMessageEvent> & { result: () => Promise<AssistantMessage> };
type StreamHandler = (options: { signal?: AbortSignal }) => MockStream;

let runAgentLoopPi: RunPi | null = null;
let streamHandler: StreamHandler;
let streamCalls = 0;
let resultCalls = 0;
let yieldedEvents = 0;
let firstEventSeen: (() => void) | null = null;

before(async () => {
  const piAiUrl = import.meta.resolve("@earendil-works/pi-ai");
  mock.module(piAiUrl, {
    namedExports: {
      stream: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        streamCalls++;
        return streamHandler(options ?? {});
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
  resultCalls = 0;
  yieldedEvents = 0;
  firstEventSeen = null;
  streamHandler = () => foreverYieldingStream();
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

function foreverYieldingStream(): MockStream {
  return {
    [Symbol.asyncIterator]: async function* () {
      while (true) {
        yieldedEvents++;
        if (yieldedEvents === 1) {
          firstEventSeen?.();
          firstEventSeen = null;
        }
        await delay(1);
        yield { type: "start", partial: assistant("stop", "") };
      }
    },
    result: async () => {
      resultCalls++;
      return await new Promise<AssistantMessage>(() => undefined);
    },
  };
}

async function runOne(abortSignal?: AbortSignal): Promise<CoreMessage[]> {
  assert.ok(runAgentLoopPi !== null, "runAgentLoopPi must be imported");
  const messages: CoreMessage[] = [{ role: "user", content: "go" }];
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

function waitForFirstEvent(): Promise<void> {
  return new Promise((resolve) => {
    firstEventSeen = resolve;
  });
}

describe("P-AUTO-L3FIX-8 Pi loop abort while stream keeps yielding", () => {
  it("T-L3F8.7: aborting a still-yielding Pi stream unwinds promptly and does not await eventStream.result forever", async () => {
    // Given a Pi stream that keeps yielding start events and whose result() never resolves, when the turn signal aborts mid-iteration, then runAgentLoopPi returns promptly without calling result().
    const ac = new AbortController();
    const firstEvent = waitForFirstEvent();
    const pending = runOne(ac.signal);

    await firstEvent;
    ac.abort();
    const outcome = await Promise.race([pending.then(() => "done" as const), delay(100).then(() => "timeout" as const)]);

    assert.equal(outcome, "done", "runAgentLoopPi must unwind promptly after the turn signal aborts");
    assert.equal(streamCalls, 1, "turn abort must not retry the still-yielding stream");
    assert.equal(resultCalls, 0, "abort path must throw before awaiting eventStream.result()");
    assert.equal(yieldedEvents <= 3, true, "loop must stop consuming shortly after abort");
  });
});
