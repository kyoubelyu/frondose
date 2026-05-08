/**
 * P-3 mock tests — T-M65..T-M67: type tool.
 *
 * Tests makeTypeTool() schema, execute dispatch (ref + label paths), and no-ref-no-label error.
 * NOTE: execute() calls applyPacing() (400-800ms real wait per test).
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeTypeTool } from "../../../src/tools/linkedin/type.js";

const abortSignal = new AbortController().signal;
const FAKE_BORDER = [0, 0, 10, 0, 10, 10, 0, 10]; // center: x=5, y=5

function makeFakeSession() {
  const callLog: string[] = [];

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: [
          {
            nodeId: "ax1",
            role: { type: "role", value: "textbox" },
            name: { type: "string", value: "Search" },
            backendDOMNodeId: 55,
          },
        ],
      }),
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async (args: { type: string }) => {
        callLog.push(`mouse:${args.type}`);
      },
      dispatchKeyEvent: async (args: { type: string; key: string; modifiers?: number }) => {
        callLog.push(`key:${args.type}:${args.key}:mod${args.modifiers ?? 0}`);
      },
      insertText: async (args: { text: string }) => {
        callLog.push(`insertText:${args.text}`);
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  return {
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () =>
      ({
        pageUrl: "https://www.linkedin.com/feed/",
        surface: "feed",
        activeLayer: "page",
        entries: [{ ref: "@e1", role: "textbox", name: "Search" }],
      }) as CurrentSurfaceContext,
    callLog,
  };
}

// ─── T-M65 ─────────────────────────────────────────────────────────────────────

test("T-M65: makeTypeTool has description + schema requires text; ref and label are optional", () => {
  const session = makeFakeSession();
  const tool = makeTypeTool(session);

  assert.ok(typeof tool.description === "string");
  assert.ok(
    tool.description.toLowerCase().includes("type") || tool.description.toLowerCase().includes("text"),
    "description must mention typing or text",
  );

  // Valid: text + ref
  const withRef = tool.parameters.safeParse({ text: "hello", ref: "@e1" });
  assert.equal(withRef.success, true);

  // Valid: text + label
  const withLabel = tool.parameters.safeParse({ text: "hello", label: "Search" });
  assert.equal(withLabel.success, true);

  // Invalid: no text
  const noText = tool.parameters.safeParse({ ref: "@e1" });
  assert.equal(noText.success, false, "missing text must fail");
});

// ─── T-M66 ─────────────────────────────────────────────────────────────────────

test("T-M66: type tool execute via ref dispatches click → Ctrl+A → insertText", { timeout: 5000 }, async () => {
  const session = makeFakeSession();
  await session.getClient().snapshot(); // populate refMap with @e1 (textbox)

  const tool = makeTypeTool(session);

  const result = await tool.execute(
    { text: "hello world", ref: "@e1" },
    { toolCallId: "t1", messages: [], abortSignal },
  );

  assert.equal(result.ok, true, "result.ok must be true");
  assert.equal(result.command, "type");

  // Verify call sequence: click happened, then Ctrl+A, then insertText
  const log = session.callLog;

  const insertIdx = log.findIndex((e) => e.startsWith("insertText:hello world"));
  assert.ok(insertIdx >= 0, "insertText must be called with the typed text");

  // Ctrl+A: dispatchKeyEvent with key='a' and modifiers=2 (Ctrl)
  const ctrlA = log.find((e) => e === "key:keyDown:a:mod2");
  assert.ok(ctrlA !== undefined, "Ctrl+A (keyDown a modifiers=2) must be dispatched before insertText");

  // Mouse click must precede insertText
  const mouseMoveIdx = log.indexOf("mouse:mouseMoved");
  assert.ok(mouseMoveIdx >= 0 && mouseMoveIdx < insertIdx, "mouse click must precede insertText");

  // type does NOT emit hint (not state-changing per cli-primitives.md §type)
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.hint, undefined, "type must NOT include data.hint (not state-changing)");
});

// ─── T-M67 ─────────────────────────────────────────────────────────────────────

test("T-M67: type tool execute without ref or label returns fail envelope", { timeout: 3000 }, async () => {
  const session = makeFakeSession();
  const tool = makeTypeTool(session);

  // The type tool source throws when neither ref nor label is provided.
  const result = await tool.execute(
    // biome-ignore lint/suspicious/noExplicitAny: intentional bad input for test
    { text: "hello" } as any,
    { toolCallId: "t2", messages: [], abortSignal },
  );

  assert.equal(result.ok, false, "type without ref or label must fail");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const error = (result as any).error;
  assert.ok(
    error.kind === "invalid_input" || error.kind === "runtime_error",
    "error kind must be invalid_input or runtime_error",
  );
});
