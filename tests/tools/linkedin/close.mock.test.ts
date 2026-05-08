/**
 * P-3 mock tests — T-M74: close tool.
 *
 * Tests makeCloseTool() calls closeBrowser() and returns ok("close", {}).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeCloseTool } from "../../../src/tools/linkedin/close.js";

const abortSignal = new AbortController().signal;

// ─── T-M74 ─────────────────────────────────────────────────────────────────────

test("T-M74: close tool execute calls closeBrowser() and returns ok('close', {})", async () => {
  let closeBrowserCalled = 0;

  const fakeHandle = {
    Browser: {
      close: async () => {
        closeBrowserCalled++;
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };

  const tool = makeCloseTool(session);

  // Tool description
  assert.ok(typeof tool.description === "string", "tool must have a description");
  assert.ok(
    tool.description.toLowerCase().includes("close") || tool.description.toLowerCase().includes("browser"),
    "description must mention close/browser",
  );

  // Execute
  const result = await tool.execute({}, { toolCallId: "t1", messages: [], abortSignal });

  assert.equal(result.ok, true, "close must return ok");
  assert.equal(result.command, "close");

  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.deepEqual(data, {}, "close data must be empty {}");

  assert.equal(closeBrowserCalled, 1, "Browser.close must be called exactly once");
});
