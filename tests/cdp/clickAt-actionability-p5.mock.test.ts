/**
 * P-POST-PUBLISH-5 Step 2 (rev-2) — Test Scaffold (outside-in TDD, all-failing on HEAD)
 * T-Click5.ScrollFirst, T-Click5.PostScrollCoords, T-Click5.AlreadyVisibleNoOp,
 * T-Click5.SelectorPath, T-Click5.AbortSafe, T-Click5.NoRegression.
 *
 * Rev-2 design (MINIMAL — no hit-test, no fallback, no resolveNode/callFunctionOn):
 *   1. DOM.scrollIntoViewIfNeeded({backendNodeId}) or ({nodeId}) — CDP-native, raced, no-op when visible.
 *   2. sleep(60) settle.
 *   3. Re-resolve DOM.getBoxModel AFTER scroll (fresh border quad → jittered center).
 *   4. Existing human mouse curve → Input.dispatchMouseEvent press/dwell/release (isTrusted:true).
 *
 * All assertion bodies are `assert.fail("TODO P5 rev2: …")` — they fail on HEAD because
 * the hardened clickAt (scroll + re-resolve) does not exist yet. The fakes are wired for
 * DOM.scrollIntoViewIfNeeded so Step 4 impl makes these tests compile + reach the assert.fail.
 *
 * Dropped from rev-1 (no hit-test/fallback in rev-2):
 *   T-Click5.HitOk, T-Click5.DescendantHit, T-Click5.Occluded,
 *   T-Click5.FallbackThrowSafe, T-Click5.ShadowResolve.
 *
 * No real Chrome required.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";

// ─── Shared types ──────────────────────────────────────────────────────────────

/** One call to DOM.scrollIntoViewIfNeeded — records the exact arg shape. */
interface ScrollIntoViewEntry {
  /** Arg had {backendNodeId} (ref path) or {nodeId} (selector path). */
  kind: "backendNodeId" | "nodeId";
  backendNodeId?: number;
  nodeId?: number;
}

/** One call to Input.dispatchMouseEvent — type + coordinates. */
interface MouseEventEntry {
  type: string;
  x: number;
  y: number;
}

/** Ordered global call log for ordering assertions (T-Click5.ScrollFirst). */
type GlobalCallType = "scrollIntoViewIfNeeded" | "getBoxModel" | "mouseEvent";
interface GlobalEntry {
  kind: GlobalCallType;
  sub: string;
}

// ─── Fake handle factory ────────────────────────────────────────────────────────

/**
 * Build a P5 rev-2 fake CDP handle with DOM.scrollIntoViewIfNeeded stubbed.
 *
 * Options:
 *   boxes              – getBoxModel call-sequence boxes (indexed, wraps to last; same pattern
 *                        as makeFakeHandle in clickAt-realism.mock.test.ts). If only one box is
 *                        given it is reused for every call (no-change baseline).
 *   targetBnid         – backendNodeId to put in the @ref mergeRefs entry.
 *   scrollNeverSettles – if true, DOM.scrollIntoViewIfNeeded returns a never-resolving promise.
 *                        Use this with an aborted turn signal to exercise T-Click5.AbortSafe.
 *
 * Returned logs:
 *   events     – all Input.dispatchMouseEvent calls in order (type + x + y).
 *   scrollLog  – all DOM.scrollIntoViewIfNeeded calls in order (kind + arg).
 *   globalLog  – ordered union of scrollIntoViewIfNeeded + getBoxModel + mouseEvent calls
 *                (for T-Click5.ScrollFirst ordering assertion).
 */
function makeP5Handle(opts: {
  boxes: Array<{ cx: number; cy: number }>;
  targetBnid: number;
  scrollNeverSettles?: boolean;
}): {
  client: CdpClient;
  events: MouseEventEntry[];
  scrollLog: ScrollIntoViewEntry[];
  globalLog: GlobalEntry[];
} {
  const events: MouseEventEntry[] = [];
  const scrollLog: ScrollIntoViewEntry[] = [];
  const globalLog: GlobalEntry[] = [];

  let boxCallIdx = 0;

  const handle = {
    DOM: {
      async getDocument(_: unknown) {
        return { root: { nodeId: 1 } };
      },
      async querySelectorAll(_: unknown) {
        return { nodeIds: [42] };
      },
      async getBoxModel(arg: { backendNodeId?: number; nodeId?: number }) {
        globalLog.push({ kind: "getBoxModel", sub: "getBoxModel" });
        const box =
          opts.boxes[Math.min(boxCallIdx, opts.boxes.length - 1)] ??
          ({ cx: 200, cy: 300 } as { cx: number; cy: number });
        boxCallIdx++;
        const { cx, cy } = box;
        return {
          model: {
            border: [cx - 20, cy - 20, cx + 20, cy - 20, cx + 20, cy + 20, cx - 20, cy + 20],
          },
        };
      },
      async scrollIntoViewIfNeeded(arg: { backendNodeId?: number; nodeId?: number }) {
        if (opts.scrollNeverSettles) {
          return new Promise<void>(() => {
            // intentionally never resolves — used for T-Click5.AbortSafe
          });
        }
        const entry: ScrollIntoViewEntry =
          arg.backendNodeId !== undefined
            ? { kind: "backendNodeId", backendNodeId: arg.backendNodeId }
            : { kind: "nodeId", nodeId: arg.nodeId };
        scrollLog.push(entry);
        globalLog.push({ kind: "scrollIntoViewIfNeeded", sub: entry.kind });
        // resolves synchronously (no-op when element already visible)
      },
    },
    Input: {
      async dispatchMouseEvent(p: { type: string; x: number; y: number }) {
        events.push({ type: p.type, x: p.x, y: p.y });
        globalLog.push({ kind: "mouseEvent", sub: p.type });
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

  return {
    client: CdpClient.fromHandle(handle),
    events,
    scrollLog,
    globalLog,
  };
}

// ─── T-Click5.ScrollFirst — scrollIntoViewIfNeeded before post-scroll getBoxModel ──

describe("T-Click5.ScrollFirst — DOM.scrollIntoViewIfNeeded issued before the post-scroll DOM.getBoxModel", () => {
  it(
    "T-Click5.ScrollFirst: when clickAt('@r1') runs the hardened flow, " +
      "→ scrollIntoViewIfNeeded appears in globalLog BEFORE the getBoxModel whose center is clicked; " +
      "scrollLog.length >= 1",
    async () => {
      // Given: target backendNodeId=20; boxes has a pre-scroll entry and a post-scroll entry (different centers)
      // When:  clickAt("@r1")
      // Then:  globalLog contains scrollIntoViewIfNeeded before getBoxModel (the click-coord getBoxModel);
      //        scrollLog.length >= 1

      const TARGET_BNID = 20;
      const { client, scrollLog, globalLog } = makeP5Handle({
        boxes: [
          { cx: 200, cy: 300 }, // first getBoxModel (pre-scroll, if present)
          { cx: 205, cy: 305 }, // post-scroll getBoxModel (fresh coords after scroll)
        ],
        targetBnid: TARGET_BNID,
      });

      client.mergeRefs({
        r1: { backendNodeId: TARGET_BNID, axNodeId: "ax1", role: "button", name: "Post" },
      });
      await client.clickAt("@r1");

      // Locate the scrollIntoViewIfNeeded entry and the last getBoxModel entry in globalLog
      const scrollIdx = globalLog.findIndex((e) => e.kind === "scrollIntoViewIfNeeded");
      const postScrollBoxIdx = globalLog.findLastIndex((e) => e.kind === "getBoxModel");

      assert.ok(scrollIdx >= 0, `scrollIntoViewIfNeeded not found in globalLog: ${JSON.stringify(globalLog)}`);
      assert.ok(
        postScrollBoxIdx > scrollIdx,
        `getBoxModel (idx ${postScrollBoxIdx}) must appear AFTER scrollIntoViewIfNeeded (idx ${scrollIdx}) in globalLog: ${JSON.stringify(globalLog)}`,
      );
      assert.ok(scrollLog.length >= 1, `scrollLog should have ≥1 entry, got ${scrollLog.length}`);
    },
  );
});

// ─── T-Click5.PostScrollCoords — clicked center equals the single post-scroll getBoxModel center ──
//
// REALIGNMENT NOTE (plan §2 "Scaffold alignment note"):
// The minimal design calls getBoxModel EXACTLY ONCE (after scroll). Supplying two boxes and
// expecting the SECOND would require two getBoxModel calls — contrary to the design. Instead
// this test supplies ONE box (the post-scroll position, (500,600)) and asserts the click uses
// that center exactly (with Math.random→0.5 so jitter=0). T-Click5.ScrollFirst separately
// proves scrollIntoViewIfNeeded ran BEFORE that single getBoxModel call.

describe("T-Click5.PostScrollCoords — mousePressed.x/y equals the single post-scroll getBoxModel center", () => {
  // Math.random is stubbed to 0.5 so jitter(x) = x (offset = 0) making the center deterministic.
  // jitter formula: Math.round((Math.random() - 0.5) * 8) → Math.round((0.5 - 0.5) * 8) = 0.
  // So mousePressed.x === post-scroll cx exactly, mousePressed.y === post-scroll cy exactly.

  let originalRandom: () => number;

  before(() => {
    originalRandom = Math.random;
    Math.random = () => 0.5;
  });

  after(() => {
    Math.random = originalRandom;
  });

  it(
    "T-Click5.PostScrollCoords: with Math.random()=0.5 (jitter=0) and a single post-scroll box at (500,600), " +
      "→ mousePressed.x===500, mousePressed.y===600 (click uses the post-scroll getBoxModel center)",
    async () => {
      // Given: Math.random() stubbed to 0.5 → jitter offset = 0 → center used as-is;
      //        single getBoxModel box (post-scroll position) at (500,600);
      //        minimal design: ONE getBoxModel call, taken after scrollIntoViewIfNeeded
      // When:  clickAt("@r1")
      // Then:  mousePressed.x === 500 AND mousePressed.y === 600 (the post-scroll box center);
      //        T-Click5.ScrollFirst independently proves scroll ran before this getBoxModel call

      const POST_CX = 500;
      const POST_CY = 600;
      const TARGET_BNID = 21;

      const { client, events } = makeP5Handle({
        boxes: [{ cx: POST_CX, cy: POST_CY }], // single post-scroll box (the only getBoxModel call)
        targetBnid: TARGET_BNID,
      });

      client.mergeRefs({
        r1: { backendNodeId: TARGET_BNID, axNodeId: "ax2", role: "button", name: "Post" },
      });
      await client.clickAt("@r1");

      const pressed = events.filter((e) => e.type === "mousePressed");

      assert.ok(pressed.length >= 1, `expected ≥1 mousePressed, got ${pressed.length}`);
      assert.strictEqual(pressed[0].x, POST_CX, `mousePressed.x should be ${POST_CX} (post-scroll cx), got ${pressed[0].x}`);
      assert.strictEqual(pressed[0].y, POST_CY, `mousePressed.y should be ${POST_CY} (post-scroll cy), got ${pressed[0].y}`);
    },
  );
});

// ─── T-Click5.AlreadyVisibleNoOp — scroll resolves without effect → click still works ──

describe("T-Click5.AlreadyVisibleNoOp — scrollIntoViewIfNeeded is a no-op when element already visible; click dispatches normally", () => {
  it(
    "T-Click5.AlreadyVisibleNoOp: when scrollIntoViewIfNeeded resolves immediately (element already visible), " +
      "→ clickAt still dispatches exactly 1 mousePressed + 1 mouseReleased (no behavioral difference)",
    async () => {
      // Given: target backendNodeId=22; scrollIntoViewIfNeeded stub resolves immediately (default, no-op);
      //        single box entry (200,300) — position does not change after scroll (already visible)
      // When:  clickAt("@r1")
      // Then:  events contains exactly 1 mousePressed + 1 mouseReleased;
      //        scrollLog.length >= 1 (scrollIntoViewIfNeeded WAS called — always called);
      //        click dispatches normally (no early exit, no error)

      const TARGET_BNID = 22;
      const { client, events, scrollLog } = makeP5Handle({
        boxes: [{ cx: 200, cy: 300 }],
        targetBnid: TARGET_BNID,
      });

      client.mergeRefs({
        r1: { backendNodeId: TARGET_BNID, axNodeId: "ax3", role: "button", name: "Post" },
      });
      await client.clickAt("@r1");

      const pressed = events.filter((e) => e.type === "mousePressed");
      const released = events.filter((e) => e.type === "mouseReleased");

      assert.strictEqual(pressed.length, 1, `expected exactly 1 mousePressed, got ${pressed.length}`);
      assert.strictEqual(released.length, 1, `expected exactly 1 mouseReleased, got ${released.length}`);
      assert.ok(
        scrollLog.length >= 1,
        `scrollIntoViewIfNeeded must be called even when element is already visible (always-call contract); got scrollLog.length=${scrollLog.length}`,
      );
    },
  );
});

// ─── T-Click5.SelectorPath — selector input uses {nodeId} for scrollIntoViewIfNeeded ──

describe("T-Click5.SelectorPath — clickAt(selector) calls scrollIntoViewIfNeeded({nodeId}), not {backendNodeId}", () => {
  it(
    "T-Click5.SelectorPath: when clickAt('#submit') (selector, not @ref), " +
      "→ scrollIntoViewIfNeeded is called with {nodeId} (the querySelectorAll-resolved nodeId); " +
      "click still dispatches normally",
    async () => {
      // Given: selector input '#submit'; querySelectorAll returns nodeId=42;
      //        scrollIntoViewIfNeeded stub records arg shape
      // When:  clickAt("#submit")
      // Then:  scrollLog[0].kind === "nodeId" (selector path uses nodeId, not backendNodeId);
      //        scrollLog[0].nodeId === 42 (the resolved nodeId);
      //        events contains exactly 1 mousePressed + 1 mouseReleased

      const TARGET_BNID = 23; // unused for selector path, but required by factory
      const { client, events, scrollLog } = makeP5Handle({
        boxes: [{ cx: 150, cy: 250 }],
        targetBnid: TARGET_BNID,
      });

      // No mergeRefs — we use the selector path directly
      await client.clickAt("#submit");

      const pressed = events.filter((e) => e.type === "mousePressed");

      assert.ok(scrollLog.length >= 1, `scrollIntoViewIfNeeded must be called for selector path; got scrollLog.length=${scrollLog.length}`);
      assert.strictEqual(scrollLog[0].kind, "nodeId", `selector path must call scrollIntoViewIfNeeded with {nodeId}, not {backendNodeId}; got kind="${scrollLog[0].kind}"`);
      assert.strictEqual(scrollLog[0].nodeId, 42, `scrollIntoViewIfNeeded nodeId must be 42 (querySelectorAll result), got ${scrollLog[0].nodeId}`);
      assert.strictEqual(pressed.length, 1, `expected exactly 1 mousePressed for selector path, got ${pressed.length}`);
    },
  );
});

// ─── T-Click5.AbortSafe — aborted turn signal → clickAt rejects promptly ──────

describe("T-Click5.AbortSafe — aborted turn signal causes clickAt to reject promptly, not hang", () => {
  it(
    "T-Click5.AbortSafe: when the turn signal is already aborted before clickAt is called, " +
      "→ clickAt rejects promptly (does NOT hang); this.race() is the choke-point",
    async () => {
      // Given: target backendNodeId=24; turn signal is aborted BEFORE clickAt is called;
      //        scrollIntoViewIfNeeded stub never resolves (scrollNeverSettles:true is a belt-and-suspenders
      //        check — the aborted signal should reject before scrollIntoViewIfNeeded completes anyway)
      // When:  setTurnAbortSignal(abortedSignal); clickAt("@r1") is awaited
      // Then:  clickAt rejects with an Error (does NOT resolve successfully, does NOT hang)

      const TARGET_BNID = 24;
      const { client } = makeP5Handle({
        boxes: [{ cx: 100, cy: 100 }],
        targetBnid: TARGET_BNID,
        scrollNeverSettles: true,
      });

      client.mergeRefs({
        r1: { backendNodeId: TARGET_BNID, axNodeId: "ax4", role: "button", name: "Post" },
      });

      const abortController = new AbortController();
      client.setTurnAbortSignal(abortController.signal);
      abortController.abort(); // abort before the call — raceCdp fast-path fires synchronously

      await assert.rejects(
        () => client.clickAt("@r1"),
        (e: unknown) => {
          assert.ok(e instanceof Error, `clickAt should reject with Error when signal is aborted, got: ${String(e)}`);
          return true;
        },
      );
    },
  );
});

// ─── T-Click5.NoRegression — happy path event shape preserved ─────────────────

describe("T-Click5.NoRegression — hardened clickAt preserves the existing event shape on the happy path", () => {
  it(
    "T-Click5.NoRegression: on the happy path (in-view element, single-box), " +
      "→ ≥1 mouseMoved before exactly 1 mousePressed + 1 mouseReleased; " +
      "press.x === release.x && press.y === release.y",
    async () => {
      // Given: target backendNodeId=70; single box entry, center (200,300);
      //        lastPointerPos starts at (0,0) → FAR path → ≥1 mouseMoved before press
      // When:  clickAt("@r1")
      // Then:  events contains ≥1 mouseMoved BEFORE mousePressed;
      //        exactly 1 mousePressed and 1 mouseReleased;
      //        press.x === release.x; press.y === release.y (shape byte-equal to HEAD)
      //
      // This is the regression guard: the hardened clickAt MUST preserve the existing
      // event shape on the happy path so all prior T-REAL.* tests remain valid.

      const TARGET_BNID = 70;
      const { client, events } = makeP5Handle({
        boxes: [{ cx: 200, cy: 300 }],
        targetBnid: TARGET_BNID,
      });

      client.mergeRefs({
        r1: { backendNodeId: TARGET_BNID, axNodeId: "ax5", role: "button", name: "Post" },
      });
      await client.clickAt("@r1");

      const pressed = events.filter((e) => e.type === "mousePressed");
      const released = events.filter((e) => e.type === "mouseReleased");
      const pressIdx = events.findIndex((e) => e.type === "mousePressed");
      const movedBeforePress = events.slice(0, pressIdx).filter((e) => e.type === "mouseMoved");

      assert.ok(
        movedBeforePress.length >= 1,
        `expected ≥1 mouseMoved before mousePressed (FAR path from (0,0) to (200,300)), got ${movedBeforePress.length}; all events: ${JSON.stringify(events.map((e) => e.type))}`,
      );
      assert.strictEqual(pressed.length, 1, `expected exactly 1 mousePressed, got ${pressed.length}`);
      assert.strictEqual(released.length, 1, `expected exactly 1 mouseReleased, got ${released.length}`);
      assert.strictEqual(pressed[0].x, released[0].x, `press.x (${pressed[0].x}) must equal release.x (${released[0].x})`);
      assert.strictEqual(pressed[0].y, released[0].y, `press.y (${pressed[0].y}) must equal release.y (${released[0].y})`);
    },
  );
});
