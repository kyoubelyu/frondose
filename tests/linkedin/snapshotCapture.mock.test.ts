/**
 * P-3 mock tests — T-M38..T-M40: LinkedIn snapshot capture.
 *
 * Tests captureCurrentSurfaceContext() using a fake CdpClient built via
 * CdpClient.fromHandle(). No real Chrome required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { captureCurrentSurfaceContext } from "../../src/linkedin/snapshotCapture.js";

/** Build a minimal fake CdpHandle for snapshot capture. */
function makeFakeHandle(opts: {
  axNodes: Array<{
    nodeId: string;
    role: string;
    name: string;
    backendDOMNodeId: number;
    ignored?: boolean;
  }>;
  pageUrl: string;
  messagingNodeIds?: number[];
  messagingAttrs?: Record<number, string[]>; // nodeId → interleaved attr array
}) {
  return {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: opts.axNodes.map((n) => ({
          nodeId: n.nodeId,
          role: n.ignored ? undefined : { type: "role", value: n.role },
          name: { type: "string", value: n.name },
          backendDOMNodeId: n.backendDOMNodeId,
          ignored: n.ignored ?? false,
        })),
      }),
    },
    Runtime: {
      evaluate: async (_args: unknown) => ({
        result: { value: opts.pageUrl },
      }),
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({
        nodeIds: opts.messagingNodeIds ?? [],
      }),
      getAttributes: async (args: { nodeId: number }) => {
        const attrs = opts.messagingAttrs?.[args.nodeId] ?? [];
        return { attributes: attrs };
      },
    },
  };
}

// ─── T-M38 ─────────────────────────────────────────────────────────────────────

test("T-M38: captureCurrentSurfaceContext on feed URL returns correct surface + entries", async () => {
  const fakeHandle = makeFakeHandle({
    axNodes: [
      { nodeId: "ax1", role: "button", name: "Start a post", backendDOMNodeId: 10 },
      { nodeId: "ax2", role: "link", name: "Home", backendDOMNodeId: 11 },
      { nodeId: "ax3", role: "staticText", name: "Top post content here", backendDOMNodeId: 12 },
    ],
    pageUrl: "https://www.linkedin.com/feed/",
  });

  const client = CdpClient.fromHandle(fakeHandle);
  const ctx = await captureCurrentSurfaceContext(client);

  assert.equal(ctx.surface, "feed", "surface must be 'feed' for /feed/ URL");
  assert.equal(ctx.activeLayer, "page", "activeLayer must always be 'page' in P-3");
  assert.equal(ctx.pageUrl, "https://www.linkedin.com/feed/");
  assert.equal(ctx.entries.length, 3, "must have 3 entries from AX nodes");

  // Entries must have correct refs and roles
  const refs = ctx.entries.map((e) => e.ref);
  assert.ok(refs.includes("@e1"), "must include @e1");
  assert.ok(refs.includes("@e2"), "must include @e2");
  assert.ok(refs.includes("@e3"), "must include @e3");

  const e1 = ctx.entries.find((e) => e.ref === "@e1");
  assert.equal(e1?.role, "button");
  assert.equal(e1?.name, "Start a post");
});

// ─── T-M39 ─────────────────────────────────────────────────────────────────────

test("T-M39: captureCurrentSurfaceContext on messaging URL synthesizes @mr* entries", async () => {
  const fakeHandle = makeFakeHandle({
    axNodes: [{ nodeId: "ax1", role: "button", name: "New message", backendDOMNodeId: 20 }],
    pageUrl: "https://www.linkedin.com/messaging/",
    messagingNodeIds: [101, 102],
    messagingAttrs: {
      101: ["aria-label", "Alice Smith", "class", "msg-conversation-listitem"],
      102: ["class", "msg-conversation-listitem", "aria-label", "Bob Jones"],
    },
  });

  const client = CdpClient.fromHandle(fakeHandle);
  const ctx = await captureCurrentSurfaceContext(client);

  assert.equal(ctx.surface, "messaging");

  // Should have 1 AX entry + 2 synthesized @mr entries
  assert.equal(ctx.entries.length, 3, "must have 1 AX entry + 2 @mr entries");

  const mr1 = ctx.entries.find((e) => e.ref === "@mr1");
  const mr2 = ctx.entries.find((e) => e.ref === "@mr2");

  assert.ok(mr1 !== undefined, "must have @mr1 entry");
  assert.ok(mr2 !== undefined, "must have @mr2 entry");
  assert.equal(mr1?.role, "messagingConversationOpener");
  assert.equal(mr1?.name, "Alice Smith", "@mr1 label must come from aria-label");
  assert.equal(mr2?.name, "Bob Jones", "@mr2 label must come from aria-label");
});

// ─── T-M40 ─────────────────────────────────────────────────────────────────────

test("T-M40: captureCurrentSurfaceContext on non-LinkedIn URL returns 'unknown' surface without messaging synthesis", async () => {
  const fakeHandle = makeFakeHandle({
    axNodes: [{ nodeId: "ax1", role: "heading", name: "Welcome", backendDOMNodeId: 30 }],
    pageUrl: "https://google.com/",
    // messagingNodeIds not provided — should not be queried
  });

  const client = CdpClient.fromHandle(fakeHandle);
  const ctx = await captureCurrentSurfaceContext(client);

  assert.equal(ctx.surface, "unknown", "non-LinkedIn URL must surface 'unknown'");
  assert.equal(ctx.entries.length, 1, "must have exactly 1 AX entry; no @mr synthesis for non-messaging surface");

  // No @mr refs
  const mrRefs = ctx.entries.filter((e) => e.ref.startsWith("@mr"));
  assert.equal(mrRefs.length, 0, "must have no @mr refs for non-messaging surface");
});
