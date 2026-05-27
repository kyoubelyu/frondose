/**
 * P-SP-E Step 5 — T-E.Sse.1..3 (G-PSPE.15) — assertions filled.
 * SseFrame union type-check: 3 new auto-run frame shapes accepted by the union.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/serve/autoRunSseFrames.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// SseFrame type import: compile-safe via type-only import (exists pre-builder).
import type { SseFrame } from "../../src/cli/subcommands/serve/context.js";

describe("T-E.Sse — SseFrame union accepts 3 new auto-run frame types (P-SP-E Sketch F)", () => {
  // ─── T-E.Sse.1 ───────────────────────────────────────────────────────────────
  it("T-E.Sse.1: SseFrame accepts {type:'auto-run-started', runId, maxDurationMinutes, maxConnects, startedAt, ts}", () => {
    // Given: SseFrame union updated by Sketch F to include auto-run-started variant
    // When:  object literal assigned as SseFrame (compile-time check; runtime check here)
    // Then:  frame.type === 'auto-run-started'; frame fields match the declared shape

    const frame = {
      type: "auto-run-started" as const,
      runId: "test-run-id",
      maxDurationMinutes: 30,
      maxConnects: 5 as number | null,
      startedAt: Date.now(),
      ts: Date.now(),
    } satisfies SseFrame;

    assert.equal(frame.type, "auto-run-started",
      "T-E.Sse.1: frame.type must be 'auto-run-started'");
    // Type-narrowed access
    if (frame.type === "auto-run-started") {
      assert.equal(frame.runId, "test-run-id", "T-E.Sse.1: runId must match");
      assert.equal(frame.maxDurationMinutes, 30, "T-E.Sse.1: maxDurationMinutes must be 30");
      assert.equal(frame.maxConnects, 5, "T-E.Sse.1: maxConnects must be 5");
      assert.ok(typeof frame.startedAt === "number", "T-E.Sse.1: startedAt must be a number");
      assert.ok(typeof frame.ts === "number", "T-E.Sse.1: ts must be a number");
    } else {
      assert.ok(false, "T-E.Sse.1: type narrowing failed — should be auto-run-started");
    }
  });

  // ─── T-E.Sse.2 ───────────────────────────────────────────────────────────────
  it("T-E.Sse.2: SseFrame accepts {type:'auto-run-progress', runId, elapsedMinutes, counters:Record<string,number>, ts}", () => {
    // Given: SseFrame union updated by Sketch F to include auto-run-progress variant
    // When:  object literal assigned as SseFrame
    // Then:  frame.type === 'auto-run-progress'; counters is Record<string,number>

    const frame = {
      type: "auto-run-progress" as const,
      runId: "test-run-id",
      elapsedMinutes: 10,
      counters: { connect_sent: 2 } as Record<string, number>,
      ts: Date.now(),
    } satisfies SseFrame;

    assert.equal(frame.type, "auto-run-progress",
      "T-E.Sse.2: frame.type must be 'auto-run-progress'");
    if (frame.type === "auto-run-progress") {
      assert.equal(frame.runId, "test-run-id", "T-E.Sse.2: runId must match");
      assert.equal(frame.elapsedMinutes, 10, "T-E.Sse.2: elapsedMinutes must be 10");
      assert.deepEqual(frame.counters, { connect_sent: 2 }, "T-E.Sse.2: counters must match");
      assert.ok(typeof frame.ts === "number", "T-E.Sse.2: ts must be a number");
    } else {
      assert.ok(false, "T-E.Sse.2: type narrowing failed — should be auto-run-progress");
    }
  });

  // ─── T-E.Sse.3 ───────────────────────────────────────────────────────────────
  it("T-E.Sse.3: SseFrame accepts {type:'auto-run-completed', runId, status, summary, finalCounters, endedAt, ts}", () => {
    // Given: SseFrame union updated by Sketch F to include auto-run-completed variant
    // When:  object literal with all required fields assigned as SseFrame
    // Then:  frame.type === 'auto-run-completed'; status is valid enum value

    const frame = {
      type: "auto-run-completed" as const,
      runId: "test-run-id",
      status: "completed" as "completed" | "stopped_by_agent" | "stopped_by_user" | "blocked",
      summary: "All done: 3 connects sent.",
      finalCounters: { connect_sent: 3 } as Record<string, number>,
      endedAt: Date.now(),
      ts: Date.now(),
    } satisfies SseFrame;

    assert.equal(frame.type, "auto-run-completed",
      "T-E.Sse.3: frame.type must be 'auto-run-completed'");
    if (frame.type === "auto-run-completed") {
      assert.equal(frame.runId, "test-run-id", "T-E.Sse.3: runId must match");
      assert.equal(frame.status, "completed", "T-E.Sse.3: status must be 'completed'");
      assert.equal(frame.summary, "All done: 3 connects sent.", "T-E.Sse.3: summary must match");
      assert.deepEqual(frame.finalCounters, { connect_sent: 3 }, "T-E.Sse.3: finalCounters must match");
      assert.ok(typeof frame.endedAt === "number", "T-E.Sse.3: endedAt must be a number");
      assert.ok(typeof frame.ts === "number", "T-E.Sse.3: ts must be a number");
    } else {
      assert.ok(false, "T-E.Sse.3: type narrowing failed — should be auto-run-completed");
    }
  });
});
