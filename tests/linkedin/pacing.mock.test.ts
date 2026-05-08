/**
 * P-3 mock tests — T-M45: Pacing behavior.
 *
 * Verifies that applyPacing() waits between 400ms and 800ms and returns
 * the expected PacingResult shape.
 *
 * NOTE: This test waits ≥400ms (real setTimeout). Per plan §6.1, this is the
 * only mock test with >1s per-test runtime. All other mock tests run in <1s.
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPacing } from "../../src/linkedin/pacing.js";

// ─── T-M45 ─────────────────────────────────────────────────────────────────────

test("T-M45: applyPacing() resolves in 400-800ms with correct PacingResult shape", async () => {
  const before = Date.now();
  const result = await applyPacing();
  const elapsed = Date.now() - before;

  // Shape contract
  assert.equal(typeof result.waitedMs, "number", "waitedMs must be a number");
  assert.equal(typeof result.jitterMs, "number", "jitterMs must be a number");
  assert.equal(result.serial, true, "serial must be true");

  // Timing constraints
  assert.ok(result.waitedMs >= 400, `waitedMs (${result.waitedMs}) must be >= 400`);
  assert.ok(result.waitedMs <= 800, `waitedMs (${result.waitedMs}) must be <= 800`);
  assert.ok(result.jitterMs >= 0, "jitterMs must be >= 0");
  assert.ok(result.jitterMs < 400, `jitterMs (${result.jitterMs}) must be < 400`);
  assert.equal(result.waitedMs, 400 + result.jitterMs, "waitedMs must equal 400 + jitterMs");

  // Wall-clock check (with 50ms tolerance for test runner overhead)
  assert.ok(elapsed >= 380, `wall-clock elapsed (${elapsed}ms) must be at least 380ms`);
  assert.ok(elapsed < 1000, `wall-clock elapsed (${elapsed}ms) must be < 1000ms (sanity)`);
});
