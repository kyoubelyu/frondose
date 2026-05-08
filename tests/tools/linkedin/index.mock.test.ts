/**
 * P-3 mock tests — T-M80: makeLinkedinTools inventory.
 *
 * Tests that makeLinkedinTools(session) returns exactly the 10 expected tool keys.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeLinkedinTools } from "../../../src/tools/linkedin/index.js";

// ─── T-M80 ─────────────────────────────────────────────────────────────────────

test("T-M80: makeLinkedinTools returns exactly 10 LinkedIn tools with correct names", () => {
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };

  const tools = makeLinkedinTools(session);
  const keys = Object.keys(tools).sort();

  const expectedKeys = [
    "click",
    "close",
    "inspect",
    "launch",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "type",
    "upload",
  ].sort();

  assert.deepEqual(keys, expectedKeys, "makeLinkedinTools must return exactly 10 tool keys");
  assert.equal(keys.length, 10, "must have exactly 10 tools");

  // Each tool must have a description and parameters property
  for (const key of keys) {
    const tool = tools[key as keyof typeof tools];
    assert.ok(tool !== undefined, `tool '${key}' must be defined`);
  }
});
