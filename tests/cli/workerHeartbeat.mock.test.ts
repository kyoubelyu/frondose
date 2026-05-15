/**
 * P-26 Step 5 — T-HB.1..3
 *
 * Tests for startWorkerHeartbeat background loop.
 * Gate coverage: G-P26.24
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startWorkerHeartbeat } from "../../src/cli/workerHeartbeat.js";
import { __resetSafeModeState, getLastHeartbeatMs } from "../../src/persistence/safeModeState.js";

const COORDS = { serverUrl: "http://test-server:3031", token: "tok", workerId: "w1" };

describe("startWorkerHeartbeat (G-P26.24)", () => {
  it("T-HB.1: when fetch resolves 200 on first tick, recordHeartbeatSuccess() is called; Authorization header sent", async () => {
    // Given: startWorkerHeartbeat(serverCoords, abortSignal); fetch mocked to return 200
    // When:  first setTimeout(0) fires
    // Then:  fetch called with /api/heartbeat; Authorization: Bearer <token>; recordHeartbeatSuccess called
    __resetSafeModeState();
    let capturedUrl = "";
    let capturedAuth = "";
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedAuth = ((opts.headers ?? {}) as Record<string, string>).Authorization ?? "";
      return { ok: true as const, status: 200 };
    };
    try {
      const controller = new AbortController();
      startWorkerHeartbeat(COORDS, controller.signal);
      // Wait for setTimeout(0) + async fetch to complete
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      assert.ok(capturedUrl.includes("/api/heartbeat"), `T-HB.1: URL must include /api/heartbeat; got: ${capturedUrl}`);
      assert.equal(capturedAuth, "Bearer tok", "T-HB.1: Authorization header must be 'Bearer tok'");
      const hbMs = getLastHeartbeatMs();
      assert.ok(
        hbMs > 0 && Date.now() - hbMs < 5000,
        `T-HB.1: recordHeartbeatSuccess() should set a recent timestamp; got ${hbMs}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      __resetSafeModeState();
    }
  });

  it("T-HB.2: when fetch throws (network error), no throw to caller; recordHeartbeatSuccess NOT called", async () => {
    // Given: fetch mocked to throw
    // When:  tick fires
    // Then:  startWorkerHeartbeat does not throw; lastSuccessfulHeartbeatMs unchanged (0)
    __resetSafeModeState();
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      const controller = new AbortController();
      // Must not throw — startWorkerHeartbeat catches errors silently
      startWorkerHeartbeat(COORDS, controller.signal);
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      assert.equal(getLastHeartbeatMs(), 0, "T-HB.2: lastSuccessfulHeartbeatMs must stay 0 when fetch throws");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      __resetSafeModeState();
    }
  });

  it("T-HB.3: when abortSignal aborted before first tick, fetch is never called", async () => {
    // Given: abortController.abort() called before startWorkerHeartbeat
    // When:  tick would fire (via setTimeout(0))
    // Then:  fetch not called; no re-schedule
    __resetSafeModeState();
    let fetchCalled = false;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      return { ok: true };
    };
    try {
      const controller = new AbortController();
      controller.abort(); // abort BEFORE startWorkerHeartbeat
      startWorkerHeartbeat(COORDS, controller.signal);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(fetchCalled, false, "T-HB.3: fetch must not be called when signal is already aborted");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      __resetSafeModeState();
    }
  });
});
