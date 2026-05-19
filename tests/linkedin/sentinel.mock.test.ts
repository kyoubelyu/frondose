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
import { type ClientOrUnavailable, createLinkedinSession } from "../../src/linkedin/index.js";

// ─── Sentinel tests ───────────────────────────────────────────────────────────

describe("linkedin/sentinel: chromeAcquireGuard gate on getOrInitClient", () => {
  it("T-LINKEDIN.1: when chromeAcquireGuard returns false (daemon, repl.pid alive), getOrInitClient returns chrome_unavailable sentinel", async () => {
    // Given:  createLinkedinSession called with chromeAcquireGuard = () => false (simulates REPL alive)
    // When:   session.getOrInitClient() is awaited
    // Then:   returns { ok: false, error: 'chrome_unavailable', message: 'REPL holds Chrome lock...' }
    //         (no Chrome boot attempted; no exception thrown)
    const session = createLinkedinSession({
      port: 9222,
      profileDir: "/tmp/fake-profile",
      chromeAcquireGuard: () => false,
    });
    const result = (await session.getOrInitClient()) as ClientOrUnavailable;
    assert.strictEqual(result.ok, false, "must return ok=false sentinel");
    assert.strictEqual((result as { ok: false; error: string }).error, "chrome_unavailable");
    assert.ok(typeof (result as { ok: false; message: string }).message === "string", "must include a message");
  });

  it("T-LINKEDIN.2: when chromeAcquireGuard returns true, getOrInitClient proceeds to Chrome boot path (throws, not sentinel)", async () => {
    // Given:  createLinkedinSession called with chromeAcquireGuard = () => true
    //         No real Chrome at port 19999 → Chrome boot throws (ECONNREFUSED or similar)
    // When:   session.getOrInitClient() is awaited
    // Then:   throws an Error (Chrome boot error, NOT a chrome_unavailable sentinel);
    //         i.e. guard=true does NOT short-circuit to sentinel
    const session = createLinkedinSession({
      port: 19999, // no Chrome listening here
      profileDir: "/tmp/fake-profile-no-chrome",
      chromeAcquireGuard: () => true,
    });
    // Must throw (Chrome boot fails) but NOT return {ok:false, error:'chrome_unavailable'}
    try {
      const result = (await session.getOrInitClient()) as ClientOrUnavailable;
      // If for some reason it returns a value, it must NOT be the unavailable sentinel
      assert.notStrictEqual(
        (result as { ok: false; error: string }).error,
        "chrome_unavailable",
        "guard=true must not produce chrome_unavailable sentinel",
      );
    } catch (e) {
      // Expected: Chrome boot throws (ECONNREFUSED or launcher error)
      assert.ok(e instanceof Error, "must throw an Error (not return sentinel)");
    }
  });

  it("T-LINKEDIN.3: when no chromeAcquireGuard provided (REPL mode), getOrInitClient preserves existing behavior (throws on boot fail, not sentinel)", async () => {
    // Given:  createLinkedinSession called with NO chromeAcquireGuard (default undefined = guard bypassed)
    // When:   session.getOrInitClient() is awaited (no real Chrome at port 19998)
    // Then:   throws a Chrome boot error (same as pre-P23 behavior); no regression from guard addition
    const session = createLinkedinSession({
      port: 19998, // no Chrome
      profileDir: "/tmp/fake-profile-no-guard",
      // No chromeAcquireGuard — preserves pre-P23 behavior
    });
    try {
      const result = (await session.getOrInitClient()) as ClientOrUnavailable;
      // If returns, must not be chrome_unavailable
      assert.notStrictEqual(
        (result as { ok: false; error: string }).error,
        "chrome_unavailable",
        "no guard must not produce chrome_unavailable sentinel",
      );
    } catch (e) {
      // Expected: throws (Chrome not running at test port)
      assert.ok(e instanceof Error, "must throw when Chrome unavailable (pre-P23 behavior)");
    }
  });
});
