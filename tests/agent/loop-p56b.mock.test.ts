/**
 * P-56b Step 5 — T-Agent.1a, T-Agent.1b (G-P56b.1)
 *
 * Validates the `onToolCall` hook on the agent loop: it must fire exactly once
 * per tool-call chunk, and omitting it must not throw.
 *
 * Gate coverage:
 *   G-P56b.1 — the loop calls `onToolCall(toolName)` exactly once per tool call;
 *              when `onToolCall` is omitted, the loop runs without throwing.
 *
 * [P-CONVO-GATE conversion — 2026-07-13] Originally this file mocked the **Vercel**
 * SDK (`MockLanguageModelV1` from `ai/test`). After the PI cutover `runAgentLoop`
 * delegates to `runAgentLoopPi`, which IGNORES `opts.model` and resolves the real
 * DeepSeek model — so the old test made a **real network call** on the nonsense prompt
 * "x" and its pass depended on the OLD unconditional D-22 stall nudge coercing a tool
 * call out of the live LLM. P-CONVO-GATE's correct fix (D-22 no longer nudges a zero-tool
 * turn) removed that coercion, exposing the test as a brittle real-network test. Converted
 * here to a **hermetic `@earendil-works/pi-ai` `mock.module` stream** (the deterministic
 * pattern from tests/agent/pi/stallGate-pConvoGate.mock.test.ts). The ORIGINAL behavioral
 * assertion is preserved unchanged: T-Agent.1a still asserts `onToolCall` fires exactly
 * once with 'qualify_profile' for one emitted tool call; T-Agent.1b still asserts no-throw
 * when omitted. The intent is NOT obsolete under the D-22 gate — a single tool-call chunk
 * has one tool call, so the last assistant message carries a tool-call part,
 * `lastAssistantMessageHasNoToolCalls` is false, and the D-22 gate leaves `stalled=false`
 * (no second phase, no double-fire) — exactly the once-per-tool-call contract.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/agent/loop-p56b.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CoreMessage } from "ai";

type RunLoop = (opts: {
  model: unknown;
  system: string;
  messages: CoreMessage[];
  tools: Record<string, unknown>;
  maxSteps?: number;
  onToolCall?: (name: string) => void;
  abortSignal?: AbortSignal;
}) => Promise<void>;

type MockStream = AsyncIterable<unknown> & { result: () => Promise<AssistantMessage> };

let runAgentLoop: RunLoop | null = null;
let streamHandler: () => MockStream;

function assistantMsg(
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
): AssistantMessage {
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
        yield { type: "start", partial: assistantMsg("stop", []) };
        yield { type: "done", reason: message.stopReason, message };
      })(),
    result: async () => message,
  };
}

before(async () => {
  const piAiUrl = import.meta.resolve("@earendil-works/pi-ai");
  const { mock } = await import("node:test");
  mock.module(piAiUrl, {
    namedExports: {
      stream: () => streamHandler(),
    },
  });
  const modelUrl = new URL("../../src/agent/pi/model.js", import.meta.url).href;
  mock.module(modelUrl, {
    namedExports: {
      LLM_COMPLETE_TIMEOUT_MS: 120_000,
      LLM_STREAM_IDLE_MS: 5_000,
      LLM_STREAM_MAX_RETRIES: 1,
      resolvePiModel: () => ({
        model: { id: "deepseek-test", api: "openai-completions" },
        apiKey: "test-key",
        timeoutMs: 120_000,
      }),
    },
  });
  // runAgentLoop delegates to runAgentLoopPi via a dynamic import at call time, so the
  // pi-ai + model mocks registered above are in effect when it runs.
  const loopMod = await import("../../src/agent/loop.js");
  runAgentLoop = loopMod.runAgentLoop as RunLoop;
});

// ─── T-Agent.1 — agent-loop onToolCall hook ───────────────────────────────────

describe("runAgentLoop — onToolCall hook via tool-call chunk (G-P56b.1)", () => {
  it("T-Agent.1a: given the model emits ONE tool-call for 'qualify_profile' + onToolCall=spy, WHEN runAgentLoop completes, THEN onToolCall is called exactly once with 'qualify_profile'", async () => {
    // Given: a hermetic pi-ai stream emitting one assistant message with a single toolCall
    //        named 'qualify_profile' (stopReason toolUse); onToolCall is a manual spy
    // When:  await runAgentLoop({..., onToolCall, maxSteps:1})
    // Then:  onToolCall call count === 1 (the loop fires opts.onToolCall(tc.name) per tool
    //        call, before dispatch); first call arg === 'qualify_profile'. The D-22 gate
    //        leaves stalled=false (last message has a tool-call part) → no second phase →
    //        no double-fire, so the once-per-tool-call contract holds.
    assert.ok(runAgentLoop, "runAgentLoop must be imported");
    streamHandler = () =>
      doneStream(
        assistantMsg("toolUse", [
          { type: "text", text: "qualifying" },
          { type: "toolCall", id: "tc-1", name: "qualify_profile", arguments: {} },
        ]),
      );

    const onToolCallCalls: string[] = [];
    const onToolCall = (name: string): void => {
      onToolCallCalls.push(name);
    };

    const messages: CoreMessage[] = [{ role: "user", content: "x" }];
    await runAgentLoop({
      model: {},
      system: "",
      messages,
      tools: {},
      onToolCall,
      maxSteps: 1,
    });

    assert.equal(
      onToolCallCalls.length,
      1,
      `onToolCall should be called exactly once — got ${onToolCallCalls.length}. ` +
        "If 0: the loop's onToolCall wiring (opts.onToolCall?.(tc.name) per tool call) regressed. " +
        "If >1: a retry phase double-fired (D-22/D-12 gate regressed).",
    );
    assert.equal(onToolCallCalls[0], "qualify_profile", "first call arg must be 'qualify_profile'");
  });

  it("T-Agent.1b: given the model emits text only + onToolCall OMITTED, WHEN runAgentLoop completes, THEN it does not throw and the transcript grows", async () => {
    // Given: a hermetic pi-ai stream emitting a text-only assistant (stopReason stop);
    //        onToolCall NOT passed → the loop's `opts.onToolCall?.(...)` optional-chain is a no-op
    // When:  await runAgentLoop({..., no onToolCall, maxSteps:1})
    // Then:  resolves without throwing; messages grew (loop ran + appended the assistant)
    assert.ok(runAgentLoop, "runAgentLoop must be imported");
    streamHandler = () => doneStream(assistantMsg("stop", [{ type: "text", text: "OK" }]));

    const messages: CoreMessage[] = [{ role: "user", content: "x" }];
    let threw = false;
    try {
      await runAgentLoop({
        model: {},
        system: "",
        messages,
        tools: {},
        // onToolCall intentionally OMITTED
        maxSteps: 1,
      });
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "loop must not throw when onToolCall is omitted");
    assert.ok(messages.length > 1, "messages should have grown (loop completed at least 1 step)");
  });
});
