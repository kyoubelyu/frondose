/**
 * P-4 mock tests — T-M119: makeMemoryTools factory.
 *
 * P-39 update: makeMemoryTools now returns 5 keys:
 *   remember, getMemory, search_memory, set_memory_note, get_memory_note
 * (Updated at P-39 Step 5 — 3 new P-39 tools added to makeMemoryTools.)
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeMemoryTools } from "../../../src/tools/memory/index.js";

// ─── T-M119 ──────────────────────────────────────────────────────────────────

test("T-M119: makeMemoryTools returns exactly 5 keys: remember, getMemory, search_memory, set_memory_note, get_memory_note", () => {
  const tools = makeMemoryTools(join(tmpdir(), "p4-t119-memory.sqlite"));
  const keys = Object.keys(tools).sort();

  // JS sort: 'M' (U+004D=77) < '_' (U+005F=95), so 'getMemory' < 'get_memory_note'
  const expectedKeys = ["getMemory", "get_memory_note", "remember", "search_memory", "set_memory_note"];
  assert.deepEqual(keys, expectedKeys, "makeMemoryTools must return the 5 expected P-39 memory tool keys");
  assert.equal(keys.length, 5, "must have exactly 5 memory tools");

  assert.ok("remember" in tools, "'remember' key must be present");
  assert.ok("getMemory" in tools, "'getMemory' key must be present");
  assert.ok("search_memory" in tools, "'search_memory' key must be present");
  assert.ok("set_memory_note" in tools, "'set_memory_note' key must be present");
  assert.ok("get_memory_note" in tools, "'get_memory_note' key must be present");

  // Each must be a Vercel AI tool (has execute + parameters + description)
  for (const key of ["remember", "getMemory", "search_memory", "set_memory_note", "get_memory_note"] as const) {
    const t = tools[key];
    assert.ok(typeof t?.execute === "function", `${key}.execute must be a function`);
    assert.ok(typeof t?.description === "string", `${key}.description must be a string`);
  }
});
