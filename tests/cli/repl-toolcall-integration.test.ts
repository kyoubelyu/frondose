/**
 * P-48 Step 4a scaffold — T-Tool.12 (G-P48.1 / G-P48.5)
 *
 * Mock integration test for `runRepl` composedStepFinish wiring and
 * audit-ordering invariant. Added at Step 3b per CONCERN-MR-2.
 *
 * Gate coverage:
 *   G-P48.1 — T-Tool.12 (tool-call line rendered per tool call in REPL)
 *   G-P48.5 — T-Tool.12 (tool-call lines emit BEFORE audit writer fires)
 *
 * Reference pattern:
 *   tests/cli/repl-slash-integration.test.ts:221 (MockLanguageModelV1 +
 *   PassThrough stdin + captured WritableStream)
 *
 * Setup:
 *   1. Forces process.stdout.isTTY = true (P-48 gate condition: out===process.stdout && isTTY)
 *   2. Stubs process.stdout.write to record writes into an ordered string[]
 *   3. MockLanguageModelV1 emits a two-tool-call step (toolCallId "a"/"b", toolName "echoN")
 *      followed by a text finish step
 *   4. onStepFinish spy pushes "AUDIT-MARK" into the same recorder (simulating audit writer)
 *   5. runRepl is called with out: process.stdout and the PassThrough input
 *
 * Assertion:
 *   recorder must contain (in order):
 *     (i)  two writes matching /⚙ echoN\(.+\) → ✓/ (one per toolResult, index order n:1 before n:2)
 *     (ii) "AUDIT-MARK" appears AFTER both ⚙ writes for that step
 *
 * All assertion bodies are TODO (assert.fail) — validator fills at Step 5.
 *
 * Source files involved (builder creates/modifies at Step 4b):
 *   - src/cli/toolCallLine.ts (NEW — formatToolCallLine used by composedStepFinish)
 *   - src/cli/repl.ts (MODIFY — composedStepFinish extended with P-48 tool-call emit)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { CoreMessage, StepResult, ToolSet } from "ai";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { z } from "zod";
import { runRepl } from "../../src/cli/repl.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p48-repl-tc-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Minimal inline tool that takes {n:number} and returns {ok:true, n}.
 * Named "echoN" to match the pattern asserted in T-Tool.12.
 * The result shape `{ok:true}` classifies as success (✓) per classifyResult.
 */
const echoNTool = tool({
  description: "echo n",
  parameters: z.object({ n: z.number().describe("echo value") }),
  execute: async ({ n }) => ({ ok: true, n }),
});

/**
 * Build a MockLanguageModelV1 that emits a two-tool-call step on first
 * invocation, then a text step on the second invocation.
 *
 * Step 1 (tool-calls):
 *   echoN(n:1) → toolCallId "a"
 *   echoN(n:2) → toolCallId "b"
 *
 * Step 2 (text):
 *   "done"
 */
function makeTwoToolCallModel(): MockLanguageModelV1 {
  let stepIdx = 0;
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-p48",
    doStream: async () => {
      stepIdx++;
      if (stepIdx === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallType: "function" as const,
                toolCallId: "a",
                toolName: "echoN",
                args: JSON.stringify({ n: 1 }),
              },
              {
                type: "tool-call" as const,
                toolCallType: "function" as const,
                toolCallId: "b",
                toolName: "echoN",
                args: JSON.stringify({ n: 2 }),
              },
              {
                type: "finish" as const,
                finishReason: "tool-calls" as const,
                usage: { promptTokens: 10, completionTokens: 4 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      // Step 2: text response after tools executed
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-delta" as const, textDelta: "done" },
            {
              type: "finish" as const,
              finishReason: "stop" as const,
              usage: { promptTokens: 20, completionTokens: 4 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

// ─── G-P48.1 + G-P48.5: runRepl tool-call display + audit ordering ───────────

describe("runRepl composedStepFinish wiring + audit ordering (G-P48.1 / G-P48.5)", () => {
  it("T-Tool.12: when process.stdout.isTTY=true + 2-toolResult mock step + AUDIT-MARK onStepFinish, THEN recorder has 2 ⚙ writes before AUDIT-MARK", async () => {
    // Given: process.stdout.isTTY forced true; process.stdout.write captured into recorder[];
    //        MockLanguageModelV1 returning a step with TWO toolResults (echoN n:1, n:2);
    //        onStepFinish spy pushes "AUDIT-MARK" into recorder (simulating audit writer delay)
    // When:  runRepl({out:process.stdout, in_:passThrough, onStepFinish:spy, ...}) completes
    // Then:  recorder contains (in order) two /⚙ echoN\(.+\) → ✓/ matches (n:1 before n:2)
    //        THEN the "AUDIT-MARK" token — proving tool-call emit fires BEFORE audit writer
    const { dir, cleanup } = makeTempDir();

    // Pre-write a minimal MAI_HOME_BASE so getHomeBase()-dependent paths resolve.
    const savedHome = process.env.HOME;
    const savedMaiHomeBase = process.env.MAI_HOME_BASE;
    process.env.MAI_HOME_BASE = dir;
    process.env.HOME = dir;

    // Force isTTY on process.stdout for the duration of this test.
    // P-48 gate: out === process.stdout && process.stdout.isTTY === true
    // biome-ignore lint/suspicious/noExplicitAny: writable isTTY for test purpose
    const savedIsTTY = (process.stdout as any).isTTY;
    // biome-ignore lint/suspicious/noExplicitAny: force-set isTTY per Node ≥ 20 pattern
    (process.stdout as any).isTTY = true;

    // Capture process.stdout.write into ordered string[] (including AUDIT-MARK from spy)
    const recorder: string[] = [];
    const savedWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: stub for test capture
    (process.stdout as any).write = (chunk: any) => {
      recorder.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };

    try {
      // Create required .mai/agent/ dir so runRepl's writePid doesn't ENOENT.
      mkdirSync(join(dir, ".mai", "agent"), { recursive: true });

      const model = makeTwoToolCallModel();
      const messages: CoreMessage[] = [];
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, ""); // empty session

      // PassThrough input: one user prompt + EOF
      const input = new PassThrough();
      input.write("run the test\n");
      input.end();

      // Audit spy: pushes AUDIT-MARK into recorder to anchor the ordering assertion.
      const auditSpy = async (_step: StepResult<ToolSet>): Promise<void> => {
        recorder.push("AUDIT-MARK");
      };

      await runRepl({
        model,
        system: "test system",
        messages,
        tools: { echoN: echoNTool },
        sessionFile,
        out: process.stdout,
        in_: input,
        onStepFinish: auditSpy,
      });

      // ── Assertions: 2 ⚙ echoN writes appear in recorder BEFORE first AUDIT-MARK ──
      // Find all writes containing ⚙ echoN
      const toolWrites = recorder.map((s, i) => ({ s, i })).filter(({ s }) => /⚙.*echoN/.test(s));

      // Find the first AUDIT-MARK token in recorder
      const auditIdx = recorder.indexOf("AUDIT-MARK");

      assert.ok(
        auditIdx >= 0,
        `T-Tool.12: AUDIT-MARK must appear in recorder. Full recorder: ${JSON.stringify(recorder.slice(0, 25))}`,
      );
      assert.ok(
        toolWrites.length >= 2,
        `T-Tool.12: expected ≥ 2 ⚙ echoN writes, got ${toolWrites.length}. recorder: ${JSON.stringify(recorder.slice(0, 30))}`,
      );

      const [first, second] = toolWrites;
      assert.ok(
        first.i < auditIdx,
        `T-Tool.12: first ⚙ echoN write (idx ${first.i}) must appear BEFORE AUDIT-MARK (idx ${auditIdx})`,
      );
      assert.ok(
        second.i < auditIdx,
        `T-Tool.12: second ⚙ echoN write (idx ${second.i}) must appear BEFORE AUDIT-MARK (idx ${auditIdx})`,
      );

      // n:1 before n:2 ordering — formatArgs({n:1}) = '({"n":1})', which contains '"n":1'
      assert.ok(/"n":1/.test(first.s), `T-Tool.12: first ⚙ write must contain n:1; got: ${first.s}`);
      assert.ok(/"n":2/.test(second.s), `T-Tool.12: second ⚙ write must contain n:2; got: ${second.s}`);
    } finally {
      // Restore process.stdout.write and isTTY
      // biome-ignore lint/suspicious/noExplicitAny: restore stubbed write
      (process.stdout as any).write = savedWrite;
      // biome-ignore lint/suspicious/noExplicitAny: restore isTTY
      (process.stdout as any).isTTY = savedIsTTY;
      // Restore env
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedMaiHomeBase !== undefined) process.env.MAI_HOME_BASE = savedMaiHomeBase;
      else delete process.env.MAI_HOME_BASE;
      cleanup();
    }
  });
});
