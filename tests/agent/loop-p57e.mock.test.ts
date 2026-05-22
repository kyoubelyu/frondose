/**
 * P-57e rev-2 Step 5 — T-Issue.2 — FILLED
 * (G-P57e.9)
 *
 * Mock-LLM-driven (MockLanguageModelV1 + simulateReadableStream from "ai/test"; loop-p56b pattern).
 * Scripts the (f) self-report+fallback protocol sequence:
 *   step 1 → primary_tool (returns {ok:false, error:{kind:"runtime_error"}})
 *   step 2 → primary_tool again (fallback — same error)
 *   step 3 → primary_tool again (retry — same error)
 *   step 4 → gh_issue(dedupKey="failure:primary_tool:runtime_error", labels=[...agent-self-report], body has turnId)
 *   step 5 → stop
 *
 * This is a WIRING test (per Step 4a documented ambiguity #3 + OQ-PLAN.38): it asserts the agent
 * loop correctly EXECUTES the scripted gh_issue tool-call (args flow through to gh_issue's execute)
 * followed by stop — NOT that a real LLM chooses gh_issue (that's T-LIVE.Issue). Deterministic
 * scripting → not brittle → strict form retained (no relaxation needed).
 *
 * D-P56b-01 lesson: tool schemas MUST be registered in the tools map so the SDK routes the
 * synthetic tool-call chunks into step.toolCalls + runs their execute fns.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/agent/loop-p57e.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CoreMessage, tool } from "ai";
import { MockLanguageModelV1, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { runAgentLoop } from "../../src/agent/loop.js";

// ─── T-Issue.2 — 3-fail-then-gh_issue mock-LLM driven ───────────────────────

describe("runAgentLoop — agent files gh_issue with engineered dedupKey after 3 same-error retries (G-P57e.9)", () => {
  it("T-Issue.2: given a mock-LLM scripted sequence [primary→runtime_error ×3, gh_issue, stop] with gh_issue execute spy + tools registered, WHEN runAgentLoop runs, THEN gh_issue spy invoked with dedupKey==='failure:primary_tool:runtime_error' + labels includes 'agent-self-report' + body contains turnId; stop called AFTER gh_issue (no silent exit)", async () => {
    const TURN_ID = "t-abc123";
    const DEDUP_KEY = "failure:primary_tool:runtime_error";

    // Per-step scripted tool-call sequence.
    const toolCallScript = [
      { toolName: "primary_tool", args: "{}" },
      { toolName: "primary_tool", args: "{}" },
      { toolName: "primary_tool", args: "{}" },
      {
        toolName: "gh_issue",
        args: JSON.stringify({
          title: `[agent-self-report] ${DEDUP_KEY}`,
          body: `turnId: ${TURN_ID}\ntool: primary_tool\nerror kind: runtime_error\nsteps tried: primary + fallback + retry\nurl: https://www.linkedin.com/in/blocked/`,
          labels: ["agent-self-report", "failure-mode"],
          dedupKey: DEDUP_KEY,
        }),
      },
      { toolName: "stop", args: "{}" },
    ];

    let step = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        const tc = toolCallScript[Math.min(step, toolCallScript.length - 1)];
        step++;
        const isStop = tc.toolName === "stop";
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallType: "function" as const,
                toolCallId: `tc-${step}`,
                toolName: tc.toolName,
                args: tc.args,
              },
              {
                type: "finish" as const,
                // Continue the loop after each tool-call; stop tool terminates via requestStop.
                finishReason: isStop ? ("stop" as const) : ("tool-calls" as const),
                usage: { promptTokens: 1, completionTokens: 1 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });

    // Spies / capture.
    // biome-ignore lint/suspicious/noExplicitAny: captured args loose
    let ghIssueArgs: any = null;
    let ghIssueCalledAtStep = -1;
    let stopCalledAtStep = -1;
    let callIndex = 0;

    const tools = {
      primary_tool: tool({
        description: "primary tool (mock) that fails with runtime_error",
        parameters: z.object({}),
        execute: async () => {
          callIndex++;
          return { ok: false, error: { kind: "runtime_error", message: "primary failed" } };
        },
      }),
      gh_issue: tool({
        description: "file a GitHub issue (mock spy)",
        parameters: z.object({
          title: z.string(),
          body: z.string(),
          labels: z.array(z.string()).default([]),
          dedupKey: z.string().optional(),
        }),
        // biome-ignore lint/suspicious/noExplicitAny: capture
        execute: async (args: any) => {
          callIndex++;
          ghIssueArgs = args;
          ghIssueCalledAtStep = callIndex;
          return { ok: true, issueUrl: "https://github.com/x/y/issues/1", deduped: false };
        },
      }),
      stop: tool({
        description: "stop the agent loop (mock spy)",
        parameters: z.object({}),
        execute: async () => {
          callIndex++;
          stopCalledAtStep = callIndex;
          return { ok: true, stopped: true };
        },
      }),
    };

    const messages: CoreMessage[] = [{ role: "user", content: "process the failure scenario" }];

    await runAgentLoop({
      model,
      system: "",
      messages,
      tools,
      maxSteps: 8,
    });

    // gh_issue was invoked with the engineered dedupKey + labels + turnId body.
    assert.ok(ghIssueArgs !== null, "gh_issue execute must have been invoked by the agent loop wiring");
    assert.equal(
      ghIssueArgs.dedupKey,
      DEDUP_KEY,
      `gh_issue dedupKey must be 'failure:primary_tool:runtime_error'; got: ${ghIssueArgs.dedupKey}`,
    );
    assert.ok(
      Array.isArray(ghIssueArgs.labels) && ghIssueArgs.labels.includes("agent-self-report"),
      `gh_issue labels must include 'agent-self-report'; got: ${JSON.stringify(ghIssueArgs.labels)}`,
    );
    assert.ok(
      typeof ghIssueArgs.body === "string" && ghIssueArgs.body.includes(TURN_ID),
      `gh_issue body must contain turnId '${TURN_ID}'; got: ${String(ghIssueArgs.body).slice(0, 120)}`,
    );

    // stop called AFTER gh_issue (no silent exit).
    assert.ok(stopCalledAtStep > 0, "stop must have been called (agent does NOT exit silently)");
    assert.ok(
      stopCalledAtStep > ghIssueCalledAtStep,
      `stop (call #${stopCalledAtStep}) must be called AFTER gh_issue (call #${ghIssueCalledAtStep})`,
    );
  });
});
