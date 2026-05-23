/**
 * P-Y1 Step 5 — T-Tool.1 — FILLED
 * (G-PY1.2)
 *
 * todo_write PURE tool (src/tools/control/todoWrite.ts): Zod 1-20 steps + optional state enum +
 * randomUUID step ids + echoes {ok, workflowTitle, steps}; no SSE/audit/state mutation.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 tests/tools/control/todoWrite-pY1.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { todoWriteSchema, todoWriteTool } from "../../../src/tools/control/todoWrite.js";

// ─── T-Tool.1 — todo_write pure tool + schema ───────────────────────────────

describe("todo_write — pure tool: 1-20 step schema + step-id generation + zero side effects (G-PY1.2)", () => {
  // Given: todoWriteTool + todoWriteSchema.
  // When:  safeParse valid/invalid inputs + execute() a valid input.
  // Then:  1-step + state-omitted parse OK; 0-step + 21-step fail; execute echoes
  //        {ok, workflowTitle, steps:[{id:/^step_/, ...}]} (pure).
  it("T-Tool.1: given todoWriteTool + todoWriteSchema, WHEN safeParse {1 step w/ state} / {0 steps} / {21 steps} / {step omitting state} + execute() a valid input, THEN 1-step+omitted-state parse OK, 0-step+21-step FAIL (min/max), execute returns {ok:true, workflowTitle, steps:[{id:/^step_/, ...}]} (pure)", async () => {
    // (1) valid 1-step with requiresApproval + state
    const r1 = todoWriteSchema.safeParse({
      workflowTitle: "Outreach",
      steps: [{ title: "Send DM", requiresApproval: true, state: "in_progress" }],
    });
    assert.ok(r1.success, "valid 1-step (w/ requiresApproval + state) must parse");

    // (2) invalid 0 steps
    const r2 = todoWriteSchema.safeParse({ workflowTitle: "X", steps: [] });
    assert.ok(!r2.success, "0 steps must FAIL (min 1)");

    // (3) invalid 21 steps
    const r3 = todoWriteSchema.safeParse({
      workflowTitle: "X",
      steps: Array.from({ length: 21 }, (_, i) => ({ title: `s${i}` })),
    });
    assert.ok(!r3.success, "21 steps must FAIL (max 20)");

    // (4) valid step omitting state (optional)
    const r4 = todoWriteSchema.safeParse({ workflowTitle: "X", steps: [{ title: "A" }] });
    assert.ok(r4.success, "step omitting state must parse (optional)");

    // execute() — pure echo with generated step ids
    // biome-ignore lint/suspicious/noExplicitAny: tool.execute signature varies by SDK version
    const out = (await (todoWriteTool as any).execute({
      workflowTitle: "Outreach",
      steps: [
        { title: "Review profile", requiresApproval: false },
        { title: "Send DM", requiresApproval: true, state: "in_progress" },
      ],
    })) as {
      ok: boolean;
      workflowTitle: string;
      steps: Array<{ id: string; title: string; requiresApproval: boolean; state: string }>;
    };

    assert.equal(out.ok, true, "execute → ok:true");
    assert.equal(out.workflowTitle, "Outreach", "echoes workflowTitle");
    assert.equal(out.steps.length, 2, "echoes both steps");
    for (const s of out.steps) {
      assert.match(s.id, /^step_/, `step id must start with 'step_'; got ${s.id}`);
    }
    assert.equal(out.steps[0].title, "Review profile");
    assert.equal(out.steps[0].requiresApproval, false);
    assert.equal(out.steps[0].state, "pending", "omitted state defaults to 'pending'");
    assert.equal(out.steps[1].requiresApproval, true);
    assert.equal(out.steps[1].state, "in_progress", "explicit state preserved");
    // Distinct ids per step (randomUUID).
    assert.notEqual(out.steps[0].id, out.steps[1].id, "step ids must be distinct");
  });
});
