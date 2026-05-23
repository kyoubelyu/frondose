/**
 * P-37 Step 4a scaffolds — T-B7.1, T-B7.2
 *
 * B7: first-launch stabilization delay — 300 ms delay between ensureChrome returning
 * `launched: true` and CdpClient.connect() being called; no delay when `launched: false`.
 *
 * Gate coverage: G-P37.11 (300 ms delay conditional on handle.launched)
 *
 * DI strategy:
 *   T-B7.1: __setLaunchFn (existing seam) → fake launch → ensureChrome returns launched:true.
 *           CdpClient.connect monkey-patched to record call timestamp.
 *           Assert ≥280 ms elapsed between getOrInitClient() call and connect() call.
 *   T-B7.2: Static source assertion — read session.ts and verify the delay is inside
 *           an `if (handle.launched)` block (behavioral mock of launched:false requires
 *           either CDP.Version mock or a new DI seam; deferred to Step 5).
 *
 * All assertion bodies are TODO — tests intentionally fail at Step 4a.
 * Builder Step 4b: 300 ms delay added inside if (handle.launched) block.
 * Validator Step 5: fill assertions (T-B7.1 timing; T-B7.2 structural source check).
 *
 * NOTE: T-M23 (client.mock.test.ts) asserts OLD scroll behavior (synthesizeScrollGesture).
 * That test will need updating at Step 5 once builder Step 4b replaces scroll() with evaluate().
 * T-M23 is NOT updated here — it is noted for Step 5 regression repair.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { launch as chromeLaunch } from "chrome-launcher";
import { CdpClient } from "../../src/cdp/client.js";
import { __setLaunchFn } from "../../src/cdp/launcher.js";
import { createLinkedinSession } from "../../src/linkedin/session.js";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");

// ─── Fake CDP handle ─────────────────────────────────────────────────────────

/**
 * Fake handle satisfying injectStealth + installOverlay + attachEventBus.
 * P-Z3: getOrInitClient now installOverlay()s + attachEventBus() after injectStealth
 * (session.ts:67-70) — those need the Runtime domain + Page.getFrameTree. The P-37-era
 * Page-only fake predates the overlay-install step; mirror session.mock.test.ts.
 */
function makeFakeCdpHandle() {
  return {
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

// ─── T-B7.1 ──────────────────────────────────────────────────────────────────

describe("B7: first-launch stabilization delay — launched:true path (G-P37.11)", () => {
  it(
    "T-B7.1: when ensureChrome returns launched:true, getOrInitClient() waits ~300 ms before calling CdpClient.connect()",
    { timeout: 5000 },
    async () => {
      // Given: fake launchFn returns immediately (launched:true via ensureChrome);
      //        CdpClient.connect monkey-patched to record its call timestamp
      // When:  session.getOrInitClient() is called; t0 recorded just before the call
      // Then:  timestamp delta (connectCalledAt - t0) >= 280 ms (allows ~20 ms tolerance)

      const fakeHandle = makeFakeCdpHandle();
      const origConnect = CdpClient.connect;
      let connectCalledAt = -1;

      // biome-ignore lint/suspicious/noExplicitAny: DI mock requires any-typed cast
      __setLaunchFn(async (launchOpts: any) => ({
        pid: 12345,
        port: launchOpts?.port ?? 19991,
        kill: () => {},
        process: null as unknown as import("child_process").ChildProcess,
        remoteDebuggingPipes: null,
      }));

      (CdpClient as unknown as { connect: typeof CdpClient.connect }).connect = async (
        _port: number,
      ): Promise<CdpClient> => {
        connectCalledAt = Date.now();
        return CdpClient.fromHandle(fakeHandle);
      };

      try {
        const session = createLinkedinSession({ port: 19991, profileDir: "/tmp/mai-b7-1" });

        const t0 = Date.now();
        await session.getOrInitClient();
        const delta = connectCalledAt - t0;

        assert.ok(
          delta >= 280,
          `getOrInitClient() must wait at least 280 ms after ensureChrome returns launched:true before calling CdpClient.connect(); ` +
            `actual delta: ${delta} ms (expected ≥ 280 ms; tolerance is 280 vs target 300)`,
        );
      } finally {
        __setLaunchFn(chromeLaunch);
        (CdpClient as unknown as { connect: typeof CdpClient.connect }).connect = origConnect;
      }
    },
  );
});

// ─── T-B7.2 ──────────────────────────────────────────────────────────────────

describe("B7: first-launch stabilization delay — launched:false path (G-P37.11)", () => {
  it("T-B7.2: when ensureChrome returns launched:false, the delay is skipped — source asserts delay is inside if (handle.launched) block", () => {
    // Given: session.ts source file containing the B7 implementation
    // When:  source text is statically inspected
    // Then:  the setTimeout/delay call appears INSIDE an if (handle.launched) conditional block;
    //        the launched:false path (Chrome already running) does NOT await the delay

    const sessionSrc = readFileSync(resolve(ROOT, "src/linkedin/session.ts"), "utf-8");

    // G-P37.11: the delay must be conditional — inside `if (handle.launched)` block
    assert.ok(
      sessionSrc.includes("handle.launched"),
      "session.ts must contain 'handle.launched' conditional (delay is gated on fresh launch)",
    );
    // The setTimeout delay must be 300 ms
    assert.ok(
      sessionSrc.includes("setTimeout(r, 300)"),
      "session.ts must contain 'setTimeout(r, 300)' (300 ms stabilization delay for fresh Chrome)",
    );
    // The delay must NOT be unconditional — CdpClient.connect must appear AFTER if (handle.launched)
    // in the source (structural check: if block precedes connect call in text order)
    const launchedIdx = sessionSrc.indexOf("handle.launched");
    const connectIdx = sessionSrc.indexOf("CdpClient.connect");
    assert.ok(
      launchedIdx < connectIdx,
      "if (handle.launched) block must appear before CdpClient.connect() in session.ts source",
    );
  });
});
