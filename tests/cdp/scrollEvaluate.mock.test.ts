/**
 * P-37 Step 5 — T-B3.1, T-B3.2 (assertions filled)
 *
 * B3: client.scroll() → window.scrollBy (replaces Input.synthesizeScrollGesture).
 * Verifies the new evaluate-based scroll method and the direction-to-delta mapping.
 *
 * Gate coverage: G-P37.1 (evaluate expression correctness), G-P37.2 (no (x,y) / no viewport-metrics)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { buildDocumentScrollExpression } from "../../src/cdp/scroll.js";

describe("B3: client.scroll() remains evaluate-based with a self-verifying document expression", () => {
  it("T-B3.1: CdpClient.scroll evaluates the production expression without synthesizeScrollGesture/getLayoutMetrics", async () => {
    // Given a fake CDP transport; When document scroll executes; Then the exact production expression is evaluated once.

    const evaluateCalls: string[] = [];
    let synthesizeScrollGestureCalled = false;
    let getLayoutMetricsCalled = false;

    const fakeHandle = {
      Runtime: {
        evaluate: async (args: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }) => {
          evaluateCalls.push(args.expression);
          return { result: { value: undefined } };
        },
      },
      Page: {
        getLayoutMetrics: async () => {
          getLayoutMetricsCalled = true;
          return {
            visualViewport: { clientWidth: 1280, clientHeight: 800 },
            layoutViewport: { clientWidth: 1280, clientHeight: 800 },
          };
        },
      },
      Input: {
        synthesizeScrollGesture: async (_args: unknown) => {
          synthesizeScrollGestureCalled = true;
        },
      },
    };

    const client = CdpClient.fromHandle(fakeHandle);
    await client.scroll("down", 3500);

    assert.equal(evaluateCalls.length, 1, "exactly one evaluate call expected");
    assert.equal(evaluateCalls[0], buildDocumentScrollExpression("down", 3500));
    assert.equal(
      getLayoutMetricsCalled,
      false,
      "Page.getLayoutMetrics must NOT be called (no viewport coordinate needed)",
    );
    assert.equal(synthesizeScrollGestureCalled, false, "Input.synthesizeScrollGesture must NOT be called");
  });

  it("T-B3.2: every direction reaches its exact production expression and never dispatches a gesture", async () => {
    // Given a recording CDP transport; When three directions execute; Then each generated production expression is preserved.

    const evaluateCalls: string[] = [];
    let synthesizeScrollGestureCalled = false;

    const fakeHandle = {
      Runtime: {
        evaluate: async (args: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }) => {
          evaluateCalls.push(args.expression);
          return { result: { value: undefined } };
        },
      },
      Page: {
        getLayoutMetrics: async () => ({
          visualViewport: { clientWidth: 1280, clientHeight: 800 },
          layoutViewport: { clientWidth: 1280, clientHeight: 800 },
        }),
      },
      Input: {
        synthesizeScrollGesture: async (_args: unknown) => {
          synthesizeScrollGestureCalled = true;
        },
      },
    };

    const client = CdpClient.fromHandle(fakeHandle);
    await client.scroll("up", 200);
    await client.scroll("left", 100);
    await client.scroll("right", 150);

    assert.equal(evaluateCalls.length, 3, "exactly 3 evaluate calls (one per scroll call)");
    assert.equal(evaluateCalls[0], buildDocumentScrollExpression("up", 200));
    assert.equal(evaluateCalls[1], buildDocumentScrollExpression("left", 100));
    assert.equal(evaluateCalls[2], buildDocumentScrollExpression("right", 150));
    assert.equal(synthesizeScrollGestureCalled, false, "synthesizeScrollGesture must NOT be called for any direction");
  });
});
