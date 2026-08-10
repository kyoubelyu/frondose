/**
 * P-OPEN-SOURCE-SPLIT Step 5a — navigate load-wait race fix.
 *
 * Defect (tool_navigation_failure): CdpClient.navigate awaited Page.navigate and only
 * THEN subscribed to Page.loadEventFired. A same-URL or cache-warm navigation can fire
 * the load event before that subscription exists → the event is missed → full-timeout
 * stall (observed live 2026-08-06 as the Wikipedia navigate "hang"). Same-document
 * navigations (fragment/anchor — CDP omits loaderId) never fire a load event at all.
 *
 * Fix: subscribe BEFORE Page.navigate (createLoadEventWaiter) + skip the wait when
 * the navigate response omits loaderId.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { CdpCallAbortedError } from "../../src/cdp/raced.js";
import { WaitTimeoutError } from "../../src/cdp/types.js";
import { createLoadEventWaiter } from "../../src/cdp/waitFor.js";

type LoadHandler = () => void;

interface FakePageOpts {
  /** What Page.navigate resolves. loaderId undefined simulates a same-document navigation. */
  navigateResult?: Record<string, unknown>;
  /** Fire registered load handlers synchronously INSIDE Page.navigate (before its promise
   *  resolves) — the fast same-URL/cache-warm load that a post-navigate subscription misses. */
  fireLoadDuringNavigate?: boolean;
  callLog?: string[];
}

function makeNavFakeHandle(opts: FakePageOpts = {}) {
  const loadHandlers = new Set<LoadHandler>();
  let unsubscribeCount = 0;
  const lifecycleHandlers = new Set<(ev: { name: string }) => void>();
  const log = opts.callLog;
  const handle = {
    Page: {
      enable: async () => {
        log?.push("Page.enable");
      },
      navigate: async (_args: { url: string }) => {
        log?.push("Page.navigate");
        if (opts.fireLoadDuringNavigate) {
          for (const cb of [...loadHandlers]) cb();
        }
        return opts.navigateResult ?? { frameId: "F1", loaderId: "L1" };
      },
      loadEventFired: (cb: LoadHandler) => {
        log?.push("Page.loadEventFired");
        loadHandlers.add(cb);
        return () => {
          unsubscribeCount++;
          loadHandlers.delete(cb);
        };
      },
      setLifecycleEventsEnabled: async (_args: unknown) => {
        log?.push("Page.setLifecycleEventsEnabled");
      },
      lifecycleEvent: (cb: (ev: { name: string }) => void) => {
        log?.push("Page.lifecycleEvent");
        lifecycleHandlers.add(cb);
        setTimeout(() => cb({ name: "networkIdle" }), 0);
        return () => {
          lifecycleHandlers.delete(cb);
        };
      },
    },
  };
  return {
    handle,
    loadHandlers,
    fireLoad: () => {
      for (const cb of [...loadHandlers]) cb();
    },
    unsubscribeCount: () => unsubscribeCount,
  };
}

function makeClient(handle: unknown): CdpClient {
  const client = CdpClient.fromHandle(handle);
  client.markStealthInjected();
  return client;
}

describe("navigate load-wait (P-OPEN-SOURCE-SPLIT 5a)", () => {
  it("T-NAV5A.1: when the load event fires DURING Page.navigate (before a post-navigate subscription could exist), navigate still resolves", async () => {
    // Given: a fake page whose loadEventFired fires synchronously inside Page.navigate —
    //        under the old subscribe-after-navigate code that event is lost and the wait stalls
    // When:  client.navigate(same-URL-style target)
    // Then:  resolves promptly (the abort guard below is the old-code RED bound: the stalled
    //        wait would reject with CdpCallAbortedError instead of resolving)
    const fake = makeNavFakeHandle({ fireLoadDuringNavigate: true });
    const client = makeClient(fake.handle);
    const ac = new AbortController();
    client.setTurnAbortSignal(ac.signal);
    const guard = setTimeout(() => ac.abort(), 100);
    await client.navigate("https://en.wikipedia.org/wiki/JavaScript");
    clearTimeout(guard);
    assert.ok(true, "navigate resolved via the pre-navigation subscription");
  });

  it("T-NAV5A.2: when Page.navigate omits loaderId (same-document navigation) and no load event fires, navigate resolves promptly and leaves no listener", async () => {
    // Given: a fake page whose navigate resolves WITHOUT loaderId and never fires load
    // When:  client.navigate(fragment/same-document target)
    // Then:  resolves without waiting (old code stalled the full timeout) and the
    //        pre-navigation subscription is cancelled (listener detached)
    const fake = makeNavFakeHandle({ navigateResult: { frameId: "F1" } });
    const client = makeClient(fake.handle);
    const ac = new AbortController();
    client.setTurnAbortSignal(ac.signal);
    const guard = setTimeout(() => ac.abort(), 100);
    await client.navigate("https://en.wikipedia.org/wiki/JavaScript#see-also");
    clearTimeout(guard);
    assert.equal(fake.loadHandlers.size, 0, "same-document skip must cancel the waiter (no dangling listener)");
    assert.ok(fake.unsubscribeCount() >= 1, "waiter cancel must unsubscribe from loadEventFired");
  });

  it("T-NAV5A.3: when loaderId is present and the load event fires AFTER the navigate response, navigate resolves (normal-path regression pin)", async () => {
    // Given: a normal cross-document navigation (loaderId) whose load event arrives late
    // When:  client.navigate, firing the event on the next tick
    // Then:  resolves
    const fake = makeNavFakeHandle();
    const client = makeClient(fake.handle);
    const nav = client.navigate("https://en.wikipedia.org/wiki/JavaScript");
    setTimeout(() => fake.fireLoad(), 0);
    await nav;
    assert.ok(true, "normal navigation still resolves on the post-response load event");
  });

  it("T-NAV5A.4: when loaderId is present and the load event never fires, the wait stays armed (abort rejects with CdpCallAbortedError labeled waitForLoad)", async () => {
    // Given: a real navigation (loaderId) whose load event never arrives
    // When:  the turn abort signal fires mid-wait
    // Then:  rejects with CdpCallAbortedError("waitForLoad") — proving the same-document
    //        skip did NOT disable waiting for real navigations
    const fake = makeNavFakeHandle(); // loaderId present, event never fired
    const client = makeClient(fake.handle);
    const ac = new AbortController();
    client.setTurnAbortSignal(ac.signal);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(
      () => client.navigate("https://en.wikipedia.org/wiki/JavaScript"),
      (err: unknown) => {
        assert.ok(err instanceof CdpCallAbortedError, `expected CdpCallAbortedError, got ${String(err)}`);
        assert.equal(err.label, "waitForLoad");
        return true;
      },
    );
  });

  it("T-NAV5A.5: when Page.navigate reports errorText, navigate throws and the pre-navigation subscription is cancelled", async () => {
    // Given: a navigation that fails at the CDP layer (errorText)
    // When:  client.navigate
    // Then:  throws "navigate failed: ..." and no loadEventFired listener leaks
    const fake = makeNavFakeHandle({ navigateResult: { errorText: "net::ERR_ABORTED" } });
    const client = makeClient(fake.handle);
    await assert.rejects(
      () => client.navigate("https://en.wikipedia.org/wiki/JavaScript"),
      /navigate failed: net::ERR_ABORTED/,
    );
    assert.equal(fake.loadHandlers.size, 0, "errorText path must cancel the waiter");
    assert.ok(fake.unsubscribeCount() >= 1, "errorText path must unsubscribe");
  });

  it("T-NAV5A.6: the networkidle wait keeps its POST-navigate subscription (lifecycleEvent replays state on enable — subscribe-first would be a stale-resolve hazard)", async () => {
    // Given: an explicit waitUntil:"networkidle" navigation with a call-order log
    // When:  client.navigate(url, "networkidle")
    // Then:  setLifecycleEventsEnabled + lifecycleEvent subscriptions happen AFTER
    //        Page.navigate, and navigate resolves on the replayed/fresh networkIdle
    const callLog: string[] = [];
    const fake = makeNavFakeHandle({ callLog });
    const client = makeClient(fake.handle);
    await client.navigate("https://example.com/", "networkidle");
    assert.deepEqual(callLog, [
      "Page.enable",
      "Page.navigate",
      "Page.setLifecycleEventsEnabled",
      "Page.lifecycleEvent",
    ]);
  });
});

describe("createLoadEventWaiter (P-OPEN-SOURCE-SPLIT 5a)", () => {
  it("T-NAV5A.7: cancel() before the event resolves the promise and detaches the listener", async () => {
    // Given: a waiter subscribed on a fake page
    // When:  cancel() is called before any event
    // Then:  the promise resolves (not rejects) and the listener is detached
    const fake = makeNavFakeHandle();
    const waiter = createLoadEventWaiter(fake.handle as never);
    waiter.cancel();
    await waiter.promise;
    assert.equal(fake.loadHandlers.size, 0);
    fake.fireLoad(); // post-cancel event fire is a no-op (must not throw)
  });

  it("T-NAV5A.8: a registered event resolves the waiter", async () => {
    // Given: a waiter subscribed on a fake page
    // When:  the load event fires
    // Then:  the promise resolves
    const fake = makeNavFakeHandle();
    const waiter = createLoadEventWaiter(fake.handle as never);
    setTimeout(() => fake.fireLoad(), 0);
    await waiter.promise;
    assert.ok(true, "resolved on loadEventFired");
  });

  it("T-NAV5A.9: when neither event nor cancel arrives, the waiter rejects with WaitTimeoutError after the timeout", async () => {
    // Given: a waiter with a 50ms timeout and no event
    // When:  the timeout elapses
    // Then:  rejects with WaitTimeoutError (inner backstop preserved)
    const fake = makeNavFakeHandle();
    const waiter = createLoadEventWaiter(fake.handle as never, { timeout: 50 });
    await assert.rejects(
      () => waiter.promise,
      (err: unknown) => {
        assert.ok(err instanceof WaitTimeoutError, `expected WaitTimeoutError, got ${String(err)}`);
        return true;
      },
    );
    assert.equal(fake.loadHandlers.size, 0, "timeout must unsubscribe");
  });
});
