/**
 * P-AUTO-11 Step 5 — Validation (assertion bodies filled)
 * T-REAL.1..10: clickAt realism (human-shaped cursor path, dwell, jitter, lastPointerPos tracking).
 *
 * Scaffold written at Step 3; assertion bodies filled at Step 5 by validator.
 *
 * Uses CdpClient.fromHandle(fakeHandle) — the test-only factory at client.ts:98 — to inject
 * a hand-rolled fake CDP handle that records every Input.dispatchMouseEvent call
 * (type, x, y) in order with wall-clock timestamps.
 *
 * Math.random stub: used ONLY for G-A11.8 and G-A11.10 (zero/near-distance edge cases)
 * to make jitter deterministic. All other tests assert structural RANGES, not exact values.
 *
 * Gate coverage:
 *   G-A11.1  — T-REAL.1
 *   G-A11.2  — T-REAL.2
 *   G-A11.3  — T-REAL.3
 *   G-A11.4  — T-REAL.4
 *   G-A11.5  — T-REAL.5
 *   G-A11.6  — T-REAL.6  (regression pin — existing hardwareCoords + hardwareInput tests stay GREEN)
 *   G-A11.7  — T-REAL.7  (regression pin — existing hardwareInput tests stay GREEN)
 *   G-A11.8  — T-REAL.8  (zero/near-distance: deterministic via Math.random stub)
 *   G-A11.9  — T-REAL.9  (@ref far-target: same realism as selector path)
 *   G-A11.10 — T-REAL.10 (@ref near-distance: combine G-A11.8 stub + @ref path)
 *
 * No real Chrome required.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";

// ─── Event log types ──────────────────────────────────────────────────────────

/** One recorded mouse event from Input.dispatchMouseEvent. */
interface MouseEventEntry {
  type: string;
  x: number;
  y: number;
  /** Wall-clock offset in ms from the start of the clickAt call (performance.now delta). */
  t: number;
}

/** A captured call to DOM.getBoxModel — records the argument shape. */
interface BoxModelCall {
  backendNodeId?: number;
  nodeId?: number;
}

// ─── Fake handle factory ──────────────────────────────────────────────────────

/**
 * Build a fake CDP handle whose getBoxModel returns boxes by call-count.
 * `boxes` is an array of {cx, cy} centers; the i-th getBoxModel call returns
 * the i-th box (wrapping to the last entry when exhausted).
 *
 * Border quad for center (cx, cy): [cx-20, cy-20, cx+20, cy-20, cx+20, cy+20, cx-20, cy+20]
 *   → (border[0]+border[4])/2 = cx, (border[1]+border[5])/2 = cy. ✓
 *
 * Every Input.dispatchMouseEvent call is logged to `events` (shared reference).
 * DOM.getBoxModel calls are logged to `boxModelCalls`.
 */
function makeFakeHandle(opts: {
  boxes: Array<{ cx: number; cy: number }>;
  events: MouseEventEntry[];
  boxModelCalls?: BoxModelCall[];
  t0: () => number; // returns the epoch from which 't' offsets are measured
}): CdpClient {
  let boxCallIdx = 0;

  const handle = {
    DOM: {
      async getDocument(_: unknown) {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(_: unknown) {
        return { nodeIds: [42] };
      },
      async getBoxModel(arg: BoxModelCall) {
        if (opts.boxModelCalls) opts.boxModelCalls.push({ ...arg });
        const box = opts.boxes[Math.min(boxCallIdx, opts.boxes.length - 1)] ?? { cx: 200, cy: 300 };
        boxCallIdx++;
        const { cx, cy } = box;
        // border quad: [x0,y0, x1,y1, x2,y2, x3,y3] where center = ((x0+x2)/2, (y0+y2)/2)
        return { model: { border: [cx - 20, cy - 20, cx + 20, cy - 20, cx + 20, cy + 20, cx - 20, cy + 20] } };
      },
    },
    Input: {
      async dispatchMouseEvent(p: { type: string; x: number; y: number }) {
        opts.events.push({ type: p.type, x: p.x, y: p.y, t: performance.now() - opts.t0() });
      },
      async insertText(_: unknown) {},
    },
    Page: {
      async enable() {},
      async navigate() {
        return {};
      },
    },
  };

  return CdpClient.fromHandle(handle);
}

// ─── Helper: filter events by type ───────────────────────────────────────────

function eventsOfType(events: MouseEventEntry[], type: string): MouseEventEntry[] {
  return events.filter((e) => e.type === type);
}

/** Return the index of the first event of the given type. -1 if not found. */
function firstIndexOf(events: MouseEventEntry[], type: string): number {
  return events.findIndex((e) => e.type === type);
}

// ─── T-REAL.1 — far target: ≥2 mouseMoved before mousePressed ────────────────

describe("G-A11.1 — clickAt FAR target emits ≥2 mouseMoved before mousePressed", () => {
  it(
    "T-REAL.1: when lastPointerPos=(0,0) and box center=(200,300) [dist≈361], " +
      "clickAt('.foo') → ≥2 mouseMoved before mousePressed; first mouseMoved closer to (0,0) than to target",
    async () => {
      // Given: new CdpClient (lastPointerPos initialized to (0,0)); getBoxModel returns center (200,300); dist≈361 → 12 curve steps
      // When:  await cli.clickAt('.foo')
      // Then:  events contains ≥2 'mouseMoved' entries before the first 'mousePressed';
      //        first mouseMoved is closer to (0,0) than to (200,300) (path started from prior pos)

      const events: MouseEventEntry[] = [];
      let t0 = performance.now();
      const cli = makeFakeHandle({ boxes: [{ cx: 200, cy: 300 }], events, t0: () => t0 });
      t0 = performance.now();
      await cli.clickAt(".foo");

      const movedEvents = eventsOfType(events, "mouseMoved");
      const pressIdx = firstIndexOf(events, "mousePressed");

      // ≥2 mouseMoved before mousePressed
      assert.ok(
        movedEvents.length >= 2,
        `expected ≥2 mouseMoved before press, got ${movedEvents.length} total (press at idx ${pressIdx})`,
      );

      // All mouseMoved events precede the first mousePressed
      const movedBeforePress = events.slice(0, pressIdx).filter((e) => e.type === "mouseMoved");
      assert.ok(
        movedBeforePress.length >= 2,
        `expected ≥2 mouseMoved before mousePressed at idx ${pressIdx}, got ${movedBeforePress.length}`,
      );

      // First mouseMoved is closer to (0,0) than to (200,300) — path starts from lastPointerPos
      const first = movedBeforePress[0]!;
      const distToOrigin = Math.hypot(first.x - 0, first.y - 0);
      const distToTarget = Math.hypot(first.x - 200, first.y - 300);
      assert.ok(
        distToOrigin < distToTarget,
        `first mouseMoved (${first.x},${first.y}) should be closer to (0,0) [dist=${distToOrigin.toFixed(1)}] than to (200,300) [dist=${distToTarget.toFixed(1)}]`,
      );
    },
  );
});

// ─── T-REAL.2 — mousePressed and mouseReleased at SAME (x, y) ────────────────

describe("G-A11.2 — mousePressed and mouseReleased share identical (x, y)", () => {
  it(
    "T-REAL.2: when clickAt('.foo') resolves, the mousePressed and mouseReleased events " +
      "have identical x and y (dwell is time-based, not position drift)",
    async () => {
      // Given: new CdpClient; getBoxModel returns center (200,300)
      // When:  await cli.clickAt('.foo')
      // Then:  mousePressed.x === mouseReleased.x AND mousePressed.y === mouseReleased.y

      const events: MouseEventEntry[] = [];
      let t0 = performance.now();
      const cli = makeFakeHandle({ boxes: [{ cx: 200, cy: 300 }], events, t0: () => t0 });
      t0 = performance.now();
      await cli.clickAt(".foo");

      const pressed = eventsOfType(events, "mousePressed");
      const released = eventsOfType(events, "mouseReleased");

      assert.equal(pressed.length, 1, "must have exactly one mousePressed");
      assert.equal(released.length, 1, "must have exactly one mouseReleased");

      assert.equal(
        pressed[0]!.x,
        released[0]!.x,
        `mousePressed.x (${pressed[0]!.x}) must equal mouseReleased.x (${released[0]!.x})`,
      );
      assert.equal(
        pressed[0]!.y,
        released[0]!.y,
        `mousePressed.y (${pressed[0]!.y}) must equal mouseReleased.y (${released[0]!.y})`,
      );
    },
  );
});

// ─── T-REAL.3 — measurable dwell ≥40 ms between mousePressed and mouseReleased ─

describe("G-A11.3 — dwell ≥40 ms between mousePressed and mouseReleased", () => {
  it(
    "T-REAL.3: when clickAt('.foo') resolves, (mouseReleased.t - mousePressed.t) >= 40 ms " +
      "and <= 200 ms (the 40-120 ms configured dwell, with CI margin)",
    async () => {
      // Given: new CdpClient; getBoxModel returns center (200,300); real setTimeout runs (no timer mock needed)
      // When:  await cli.clickAt('.foo')
      // Then:  the wall-clock gap between mousePressed and mouseReleased timestamps ≥40 ms

      const events: MouseEventEntry[] = [];
      let t0 = performance.now();
      const cli = makeFakeHandle({ boxes: [{ cx: 200, cy: 300 }], events, t0: () => t0 });
      t0 = performance.now();
      await cli.clickAt(".foo");

      const pressEv = eventsOfType(events, "mousePressed")[0];
      const releaseEv = eventsOfType(events, "mouseReleased")[0];

      assert.ok(pressEv !== undefined, "must have mousePressed event");
      assert.ok(releaseEv !== undefined, "must have mouseReleased event");

      const dwell = releaseEv.t - pressEv.t;
      assert.ok(
        dwell >= 40,
        `dwell (${dwell.toFixed(1)} ms) must be >= 40 ms (press.t=${pressEv.t.toFixed(1)}, release.t=${releaseEv.t.toFixed(1)})`,
      );
      assert.ok(
        dwell <= 200,
        `dwell (${dwell.toFixed(1)} ms) must be <= 200 ms (CI margin for configured 40-120 ms range)`,
      );
    },
  );
});

// ─── T-REAL.4 — second clickAt's first mouseMoved starts from prior landing ──

describe("G-A11.4 — lastPointerPos tracked across calls: second click curves from first landing", () => {
  it(
    "T-REAL.4: when cli.clickAt('.a') then cli.clickAt('.b') with different box centers, " +
      "the first mouseMoved of the second call is closer to the first click's landing than to the new target",
    async () => {
      // Given: new CdpClient; first box center=(200,300), second box center=(500,400)
      // When:  await cli.clickAt('.a'); await cli.clickAt('.b')
      // Then:  first mouseMoved of second click is closer to (200,300)±4 (first landing) than to (500,400)

      const events1: MouseEventEntry[] = [];
      const events2: MouseEventEntry[] = [];
      let t0 = performance.now();
      const allEvents: MouseEventEntry[] = [];

      // Two separate click calls — we need to track which events belong to which call.
      // Strategy: record events during each call separately using different event arrays.
      let captureTarget = events1;
      const fakeHandle = {
        DOM: {
          async getDocument() {
            return { root: { nodeId: 1 } };
          },
          async querySelectorAll() {
            return { nodeIds: [42] };
          },
          _boxIdx: 0,
          async getBoxModel() {
            const centers = [
              { cx: 200, cy: 300 },
              { cx: 500, cy: 400 },
            ] as const;
            const box = centers[fakeHandle.DOM._boxIdx % 2] ?? { cx: 200, cy: 300 };
            fakeHandle.DOM._boxIdx++;
            const { cx, cy } = box;
            return {
              model: { border: [cx - 20, cy - 20, cx + 20, cy - 20, cx + 20, cy + 20, cx - 20, cy + 20] },
            };
          },
        },
        Input: {
          async dispatchMouseEvent(p: { type: string; x: number; y: number }) {
            captureTarget.push({ type: p.type, x: p.x, y: p.y, t: performance.now() - t0 });
            allEvents.push({ type: p.type, x: p.x, y: p.y, t: performance.now() - t0 });
          },
          async insertText() {},
        },
        Page: { async enable() {}, async navigate() { return {}; } },
      };

      const cli = CdpClient.fromHandle(fakeHandle);
      t0 = performance.now();
      captureTarget = events1;
      await cli.clickAt(".a");
      captureTarget = events2;
      await cli.clickAt(".b");

      // First click's jittered landing (mousePressed coords = what lastPointerPos was set to)
      const pressed1 = eventsOfType(events1, "mousePressed")[0];
      assert.ok(pressed1 !== undefined, "first click must have mousePressed");

      // Second click's first mouseMoved must start near where first click landed
      const moved2 = eventsOfType(events2, "mouseMoved");
      assert.ok(moved2.length >= 1, "second click must have at least one mouseMoved");

      const firstMoved2 = moved2[0]!;

      // Assert closer to the first landing (where lastPointerPos was set) than to the new target (500,400)
      const distToFirstLanding = Math.hypot(firstMoved2.x - pressed1.x, firstMoved2.y - pressed1.y);
      const distToNewTarget = Math.hypot(firstMoved2.x - 500, firstMoved2.y - 400);
      assert.ok(
        distToFirstLanding < distToNewTarget,
        `first mouseMoved of second click (${firstMoved2.x},${firstMoved2.y}) should be ` +
          `closer to first landing (${pressed1.x},${pressed1.y}) [dist=${distToFirstLanding.toFixed(1)}] ` +
          `than to new target (500,400) [dist=${distToNewTarget.toFixed(1)}]`,
      );
    },
  );
});

// ─── T-REAL.5 — landing (x,y) within ±4 px of box center (jitter bounded) ───

describe("G-A11.5 — jitter bounded: mousePressed (x,y) within ±4 px of exact box center", () => {
  it(
    "T-REAL.5: over 200 trials with center=(200,300), mousePressed.x is always in [196,204] " +
      "and mousePressed.y always in [296,304]; at least one trial has a non-zero offset",
    async () => {
      // Given: re-used CdpClient (new instance each trial to reset lastPointerPos); center=(200,300)
      // When:  200 × clickAt('.foo')
      // Then:  every trial: |mousePressed.x - 200| <= 4 AND |mousePressed.y - 300| <= 4;
      //        at least one trial: pressed.x != 200 OR pressed.y != 300 (jitter is not no-op)

      const RAW_CX = 200;
      const RAW_CY = 300;
      const TRIALS = 200;
      let anyNonZeroOffset = false;

      // Performance: use the SAME client instance across trials to carry lastPointerPos forward.
      // After the first click lands near (RAW_CX,RAW_CY), subsequent clicks will have dist≈0-8px
      // (jitter range ±4), producing just 1 step per click → minimal sleep per trial.
      // The FIRST trial still starts from lastPointerPos=(0,0) so the first curve is FAR.
      // We only need to check that pressed.x/y stays within ±4 of raw center, which holds
      // regardless of path length. A fresh instance per trial would take ~30s; shared saves ~28s.
      const allEvents: MouseEventEntry[] = [];
      let t0 = performance.now();
      const cli = makeFakeHandle({ boxes: [{ cx: RAW_CX, cy: RAW_CY }], events: allEvents, t0: () => t0 });
      t0 = performance.now();

      for (let i = 0; i < TRIALS; i++) {
        allEvents.length = 0; // reset the shared event log before each trial
        await cli.clickAt(".foo");

        const pressed = eventsOfType(allEvents, "mousePressed")[0];
        assert.ok(pressed !== undefined, `trial ${i}: must have mousePressed`);

        assert.ok(
          Math.abs(pressed.x - RAW_CX) <= 4,
          `trial ${i}: mousePressed.x=${pressed.x} out of jitter bound [${RAW_CX - 4},${RAW_CX + 4}]`,
        );
        assert.ok(
          Math.abs(pressed.y - RAW_CY) <= 4,
          `trial ${i}: mousePressed.y=${pressed.y} out of jitter bound [${RAW_CY - 4},${RAW_CY + 4}]`,
        );

        if (pressed.x !== RAW_CX || pressed.y !== RAW_CY) {
          anyNonZeroOffset = true;
        }
      }

      assert.ok(
        anyNonZeroOffset,
        `over ${TRIALS} trials, at least one must have jitter != 0 (jitter function should not be a no-op)`,
      );
    },
  );
});

// ─── T-REAL.6 — regression pin: hardwareCoords + hardwareInput tests still green ──

describe("G-A11.6 — regression pin: jitter/mouseCurve re-export is byte-identical (existing tests stay GREEN)", () => {
  it(
    "T-REAL.6: after extraction, hardwareInput.jitter and mouseRealism.jitter refer to the same function " +
      "(import-then-export preserves identity); hardwareCoords.mock.test.ts + hardwareInput.mock.test.ts must pass unchanged",
    async () => {
      // Given: mouseRealism.ts exports jitter and mouseCurve; hardwareInput.ts imports then re-exports them
      // When:  import { jitter } from hardwareInput.js AND import { jitter } from mouseRealism.js
      // Then:  the two function references are triple-equal (same object through the re-export)

      const { jitter: jHW, mouseCurve: mcHW } = await import("../../src/cdp/hardwareInput.js");
      const { jitter: jMR, mouseCurve: mcMR } = await import("../../src/cdp/mouseRealism.js");

      assert.strictEqual(
        jHW,
        jMR,
        "jitter imported from hardwareInput must be the same function reference as jitter from mouseRealism (re-export identity)",
      );
      assert.strictEqual(
        mcHW,
        mcMR,
        "mouseCurve imported from hardwareInput must be the same function reference as mouseCurve from mouseRealism (re-export identity)",
      );
    },
  );
});

// ─── T-REAL.7 — regression pin: hardwareClickAt still works (re-export intact) ─

describe("G-A11.7 — regression pin: hardwareClickAt still works after extraction (re-export intact)", () => {
  it(
    "T-REAL.7: hardwareClickAt runs with the re-exported jitter+mouseCurve from hardwareInput; " +
      "the existing T-HW.CLICK.1 assertion (moveMouse ≥1× + mouseClick exactly once) holds",
    async () => {
      // Given: hardwareInput.ts re-exports jitter+mouseCurve from mouseRealism.ts; hardwareClickAt calls bare names
      // When:  hardwareClickAt(fakeClient, '@e1', fakeCg) (as in existing T-HW.CLICK.1)
      // Then:  no runtime error; cg.moveMouse called ≥1×; cg.mouseClick called exactly once

      const { hardwareClickAt } = await import("../../src/cdp/hardwareInput.js");
      // NOTE: hardwareClickAt calls resolveScreenCoords → client.evaluate() (Runtime.evaluate) +
      // client.handle.DOM.getBoxModel + client.currentRefMap. We use the same FakeClient pattern
      // as T-HW.CLICK.1 in hardwareInput.mock.test.ts (a cast object, not CdpClient.fromHandle),
      // because fromHandle's fake handle doesn't expose Runtime.evaluate and patching it would
      // require knowing client.ts internals. The FakeClient pattern is what T-HW.CLICK.1 uses.

      const moveMouseCalls: Array<[number, number]> = [];
      let mouseClickCount = 0;

      const fakeCg = {
        moveMouse(x: number, y: number) {
          moveMouseCalls.push([x, y]);
        },
        mouseClick() {
          mouseClickCount++;
        },
        scrollWheel(_dx: number, _dy: number) {},
        keyEvent(_keyCode: number, _down: boolean, _flags: number) {},
        unicodeType(_text: string) {},
        getMousePos() {
          return { x: 0, y: 0 };
        },
        getScreenSize() {
          return { width: 1920, height: 1080 };
        },
        isAccessibilityTrusted() {
          return true;
        },
      };

      // Border for center (100, 150): [80,130, 120,130, 120,170, 80,170]
      const BORDER = [80, 130, 120, 130, 120, 170, 80, 170];
      // evaluateResult: window.screenX=0, window.screenY=0, outerHeight-innerHeight=0
      const fakeClient = {
        async evaluate<T>(_expr: string): Promise<T> {
          return JSON.stringify({ sx: 0, sy: 0, ch: 0 }) as unknown as T;
        },
        get currentRefMap() {
          return {
            e1: { backendNodeId: 42, axNodeId: "ax1", role: "button", name: "Go" },
          };
        },
        handle: {
          DOM: {
            async getBoxModel(_arg: unknown) {
              return { model: { border: BORDER } };
            },
          },
        },
      } as unknown as import("../../src/cdp/client.js").CdpClient;

      // hardwareClickAt drives cg.moveMouse (curve steps from cg.getMousePos to jittered center)
      // then cg.mouseClick exactly once
      await hardwareClickAt(fakeClient, "@e1", fakeCg);

      assert.ok(
        moveMouseCalls.length >= 1,
        `cg.moveMouse must be called ≥1× (got ${moveMouseCalls.length})`,
      );
      assert.equal(mouseClickCount, 1, `cg.mouseClick must be called exactly once (got ${mouseClickCount})`);
    },
  );
});

// ─── T-REAL.8 — zero/near-distance: exactly 1 mouseMoved + dwell + press + release ──

describe("G-A11.8 — zero/near-distance: stub Math.random to 0.5 → jitter=0 → dist=0 → 1 mouseMoved", () => {
  // Round-2 N1: MUST stub Math.random so jitter is deterministic (both first and second click).
  // Math.random() = 0.5 → Math.round((0.5 - 0.5) * 8) = 0 → jitter offset = 0 px → dist = 0.
  // This makes the second click's target land EXACTLY on lastPointerPos → dist<1 → mouseCurve returns [to].

  let originalRandom: () => number;

  before(() => {
    // Stub Math.random to return 0.5 deterministically for the duration of this describe block.
    // Using a manual reassignment + restore pattern (compatible with any Node version).
    originalRandom = Math.random;
    Math.random = () => 0.5;
  });

  after(() => {
    Math.random = originalRandom;
  });

  it(
    "T-REAL.8: when Math.random()=0.5 (jitter=0), first click drives lastPointerPos to box center; " +
      "second click to same center → dist=0 → exactly 1 mouseMoved + 1 mousePressed + 1 mouseReleased; " +
      "dwell still fires (mouseReleased.t - mousePressed.t >= 40); no crash",
    async () => {
      // Given: Math.random() stubbed to 0.5 (jitter returns +0 on every call);
      //        first clickAt('.a') → center (200,300); lastPointerPos → (200,300) (jitter=0)
      //        second clickAt('.b') → same center (200,300); target = jitter(200,300) = (200,300); dist=0
      //        → mouseCurve returns [to]; path has exactly 1 point → 1 mouseMoved
      // When:  second clickAt resolves
      // Then:  second-click events = exactly [mouseMoved, mousePressed, mouseReleased];
      //        no crash; mouseReleased.t - mousePressed.t >= 40 ms

      const events1: MouseEventEntry[] = [];
      const events2: MouseEventEntry[] = [];
      let t0 = performance.now();
      let captureTarget = events1;

      const fakeHandle = {
        DOM: {
          async getDocument() { return { root: { nodeId: 1 } }; },
          async querySelectorAll() { return { nodeIds: [42] }; },
          async getBoxModel() {
            // Both clicks target center (200, 300)
            return { model: { border: [180, 280, 220, 280, 220, 320, 180, 320] } };
          },
        },
        Input: {
          async dispatchMouseEvent(p: { type: string; x: number; y: number }) {
            captureTarget.push({ type: p.type, x: p.x, y: p.y, t: performance.now() - t0 });
          },
          async insertText() {},
        },
        Page: { async enable() {}, async navigate() { return {}; } },
      };

      const cli = CdpClient.fromHandle(fakeHandle);
      t0 = performance.now();
      captureTarget = events1;
      await cli.clickAt(".a"); // drives lastPointerPos to (200,300) with jitter=0

      captureTarget = events2;
      await cli.clickAt(".b"); // dist=0 → 1 mouseMoved only

      const moved2 = eventsOfType(events2, "mouseMoved");
      const pressed2 = eventsOfType(events2, "mousePressed")[0];
      const released2 = eventsOfType(events2, "mouseReleased")[0];

      assert.equal(
        moved2.length,
        1,
        `second click at dist=0 must emit exactly 1 mouseMoved (got ${moved2.length})`,
      );
      assert.ok(pressed2 !== undefined, "second click must have mousePressed");
      assert.ok(released2 !== undefined, "second click must have mouseReleased");

      // Exactly 3 events total for the second click: 1 moved + 1 pressed + 1 released
      assert.equal(
        events2.length,
        3,
        `second click at dist=0 must have exactly 3 total events [moved, pressed, released] (got ${events2.length}: ${events2.map((e) => e.type).join(", ")})`,
      );

      // Dwell still fires even for the near-zero case
      const dwell = released2.t - pressed2.t;
      assert.ok(
        dwell >= 40,
        `dwell (${dwell.toFixed(1)} ms) must be >= 40 ms even for dist=0 case`,
      );
    },
  );
});

// ─── T-REAL.9 — @ref path: same realism as selector path; getBoxModel with backendNodeId ──

describe("G-A11.9 — @ref path: same realism shape as selector; DOM.getBoxModel called with {backendNodeId:99}", () => {
  it(
    "T-REAL.9: when refMap seeded with r1→{backendNodeId:99} and clickAt('@r1') resolves on a FAR target, " +
      "the event log shows ≥2 mouseMoved before mousePressed; getBoxModel called with {backendNodeId:99} not {nodeId}; " +
      "press+release share jittered (x,y) within ±4 px of center; dwell ≥40 ms",
    async () => {
      // Given: new CdpClient; mergeRefs({r1: {backendNodeId:99, axNodeId:'ax1', role:'button', name:'Test'}});
      //        getBoxModel returns center (400,500) [dist from (0,0) ≈ 640 → 21 curve steps → far]
      //        getBoxModel is called with {backendNodeId:99} (NOT {nodeId}) — @ref path
      //        DOM.getDocument + querySelectorAll are NOT called (@ref skips selector resolution)
      // When:  await cli.clickAt('@r1')
      // Then:  ≥2 mouseMoved before mousePressed; getBoxModel arg = {backendNodeId:99};
      //        press.x === release.x; press.y === release.y; |press.x-400|<=4; |press.y-500|<=4;
      //        release.t - press.t >= 40

      const events: MouseEventEntry[] = [];
      const boxModelCalls: BoxModelCall[] = [];
      let getDocumentCallCount = 0;
      let querySelectorAllCallCount = 0;
      let t0 = performance.now();

      const fakeHandle = {
        DOM: {
          async getDocument() {
            // should NOT be called on @ref path
            getDocumentCallCount++;
            return { root: { nodeId: 1 } };
          },
          async querySelectorAll() {
            // should NOT be called on @ref path
            querySelectorAllCallCount++;
            return { nodeIds: [42] };
          },
          async getBoxModel(arg: BoxModelCall) {
            boxModelCalls.push({ ...arg });
            // center (400, 500)
            return { model: { border: [380, 480, 420, 480, 420, 520, 380, 520] } };
          },
        },
        Input: {
          async dispatchMouseEvent(p: { type: string; x: number; y: number }) {
            events.push({ type: p.type, x: p.x, y: p.y, t: performance.now() - t0 });
          },
          async insertText() {},
        },
        Page: { async enable() {}, async navigate() { return {}; } },
      };

      const cli = CdpClient.fromHandle(fakeHandle);
      // Seed refMap via the mergeRefs test seam (client.ts:306)
      cli.mergeRefs({ r1: { backendNodeId: 99, axNodeId: "ax1", role: "button", name: "Test" } });

      t0 = performance.now();
      await cli.clickAt("@r1");

      const movedEvents = eventsOfType(events, "mouseMoved");
      const pressed = eventsOfType(events, "mousePressed")[0];
      const released = eventsOfType(events, "mouseReleased")[0];

      // ≥2 mouseMoved before mousePressed (FAR target, dist≈640 from (0,0))
      const pressIdx = firstIndexOf(events, "mousePressed");
      const movedBeforePress = events.slice(0, pressIdx).filter((e) => e.type === "mouseMoved");
      assert.ok(
        movedBeforePress.length >= 2,
        `@ref FAR target: expected ≥2 mouseMoved before press, got ${movedBeforePress.length} (${movedEvents.length} total)`,
      );

      // getBoxModel called with {backendNodeId:99}, NOT {nodeId}
      assert.ok(boxModelCalls.length >= 1, "getBoxModel must be called at least once");
      assert.equal(
        boxModelCalls[0]!.backendNodeId,
        99,
        `getBoxModel must be called with backendNodeId:99 (got ${JSON.stringify(boxModelCalls[0])})`,
      );
      assert.equal(
        boxModelCalls[0]!.nodeId,
        undefined,
        "getBoxModel must NOT have nodeId on the @ref path",
      );

      // DOM.getDocument and querySelectorAll must NOT be called on the @ref path
      assert.equal(getDocumentCallCount, 0, "DOM.getDocument must NOT be called on @ref path");
      assert.equal(querySelectorAllCallCount, 0, "DOM.querySelectorAll must NOT be called on @ref path");

      // press and release share the same (x,y)
      assert.ok(pressed !== undefined, "must have mousePressed");
      assert.ok(released !== undefined, "must have mouseReleased");
      assert.equal(pressed.x, released.x, `press.x (${pressed.x}) must equal release.x (${released.x})`);
      assert.equal(pressed.y, released.y, `press.y (${pressed.y}) must equal release.y (${released.y})`);

      // jitter bound: ±4 px of raw center (400, 500)
      assert.ok(
        Math.abs(pressed.x - 400) <= 4,
        `pressed.x=${pressed.x} must be within ±4 of 400`,
      );
      assert.ok(
        Math.abs(pressed.y - 500) <= 4,
        `pressed.y=${pressed.y} must be within ±4 of 500`,
      );

      // Dwell ≥40 ms
      const dwell = released.t - pressed.t;
      assert.ok(dwell >= 40, `dwell (${dwell.toFixed(1)} ms) must be >= 40 ms`);
    },
  );
});

// ─── T-REAL.10 — @ref + near-distance (N2 fix) ──────────────────────────────

describe("G-A11.10 — @ref near-distance: combine Math.random stub + @ref path → 1 mouseMoved + dwell", () => {
  // Round-2 N2: @ref path at dist<1 was untested. This covers the @ref×near combination.
  // Math.random stub (0.5 → jitter=0) ensures the second click via @ref lands at dist=0.

  let originalRandom: () => number;

  before(() => {
    originalRandom = Math.random;
    Math.random = () => 0.5;
  });

  after(() => {
    Math.random = originalRandom;
  });

  it(
    "T-REAL.10: when Math.random()=0.5 (jitter=0), first clickAt('@r1') drives lastPointerPos to center; " +
      "second clickAt('@r1') at same center → dist=0 → exactly 1 mouseMoved + press + dwell ≥40 ms + release",
    async () => {
      // Given: Math.random() stubbed to 0.5;
      //        refMap seeded with r1→{backendNodeId:99}; both calls target center (300,200)
      //        first @r1 click: drives lastPointerPos to (300,200) (jitter=0)
      //        second @r1 click: target=(300,200), dist=0 → mouseCurve returns [to] → 1 mouseMoved
      // When:  second clickAt('@r1') resolves
      // Then:  second-click events = exactly [mouseMoved(300,200), mousePressed(300,200), mouseReleased(300,200)];
      //        dwell = release.t - press.t >= 40 ms; no crash; getBoxModel called with {backendNodeId:99} (both calls)

      const events1: MouseEventEntry[] = [];
      const events2: MouseEventEntry[] = [];
      const boxModelCalls: BoxModelCall[] = [];
      let t0 = performance.now();
      let captureTarget = events1;

      const fakeHandle = {
        DOM: {
          async getDocument() { return { root: { nodeId: 1 } }; },
          async querySelectorAll() { return { nodeIds: [42] }; },
          async getBoxModel(arg: BoxModelCall) {
            boxModelCalls.push({ ...arg });
            // center (300, 200)
            return { model: { border: [280, 180, 320, 180, 320, 220, 280, 220] } };
          },
        },
        Input: {
          async dispatchMouseEvent(p: { type: string; x: number; y: number }) {
            captureTarget.push({ type: p.type, x: p.x, y: p.y, t: performance.now() - t0 });
          },
          async insertText() {},
        },
        Page: { async enable() {}, async navigate() { return {}; } },
      };

      const cli = CdpClient.fromHandle(fakeHandle);
      cli.mergeRefs({ r1: { backendNodeId: 99, axNodeId: "ax1", role: "button", name: "Test" } });

      t0 = performance.now();
      captureTarget = events1;
      await cli.clickAt("@r1"); // first click: seeds lastPointerPos to (300,200) with jitter=0

      captureTarget = events2;
      await cli.clickAt("@r1"); // second click: dist=0 → 1 mouseMoved only

      const moved2 = eventsOfType(events2, "mouseMoved");
      const pressed2 = eventsOfType(events2, "mousePressed")[0];
      const released2 = eventsOfType(events2, "mouseReleased")[0];

      // Exactly 1 mouseMoved for the dist=0 second click
      assert.equal(
        moved2.length,
        1,
        `@ref second click at dist=0 must emit exactly 1 mouseMoved (got ${moved2.length})`,
      );

      // Exactly 3 total events
      assert.equal(
        events2.length,
        3,
        `second @ref click at dist=0 must have exactly 3 total events (got ${events2.length}: ${events2.map((e) => e.type).join(", ")})`,
      );

      assert.ok(pressed2 !== undefined, "must have mousePressed on second @ref click");
      assert.ok(released2 !== undefined, "must have mouseReleased on second @ref click");

      // Dwell ≥40 ms
      const dwell = released2.t - pressed2.t;
      assert.ok(
        dwell >= 40,
        `dwell (${dwell.toFixed(1)} ms) must be >= 40 ms even for @ref dist=0 case`,
      );

      // All getBoxModel calls must use backendNodeId:99 (both clicks go through @ref path)
      assert.ok(boxModelCalls.length >= 2, `must have ≥2 getBoxModel calls (got ${boxModelCalls.length})`);
      for (let i = 0; i < boxModelCalls.length; i++) {
        assert.equal(
          boxModelCalls[i]!.backendNodeId,
          99,
          `boxModelCalls[${i}] must have backendNodeId:99 (got ${JSON.stringify(boxModelCalls[i])})`,
        );
        assert.equal(
          boxModelCalls[i]!.nodeId,
          undefined,
          `boxModelCalls[${i}] must NOT have nodeId on @ref path`,
        );
      }
    },
  );
});
