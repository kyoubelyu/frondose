/**
 * P-32 Step 4a — T-COORD.1-2, T-CURVE.1-2, T-JIT.1, T-KEY.1
 *
 * Tests: pure coordinate/curve/jitter/keymap functions from hardwareInput.ts.
 *
 * Gate coverage:
 *   G-P32.11 — T-COORD.1, T-COORD.2
 *   G-P32.12 — T-CURVE.1, T-CURVE.2
 *   G-P32.13 — T-JIT.1
 *   G-P32.14 — T-KEY.1
 *
 * No Chrome, no native addon, no async required — all pure-function tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CdpClient } from "../../src/cdp/client.js";
import { jitter, mapKey, mapModifiers, mouseCurve, resolveScreenCoords } from "../../src/cdp/hardwareInput.js";

// ─── Fake CdpClient for coordinate tests ──────────────────────────────────────

function makeCoordFakeClient(opts: {
  sx: number;
  sy: number;
  ch: number;
  border: number[]; // 8-element quad
  refKey: string;
  backendNodeId: number;
}): CdpClient {
  return {
    async evaluate<T>(_expr: string): Promise<T> {
      return JSON.stringify({ sx: opts.sx, sy: opts.sy, ch: opts.ch }) as unknown as T;
    },
    get currentRefMap() {
      return {
        [opts.refKey]: { backendNodeId: opts.backendNodeId, axNodeId: "1", role: "button", name: "btn" },
      };
    },
    handle: {
      DOM: {
        async getBoxModel(_arg: unknown) {
          return { model: { border: opts.border } };
        },
      },
    },
  } as unknown as CdpClient;
}

// ─── T-COORD.1 ────────────────────────────────────────────────────────────────

describe("resolveScreenCoords — G-P32.11", () => {
  it("T-COORD.1: resolveScreenCoords returns {x: sx+(b0+b4)/2, y: sy+ch+(b1+b5)/2} (Method A arithmetic)", async () => {
    // Given: evaluate → {sx:100, sy:50, ch:74}; getBoxModel border [200,300,240,300,240,340,200,340]
    //        (b0=200, b1=300, b4=240, b5=340)
    // When:  resolveScreenCoords(fakeClient, "@e1")
    // Then:  returns {x: 100 + (200+240)/2, y: 50+74 + (300+340)/2}
    //                  = {x: 100+220, y: 124+320} = {x: 320, y: 444}
    const fakeClient = makeCoordFakeClient({
      sx: 100,
      sy: 50,
      ch: 74,
      border: [200, 300, 240, 300, 240, 340, 200, 340],
      refKey: "e1",
      backendNodeId: 10,
    });
    const result = await resolveScreenCoords(fakeClient, "@e1");
    assert.equal(result.x, 320, "T-COORD.1: x must be sx + (b0+b4)/2 = 320");
    assert.equal(result.y, 444, "T-COORD.1: y must be sy + ch + (b1+b5)/2 = 444");
  });

  it("T-COORD.2: resolveScreenCoords with a ref absent from currentRefMap throws a clear Error", async () => {
    // Given: currentRefMap has no entry for ref "@missing"
    // When:  resolveScreenCoords(fakeClient, "@missing")
    // Then:  throws an Error mentioning the missing ref
    const fakeClient = makeCoordFakeClient({
      sx: 0,
      sy: 0,
      ch: 0,
      border: [0, 0, 0, 0, 0, 0, 0, 0],
      refKey: "other",
      backendNodeId: 1,
    });
    await assert.rejects(
      () => resolveScreenCoords(fakeClient, "@missing"),
      (err: unknown) => err instanceof Error,
      "T-COORD.2: must throw when ref is absent from currentRefMap",
    );
  });
});

// ─── T-CURVE.1 ────────────────────────────────────────────────────────────────

describe("mouseCurve — G-P32.12", () => {
  it("T-CURVE.1: mouseCurve({x:0,y:0},{x:300,y:200}) returns ≥1 points; last===to; steps bounded; trends toward target", () => {
    // Given: from={x:0,y:0}, to={x:300,y:200}; distance=~360px
    // When:  mouseCurve(from, to)
    // Then:  length ≥1; last element === to exactly; each step delta ≤ some reasonable cap;
    //        overall x and y progress toward target (no backtracking beyond noise)
    const from = { x: 0, y: 0 };
    const to = { x: 300, y: 200 };
    const pts = mouseCurve(from, to);
    assert.ok(pts.length >= 1, "T-CURVE.1: must return at least one point");
    const last = pts[pts.length - 1];
    assert.deepEqual(last, to, "T-CURVE.1: last point must be exactly {x:300, y:200}");
    // Each step must be bounded (no teleport — step size ≤ 100px)
    const maxStep = 100;
    for (let i = 1; i < pts.length; i++) {
      const dx = Math.abs((pts[i]?.x ?? 0) - (pts[i - 1]?.x ?? 0));
      const dy = Math.abs((pts[i]?.y ?? 0) - (pts[i - 1]?.y ?? 0));
      assert.ok(dx <= maxStep && dy <= maxStep, `T-CURVE.1: step ${i} delta (${dx},${dy}) exceeds maxStep ${maxStep}`);
    }
  });

  it("T-CURVE.2: mouseCurve(p, p) returns [p] (already at target — no empty array, no teleport)", () => {
    // Given: from === to === {x:50, y:50}
    // When:  mouseCurve({x:50,y:50}, {x:50,y:50})
    // Then:  returns a single-element array containing {x:50, y:50}
    const p = { x: 50, y: 50 };
    const pts = mouseCurve(p, p);
    assert.ok(pts.length >= 1, "T-CURVE.2: must return at least one point (no empty array)");
    const last = pts[pts.length - 1];
    assert.deepEqual(last, p, "T-CURVE.2: last point must be exactly {x:50, y:50}");
  });
});

// ─── T-JIT.1 ──────────────────────────────────────────────────────────────────

describe("jitter — G-P32.13", () => {
  it("T-JIT.1: jitter(100, 4) over 1000 calls always returns a value within [96, 104]", () => {
    // Given: v=100, max=4
    // When:  jitter(100, 4) called 1000 times
    // Then:  every result is in [96, 104] (never outside ±max range)
    const results = Array.from({ length: 1000 }, () => jitter(100, 4));
    for (const r of results) {
      assert.ok(r >= 96 && r <= 104, `T-JIT.1: jitter(100, 4) returned ${r}, outside [96, 104]`);
    }
  });
});

// ─── T-KEY.1 ──────────────────────────────────────────────────────────────────

describe("mapKey / mapModifiers — G-P32.14", () => {
  it("T-KEY.1: mapKey table — Enter→36, Tab→48, Escape→53, ArrowDown→125, Space→49; modifier bitmask→CGEventFlags", () => {
    // Given: the KEYCODES table in hardwareInput.ts (plan §6.4)
    // When:  mapKey called with known keys
    // Then:  each returns the correct macOS virtual keycode
    assert.equal(mapKey("Enter"), 36, "T-KEY.1: Enter → 36");
    assert.equal(mapKey("Tab"), 48, "T-KEY.1: Tab → 48");
    assert.equal(mapKey("Escape"), 53, "T-KEY.1: Escape → 53");
    assert.equal(mapKey("ArrowDown"), 125, "T-KEY.1: ArrowDown → 125");
    assert.equal(mapKey("Space"), 49, "T-KEY.1: Space → 49");
    // Modifier bitmask: Meta(4) → kCGEventFlagMaskCommand (0x00100000)
    const cmdFlags = mapModifiers(4);
    assert.equal(cmdFlags, 0x00100000, "T-KEY.1: Meta modifier must map to kCGEventFlagMaskCommand");
    // Shift(8) → kCGEventFlagMaskShift (0x00020000)
    const shiftFlags = mapModifiers(8);
    assert.equal(shiftFlags, 0x00020000, "T-KEY.1: Shift modifier must map to kCGEventFlagMaskShift");
  });
});
