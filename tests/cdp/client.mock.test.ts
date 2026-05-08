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
