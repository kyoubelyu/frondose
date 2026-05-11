/**
 * P-11 Step 5 — T-Lock.1..T-Lock.5 (filled assertions)
 *
 * TurnLock Promise-chain mutex (src/agent/turnSemaphore.ts).
 * Gate coverage: G-P11.1 (all T-Lock tests)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TurnLock } from "../../src/agent/turnSemaphore.js";

// ─── T-Lock: TurnLock serialization ───────────────────────────────────────────

describe("TurnLock Promise-chain mutex (G-P11.1)", () => {
  it("T-Lock.1: when asyncFn1 and asyncFn2 are queued synchronously AND asyncFn1 resolves after 50ms, asyncFn2 starts ONLY after asyncFn1 resolves (delta ≥ 50ms)", async () => {
    // Given: fresh TurnLock + fn1 sleeps 50ms + fn2 records its own start time
    // When: both queued back-to-back via lock.run()
    // Then: fn2 start timestamp − fn1 start timestamp >= 50ms (serialized, not parallel)
    const lock = new TurnLock();
    const fn1Start = Date.now();
    let fn2Start = 0;

    const p1 = lock.run(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const p2 = lock.run(async () => {
      fn2Start = Date.now();
    });

    await Promise.all([p1, p2]);
    const delta = fn2Start - fn1Start;
    assert.ok(delta >= 45, `fn2 must start ≥ 45ms after fn1 queued (serialized); delta=${delta}ms`);
  });

  it("T-Lock.2: when asyncFn1 THROWS AND asyncFn2 is queued after, outer1 rejects with fn1 error AND fn2 still runs normally (chain advances)", async () => {
    // Given: fn1 throws Error("boom"); fn2 pushes "ran" to shared array
    // When: both queued; outer1 awaited with try/catch; outer2 awaited
    // Then: outer1 rejected with "boom"; fn2 ran (array includes "ran")
    const lock = new TurnLock();
    const ran: string[] = [];

    const p1 = lock.run(async () => {
      throw new Error("boom");
    });
    const p2 = lock.run(async () => {
      ran.push("ran");
    });

    await assert.rejects(p1, (err: Error) => {
      assert.equal(err.message, "boom");
      return true;
    });
    await p2;
    assert.deepEqual(ran, ["ran"], "fn2 must run after fn1 throws (chain advances)");
  });

  it("T-Lock.3: when 100 fns are queued in a tight loop each pushing their index, the shared array equals [0,1,...,99] (FIFO order)", async () => {
    // Given: 100 async fns each pushing their loop index to a shared array
    // When: all queued via lock.run() in a tight for-loop
    // Then: array equals [0, 1, 2, ..., 99] after all Promises settle
    const lock = new TurnLock();
    const order: number[] = [];

    const promises = Array.from({ length: 100 }, (_, i) =>
      lock.run(async () => {
        order.push(i);
      }),
    );
    await Promise.all(promises);

    assert.deepEqual(
      order,
      Array.from({ length: 100 }, (_, i) => i),
      "TurnLock must preserve FIFO order across 100 queued fns",
    );
  });

  it("T-Lock.4: when lock.run<T>(fn) is given a fn returning T, the outer Promise resolves to that exact T value (generic forwarding correct)", async () => {
    // Given: fn returns the string "ping"
    // When: lock.run(() => Promise.resolve("ping")) awaited
    // Then: result === "ping"
    const lock = new TurnLock();
    const result = await lock.run(async () => "ping");
    assert.equal(result, "ping", "TurnLock must forward the resolved value T");
  });

  it("T-Lock.5: when lock.run(inner) is called inside another lock.run body (recursive acquisition), the inner call does NOT resolve within 500ms (deadlock guard — 500ms per NIT-A Step 3b)", async () => {
    // Given: outer fn queues inner via lock.run and awaits it → deadlock
    // When: Promise.race([innerPromise, 500ms sleep])
    // Then: race winner === "timeout" (inner never starts while outer holds the chain)
    const lock = new TurnLock();

    let innerPromise: Promise<string> | null = null;
    // Signal when innerPromise has been set (outer has started running)
    let signalInnerSet!: () => void;
    const innerSetP = new Promise<void>((r) => {
      signalInnerSet = r;
    });

    // outer fn calls lock.run(inner) and awaits it — creating a circular dependency
    const outerPromise = lock.run(async () => {
      // Queue inner INSIDE the outer body
      innerPromise = lock.run(async () => "inner-done");
      signalInnerSet(); // notify: innerPromise is now set
      // Await inner inside outer → deadlock:
      //   outer won't release until innerPromise resolves,
      //   but innerPromise can't start until outer releases.
      await innerPromise;
    });
    void outerPromise; // intentionally not awaited — it deadlocks

    // Wait until outer has started and set innerPromise
    await innerSetP;

    const result = await Promise.race([
      (innerPromise as Promise<string>).then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 500)),
    ]);
    assert.equal(result, "timeout", "Inner lock.run inside outer must deadlock (≥500ms no resolution)");
  });
});
