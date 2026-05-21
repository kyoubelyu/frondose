/**
 * P-56b Step 5 — T-Agent.1a, T-Agent.1b (G-P56b.1)
 *
 * Validates the `onToolCall` hook added to `runAgentLoop` in P-56b §5.1.
 *
 * Gate coverage:
 *   G-P56b.1 — `runAgentLoop` calls `onToolCall(toolName)` exactly once per
 *               tool-call chunk.  When `onToolCall` is omitted, the loop runs
 *               without throwing (conditional `onChunk` construction is intact).
 *
 * Implementation note (D-P56b-01 — Step 5a round 2 — CLOSED 2026-05-21):
 *   Round 1 builder wired `onChunk` checking `chunk.type === "tool-call-streaming-start"`.
 *   That event only fires when `experimental_toolCallStreaming: true` is set (SDK default
 *   is false), so `onToolCall` was dead code. Round 2 (Codex Step 5a r2) switched the
 *   wiring to wrap `onStepFinish` and iterate `step.toolCalls` instead — the Vercel
 *   SDK contract-correct path. For the mock test to populate `step.toolCalls`, the
 *   tool schema MUST be registered in the `tools` map (an empty `tools: {}` makes the
 *   SDK ignore the synthetic tool-call chunk). T-Agent.1a now registers `qualify_profile`
 *   via `tool({...})` so the SDK routes the mock chunk into `step.toolCalls`, which the
 *   onStepFinish wrap then forwards to `onToolCall`.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/agent/loop-p56b.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CoreMessage, tool } from "ai";
import { MockLanguageModelV1, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { runAgentLoop } from "../../src/agent/loop.js";

// ─── T-Agent.1 — runAgentLoop onToolCall hook ─────────────────────────────────

describe("runAgentLoop — onToolCall hook via tool-call chunk (G-P56b.1)", () => {
  it("T-Agent.1a: given a mock model that emits tool-call for 'qualify_profile' + onToolCall=spy + qualify_profile tool registered in tools map, WHEN runAgentLoop completes, THEN onToolCall called exactly once with 'qualify_profile'", async () => {
    // Given: MockLanguageModelV1 emits tool-call{toolName:'qualify_profile'} + finish;
    //        tools:{qualify_profile: tool({...})} — schema registered so SDK routes the
    //        synthetic chunk into step.toolCalls (Step 5a r2 mock fix);
    //        no execute fn — tool call not auto-executed by SDK;
    //        onToolCall is a manual spy (call log array)
    // When:  await runAgentLoop({model, system:"", messages:[...], tools:{qualify_profile:...},
    //          onToolCall, maxSteps:1})
    // Then:  onToolCall call count === 1 via the onStepFinish wrap iterating step.toolCalls;
    //        first call arg === 'qualify_profile'
    const onToolCallCalls: string[] = [];
    const onToolCall = (name: string) => {
      onToolCallCalls.push(name);
    };

    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call" as const,
              toolCallType: "function" as const,
              toolCallId: "tc-1",
              toolName: "qualify_profile",
              args: "{}",
            },
            {
              type: "finish" as const,
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const messages: CoreMessage[] = [{ role: "user", content: "x" }];

    await runAgentLoop({
      model,
      system: "",
      messages,
      tools: {
        // Schema registration required so SDK routes the mocked tool-call chunk into
        // step.toolCalls — without this, step.toolCalls stays empty and the
        // onStepFinish wrap finds nothing to forward to onToolCall.
        // No execute fn — keeps the test from auto-running the tool body.
        qualify_profile: tool({
          description: "qualify a LinkedIn profile (mock)",
          parameters: z.object({}),
        }),
      },
      onToolCall,
      maxSteps: 1,
    });

    assert.equal(
      onToolCallCalls.length,
      1,
      `onToolCall should be called exactly once — got ${onToolCallCalls.length}. ` +
        "If 0: D-P56b-01 production fix (onStepFinish wrap iterating step.toolCalls) " +
        "regressed, OR the tool schema is no longer registered in the mock setup.",
    );
    assert.equal(onToolCallCalls[0], "qualify_profile", "first call arg must be 'qualify_profile'");
  });

  it("T-Agent.1b: given a mock model emitting text-delta + onToolCall OMITTED, WHEN runAgentLoop completes, THEN no throw (conditional onToolCall guard inside the onStepFinish wrap)", async () => {
    // Given: MockLanguageModelV1 emits text-delta 'OK' + finish:stop;
    //        onToolCall NOT in opts → opts.onToolCall is undefined → the
    //        `if (opts.onToolCall)` guard in the onStepFinish wrap skips the loop
    // When:  await runAgentLoop({model, system:"", messages:[...], tools:{}, maxSteps:1})
    // Then:  resolves without throwing; loop ran to completion
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-delta" as const, textDelta: "OK" },
            {
              type: "finish" as const,
              finishReason: "stop" as const,
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const messages: CoreMessage[] = [{ role: "user", content: "x" }];
    let threw = false;
    try {
      await runAgentLoop({
        model,
        system: "",
        messages,
        tools: {},
        // onToolCall intentionally OMITTED
        maxSteps: 1,
      });
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "loop must not throw when onToolCall is omitted (conditional onChunk:undefined)");
    // Verify loop ran: messages should have grown (model + user input)
    assert.ok(messages.length > 1, "messages should have grown (loop completed at least 1 step)");
  });
});
