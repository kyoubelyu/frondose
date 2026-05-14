/**
 * P-3 / v0.3-fix1 mock tests — T-M54..T-M55 + T-V031.6..T-V031.10
 *
 * T-M54: getClient() returns undefined before any getOrInitClient() call.
 * T-M55: setLastContext / getLastContext round-trip still works on lazy session.
 * T-V031.6..T-V031.10: lazy factory semantics (boot-once, cache, dedup, retry).
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
import { test } from "node:test";
import { launch as chromeLaunch } from "chrome-launcher";
import { CdpClient } from "../../src/cdp/client.js";
import { __setLaunchFn } from "../../src/cdp/launcher.js";
import { createLinkedinSession } from "../../src/linkedin/session.js";
import type { ClientOrUnavailable, CurrentSurfaceContext } from "../../src/linkedin/types.js";

// ─── Fake CDP handle ─────────────────────────────────────────────────────────

/**
 * Build a fake CdpHandle that satisfies the methods called by injectStealth:
 *   Page.enable, Page.addScriptToEvaluateOnNewDocument.
 */
function makeFakeCdpHandle() {
  return {
    Page: {
      enable: async () => {},
      addScriptToEvaluateOnNewDocument: async (_args: unknown) => ({ identifier: "mock-id" }),
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
  } = {},
): () => void {
  let firstLaunch = true;
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
      kill: () => {},
      process: null as unknown as import("child_process").ChildProcess,
      remoteDebuggingPipes: null,
    };
  });

  // Monkey-patch CdpClient.connect: bypass waitForPageTarget + CDP WebSocket
  (CdpClient as unknown as { connect: typeof CdpClient.connect }).connect = async (_port: number): Promise<CdpClient> =>
    CdpClient.fromHandle(fakeHandle);

  return () => {
    __setLaunchFn(chromeLaunch);
    (CdpClient as unknown as { connect: typeof CdpClient.connect }).connect = origConnect;
  };
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

  try {
    const session = createLinkedinSession({ port: 19999, profileDir: "/tmp/mai-tv031-6" });

    // P-23: getOrInitClient returns ClientOrUnavailable; unwrap the .client from ok=true result
    const result = await session.getOrInitClient() as ClientOrUnavailable;
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

  try {
    const session = createLinkedinSession({ port: 19999, profileDir: "/tmp/mai-tv031-7" });

    // P-23: unwrap ClientOrUnavailable to compare inner CdpClient references
    const result1 = await session.getOrInitClient() as ClientOrUnavailable;
    const result2 = await session.getOrInitClient() as ClientOrUnavailable;
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

  try {
    const session = createLinkedinSession({ port: 19999, profileDir: "/tmp/mai-tv031-8" });

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

  try {
    const session = createLinkedinSession({ port: 19999, profileDir: "/tmp/mai-tv031-9" });

    // First call: launchFn throws → getOrInitClient() rejects
    await assert.rejects(() => session.getOrInitClient(), /Mock Chrome launch failed/, "first call must reject");

    assert.equal(launchCallCount.count, 1, "launchFn was called once for the failed attempt");
    assert.equal(session.getClient(), undefined, "getClient() must still be undefined after a failed boot");

    // Second call: launchFn succeeds (initPromise was reset by the failure handler)
    // P-23: unwrap ClientOrUnavailable
    const result = await session.getOrInitClient() as ClientOrUnavailable;
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

  try {
    const session = createLinkedinSession({ port: 19999, profileDir: "/tmp/mai-tv031-10" });

    assert.equal(session.getClient(), undefined, "getClient() must be undefined before getOrInitClient()");

    // P-23: unwrap ClientOrUnavailable; getClient() still returns CdpClient directly
    const result = await session.getOrInitClient() as ClientOrUnavailable;
    assert.strictEqual(result.ok, true, "getOrInitClient must succeed");
    const client = (result as { ok: true; client: CdpClient }).client;
    const cached = session.getClient();

    assert.strictEqual(cached, client, "getClient() must return the same CdpClient after getOrInitClient()");
    assert.ok(cached instanceof CdpClient, "cached client must be a CdpClient instance");
  } finally {
    restore();
  }
});
