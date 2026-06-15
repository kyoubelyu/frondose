/**
 * P-AUTO-18 Step 3 scaffolds — T-A18.6..T-A18.8: capture-time region annotation.
 *
 * Tests captureCurrentSurfaceContext() for the [P-AUTO-18] tagAsideClickables seam:
 *   - aside-resident AX entries get region:"aside" in the returned entries[]
 *   - main-resident (non-aside) AX entries get region:undefined
 *   - a failing tagAsideClickables (REGION_TAG_JS evaluate throws) is best-effort:
 *     captureCurrentSurfaceContext completes; entries are materialized; all region===undefined
 *
 * All assertion bodies are assert.fail("TODO Step 5") — intentional red-state per
 * outside-in TDD. Tests compile but fail. Codex Step 4 adds tagAsideClickables() and
 * the region-annotation pass inside captureCurrentSurfaceContext; Step 5 fills assertions.
 *
 * Fake CdpHandle pattern: same approach as snapshotCapture.mock.test.ts
 * (makeOverlayFakeHandle). The handle must respond to:
 *   1. Accessibility.enable() + Accessibility.getFullAXTree({}) → AX nodes
 *   2. Runtime.evaluate:
 *      a. "window.location.href" → pageUrl  (getCurrentUrl)
 *      b. expression containing 'data-mai-rg-aside' → REGION_TAG_JS → return tagCount (number)
 *      c. expression containing 'data-mai-ov' (setAttribute) → OVERLAY_SYNTH_JS → "[]" (no overlays)
 *      d. any other expression → undefined (best-effort cleanup paths)
 *   3. DOM.getDocument({depth:0}) → {root:{nodeId:1}}
 *   4. DOM.querySelectorAll:
 *      a. selector '[data-mai-rg-aside="1"]' → aside-tagged nodeIds
 *      b. any other selector → [] (messaging, overlay, profile synth selectors)
 *   5. DOM.describeNode({nodeId}) → {node:{backendNodeId}} mapping
 *   6. DOM.getAttributes() → {attributes:[]} (messaging synth)
 *
 * NOTE: captureCurrentSurfaceContext currently has NO tagAsideClickables call (pre-Step 4).
 * These scaffolds will compile against the current source but the assertions fail because
 * the production code does not yet annotate region. After Step 4, assertions pass.
 *
 * No Chrome required; no LLM required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { captureCurrentSurfaceContext } from "../../src/linkedin/snapshotCapture.js";

// ─── Fake handle factory ──────────────────────────────────────────────────────

/**
 * Build a fake CdpHandle for region-annotation tests. The handle routes calls by
 * expression content so no tight coupling to the REGION_TAG_JS constant string is needed:
 *   - 'window.location.href' → pageUrl
 *   - contains 'data-mai-rg-aside' → REGION_TAG_JS path → returns tagCount
 *   - contains 'data-mai-ov' + 'setAttribute' → OVERLAY_SYNTH_JS → "[]" (suppress overlays)
 *   - anything else → undefined (best-effort cleanup evals)
 *
 * The DOM side:
 *   - querySelectorAll('[data-mai-rg-aside="1"]') → asideNodeIds
 *   - any other selector → [] (overlay/messaging synths use different selectors)
 *   - describeNode({nodeId}) → nodeToBackend[nodeId] ?? {node:{backendNodeId:undefined}}
 */
function makeRegionFakeHandle(opts: {
  /** AX nodes to return from getFullAXTree. backendDOMNodeId is the AX-tree's backendNodeId. */
  axNodes: Array<{
    nodeId: string;
    role: string;
    name: string;
    backendDOMNodeId: number;
    ignored?: boolean;
  }>;
  pageUrl: string;
  /** nodeIds that DOM.querySelectorAll('[data-mai-rg-aside="1"]') returns (aside-tagged). */
  asideNodeIds: number[];
  /** Maps a DOM nodeId → backendNodeId for DOM.describeNode responses. */
  nodeToBackend: Record<number, number>;
  /** If true, REGION_TAG_JS evaluate throws instead of returning the count. */
  regionEvalThrows?: boolean;
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
      evaluate: async (args: { expression: string }) => {
        if (args.expression === "window.location.href") {
          return { result: { value: opts.pageUrl } };
        }
        // REGION_TAG_JS identified by the 'data-mai-rg-aside' marker it sets on elements
        if (args.expression.includes("data-mai-rg-aside")) {
          if (opts.regionEvalThrows) {
            throw new Error("fake region eval throw (G-A18.8 best-effort path)");
          }
          return { result: { value: opts.asideNodeIds.length } };
        }
        // OVERLAY_SYNTH_JS identified by data-mai-ov setAttribute; return "[]" = no overlays
        if (args.expression.includes("setAttribute('data-mai-ov'")) {
          return { result: { value: "[]" } };
        }
        // Cleanup evals (removeAttribute) and any other expression → no-op
        return { result: { value: undefined } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (args: { nodeId: number; selector: string }) => {
        if (args.selector === '[data-mai-rg-aside="1"]') {
          return { nodeIds: opts.asideNodeIds };
        }
        // All other selectors (messaging synth, profile synth, overlay cleanup) → empty
        return { nodeIds: [] };
      },
      getAttributes: async (_args: unknown) => ({ attributes: [] }),
      describeNode: async (args: { nodeId?: number; backendNodeId?: number }) => {
        const nid = args.nodeId;
        if (typeof nid === "number" && opts.nodeToBackend[nid] !== undefined) {
          return { node: { backendNodeId: opts.nodeToBackend[nid] } };
        }
        return { node: { backendNodeId: undefined } };
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// T-A18.6..T-A18.8 — capture-time region annotation
// Gates: G-A18.6, G-A18.7, G-A18.8
// ═══════════════════════════════════════════════════════════════════════════════

describe("T-A18 — capture-time region annotation (P-AUTO-18)", () => {
  // ─── T-A18.6 ─────────────────────────────────────────────────────────────
  it(
    "T-A18.6: when refMap entry e147 backendNodeId=147 is aside-resident, captureCurrentSurfaceContext returns entries with {ref:'@e1', region:'aside'} (G-A18.6)",
    async () => {
      // Given: fake CdpClient with:
      //   - AX tree has one node (backendDOMNodeId=147) → refMap key 'e1' (counter=1)
      //   - REGION_TAG_JS evaluate returns tag count (no throw)
      //   - querySelectorAll('[data-mai-rg-aside="1"]') returns [DOM nodeId 5]
      //   - describeNode({nodeId:5}) returns {node:{backendNodeId:147}}
      // When:  captureCurrentSurfaceContext(client) runs
      // Then:  entries[] contains an entry with ref==="@e1" AND region==="aside"
      //        (refMap key is counter-based: e1 for the first non-ignored AX node)
      const handle = makeRegionFakeHandle({
        axNodes: [
          { nodeId: "ax1", role: "button", name: "Invite Fernando to connect", backendDOMNodeId: 147 },
        ],
        pageUrl: "https://www.linkedin.com/in/someone/",
        asideNodeIds: [5], // DOM nodeId 5 is the aside-resident element
        nodeToBackend: { 5: 147 }, // DOM nodeId 5 → backendNodeId 147
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      // The AX-tree counter generates key 'e1' for the first non-ignored node.
      const e1 = ctx.entries.find((e) => e.ref === "@e1");
      assert.ok(e1 !== undefined, "entries[] must contain @e1 (first AX node, backendNodeId=147)");
      assert.equal(e1.region, "aside", "@e1 (backendNodeId=147, aside-tagged) must have region='aside'");
    },
  );

  // ─── T-A18.7 ─────────────────────────────────────────────────────────────
  it(
    "T-A18.7: when refMap entry e1 backendNodeId=1 is NOT aside-resident, captureCurrentSurfaceContext returns entries with {ref:'@e1', region:undefined} (G-A18.7)",
    async () => {
      // Given: fake CdpClient with:
      //   - AX tree has one node (backendDOMNodeId=1) → refMap key 'e1'
      //   - REGION_TAG_JS evaluate returns 0 (no aside elements tagged)
      //   - querySelectorAll('[data-mai-rg-aside="1"]') returns [] (nothing aside-tagged)
      // When:  captureCurrentSurfaceContext(client) runs
      // Then:  entries[] contains an entry with ref==="@e1" AND region===undefined
      //        (main-region button must NOT be false-positively tagged as aside)
      const handle = makeRegionFakeHandle({
        axNodes: [{ nodeId: "ax1", role: "button", name: "Connect", backendDOMNodeId: 1 }],
        pageUrl: "https://www.linkedin.com/in/someone/",
        asideNodeIds: [], // no aside-tagged elements
        nodeToBackend: {},
      });
      const client = CdpClient.fromHandle(handle);
      const ctx = await captureCurrentSurfaceContext(client);
      const e1 = ctx.entries.find((e) => e.ref === "@e1");
      assert.ok(e1 !== undefined, "entries[] must contain @e1 (first AX node, backendNodeId=1)");
      assert.equal(e1.region, undefined, "@e1 (non-aside, backendNodeId=1 not in asideIds) must have region===undefined");
    },
  );

  // ─── T-A18.8 ─────────────────────────────────────────────────────────────
  it(
    "T-A18.8: when REGION_TAG_JS evaluate throws, captureCurrentSurfaceContext completes without throwing and every entry has region===undefined (best-effort — G-A18.8)",
    async () => {
      // Given: fake CdpClient with:
      //   - AX tree has one node (backendDOMNodeId=147) → refMap key 'e1'
      //   - REGION_TAG_JS evaluate THROWS (simulates a page-navigation race / JS error)
      // When:  captureCurrentSurfaceContext(client) runs
      // Then:  (a) call completes without throwing
      //        (b) entries[] is non-empty (entries are materialized despite the tag failure)
      //        (c) every AX-derived entry has region===undefined
      //        (best-effort contract: region tag is an enhancement, never a blocker)
      const handle = makeRegionFakeHandle({
        axNodes: [
          { nodeId: "ax1", role: "button", name: "Invite X to connect", backendDOMNodeId: 147 },
        ],
        pageUrl: "https://www.linkedin.com/in/someone/",
        asideNodeIds: [],
        nodeToBackend: {},
        regionEvalThrows: true, // triggers the best-effort catch path in tagAsideClickables
      });
      const client = CdpClient.fromHandle(handle);
      let ctx: Awaited<ReturnType<typeof captureCurrentSurfaceContext>> | undefined;
      let threw = false;
      try {
        ctx = await captureCurrentSurfaceContext(client);
      } catch {
        threw = true;
      }
      // (a) must not throw
      assert.equal(threw, false, "captureCurrentSurfaceContext must NOT throw when tagAsideClickables fails");
      assert.ok(ctx !== undefined, "ctx must be defined (capture succeeded despite tag failure)");
      // (b) entries must be non-empty
      assert.ok(ctx.entries.length > 0, "entries[] must be non-empty even when tagAsideClickables throws");
      // (c) all AX-derived entries must have region===undefined (asideIds returned empty Set)
      const axEntries = ctx.entries.filter((e) => e.ref.startsWith("@e"));
      assert.ok(axEntries.length > 0, "at least one @e* AX entry must be present");
      for (const e of axEntries) {
        assert.equal(
          e.region,
          undefined,
          `entry ${e.ref} must have region===undefined when tagAsideClickables threw; got region=${String(e.region)}`,
        );
      }
    },
  );
});
