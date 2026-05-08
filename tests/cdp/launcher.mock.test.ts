/**
 * P-2 mock tests — T-M1..T-M3: ensureChrome() reuse-vs-launch behavior.
 *
 * T-M1: If Chrome is already live on the port (probe succeeds via an in-process
 *        HTTP server), ensureChrome returns launched:false with kill:undefined.
 * T-M2: If the probe fails (no server on port), ensureChrome calls launchFn and
 *        returns launched:true with a kill function. Uses __setLaunchFn DI hook
 *        (per guardian CONCERN-MR-4) to mock chrome-launcher without mock.module().
 * T-M3: Composite — kill is undefined on reuse, function on launch.
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
import { __setLaunchFn, ensureChrome } from "../../src/cdp/launcher.js";

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
