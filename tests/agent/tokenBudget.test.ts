/**
 * P-8 mock tests — T-TokenBudget.1..T-TokenBudget.5
 *
 * Tests for TokenBudget class and MODEL_CONTEXT_WINDOWS table added in P-8
 * src/agent/tokenBudget.ts.
 *
 * T-TokenBudget.1  — add() accumulates cumulativeCompletion, cumulativeTotal, lastPromptTokens
 * T-TokenBudget.2  — reset() zeros all mutable fields; contextWindow unchanged
 * T-TokenBudget.3  — contextWindowFor composite key lookup (openai:deepseek-v4-flash → 1M)
 * T-TokenBudget.4  — contextWindowFor bare modelId fallback (deepseek-v4-flash → 1M)
 * T-TokenBudget.5  — contextWindowFor unknown model → DEFAULT 128_000
 *
 * Gate coverage: G-P8.2 (auto-compaction threshold math), G-P8.3 (status line budget input)
 *
 * No LLM calls, no Chrome, no filesystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { MODEL_CONTEXT_WINDOWS, TokenBudget } from "../../src/agent/tokenBudget.js";

// ─── helper ──────────────────────────────────────────────────────────────────

function makeModel(provider: string, modelId: string): MockLanguageModelV1 {
  return new MockLanguageModelV1({ provider, modelId });
}

// ─── T-TokenBudget.1: add() accumulates correctly ────────────────────────────

test("T-TokenBudget.1: add() accumulates cumulativeCompletion, cumulativeTotal, lastPromptTokens", () => {
  const model = makeModel("openai", "deepseek-v4-flash");
  const budget = new TokenBudget(model);

  // Initial state
  assert.equal(budget.cumulativeCompletion, 0);
  assert.equal(budget.cumulativeTotal, 0);
  assert.equal(budget.lastPromptTokens, 0);

  // First add
  budget.add({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  assert.equal(budget.cumulativeCompletion, 50);
  assert.equal(budget.cumulativeTotal, 150);
  assert.equal(budget.lastPromptTokens, 100); // replaced (not accumulated)

  // Second add — completion + total accumulate; lastPromptTokens replaces
  budget.add({ promptTokens: 200, completionTokens: 30, totalTokens: 230 });
  assert.equal(budget.cumulativeCompletion, 80, "completion accumulates");
  assert.equal(budget.cumulativeTotal, 380, "total accumulates");
  assert.equal(budget.lastPromptTokens, 200, "lastPromptTokens replaced, not accumulated");
});

// ─── T-TokenBudget.2: reset() zeros mutable fields ───────────────────────────

test("T-TokenBudget.2: reset() zeros all mutable fields; contextWindow unchanged", () => {
  const model = makeModel("anthropic", "claude-sonnet-4-5");
  const budget = new TokenBudget(model);

  budget.add({ promptTokens: 1000, completionTokens: 200, totalTokens: 1200 });
  assert.equal(budget.lastPromptTokens, 1000);

  const windowBefore = budget.contextWindow;
  budget.reset();

  assert.equal(budget.cumulativeCompletion, 0, "cumulativeCompletion reset to 0");
  assert.equal(budget.cumulativeTotal, 0, "cumulativeTotal reset to 0");
  assert.equal(budget.lastPromptTokens, 0, "lastPromptTokens reset to 0");
  assert.equal(budget.contextWindow, windowBefore, "contextWindow unchanged by reset");
  // Verify no cumulativePrompt field (rev-3: dropped)
  assert.ok(!("cumulativePrompt" in budget), "cumulativePrompt field must NOT exist (rev-3 dropped)");
});

// ─── T-TokenBudget.3: composite key lookup ────────────────────────────────────

test("T-TokenBudget.3: contextWindowFor composite key openai:deepseek-v4-flash → 1_000_000", () => {
  const model = makeModel("openai", "deepseek-v4-flash");
  const cw = TokenBudget.contextWindowFor(model);
  assert.equal(cw, 1_000_000, "deepseek-v4-flash (via OpenAI adapter) = 1M context window");

  // Verify in MODEL_CONTEXT_WINDOWS table directly
  assert.equal(MODEL_CONTEXT_WINDOWS["openai:deepseek-v4-flash"], 1_000_000);
  assert.equal(MODEL_CONTEXT_WINDOWS["anthropic:claude-sonnet-4-5"], 200_000);
  assert.equal(MODEL_CONTEXT_WINDOWS["openai:gpt-4o"], 128_000);
});

// ─── T-TokenBudget.4: bare modelId fallback ───────────────────────────────────

test("T-TokenBudget.4: contextWindowFor falls back to bare modelId when composite misses", () => {
  // Simulate a model with no 'provider' property set (edge-case adapter)
  const model = makeModel("unknown-adapter", "deepseek-v4-flash");
  // composite key "unknown-adapter:deepseek-v4-flash" is NOT in the table
  // bare key "deepseek-v4-flash" IS in the table
  assert.ok(!MODEL_CONTEXT_WINDOWS["unknown-adapter:deepseek-v4-flash"], "composite key missing");
  const cw = TokenBudget.contextWindowFor(model);
  assert.equal(cw, 1_000_000, "fell back to bare modelId lookup → 1M");
});

// ─── T-TokenBudget.5: unknown model → DEFAULT 128_000 ────────────────────────

test("T-TokenBudget.5: contextWindowFor unknown model returns DEFAULT 128_000", () => {
  const model = makeModel("unknown-provider", "totally-unknown-model-xyz");
  const cw = TokenBudget.contextWindowFor(model);
  assert.equal(cw, 128_000, "unknown model → DEFAULT_CONTEXT_WINDOW = 128_000");
});

// ─── T-TokenBudget.6: constructor wires contextWindow on construction ─────────

test("T-TokenBudget.6: constructor sets contextWindow from model at construction time", () => {
  const flashModel = makeModel("openai", "deepseek-v4-flash");
  const budgetFlash = new TokenBudget(flashModel);
  assert.equal(budgetFlash.contextWindow, 1_000_000);

  const gpt4o = makeModel("openai", "gpt-4o");
  const budgetGPT = new TokenBudget(gpt4o);
  assert.equal(budgetGPT.contextWindow, 128_000);

  // Rev-3 guard: no cumulativePrompt field anywhere
  assert.ok(!("cumulativePrompt" in budgetFlash), "no cumulativePrompt (rev-3)");
  assert.ok(!("cumulativePrompt" in budgetGPT), "no cumulativePrompt (rev-3)");
});
