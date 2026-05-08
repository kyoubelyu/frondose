/**
 * P-6 mock tests — T-M_p6.10..T-M_p6.11: stop tool.
 *
 * Tests:
 *   T-M_p6.10 — makeStopTool(control): execute calls requestStop exactly once + returns ok envelope
 *   T-M_p6.11 — makeStopTool(undefined): factory builds cleanly; execute returns ok without throwing; stderr warning emitted
 *
 * No Chrome, no LLM, no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeStopTool } from "../../../src/tools/control/stop.js";

// ─── T-M_p6.10 — stop calls requestStop ──────────────────────────────────────

test("T-M_p6.10: stop tool calls control.requestStop exactly once and returns ok envelope", async () => {
  let stopCallCount = 0;
  const control = {
    requestStop: () => {
      stopCallCount++;
    },
  };

  const tool = makeStopTool(control);
  const result = await tool.execute({ reason: "task complete" }, { toolCallId: "t-m-p6-10", messages: [] });

  assert.equal(stopCallCount, 1, "T-M_p6.10: requestStop must be called exactly once");

  const r = result as unknown as Record<string, unknown>;
  assert.equal(r.ok, true, "T-M_p6.10: result.ok must be true");
  assert.equal(r.command, "stop", "T-M_p6.10: result.command must be 'stop'");
  const data = r.data as Record<string, unknown>;
  assert.equal(data.stopped, true, "T-M_p6.10: data.stopped must be true");
  assert.equal(data.reason, "task complete", "T-M_p6.10: data.reason must match input");

  console.log("T-M_p6.10: stop calls requestStop once + ok envelope ✓");
});

// ─── T-M_p6.10b — stop with no reason (optional) ─────────────────────────────

test("T-M_p6.10b: stop tool with no reason → ok envelope with stopped:true", async () => {
  const control = { requestStop: () => {} };
  const tool = makeStopTool(control);
  const result = await tool.execute({}, { toolCallId: "t-m-p6-10b", messages: [] });
  const r = result as unknown as Record<string, unknown>;
  assert.equal(r.ok, true, "T-M_p6.10b: ok must be true");
  const data = r.data as Record<string, unknown>;
  assert.equal(data.stopped, true, "T-M_p6.10b: stopped must be true");
  // reason may be undefined or null — just must not throw
  console.log("T-M_p6.10b: stop with no reason → ok ✓");
});

// ─── T-M_p6.11 — stop with no control (undefined) ────────────────────────────

test("T-M_p6.11: makeStopTool(undefined) builds cleanly; execute returns ok; stderr warning emitted", async () => {
  const tool = makeStopTool(undefined);

  // Capture stderr
  const stderrChunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    return true;
  };

  let result: unknown;
  try {
    result = await tool.execute({ reason: "no control test" }, { toolCallId: "t-m-p6-11", messages: [] });
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = origWrite;
  }

  // Must return ok envelope (not throw)
  const r = result as Record<string, unknown>;
  assert.equal(r.ok, true, "T-M_p6.11: result.ok must be true even without control");
  const data = r.data as Record<string, unknown>;
  assert.equal(data.stopped, true, "T-M_p6.11: stopped must be true");

  // Must have written a stderr warning
  const captured = stderrChunks.join("");
  assert.ok(
    captured.includes("stop tool") || captured.includes("control.requestStop") || captured.includes("no-op"),
    `T-M_p6.11: stderr must contain a warning about missing control; got: "${captured.slice(0, 200)}"`,
  );

  console.log("T-M_p6.11: makeStopTool(undefined) → ok envelope + stderr warning ✓");
});
