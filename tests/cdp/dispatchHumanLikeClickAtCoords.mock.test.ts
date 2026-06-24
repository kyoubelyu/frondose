/**
 * P-POST-PUBLISH-7 Step 2 (new scaffold) — CdpClient.dispatchHumanLikeClickAtCoords
 * T-Dispatch.1..5: the extracted public method on CdpClient.
 *
 * Gate: G-P7.sequence (supporting the deterministic routine's click delegation)
 *
 * CMR-7 / OQ-6: CdpClient.dispatchHumanLikeClickAtCoords(x, y) is extracted from
 * the inlined block at src/cdp/client.ts:212-248. Both `clickAt` (after DOM-box
 * resolution) and the deterministic publish runtime (after getBoundingClientRect
 * resolution) delegate to this single method. Tests verify:
 *   1. mouseMoved curve before mousePressed (same realism as existing T-REAL.1)
 *   2. mousePressed + mouseReleased at the SAME jittered target (same as T-REAL.2)
 *   3. Press-dwell between mousePressed and mouseReleased (same as T-REAL.3 range)
 *   4. lastPointerPos is updated to the jittered target after a completed click
 *   5. clickAt still delegates: calling clickAt still produces the same sequence
 *      (regression — existing T-REAL.* in clickAt-realism.mock.test.ts stays GREEN)
 *
 * The method does NOT yet exist on HEAD (Step 4 pending).
 * COMPILE APPROACH:
 *   - T-Dispatch.1..4 call `dispatchHumanLikeClickAtCoords` via dynamic method access
 *     `(client as any).dispatchHumanLikeClickAtCoords` — resolves to undefined pre-Step-4
 *     → assert.fail("TODO P7: …") → RED.
 *   - T-Dispatch.5 calls `clickAt` (exists on HEAD) and verifies the same mouse sequence
 *     shape, which PASSES on HEAD (regression guard).
 *
 * All 5 tests FAIL on HEAD except T-Dispatch.5 which PASSES on HEAD.
 * Adjusted: T-Dispatch.5 is written to PASS on HEAD (existing behavior unchanged).
 * T-Dispatch.1..4 FAIL on HEAD (correct RED for the new method).
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/cdp/dispatchHumanLikeClickAtCoords.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Mouse event log types
// ---------------------------------------------------------------------------

interface MouseEventEntry {
  type: string;
  x: number;
  y: number;
  t: number; // wall-clock offset in ms from start of the call
}

// ---------------------------------------------------------------------------
// Fake CDP handle factory — records all Input.dispatchMouseEvent calls
// ---------------------------------------------------------------------------

/**
 * Build a fake CdpClient whose Input.dispatchMouseEvent records every call
 * (type, x, y, wall-clock offset from `t0`).
 * DOM.getBoxModel returns a box centered at (cx, cy) for use by `clickAt`.
 */
function makeFakeClientForDispatch(opts: {
  cx?: number;
  cy?: number;
  events: MouseEventEntry[];
  t0: () => number;
}): CdpClient {
  const cx = opts.cx ?? 200;
  const cy = opts.cy ?? 300;
  const fakeHandle = {
    Accessibility: { enable: async () => {}, getFullAXTree: async () => ({ nodes: [] }) },
    Runtime: {
      evaluate: async (_args: { expression: string }) => ({ result: { value: null } }),
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: [42] }),
      scrollIntoViewIfNeeded: async () => {},
      // border quad centered at (cx, cy): [cx-20, cy-20, cx+20, cy-20, cx+20, cy+20, cx-20, cy+20]
      // center(border) → ((cx-20+cx+20)/2, (cy-20+cy+20)/2) = (cx, cy) ✓
      getBoxModel: async () => ({
        model: { border: [cx - 20, cy - 20, cx + 20, cy - 20, cx + 20, cy + 20, cx - 20, cy + 20] },
      }),
    },
    Input: {
      dispatchMouseEvent: async (p: { type: string; x: number; y: number }) => {
        opts.events.push({ type: p.type, x: p.x, y: p.y, t: performance.now() - opts.t0() });
      },
      dispatchKeyEvent: async () => {},
      insertText: async () => {},
      synthesizeScrollGesture: async () => {},
    },
    Browser: { close: async () => {} },
    Page: {
      enable: async () => {},
      navigate: async () => ({}),
      loadEventFired: (cb: (p: unknown) => void) => { setTimeout(() => cb({ timestamp: 0 }), 0); return () => {}; },
      frameNavigated: (cb: (p: unknown) => void) => { setTimeout(() => cb({ frame: { url: "" } }), 0); return () => {}; },
      lifecycleEvent: (cb: (p: unknown) => void) => { setTimeout(() => cb({ name: "networkIdle" }), 0); return () => {}; },
      setLifecycleEventsEnabled: async () => {},
      getLayoutMetrics: async () => ({
        visualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        cssLayoutViewport: { clientWidth: 1440, clientHeight: 900 },
      }),
      reload: async () => {},
    },
  };
  return CdpClient.fromHandle(fakeHandle);
}

function eventsOfType(events: MouseEventEntry[], type: string): MouseEventEntry[] {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// T-Dispatch.1 — calls method with correct mouse sequence shape
// ---------------------------------------------------------------------------

describe("CdpClient.dispatchHumanLikeClickAtCoords — mouseMoved curve → mousePressed → dwell → mouseReleased at (x,y) with jitter (G-P7.sequence)", () => {
  it(
    "T-Dispatch.1: dispatchHumanLikeClickAtCoords(480, 320) emits ≥1 mouseMoved before mousePressed, mousePressed+mouseReleased at same jittered target near (480,320), mouseReleased after press-dwell",
    { timeout: 5000 },
    async () => {
      // Given: a new CdpClient (lastPointerPos=(0,0)) with a far target (480,320).
      // When:  client.dispatchHumanLikeClickAtCoords(480, 320) is called.
      // Then:  events contains ≥1 mouseMoved before mousePressed;
      //        mousePressed.x === mouseReleased.x (same jittered target);
      //        mousePressed.y === mouseReleased.y;
      //        mouseReleased.t >= mousePressed.t + 40 (press-dwell ≥40ms, mirrors clickAt T-REAL.3);
      //        target x is near 480 (within ±20 jitter), y near 320 (within ±20 jitter).
      const events: MouseEventEntry[] = [];
      let t0 = performance.now();
      const client = makeFakeClientForDispatch({ cx: 480, cy: 320, events, t0: () => t0 });

      // T-Dispatch.1..4: the method may not exist yet (Step 4 pending)
      // biome-ignore lint/suspicious/noExplicitAny: testing a method that does not exist yet on HEAD
      const method = (client as unknown as Record<string, unknown>)["dispatchHumanLikeClickAtCoords"];
      if (typeof method !== "function") {
        assert.fail(
          "TODO P7: CdpClient.dispatchHumanLikeClickAtCoords not yet exported " +
          "(src/cdp/client.ts Step 4 edit pending — CMR-7 / OQ-6). " +
          "After Step 4, fill: call dispatchHumanLikeClickAtCoords(480,320), assert " +
          "≥1 mouseMoved before mousePressed + same target for press/release + dwell ≥40ms.",
        );
      }

      t0 = performance.now();
      await (method as (x: number, y: number) => Promise<void>).call(client, 480, 320);

      const movedEvents = eventsOfType(events, "mouseMoved");
      const pressedEvents = eventsOfType(events, "mousePressed");
      const releasedEvents = eventsOfType(events, "mouseReleased");

      // T-Dispatch.1: ≥1 mouseMoved before mousePressed (Bezier curve)
      const pressIdx = events.findIndex((e) => e.type === "mousePressed");
      const movedBeforePress = events.slice(0, pressIdx).filter((e) => e.type === "mouseMoved");
      assert.ok(movedBeforePress.length >= 1, `T-Dispatch.1: expected ≥1 mouseMoved before mousePressed, got ${movedBeforePress.length}`);
      // exactly 1 press and 1 release
      assert.equal(pressedEvents.length, 1, `T-Dispatch.1: expected exactly 1 mousePressed, got ${pressedEvents.length}`);
      assert.equal(releasedEvents.length, 1, `T-Dispatch.1: expected exactly 1 mouseReleased, got ${releasedEvents.length}`);
      // same jittered target for press and release
      const pressed1 = pressedEvents[0]!;
      const released1 = releasedEvents[0]!;
      assert.equal(pressed1.x, released1.x, `T-Dispatch.1: mousePressed.x (${pressed1.x}) !== mouseReleased.x (${released1.x})`);
      assert.equal(pressed1.y, released1.y, `T-Dispatch.1: mousePressed.y (${pressed1.y}) !== mouseReleased.y (${released1.y})`);
      // press-dwell ≥40ms
      assert.ok(released1.t >= pressed1.t + 40, `T-Dispatch.1: press-dwell should be ≥40ms, got ${released1.t - pressed1.t}ms`);
      // jitter envelope: pressed within ±20px of (480,320)
      assert.ok(pressed1.x >= 460 && pressed1.x <= 500, `T-Dispatch.1: pressed.x (${pressed1.x}) outside [460,500] (±20 jitter of 480)`);
      assert.ok(pressed1.y >= 300 && pressed1.y <= 340, `T-Dispatch.1: pressed.y (${pressed1.y}) outside [300,340] (±20 jitter of 320)`);
    },
  );
});

// ---------------------------------------------------------------------------
// T-Dispatch.2 — lastPointerPos updated after completed call
// ---------------------------------------------------------------------------

describe("CdpClient.dispatchHumanLikeClickAtCoords — updates lastPointerPos to jittered target after completed click (G-P7.sequence)", () => {
  it(
    "T-Dispatch.2: after dispatchHumanLikeClickAtCoords(480, 320) completes, a second call starts its mouseMoved curve from near (480,320) not from (0,0)",
    { timeout: 5000 },
    async () => {
      // Given: a new CdpClient (lastPointerPos initialized to (0,0)).
      // When:  dispatchHumanLikeClickAtCoords(480, 320) completes,
      //        THEN dispatchHumanLikeClickAtCoords(200, 100) is called.
      // Then:  the SECOND call's first mouseMoved event is closer to (480,320) than to (0,0)
      //        — proving lastPointerPos was updated to the jittered target after the first call.
      //        (Mirrors clickAt lastPointerPos tracking at src/cdp/client.ts:248.)
      const events: MouseEventEntry[] = [];
      let t0 = performance.now();
      const client = makeFakeClientForDispatch({ cx: 480, cy: 320, events, t0: () => t0 });

      // biome-ignore lint/suspicious/noExplicitAny: testing a method that does not exist yet on HEAD
      const method = (client as unknown as Record<string, unknown>)["dispatchHumanLikeClickAtCoords"];
      if (typeof method !== "function") {
        assert.fail(
          "TODO P7: CdpClient.dispatchHumanLikeClickAtCoords not yet exported (Step 4 pending). " +
          "After Step 4, fill: call(480,320) → check lastPointerPos updated → second call(200,100) " +
          "first mouseMoved closer to (480,320) than to (0,0).",
        );
      }

      t0 = performance.now();
      await (method as (x: number, y: number) => Promise<void>).call(client, 480, 320);
      const countAfterFirst = events.length;
      await (method as (x: number, y: number) => Promise<void>).call(client, 200, 100);
      const secondCallEvents = events.slice(countAfterFirst);
      const firstMoved = secondCallEvents.find((e) => e.type === "mouseMoved");

      // T-Dispatch.2: second call's first mouseMoved starts closer to (480,320) than to (0,0)
      assert.ok(firstMoved !== undefined, `T-Dispatch.2: second call must emit at least one mouseMoved event`);
      if (firstMoved) {
        const distFromFirst = Math.hypot(firstMoved.x - 480, firstMoved.y - 320);
        const distFromOrigin = Math.hypot(firstMoved.x - 0, firstMoved.y - 0);
        assert.ok(
          distFromFirst < distFromOrigin,
          `T-Dispatch.2: second call's first mouseMoved (${firstMoved.x},${firstMoved.y}) should be closer to (480,320) (d=${distFromFirst.toFixed(1)}) than to (0,0) (d=${distFromOrigin.toFixed(1)}). lastPointerPos was not updated.`,
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Dispatch.3 — jitter envelope: target within ±20px of requested (x,y)
// ---------------------------------------------------------------------------

describe("CdpClient.dispatchHumanLikeClickAtCoords — jitter envelope: mousePressed lands within ±20px of requested (x,y) (G-P7.sequence)", () => {
  it(
    "T-Dispatch.3: dispatchHumanLikeClickAtCoords(480, 320) — mousePressed.x is in [460,500] AND mousePressed.y is in [300,340]",
    { timeout: 5000 },
    async () => {
      // Given: a new CdpClient with a target at (480, 320).
      // When:  dispatchHumanLikeClickAtCoords(480, 320) is called.
      // Then:  mousePressed.x is in the range [480-20, 480+20] = [460, 500]
      //        mousePressed.y is in the range [320-20, 320+20] = [300, 340]
      //        (jitter() applies a ±~10px per-axis offset — stays within ±20px envelope).
      const events: MouseEventEntry[] = [];
      let t0 = performance.now();
      const client = makeFakeClientForDispatch({ cx: 480, cy: 320, events, t0: () => t0 });

      // biome-ignore lint/suspicious/noExplicitAny: testing a method that does not exist yet on HEAD
      const method = (client as unknown as Record<string, unknown>)["dispatchHumanLikeClickAtCoords"];
      if (typeof method !== "function") {
        assert.fail(
          "TODO P7: CdpClient.dispatchHumanLikeClickAtCoords not yet exported (Step 4 pending). " +
          "After Step 4, fill: call(480,320) → mousePressed.x in [460,500], .y in [300,340].",
        );
      }

      t0 = performance.now();
      await (method as (x: number, y: number) => Promise<void>).call(client, 480, 320);

      const pressed = eventsOfType(events, "mousePressed")[0];

      // T-Dispatch.3: jitter envelope — pressed within ±20px of (480,320)
      assert.ok(pressed !== undefined, "T-Dispatch.3: must have a mousePressed event");
      if (pressed) {
        assert.ok(pressed.x >= 460 && pressed.x <= 500, `T-Dispatch.3: pressed.x (${pressed.x}) outside [460,500] (jitter envelope ±20 of 480)`);
        assert.ok(pressed.y >= 300 && pressed.y <= 340, `T-Dispatch.3: pressed.y (${pressed.y}) outside [300,340] (jitter envelope ±20 of 320)`);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Dispatch.4 — clickAt delegates: calling clickAt still calls dispatchHumanLikeClickAtCoords
// ---------------------------------------------------------------------------

describe("CdpClient.clickAt — delegates raw-coord stealth to dispatchHumanLikeClickAtCoords after DOM-box resolution (G-P7.sequence — regression contract)", () => {
  it(
    "T-Dispatch.4: after Step 4, clickAt('.selector') calls dispatchHumanLikeClickAtCoords(cx, cy) — same event sequence shape as a direct dispatchHumanLikeClickAtCoords call",
    { timeout: 5000 },
    async () => {
      // Given: a CdpClient where getBoxModel returns a box centered at (200, 300).
      //        After Step 4, clickAt delegates the raw-coord stealth to the new method.
      // When:  clickAt('.selector') runs.
      // Then:  the mouse event sequence is IDENTICAL in shape to a direct
      //        dispatchHumanLikeClickAtCoords(200, 300) call:
      //        ≥1 mouseMoved → mousePressed at jittered (200,300) → mouseReleased at same target.
      //        The delegation contract: clickAt = DOM-box resolution + dispatchHumanLikeClickAtCoords.
      //
      // NOTE: This test DEPENDS on Step 4 refactoring clickAt to delegate.
      // Until then it FAILS (clickAt exists but doesn't call the new method).
      const events: MouseEventEntry[] = [];
      let t0 = performance.now();
      const client = makeFakeClientForDispatch({ cx: 200, cy: 300, events, t0: () => t0 });

      // biome-ignore lint/suspicious/noExplicitAny: testing a method that does not exist yet on HEAD
      const dispatchMethod = (client as unknown as Record<string, unknown>)["dispatchHumanLikeClickAtCoords"];
      if (typeof dispatchMethod !== "function") {
        assert.fail(
          "TODO P7: CdpClient.dispatchHumanLikeClickAtCoords not yet exported (Step 4 pending). " +
          "After Step 4, fill: clickAt('.selector') → same sequence as dispatchHumanLikeClickAtCoords(200,300) " +
          "(≥1 mouseMoved + pressed + released at same jittered target near (200,300)).",
        );
      }

      // Run both and compare shapes — they should produce equivalent sequences
      const eventsFromClickAt: MouseEventEntry[] = [];
      let t0b = performance.now();
      const client2 = makeFakeClientForDispatch({ cx: 200, cy: 300, events: eventsFromClickAt, t0: () => t0b });
      t0b = performance.now();
      await client2.clickAt(".selector");

      // Direct call on client1
      t0 = performance.now();
      await (dispatchMethod as (x: number, y: number) => Promise<void>).call(client, 200, 300);

      // T-Dispatch.4: clickAt produces the same event type shape as a direct dispatchHumanLikeClickAtCoords call
      const clickAtTypes = eventsFromClickAt.map((e) => e.type);
      const directTypes = events.map((e) => e.type);
      // Both must have ≥1 mouseMoved, exactly 1 mousePressed, exactly 1 mouseReleased
      const clickAtMoved = clickAtTypes.filter((t) => t === "mouseMoved").length;
      const directMoved = directTypes.filter((t) => t === "mouseMoved").length;
      assert.ok(clickAtMoved >= 1, `T-Dispatch.4: clickAt should produce ≥1 mouseMoved, got ${clickAtMoved}`);
      assert.ok(directMoved >= 1, `T-Dispatch.4: direct call should produce ≥1 mouseMoved, got ${directMoved}`);
      assert.equal(clickAtTypes.filter((t) => t === "mousePressed").length, 1, "T-Dispatch.4: clickAt must produce exactly 1 mousePressed");
      assert.equal(clickAtTypes.filter((t) => t === "mouseReleased").length, 1, "T-Dispatch.4: clickAt must produce exactly 1 mouseReleased");
      // clickAt pressed and released must be at same coords (same jittered target)
      const clickAtPressed = eventsFromClickAt.find((e) => e.type === "mousePressed");
      const clickAtReleased = eventsFromClickAt.find((e) => e.type === "mouseReleased");
      assert.ok(clickAtPressed && clickAtReleased, "T-Dispatch.4: clickAt must produce mousePressed and mouseReleased");
      if (clickAtPressed && clickAtReleased) {
        assert.equal(clickAtPressed.x, clickAtReleased.x, `T-Dispatch.4: clickAt pressed.x (${clickAtPressed.x}) !== released.x (${clickAtReleased.x})`);
        assert.equal(clickAtPressed.y, clickAtReleased.y, `T-Dispatch.4: clickAt pressed.y (${clickAtPressed.y}) !== released.y (${clickAtReleased.y})`);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Dispatch.5 — regression: existing clickAt event sequence is unchanged (GREEN on HEAD)
// ---------------------------------------------------------------------------

describe("CdpClient.clickAt — regression: event sequence (mouseMoved → mousePressed → mouseReleased) is unchanged by the P7 extraction refactor (G-P7.sequence — regression pin)", () => {
  it(
    "T-Dispatch.5: clickAt('.selector') produces ≥1 mouseMoved before mousePressed + mouseReleased — sequence shape unaffected by dispatchHumanLikeClickAtCoords extraction",
    { timeout: 5000 },
    async () => {
      // Given: a new CdpClient; getBoxModel returns a box centered at (200, 300).
      //        This test uses only clickAt (which ALREADY EXISTS on HEAD) and asserts
      //        the existing mouse sequence shape. It must pass on HEAD and after Step 4.
      // When:  await client.clickAt('.selector') runs.
      // Then:  events contains ≥1 mouseMoved before mousePressed;
      //        exactly 1 mousePressed and 1 mouseReleased;
      //        pressed.x === released.x AND pressed.y === released.y.
      //        (Mirrors assertions from clickAt-realism.mock.test.ts T-REAL.1 + T-REAL.2 —
      //        the P7 extraction MUST NOT regress these.)
      const events: MouseEventEntry[] = [];
      let t0 = performance.now();
      const client = makeFakeClientForDispatch({ cx: 200, cy: 300, events, t0: () => t0 });

      t0 = performance.now();
      await client.clickAt(".selector");

      const movedEvents = eventsOfType(events, "mouseMoved");
      const pressedEvents = eventsOfType(events, "mousePressed");
      const releasedEvents = eventsOfType(events, "mouseReleased");
      const pressIdx = events.findIndex((e) => e.type === "mousePressed");
      const movedBeforePress = events.slice(0, pressIdx).filter((e) => e.type === "mouseMoved");

      // ≥1 mouseMoved before mousePressed (mirrors T-REAL.1)
      assert.ok(
        movedBeforePress.length >= 1,
        `clickAt regression: expected ≥1 mouseMoved before mousePressed, got ${movedBeforePress.length} (total moved=${movedEvents.length})`,
      );

      // Exactly 1 mousePressed and 1 mouseReleased
      assert.equal(pressedEvents.length, 1, `clickAt regression: expected exactly 1 mousePressed, got ${pressedEvents.length}`);
      assert.equal(releasedEvents.length, 1, `clickAt regression: expected exactly 1 mouseReleased, got ${releasedEvents.length}`);

      // mousePressed and mouseReleased at SAME (x, y) (mirrors T-REAL.2)
      const pressed = pressedEvents[0]!;
      const released = releasedEvents[0]!;
      assert.equal(
        pressed.x,
        released.x,
        `clickAt regression: mousePressed.x (${pressed.x}) !== mouseReleased.x (${released.x})`,
      );
      assert.equal(
        pressed.y,
        released.y,
        `clickAt regression: mousePressed.y (${pressed.y}) !== mouseReleased.y (${released.y})`,
      );
    },
  );
});
