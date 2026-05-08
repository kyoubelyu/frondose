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
    getOrInitClient: () => Promise.resolve(client),
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
