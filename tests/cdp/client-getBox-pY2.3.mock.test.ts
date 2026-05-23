/**
 * P-Y2.3 Step 4a — T-Box.1..3 — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * Coords for the takeover highlight (plan §6.4-A): the pure `borderQuadToBox(border)` + the new
 * `CdpClient.getBox(selectorOrRef)` (reuses the clickAt resolve path: @ref→refMap.backendNodeId, else
 * selector→nodeId → DOM.getBoxModel border quad). 0px-delta to a position:fixed overlay box (F-RG-2).
 *
 * LOAD: LOADS NOW (namespace import — cdp/client.ts exists). `borderQuadToBox` (new named export) + the
 * `getBox` method do NOT exist until builder 4b; a NAMED `import { borderQuadToBox }` would crash the load,
 * so the module is imported as a NAMESPACE — `cdpMod.borderQuadToBox` / `client.getBox` are undefined until 4b
 * and every body is `assert.fail("TODO Step 5: …")`.
 *
 * Gate coverage: G-PY2.3.1 (coords — viewport {x,y,w,h} matching the element).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/cdp/client-getBox-pY2.3.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdpMod from "../../src/cdp/client.js";

// A fake CdpHandle whose DOM.* return the canned resolution chain (getDocument→querySelectorAll→getBoxModel).
function fakeHandle(opts: { border?: number[]; nodeIds?: number[] } = {}) {
  const border = opts.border ?? [10, 20, 110, 20, 110, 70, 10, 70];
  return {
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: opts.nodeIds ?? [5] }),
      getBoxModel: async () => ({ model: { border } }),
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake handle for the resolve-path test
  } as any;
}

describe("borderQuadToBox — quad → {x,y,w,h} (G-PY2.3.1)", () => {
  // Given: the pure helper. When: passed [10,20, 110,20, 110,70, 10,70].
  // Then: { x:10, y:20, w:100, h:50 } (x=x0, y=y0, w=x1−x0, h=y2−y0).
  it("T-Box.1: borderQuadToBox([10,20,110,20,110,70,10,70]) → {x:10,y:20,w:100,h:50}", () => {
    assert.equal(typeof cdpMod.borderQuadToBox, "function", "builder 4b must export borderQuadToBox");
    assert.deepEqual(cdpMod.borderQuadToBox([10, 20, 110, 20, 110, 70, 10, 70]), { x: 10, y: 20, w: 100, h: 50 });
    // edge: a different quad
    assert.deepEqual(cdpMod.borderQuadToBox([0, 0, 50, 0, 50, 30, 0, 30]), { x: 0, y: 0, w: 50, h: 30 });
  });
});

describe("CdpClient.getBox — selector path resolves + returns the box (G-PY2.3.1)", () => {
  // Given: CdpClient.fromHandle(fakeHandle) (getDocument→querySelectorAll→getBoxModel canned).
  // When: getBox("button.foo"). Then: {x:10,y:20,w:100,h:50}.
  it("T-Box.2: getBox(selector) resolves getDocument→querySelectorAll→getBoxModel → {x:10,y:20,w:100,h:50}", async () => {
    const c = cdpMod.CdpClient.fromHandle(fakeHandle());
    assert.deepEqual(await c.getBox("button.foo"), { x: 10, y: 20, w: 100, h: 50 });
  });
});

describe("CdpClient.getBox — @ref path + unknown-ref throw (G-PY2.3.1)", () => {
  // Given: a CdpClient with refMap e1→{backendNodeId:42} (set via cast — refMap is private) + getBoxModel→border.
  // When: getBox("@e1") → the box (resolved via backendNodeId). AND getBox("@nope") → throws
  //       "getBox: ref @nope not found in current snapshot".
  it("T-Box.3: getBox('@e1') resolves via refMap.backendNodeId → box; getBox('@nope') throws 'ref @nope not found'", async () => {
    const c = cdpMod.CdpClient.fromHandle(fakeHandle());
    // refMap is private (populated by inspect/snapshot in production) — set it via cast for the unit test.
    (c as unknown as { refMap: Record<string, { backendNodeId: number }> }).refMap = { e1: { backendNodeId: 42 } };
    assert.deepEqual(await c.getBox("@e1"), { x: 10, y: 20, w: 100, h: 50 });
    await assert.rejects(() => c.getBox("@nope"), /getBox: ref @nope not found in current snapshot/);
  });
});
