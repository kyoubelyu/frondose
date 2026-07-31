import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { buildDocumentScrollExpression, SCROLL_OBSERVE_MS, type ScrollOutcome } from "../../src/cdp/scroll.js";

interface RootFixture {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  scrollLeft: number;
  scrollTop: number;
}

interface ExpressionHarness {
  outcome: Promise<ScrollOutcome>;
  rafs: Array<() => void>;
  timers: Array<{ ms: number; callback: () => void }>;
  root: RootFixture;
  distractor: { scrollTop: number };
}

function makeHarness(
  direction: "up" | "down" | "left" | "right",
  amount: number,
  rootOverrides: Partial<RootFixture> = {},
  onSet?: (axis: "x" | "y", value: number, root: RootFixture) => void,
): ExpressionHarness {
  const state: RootFixture = {
    clientWidth: 800,
    clientHeight: 600,
    scrollWidth: 800,
    scrollHeight: 2400,
    scrollLeft: 0,
    scrollTop: 0,
    ...rootOverrides,
  };
  const root = {
    clientWidth: state.clientWidth,
    clientHeight: state.clientHeight,
    scrollWidth: state.scrollWidth,
    scrollHeight: state.scrollHeight,
    get scrollLeft() {
      return state.scrollLeft;
    },
    set scrollLeft(value: number) {
      if (onSet) onSet("x", value, state);
      else state.scrollLeft = value;
    },
    get scrollTop() {
      return state.scrollTop;
    },
    set scrollTop(value: number) {
      if (onSet) onSet("y", value, state);
      else state.scrollTop = value;
    },
  };
  const rafs: Array<() => void> = [];
  const timers: Array<{ ms: number; callback: () => void }> = [];
  const distractor = { scrollTop: 0 };
  const context = vm.createContext({
    document: { scrollingElement: root, querySelectorAll: () => [distractor] },
    requestAnimationFrame: (callback: () => void) => {
      rafs.push(callback);
      return rafs.length;
    },
    setTimeout: (callback: () => void, ms: number) => {
      timers.push({ callback, ms });
      return timers.length;
    },
  });
  const outcome = vm.runInContext(buildDocumentScrollExpression(direction, amount), context) as Promise<ScrollOutcome>;
  return { outcome, rafs, timers, root: state, distractor };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function fireNextRaf(harness: ExpressionHarness): Promise<void> {
  await flushMicrotasks();
  const callback = harness.rafs.shift();
  assert.ok(callback, "expected a queued requestAnimationFrame callback");
  callback();
  await flushMicrotasks();
}

describe("self-verifying document scroll expression", () => {
  it("T-SCROLL.MOCK.1: reports actual document movement from the production expression", async () => {
    // Given a vertically scrollable document at y=0; When down 300 executes; Then actual y evidence is returned.
    const harness = makeHarness("down", 300);
    await fireNextRaf(harness);
    await fireNextRaf(harness);
    const result = await harness.outcome;
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      verification: "verified",
      state: "moved",
      target: "document",
      axis: "y",
      beforeX: 0,
      beforeY: 0,
      afterX: 0,
      afterY: 300,
      deltaX: 0,
      deltaY: 300,
    });
    assert.deepEqual(
      harness.timers.map(({ ms }) => ms),
      [SCROLL_OBSERVE_MS],
      "the complete RAF chain must be protected by exactly one local timer",
    );
  });

  it("T-SCROLL.MOCK.2: distinguishes no range, requested boundary, and blocked movement without touching a distractor", async () => {
    // Given three root zero-delta causes plus a movable distractor; When scrolling; Then reasons differ and distractor stays fixed.
    const noRange = makeHarness("down", 300, { scrollHeight: 600 });
    const noRangeResult = await noRange.outcome;
    assert.equal(noRangeResult.state, "not_moved");
    if (noRangeResult.state === "not_moved") assert.equal(noRangeResult.reason, "no_scroll_range");

    const boundary = makeHarness("down", 300, { scrollTop: 1800 });
    const boundaryResult = await boundary.outcome;
    assert.equal(boundaryResult.state, "not_moved");
    if (boundaryResult.state === "not_moved") assert.equal(boundaryResult.reason, "at_requested_boundary");

    const blocked = makeHarness("down", 300, {}, () => {});
    await fireNextRaf(blocked);
    await fireNextRaf(blocked);
    const blockedResult = await blocked.outcome;
    assert.equal(blockedResult.state, "not_moved");
    if (blockedResult.state === "not_moved") assert.equal(blockedResult.reason, "movement_blocked");

    assert.equal(noRange.distractor.scrollTop, 0);
    assert.equal(boundary.distractor.scrollTop, 0);
    assert.equal(blocked.distractor.scrollTop, 0);
  });

  it("T-SCROLL.MOCK.3a: observes movement released only on RAF2", async () => {
    // Given assignment becomes observable at RAF2; When the complete chain resolves; Then the final sample sees movement.
    let pending = 0;
    const harness = makeHarness("down", 300, {}, (_axis, value) => {
      pending = value;
    });
    await fireNextRaf(harness);
    harness.root.scrollTop = pending;
    await fireNextRaf(harness);
    const result = await harness.outcome;
    assert.equal(result.state, "moved");
    assert.equal(result.deltaY, 300);
  });

  it("T-SCROLL.MOCK.3b: resolves at one 120ms timer when every RAF is suppressed", async () => {
    // Given no RAF callback fires; When the sole timer wins; Then the expression resolves without the outer CDP deadline.
    const harness = makeHarness("down", 300);
    await flushMicrotasks();
    assert.deepEqual(
      harness.timers.map(({ ms }) => ms),
      [120],
    );
    harness.timers[0]?.callback();
    await flushMicrotasks();
    const result = await harness.outcome;
    assert.equal(result.state, "moved");
  });

  it("T-SCROLL.MOCK.3c: the same timer still bounds the chain after RAF1 fires while RAF2 is suppressed", async () => {
    // Given RAF1 fires but RAF2 never does; When the original timer wins; Then no unbounded RAF2 await remains.
    const harness = makeHarness("down", 300);
    await flushMicrotasks();
    assert.deepEqual(
      harness.timers.map(({ ms }) => ms),
      [120],
    );
    await fireNextRaf(harness);
    assert.equal(harness.rafs.length, 1, "RAF2 must be queued and intentionally left suppressed");
    harness.timers[0]?.callback();
    await flushMicrotasks();
    const result = await harness.outcome;
    assert.equal(result.state, "moved");
    assert.equal(harness.timers.length, 1, "must not create a per-frame timer");
  });

  it("T-SCROLL.MOCK.4: reports signed horizontal movement and partial clamping honestly", async () => {
    // Given horizontal range with only 150px capacity; When right 300 executes; Then actual delta is +150 and success.
    const harness = makeHarness("right", 300, {
      scrollWidth: 1000,
      clientWidth: 800,
      scrollLeft: 50,
      scrollHeight: 600,
    });
    await fireNextRaf(harness);
    await fireNextRaf(harness);
    const result = await harness.outcome;
    assert.equal(result.state, "moved");
    assert.equal(result.axis, "x");
    assert.equal(result.beforeX, 50);
    assert.equal(result.afterX, 200);
    assert.equal(result.deltaX, 150);
    assert.equal(result.deltaY, 0);
  });
});
