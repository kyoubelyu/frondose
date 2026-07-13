/**
 * P-CONVO-GATE — D-22 stall-nudge gating + D-12 narrative-regex fix.
 *
 * Live-proven root cause of "你好 launches the full sales flow" (2026-07-13, FM-3
 * turn 699dff5e): the model correctly answered the greeting with a plain-text reply
 * and ZERO tool calls, then the unconditional D-22 stall detector injected
 * stalledContinueMessage ("You stopped without completing the task … call
 * navigate_to_url to my LinkedIn feed … Do NOT respond with text only") which
 * countermanded the Boundary conversational-turn gate and launched the flow.
 *
 * Fix under test:
 *  (1) runAgentLoopPi only fires the stall nudge when the turn made >= 1 tool call
 *      (in-flight work went silent — D-22's original case) — a zero-tool text-only
 *      turn is a legitimate conversational reply and gets NO continuation.
 *  (2) NARRATIVE_HOOK_RE no longer matches the conversational sign-off "Let me know…"
 *      (the empty alternative in `let me (…|)` matched ANY "let me X").
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/agent/pi/stallGate-pConvoGate.mock.test.ts
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CoreMessage, ToolSet } from "ai";

type RunPi = (opts: {
  model: unknown;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}) => Promise<void>;

let runAgentLoopPi: RunPi | null = null;
let lastAssistantMessageMissedExecute: ((messages: CoreMessage[]) => boolean) | null = null;
let streamHandler: (callIndex: number) => MockStream;
let streamCalls = 0;

type MockStream = AsyncIterable<unknown> & { result: () => Promise<AssistantMessage> };

function assistantMsg(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
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

/** Plain-text conversational reply, zero tool calls, natural stop. */
function textOnlyStop(text: string): MockStream {
  return doneStream(assistantMsg("stop", [{ type: "text", text }]));
}

/** A step that calls one tool then wants to continue. */
function toolCallStep(id: string): MockStream {
  return doneStream(
    assistantMsg("toolUse", [
      { type: "text", text: "working" },
      { type: "toolCall", id, name: "mock_tool", arguments: {} },
    ]),
  );
}

before(async () => {
  const piAiUrl = import.meta.resolve("@earendil-works/pi-ai");
  mock.module(piAiUrl, {
    namedExports: {
      stream: () => {
        streamCalls++;
        return streamHandler(streamCalls);
      },
    },
  });
  const modelUrl = new URL("../../../src/agent/pi/model.js", import.meta.url).href;
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
  const loopMod = await import("../../../src/agent/pi/loop.js");
  runAgentLoopPi = loopMod.runAgentLoopPi as RunPi;
  const outerLoop = await import("../../../src/agent/loop.js");
  lastAssistantMessageMissedExecute = outerLoop.lastAssistantMessageMissedExecute;
});

beforeEach(() => {
  streamCalls = 0;
});

async function runTurn(prompt: string, maxSteps = 10): Promise<CoreMessage[]> {
  assert.ok(runAgentLoopPi, "loop imported");
  const messages: CoreMessage[] = [{ role: "user", content: prompt }];
  await runAgentLoopPi({ model: {}, system: "system", messages, tools: {}, maxSteps });
  return messages;
}

describe("P-CONVO-GATE: D-22 stall nudge does not fire on a zero-tool conversational turn", () => {
  it("T-StallGate.1: given the model answers a greeting with plain text and zero tool calls, when the turn ends, then NO stalledContinueMessage is injected and no second phase runs", async () => {
    // Given: one LLM step, text-only, natural stop (the live "你好" shape)
    // When:  runAgentLoopPi completes
    // Then:  exactly 1 stream call (no retry phase) and the transcript contains no
    //        synthetic "You stopped without completing the task" user message
    streamHandler = () => textOnlyStop("你好！有什么我可以帮你的吗？");
    const messages = await runTurn("你好");
    assert.equal(streamCalls, 1, "a conversational text-only turn must NOT trigger a continuation phase");
    const flat = JSON.stringify(messages);
    assert.ok(
      !flat.includes("You stopped without completing the task"),
      "stalledContinueMessage must NOT be injected on a zero-tool turn",
    );
  });

  it("T-StallGate.2: given the turn made a tool call and then went silent (text-only stop) within the stall threshold, when the turn ends, then the stall nudge IS injected exactly once (D-22 original case + at-most-one-continuation preserved)", async () => {
    // Given: step 1 calls a tool (toolUse), step 2 is text-only stop — the
    //        "start_auto_run + todo_write then silence" dogfood shape
    // When:  runAgentLoopPi completes
    // Then:  the stall continuation IS injected AND exactly one phase-2 stream call runs
    //        (phase1 = 2 calls: toolUse then stop; +1 continuation call = 3 total) —
    //        pinning the "at most one continuation per turn" invariant
    streamHandler = (call) => (call === 1 ? toolCallStep("tc-1") : textOnlyStop("done for now"));
    const messages = await runTurn("browse the feed");
    const flat = JSON.stringify(messages);
    assert.ok(
      flat.includes("You stopped without completing the task"),
      "a turn that acted then went silent must still get the D-22 stall nudge",
    );
    assert.equal(streamCalls, 3, "exactly one continuation phase must run (phase1=2 + one nudge phase=1)");
  });

  it("T-StallGate.5: given the LAST assistant message still carries a tool-call part (turn ended mid-tool, not silent) within the threshold, when the turn ends, then NO D-22 nudge is injected", async () => {
    // Given: every step keeps calling a tool — the last assistant message has a tool-call
    //        part, so the turn never went silent (lastAssistantMessageHasNoToolCalls=false)
    // When:  runAgentLoopPi completes after maxSteps
    // Then:  no stalledContinueMessage — D-22 only fires when the tail went text-only
    streamHandler = (call) => toolCallStep(`tc-${call}`);
    const messages = await runTurn("keep going", 3);
    assert.ok(
      !JSON.stringify(messages).includes("You stopped without completing the task"),
      "a turn whose last assistant message still has a tool call must NOT get the D-22 nudge",
    );
  });

  it("T-StallGate.6: given an execution-shaped prompt answered with plain text, zero tools, and no narrative hook, when the turn ends, then NO nudge is injected (zero-tool task turn is a valid text-only outcome)", async () => {
    // Given: an execution-shaped operator prompt but a text-only, zero-tool reply with no
    //        forward-looking announcement (the turnToolCallCount>0 gate must hold here)
    // When:  runAgentLoopPi completes
    // Then:  neither the D-22 stall nudge nor the D-12 narrative nudge fires
    streamHandler = () => textOnlyStop("I don't have enough detail yet to search — which region and role?");
    const messages = await runTurn("find me some leads");
    const flat = JSON.stringify(messages);
    assert.equal(streamCalls, 1, "a zero-tool text-only task turn must not trigger a continuation phase");
    assert.ok(!flat.includes("You stopped without completing the task"), "no D-22 nudge on a zero-tool task turn");
    assert.ok(!flat.includes("Continue — execute the action"), "no D-12 nudge on a non-narrative text-only reply");
  });
});

describe("P-CONVO-GATE: D-12 narrative regex no longer matches the 'Let me know…' sign-off", () => {
  it("T-StallGate.3: given a conversational reply ending 'Let me know what you need!', when the narrative detector runs, then it does NOT classify it as narrate-without-execute", () => {
    // Given: a zero-tool assistant reply with a conversational sign-off
    // When:  lastAssistantMessageMissedExecute inspects the transcript
    // Then:  false — 'Let me know' is not a forward-looking action announcement
    assert.ok(lastAssistantMessageMissedExecute, "detector imported");
    const messages: CoreMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Happy to help. Let me know what you need!" },
    ];
    assert.equal(lastAssistantMessageMissedExecute(messages), false);
  });

  it("T-StallGate.4: given a reply announcing 'Let me now open the feed' with no tool call, when the narrative detector runs, then it still fires (D-12 preserved)", () => {
    // Given: a zero-tool assistant reply that ANNOUNCES an action
    // When:  lastAssistantMessageMissedExecute inspects the transcript
    // Then:  true — forward-looking announcements still trigger the narration nudge
    assert.ok(lastAssistantMessageMissedExecute, "detector imported");
    const messages: CoreMessage[] = [
      { role: "user", content: "browse the feed" },
      { role: "assistant", content: "Let me now open the feed." },
    ];
    assert.equal(lastAssistantMessageMissedExecute(messages), true);
  });

  it("T-StallGate.7: given residual conversational 'let me' phrasings (think/see) and the 'now let me know' branch, when the narrative detector runs, then none of them fire (CONCERN-MR-1 under-narrowing closed)", () => {
    // Given: conversational sign-offs / hesitations the OLD regex matched via the empty
    //        'let me' alternative or the unrestricted 'now let me' branch
    // When:  lastAssistantMessageMissedExecute inspects each
    // Then:  false for every one — they must not inject a tool nudge
    assert.ok(lastAssistantMessageMissedExecute, "detector imported");
    for (const reply of [
      "Sure — let me think about that for a moment.",
      "Hmm, let me see what makes sense here.",
      "Happy to help. Let me explain how the pipeline works.",
      "Got it. Now let me know what you'd like to prioritize!",
      "Let me help you frame the ICP.",
    ]) {
      const messages: CoreMessage[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: reply },
      ];
      assert.equal(
        lastAssistantMessageMissedExecute(messages),
        false,
        `conversational reply must NOT trigger the narrative nudge: "${reply}"`,
      );
    }
  });

  it("T-StallGate.8: given an assistant message that both narrates AND carries a tool-call part, when the narrative detector runs, then it does NOT fire (final tool-call precedence)", () => {
    // Given: the assistant announced an action AND actually called a tool in the same message
    // When:  lastAssistantMessageMissedExecute inspects the transcript
    // Then:  false — a real tool call means the announcement was executed
    assert.ok(lastAssistantMessageMissedExecute, "detector imported");
    const messages: CoreMessage[] = [
      { role: "user", content: "browse the feed" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me now open the feed." },
          { type: "tool-call", toolCallId: "tc-x", toolName: "launch", args: {} },
        ],
      },
    ];
    assert.equal(lastAssistantMessageMissedExecute(messages), false);
  });
});
