/**
 * P-39 Step 5 — T-RememberTool.1-3, T-GetMemoryTool.1-2, T-SearchTool.1-2,
 *               T-SetNoteTool.1-2, T-GetNoteTool.1-2
 *
 * Assertions filled at Step 5.
 *
 * Gates covered: G-P39.5, G-P39.6, G-P39.7, G-P39.8
 *
 * Isolation: getMemoryDb caches by path → use unique temp paths per test, NOT ":memory:".
 * Each test function creates its own tmpDir + cleans up in finally.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeGetMemoryTool } from "../../src/tools/memory/getMemory.js";
import { makeGetMemoryNoteTool } from "../../src/tools/memory/getMemoryNote.js";
import { makeRememberTool } from "../../src/tools/memory/remember.js";
import { makeSearchMemoryTool } from "../../src/tools/memory/searchMemory.js";
import { makeSetMemoryNoteTool } from "../../src/tools/memory/setMemoryNote.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;
function uniqueDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `mai-p39-tools-${process.pid}-${++_counter}-`));
  return {
    dbPath: join(dir, "memory.sqlite"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

type ExecFn = (input: Record<string, unknown>) => PromiseLike<unknown>;

// biome-ignore lint/suspicious/noExplicitAny: bridging Vercel tool.execute (2-arg, PromiseLike) to single-arg test helper
function toolExecute(t: { execute?: (args: any, opts: any) => PromiseLike<unknown> }): ExecFn {
  if (typeof t.execute !== "function") throw new Error("tool.execute is not a function");
  const exec = t.execute;
  return (input) => exec(input, { toolCallId: "tc-test", messages: [] });
}

const ALICE_URL = "https://www.linkedin.com/in/alice-wang-test/";
const ALICE_INPUT = {
  personName: "Alice Wang",
  profileUrl: ALICE_URL,
  interaction: "message" as const,
  summary: "Discussed B2B SaaS pricing with Alice; she showed interest in fintech automation.",
};

// ─── T-RememberTool ───────────────────────────────────────────────────────────

describe("remember tool — P-39 score param (G-P39.7)", () => {
  it("T-RememberTool.1: remember with score:9 → ok envelope AND person_scores has score 9", async () => {
    // Given: the remember tool; input includes score: 9
    // When:  execute({ ...ALICE_INPUT, score: 9 })
    // Then:  result.ok === true; person_scores row for normalized ALICE_URL has score 9
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      const exec = toolExecute(makeRememberTool(dbPath));
      const result = (await exec({ ...ALICE_INPUT, score: 9 })) as {
        ok: boolean;
        command: string;
        data?: { score?: number | null };
      };
      assert.equal(result.ok, true, "remember with score:9 must return ok:true");
      assert.equal(result.command, "remember");

      // Verify score persisted: use getMemory tool (same cached DB handle)
      const getExec = toolExecute(makeGetMemoryTool(dbPath));
      const getResult = (await getExec({ profileUrl: ALICE_URL })) as {
        ok: boolean;
        data?: { score: number | null };
      };
      assert.equal(getResult.ok, true, "getMemory must succeed after remember");
      assert.equal(getResult.data?.score, 9, "person_scores must have score 9");
    } finally {
      cleanup();
    }
  });

  it("T-RememberTool.2: remember with no score → ok AND person_scores has no row for the URL", async () => {
    // Given: the remember tool; input has no score field
    // When:  execute({ ...ALICE_INPUT })
    // Then:  result.ok === true; person_scores has no row → getMemory returns score null
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      const exec = toolExecute(makeRememberTool(dbPath));
      const result = (await exec({ ...ALICE_INPUT })) as { ok: boolean };
      assert.equal(result.ok, true, "remember without score must return ok:true");

      const getExec = toolExecute(makeGetMemoryTool(dbPath));
      const getResult = (await getExec({ profileUrl: ALICE_URL })) as {
        ok: boolean;
        data?: { score: number | null };
      };
      assert.equal(getResult.ok, true);
      assert.equal(getResult.data?.score, null, "score must be null when remember had no score");
    } finally {
      cleanup();
    }
  });

  it("T-RememberTool.3: remember with score:11 → fail/validation envelope (out of 0–10 range)", async () => {
    // Given: the remember tool; input has score: 11 (outside max(10))
    // When:  execute({ ...ALICE_INPUT, score: 11 })
    // Then:  result.ok === false OR result is a ZodError-based fail envelope
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      const exec = toolExecute(makeRememberTool(dbPath));
      const result = (await exec({ ...ALICE_INPUT, score: 11 })) as { ok: boolean };
      assert.equal(result.ok, false, "score:11 must produce ok:false (Zod max(10) violation)");
    } finally {
      cleanup();
    }
  });
});

// ─── T-GetMemoryTool ──────────────────────────────────────────────────────────

describe("getMemory tool — P-39 score in envelope (G-P39.8)", () => {
  it("T-GetMemoryTool.1: a remembered+scored(7) person → getMemory ok data.score === 7", async () => {
    // Given: a DB with Alice remembered AND scored 7 (via remember with score:7)
    // When:  getMemory({ profileUrl: ALICE_URL })
    // Then:  result.ok === true; result.data.score === 7
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      // Seed: remember Alice with score:7
      const remExec = toolExecute(makeRememberTool(dbPath));
      await remExec({ ...ALICE_INPUT, score: 7 });

      const exec = toolExecute(makeGetMemoryTool(dbPath));
      const result = (await exec({ profileUrl: ALICE_URL })) as {
        ok: boolean;
        data?: { score: number | null };
      };
      assert.equal(result.ok, true, "getMemory must succeed");
      assert.equal(result.data?.score, 7, "data.score must be 7");
    } finally {
      cleanup();
    }
  });

  it("T-GetMemoryTool.2: a remembered, never-scored person → getMemory ok data.score === null", async () => {
    // Given: a DB with Alice remembered but no score set
    // When:  getMemory({ profileUrl: ALICE_URL })
    // Then:  result.ok === true; result.data.score === null
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      const remExec = toolExecute(makeRememberTool(dbPath));
      await remExec({ ...ALICE_INPUT });

      const exec = toolExecute(makeGetMemoryTool(dbPath));
      const result = (await exec({ profileUrl: ALICE_URL })) as {
        ok: boolean;
        data?: { score: number | null };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data?.score, null, "data.score must be null when no score was set");
    } finally {
      cleanup();
    }
  });
});

// ─── T-SearchTool ─────────────────────────────────────────────────────────────

describe("search_memory tool (G-P39.5)", () => {
  it("T-SearchTool.1: memory rows present → search_memory with matching query → ok { hits, count }, count > 0, hits[0] has snippet", async () => {
    // Given: a DB with at least one person remembered containing "B2B" and "fintech" in summary
    // When:  search_memory tool execute({ query: "B2B fintech" })
    // Then:  result.ok === true; data.count > 0; data.hits[0].snippet is a non-empty string
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      // Seed: Alice with B2B+fintech in summary
      const remExec = toolExecute(makeRememberTool(dbPath));
      await remExec({ ...ALICE_INPUT });

      const exec = toolExecute(makeSearchMemoryTool(dbPath));
      const result = (await exec({ query: "B2B fintech" })) as {
        ok: boolean;
        data?: { hits: Array<{ snippet?: string }>; count: number };
      };
      assert.equal(result.ok, true, "search_memory must return ok:true");
      assert.ok((result.data?.count ?? 0) > 0, "count must be > 0 when a matching row exists");
      const firstHit = (result.data?.hits ?? [])[0];
      assert.ok(
        typeof firstHit?.snippet === "string" && firstHit.snippet.length > 0,
        "hits[0].snippet must be a non-empty string",
      );
    } finally {
      cleanup();
    }
  });

  it("T-SearchTool.2: empty DB → search_memory → ok { hits: [], count: 0 }", async () => {
    // Given: a fresh empty DB (no rows)
    // When:  search_memory tool execute({ query: "anything" })
    // Then:  result.ok === true; data.hits === []; data.count === 0
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      const exec = toolExecute(makeSearchMemoryTool(dbPath));
      const result = (await exec({ query: "anything" })) as {
        ok: boolean;
        data?: { hits: unknown[]; count: number };
      };
      assert.equal(result.ok, true, "search_memory on empty DB must return ok:true");
      assert.deepEqual(result.data?.hits, [], "hits must be [] on empty DB");
      assert.equal(result.data?.count, 0, "count must be 0 on empty DB");
    } finally {
      cleanup();
    }
  });
});

// ─── T-SetNoteTool ────────────────────────────────────────────────────────────

describe("set_memory_note tool (G-P39.6)", () => {
  it("T-SetNoteTool.1: set_memory_note execute({ key, value }) → ok { key } AND general_memory has the row", async () => {
    // Given: the set_memory_note tool
    // When:  execute({ key: "test_note", value: "hello from set_memory_note" })
    // Then:  result.ok === true; result.data.key === "test_note";
    //        get_memory_note confirms the row is present with the stored value
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      const setExec = toolExecute(makeSetMemoryNoteTool(dbPath));
      const result = (await setExec({ key: "test_note", value: "hello from set_memory_note" })) as {
        ok: boolean;
        data?: { key: string };
      };
      assert.equal(result.ok, true, "set_memory_note must return ok:true");
      assert.equal(result.data?.key, "test_note", "data.key must equal the input key");

      // Verify via get_memory_note (same cached DB path)
      const getExec = toolExecute(makeGetMemoryNoteTool(dbPath));
      const getResult = (await getExec({ key: "test_note" })) as {
        ok: boolean;
        data?: { found: boolean; note?: { value: string } | null };
      };
      assert.equal(getResult.ok, true, "get_memory_note must succeed");
      assert.equal(getResult.data?.found, true, "found must be true for the set key");
      assert.equal(getResult.data?.note?.value, "hello from set_memory_note", "stored value must match");
    } finally {
      cleanup();
    }
  });

  it("T-SetNoteTool.2: set_memory_note with a 9000-char value → validation fail envelope (max 8000)", async () => {
    // Given: the set_memory_note tool
    // When:  execute({ key: "k", value: "x".repeat(9000) })
    // Then:  result.ok === false (Zod validation fail — value exceeds max(8000))
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      const exec = toolExecute(makeSetMemoryNoteTool(dbPath));
      const result = (await exec({ key: "k", value: "x".repeat(9000) })) as { ok: boolean };
      assert.equal(result.ok, false, "9000-char value must fail Zod max(8000) validation → ok:false");
    } finally {
      cleanup();
    }
  });
});

// ─── T-GetNoteTool ────────────────────────────────────────────────────────────

describe("get_memory_note tool (G-P39.6 / D-7)", () => {
  it("T-GetNoteTool.1: existing key → get_memory_note → ok { found: true, note: { key, value, updatedAt } }", async () => {
    // Given: a DB with note key "existing_key" set via set_memory_note
    // When:  get_memory_note execute({ key: "existing_key" })
    // Then:  result.ok === true; data.found === true; data.note.value is the stored value
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      // Seed: set the note
      const setExec = toolExecute(makeSetMemoryNoteTool(dbPath));
      await setExec({ key: "existing_key", value: "stored_value_42" });

      const exec = toolExecute(makeGetMemoryNoteTool(dbPath));
      const result = (await exec({ key: "existing_key" })) as {
        ok: boolean;
        data?: { found: boolean; note?: { key: string; value: string; updatedAt: string } | null };
      };
      assert.equal(result.ok, true, "get_memory_note must return ok:true");
      assert.equal(result.data?.found, true, "found must be true for an existing key");
      assert.equal(result.data?.note?.value, "stored_value_42", "note.value must match stored value");
      assert.ok(
        typeof result.data?.note?.updatedAt === "string" && result.data.note.updatedAt.length > 0,
        "note.updatedAt must be a non-empty string",
      );
    } finally {
      cleanup();
    }
  });

  it("T-GetNoteTool.2: missing key → get_memory_note → ok { found: false, note: null } (NOT a fail envelope — D-7)", async () => {
    // Given: a DB with no note for key "no_such_key_xyz"
    // When:  get_memory_note execute({ key: "no_such_key_xyz" })
    // Then:  result.ok === true (absence is a normal answer, per D-7);
    //        data.found === false; data.note === null
    const { dbPath, cleanup } = uniqueDbPath();
    try {
      const exec = toolExecute(makeGetMemoryNoteTool(dbPath));
      const result = (await exec({ key: "no_such_key_xyz" })) as {
        ok: boolean;
        data?: { found: boolean; note: null };
      };
      assert.equal(result.ok, true, "missing key must return ok:true (D-7: absence is normal)");
      assert.equal(result.data?.found, false, "found must be false for missing key");
      assert.equal(result.data?.note, null, "note must be null for missing key");
    } finally {
      cleanup();
    }
  });
});
