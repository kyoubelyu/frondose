/**
 * P-2 mock tests — T-M12..T-M17: waitForUrl / waitForLoad / waitForText / waitForFn.
 *
 * Uses a fake CRI-style event client:
 * - Event subscriptions: client.Page.frameNavigated(cb) → returns unsubscribe fn
 * - `Runtime.evaluate` stubbed to return controlled sequences.
 *
 * No real Chrome required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { WaitTimeoutError } from "../../src/cdp/types.js";
import { waitForFn, waitForLoad, waitForText, waitForUrl } from "../../src/cdp/waitFor.js";

// ─── Event-emitter helper ─────────────────────────────────────────────────────

/** Mimics CRI's event subscription: call to subscribe returns unsubscribe fn. */
function makeEventSource<T>() {
  const handlers = new Set<(params: T) => void>();
  const subscribe = (handler: (params: T) => void): (() => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  };
  const emit = (params: T): void => {
    for (const h of handlers) h(params);
  };
  return { subscribe, emit };
}

// ─── T-M12 ─────────────────────────────────────────────────────────────────────

test("T-M12: waitForUrl resolves on matching Page.frameNavigated", async () => {
  const frameNavigated = makeEventSource<{ frame: { url: string } }>();
  const client = {
    Page: {
      frameNavigated: frameNavigated.subscribe,
    },
  };

  const p = waitForUrl(client, /example\.com/);

  // Non-matching navigation: must NOT resolve the promise
  frameNavigated.emit({ frame: { url: "https://other.com/page" } });

  // Matching navigation: must resolve
  frameNavigated.emit({ frame: { url: "https://example.com/foo" } });

  await p; // If the promise doesn't resolve, the test will hang until timeout (test runner kills it)
});

// ─── T-M13 ─────────────────────────────────────────────────────────────────────

test("T-M13: waitForLoad('load') resolves on Page.loadEventFired", async () => {
  const loadEventFired = makeEventSource<undefined>();
  const client = {
    Page: {
      loadEventFired: loadEventFired.subscribe,
    },
  };

  const p = waitForLoad(client, "load");
  loadEventFired.emit(undefined);
  await p;
});

// ─── T-M14 ─────────────────────────────────────────────────────────────────────

test("T-M14: waitForLoad('networkidle') calls setLifecycleEventsEnabled then resolves on lifecycleEvent name=networkIdle", async () => {
  const lifecycleEvent = makeEventSource<{ name: string }>();
  let lifecycleEventsEnabled = false;
  let setLifecycleCalled = false;

  const client = {
    Page: {
      setLifecycleEventsEnabled: async ({ enabled }: { enabled: boolean }) => {
        setLifecycleCalled = true;
        lifecycleEventsEnabled = enabled;
      },
      lifecycleEvent: lifecycleEvent.subscribe,
    },
  };

  // Start the wait — setLifecycleEventsEnabled is awaited before the listener registers
  const p = waitForLoad(client, "networkidle");

  // Yield one microtask tick so the internal await setLifecycleEventsEnabled resolves
  await Promise.resolve();

  assert.ok(setLifecycleCalled, "Page.setLifecycleEventsEnabled must have been called");
  assert.equal(lifecycleEventsEnabled, true, "enabled must be true");

  // A non-matching lifecycle event must NOT resolve the promise
  lifecycleEvent.emit({ name: "firstPaint" });

  // The matching event must resolve
  lifecycleEvent.emit({ name: "networkIdle" });
  await p;
});

// ─── T-M15 ─────────────────────────────────────────────────────────────────────

test("T-M15: waitForText polls Runtime.evaluate until result.value === true", async () => {
  const evaluateCalls: Array<{ expression: string; returnByValue: boolean }> = [];
  let callCount = 0;

  const client = {
    Runtime: {
      evaluate: async (params: { expression: string; returnByValue: boolean }) => {
        evaluateCalls.push(params);
        callCount++;
        // Return false for first 2 calls, true on 3rd
        return { result: { value: callCount >= 3 } };
      },
    },
  };

  // Use a very short pollInterval so the test completes quickly
  await waitForText(client, "hello", { pollInterval: 5, timeout: 2000 });

  // Must have polled at least 3 times
  assert.ok(callCount >= 3, `must poll at least 3 times; got ${callCount}`);

  // Expression must include JSON.stringify("hello") for safe string embedding
  const lastExpr = evaluateCalls[evaluateCalls.length - 1]?.expression ?? "";
  assert.ok(
    lastExpr.includes(JSON.stringify("hello")),
    `expression must include JSON.stringify("hello"); got: ${lastExpr}`,
  );
});

// ─── T-M16 ─────────────────────────────────────────────────────────────────────

test("T-M16: waitForFn polls Runtime.evaluate with awaitPromise:true and returnByValue:true", async () => {
  const evaluateCalls: Array<{ expression: string; returnByValue?: boolean; awaitPromise?: boolean }> = [];
  let callCount = 0;

  const client = {
    Runtime: {
      evaluate: async (params: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }) => {
        evaluateCalls.push(params);
        callCount++;
        return { result: { value: callCount >= 3 } };
      },
    },
  };

  await waitForFn(client, "window.ready === true", { pollInterval: 5, timeout: 2000 });

  assert.ok(callCount >= 3, `must poll at least 3 times; got ${callCount}`);

  // Every call must have awaitPromise: true and returnByValue: true
  for (const call of evaluateCalls) {
    assert.equal(call.awaitPromise, true, "every evaluate call must have awaitPromise:true");
    assert.equal(call.returnByValue, true, "every evaluate call must have returnByValue:true");
  }

  // Expression must pass through unchanged
  assert.ok(
    evaluateCalls[0]?.expression === "window.ready === true",
    "expression must be passed through to Runtime.evaluate",
  );
});

// ─── T-M17 ─────────────────────────────────────────────────────────────────────

test("T-M17: all four wait primitives reject with WaitTimeoutError after timeout", async () => {
  // Fake clients that never fire the matching condition
  const neverClient = {
    Page: {
      frameNavigated: (_cb: unknown) => () => {},
      loadEventFired: (_cb: unknown) => () => {},
      setLifecycleEventsEnabled: async () => {},
      lifecycleEvent: (_cb: unknown) => () => {},
    },
    Runtime: {
      evaluate: async () => ({ result: { value: false } }),
    },
  };

  // waitForUrl — timeout 50ms
  await assert.rejects(
    waitForUrl(neverClient, "never-matches", { timeout: 50 }),
    (err: unknown) => err instanceof WaitTimeoutError && (err as Error).message.toLowerCase().includes("waitforurl"),
    "waitForUrl must reject with WaitTimeoutError",
  );

  // waitForLoad("load") — timeout 50ms
  await assert.rejects(
    waitForLoad(neverClient, "load", { timeout: 50 }),
    (err: unknown) => err instanceof WaitTimeoutError && (err as Error).message.toLowerCase().includes("waitforload"),
    "waitForLoad('load') must reject with WaitTimeoutError",
  );

  // waitForLoad("networkidle") — timeout 50ms
  await assert.rejects(
    waitForLoad(neverClient, "networkidle", { timeout: 50 }),
    (err: unknown) => err instanceof WaitTimeoutError && (err as Error).message.toLowerCase().includes("waitforload"),
    "waitForLoad('networkidle') must reject with WaitTimeoutError",
  );

  // waitForText — timeout 50ms
  await assert.rejects(
    waitForText(neverClient, "never-text", { timeout: 50, pollInterval: 10 }),
    (err: unknown) => err instanceof WaitTimeoutError && (err as Error).message.toLowerCase().includes("waitfortext"),
    "waitForText must reject with WaitTimeoutError",
  );

  // waitForFn — timeout 50ms
  await assert.rejects(
    waitForFn(neverClient, "false", { timeout: 50, pollInterval: 10 }),
    (err: unknown) => err instanceof WaitTimeoutError && (err as Error).message.toLowerCase().includes("waitforfn"),
    "waitForFn must reject with WaitTimeoutError",
  );
});
