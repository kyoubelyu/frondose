import assert from "node:assert/strict";
import { test } from "node:test";
import { composeSystemPrompt } from "../../src/agent/systemPrompt/compose.js";

// T-M7: 3-band system prompt order contract

test("T-M7: composeSystemPrompt orders bands Boundary→Soul→Checkpoint with separator", () => {
  const out = composeSystemPrompt({ boundary: "B", soul: "S", checkpoint: "C" });
  assert.equal(out, "B\n\n---\n\nS\n\n---\n\nC");
  assert.ok(out.startsWith("B"), "must start with Boundary band");
  assert.ok(out.endsWith("C"), "must end with Checkpoint band");
  assert.equal(out.split("\n\n---\n\n").length, 3, "must have exactly 2 separators → 3 bands");
});

test("T-M7b: composeSystemPrompt with real placeholder content preserves order", () => {
  const boundary = "[BOUNDARY]";
  const soul = "[SOUL]";
  const checkpoint = "[CHECKPOINT]";
  const out = composeSystemPrompt({ boundary, soul, checkpoint });
  const parts = out.split("\n\n---\n\n");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], boundary);
  assert.equal(parts[1], soul);
  assert.equal(parts[2], checkpoint);
});
