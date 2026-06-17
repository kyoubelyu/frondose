/**
 * WIN-7 Step 2 scaffold — T-WIN7.Profile.1..2
 *
 * These tests pin the clean-profile launch contract from docs/phase-win-7-plan.md.
 * They are intentionally red at scaffold time: T-WIN7.Profile.1 fails against
 * current code because ensureChrome does not create a missing profile directory
 * before chrome-launcher runs; after Step 4 reaches the contract, both tests hit
 * the TODO assertion branches for Step 5 to fill.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { launch as chromeLaunch } from "chrome-launcher";
import { __setLaunchFn, ensureChrome } from "../../src/cdp/launcher.js";
import { cleanupTmpDir } from "../_helpers/tmp";

type LaunchedChrome = Awaited<ReturnType<typeof chromeLaunch>>;
type LaunchOptions = Parameters<typeof chromeLaunch>[0];

let tmpDirs: string[] = [];

afterEach(() => {
  __setLaunchFn(chromeLaunch);
  for (const dir of tmpDirs) cleanupTmpDir(dir);
  tmpDirs = [];
});

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

async function startFakeChromeServer(port: number): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        Browser: "Chrome/120.0.0.0",
        "Protocol-Version": "1.3",
        "User-Agent": "fake-win7",
        "V8-Version": "12.0.0",
        "WebKit-Version": "537.36",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/win7`,
      }),
    );
  });
  return new Promise<http.Server>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

async function stopServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function makeMissingProfileDir(): string {
  const root = mkdtempSync(join(tmpdir(), "win7-clean-profile-"));
  tmpDirs.push(root);
  return join(root, "chrome-profile");
}

function fakeLaunchedChrome(port: number): LaunchedChrome {
  return {
    pid: 707,
    port,
    kill: () => {},
    process: null as unknown as ChildProcess,
    remoteDebuggingPipes: null,
  };
}

describe("WIN-7 clean Chrome profile launch behavior", () => {
  it("T-WIN7.Profile.1: when launching with a nonexistent profile directory, ensureChrome creates it before chrome-launcher runs", async () => {
    // Given: a nonexistent profileDir and fake launchFn that checks the directory at call time; When: ensureChrome takes the launch path; Then: the directory exists before launch and userDataDir is unchanged.
    const port = await getFreePort();
    const profileDir = makeMissingProfileDir();
    assert.equal(existsSync(profileDir), false, "precondition: profileDir must not exist before ensureChrome");

    let launchCallCount = 0;
    let capturedUserDataDir: unknown;
    let sawProfileDirAtLaunch = false;
    const fakeLaunch = (async (opts?: LaunchOptions): Promise<LaunchedChrome> => {
      launchCallCount++;
      capturedUserDataDir = opts?.userDataDir;
      sawProfileDirAtLaunch = existsSync(profileDir);
      return fakeLaunchedChrome(opts?.port ?? port);
    }) as typeof chromeLaunch;
    __setLaunchFn(fakeLaunch);

    const handle = await ensureChrome({ port, profileDir });

    assert.equal(handle.launched, true, "T-WIN7.Profile.1: launch path must return launched:true");
    assert.equal(handle.port, port, "T-WIN7.Profile.1: launch path must preserve the requested port");
    assert.equal(typeof handle.kill, "function", "T-WIN7.Profile.1: launch path must expose a kill function");
    assert.equal(launchCallCount, 1, "T-WIN7.Profile.1: chrome-launcher must be invoked exactly once");
    assert.equal(capturedUserDataDir, profileDir, "T-WIN7.Profile.1: launch userDataDir must equal profileDir");
    assert.equal(
      sawProfileDirAtLaunch,
      true,
      "T-WIN7.Profile.1: profileDir must exist before chrome-launcher is invoked",
    );
    assert.equal(existsSync(profileDir), true, "T-WIN7.Profile.1: profileDir must exist after ensureChrome");
  });

  it("T-WIN7.Profile.2: when reusing an existing Chrome, ensureChrome does not create the unused profile directory", async () => {
    // Given: a fake Chrome /json/version server and nonexistent profileDir; When: ensureChrome takes the reuse path; Then: launched is false and the profileDir remains absent.
    const port = await getFreePort();
    const server = await startFakeChromeServer(port);
    const profileDir = makeMissingProfileDir();
    assert.equal(existsSync(profileDir), false, "precondition: profileDir must not exist before reuse");
    let launchCalled = false;
    const fakeLaunch = (async (opts?: LaunchOptions): Promise<LaunchedChrome> => {
      launchCalled = true;
      return fakeLaunchedChrome(opts?.port ?? port);
    }) as typeof chromeLaunch;
    __setLaunchFn(fakeLaunch);

    try {
      const handle = await ensureChrome({ port, profileDir });

      assert.equal(handle.launched, false, "T-WIN7.Profile.2: reuse path must return launched:false");
      assert.equal(handle.port, port, "T-WIN7.Profile.2: reuse path must preserve the requested port");
      assert.equal(handle.kill, undefined, "T-WIN7.Profile.2: reuse handle must not provide kill");
      assert.equal(launchCalled, false, "T-WIN7.Profile.2: reuse path must not invoke chrome-launcher");
      assert.equal(existsSync(profileDir), false, "T-WIN7.Profile.2: reuse path must not create profileDir");
    } finally {
      await stopServer(server);
    }
  });
});
