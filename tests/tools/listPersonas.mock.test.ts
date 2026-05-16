/**
 * P-27 Step 5 — T-LP.1..3
 *
 * Tests for src/tools/server/listPersonas.ts — makeListPersonasTool.
 * Gate coverage: G-P27.14 (returns persona list), G-P27.28 (personasDir empty → [])
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { personaTemplateSchema } from "../../src/persistence/personaLibrary.js";
import { makeListPersonasTool } from "../../src/tools/server/listPersonas.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-lp-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function validPersonaJson(fullName = "BD Alice"): string {
  return JSON.stringify(
    personaTemplateSchema.parse({
      fullName,
      role: "BD Specialist",
      company: "Acme",
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    }),
  );
}

// ─── T-LP.1 ─────────────────────────────────────────────────────────────────

describe("list_personas — 2 personas present (G-P27.14)", () => {
  it("T-LP.1: given personasDir has 'p1.json' and 'p2.json', execute returns {ok:true, personas:[{id:'p1',...},{id:'p2',...}]}", async () => {
    // Given: personasDir has p1.json (fullName='BD Alice') and p2.json (fullName='BD Bob')
    // When:  tool.execute({})
    // Then:  result.ok=true; result.personas.length=2; ids 'p1' and 'p2' present
    const { dir, cleanup } = makeTmpDir();
    try {
      writeFileSync(join(dir, "p1.json"), validPersonaJson("BD Alice"), "utf-8");
      writeFileSync(join(dir, "p2.json"), validPersonaJson("BD Bob"), "utf-8");
      const tool = makeListPersonasTool(dir);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({}, {});
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.personas), "personas must be an array");
      assert.equal(result.personas.length, 2);
      const ids = result.personas.map((p: { id: string }) => p.id).sort();
      assert.deepEqual(ids, ["p1", "p2"]);
      // Each persona must have id + fullName
      for (const p of result.personas) {
        assert.ok(typeof p.id === "string", "persona must have id");
        assert.ok(typeof p.fullName === "string", "persona must have fullName");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-LP.2 ─────────────────────────────────────────────────────────────────

describe("list_personas — empty personasDir (G-P27.28)", () => {
  it("T-LP.2: given personasDir is empty (no .json files), execute returns {ok:true, personas:[]}", async () => {
    // Given: personasDir exists but contains no .json files
    // When:  tool.execute({})
    // Then:  result.ok=true; result.personas=[]
    const { dir, cleanup } = makeTmpDir();
    try {
      const tool = makeListPersonasTool(dir);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({}, {});
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.personas), "personas must be array");
      assert.equal(result.personas.length, 0);
    } finally {
      cleanup();
    }
  });
});

// ─── T-LP.3 ─────────────────────────────────────────────────────────────────

describe("list_personas — non-JSON files ignored (G-P27.14)", () => {
  it("T-LP.3: given personasDir has 'p1.json' and 'notes.txt', execute returns only p1 (non-.json files ignored)", async () => {
    // Given: personasDir has p1.json (valid persona) and notes.txt (not a persona)
    // When:  tool.execute({})
    // Then:  result.ok=true; result.personas.length=1; result.personas[0].id='p1'
    const { dir, cleanup } = makeTmpDir();
    try {
      writeFileSync(join(dir, "p1.json"), validPersonaJson("BD Alice"), "utf-8");
      writeFileSync(join(dir, "notes.txt"), "ignored file", "utf-8");
      const tool = makeListPersonasTool(dir);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({}, {});
      assert.equal(result.ok, true);
      assert.equal(result.personas.length, 1);
      assert.equal(result.personas[0].id, "p1");
    } finally {
      cleanup();
    }
  });
});
