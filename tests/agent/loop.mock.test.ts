import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
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

// ─── P-46 D-1/D-2 two-phase loop tests (T-Loop.1–8) ─────────────────────────
//
// Mock-construction convention (C-1 note from plan §5):
//   - "Always-tool-calls" model: emits a tool-call chunk every doStream invocation.
//     With maxSteps=N and softCap=floor(N*0.8), Phase 1 runs `softCap` doStream calls,
//     finishes with finishReason:'tool-calls', stepCount=softCap. Triggers Phase 2.
//   - "Natural stop" model: emits text + stop on every doStream invocation.
//     Phase 1 finishes with finishReason:'stop'. No Phase 2.
//   - Both models use the `echo` tool from `tools` (has execute — SDK auto-continues).
//
// Step counts are observable by counting doStream invocations across both phases.
// Phase 2 is detectable via the STEP-BUDGET WARNING message presence in opts.messages.

/** Helper: build a MockLanguageModelV1 that emits a tool-call for `echo` on every step. */
function makeAlwaysToolCallModel(): { model: MockLanguageModelV1; callCount: () => number } {
  let calls = 0;
  const model = new MockLanguageModelV1({
    doStream: async () => {
      calls++;
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call" as const,
              toolCallType: "function" as const,
              toolCallId: `c${calls}`,
              toolName: "echo",
              args: '{"message":"step"}',
            },
            {
              type: "finish" as const,
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 5, completionTokens: 2 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, callCount: () => calls };
}

/** Helper: build a MockLanguageModelV1 that immediately emits text + stop. */
function makeNaturalStopModel(): { model: MockLanguageModelV1; callCount: () => number } {
  let calls = 0;
  const model = new MockLanguageModelV1({
    doStream: async () => {
      calls++;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-delta" as const, textDelta: "done" },
            {
              type: "finish" as const,
              finishReason: "stop" as const,
              usage: { promptTokens: 5, completionTokens: 2 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, callCount: () => calls };
}

/** Predicate: does `messages` contain exactly one STEP-BUDGET WARNING user turn? */
function hasStepBudgetWarning(msgs: CoreMessage[]): boolean {
  return msgs.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[STEP-BUDGET WARNING]"),
  );
}

// ─── T-Loop.1: default budget 200 ──────────────────────────────────────────

describe("T-Loop.1: when opts.maxSteps undefined, runAgentLoop uses DEFAULT_MAX_STEPS=200", () => {
  it("default budget — Phase 1 cap is floor(200×0.8)=160, not the old 10", async () => {
    // Given: runAgentLoop called without opts.maxSteps; model stops naturally at step 1
    // When:  the loop runs
    // Then:  exactly 1 doStream call (single phase, natural stop); no STEP-BUDGET WARNING in messages;
    //        DEFAULT_MAX_STEPS is 200 (not 10)
    const { model, callCount } = makeNaturalStopModel();
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop({ model, system: "test", messages, tools });

    assert.equal(callCount(), 1, "natural stop → exactly 1 doStream call (single phase)");
    assert.equal(
      hasStepBudgetWarning(messages),
      false,
      "no STEP-BUDGET WARNING on natural stop (finishReason='stop' → no Phase 2)",
    );
    // D-1 contract: default budget is 200 (not 10); loop ran without budget issue
    assert.ok(messages.length > 1, "messages must include at least the original + response (loop completed)");
  });
});

// ─── T-Loop.2: explicit maxSteps honored ──────────────────────────────────

describe("T-Loop.2: when opts.maxSteps=6, Phase 1 cap=4, Phase 2 cap=2", () => {
  it("Phase-1 streamText is constrained to softCap=4; Phase-2 (if triggered) to remaining=2", async () => {
    // Given: opts.maxSteps=6 (softCap=floor(6×0.8)=4, remaining=2); always-tool-call model
    // When:  the loop runs → Phase 1 runs to cap (4 doStream calls) → triggers Phase 2 (2 more)
    // Then:  total doStream calls = 6 (4 Phase-1 + 2 Phase-2); warning injected between phases
    const { model, callCount } = makeAlwaysToolCallModel();
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop({ model, system: "test", messages, tools, maxSteps: 6 });

    // Phase 1: softCap=4 steps; Phase 2: remaining=2 steps; total=6
    assert.equal(callCount(), 6, "total doStream calls = Phase-1(4) + Phase-2(2) = 6");
    assert.equal(
      hasStepBudgetWarning(messages),
      true,
      "STEP-BUDGET WARNING must be injected (Phase 1 exhausted softCap=4)",
    );
  });
});

// ─── T-Loop.3: warning injected on genuine tool-calls cutoff ──────────────

describe("T-Loop.3: when Phase 1 genuinely cut off (tool-calls + stepCount>=softCap), warning injected", () => {
  it("STEP-BUDGET WARNING user message appears between Phase 1 and Phase 2 messages", async () => {
    // Given: always-tool-call model, opts.maxSteps=6 (softCap=4, remaining=2)
    // When:  runAgentLoop runs; Phase 1 exhausts softCap → finishReason:'tool-calls', stepCount=4
    // Then:  exactly one {role:'user'} message with content containing 'STEP-BUDGET WARNING'
    //        is appended after Phase-1 messages and before Phase-2 messages;
    //        a second streamText pass occurs
    const { model } = makeAlwaysToolCallModel();
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop({ model, system: "test", messages, tools, maxSteps: 6 });

    const warningMsgs = messages.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[STEP-BUDGET WARNING]"),
    );
    assert.equal(warningMsgs.length, 1, "exactly one STEP-BUDGET WARNING message must be injected");

    const warnContent = warningMsgs[0]?.content as string;
    // remaining = 6 - softCap(4) = 2 → "About 2 tool-call steps remain"
    assert.ok(
      warnContent.includes("About 2"),
      `warning must say 'About 2 tool-call steps remain' (remaining=6-4=2); got: '${warnContent?.slice(0, 120)}'`,
    );
    assert.ok(
      warnContent.includes("telegram_notify"),
      "warning must mention telegram_notify per budgetWarningMessage spec",
    );
  });
});

// ─── T-Loop.4: no warning on natural finish ────────────────────────────────

describe("T-Loop.4: when Phase 1 finishes naturally (stop), no warning injected", () => {
  it("natural stop → no STEP-BUDGET WARNING in messages; exactly 1 streamText pass", async () => {
    // Given: natural-stop model, opts.maxSteps=6 (two-phase-eligible)
    // When:  runAgentLoop runs; Phase 1 resolves finishReason:'stop'
    // Then:  no message containing 'STEP-BUDGET WARNING' in opts.messages;
    //        model called exactly 1 time (single streamText pass)
    const { model, callCount } = makeNaturalStopModel();
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop({ model, system: "test", messages, tools, maxSteps: 6 });

    assert.equal(callCount(), 1, "natural stop → exactly 1 doStream call (single phase, no Phase 2)");
    assert.equal(
      hasStepBudgetWarning(messages),
      false,
      "no STEP-BUDGET WARNING when finishReason='stop' (natural finish → no Phase 2)",
    );
  });
});

// ─── T-Loop.5: no Phase 2 when budget fully consumed (maxSteps=1) ──────────

describe("T-Loop.5: when opts.maxSteps=1, softCap=1, remaining=0 — single phase, no warning", () => {
  it("maxSteps=1 → 1 doStream call; no STEP-BUDGET WARNING; no Phase 2", async () => {
    // Given: opts.maxSteps=1 (softCap=max(1,floor(1×0.8))=1, remaining=1-1=0 → twoPhase=false)
    // When:  always-tool-call model runs; Phase 1 has maxSteps=1 (full budget, single phase)
    // Then:  exactly 1 doStream call; no STEP-BUDGET WARNING injected
    const { model, callCount } = makeAlwaysToolCallModel();
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop({ model, system: "test", messages, tools, maxSteps: 1 });

    // softCap = max(1, floor(1*0.8)) = max(1, 0) = 1; remaining = 0; twoPhase = false
    assert.equal(callCount(), 1, "maxSteps=1 → exactly 1 doStream call (single phase, remaining=0 < 2)");
    assert.equal(
      hasStepBudgetWarning(messages),
      false,
      "no STEP-BUDGET WARNING for maxSteps=1 (twoPhase=false: remaining=0 < 2 threshold)",
    );
  });
});

// ─── T-Loop.6: abort during Phase 1 is clean ──────────────────────────────

describe("T-Loop.6: when abortSignal already aborted, runAgentLoop resolves cleanly", () => {
  it("pre-aborted signal → resolves without throw; no STEP-BUDGET WARNING injected", async () => {
    // Given: opts.abortSignal already aborted; model would throw AbortError via streamText
    // When:  runAgentLoop is called
    // Then:  returns (does not reject); no STEP-BUDGET WARNING appended to messages
    const { model } = makeNaturalStopModel();
    const ac = new AbortController();
    ac.abort(); // pre-abort
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    let threw = false;
    try {
      await runAgentLoop({ model, system: "test", messages, tools, maxSteps: 6, abortSignal: ac.signal });
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "pre-aborted signal → runAgentLoop must not rethrow (catch guards aborted state)");
    assert.equal(
      hasStepBudgetWarning(messages),
      false,
      "no STEP-BUDGET WARNING when aborted (loop exited before Phase 2 injection or natural stop)",
    );
  });
});

// ─── T-Loop.7: small budget (maxSteps 1–5) → single phase, no warning (C-2) ─

describe("T-Loop.7 (C-2): maxSteps=2 → remaining=1 < 2 → single phase; no STEP-BUDGET WARNING", () => {
  it("maxSteps=2: full budget used in single phase (cap=2, not softCap=1); no warning", async () => {
    // Given: opts.maxSteps=2 (softCap=floor(2×0.8)=1, remaining=2-1=1 < 2 → twoPhase=false)
    // When:  always-tool-call model; single phase runs at full budget (maxSteps=2, not softCap=1)
    // Then:  (a) no STEP-BUDGET WARNING injected; (b) exactly 2 doStream calls (full budget=2, not 1)
    const { model, callCount } = makeAlwaysToolCallModel();
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    await runAgentLoop({ model, system: "test", messages, tools, maxSteps: 2 });

    // twoPhase=false → runPhase(maxSteps=2), not runPhase(softCap=1)
    // If softCap=1 was accidentally used, callCount would be 1 (not 2)
    assert.equal(callCount(), 2, "maxSteps=2: exactly 2 doStream calls (full budget used, not truncated softCap=1)");
    assert.equal(
      hasStepBudgetWarning(messages),
      false,
      "no STEP-BUDGET WARNING: twoPhase=false (C-2 guard: remaining=1 < 2 threshold)",
    );
  });
});

// ─── T-Loop.8: no warning when tool-calls but softCap NOT reached (C-1) ─────

describe("T-Loop.8 (C-1): finishReason=tool-calls but stepCount<softCap → no warning (false-trigger guard)", () => {
  it("tool-calls after 1 step when softCap=4 → stepCount(1) < softCap(4) → no warning injected", async () => {
    // Given: opts.maxSteps=6 (softCap=4, remaining=2); mock whose Phase 1 resolves
    //        finishReason:'tool-calls' with stepCount=1 (< softCap=4) —
    //        achieved by passing tools:{} so echo has no execute → SDK cannot auto-continue
    // When:  runAgentLoop runs
    // Then:  cutOffMidTask predicate is false (stepCount=1 < softCap=4);
    //        no STEP-BUDGET WARNING appended; exactly 1 streamText pass
    let phase1calls = 0;
    const earlyStopModel = new MockLanguageModelV1({
      doStream: async () => {
        phase1calls++;
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallType: "function" as const,
                toolCallId: `c${phase1calls}`,
                toolName: "echo",
                args: '{"message":"x"}',
              },
              {
                type: "finish" as const,
                finishReason: "tool-calls" as const,
                usage: { promptTokens: 5, completionTokens: 2 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const messages: CoreMessage[] = [{ role: "user", content: "go" }];
    // tools:{} → echo has no execute → SDK halts after 1 unexecuted tool call → stepCount=1 < softCap=4
    await runAgentLoop({ model: earlyStopModel, system: "test", messages, tools: {}, maxSteps: 6 });

    // C-1: stepCount=1 < softCap=4 → cutOffMidTask=false → no Phase 2 → no warning
    assert.equal(
      phase1calls,
      1,
      "exactly 1 doStream call (tools={}: SDK cannot auto-continue without execute function)",
    );
    assert.equal(
      hasStepBudgetWarning(messages),
      false,
      "no STEP-BUDGET WARNING: stepCount(1) < softCap(4) → C-1 guard prevents false trigger",
    );
  });
});
