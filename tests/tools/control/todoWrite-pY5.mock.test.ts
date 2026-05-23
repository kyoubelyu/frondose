/**
 * P-Y5 Step 4a scaffold — T-Todo.5 + T-Todo.6 (D-RUN-4: todo_write description + schema guard).
 *
 * T-Todo.5 verifies the R3 description re-frame (value framing + drop the "zero side effects"
 * anti-signal). T-Todo.6 is the CONTRACT GUARD proving R3 moved ONLY the description string —
 * the tool name + parameter schema (todoWriteSchema) are byte-identical (content-not-contract,
 * guardian Check 2 ruling). Both import EXISTING exports, so this file COMPILES + LOADS now;
 * assertion bodies are `assert.fail("TODO Step 5: …")` (intentionally failing until Step 5,
 * since the new description string does not exist until the builder lands R3 at Step 4b).
 *
 * Outside-in TDD + BDD-light per CLAUDE.md § Test Discipline.
 *
 * Gate coverage:
 *   T-Todo.5 — D-RUN-4 / R3 (tool description value-framed, anti-signal removed)
 *   T-Todo.6 — contract guard (todo_write schema + tool name UNCHANGED)
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/control/todoWrite-pY5.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { todoWriteSchema, todoWriteTool } from "../../../src/tools/control/todoWrite.js";

/** The anti-signal that R3 REMOVES. */
const ANTI_SIGNAL = "Pure control tool with zero side effects";
/** The two value-framing phrases R3 ADDS. */
const VALUE_PHRASE_CARD = "live workflow card";
const VALUE_PHRASE_GATE = "approval gate";

// ─── T-Todo.5 — description value-framed, anti-signal removed ─────────────────

describe("todoWriteTool.description — value-framed, anti-signal removed (D-RUN-4 / R3)", () => {
  // Given: todoWriteTool.description.
  // When:  the string is searched.
  // Then:  it does NOT contain "Pure control tool with zero side effects"
  //        AND it DOES contain "live workflow card" AND "approval gate".
  it("T-Todo.5: todoWriteTool.description does NOT contain 'Pure control tool with zero side effects' AND DOES contain 'live workflow card' AND 'approval gate'", () => {
    const description = todoWriteTool.description ?? "";
    assert.ok(description.length > 0, "todoWriteTool.description must be a non-empty string");
    assert.ok(
      !description.includes(ANTI_SIGNAL),
      `the anti-signal ${JSON.stringify(ANTI_SIGNAL)} must be removed (R3)`,
    );
    assert.ok(
      description.includes(VALUE_PHRASE_CARD),
      `description must add value framing ${JSON.stringify(VALUE_PHRASE_CARD)}`,
    );
    assert.ok(
      description.includes(VALUE_PHRASE_GATE),
      `description must add value framing ${JSON.stringify(VALUE_PHRASE_GATE)}`,
    );
  });
});

// ─── T-Todo.6 — schema + tool-name UNCHANGED (contract guard) ─────────────────

describe("todoWriteSchema + tool name — UNCHANGED contract guard (R3 is content-only)", () => {
  // Given: todoWriteSchema + todoWriteTool.execute.
  // When:  valid/invalid shapes are parsed + a valid input is executed.
  // Then:  workflowTitle string min1 max200; steps array min1 max20 of
  //        { title string min1 max120, requiresApproval boolean default false,
  //          state enum[pending,in_progress,completed,failed] optional };
  //        execute({...}) → { ok:true, workflowTitle, steps:[{id,title,requiresApproval,state}] }.
  it("T-Todo.6: todoWriteSchema enforces workflowTitle(1-200) + steps(1-20 of {title 1-120, requiresApproval bool default false, state enum optional}) AND execute echoes {ok,workflowTitle,steps:[{id,title,requiresApproval,state}]} (schema/tool-name unchanged)", async () => {
    // (1) baseline valid input
    assert.ok(
      todoWriteSchema.safeParse({ workflowTitle: "X", steps: [{ title: "A" }] }).success,
      "minimal valid {workflowTitle, 1 step} must parse",
    );

    // (2) workflowTitle bounds 1-200
    assert.ok(
      !todoWriteSchema.safeParse({ workflowTitle: "", steps: [{ title: "A" }] }).success,
      "empty workflowTitle FAILS (min1)",
    );
    assert.ok(
      todoWriteSchema.safeParse({ workflowTitle: "x".repeat(200), steps: [{ title: "A" }] }).success,
      "200-char workflowTitle OK (max200 inclusive)",
    );
    assert.ok(
      !todoWriteSchema.safeParse({ workflowTitle: "x".repeat(201), steps: [{ title: "A" }] }).success,
      "201-char workflowTitle FAILS (max200)",
    );

    // (3) steps array bounds 1-20
    assert.ok(!todoWriteSchema.safeParse({ workflowTitle: "X", steps: [] }).success, "0 steps FAILS (min1)");
    assert.ok(
      todoWriteSchema.safeParse({
        workflowTitle: "X",
        steps: Array.from({ length: 20 }, (_, i) => ({ title: `s${i}` })),
      }).success,
      "20 steps OK (max20 inclusive)",
    );
    assert.ok(
      !todoWriteSchema.safeParse({
        workflowTitle: "X",
        steps: Array.from({ length: 21 }, (_, i) => ({ title: `s${i}` })),
      }).success,
      "21 steps FAILS (max20)",
    );

    // (4) step title bounds 1-120
    assert.ok(
      !todoWriteSchema.safeParse({ workflowTitle: "X", steps: [{ title: "" }] }).success,
      "empty step title FAILS (min1)",
    );
    assert.ok(
      todoWriteSchema.safeParse({ workflowTitle: "X", steps: [{ title: "t".repeat(120) }] }).success,
      "120-char step title OK (max120 inclusive)",
    );
    assert.ok(
      !todoWriteSchema.safeParse({ workflowTitle: "X", steps: [{ title: "t".repeat(121) }] }).success,
      "121-char step title FAILS (max120)",
    );

    // (5) state enum + requiresApproval default
    assert.ok(
      !todoWriteSchema.safeParse({ workflowTitle: "X", steps: [{ title: "A", state: "bogus" }] }).success,
      "state 'bogus' FAILS (enum[pending,in_progress,completed,failed])",
    );
    const parsedOmitState = todoWriteSchema.safeParse({ workflowTitle: "X", steps: [{ title: "A" }] });
    assert.ok(parsedOmitState.success, "state omitted OK (optional)");
    if (parsedOmitState.success) {
      assert.equal(parsedOmitState.data.steps[0].requiresApproval, false, "requiresApproval omitted defaults to false");
      assert.equal(parsedOmitState.data.steps[0].state, undefined, "state omitted stays undefined at schema level");
    }

    // (6) execute echo + step-id generation (proves tool name + execute output shape unchanged)
    const out = (await (todoWriteTool as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      workflowTitle: "O",
      steps: [{ title: "a" }, { title: "b", requiresApproval: true, state: "in_progress" }],
    })) as {
      ok: boolean;
      workflowTitle: string;
      steps: Array<{ id: string; title: string; requiresApproval: boolean; state: string }>;
    };
    assert.equal(out.ok, true);
    assert.equal(out.workflowTitle, "O");
    assert.equal(out.steps.length, 2);
    assert.match(out.steps[0].id, /^step_/);
    assert.match(out.steps[1].id, /^step_/);
    assert.notEqual(out.steps[0].id, out.steps[1].id, "step ids must be distinct (randomUUID)");
    assert.equal(out.steps[0].state, "pending", "omitted state → 'pending' at execute level");
    assert.equal(out.steps[0].requiresApproval, false);
    assert.equal(out.steps[1].state, "in_progress", "explicit state preserved");
    assert.equal(out.steps[1].requiresApproval, true);
  });
});
