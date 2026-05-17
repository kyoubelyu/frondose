/**
 * P-33 Step 4a — T-P33.BROWSER.INDEX: makeBrowserTools inventory.
 *
 * Replaces the stale T-M80 test (which asserted makeLinkedinTools → 10 tools).
 * Now asserts makeBrowserTools(session) returns exactly the 11 expected browser
 * tool keys after the P-33 reorg.
 *
 * Gate coverage: G-P33.3 (makeBrowserTools → 11 tools, exact name set)
 *
 * Note (Step 4a): this file imports src/tools/browser/index.js which does NOT
 * exist yet — expected compile/import failure until builder Step 4b creates
 * src/tools/browser/. This is the intended outside-in TDD red state.
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeBrowserTools } from "../../../src/tools/browser/index.js";

// ─── Fake session helper ──────────────────────────────────────────────────────

function makeFakeSession() {
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
  return {
    inputMode: "cdp" as const,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };
}

// ─── T-P33.BROWSER.INDEX ─────────────────────────────────────────────────────

describe("makeBrowserTools registry (G-P33.3)", () => {
  it("T-P33.BROWSER.INDEX: makeBrowserTools returns exactly 11 browser tools with correct names", () => {
    // Given: a fake LinkedinSession (no Chrome required)
    // When:  makeBrowserTools(session) is called
    // Then:  exactly 11 tools returned; names match the expected browser-tool set

    const session = makeFakeSession();
    const tools = makeBrowserTools(session);
    const keys = Object.keys(tools).sort();

    const expectedKeys = [
      "clear_cookies",
      "click",
      "close",
      "inspect",
      "navigate_to_url",
      "press",
      "reload",
      "screenshot",
      "scroll",
      "type",
      "upload",
    ].sort();

    assert.deepEqual(keys, expectedKeys, "makeBrowserTools must return exactly 11 browser tool keys");
    assert.equal(keys.length, 11, "must have exactly 11 tools");

    // Each tool must be a defined object with a description string
    for (const key of keys) {
      const tool = tools[key as keyof typeof tools];
      assert.ok(tool !== undefined, `tool '${key}' must be defined`);
      assert.ok(
        typeof (tool as { description?: unknown }).description === "string",
        `tool '${key}' must have a description string`,
      );
    }
  });
});
