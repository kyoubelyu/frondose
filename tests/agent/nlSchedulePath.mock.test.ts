/**
 * P-31 Step 4a — T-NL.1 scaffold (NL inbox → schedule_task end-to-end)
 *
 * Gate coverage:
 *   G-P31.5 — T-NL.1 (inbox message → runAgentLoop → schedule_task.execute →
 *              writeSchedule closes the full chain)
 *
 * DI surface (plan §11): makeAllTools worker mode with tmp schedulePath;
 * AI-SDK MockLanguageModelV1 scripted to emit a schedule_task tool call.
 *
 * NOTE (Step 4a red state):
 *   - makeAllTools does NOT include schedule_task yet (builder adds at Step 4b).
 *   - The mock model emits a schedule_task tool call; runAgentLoop will fail
 *     or produce an empty schedule.
 *   - Assertion body is TODO → test intentionally fails.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { runAgentLoop } from "../../src/agent/loop.js";
import { readSchedule } from "../../src/persistence/schedule.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p31-nl-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// ─── T-NL.1 ───────────────────────────────────────────────────────────────────

describe("NL inbox → schedule_task end-to-end (G-P31.5)", () => {
  it("T-NL.1: given user turn 'schedule daily 9am check' and a mock model that emits schedule_task({task,cron_expr}), after runAgentLoop the schedule.jsonl contains the new record", async () => {
    // Given:  makeAllTools(undefined, {schedulePath}, control, undefined, {mode:"worker",workerId:"w1"})
    //         + MockLanguageModelV1 scripted to emit schedule_task tool call
    //         + messages seeded with user turn "please schedule a daily 9am check"
    // When:   runAgentLoop({model, system:"test", messages, tools, maxSteps:3})
    // Then:   readSchedule(schedulePath) has 1 record with task & cron_expr from the tool call

    const { dir, cleanup } = makeTmpDir();
    try {
      const schedulePath = join(dir, "schedule.jsonl");

      // Build tools (schedule_task will be present after builder Step 4b)
      const tools = makeAllTools(
        undefined,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json"), schedulePath },
        mockControl,
        undefined,
        { mode: "worker", workerId: "test-worker" },
      );

      // Mock model: step 1 emits schedule_task tool call; step 2 emits text "Done"
      let step = 0;
      const model = new MockLanguageModelV1({
        doStream: async () => {
          step++;
          if (step === 1) {
            return {
              stream: simulateReadableStream({
                chunks: [
                  {
                    type: "tool-call" as const,
                    toolCallType: "function" as const,
                    toolCallId: "nl-st-1",
                    toolName: "schedule_task",
                    args: JSON.stringify({ task: "daily 9am check", cron_expr: "0 9 * * *" }),
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
          // Step 2: text response after tool result
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-delta" as const, textDelta: "Done — scheduled daily 9am check." },
                {
                  type: "finish" as const,
                  finishReason: "stop" as const,
                  usage: { promptTokens: 20, completionTokens: 10 },
                },
              ],
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });

      const messages: CoreMessage[] = [{ role: "user", content: "please schedule a daily 9am check" }];

      await runAgentLoop({ model, system: "test", messages, tools, maxSteps: 3 });

      // schedule.jsonl must have 1 record written by schedule_task.execute
      const records = readSchedule(schedulePath);
      assert.equal(
        records.length,
        1,
        `schedule.jsonl must have exactly 1 record after runAgentLoop calls schedule_task; got ${records.length}`,
      );
      const rec = records[0];
      assert.ok(rec !== undefined, "schedule record must exist");
      assert.equal(rec.task, "daily 9am check", "record.task must match the tool call argument");
      assert.equal(rec.cronExpr, "0 9 * * *", "record.cronExpr must match the tool call argument");
      assert.equal(rec.type, "recurring", "record.type must be 'recurring'");
      assert.equal(rec.enabled, true, "record.enabled must be true");
    } finally {
      cleanup();
    }
  });
});
