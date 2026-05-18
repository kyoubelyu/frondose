/**
 * P-2 mock tests — T-M18..T-M22: CdpClient method dispatch.
 *
 * Uses CdpClient.fromHandle(fakeHandle) (the test factory per §6.4)
 * to inject a fake CdpHandle without needing a real Chrome connection.
 *
 * No real Chrome required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

type MouseEventCall = {
  type: string;
  x: number;
  y: number;
  button?: string;
  clickCount?: number;
};

type KeyEventCall = { type: string; key: string };

/** Border: [x0,y0, x1,y1, x2,y2, x3,y3] — Quad 8-element array.
 *  center_x = (border[0] + border[4]) / 2
 *  center_y = (border[1] + border[5]) / 2
 *
 *  For border [10, 20, 30, 20, 30, 40, 10, 40]:
 *    center_x = (10 + 30) / 2 = 20
 *    center_y = (20 + 40) / 2 = 30
 */
const FAKE_BORDER = [10, 20, 30, 20, 30, 40, 10, 40];

// ─── T-M18 ─────────────────────────────────────────────────────────────────────

test("T-M18: clickAt(selector) does getDocument + querySelectorAll + getBoxModel + 3 mouse events", async () => {
  const mouseEvents: MouseEventCall[] = [];
  const getDocumentCalls: Array<{ depth: number }> = [];
  const querySelectorAllCalls: Array<{ nodeId: number; selector: string }> = [];
  const boxModelCalls: Array<{ backendNodeId?: number; nodeId?: number }> = [];

  const fakeHandle = {
    DOM: {
      getDocument: async (args: { depth: number }) => {
        getDocumentCalls.push(args);
        return { root: { nodeId: 1 } };
      },
      querySelectorAll: async (args: { nodeId: number; selector: string }) => {
        querySelectorAllCalls.push(args);
        return { nodeIds: [42] };
      },
      getBoxModel: async (args: { backendNodeId?: number; nodeId?: number }) => {
        boxModelCalls.push(args);
        return { model: { border: FAKE_BORDER } };
      },
    },
    Input: {
      dispatchMouseEvent: async (args: MouseEventCall) => {
        mouseEvents.push(args);
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  await client.clickAt("#submit");

  // DOM.getDocument must be called with depth:0
  assert.equal(getDocumentCalls.length, 1, "getDocument must be called exactly once");
  assert.equal(getDocumentCalls[0]?.depth, 0, "getDocument must be called with depth:0");

  // DOM.querySelectorAll must be called with nodeId from getDocument root + selector
  assert.equal(querySelectorAllCalls.length, 1, "querySelectorAll must be called exactly once");
  assert.equal(querySelectorAllCalls[0]?.nodeId, 1, "querySelectorAll nodeId must come from getDocument root");
  assert.equal(querySelectorAllCalls[0]?.selector, "#submit", "querySelectorAll selector must be '#submit'");

  // DOM.getBoxModel must be called with nodeId from querySelectorAll result
  assert.equal(boxModelCalls.length, 1, "getBoxModel must be called exactly once");
  assert.equal(boxModelCalls[0]?.nodeId, 42, "getBoxModel must receive the resolved nodeId");
  assert.equal(boxModelCalls[0]?.backendNodeId, undefined, "selector path must use nodeId not backendNodeId");

  // Must fire exactly 3 mouse events in order
  assert.equal(mouseEvents.length, 3, "must dispatch exactly 3 mouse events");
  assert.equal(mouseEvents[0]?.type, "mouseMoved");
  assert.equal(mouseEvents[1]?.type, "mousePressed");
  assert.equal(mouseEvents[2]?.type, "mouseReleased");

  // All events must use the computed center coordinates
  for (const evt of mouseEvents) {
    assert.equal(evt.x, 20, `event ${evt.type} x must be 20`);
    assert.equal(evt.y, 30, `event ${evt.type} y must be 30`);
  }

  // mousePressed and mouseReleased must have button:'left' and clickCount:1
  assert.equal(mouseEvents[1]?.button, "left");
  assert.equal(mouseEvents[1]?.clickCount, 1);
  assert.equal(mouseEvents[2]?.button, "left");
  assert.equal(mouseEvents[2]?.clickCount, 1);
});

// ─── T-M19 ─────────────────────────────────────────────────────────────────────

test("T-M19: clickAt(@e1) uses RefMap from prior snapshot (backendNodeId path)", async () => {
  const expectedBackendNodeId = 99;
  const boxModelCalls: Array<{ backendNodeId?: number; nodeId?: number }> = [];
  const getDocumentCalls: number[] = [];

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: [
          {
            nodeId: "ax1",
            role: { type: "role", value: "button" },
            name: { type: "string", value: "Submit" },
            backendDOMNodeId: expectedBackendNodeId,
          },
        ],
      }),
    },
    DOM: {
      getDocument: async () => {
        // getDocument should NOT be called on the ref path
        getDocumentCalls.push(1);
        return { root: { nodeId: 1 } };
      },
      getBoxModel: async (args: { backendNodeId?: number; nodeId?: number }) => {
        boxModelCalls.push(args);
        return { model: { border: FAKE_BORDER } };
      },
    },
    Input: {
      dispatchMouseEvent: async () => {},
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  // snapshot() populates the internal refMap
  await client.snapshot();

  // clickAt("@e1") must use backendNodeId from the RefMap, not the selector path
  await client.clickAt("@e1");

  // getDocument must NOT be called (ref path skips selector resolution)
  assert.equal(getDocumentCalls.length, 0, "getDocument must NOT be called on the @ref path");

  // getBoxModel must be called with backendNodeId only
  assert.equal(boxModelCalls.length, 1, "getBoxModel must be called exactly once");
  assert.equal(
    boxModelCalls[0]?.backendNodeId,
    expectedBackendNodeId,
    "getBoxModel must use backendNodeId from RefMap",
  );
  assert.equal(boxModelCalls[0]?.nodeId, undefined, "ref path must not pass nodeId to getBoxModel");
});

// ─── T-M20 ─────────────────────────────────────────────────────────────────────

test("T-M20: clickAt(@unknown) throws when ref is not in current RefMap", async () => {
  // No snapshot called → refMap is empty
  const client = CdpClient.fromHandle({});

  await assert.rejects(
    () => client.clickAt("@e99"),
    (err: unknown) => err instanceof Error && /ref.*not found/i.test(err.message),
    "clickAt(@unknown) must throw an error mentioning ref not found",
  );
});

// ─── T-M21 ─────────────────────────────────────────────────────────────────────

test("T-M21: typeAt clicks first then Input.insertText({ text })", async () => {
  // Track call order to verify click sequence precedes insertText
  const callLog: string[] = [];

  const fakeHandle = {
    DOM: {
      getDocument: async () => {
        callLog.push("getDocument");
        return { root: { nodeId: 1 } };
      },
      querySelectorAll: async () => {
        callLog.push("querySelectorAll");
        return { nodeIds: [55] };
      },
      getBoxModel: async () => {
        callLog.push("getBoxModel");
        return { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } };
      },
    },
    Input: {
      dispatchMouseEvent: async (args: { type: string }) => {
        callLog.push(`mouseEvent:${args.type}`);
      },
      insertText: async (args: { text: string }) => {
        callLog.push(`insertText:${args.text}`);
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  await client.typeAt("#input", "hello");

  // insertText must be the last entry, after all mouse events
  const insertTextIdx = callLog.lastIndexOf("insertText:hello");
  assert.ok(insertTextIdx >= 0, "insertText must be called with 'hello'");

  const mouseRelIdx = callLog.lastIndexOf("mouseEvent:mouseReleased");
  assert.ok(mouseRelIdx >= 0, "mouseReleased event must be called");
  assert.ok(mouseRelIdx < insertTextIdx, "click sequence must complete before insertText");

  // Verify exactly one insertText call
  const insertCount = callLog.filter((e) => e.startsWith("insertText:")).length;
  assert.equal(insertCount, 1, "insertText must be called exactly once");
});

// ─── T-M22 ─────────────────────────────────────────────────────────────────────

test("T-M22: pressKey('Enter') issues keyDown then keyUp", async () => {
  const keyEvents: KeyEventCall[] = [];

  const fakeHandle = {
    Input: {
      dispatchKeyEvent: async (args: KeyEventCall) => {
        keyEvents.push(args);
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  await client.pressKey("Enter");

  assert.equal(keyEvents.length, 2, "must dispatch exactly 2 key events");
  assert.equal(keyEvents[0]?.type, "keyDown", "first event must be keyDown");
  assert.equal(keyEvents[0]?.key, "Enter", "first event key must be Enter");
  assert.equal(keyEvents[1]?.type, "keyUp", "second event must be keyUp");
  assert.equal(keyEvents[1]?.key, "Enter", "second event key must be Enter");
});

// ─── T-M23..T-M27: P-3 CdpClient extensions ──────────────────────────────────

// T-M23: P-37 B3 — scroll uses window.scrollBy evaluate (replaces synthesizeScrollGesture)
// Updated from the pre-P-37 version that asserted getLayoutMetrics + synthesizeScrollGesture.
test("T-M23: scroll('down', 300) calls Runtime.evaluate('window.scrollBy(0, 300)') — no synthesizeScrollGesture, no getLayoutMetrics", async () => {
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
  await client.scroll("down", 300);

  assert.equal(evaluateCalls.length, 1, "exactly one Runtime.evaluate call expected");
  assert.equal(evaluateCalls[0], "window.scrollBy(0, 300)", "evaluate expression must be 'window.scrollBy(0, 300)'");
  assert.equal(getLayoutMetricsCalled, false, "Page.getLayoutMetrics must NOT be called (no viewport coordinates needed)");
  assert.equal(synthesizeScrollGestureCalled, false, "Input.synthesizeScrollGesture must NOT be called (replaced by evaluate)");
});

// T-M24: getCurrentUrl delegates to Runtime.evaluate('window.location.href')
test("T-M24: getCurrentUrl() returns the evaluated window.location.href", async () => {
  const evaluateCalls: Array<{ expression: string; returnByValue: boolean; awaitPromise: boolean }> = [];

  const fakeHandle = {
    Runtime: {
      evaluate: async (args: { expression: string; returnByValue: boolean; awaitPromise: boolean }) => {
        evaluateCalls.push(args);
        return { result: { value: "https://www.linkedin.com/feed/" } };
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  const url = await client.getCurrentUrl();

  assert.equal(url, "https://www.linkedin.com/feed/", "getCurrentUrl must return the evaluated href");
  assert.equal(evaluateCalls.length, 1, "Runtime.evaluate must be called once");
  assert.equal(
    evaluateCalls[0]?.expression,
    "window.location.href",
    "evaluate expression must be window.location.href",
  );
  assert.equal(evaluateCalls[0]?.returnByValue, true, "returnByValue must be true");
});

// T-M25: querySelectorAll calls DOM.getDocument then DOM.querySelectorAll
test("T-M25: querySelectorAll('.foo') calls DOM.getDocument({depth:0}) then DOM.querySelectorAll and returns nodeIds[]", async () => {
  let getDocArgs: { depth: number } | null = null;
  let qsaArgs: { nodeId: number; selector: string } | null = null;

  const fakeHandle = {
    DOM: {
      getDocument: async (args: { depth: number }) => {
        getDocArgs = args;
        return { root: { nodeId: 7 } };
      },
      querySelectorAll: async (args: { nodeId: number; selector: string }) => {
        qsaArgs = args;
        return { nodeIds: [11, 22, 33] };
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  const nodeIds = await client.querySelectorAll(".foo");

  assert.deepEqual(nodeIds, [11, 22, 33], "querySelectorAll must return the nodeIds array");
  assert.ok(getDocArgs !== null, "DOM.getDocument must be called");
  assert.equal(getDocArgs?.depth, 0, "DOM.getDocument must be called with depth:0");
  assert.ok(qsaArgs !== null, "DOM.querySelectorAll must be called");
  assert.equal(qsaArgs?.nodeId, 7, "DOM.querySelectorAll nodeId must come from getDocument root");
  assert.equal(qsaArgs?.selector, ".foo", "DOM.querySelectorAll selector must be '.foo'");
});

// T-M26: setFileInputFiles resolves backendNodeId via DOM.describeNode then calls DOM.setFileInputFiles
// (Updated from resolveNode→requestNode chain per validator FAIL-1 / builder Step 5a fix)
test("T-M26: setFileInputFiles(42, ['/tmp/a.png']) resolves backendNodeId to nodeId then calls DOM.setFileInputFiles", async () => {
  let describeNodeArgs: { backendNodeId: number } | null = null;
  let setFileInputArgs: { nodeId: number; files: string[] } | null = null;

  const fakeHandle = {
    DOM: {
      describeNode: async (args: { backendNodeId?: number; nodeId?: number }) => {
        if (args.backendNodeId !== undefined) {
          describeNodeArgs = { backendNodeId: args.backendNodeId };
          return { node: { nodeId: 77 } };
        }
        return { node: { backendNodeId: 42 } };
      },
      setFileInputFiles: async (args: { nodeId: number; files: string[] }) => {
        setFileInputArgs = args;
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  await client.setFileInputFiles(42, ["/tmp/a.png"]);

  assert.ok(describeNodeArgs !== null, "DOM.describeNode must be called");
  assert.equal(describeNodeArgs?.backendNodeId, 42, "describeNode must receive backendNodeId=42");
  assert.ok(setFileInputArgs !== null, "DOM.setFileInputFiles must be called");
  assert.equal(setFileInputArgs?.nodeId, 77, "setFileInputFiles nodeId must come from describeNode");
  assert.deepEqual(setFileInputArgs?.files, ["/tmp/a.png"], "setFileInputFiles files must match input");
});

// T-M27: currentRefMap getter exposes the snapshot's RefMap after snapshot() is called
test("T-M27: client.currentRefMap after snapshot() equals the captured RefMap", async () => {
  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: [
          {
            nodeId: "ax1",
            role: { type: "role", value: "button" },
            name: { type: "string", value: "Click me" },
            backendDOMNodeId: 55,
          },
          {
            nodeId: "ax2",
            role: { type: "role", value: "textbox" },
            name: { type: "string", value: "Search" },
            backendDOMNodeId: 66,
          },
        ],
      }),
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  // Before snapshot, refMap is empty
  assert.deepEqual(Object.keys(client.currentRefMap), [], "currentRefMap must be empty before snapshot()");

  await client.snapshot();

  const refMap = client.currentRefMap;
  const keys = Object.keys(refMap);
  assert.equal(keys.length, 2, "currentRefMap must have 2 entries after snapshot");
  assert.ok(keys.includes("e1"), "must have key 'e1'");
  assert.ok(keys.includes("e2"), "must have key 'e2'");
  assert.equal(refMap.e1?.role, "button", "e1 must have role 'button'");
  assert.equal(refMap.e2?.role, "textbox", "e2 must have role 'textbox'");
});
