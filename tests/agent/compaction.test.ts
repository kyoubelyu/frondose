/**
 * P-8 mock tests — T-Compact.1..T-Compact.5
 *
 * Tests for compactMessages() added in src/agent/compaction.ts.
 *
 * T-Compact.1 — happy path: > lastK messages → summary head + tail returned; marker shape correct
 * T-Compact.2 — no-op: messages.length <= lastK → original array returned; summarizedCount = 0
 * T-Compact.3 — API failure: generateText throws → compactMessages throws (caller is responsible)
 * T-Compact.4 — role:"user" + prefix shape (D-9 / CONCERN-MR-1 resolution)
 * T-Compact.5 — custom lastK parameter honoured
 *
 * Gate coverage: G-P8.1 (compaction engine logic), G-P8.2 (no-op branch)
 *
 * Uses MockLanguageModelV1 with doGenerate for generateText path.
 * No real LLM calls, no Chrome, no filesystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreMessage } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { compactMessages } from "../../src/agent/compaction.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeModel(summaryText = "Conversation summary."): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop" as const,
      usage: { promptTokens: 100, completionTokens: 50 },
      text: summaryText,
    }),
  });
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message-content-${i}`,
  }));
}

// ─── T-Compact.1: happy path ─────────────────────────────────────────────────

test("T-Compact.1: compactMessages with 15 messages and lastK=10 → 1 summary head + 10 tail", async () => {
  const model = makeModel("Summary of the first 5 messages.");
  const messages = makeMessages(15);

  const { newMessages, marker } = await compactMessages({ model, messages, lastK: 10 });

  // newMessages = 1 summary head + 10 tail = 11 total
  assert.equal(newMessages.length, 11, "newMessages = 1 summary + 10 tail");

  // First message is the summary head
  const head = newMessages[0];
  assert.ok(head !== undefined, "summary head exists");

  // Tail messages are the last 10 originals (indices 5..14)
  for (let i = 1; i <= 10; i++) {
    assert.deepEqual(newMessages[i], messages[i + 4], `tail[${i - 1}] matches original message ${i + 4}`);
  }

  // Marker shape
  assert.equal(marker.type, "compaction");
  assert.equal(marker.summarizedCount, 5, "first 5 messages summarized");
  assert.equal(marker.keptCount, 10, "last 10 kept verbatim");
  assert.ok(typeof marker.ts === "string" && marker.ts.length > 0, "ts is an ISO string");
  assert.ok(typeof marker.model === "string" && marker.model.length > 0, "model label present");
});

// ─── T-Compact.2: no-op branch (messages.length <= lastK) ────────────────────

test("T-Compact.2: no-op when messages.length <= lastK → original array returned, summarizedCount=0", async () => {
  const model = makeModel("Should not be called.");
  const messages = makeMessages(8); // <= default lastK=10

  const { newMessages, marker } = await compactMessages({ model, messages, lastK: 10 });

  // Returns the original array (same reference for the inner no-op path)
  assert.equal(newMessages.length, 8, "all messages returned unchanged");
  assert.equal(marker.summarizedCount, 0, "summarizedCount = 0 (nothing summarized)");
  assert.equal(marker.keptCount, 8, "keptCount = 8");
  // Verify content unchanged
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(newMessages[i], messages[i]);
  }
});

// ─── T-Compact.3: API failure propagates to caller ────────────────────────────

test("T-Compact.3: API failure from generateText propagates as thrown error to caller", async () => {
  const errorModel = new MockLanguageModelV1({
    doGenerate: async () => {
      throw new Error("Network error: connection refused");
    },
  });

  const messages = makeMessages(15); // > lastK, so summarization path is taken

  await assert.rejects(
    () => compactMessages({ model: errorModel, messages, lastK: 10 }),
    (err: Error) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("connection refused"), `got: ${err.message}`);
      return true;
    },
    "compactMessages must re-throw LLM errors; caller wraps in try/catch per D-16",
  );
});

// ─── T-Compact.4: role:"user" + prefix shape (D-9 / CONCERN-MR-1) ────────────

test("T-Compact.4: summary head is role:'user' with [Previous conversation summary by /compact] prefix", async () => {
  const summaryBody = "The operator discussed LinkedIn lead qualification.";
  const model = makeModel(summaryBody);
  const messages = makeMessages(12); // > lastK=10

  const { newMessages } = await compactMessages({ model, messages, lastK: 10 });

  const head = newMessages[0];
  assert.ok(head !== undefined, "summary head exists");
  assert.equal(head.role, "user", "summary head role must be 'user' (not 'system') per D-9/CONCERN-MR-1");
  assert.ok(typeof head.content === "string", "summary head content must be a string");
  const content = head.content as string;
  assert.ok(
    content.startsWith("[Previous conversation summary by /compact]"),
    `summary head must start with canonical prefix; got: "${content.slice(0, 60)}"`,
  );
  assert.ok(content.includes(summaryBody), "summary head must include the generated summary text");
});

// ─── T-Compact.5: custom lastK parameter ─────────────────────────────────────

test("T-Compact.5: custom lastK=5 keeps only the last 5 messages", async () => {
  const model = makeModel("Custom K summary.");
  const messages = makeMessages(12); // total=12, lastK=5 → head=7, tail=5

  const { newMessages, marker } = await compactMessages({ model, messages, lastK: 5 });

  assert.equal(newMessages.length, 6, "1 summary head + 5 tail");
  assert.equal(marker.summarizedCount, 7, "7 messages summarized");
  assert.equal(marker.keptCount, 5, "5 messages kept");
  // Tail is the last 5 originals (indices 7..11)
  for (let i = 1; i <= 5; i++) {
    assert.deepEqual(newMessages[i], messages[i + 6]);
  }
});
