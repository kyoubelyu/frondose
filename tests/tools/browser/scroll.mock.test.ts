/**
 * P-3 mock tests — T-M76..T-M77: scroll tool.
 *
 * Tests makeScrollTool() schema and execute dispatch to client.scroll().
 * NOTE: execute() calls applyPacing(). P-Y5 D-RUN-2 raises the default band to
 * 800-2500ms, so this suite disables pacing via MAI_PACE_MIN_MS=0 (resolvePaceBand
 * → disabled → no sleep; data.pacing is still {waitedMs:0,...} so presence checks hold).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeScrollTool } from "../../../src/tools/browser/scroll.js";

// P-Y5 D-RUN-2: keep the mock suite fast — disable inter-tool pacing for this file.
process.env.FRONDOSE_PACE_MIN_MS = "0";

const abortSignal = new AbortController().signal;

function makeFakeSession() {
  const scrollCalls: Array<{ direction: string; amount: number }> = [];

  // P-37: scroll now uses Runtime.evaluate("window.scrollBy(dx, dy)")
  // — old Input.synthesizeScrollGesture and Page.getLayoutMetrics are no longer called.
  const fakeHandle = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }) => {
        const match = expression.match(/window\.scrollBy\((-?\d+),\s*(-?\d+)\)/);
        if (match) {
          const dx = parseInt(match[1], 10);
          const dy = parseInt(match[2], 10);
          const direction = dy > 0 ? "down" : dy < 0 ? "up" : dx > 0 ? "right" : "left";
          const amount = Math.abs(dy !== 0 ? dy : dx);
          scrollCalls.push({ direction, amount });
        }
        return { result: { value: undefined } };
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  return {
    inputMode: "cdp" as const,
    heartbeat: async () => true,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
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
