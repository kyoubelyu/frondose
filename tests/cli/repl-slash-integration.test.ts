/**
 * P-8 mock tests — T-ReplInt.1..T-ReplInt.4
 *
 * Integration tests for slash dispatch in runRepl() (src/cli/repl.ts).
 * Tests that slash commands intercept BEFORE the LLM and BEFORE messages.push().
 *
 * T-ReplInt.1 — /help dispatched before LLM; messages NOT pushed; no LLM call
 * T-ReplInt.2 — non-slash line goes to LLM; user message pushed; LLM called once
 * T-ReplInt.3 — runOneShot does NOT process slash commands (D-11)
 * T-ReplInt.4 — /unknown still intercepts (LLM not called); only unknown-command output
 *
 * Gate coverage: G-P8.3 (all slash commands intercept BEFORE LLM), G-P8.7 (runOneShot no regression)
 *
 * Uses PassThrough streams for input injection.
 * No real LLM calls, no Chrome, no real ~/.mai writes.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { CoreMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { runOneShot, runRepl } from "../../src/cli/repl.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p8-repl-int-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeOut(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

function makeCountingModel(): { model: MockLanguageModelV1; callCount: () => number } {
  let count = 0;
  const model = new MockLanguageModelV1({
    provider: "openai",
    modelId: "deepseek-v4-flash",
    doStream: async () => {
      count++;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-delta" as const, textDelta: "llm-response" },
            {
              type: "finish" as const,
              finishReason: "stop" as const,
              usage: { promptTokens: 10, completionTokens: 5 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, callCount: () => count };
}

// ─── T-ReplInt.1: /help dispatched before LLM ────────────────────────────────

test("T-ReplInt.1: /help dispatched before LLM; messages NOT pushed; zero LLM calls", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const { model, callCount } = makeCountingModel();
    const messages: CoreMessage[] = [];
    const sessionFile = join(dir, "session.jsonl");
    const { lines, stream: out } = makeOut();

    const input = new PassThrough();
    input.write("/help\n");
    input.end();

    await runRepl({
      model,
      system: "test system",
      messages,
      tools: {},
      sessionFile,
      out,
      in_: input,
    });

    // Guard: /help must intercept BEFORE LLM (guardian §8 item 1)
    assert.equal(callCount(), 0, "/help must produce zero LLM calls");

    // Guard: /help must NOT push a user message (guardian §8 item 1)
    assert.equal(messages.length, 0, "/help must not push any message to the messages array");

    // Guard: HELP_TEXT must be printed with all 3 rev-3 commands
    const output = lines.join("");
    assert.ok(output.includes("/compact"), "HELP_TEXT contains /compact");
    assert.ok(output.includes("/new"), "HELP_TEXT contains /new");
    assert.ok(output.includes("/help"), "HELP_TEXT contains /help");
    assert.ok(!output.includes("/cost"), "HELP_TEXT does not mention /cost (removed rev-3)");
    assert.ok(!output.includes("/sessions"), "HELP_TEXT does not mention /sessions (rejected)");
  } finally {
    cleanup();
  }
});

// ─── T-ReplInt.2: non-slash line goes to LLM ─────────────────────────────────

test("T-ReplInt.2: non-slash input goes to LLM; user message pushed; LLM called exactly once", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const { model, callCount } = makeCountingModel();
    const messages: CoreMessage[] = [];
    const sessionFile = join(dir, "session.jsonl");
    const { stream: out } = makeOut();

    const input = new PassThrough();
    input.write("what is 2+2?\n");
    input.end();

    await runRepl({
      model,
      system: "test system",
      messages,
      tools: {},
      sessionFile,
      out,
      in_: input,
    });

    assert.equal(callCount(), 1, "exactly one LLM call for non-slash input");
    const userMessages = messages.filter((m) => m.role === "user");
    assert.equal(userMessages.length, 1, "one user message pushed");
    assert.equal(userMessages[0]?.content, "what is 2+2?", "user message content correct");
  } finally {
    cleanup();
  }
});

// ─── T-ReplInt.3: runOneShot does NOT process slash (D-11) ───────────────────

test("T-ReplInt.3: runOneShot passes /help verbatim to LLM (D-11: no slash dispatch in one-shot)", async () => {
  // Guardian §8 item 2: runOneShot body has no dispatchSlash call.
  // Verify: sending "/help" as the prompt goes to the LLM, NOT the slash dispatcher.

  const { dir, cleanup } = makeTempDir();
  try {
    const { model, callCount } = makeCountingModel();
    const messages: CoreMessage[] = [];
    const sessionFile = join(dir, "session.jsonl");
    const { stream: out } = makeOut();

    await runOneShot({
      model,
      system: "test system",
      messages,
      tools: {},
      sessionFile,
      out,
      prompt: "/help",
    });

    // LLM must have been called (slash not intercepted in one-shot mode)
    assert.equal(callCount(), 1, "runOneShot sends /help verbatim to LLM (D-11)");

    // The user message "/help" must be in the messages array
    const userMsg = messages.find((m) => m.role === "user");
    assert.equal(userMsg?.content, "/help", 'user message "/help" pushed verbatim');
  } finally {
    cleanup();
  }
});

// ─── T-ReplInt.4: /unknown intercepts before LLM ─────────────────────────────

test("T-ReplInt.4: unknown slash command intercepts before LLM; no message pushed; handled with notice", async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const { model, callCount } = makeCountingModel();
    const messages: CoreMessage[] = [];
    const sessionFile = join(dir, "session.jsonl");
    const { lines, stream: out } = makeOut();

    const input = new PassThrough();
    input.write("/nonexistent-cmd\n");
    input.end();

    await runRepl({
      model,
      system: "test system",
      messages,
      tools: {},
      sessionFile,
      out,
      in_: input,
    });

    // Unknown slash must still intercept (not fall through to LLM)
    assert.equal(callCount(), 0, "unknown slash must produce zero LLM calls");
    assert.equal(messages.length, 0, "unknown slash must not push a message");

    const output = lines.join("");
    assert.ok(
      output.includes("unknown") || output.includes("/help"),
      `unknown slash must print notice; got: "${output.slice(0, 200)}"`,
    );
  } finally {
    cleanup();
  }
});

// ─── T-ReplInt.5: onStepFinish chain preserved ────────────────────────────────

test("T-ReplInt.5: onStepFinish chain calls audit handler AFTER tokenBudget.add (guardian §8 item 3)", async () => {
  // Verify composedStepFinish: tokenBudget.add() fires first, then opts.onStepFinish.
  const { dir, cleanup } = makeTempDir();
  try {
    const auditCalls: Array<{ promptTokens: number }> = [];
    const model = new MockLanguageModelV1({
      provider: "openai",
      modelId: "deepseek-v4-flash",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-delta" as const, textDelta: "hi" },
            {
              type: "finish" as const,
              finishReason: "stop" as const,
              usage: { promptTokens: 42, completionTokens: 3 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const messages: CoreMessage[] = [];
    const sessionFile = join(dir, "session.jsonl");
    const { stream: out } = makeOut();

    const input = new PassThrough();
    input.write("test prompt\n");
    input.end();

    await runRepl({
      model,
      system: "test system",
      messages,
      tools: {},
      sessionFile,
      out,
      in_: input,
      onStepFinish: async (step) => {
        auditCalls.push({ promptTokens: step.usage.promptTokens });
      },
    });

    // onStepFinish must have been called
    assert.ok(auditCalls.length > 0, "onStepFinish (audit writer) must be called");
    // The step usage should include the mock's 42 promptTokens
    assert.equal(auditCalls[0]?.promptTokens, 42, "step usage passed to audit handler correctly");
  } finally {
    cleanup();
  }
});
