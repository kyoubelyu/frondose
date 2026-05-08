/**
 * P-2 / v0.3-fix1 mock tests — T-M1..T-M3 + T-V031.1..T-V031.4
 *
 * T-M1: If Chrome is already live on the port (probe succeeds via an in-process
 *        HTTP server), ensureChrome returns launched:false with kill:undefined.
 * T-M2: If the probe fails (no server on port), ensureChrome calls launchFn and
 *        returns launched:true with a kill function. Uses __setLaunchFn DI hook
 *        (per guardian CONCERN-MR-4) to mock chrome-launcher without mock.module().
 * T-M3: Composite — kill is undefined on reuse, function on launch.
 *
 * T-V031.1: waitForPageTarget returns first page target when list immediately has one.
 * T-V031.2: waitForPageTarget retries until target appears (2 empty → 3rd has page).
 * T-V031.3: waitForPageTarget falls back to CDP.New after max attempts exhausted.
 * T-V031.4: waitForPageTarget throws when CDP.New returns no webSocketDebuggerUrl.
 *
 * No real Chrome spawned.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch as chromeLaunch } from "chrome-launcher";
import { __setLaunchFn, __setListFn, __setNewFn, ensureChrome, waitForPageTarget } from "../../src/cdp/launcher.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Find a free port by binding briefly to port 0. */
async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

/**
 * Start a minimal HTTP server on the given port that responds to GET /json/version
 * with a Chrome-like JSON payload (enough to make CDP.Version resolve).
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

/** Close the HTTP server and wait for it to stop. */
async function stopServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// Ensure the real launch function is restored after all tests in this file.
after(() => {
  __setLaunchFn(chromeLaunch);
});

// ─── T-M1 ─────────────────────────────────────────────────────────────────────

test("T-M1: ensureChrome reuses an existing Chrome on the requested port", async () => {
  const port = await getFreePort();
  const server = await startFakeChromeServer(port);
  const profileDir = mkdtempSync(join(tmpdir(), "mai-test-t1-"));

  try {
    const handle = await ensureChrome({ port, profileDir });

    assert.equal(handle.launched, false, "must return launched:false for probe-success path");
    assert.equal(handle.port, port, "must echo back the requested port");
    assert.equal(handle.kill, undefined, "must not provide a kill function on reuse path");
  } finally {
    await stopServer(server);
    rmSync(profileDir, { recursive: true, force: true });
  }
});

// ─── T-M2 ─────────────────────────────────────────────────────────────────────

test("T-M2: ensureChrome launches Chrome when probe fails", async () => {
  // Use a very high ephemeral port that is almost certainly NOT in use.
  // If it happens to be in use, the probe will succeed and the test will fail—
  // that's acceptable because it's an environment issue, not a code defect.
  const port = 49000 + Math.floor(Math.random() * 1000);
  const profileDir = mkdtempSync(join(tmpdir(), "mai-test-t2-"));

  let launchCalled = false;
  let capturedOpts: Record<string, unknown> = {};

  // Inject fake launch function via DI hook (guardian CONCERN-MR-4 pattern)
  // biome-ignore lint/suspicious/noExplicitAny: test mock requires type cast to match LaunchFn signature
  __setLaunchFn(async (opts: any) => {
    launchCalled = true;
    capturedOpts = { ...opts };
    return {
      pid: 999,
      port: opts?.port ?? port,
      kill: () => {},
      // chrome-launcher LaunchedChrome.process and remoteDebuggingPipes are not
      // used by ensureChrome; supply minimal stubs to satisfy the type.
      process: null as unknown as import("child_process").ChildProcess,
      remoteDebuggingPipes: null,
    };
  });

  try {
    const handle = await ensureChrome({ port, profileDir });

    assert.ok(launchCalled, "chrome-launcher.launch must have been invoked");
    assert.equal(handle.launched, true, "must return launched:true when Chrome was spawned");
    assert.equal(handle.port, port, "must echo back the port from the launched result");
    assert.equal(typeof handle.kill, "function", "must provide a kill function on launch path");

    // Verify the options passed to the launch function
    assert.equal(capturedOpts.port, port, "launch must receive the requested port");
    assert.equal(capturedOpts.userDataDir, profileDir, "launch must receive the profileDir as userDataDir");
    assert.ok(Array.isArray(capturedOpts.chromeFlags), "launch must receive chromeFlags array");
    assert.equal(capturedOpts.handleSIGINT, true, "launch must set handleSIGINT: true");
  } finally {
    // Restore the real chrome-launcher function
    __setLaunchFn(chromeLaunch);
    rmSync(profileDir, { recursive: true, force: true });
  }
});

// ─── T-M3 ─────────────────────────────────────────────────────────────────────

test("T-M3: ChromeHandle.kill is undefined on reuse, function on launch", async () => {
  // Reuse path: kill === undefined
  const reusePort = await getFreePort();
  const reuseServer = await startFakeChromeServer(reusePort);
  const reuseDir = mkdtempSync(join(tmpdir(), "mai-test-t3r-"));

  try {
    const reuseHandle = await ensureChrome({ port: reusePort, profileDir: reuseDir });
    assert.equal(reuseHandle.kill, undefined, "reuse handle must have kill:undefined");
  } finally {
    await stopServer(reuseServer);
    rmSync(reuseDir, { recursive: true, force: true });
  }

  // Launch path: kill is a function
  const launchPort = 49100 + Math.floor(Math.random() * 500);
  const launchDir = mkdtempSync(join(tmpdir(), "mai-test-t3l-"));

  // biome-ignore lint/suspicious/noExplicitAny: test mock requires type cast
  __setLaunchFn(async (opts: any) => ({
    pid: 998,
    port: opts?.port ?? launchPort,
    kill: () => {},
    process: null as unknown as import("child_process").ChildProcess,
    remoteDebuggingPipes: null,
  }));

  try {
    const launchHandle = await ensureChrome({ port: launchPort, profileDir: launchDir });
    assert.equal(typeof launchHandle.kill, "function", "launch handle must have kill as a function");
  } finally {
    __setLaunchFn(chromeLaunch);
    rmSync(launchDir, { recursive: true, force: true });
  }
});

// ─── v0.3-fix1: waitForPageTarget DI mock tests ───────────────────────────────

/**
 * Default no-op fns to restore after each waitForPageTarget test.
 * These parallel the defaults in launcher.ts — they never succeed against real
 * Chrome since there's no server running, but they're never called after restore.
 */
function restoreListNewFns(): void {
  // Restore to no-op stubs (avoids importing CDP in test code).
  // Real launcher.ts defaults call CDP.List / CDP.New, but tests always set their
  // own hooks before calling waitForPageTarget.
  __setListFn(async () => []);
  __setNewFn(async () => ({}));
}

// ─── T-V031.1 ─────────────────────────────────────────────────────────────────

test("T-V031.1: waitForPageTarget returns first page target when list immediately has one", async () => {
  const fakePage = {
    id: "page-abc",
    type: "page" as const,
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-abc",
    title: "New Tab",
  };

  let listCallCount = 0;
  let newCallCount = 0;

  __setListFn(async () => {
    listCallCount++;
    return [fakePage];
  });
  __setNewFn(async () => {
    newCallCount++;
    return {};
  });

  try {
    const result = await waitForPageTarget(9222);

    assert.equal(result.id, "page-abc", "must return the page target id");
    assert.equal(result.webSocketDebuggerUrl, fakePage.webSocketDebuggerUrl, "must return the webSocketDebuggerUrl");
    assert.equal(result.type, "page", "must have type=page");
    assert.equal(listCallCount, 1, "list must be called exactly once (target found immediately)");
    assert.equal(newCallCount, 0, "CDP.New must NOT be called when list succeeds");
  } finally {
    restoreListNewFns();
  }
});

// ─── T-V031.2 ─────────────────────────────────────────────────────────────────

test(
  "T-V031.2: waitForPageTarget retries until target appears (2 empty then 1 with page)",
  { timeout: 10_000 },
  async () => {
    const fakePage = {
      id: "page-retry",
      type: "page" as const,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-retry",
      title: "",
    };

    let listCallCount = 0;

    __setListFn(async () => {
      listCallCount++;
      if (listCallCount <= 2) return []; // First two calls: no page targets
      return [fakePage]; // Third call: page target appears
    });
    __setNewFn(async () => {
      throw new Error("CDP.New must not be called in T-V031.2");
    });

    try {
      const start = Date.now();
      const result = await waitForPageTarget(9222);
      const elapsed = Date.now() - start;

      assert.equal(result.id, "page-retry", "must return the page target id");
      assert.equal(listCallCount, 3, "must have polled list exactly 3 times (2 empty + 1 success)");
      // 2 retries × 300ms interval = ~600ms minimum
      assert.ok(elapsed >= 550, `elapsed must be ≥550ms (got ${elapsed}ms) to confirm real retries occurred`);
    } finally {
      restoreListNewFns();
    }
  },
);

// ─── T-V031.3 ─────────────────────────────────────────────────────────────────

test(
  "T-V031.3: waitForPageTarget falls back to CDP.New after max attempts exhausted",
  { timeout: 40_000 },
  async () => {
    const fakeNewPage = {
      id: "new-page",
      type: "page" as const,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/new-page",
      title: "",
    };

    let listCallCount = 0;
    let newCallCount = 0;

    // Always return empty or non-page targets to exhaust all 10 attempts
    __setListFn(async () => {
      listCallCount++;
      // Return a background_page (non-"page" type) to also exercise the type filter
      return [{ id: "bg", type: "background_page", webSocketDebuggerUrl: "ws://bg", title: "" }];
    });
    __setNewFn(async () => {
      newCallCount++;
      return fakeNewPage;
    });

    try {
      const result = await waitForPageTarget(9222);

      assert.equal(result.id, "new-page", "must return the CDP.New result");
      assert.equal(result.webSocketDebuggerUrl, fakeNewPage.webSocketDebuggerUrl);
      assert.equal(listCallCount, 10, "list must be called exactly TARGET_POLL_MAX_ATTEMPTS (10) times");
      assert.equal(newCallCount, 1, "CDP.New must be called exactly once after max attempts");
    } finally {
      restoreListNewFns();
    }
  },
);

// ─── T-V031.4 ─────────────────────────────────────────────────────────────────

test(
  "T-V031.4: waitForPageTarget throws when CDP.New returns no webSocketDebuggerUrl",
  { timeout: 40_000 },
  async () => {
    __setListFn(async () => []);
    // CDP.New returns a target without webSocketDebuggerUrl
    __setNewFn(async () => ({ id: "bad-target", type: "page", title: "" }));

    try {
      await assert.rejects(
        () => waitForPageTarget(9222),
        /CDP\.New.*webSocketDebuggerUrl/,
        "must throw with an error mentioning CDP.New and webSocketDebuggerUrl",
      );
    } finally {
      restoreListNewFns();
    }
  },
);
