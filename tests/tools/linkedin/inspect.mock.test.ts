/**
 * P-3 mock tests — T-M59..T-M61: inspect tool.
 *
 * Tests makeInspectTool() schema, execute dispatch, and failure path.
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeInspectTool } from "../../../src/tools/linkedin/inspect.js";

const abortSignal = new AbortController().signal;

/** Build a fake session for inspect tests. */
function makeFakeSession(opts: {
  axNodes?: Array<{ nodeId: string; role: string; name: string; backendDOMNodeId: number }>;
  pageUrl?: string;
  failSnapshot?: boolean;
}) {
  let lastCtx: CurrentSurfaceContext | undefined;

  const axNodes = opts.axNodes ?? [
    { nodeId: "ax1", role: "button", name: "Start a post", backendDOMNodeId: 10 },
    { nodeId: "ax2", role: "staticText", name: "Feed post body here", backendDOMNodeId: 11 },
  ];

  const fakeHandle = opts.failSnapshot
    ? {
        Accessibility: {
          enable: async () => {},
          getFullAXTree: async () => {
            throw new Error("CDP snapshot failed: connection reset");
          },
        },
      }
    : {
        Accessibility: {
          enable: async () => {},
          getFullAXTree: async () => ({
            nodes: axNodes.map((n) => ({
              nodeId: n.nodeId,
              role: { type: "role", value: n.role },
              name: { type: "string", value: n.name },
              backendDOMNodeId: n.backendDOMNodeId,
            })),
          }),
        },
        Runtime: {
          evaluate: async (_args: unknown) => ({
            result: { value: opts.pageUrl ?? "https://www.linkedin.com/feed/" },
          }),
        },
        DOM: {
          getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
          querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
        },
      };

  const client = CdpClient.fromHandle(fakeHandle);
  return {
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (ctx: CurrentSurfaceContext) => {
      lastCtx = ctx;
    },
    getLastContext: () => lastCtx,
  };
}

// ─── T-M59 ─────────────────────────────────────────────────────────────────────

test("T-M59: makeInspectTool returns a tool with correct description and optional scope param", () => {
  const session = makeFakeSession({});
  const tool = makeInspectTool(session);

  assert.ok(typeof tool.description === "string", "tool must have a description");
  assert.ok(
    tool.description.toLowerCase().includes("inspect") ||
      tool.description.toLowerCase().includes("snapshot") ||
      tool.description.toLowerCase().includes("surface"),
    "description must describe inspection/snapshot behavior",
  );

  // scope is optional
  const noScope = tool.parameters.safeParse({});
  assert.equal(noScope.success, true, "empty params must be valid (scope is optional)");

  const withScope = tool.parameters.safeParse({ scope: "feed" });
  assert.equal(withScope.success, true, "scope string must be valid");
});

// ─── T-M60 ─────────────────────────────────────────────────────────────────────

test("T-M60: inspect tool execute returns ok envelope with InspectSummary shape", async () => {
  const session = makeFakeSession({
    pageUrl: "https://www.linkedin.com/feed/",
    axNodes: [
      { nodeId: "ax1", role: "button", name: "Start a post", backendDOMNodeId: 10 },
      { nodeId: "ax2", role: "staticText", name: "Post body text here", backendDOMNodeId: 11 },
    ],
  });
  const tool = makeInspectTool(session);

  const result = await tool.execute({}, { toolCallId: "t1", messages: [], abortSignal });

  assert.equal(result.ok, true, "result.ok must be true");
  assert.equal(result.command, "inspect", "command must be 'inspect'");

  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;
  assert.equal(data.surface, "feed", "summary surface must be 'feed'");
  assert.equal(data.activeLayer, "page", "activeLayer must be 'page'");
  assert.ok(Array.isArray(data.buttons), "summary must have buttons array");
  assert.ok(Array.isArray(data.inputs), "summary must have inputs array");
  assert.ok(Array.isArray(data.text), "summary must have text array");
  assert.ok(Array.isArray(data.availableScopes), "summary must have availableScopes array");

  // session.getLastContext() must be populated after inspect
  const ctx = session.getLastContext();
  assert.ok(ctx !== undefined, "setLastContext must have been called during inspect");
  assert.equal(ctx?.surface, "feed");
});

// ─── T-M61 ─────────────────────────────────────────────────────────────────────

// ─── T-Inspect.3 — full flag appends debug fields ──────────────────────────────

test("T-Inspect.3: full flag appends debug diagnostics (totalEntries, entriesByRole, roleDetails) alongside standard summary", async () => {
  // Given: session with AX snapshot returning 5+ entries across multiple roles
  // When:  inspect({ full: true }) is executed
  // Then:  ok=true; data contains InspectSummary fields (surface, buttons, inputs, text, availableScopes)
  //        PLUS totalEntries (number), entriesByRole (Record<string,number>), roleDetails (string[])

  const session = makeFakeSession({
    axNodes: [
      { nodeId: "ax1", role: "button", name: "Start a post", backendDOMNodeId: 10 },
      { nodeId: "ax2", role: "button", name: "Like", backendDOMNodeId: 11 },
      { nodeId: "ax3", role: "staticText", name: "Feed post body", backendDOMNodeId: 12 },
      { nodeId: "ax4", role: "staticText", name: "Read more", backendDOMNodeId: 13 },
      { nodeId: "ax5", role: "textbox", name: "Search", backendDOMNodeId: 14 },
      { nodeId: "ax6", role: "textbox", name: "Comment", backendDOMNodeId: 15 },
    ],
  });
  const tool = makeInspectTool(session);

  const result = await tool.execute({ full: true }, { toolCallId: "ti3", messages: [], abortSignal });

  assert.equal(result.ok, true, "inspect with full flag must succeed");
  assert.equal(result.command, "inspect");

  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;

  // Standard InspectSummary fields
  assert.equal(typeof data.surface, "string", "surface must be a string");
  assert.ok(Array.isArray(data.buttons), "buttons must be an array");
  assert.ok(Array.isArray(data.inputs), "inputs must be an array");
  assert.ok(Array.isArray(data.text), "text must be an array");
  assert.ok(Array.isArray(data.availableScopes), "availableScopes must be an array");

  // Debug fields from full flag (field name is roleDetails per implementation, not scopeHints)
  assert.equal(typeof data.totalEntries, "number", "totalEntries must be a number");
  assert.equal(data.totalEntries, 6, "totalEntries must equal ctx.entries.length");
  assert.equal(typeof data.entriesByRole, "object", "entriesByRole must be a Record<string,number>");
  assert.equal(data.entriesByRole.button, 2, "entriesByRole must count 2 buttons");
  assert.equal(data.entriesByRole.staticText, 2, "entriesByRole must count 2 staticText");
  assert.equal(data.entriesByRole.textbox, 2, "entriesByRole must count 2 textboxes");
  assert.ok(Array.isArray(data.roleDetails), "roleDetails must be an array of role names");
  assert.ok(data.roleDetails.includes("button"), "roleDetails must include 'button'");
  assert.ok(data.roleDetails.includes("staticText"), "roleDetails must include 'staticText'");
  assert.ok(data.roleDetails.includes("textbox"), "roleDetails must include 'textbox'");
});

// ─── T-Inspect.4 — full flag with scope filter ────────────────────────────────

test("T-Inspect.4: full flag with scope filter returns debug fields alongside standard summary fields", async () => {
  // Given: session with entries across multiple scopes
  // When:  inspect({ scope: "feed", full: true }) is executed
  // Then:  ok=true; debug fields (totalEntries, entriesByRole, roleDetails) present alongside
  //        standard InspectSummary fields; debug fields reflect full ctx.entries (implementation behavior)

  const session = makeFakeSession({
    axNodes: [
      { nodeId: "ax1", role: "button", name: "Start a post", backendDOMNodeId: 10 },
      { nodeId: "ax2", role: "staticText", name: "Feed post body", backendDOMNodeId: 11 },
      { nodeId: "ax3", role: "button", name: "Send", backendDOMNodeId: 12 },
      { nodeId: "ax4", role: "textbox", name: "Message input", backendDOMNodeId: 13 },
    ],
    pageUrl: "https://www.linkedin.com/messaging/thread/",
  });
  const tool = makeInspectTool(session);

  const result = await tool.execute({ scope: "feed", full: true }, { toolCallId: "ti4", messages: [], abortSignal });

  assert.equal(result.ok, true, "inspect with scope + full must succeed");
  assert.equal(result.command, "inspect");

  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const data = (result as any).data;

  // Debug fields present regardless of scope filter
  assert.equal(typeof data.totalEntries, "number", "totalEntries must be a number (debug field)");
  assert.equal(typeof data.entriesByRole, "object", "entriesByRole must be present (debug field)");
  assert.ok(Array.isArray(data.roleDetails), "roleDetails must be an array (debug field)");

  // Standard InspectSummary fields present
  assert.equal(typeof data.surface, "string", "surface must be present");
  assert.ok(Array.isArray(data.buttons), "buttons must be present");
  assert.ok(Array.isArray(data.inputs), "inputs must be present");
  assert.ok(Array.isArray(data.text), "text must be present");
  assert.ok(Array.isArray(data.availableScopes), "availableScopes must be present");
});

test("T-M61: inspect tool execute returns fail envelope when CDP snapshot throws", async () => {
  const session = makeFakeSession({ failSnapshot: true });
  const tool = makeInspectTool(session);

  const result = await tool.execute({}, { toolCallId: "t2", messages: [], abortSignal });

  assert.equal(result.ok, false, "result.ok must be false when snapshot fails");
  assert.equal(result.command, "inspect");

  // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
  const error = (result as any).error;
  assert.ok(typeof error.kind === "string", "error.kind must be a string");
  assert.ok(typeof error.message === "string", "error.message must be a string");
  assert.ok(
    error.message.toLowerCase().includes("snapshot") || error.message.toLowerCase().includes("connection"),
    "error message must mention the failure",
  );
});
