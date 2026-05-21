/**
 * P-57a Step 5 — T-Tools.2 (G-P57a.2) — FILLED
 *
 * Mock test for P-57a tool: `src/tools/control/suggestNextActions.ts`.
 *   T-Tools.2 — `suggest_next_actions` Zod schema enforces 1-3 actions
 *               + each action carries id/label/prompt (+ optional danger).
 *
 * Gate coverage:
 *   G-P57a.2 — suggest_next_actions Zod schema (.min(1).max(3))
 *
 * Mock strategy:
 *   - Dynamic-import sentinel via variable import-path.
 *   - Direct Zod schema test on `tool.parameters.parse(...)` — NO SDK round-trip.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/tools/control/suggestNextActions-p57a.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ─── Dynamic-import sentinel (kept from Step 4a scaffold) ────────────────────
// biome-ignore lint/suspicious/noExplicitAny: dynamic import result typed as any
let mod: any = null;
{
  const importPath = "../../../src/tools/control/suggestNextActions.js";
  try {
    mod = await import(importPath);
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") {
      throw e;
    }
  }
}

// ─── T-Tools.2 — suggest_next_actions Zod schema validation ─────────────────

describe("suggestNextActionsTool — Zod schema enforces .min(1).max(3) actions (G-P57a.2)", () => {
  it("T-Tools.2: given suggestNextActionsTool imported, WHEN parameters.parse called against (a) 1 action, (b) 2 actions, (c) 3 actions, (d) 0 actions, (e) 4 actions, (f) each action requires id+label+prompt, THEN (a)/(b)/(c) succeed AND (d)/(e) throw AND missing-field action throws", async () => {
    // Given: suggestNextActionsTool with parameters.actions = .min(1).max(3)
    // When:  parse against 1/2/3 (valid) and 0/4 (invalid) action arrays + missing-field action
    // Then:  valid arrays parse; invalid throw; execute is pure echo

    assert.ok(mod !== null, "suggestNextActions.js module must be importable");
    assert.ok(mod.suggestNextActionsTool, "module must export `suggestNextActionsTool`");

    const tool = mod.suggestNextActionsTool;
    assert.ok(tool.parameters, "tool must have a `parameters` Zod schema");
    assert.ok(typeof tool.execute === "function", "tool must have an `execute` function");
    const schema = tool.parameters;

    const validAction = { id: "a", label: "Click", prompt: "Do X" };

    // (a) 1 action
    assert.doesNotThrow(() => schema.parse({ summary: "S", actions: [validAction] }), "(a) 1 action should parse");
    // (b) 2 actions
    assert.doesNotThrow(
      () => schema.parse({ summary: "S", actions: [validAction, { ...validAction, id: "b" }] }),
      "(b) 2 actions should parse",
    );
    // (c) 3 actions
    assert.doesNotThrow(
      () =>
        schema.parse({
          summary: "S",
          actions: [validAction, { ...validAction, id: "b" }, { ...validAction, id: "c" }],
        }),
      "(c) 3 actions should parse",
    );

    // (d) 0 actions throws (.min(1))
    assert.throws(
      () => schema.parse({ summary: "S", actions: [] }),
      /array|min|empty/i,
      "(d) 0 actions should throw (violates .min(1))",
    );

    // (e) 4 actions throws (.max(3))
    assert.throws(
      () =>
        schema.parse({
          summary: "S",
          actions: [validAction, { ...validAction, id: "b" }, { ...validAction, id: "c" }, { ...validAction, id: "d" }],
        }),
      /array|max|too long/i,
      "(e) 4 actions should throw (violates .max(3))",
    );

    // (f) Action missing required field (no prompt)
    assert.throws(
      () => schema.parse({ summary: "S", actions: [{ id: "a", label: "L" }] }),
      /required|prompt/i,
      "(f) action with missing `prompt` field should throw",
    );

    // Optional `danger: true` accepted
    assert.doesNotThrow(
      () => schema.parse({ summary: "S", actions: [{ ...validAction, danger: true }] }),
      "optional danger:true should parse",
    );

    // execute pure echo
    const echoInput = { summary: "S", actions: [validAction] };
    const result = await tool.execute(echoInput, { toolCallId: "tc-test", messages: [] });
    assert.deepEqual(
      result,
      { ok: true, summary: "S", actions: [validAction] },
      "execute should return {ok:true, ...input} (pure echo)",
    );
  });
});
