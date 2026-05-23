/**
 * P-Y5 Step 4a scaffold — T-Todo.1..4 + T-Todo.7 (D-RUN-4: todo_write encouragement).
 *
 * String-presence + structure-guard scaffolds for the 3-band re-engineering of the
 * `todo_write` planning nudge (docs/phase-Y5-drun24-plan.md §6.4 R1/R2a/R2b) plus the
 * 3-band ORDER invariant guard (T-Todo.7). These import EXISTING band exports
 * (composeSoulBand / resolveSoulBand / BOUNDARY / CHECKPOINT / composeSystemPrompt),
 * so the file COMPILES + LOADS now; the assertion bodies are `assert.fail("TODO Step 5: …")`
 * (intentionally failing until Step 5) because the new band strings do not exist until the
 * builder lands R1/R2 at Step 4b.
 *
 * Outside-in TDD + BDD-light per CLAUDE.md § Test Discipline.
 *
 * Gate coverage:
 *   T-Todo.1 — D-RUN-4 / R1 (Soul habit present + before `remember`)
 *   T-Todo.2 — D-RUN-4 / R1 (habit on the REPL compose path — kills F3 omission)
 *   T-Todo.3 — D-RUN-4 / R2a (Boundary ordered ritual — kills H1 race, Boundary side)
 *   T-Todo.4 — D-RUN-4 / R2b (Checkpoint ordered ritual — kills H1 race, Checkpoint side)
 *   T-Todo.7 — contract STRUCTURE invariant (3-band Boundary→Soul→Checkpoint order)
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemPrompt/todoEncouragement-pY5.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../../src/agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../../src/agent/systemPrompt/compose.js";
import { composeSoulBand, resolveSoulBand } from "../../../src/agent/systemPrompt/soul.js";
import type { IdentityRecord } from "../../../src/persistence/identity.js";

/** Minimal identity record sufficient for `composeSoulBand` / `resolveSoulBand`. */
function makeMinimalIdentity(): IdentityRecord {
  return {
    fullName: "Test Operator",
    company: "TestCo",
    role: "BD",
    persona: "You do outbound sales, methodology is Solution Selling®",
    icp: {
      targetRole: ["VP Sales"],
      industry: ["SaaS"],
      companySize: { min: 50, max: 500 },
      geography: ["US"],
    },
    style: "Direct, technical, empathetic",
    freeAxes: { pain_chain_lean: "P1", lead_role: "L1", discovery_lean: "D1", story_shape: "S1" },
    updatedAt: new Date().toISOString(),
  } as unknown as IdentityRecord;
}

/** The R1 Soul habit substring (real backticks in the runtime string). */
const TODO_HABIT = "you lay it out as a `todo_write` plan before you touch the page";
/** The pre-existing `remember` habit substring — the todo_write habit must precede it. */
const REMEMBER_HABIT = "call the `remember` tool immediately";

// ─── T-Todo.1 — Soul band carries the todo_write planning habit (before remember) ─

describe("composeSoulBand — todo_write planning habit present + first (D-RUN-4 / R1)", () => {
  // Given: composeSoulBand(null) AND composeSoulBand(populated identity).
  // When:  the returned Soul band string is searched.
  // Then:  it contains TODO_HABIT, and TODO_HABIT appears BEFORE REMEMBER_HABIT (first-element placement).
  it("T-Todo.1: when composeSoulBand(null) and composeSoulBand(identity) run, the Soul band contains the `todo_write` planning habit AND that habit appears before the `remember` habit", () => {
    for (const soul of [composeSoulBand(null), composeSoulBand(makeMinimalIdentity())]) {
      const todoIdx = soul.indexOf(TODO_HABIT);
      const rememberIdx = soul.indexOf(REMEMBER_HABIT);
      assert.ok(todoIdx >= 0, `Soul band must contain the todo_write habit ${JSON.stringify(TODO_HABIT)}`);
      assert.ok(rememberIdx >= 0, `Soul band must contain the remember habit ${JSON.stringify(REMEMBER_HABIT)}`);
      assert.ok(
        todoIdx < rememberIdx,
        "todo_write habit must appear BEFORE the remember habit (first-element placement)",
      );
    }
  });
});

// ─── T-Todo.2 — habit present on the REPL compose path (F3 fix) ───────────────

describe("resolveSoulBand — todo_write habit on the REPL path (D-RUN-4 / R1, kills F3)", () => {
  // Given: resolveSoulBand(null, identity) — the worker-REPL path that does NOT append soulModeFragment.
  // When:  the composed band is searched.
  // Then:  it still contains TODO_HABIT (proves the habit lives in composeSoulBand, seen in REPL+serve+telegram+cron).
  it("T-Todo.2: when resolveSoulBand(null, identity) runs (REPL path, no soulModeFragment), the composed band still contains the `todo_write` planning habit", () => {
    const repl = resolveSoulBand(null, makeMinimalIdentity());
    assert.ok(
      repl.includes(TODO_HABIT),
      `REPL path (resolveSoulBand, no soulModeFragment) must carry the todo_write habit ${JSON.stringify(TODO_HABIT)} (F3 omission killed)`,
    );
  });
});

// ─── T-Todo.3 — Boundary states the ordered ritual (search_memory → todo_write) ─

describe("BOUNDARY — Plan-first paragraph ordered ritual (D-RUN-4 / R2a, kills H1)", () => {
  // Given: the BOUNDARY band string.
  // When:  the "Plan-first discipline" paragraph is searched.
  // Then:  it contains "FIRST the `search_memory` lookup" AND
  //        "THEN — before any other substantive action — a `todo_write` plan".
  it("T-Todo.3: BOUNDARY contains 'FIRST the `search_memory` lookup' AND 'THEN — before any other substantive action — a `todo_write` plan' (ordered ritual, no two-FIRST race)", () => {
    assert.ok(
      BOUNDARY.includes("FIRST the `search_memory` lookup"),
      "BOUNDARY must state the ordered ritual: FIRST the `search_memory` lookup",
    );
    assert.ok(
      BOUNDARY.includes("THEN — before any other substantive action — a `todo_write` plan"),
      "BOUNDARY must state: THEN — before any other substantive action — a `todo_write` plan",
    );
    // The OLD two-FIRST-race phrasing must be gone (H1 killed, Boundary side).
    assert.ok(
      !BOUNDARY.includes(
        "after any task-start memory lookup, your first substantive action MUST be a `todo_write` plan",
      ),
      "the OLD ambiguous 'first substantive action MUST be a todo_write plan' phrasing must be removed",
    );
  });
});

// ─── T-Todo.4 — Checkpoint states the ordered ritual ─────────────────────────

describe("CHECKPOINT — Task-start lookup ordered ritual (D-RUN-4 / R2b, kills H1)", () => {
  // Given: the CHECKPOINT band string.
  // When:  the "Task-start context lookup" paragraph is searched.
  // Then:  it contains "step one of your task-start ritual" AND "declare your `todo_write` plan".
  it("T-Todo.4: CHECKPOINT contains 'step one of your task-start ritual' AND 'declare your `todo_write` plan' (ordered ritual, Checkpoint side)", () => {
    assert.ok(
      CHECKPOINT.includes("step one of your task-start ritual"),
      "CHECKPOINT must frame search_memory as 'step one of your task-start ritual'",
    );
    assert.ok(
      CHECKPOINT.includes("declare your `todo_write` plan"),
      "CHECKPOINT must tie todo_write as the immediate next ritual step (declare your `todo_write` plan)",
    );
  });
});

// ─── T-Todo.7 — 3-band ORDER invariant (structure guard) ─────────────────────

describe("composeSystemPrompt — 3-band order invariant Boundary→Soul→Checkpoint (contract guard)", () => {
  // Given: composeSystemPrompt({ boundary, soul, checkpoint }) with sentinel band strings.
  // When:  the composed output is compared.
  // Then:  output === boundary + "\n\n---\n\n" + soul + "\n\n---\n\n" + checkpoint (compose.ts untouched).
  it("T-Todo.7: composeSystemPrompt({boundary,soul,checkpoint}) === boundary + '\\n\\n---\\n\\n' + soul + '\\n\\n---\\n\\n' + checkpoint (Boundary→Soul→Checkpoint, byte-identical separator)", () => {
    const composed = composeSystemPrompt({ boundary: "BBB", soul: "SSS", checkpoint: "CCC" });
    assert.strictEqual(
      composed,
      "BBB\n\n---\n\nSSS\n\n---\n\nCCC",
      "3-band order Boundary→Soul→Checkpoint with the \\n\\n---\\n\\n separator is the contract structure invariant",
    );
  });
});
