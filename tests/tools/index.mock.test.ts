/**
 * P-3 mock tests — T-M81: makeAllTools factory.
 *
 * Tests that makeAllTools() without session returns only {echo},
 * and makeAllTools(session) returns 11 keys (echo + 10 LinkedIn tools).
 * Also verifies the static `tools` export still only contains {echo}.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../src/linkedin/types.js";
import { makeAllTools, tools } from "../../src/tools/index.js";

// ─── T-M81 ─────────────────────────────────────────────────────────────────────

test("T-M81: makeAllTools with no session returns {echo} only; with session returns 11 keys", () => {
  // No session → echo-only (MAI_NO_CHROME=1 path)
  const echoOnly = makeAllTools();
  const echoKeys = Object.keys(echoOnly);
  assert.deepEqual(echoKeys, ["echo"], "makeAllTools() (no session) must return only 'echo'");

  // Static export `tools` must also be echo-only (P-1 backward compat)
  const staticKeys = Object.keys(tools);
  assert.deepEqual(staticKeys, ["echo"], "static `tools` export must contain only 'echo'");

  // With session → 11 keys (echo + 10 LinkedIn tools)
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };

  const allTools = makeAllTools(session);
  const allKeys = Object.keys(allTools).sort();

  const expectedKeys = [
    "click",
    "close",
    "echo",
    "inspect",
    "launch",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
  ].sort();

  assert.deepEqual(allKeys, expectedKeys, "makeAllTools(session) must return 11 keys");
  assert.equal(allKeys.length, 11, "must have exactly 11 tools with session");

  // echo tool must be present in both
  assert.ok("echo" in echoOnly, "echo must be in echo-only set");
  assert.ok("echo" in allTools, "echo must be in full set");
});
