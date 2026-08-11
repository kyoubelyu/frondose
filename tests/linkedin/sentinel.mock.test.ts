/**
 * P-23 Step 4a scaffold — T-LINKEDIN.1..3
 *
 * LinkedIn-tool gate: createLinkedinSession gains optional chromeAcquireGuard parameter;
 * getOrInitClient returns ClientOrUnavailable sentinel when guard returns false.
 * (src/linkedin/session.ts + src/linkedin/types.ts EDIT at builder Step 4b per plan §6.5.)
 *
 * Gate coverage: G-P23.7
 *
 * All assertion bodies are TODO. Builder must make scaffolds reach assert.fail at Step 4b.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { launch as chromeLaunch } from "chrome-launcher";
import { __setLaunchFn } from "../../src/cdp/launcher.js";
import { type ClientOrUnavailable, createLinkedinSession } from "../../src/linkedin/index.js";

// ─── Sentinel tests ───────────────────────────────────────────────────────────

function installNonBrowserLaunch(port: number): { launches: { count: number }; kills: { count: number } } {
  const launches = { count: 0 };
  const kills = { count: 0 };
  __setLaunchFn(async () => {
    launches.count++;
    return {
      pid: 12345,
      port,
      kill: () => {
        kills.count++;
      },
      process: null as unknown as import("node:child_process").ChildProcess,
      remoteDebuggingPipes: null,
    };
  });
  return { launches, kills };
}

describe("linkedin/sentinel: chromeAcquireGuard gate on getOrInitClient", () => {
  it("T-LINKEDIN.1: when chromeAcquireGuard returns false (daemon, repl.pid alive), getOrInitClient returns chrome_unavailable sentinel", async () => {
    // Given:  createLinkedinSession called with chromeAcquireGuard = () => false (simulates REPL alive)
    // When:   session.getOrInitClient() is awaited
    // Then:   returns { ok: false, error: 'chrome_unavailable', message: 'REPL holds Chrome lock...' }
    //         (no Chrome boot attempted; no exception thrown)
    const owner = installNonBrowserLaunch(19997);
    try {
      const session = createLinkedinSession({
        port: 19997,
        profileDir: "/tmp/fake-profile",
        chromeAcquireGuard: () => false,
      });
      const result = (await session.getOrInitClient()) as ClientOrUnavailable;
      assert.strictEqual(result.ok, false, "must return ok=false sentinel");
      assert.strictEqual((result as { ok: false; error: string }).error, "chrome_unavailable");
      assert.ok(typeof (result as { ok: false; message: string }).message === "string", "must include a message");
      assert.deepEqual(owner, { launches: { count: 0 }, kills: { count: 0 } });
    } finally {
      __setLaunchFn(chromeLaunch);
    }
  });

  it("T-LINKEDIN.2: when chromeAcquireGuard returns true, getOrInitClient proceeds to Chrome boot path (throws, not sentinel)", async () => {
    // Given:  createLinkedinSession called with chromeAcquireGuard = () => true
    //         No real Chrome at port 19999 → Chrome boot throws (ECONNREFUSED or similar)
    // When:   session.getOrInitClient() is awaited
    // Then:   throws an Error (Chrome boot error, NOT a chrome_unavailable sentinel);
    //         i.e. guard=true does NOT short-circuit to sentinel
    const owner = installNonBrowserLaunch(19999);
    try {
      const session = createLinkedinSession({
        port: 19999,
        profileDir: "/tmp/fake-profile-no-chrome",
        chromeAcquireGuard: () => true,
      });
      await assert.rejects(session.getOrInitClient(), Error);
      assert.deepEqual(owner, { launches: { count: 1 }, kills: { count: 1 } });
    } finally {
      __setLaunchFn(chromeLaunch);
    }
  });

  it("T-LINKEDIN.3: when no chromeAcquireGuard provided (REPL mode), getOrInitClient preserves existing behavior (throws on boot fail, not sentinel)", async () => {
    // Given:  createLinkedinSession called with NO chromeAcquireGuard (default undefined = guard bypassed)
    // When:   session.getOrInitClient() is awaited (no real Chrome at port 19998)
    // Then:   throws a Chrome boot error (same as pre-P23 behavior); no regression from guard addition
    const owner = installNonBrowserLaunch(19998);
    try {
      const session = createLinkedinSession({
        port: 19998,
        profileDir: "/tmp/fake-profile-no-guard",
        // No chromeAcquireGuard — preserves pre-P23 behavior
      });
      await assert.rejects(session.getOrInitClient(), Error);
      assert.deepEqual(owner, { launches: { count: 1 }, kills: { count: 1 } });
    } finally {
      __setLaunchFn(chromeLaunch);
    }
  });
});
