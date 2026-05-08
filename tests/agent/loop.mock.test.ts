import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreMessage, CoreToolMessage, ToolResultPart } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { runAgentLoop } from "../../src/agent/loop.js";
import { tools } from "../../src/tools/index.js";

// T-M13: runAgentLoop drives a multi-step tool-call → tool-result → text loop
// using MockLanguageModelV1 (no API key required).

test("T-M13: runAgentLoop drives tool-call → tool-result → text with maxSteps", async () => {
  let step = 0;

  const model = new MockLanguageModelV1({
    doStream: async () => {
      step++;

      if (step === 1) {
        // Step 1: model emits a tool-call for "echo" with message "hello"
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallType: "function" as const,
                toolCallId: "c1",
                toolName: "echo",
                args: '{"message":"hello"}',
              },
              {
                type: "finish" as const,
                finishReason: "tool-calls" as const,
                usage: { promptTokens: 10, completionTokens: 5 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }

      // Step 2: model emits text "OK" after receiving the tool result
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-delta" as const, textDelta: "OK" },
            {
              type: "finish" as const,
              finishReason: "stop" as const,
              usage: { promptTokens: 20, completionTokens: 3 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });

  const messages: CoreMessage[] = [{ role: "user", content: "echo hello" }];
  const collected: string[] = [];

  await runAgentLoop({
    model,
    system: "test system",
    messages,
    tools,
    onText: (d) => collected.push(d),
    maxSteps: 3,
  });

  // Assert: messages array grew with assistant(tool-call) + tool(result) + assistant(text)
  assert.ok(messages.length >= 4, `expected >= 4 messages after loop, got ${messages.length}`);

  // Last 3 messages must be: assistant → tool → assistant
  const last3 = messages.slice(-3);
  assert.equal(last3[0]?.role, "assistant", "first response message must be assistant (tool-call)");
  assert.equal(last3[1]?.role, "tool", "second response message must be tool (tool-result)");
  assert.equal(last3[2]?.role, "assistant", "third response message must be assistant (text)");

  // Assert: tool-result contains { echoed: "hello" } (echoTool executed correctly)
  const toolMsg = last3[1] as CoreToolMessage;
  const resultPart = (toolMsg.content as ToolResultPart[]).find((c) => c.type === "tool-result");
  assert.ok(resultPart, "tool-result part must exist in tool message");
  assert.deepEqual(
    (resultPart.result as Record<string, unknown>).echoed,
    "hello",
    "echoTool must return { echoed: 'hello' }",
  );

  // Assert: text deltas forwarded to onText callback
  assert.equal(collected.join(""), "OK", "onText must collect streamed text deltas");

  // Assert: the model was called exactly twice (2 steps)
  assert.equal(step, 2, "model must be called exactly 2 times (tool-call step + text step)");
});
