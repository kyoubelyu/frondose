/**
 * P-Y3 Step 4a scaffold — present_summary control tool.
 *
 * Expected-red before Step 4b: src/tools/control/presentSummary.ts does not
 * exist yet. Dynamic import keeps the scaffold runnable while pinning the
 * tool contract for builder.
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/control/presentSummary-pY3.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

type PresentSummaryModule = {
  presentSummarySchema?: { safeParse: (value: unknown) => { success: boolean } };
  presentSummaryTool?: {
    description?: string;
    parameters?: { safeParse: (value: unknown) => { success: boolean } };
    execute?: (input: unknown, options?: unknown) => Promise<unknown>;
  };
};

const mod = (await import("../../../src/tools/control/presentSummary.js").catch(() => null)) as PresentSummaryModule | null;

function requireTool(): NonNullable<PresentSummaryModule["presentSummaryTool"]> {
  assert.ok(mod, "src/tools/control/presentSummary.ts must exist and export presentSummaryTool");
  assert.ok(mod.presentSummaryTool, "presentSummaryTool export must be present");
  return mod.presentSummaryTool;
}

function requireSchema(): NonNullable<PresentSummaryModule["presentSummarySchema"]> {
  assert.ok(mod, "src/tools/control/presentSummary.ts must exist and export presentSummarySchema");
  assert.ok(mod.presentSummarySchema, "presentSummarySchema export must be present");
  return mod.presentSummarySchema;
}

describe("present_summary — compact summary payload schema and pure execute", () => {
  it("T-PY3.Tool.1: accepts a compact summary payload and returns { ok:true, ...input } with zero I/O", async () => {
    // Given: presentSummaryTool and presentSummarySchema.
    // When: a valid title/summary/bullets/nextStep payload is parsed and executed.
    // Then: the schema accepts it and execute returns the same payload with ok:true.
    const tool = requireTool();
    const schema = requireSchema();
    assert.equal(tool.parameters, schema, "presentSummaryTool.parameters must use the exported presentSummarySchema");
    assert.equal(typeof tool.execute, "function", "presentSummaryTool.execute must be a function");

    const input = {
      title: "Lead review",
      summary: "This profile is relevant enough for a concise operator-facing summary card.",
      bullets: ["VP Engineering", "Canada", "Likely scaling product operations"],
      nextStep: "Review the suggested outreach angle before taking action.",
    };

    const parsed = schema.safeParse(input);
    assert.ok(parsed.success, "valid compact present_summary payload must parse");

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = ((async () => {
      fetchCalled = true;
      throw new Error("present_summary must not fetch");
    }) as unknown) as typeof fetch;
    try {
      const result = await tool.execute(input, { toolCallId: "tc-py3", messages: [] });
      assert.deepEqual(result, { ok: true, ...input }, "execute returns { ok:true, ...input }");
      assert.equal(fetchCalled, false, "present_summary execute must not call fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("T-PY3.Tool.2: rejects empty required text, oversized text, more than five bullets, and oversized bullet/nextStep", () => {
    // Given: presentSummarySchema.
    // When: invalid boundary payloads are parsed.
    // Then: each invalid shape is rejected by the Zod limits from the plan.
    const schema = requireSchema();
    const valid = { title: "Title", summary: "Summary" };

    const cases: Array<[string, unknown]> = [
      ["empty title", { ...valid, title: "" }],
      ["empty summary", { ...valid, summary: "" }],
      ["oversized title", { ...valid, title: "x".repeat(97) }],
      ["oversized summary", { ...valid, summary: "x".repeat(701) }],
      ["more than five bullets", { ...valid, bullets: ["1", "2", "3", "4", "5", "6"] }],
      ["empty bullet", { ...valid, bullets: [""] }],
      ["oversized bullet", { ...valid, bullets: ["x".repeat(181)] }],
      ["empty nextStep", { ...valid, nextStep: "" }],
      ["oversized nextStep", { ...valid, nextStep: "x".repeat(241) }],
    ];

    for (const [label, payload] of cases) {
      const parsed = schema.safeParse(payload);
      assert.equal(parsed.success, false, `${label} must be rejected`);
    }
  });

  it("T-PY3.Tool.3: description identifies overlay summary presentation and zero side effects", () => {
    // Given: presentSummaryTool.description.
    // When: the description is inspected.
    // Then: the model-facing contract tells the LLM this is overlay summary presentation with zero side effects.
    const tool = requireTool();
    const description = tool.description ?? "";

    assert.match(description, /summary/i, "description must identify summary presentation");
    assert.match(description, /overlay|in-page|dialog/i, "description must identify the overlay/dialog target");
    assert.match(description, /zero side effects|zero-side-effect|no side effects/i, "description must say zero side effects");
  });
});
