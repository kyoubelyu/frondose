/**
 * P-3 / v0.3-fix1 mock tests — T-M54..T-M55 + T-V031.6..T-V031.10
 * ISSUE-ENSURECHROME-ORPHAN mock tests — T-Orphan.1..T-Orphan.6
 *
 * T-M54: getClient() returns undefined before any getOrInitClient() call.
 * T-M55: setLastContext / getLastContext round-trip still works on lazy session.
 * T-V031.6..T-V031.10: lazy factory semantics (boot-once, cache, dedup, retry).
 *
 * T-Orphan.1..3b: direct unit tests on the exported reapOnBootFailure() helper
 *   — deliberately exercised with "poisoned" handle shapes (e.g. launched:false
 *   with a kill spy present) that never occur through the real ensureChrome()
 *   reuse path (which always returns kill:undefined). A real reused handle
 *   can't make a guard regression observable — see FM-1 critic finding in
 *   docs/phase-ensurechrome-orphan-plan.md.
 * T-Orphan.4..6: integration tests through the full getOrInitClient() boot
 *   path (launch path, real reuse path via a fake HTTP /json/version server,
 *   and concurrent dedup), proving the original error object (not a copy) is
 *   what callers see and that kill is invoked exactly once per shared failure.
 *
 * DI strategy: __setLaunchFn stubs ensureChrome's launch path.
 * CdpClient.connect is monkey-patched to return a fromHandle(fakeHandle) client,
 * bypassing waitForPageTarget + real WebSocket entirely.
 * injectStealth is exercised via a minimal fake CDP handle (Page.enable +
 * Page.addScriptToEvaluateOnNewDocument). No real Chrome or LLM required.
 *
 * NOTE: This file modifies module-level mutable state (CdpClient.connect) for
 * test isolation. Each test installs and restores the mock via installMockBootHooks.
 * Tests in this file MUST be run sequentially (default for node:test).
 */

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { launch as chromeLaunch } from "chrome-launcher";
import { CdpClient } from "../../src/cdp/client.js";
import { __setLaunchFn } from "../../src/cdp/launcher.js";
import { createLinkedinSession, reapOnBootFailure } from "../../src/linkedin/session.js";
import type { ClientOrUnavailable, CurrentSurfaceContext } from "../../src/linkedin/types.js";

/** Find a guaranteed-free ephemeral port by briefly binding to port 0. */
function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

// ─── Fake CDP handle ─────────────────────────────────────────────────────────

/**
 * Build a fake CdpHandle that satisfies the methods called by injectStealth:
 *   Page.enable, Page.addScriptToEvaluateOnNewDocument.
 */
function makeFakeCdpHandle() {
  return {
    // P-Z3: getOrInitClient now also installOverlay()s + attachEventBus() after injectStealth
    // (session.ts:67-70) — those need the Runtime domain + Page.getFrameTree. The P-v031-era
    // Page-only fake predates the overlay-install step. Mirror the serve-p57b fake handle.
    Runtime: {
      enable: async () => {},
      addBinding: async () => {},
      executionContextCreated: () => () => {},
      // biome-ignore lint/suspicious/noExplicitAny: handler-capture stub
      bindingCalled: (_h: any) => () => {},
      callFunctionOn: async () => ({ result: { value: null } }),
    },
    Page: {
      enable: async () => {},
      addScriptToEvaluateOnNewDocument: async (_args: unknown) => ({ identifier: "mock-id" }),
      getFrameTree: async () => ({ frameTree: { frame: { id: "main-1" } } }),
    },
  };
}

// ─── DI boot hook ────────────────────────────────────────────────────────────

/**
 * Install DI stubs so getOrInitClient() completes without a real Chrome process
 * or WebSocket. Returns a teardown fn that restores the originals.
 *
 * Mechanism:
 *   1. __setLaunchFn → stubs the chrome-launcher path inside ensureChrome.
 *      (ensureChrome's CDP.Version probe on a free port fails → falls through to launch.)
 *   2. CdpClient.connect is monkey-patched to return fromHandle(fakeHandle)
 *      directly, bypassing waitForPageTarget + CDP WebSocket connection.
 *   3. injectStealth(client.handle) is exercised via the fake handle methods above.
 */
function installMockBootHooks(
  fakeHandle: ReturnType<typeof makeFakeCdpHandle>,
  opts: {
    launchCallCount?: { count: number };
    /** Throw on the FIRST launchFn call; succeed on subsequent calls. */
    failFirstLaunch?: boolean;
    /** ISSUE-ENSURECHROME-ORPHAN: reject CdpClient.connect() with this exact
     *  error object on its next call — simulates a post-spawn boot failure. */
    failConnectWith?: Error;
    /** ISSUE-ENSURECHROME-ORPHAN: tracks kill() invocations on the mock
     *  launched-Chrome handle. */
    killCallCount?: { count: number };
  } = {},
): () => void {
  let firstLaunch = true;
  let connectShouldFail = Boolean(opts.failConnectWith);
  const origConnect = CdpClient.connect;

  // biome-ignore lint/suspicious/noExplicitAny: DI mock requires any-typed opts
  __setLaunchFn(async (launchOpts: any) => {
    if (opts.launchCallCount) opts.launchCallCount.count++;
    if (opts.failFirstLaunch && firstLaunch) {
      firstLaunch = false;
      throw new Error("Mock Chrome launch failed");
    }
    firstLaunch = false;
    return {
      pid: 12345,
      port: launchOpts?.port ?? 19999,
      kill: () => {
        if (opts.killCallCount) opts.killCallCount.count++;
      },
      process: null as unknown as import("child_process").ChildProcess,
      remoteDebuggingPipes: null,
    };
  });

  // Monkey-patch CdpClient.connect: bypass waitForPageTarget + CDP WebSocket.
  // P-Z3: getOrInitClient's cache-reuse check is `cached?.isConnected()` (session.ts:53).
  // A fromHandle() client has no real WebSocket so isConnected() is false → the 2nd call
  // would re-boot. Override isConnected()=true on the returned client so the cache is
  // reused (T-V031.7) and concurrent dedupe holds (T-V031.8).
  (CdpClient as unknown as { connect: typeof CdpClient.connect }).connect = async (
    _port: number,
  ): Promise<CdpClient> => {
    // ISSUE-ENSURECHROME-ORPHAN: simulate a post-spawn (or post-reuse) boot
    // failure exactly once — the SAME error object every subsequent call would
    // reuse if not for the flag flip, so a concurrent-dedup boot only sees it once.
    if (connectShouldFail) {
      connectShouldFail = false;
      throw opts.failConnectWith;
    }
    const c = CdpClient.fromHandle(fakeHandle);
    (c as unknown as { isConnected: () => boolean }).isConnected = () => true;
    return c;
  };

  return () => {
    __setLaunchFn(chromeLaunch);
    (CdpClient as unknown as { connect: typeof CdpClient.connect }).connect = origConnect;
  };
}

// ─── ISSUE-ENSURECHROME-ORPHAN: fake /json/version server (real reuse path) ───

/**
 * Start a minimal HTTP server on the given port that responds to GET /json/version
 * with a Chrome-like JSON payload — enough to make ensureChrome()'s CDP.Version
 * probe succeed, driving the real (unmocked) reused-Chrome branch (launched:false,
 * kill:undefined). Mirrors tests/cdp/launcher.mock.test.ts's T-M1 helper.
 */
async function startFakeChromeServer(port: number): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        Browser: "Chrome/120.0.0.0",
        "Protocol-Version": "1.3",
        "User-Agent": "fake",
        "V8-Version": "12.0.0",
        "WebKit-Version": "537.36",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
      }),
    );
  });
  return new Promise<http.Server>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ─── T-M54 ─────────────────────────────────────────────────────────────────────

test("T-M54: createLinkedinSession getClient() returns undefined before any boot call", () => {
  const session = createLinkedinSession({ port: 19999, profileDir: "/tmp/mai-t54" });
  assert.equal(
    session.getClient(),
    undefined,
    "getClient() must return undefined before getOrInitClient() is ever called",
  );
});

// ─── T-M55 ─────────────────────────────────────────────────────────────────────

test("T-M55: setLastContext / getLastContext round-trip; getLastContext returns undefined before first set", () => {
  const session = createLinkedinSession({ port: 19999, profileDir: "/tmp/mai-t55" });

  assert.equal(session.getLastContext(), undefined, "getLastContext must be undefined before first setLastContext");

  const ctx: CurrentSurfaceContext = {
    pageUrl: "https://www.linkedin.com/feed/",
    surface: "feed",
    activeLayer: "page",
    entries: [{ ref: "@e1", role: "button", name: "Post" }],
  };

  session.setLastContext(ctx);
  assert.strictEqual(session.getLastContext(), ctx, "getLastContext must return the exact context set");
  assert.equal(session.getLastContext()?.surface, "feed");

  const ctx2: CurrentSurfaceContext = {
    pageUrl: "https://www.linkedin.com/messaging/",
    surface: "messaging",
    activeLayer: "page",
    entries: [],
  };
  session.setLastContext(ctx2);
  assert.strictEqual(session.getLastContext(), ctx2, "getLastContext must return the most-recently set context");
});

// ─── T-V031.6 ─────────────────────────────────────────────────────────────────

test("T-V031.6: first getOrInitClient() boots Chrome once and returns a CdpClient", async () => {
  const fakeHandle = makeFakeCdpHandle();
  const launchCallCount = { count: 0 };
  const restore = installMockBootHooks(fakeHandle, { launchCallCount });
  const freePort = await getFreePort();

  try {
    const session = createLinkedinSession({ port: freePort, profileDir: "/tmp/mai-tv031-6" });

    // P-23: getOrInitClient returns ClientOrUnavailable; unwrap the .client from ok=true result
    const result = (await session.getOrInitClient()) as ClientOrUnavailable;
    assert.strictEqual(result.ok, true, "getOrInitClient must succeed (ok=true)");
    const client = (result as { ok: true; client: CdpClient }).client;
    assert.ok(client instanceof CdpClient, "getOrInitClient must return a CdpClient instance");
    assert.equal(launchCallCount.count, 1, "ensureChrome launchFn must be called exactly once");
  } finally {
    restore();
  }
});

// ─── T-V031.7 ─────────────────────────────────────────────────────────────────

test("T-V031.7: second getOrInitClient() returns the cached client without re-booting", async () => {
  const fakeHandle = makeFakeCdpHandle();
  const launchCallCount = { count: 0 };
  const restore = installMockBootHooks(fakeHandle, { launchCallCount });
  const freePort = await getFreePort();

  try {
    const session = createLinkedinSession({ port: freePort, profileDir: "/tmp/mai-tv031-7" });

    // P-23: unwrap ClientOrUnavailable to compare inner CdpClient references
    const result1 = (await session.getOrInitClient()) as ClientOrUnavailable;
    const result2 = (await session.getOrInitClient()) as ClientOrUnavailable;
    assert.strictEqual(result1.ok, true, "first call must succeed");
    assert.strictEqual(result2.ok, true, "second call must succeed");
    const client1 = (result1 as { ok: true; client: CdpClient }).client;
    const client2 = (result2 as { ok: true; client: CdpClient }).client;
    assert.strictEqual(client1, client2, "second call must return the exact same CdpClient reference");
    assert.equal(launchCallCount.count, 1, "ensureChrome must be called exactly once (cached on second call)");
  } finally {
    restore();
  }
});

// ─── T-V031.8 ─────────────────────────────────────────────────────────────────

test("T-V031.8: concurrent getOrInitClient() calls dedupe to a single boot", async () => {
  const fakeHandle = makeFakeCdpHandle();
  const launchCallCount = { count: 0 };
  const restore = installMockBootHooks(fakeHandle, { launchCallCount });
  const freePort = await getFreePort();

  try {
    const session = createLinkedinSession({ port: freePort, profileDir: "/tmp/mai-tv031-8" });

    // P-23: unwrap ClientOrUnavailable from concurrent calls; compare inner CdpClient
    const [result1, result2] = await Promise.all([
      session.getOrInitClient() as Promise<ClientOrUnavailable>,
      session.getOrInitClient() as Promise<ClientOrUnavailable>,
    ]);
    assert.strictEqual(result1.ok, true, "first concurrent call must succeed");
    assert.strictEqual(result2.ok, true, "second concurrent call must succeed");
    const client1 = (result1 as { ok: true; client: CdpClient }).client;
    const client2 = (result2 as { ok: true; client: CdpClient }).client;
    assert.strictEqual(client1, client2, "both concurrent calls must resolve to the same CdpClient");
    assert.equal(launchCallCount.count, 1, "ensureChrome must be called exactly once (deduped concurrent calls)");
  } finally {
    restore();
  }
});

// ─── T-V031.9 ─────────────────────────────────────────────────────────────────

test("T-V031.9: failed boot resets initPromise so next call retries", async () => {
  const fakeHandle = makeFakeCdpHandle();
  const launchCallCount = { count: 0 };
  const restore = installMockBootHooks(fakeHandle, { launchCallCount, failFirstLaunch: true });
  const freePort = await getFreePort();

  try {
    const session = createLinkedinSession({ port: freePort, profileDir: "/tmp/mai-tv031-9" });

    // First call: launchFn throws → getOrInitClient() rejects
    await assert.rejects(() => session.getOrInitClient(), /Mock Chrome launch failed/, "first call must reject");

    assert.equal(launchCallCount.count, 1, "launchFn was called once for the failed attempt");
    assert.equal(session.getClient(), undefined, "getClient() must still be undefined after a failed boot");

    // Second call: launchFn succeeds (initPromise was reset by the failure handler)
    // P-23: unwrap ClientOrUnavailable
    const result = (await session.getOrInitClient()) as ClientOrUnavailable;
    assert.strictEqual(result.ok, true, "second call must succeed after the failed first attempt");
    const client = (result as { ok: true; client: CdpClient }).client;
    assert.ok(client instanceof CdpClient, "second call must succeed after the failed first attempt");
    assert.equal(launchCallCount.count, 2, "launchFn must be called again on retry");
  } finally {
    restore();
  }
});

// ─── T-V031.10 ────────────────────────────────────────────────────────────────

test("T-V031.10: getClient() returns undefined before getOrInitClient, then the cached client after", async () => {
  const fakeHandle = makeFakeCdpHandle();
  const restore = installMockBootHooks(fakeHandle);
  const freePort = await getFreePort();

  try {
    const session = createLinkedinSession({ port: freePort, profileDir: "/tmp/mai-tv031-10" });

    assert.equal(session.getClient(), undefined, "getClient() must be undefined before getOrInitClient()");

    // P-23: unwrap ClientOrUnavailable; getClient() still returns CdpClient directly
    const result = (await session.getOrInitClient()) as ClientOrUnavailable;
    assert.strictEqual(result.ok, true, "getOrInitClient must succeed");
    const client = (result as { ok: true; client: CdpClient }).client;
    const cached = session.getClient();

    assert.strictEqual(cached, client, "getClient() must return the same CdpClient after getOrInitClient()");
    assert.ok(cached instanceof CdpClient, "cached client must be a CdpClient instance");
  } finally {
    restore();
  }
});

// ─── ISSUE-ENSURECHROME-ORPHAN: T-Orphan.1..3b — reapOnBootFailure() unit tests ─

test("T-Orphan.1: reapOnBootFailure calls kill() exactly once when handle.launched === true", async () => {
  let killCalls = 0;
  const handle = {
    port: 19999,
    launched: true,
    kill: async () => {
      killCalls++;
    },
  };
  await reapOnBootFailure(handle);
  assert.equal(killCalls, 1, "kill must be called exactly once for a launched handle");
});

test(
  "T-Orphan.2: reapOnBootFailure NEVER calls kill() when handle.launched === false, " +
    "even if a kill fn is present (poisoned test handle — proves the guard, not kill's presence, gates the call)",
  async () => {
    let killCalls = 0;
    // A real reused ChromeHandle always has kill:undefined (launcher.ts:98); this shape
    // is deliberately unrealistic so the test is sensitive to a `launched` guard regression
    // (a real reused handle can't distinguish "guarded" from "unguarded optional call").
    const handle = {
      port: 19999,
      launched: false,
      kill: async () => {
        killCalls++;
      },
    };
    await reapOnBootFailure(handle);
    assert.equal(
      killCalls,
      0,
      "kill must never be called on a reused (launched:false) handle — that's the operator's own browser",
    );
  },
);

test("T-Orphan.3: reapOnBootFailure swallows a kill() failure and logs it (does not throw)", async () => {
  const origConsoleError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const handle = {
      port: 19999,
      launched: true,
      kill: async () => {
        throw new Error("kill boom");
      },
    };
    await assert.doesNotReject(() => reapOnBootFailure(handle), "a kill() failure must be swallowed, not thrown");
    assert.ok(
      logs.some((l) => String(l[0]).includes("kill failed")),
      "must log the kill failure",
    );
  } finally {
    console.error = origConsoleError;
  }
});

test(
  "T-Orphan.3b: reapOnBootFailure logs an invariant violation (and does not throw) " +
    "when launched === true but kill is undefined (broken handle)",
  async () => {
    const origConsoleError = console.error;
    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      const handle = { port: 19999, launched: true, kill: undefined };
      await assert.doesNotReject(() => reapOnBootFailure(handle));
      assert.ok(
        logs.some((l) => String(l[0]).includes("broken handle")),
        "must log the invariant violation",
      );
    } finally {
      console.error = origConsoleError;
    }
  },
);

// ─── T-Orphan.4..6 — integration through getOrInitClient()'s boot path ────────

test(
  "T-Orphan.4: post-spawn CdpClient.connect() failure reaps the spawned Chrome " +
    "and propagates the ORIGINAL error object unchanged",
  async () => {
    const bootError = new Error("mock post-spawn boot failure");
    const launchCallCount = { count: 0 };
    const killCallCount = { count: 0 };
    const restore = installMockBootHooks(makeFakeCdpHandle(), {
      launchCallCount,
      killCallCount,
      failConnectWith: bootError,
    });
    const freePort = await getFreePort();

    try {
      const session = createLinkedinSession({ port: freePort, profileDir: "/tmp/mai-torphan-4" });
      let caught: unknown;
      try {
        await session.getOrInitClient();
        assert.fail("getOrInitClient must reject");
      } catch (err) {
        caught = err;
      }
      assert.strictEqual(caught, bootError, "must propagate the exact original error object, not a replacement");
      assert.equal(launchCallCount.count, 1, "Chrome must have been spawned (launched:true path)");
      assert.equal(killCallCount.count, 1, "the spawned Chrome must be reaped exactly once");
    } finally {
      restore();
    }
  },
);

test(
  "T-Orphan.5: reused-Chrome path (real ensureChrome probe succeeds, launched:false) — " +
    "post-ensureChrome failure propagates unchanged and launchFn is never called",
  async () => {
    const bootError = new Error("mock post-spawn boot failure (reused Chrome)");
    const port = await getFreePort();
    const server = await startFakeChromeServer(port);
    const launchCallCount = { count: 0 };
    const restore = installMockBootHooks(makeFakeCdpHandle(), {
      launchCallCount,
      failConnectWith: bootError,
    });

    try {
      const session = createLinkedinSession({ port, profileDir: "/tmp/mai-torphan-5" });
      let caught: unknown;
      try {
        await session.getOrInitClient();
        assert.fail("getOrInitClient must reject");
      } catch (err) {
        caught = err;
      }
      assert.strictEqual(caught, bootError, "must propagate the exact original error object");
      assert.equal(
        launchCallCount.count,
        0,
        "launchFn must NEVER be called on the reuse path (real ensureChrome CDP.Version probe succeeded)",
      );
    } finally {
      restore();
      await stopServer(server);
    }
  },
);

test(
  "T-Orphan.6: concurrent getOrInitClient() calls sharing one post-spawn failure — " +
    "one launch, one kill, both reject with the identical error object",
  async () => {
    const bootError = new Error("mock post-spawn boot failure (concurrent)");
    const launchCallCount = { count: 0 };
    const killCallCount = { count: 0 };
    const restore = installMockBootHooks(makeFakeCdpHandle(), {
      launchCallCount,
      killCallCount,
      failConnectWith: bootError,
    });
    const freePort = await getFreePort();

    try {
      const session = createLinkedinSession({ port: freePort, profileDir: "/tmp/mai-torphan-6" });

      const results = await Promise.allSettled([session.getOrInitClient(), session.getOrInitClient()]);

      assert.equal(results[0].status, "rejected", "first concurrent call must reject");
      assert.equal(results[1].status, "rejected", "second concurrent call must reject");
      const err1 = (results[0] as PromiseRejectedResult).reason;
      const err2 = (results[1] as PromiseRejectedResult).reason;
      assert.strictEqual(err1, bootError, "first caller must reject with the exact original error");
      assert.strictEqual(err2, bootError, "second caller must reject with the exact original error (deduped)");
      assert.equal(launchCallCount.count, 1, "launchFn must be called exactly once (deduped concurrent calls)");
      assert.equal(killCallCount.count, 1, "kill must be called exactly once (single shared reap)");
    } finally {
      restore();
    }
  },
);
