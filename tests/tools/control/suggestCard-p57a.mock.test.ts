/**
 * P-57a Step 5 — T-Tools.1 (G-P57a.1) — FILLED
 *
 * Mock test for P-57a tool: `src/tools/control/suggestCard.ts`.
 *   T-Tools.1 — `suggest_card` Zod schema accepts qualified + dismissed shapes
 *               + 15-value painChainStage enum + rejects invalid enum.
 *
 * Gate coverage:
 *   G-P57a.1 — suggest_card Zod schema valid (qualified + dismissed) + 15-enum
 *
 * Mock strategy:
 *   - Dynamic-import sentinel via variable import-path (so TS doesn't resolve
 *     statically — pattern carried over from Step 4a scaffold for safety).
 *   - Direct Zod schema test via `tool.parameters.parse(...)`; NO Vercel SDK
 *     round-trip needed (the SDK mock-schema requirement from D-P56b-01 lesson
 *     only applies when driving `streamText` through `MockLanguageModelV1`).
 *   - The 15 painChainStage values are verbatim from references/methodology.md:38-49
 *     per plan §5.1.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/tools/control/suggestCard-p57a.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ─── Dynamic-import sentinel (kept from Step 4a scaffold) ────────────────────
// biome-ignore lint/suspicious/noExplicitAny: dynamic import result typed as any
let mod: any = null;
{
  const importPath = "../../../src/tools/control/suggestCard.js";
  try {
    mod = await import(importPath);
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") {
      throw e;
    }
  }
}

// ─── T-Tools.1 — suggest_card Zod schema validation ─────────────────────────

describe("suggestCardTool — Zod schema validates qualified + dismissed payloads + 15-enum (G-P57a.1)", () => {
  it("T-Tools.1: given suggestCardTool imported from src/tools/control/suggestCard.ts, WHEN parameters.parse called against (a) full qualified payload, (b) dismissed-only payload, (c) each of 15 painChainStage enum values, (d) invalid painChainStage value, THEN (a)/(b)/(c) succeed AND (d) throws ZodError", async () => {
    // Given: suggestCardTool is an exported `tool({description, parameters, execute})` per plan §5.1
    // When:  call parameters.parse(...) against four scenarios + execute(input)
    // Then:  (a)/(b)/(c) parse without throwing; (d) throws; execute is pure echo.

    assert.ok(mod !== null, "suggestCard.js module must be importable (file should exist after Step 4b)");
    assert.ok(mod.suggestCardTool, "module must export `suggestCardTool`");

    const tool = mod.suggestCardTool;
    assert.ok(tool.parameters, "tool must have a `parameters` Zod schema");
    assert.ok(typeof tool.execute === "function", "tool must have an `execute` function");
    const schema = tool.parameters;

    // (a) Full qualified payload — all optional fields populated
    const qualifiedPayload = {
      title: "John Doe — VP Engineering",
      icpMatch: {
        qualified: true,
        matched: ["VP role", "tech industry"],
        missing: [],
      },
      painChainHypothesis: "Migration pain — legacy infra blocking velocity.",
      painChainStage: "R1-open",
      suggestedMove: {
        kind: "connect",
        text: "Hi John, I noticed you lead engineering at Acme...",
      },
    };
    assert.doesNotThrow(() => schema.parse(qualifiedPayload), "(a) full qualified payload should parse without error");

    // (b) Dismissed-only variant
    const dismissedPayload = { dismissed: true, reason: "extraction failed — private profile" };
    assert.doesNotThrow(() => schema.parse(dismissedPayload), "(b) dismissed-only payload should parse");

    // (c) All 15 painChainStage enum values per references/methodology.md:38-49
    const enumValues = [
      "precall",
      "spark-interest",
      "R1-open",
      "R2-controlled",
      "R3-confirming",
      "I1-open",
      "I2-controlled",
      "I3-confirming",
      "C1-open",
      "C2-controlled",
      "C3-confirming",
      "validate",
      "close",
      "post",
      "disqualified",
    ];
    assert.equal(enumValues.length, 15, "(c) test fixture must have all 15 methodology enum values");
    for (const stage of enumValues) {
      assert.doesNotThrow(() => schema.parse({ painChainStage: stage }), `(c) painChainStage "${stage}" should parse`);
    }

    // (d) Invalid painChainStage throws ZodError
    assert.throws(
      () => schema.parse({ painChainStage: "not-a-stage" }),
      /invalid|enum/i,
      "(d) invalid painChainStage 'not-a-stage' should throw ZodError",
    );

    // (e) execute is pure echo: returns {ok:true, ...input}
    const echoInput = { title: "X", dismissed: false };
    const result = await tool.execute(echoInput, { toolCallId: "tc-test", messages: [] });
    assert.deepEqual(
      result,
      { ok: true, title: "X", dismissed: false },
      "execute should return {ok:true, ...input} (pure echo)",
    );
  });
});
