/**
 * P-6 mock tests — T-M_p6.12..T-M_p6.13: sleep tool.
 *
 * Tests:
 *   T-M_p6.12 — Zod bounds: seconds:0 and seconds:301 rejected; seconds:1 and seconds:300 accepted
 *   T-M_p6.13 — actual timing: seconds:1 → elapsed ≥ 950ms and ≤ 1500ms
 *
 * No Chrome, no LLM, no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { sleepTool } from "../../../src/tools/control/sleep.js";

// ─── T-M_p6.12 — Zod bounds ──────────────────────────────────────────────────

test("T-M_p6.12: sleep Zod bounds — seconds:0 and seconds:301 rejected; seconds:1 and seconds:300 accepted", async () => {
  // Access the Zod schema through the tool's parameters field.
  // Vercel AI SDK stores the schema on tool.parameters.
  const schema = (sleepTool as unknown as { parameters: { safeParse: (v: unknown) => { success: boolean } } })
    .parameters;

  // seconds:0 must be rejected (min is 1)
  const r0 = schema.safeParse({ seconds: 0 });
  assert.equal(r0.success, false, "T-M_p6.12: seconds:0 must fail Zod validation (min:1)");

  // seconds:301 must be rejected (max is 300)
  const r301 = schema.safeParse({ seconds: 301 });
  assert.equal(r301.success, false, "T-M_p6.12: seconds:301 must fail Zod validation (max:300)");

  // seconds:1 must be accepted
  const r1 = schema.safeParse({ seconds: 1 });
  assert.equal(r1.success, true, "T-M_p6.12: seconds:1 must pass Zod validation");

  // seconds:300 must be accepted
  const r300 = schema.safeParse({ seconds: 300 });
  assert.equal(r300.success, true, "T-M_p6.12: seconds:300 must pass Zod validation");

  // fractional seconds must be rejected (int constraint)
  const r15 = schema.safeParse({ seconds: 1.5 });
  assert.equal(r15.success, false, "T-M_p6.12: seconds:1.5 must fail Zod validation (int constraint)");

  console.log("T-M_p6.12: sleep Zod bounds validated ✓");
});

// ─── T-M_p6.13 — actual timing ───────────────────────────────────────────────

test("T-M_p6.13: sleep tool actually waits ≥ 950ms and ≤ 1500ms for seconds:1", { timeout: 3000 }, async () => {
  const before = Date.now();
  const result = await (
    sleepTool as unknown as { execute: (args: { seconds: number; reason?: string }, ctx?: unknown) => Promise<unknown> }
  ).execute({ seconds: 1, reason: "P-6 timing test" }, { toolCallId: "t-m-p6-13", messages: [] });
  const elapsed = Date.now() - before;

  assert.ok(elapsed >= 950, `T-M_p6.13: elapsed must be ≥ 950ms; got ${elapsed}ms`);
  assert.ok(elapsed <= 1500, `T-M_p6.13: elapsed must be ≤ 1500ms (no stall); got ${elapsed}ms`);

  // Verify ok envelope
  const r = result as unknown as Record<string, unknown>;
  assert.equal(r.ok, true, "T-M_p6.13: result.ok must be true");
  assert.equal(r.command, "sleep", "T-M_p6.13: result.command must be 'sleep'");
  const data = r.data as Record<string, unknown>;
  assert.equal(data.sleptSeconds, 1, "T-M_p6.13: data.sleptSeconds must be 1");
  assert.equal(data.reason, "P-6 timing test", "T-M_p6.13: data.reason must match input");

  console.log(`T-M_p6.13: sleep(1) → ${elapsed}ms elapsed, ok envelope ✓`);
});
