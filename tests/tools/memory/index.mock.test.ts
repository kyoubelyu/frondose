/**
 * P-4 mock tests — T-M119: makeMemoryTools factory.
 *
 * Verifies that makeMemoryTools returns exactly 2 keys: remember + getMemory.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeMemoryTools } from "../../../src/tools/memory/index.js";

// ─── T-M119 ──────────────────────────────────────────────────────────────────

test("T-M119: makeMemoryTools returns exactly 2 keys: remember and getMemory", () => {
  const tools = makeMemoryTools("/tmp/p4-t119-memory.sqlite");
  const keys = Object.keys(tools).sort();

  assert.deepEqual(keys, ["getMemory", "remember"], "makeMemoryTools must return {remember, getMemory}");
  assert.equal(keys.length, 2, "must have exactly 2 memory tools");

  assert.ok("remember" in tools, "'remember' key must be present");
  assert.ok("getMemory" in tools, "'getMemory' key must be present");

  // Each must be a Vercel AI tool (has execute + parameters + description)
  for (const key of ["remember", "getMemory"] as const) {
    const t = tools[key];
    assert.ok(typeof t?.execute === "function", `${key}.execute must be a function`);
    assert.ok(typeof t?.description === "string", `${key}.description must be a string`);
  }
});
