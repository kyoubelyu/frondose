/**
 * P-3 mock tests — T-M75: reload tool.
 *
 * Tests makeReloadTool() calls client.reload() + waitFor({kind:"load"}) and returns ok("reload", {}).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeReloadTool } from "../../../src/tools/linkedin/reload.js";

const abortSignal = new AbortController().signal;

// ─── T-M75 ─────────────────────────────────────────────────────────────────────

test("T-M75: reload tool execute calls Page.reload + waitFor load event, returns ok('reload', {})", async () => {
  let reloadCalled = 0;

  const fakeHandle = {
    Page: {
      enable: async () => {},
      reload: async (_args: unknown) => {
        reloadCalled++;
      },
      // waitForLoad("load") subscribes to loadEventFired; fire immediately to simulate load
      loadEventFired: (cb: () => void) => {
        Promise.resolve().then(() => cb());
        return () => {};
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  const session = {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
  };

  const tool = makeReloadTool(session);

  assert.ok(typeof tool.description === "string", "tool must have a description");
  assert.ok(tool.description.toLowerCase().includes("reload"), "description must mention reload");

  const result = await tool.execute({}, { toolCallId: "t1", messages: [], abortSignal });

  assert.equal(result.ok, true, "reload must return ok");
  assert.equal(result.command, "reload");

  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.deepEqual(data, {}, "reload data must be empty {}");

  assert.equal(reloadCalled, 1, "Page.reload must be called exactly once");
});
