/**
 * P-4 mock tests — T-M118: makeIdentityTools factory.
 *
 * Verifies that makeIdentityTools returns exactly 2 keys: identity + getIdentity.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeIdentityTools } from "../../../src/tools/identity/index.js";

// ─── T-M118 ──────────────────────────────────────────────────────────────────

test("T-M118: makeIdentityTools returns exactly 2 keys: identity and getIdentity", () => {
  const tools = makeIdentityTools(join(tmpdir(), "p4-t118-identity.json"));
  const keys = Object.keys(tools).sort();

  assert.deepEqual(keys, ["getIdentity", "identity"], "makeIdentityTools must return {identity, getIdentity}");
  assert.equal(keys.length, 2, "must have exactly 2 identity tools");

  assert.ok("identity" in tools, "'identity' key must be present");
  assert.ok("getIdentity" in tools, "'getIdentity' key must be present");

  // Each must be a Vercel AI tool (has execute + parameters + description)
  for (const key of ["identity", "getIdentity"] as const) {
    const t = tools[key];
    assert.ok(typeof t?.execute === "function", `${key}.execute must be a function`);
    assert.ok(typeof t?.description === "string", `${key}.description must be a string`);
  }
});
