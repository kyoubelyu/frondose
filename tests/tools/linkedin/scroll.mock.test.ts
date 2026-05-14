/**
 * P-3 mock tests — T-M76..T-M77: scroll tool.
 *
 * Tests makeScrollTool() schema and execute dispatch to client.scroll().
 * NOTE: execute() calls applyPacing() (400-800ms real wait per test).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeScrollTool } from "../../../src/tools/linkedin/scroll.js";

const abortSignal = new AbortController().signal;

function makeFakeSession() {
  const scrollCalls: Array<{ direction: string; amount: number }> = [];

  const fakeHandle = {
    Page: {
      getLayoutMetrics: async () => ({
        visualViewport: { clientWidth: 1280, clientHeight: 800 },
      }),
    },
    Input: {
      synthesizeScrollGesture: async (args: { x: number; y: number; xDistance: number; yDistance: number }) => {
        scrollCalls.push({
          direction: args.yDistance > 0 ? "down" : args.yDistance < 0 ? "up" : args.xDistance > 0 ? "right" : "left",
          amount: Math.abs(args.yDistance || args.xDistance),
        });
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  return {
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined as CurrentSurfaceContext | undefined,
    scrollCalls,
  };
}

// ─── T-M76 ─────────────────────────────────────────────────────────────────────

test(
  "T-M76: scroll tool execute({direction:'down', amount:300}) calls client.scroll and returns ok",
  { timeout: 5000 },
  async () => {
    const session = makeFakeSession();
    const tool = makeScrollTool(session);

    // Schema validation
    const valid = tool.parameters.safeParse({ direction: "down", amount: 300 });
    assert.equal(valid.success, true);

    const invalidDir = tool.parameters.safeParse({ direction: "diagonal", amount: 100 });
    assert.equal(invalidDir.success, false, "invalid direction must fail");

    const invalidAmount = tool.parameters.safeParse({ direction: "up", amount: -10 });
    assert.equal(invalidAmount.success, false, "negative amount must fail");

    // Execute
    const result = await tool.execute(
      { direction: "down", amount: 300 },
      { toolCallId: "t1", messages: [], abortSignal },
    );

    assert.equal(result.ok, true, "scroll must return ok");
    assert.equal(result.command, "scroll");

    // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
    const data = (result as any).data;
    assert.equal(data.direction, "down");
    assert.equal(data.amount, 300);
    assert.ok(data.pacing !== undefined, "data.pacing must be present");

    assert.equal(session.scrollCalls.length, 1, "scroll must be called once");
    assert.equal(session.scrollCalls[0]?.direction, "down");
    assert.equal(session.scrollCalls[0]?.amount, 300);
  },
);

// ─── T-M77 ─────────────────────────────────────────────────────────────────────

test(
  "T-M77: scroll tool Zod schema defaults amount to 3500; parsed params work for 'up' direction",
  { timeout: 5000 },
  async () => {
    const session = makeFakeSession();
    const tool = makeScrollTool(session);

    // Parse through Zod to apply the default (amount defaults to 3500 when omitted — Phase 86.1 upstream fix)
    const params = tool.parameters.parse({ direction: "up" });
    assert.equal(params.amount, 3500, "Zod schema must default amount to 3500");

    // Execute with the Zod-parsed params (amount = 3500 from default)
    const result = await tool.execute(params, { toolCallId: "t2", messages: [], abortSignal });

    assert.equal(result.ok, true, "scroll with default amount must succeed");
    // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
    const data = (result as any).data;
    assert.equal(data.amount, 3500, "execute data.amount must be 3500 (from default)");
    assert.equal(data.direction, "up");
  },
);
