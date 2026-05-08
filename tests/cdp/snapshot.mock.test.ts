/**
 * P-2 mock tests — T-M8..T-M11: getSnapshot() against a fake CDP client.
 *
 * Tests run with no Chrome required.
 * Provides hand-built AXNode arrays to exercise the snapshot ref assignment logic.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { getSnapshot } from "../../src/cdp/snapshot.js";

/** Minimal AXNode shape matching snapshot.ts's internal interface. */
interface FakeAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  backendDOMNodeId?: number;
}

/** Build a fake CDP client that returns the given AXNode array. */
function makeFakeClient(nodes: FakeAXNode[]) {
  return {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({ nodes }),
    },
  };
}

// ─── T-M8 ─────────────────────────────────────────────────────────────────────

test("T-M8: refs are sequentially numbered e1, e2, ... in walk order", async () => {
  const nodes: FakeAXNode[] = [
    {
      nodeId: "ax1",
      role: { type: "role", value: "button" },
      name: { type: "string", value: "Submit" },
      backendDOMNodeId: 10,
    },
    {
      nodeId: "ax2",
      role: { type: "role", value: "link" },
      name: { type: "string", value: "Home" },
      backendDOMNodeId: 20,
    },
    { nodeId: "ax3", role: { type: "role", value: "textbox" }, backendDOMNodeId: 30 },
  ];

  const client = makeFakeClient(nodes);
  const snap = await getSnapshot(client);

  // Tree must contain all three refs in order
  assert.ok(snap.tree.includes("[ref=@e1]"), "tree must include [ref=@e1]");
  assert.ok(snap.tree.includes("[ref=@e2]"), "tree must include [ref=@e2]");
  assert.ok(snap.tree.includes("[ref=@e3]"), "tree must include [ref=@e3]");

  // Refs map must have exactly e1, e2, e3
  assert.deepEqual(Object.keys(snap.refs).sort(), ["e1", "e2", "e3"]);

  // Walk order: e1 is the first node, e2 is the second
  assert.equal(snap.refs.e1?.axNodeId, "ax1", "e1 must map to first node");
  assert.equal(snap.refs.e2?.axNodeId, "ax2", "e2 must map to second node");
  assert.equal(snap.refs.e3?.axNodeId, "ax3", "e3 must map to third node");
});

// ─── T-M9 ─────────────────────────────────────────────────────────────────────

test("T-M9: ignored:true nodes are skipped and do not consume a ref number", async () => {
  const nodes: FakeAXNode[] = [
    { nodeId: "ax1", role: { type: "role", value: "button" }, backendDOMNodeId: 10 },
    // node 2: ignored — should be skipped and NOT consume e2
    { nodeId: "ax2", ignored: true, role: { type: "role", value: "generic" }, backendDOMNodeId: 20 },
    { nodeId: "ax3", role: { type: "role", value: "link" }, backendDOMNodeId: 30 },
  ];

  const client = makeFakeClient(nodes);
  const snap = await getSnapshot(client);

  // Only 2 refs: e1 (ax1) and e2 (ax3 — ax2 is ignored so counter not incremented)
  assert.deepEqual(Object.keys(snap.refs).sort(), ["e1", "e2"]);
  assert.equal(snap.refs.e1?.axNodeId, "ax1");
  assert.equal(snap.refs.e2?.axNodeId, "ax3", "e2 must point at ax3, not the ignored ax2");
});

// ─── T-M10 ─────────────────────────────────────────────────────────────────────

test("T-M10: nodes without a role are skipped", async () => {
  const nodes: FakeAXNode[] = [
    { nodeId: "ax1", role: { type: "role", value: "button" }, backendDOMNodeId: 10 },
    // node 2: no role field — must be skipped
    { nodeId: "ax2", backendDOMNodeId: 20 },
    { nodeId: "ax3", role: { type: "role", value: "link" }, backendDOMNodeId: 30 },
  ];

  const client = makeFakeClient(nodes);
  const snap = await getSnapshot(client);

  assert.deepEqual(Object.keys(snap.refs).sort(), ["e1", "e2"]);
  assert.equal(snap.refs.e1?.axNodeId, "ax1");
  assert.equal(snap.refs.e2?.axNodeId, "ax3", "e2 must skip the no-role node");
});

// ─── T-M11 ─────────────────────────────────────────────────────────────────────

test("T-M11: RefMap[ref].backendNodeId matches the input node's backendDOMNodeId", async () => {
  const expectedBackendNodeId = 42;
  const nodes: FakeAXNode[] = [
    {
      nodeId: "ax1",
      role: { type: "role", value: "button" },
      name: { type: "string", value: "Save" },
      backendDOMNodeId: expectedBackendNodeId,
    },
  ];

  const client = makeFakeClient(nodes);
  const snap = await getSnapshot(client);

  assert.equal(
    snap.refs.e1?.backendNodeId,
    expectedBackendNodeId,
    "backendNodeId must match backendDOMNodeId from input",
  );
  assert.equal(snap.refs.e1?.axNodeId, "ax1");
  assert.equal(snap.refs.e1?.role, "button");
  assert.equal(snap.refs.e1?.name, "Save");
});
