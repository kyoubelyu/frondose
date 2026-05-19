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

describe("B3: client.scroll() uses window.scrollBy (evaluate-based, no synthesizeScrollGesture)", () => {
  it("T-B3.1: when CdpClient.scroll('down', 3500), evaluate receives 'window.scrollBy(0, 3500)' and synthesizeScrollGesture/getLayoutMetrics are NOT called", async () => {
    // Given: CdpClient.fromHandle with fake Runtime.evaluate, Page.getLayoutMetrics, Input.synthesizeScrollGesture
    // When:  client.scroll("down", 3500) is called
    // Then:  Runtime.evaluate called with "window.scrollBy(0, 3500)"; synthesizeScrollGesture NOT called; getLayoutMetrics NOT called

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
    assert.equal(evaluateCalls[0], "window.scrollBy(0, 3500)", "evaluate expression must be window.scrollBy(0, 3500)");
    assert.equal(
      getLayoutMetricsCalled,
      false,
      "Page.getLayoutMetrics must NOT be called (no viewport coordinate needed)",
    );
    assert.equal(synthesizeScrollGestureCalled, false, "Input.synthesizeScrollGesture must NOT be called");
  });

  it("T-B3.2: scroll direction-to-delta mapping — up→(0,-N), left→(-N,0), right→(N,0) — no synthesizeScrollGesture in any direction", async () => {
    // Given: CdpClient.fromHandle with Runtime.evaluate recording all expression strings
    // When:  scroll("up", 200), scroll("left", 100), scroll("right", 150) are called in sequence
    // Then:  evaluate expressions are "window.scrollBy(0, -200)", "window.scrollBy(-100, 0)", "window.scrollBy(150, 0)" respectively

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
    assert.equal(evaluateCalls[0], "window.scrollBy(0, -200)", "up → dy=-200");
    assert.equal(evaluateCalls[1], "window.scrollBy(-100, 0)", "left → dx=-100");
    assert.equal(evaluateCalls[2], "window.scrollBy(150, 0)", "right → dx=150");
    assert.equal(synthesizeScrollGestureCalled, false, "synthesizeScrollGesture must NOT be called for any direction");
  });
});
