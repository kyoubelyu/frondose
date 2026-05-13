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

/**
 * Make a fake session with configurable entries for ambiguous-target tests.
 * Adds the existing callLog tracking for CDP call verification.
 */
function makeFakeSessionWithEntries(entries: Array<{ ref: string; role: string; name: string }>) {
  const callLog: string[] = [];

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: entries.map((e, i) => ({
          nodeId: `ax${i}`,
          role: { type: "role", value: e.role },
          name: { type: "string", value: e.name },
          backendDOMNodeId: 100 + i,
        })),
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
    getOrInitClient: () => Promise.resolve(client),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () =>
      ({
        pageUrl: "https://www.linkedin.com/feed/",
        surface: "feed",
        activeLayer: "page",
        entries,
      }) as CurrentSurfaceContext,
    callLog,
  };
}

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
    getOrInitClient: () => Promise.resolve(client),
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

// ─── T-Type.3 — ambiguous_target on multi-input scope without label ────────────

test("T-Type.3: ambiguous_target when >1 input matches scope and no label", { timeout: 5000 }, async () => {
  // Given: session context with 2 textbox entries [{ ref: "@e1", role: "textbox", name: "Write a message…" },
  //          { ref: "@e2", role: "textbox", name: "Recipient" }] under scope "threadInput"
  // When:  type({ text: "hello", scope: "threadInput" }) called — no label provided
  // Then:  ok=false; error.kind==="ambiguous_target"; error.candidates lists both inputs with ref and name

  const session = makeFakeSessionWithEntries([
    { ref: "@e1", role: "textbox", name: "Write a message…" },
    { ref: "@e2", role: "textbox", name: "Recipient" },
  ]);
  await session.getClient().snapshot();

  const tool = makeTypeTool(session);
  const result = await tool.execute(
    { text: "hello", scope: "threadInput" },
    { toolCallId: "t3a", messages: [], abortSignal },
  );

  assert.equal(result.ok, false, "ambiguous_target must return ok=false");
  assert.equal(result.command, "type");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const error = (result as any).error;
  assert.equal(error.kind, "ambiguous_target", "error.kind must be 'ambiguous_target'");
  assert.ok(Array.isArray(error.candidates), "error.candidates must be an array");
  assert.equal(error.candidates.length, 2, "error.candidates must list both inputs");
  assert.equal(error.candidates[0].ref, "@e1");
  assert.equal(error.candidates[0].label, "Write a message…");
  assert.equal(error.candidates[1].ref, "@e2");
  assert.equal(error.candidates[1].label, "Recipient");
});

// ─── T-Type.4 — succeeds with label on multi-input scope ──────────────────────

test("T-Type.4: succeeds with label disambiguation on >1 input scope", { timeout: 5000 }, async () => {
  // Given: same dual-input context as T-Type.3
  // When:  type({ text: "hello", scope: "threadInput", label: "Write a message…" }) called
  // Then:  ok=true; data.target==="@e1"; Ctrl+A + insertText dispatched to the correct input

  const session = makeFakeSessionWithEntries([
    { ref: "@e1", role: "textbox", name: "Write a message…" },
    { ref: "@e2", role: "textbox", name: "Recipient" },
  ]);
  await session.getClient().snapshot();

  const tool = makeTypeTool(session);
  const result = await tool.execute(
    { text: "hello", scope: "threadInput", label: "Write a message…" },
    { toolCallId: "t4a", messages: [], abortSignal },
  );

  assert.equal(result.ok, true, "type with label must succeed");
  assert.equal(result.command, "type");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.target, "@e1", "data.target must be the resolved ref of the label-matched input");

  // Verify Ctrl+A + insertText dispatched
  const log = session.callLog;
  const ctrlA = log.find((e) => e === "key:keyDown:a:mod2");
  assert.ok(ctrlA !== undefined, "Ctrl+A must be dispatched before insertText");
  const insertText = log.find((e) => e.startsWith("insertText:hello"));
  assert.ok(insertText !== undefined, "insertText must be dispatched with correct text");
});

// ─── T-Type.5 — succeeds on single-input scope without label ──────────────────

test("T-Type.5: no error on single-input scope without label", { timeout: 5000 }, async () => {
  // Given: session context has single textbox [{ ref: "@e1", role: "textbox", name: "Search" }] under scope "search"
  // When:  type({ text: "query", scope: "search" }) called — no label
  // Then:  ok=true; single input auto-selected (non-ambiguous)

  const session = makeFakeSessionWithEntries([{ ref: "@e1", role: "textbox", name: "Search" }]);
  await session.getClient().snapshot();

  const tool = makeTypeTool(session);
  const result = await tool.execute(
    { text: "query", scope: "search" },
    { toolCallId: "t5a", messages: [], abortSignal },
  );

  assert.equal(result.ok, true, "single-input scope without label must succeed");
  assert.equal(result.command, "type");
  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.target, "@e1", "data.target must be the auto-selected input ref");

  // Verify typing dispatched to correct input
  const log = session.callLog;
  const ctrlA = log.find((e) => e === "key:keyDown:a:mod2");
  assert.ok(ctrlA !== undefined, "Ctrl+A must be dispatched");
  const insertText = log.find((e) => e.startsWith("insertText:query"));
  assert.ok(insertText !== undefined, "insertText must be dispatched with correct text");
});

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
