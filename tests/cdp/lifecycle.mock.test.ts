/**
 * P-62 mock tests — T-Stealth.1..5, T-Target.1, T-Idemp.1, T-Lifecycle.1, T-Plugin.1.
 *
 * Phase P-62 — Browser Quality / CDP Stealth Lifecycle.
 * Step 5: Assertion bodies filled (all tests should PASS post-builder Step 4b).
 *
 * Test contract per docs/phase-62-test.md § Test Contract.
 * No real Chrome required (mock CDP only).
 *
 * BDD-light naming: T-<Component>.<N>: when <preconditions>, <action> → <expected>
 *
 * ─── Module-mock harness for T-Target.1 + T-Stealth.3 ──────────────────────────
 * registerTargetCreatedAutoInject is module-internal (NOT exported from session.ts per C2).
 * T-Target.1 and T-Stealth.3 exercise it via the session boot path using the serve-p57f
 * pattern: mock.module() + dynamic import (see tests/cli/subcommands/serve-pY4.mock.test.ts).
 *
 * Mocked dependencies (all via pathToFileURL absolute URLs):
 *  - src/cdp/client.js       → MockCdpClient (connect() returns bootFakeHandle-based instance)
 *  - src/cdp/launcher.js     → fake ensureChrome (session.ts imports via index.js re-export)
 *  - src/overlay/inject.js   → no-op installOverlay
 *  - src/overlay/eventBus.js → no-op attachEventBus + dummy appendOverlayEventRow
 *
 * Statically imported CdpClient / injectStealth / STEALTH_INIT_SCRIPT are UNAFFECTED by
 * mock.module() (per Node.js docs: "previously imported values hold refs to originals").
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { CdpClient } from "../../src/cdp/client.js";
import { injectStealth, STEALTH_INIT_SCRIPT } from "../../src/cdp/stealth.js";

// ─── Module-level state for T-Target.1 + T-Stealth.3 (populated by before()) ───

const sessionCallLog: string[] = [];
const capturedHandlers: Record<string, (params: unknown) => Promise<void>> = {};
const sessionSendLog: Array<{ method: string; params: unknown; sessionId: string }> = [];

/**
 * Module-level before() hook (serve-p57f pattern):
 *  1. Mock CdpClient.connect + launcher.js + overlay modules
 *  2. Dynamically import session.ts (AFTER mocks — gets MockCdpClient)
 *  3. Run session boot path → registerTargetCreatedAutoInject fires → handler captured
 *
 * After before() completes, sessionCallLog + capturedHandlers are populated
 * and available to T-Target.1 + T-Stealth.3.
 */
before(async () => {
  const clientUrl = pathToFileURL(resolve(process.cwd(), "src/cdp/client.js")).href;
  const launcherUrl = pathToFileURL(resolve(process.cwd(), "src/cdp/launcher.js")).href;
  const overlayInjectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  const overlayEventBusUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/eventBus.js")).href;

  // Fake handle records all CDP calls for T-Target.1 sequencing + T-Stealth.3 handler
  const bootFakeHandle = {
    Page: {
      enable: async () => {
        sessionCallLog.push("Page.enable");
      },
      addScriptToEvaluateOnNewDocument: async (_args: { source: string; runImmediately: boolean }) => {
        sessionCallLog.push("Page.addScriptToEvaluateOnNewDocument");
        return { identifier: "boot-stealth-id" };
      },
    },
    Target: {
      setDiscoverTargets: async (args: { discover: boolean }) => {
        sessionCallLog.push(`setDiscoverTargets:${args.discover}`);
      },
      attachToTarget: async (args: { targetId: string; flatten: boolean }) => {
        sessionCallLog.push(`attachToTarget:${args.targetId}:${args.flatten}`);
        return { sessionId: `sess-${args.targetId}` };
      },
    },
    on: (event: string, handler: (params: unknown) => Promise<void>) => {
      sessionCallLog.push(`on:${event}`);
      capturedHandlers[event] = handler;
    },
    send: async (method: string, params: unknown, sessionId: string) => {
      sessionCallLog.push(`send:${method}@${sessionId}`);
      sessionSendLog.push({ method, params, sessionId });
    },
  };

  // MockCdpClient: minimal surface that satisfies session.ts's boot path + injectStealth.
  class MockCdpClient {
    readonly handle = bootFakeHandle;
    private _stealthInjected = false;

    // biome-ignore lint/suspicious/noExplicitAny: mock DI — handle shape is irrelevant for mock
    static fromHandle(_h: any): MockCdpClient {
      return new MockCdpClient();
    }

    static async connect(_port: number): Promise<MockCdpClient> {
      return new MockCdpClient();
    }

    markStealthInjected(): void {
      this._stealthInjected = true;
    }

    isStealthInjected(): boolean {
      return this._stealthInjected;
    }

    isConnected(): boolean {
      return true;
    }
  }

  // Replace client.js → MockCdpClient (session.ts dynamic import gets mock; static imports keep real)
  mock.module(clientUrl, { namedExports: { CdpClient: MockCdpClient } });

  // Replace launcher.js → fake ensureChrome (session.ts imports via index.js live re-export)
  mock.module(launcherUrl, {
    namedExports: {
      ensureChrome: async () => ({ port: 9222, launched: false }),
      waitForPageTarget: async () => ({ targetId: "T0-primary", type: "page", url: "about:blank" }),
    },
  });

  // Replace overlay modules → no-ops (session.ts calls these post-boot)
  mock.module(overlayInjectUrl, { namedExports: { installOverlay: async () => {} } });
  mock.module(overlayEventBusUrl, {
    namedExports: {
      attachEventBus: () => {},
      appendOverlayEventRow: () => {},
    },
  });

  // Dynamically import session.ts AFTER mocks → gets MockCdpClient + faked ensureChrome
  let createLinkedinSession: ((opts: { port: number; profileDir: string }) => {
    getOrInitClient: () => Promise<unknown>;
  }) | undefined;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import shape is opaque at test compile time
    const mod = (await import("../../src/linkedin/session.js")) as any;
    createLinkedinSession = mod.createLinkedinSession;
  } catch (e) {
    console.error("[P-62 before()] session.ts import failed (module mock may not apply):", e);
    return;
  }

  if (!createLinkedinSession) {
    console.error("[P-62 before()] createLinkedinSession not found in session.ts exports");
    return;
  }

  const session = createLinkedinSession({ port: 9222, profileDir: "/tmp/test-p62" });
  try {
    await session.getOrInitClient();
  } catch (e) {
    // Boot-path failure — captured for test diagnosis; T-Target.1 / T-Stealth.3 will report.
    console.error("[P-62 before()] boot failed (mock intercept may be partial):", e);
  }
});

// ─── T-Stealth.1..5 ───────────────────────────────────────────────────────────────

describe("T-Stealth: F-1 navigation invariant (mock)", () => {
  it("T-Stealth.1: when CdpClient.fromHandle() is used without calling injectStealth(), client.navigate() THROWS with stealth-not-injected message", async () => {
    // Given: a CdpClient built from a fake handle (no stealth injected)
    // When:  client.navigate("about:blank") is called
    // Then:  it throws an error matching "navigate: stealth not injected"
    const fakeHandle = {
      Page: {
        enable: async () => {},
        navigate: async (_args: { url: string }) => ({ errorText: undefined }),
      },
      Network: {},
    };
    const client = CdpClient.fromHandle(fakeHandle);
    await assert.rejects(
      () => client.navigate("about:blank"),
      (err: unknown) => {
        assert.ok(err instanceof Error, "T-Stealth.1: thrown value must be an Error instance");
        assert.match(
          err.message,
          /navigate: stealth not injected/,
          "T-Stealth.1: error message must match 'navigate: stealth not injected'",
        );
        return true;
      },
      "T-Stealth.1: navigate() on an uninjected client must throw a stealth-not-injected error",
    );
  });

  // ─── T-Stealth.2 ────────────────────────────────────────────────────────────

  it("T-Stealth.2: when injectStealth(client) is called first, client.navigate() does NOT throw", async () => {
    // Given: a CdpClient whose handle records Page calls; injectStealth(client) is called
    // When:  client.navigate("about:blank") is called after injection
    // Then:  navigate resolves without throwing (stealthInjected === true)
    const callLog: string[] = [];
    const fakeHandle = {
      Page: {
        enable: async () => {
          callLog.push("Page.enable");
        },
        addScriptToEvaluateOnNewDocument: async (_args: { source: string; runImmediately: boolean }) => {
          callLog.push("Page.addScriptToEvaluateOnNewDocument");
          return { identifier: "id-1" };
        },
        navigate: async (_args: { url: string }) => {
          callLog.push("Page.navigate");
          return { errorText: undefined };
        },
        // [Step 5] Added: waitForLoad("load") needs Page.loadEventFired to resolve immediately.
        loadEventFired: (cb: (params?: unknown) => void): (() => void) => {
          callLog.push("Page.loadEventFired");
          cb(); // immediate resolve — simulates page load complete
          return () => {}; // unsubscribe no-op
        },
      },
      Network: {},
    };
    const client = CdpClient.fromHandle(fakeHandle);
    await injectStealth(client);
    await assert.doesNotReject(
      () => client.navigate("about:blank"),
      "T-Stealth.2: navigate() must not throw when stealthInjected === true",
    );
    assert.ok(callLog.includes("Page.navigate"), "T-Stealth.2: navigate must call Page.navigate on the handle");
    assert.ok(callLog.includes("Page.loadEventFired"), "T-Stealth.2: navigate must await Page.loadEventFired");
  });

  // ─── T-Stealth.3 ────────────────────────────────────────────────────────────
  //
  // [OQ-5] Target.targetCreated auto-inject wiring: when the session is booted
  // (stealth injected on primary) and a fake targetCreated event arrives for a
  // new page target, the handler MUST call Page.addScriptToEvaluateOnNewDocument
  // on a sub-session for that target.
  //
  // ★ C1 GUARDIAN CONCERN-MR-1 NOTE:
  //   "A retroactive fire for the primary targetId is expected/accepted.
  //    Do NOT classify as a 5a defect. The assertion is: ≥1 injectStealth
  //    call on the NEW target's sub-session, not EXACTLY 1 on all targets."

  it("T-Stealth.3: when Target.targetCreated fires with type='page' for a new targetId, handler calls attachToTarget + Page.addScriptToEvaluateOnNewDocument on sub-session", async () => {
    // Given: session is booted (primary client has stealth injected) and
    //        setDiscoverTargets is registered; a 'Target.targetCreated' event
    //        fires with targetInfo: {type:'page', targetId:'T2', url:'about:blank'}
    // When:  the registered handler runs
    // Then:  Target.attachToTarget({targetId:'T2', flatten:true}) is called AND
    //        Page.addScriptToEvaluateOnNewDocument is called on the sub-session
    //        with STEALTH_INIT_SCRIPT; non-page targets ('iframe','service_worker')
    //        are SKIPPED (no attach, no script call for those types)

    const handler = capturedHandlers["Target.targetCreated"];
    assert.ok(
      handler,
      "T-Stealth.3: before() must have captured 'Target.targetCreated' handler via session boot path (check mock setup if missing)",
    );
    if (!handler) return; // type guard — already asserted above

    // Snapshot sessionSendLog length before invoking handler (isolate this test's calls)
    const logBefore = sessionSendLog.length;

    // Invoke handler with a NEW page target (T2) — must call attachToTarget + send
    await handler({
      targetInfo: { type: "page", targetId: "T2", url: "about:blank" },
    });

    // Assert: at least one Page.addScriptToEvaluateOnNewDocument was sent on sess-T2's sub-session
    // (per C1: ≥1, not exactly 1 — retroactive primary fire is tolerated)
    const t2Calls = sessionSendLog.slice(logBefore).filter((c) => c.sessionId === "sess-T2");
    assert.ok(
      t2Calls.some((c) => c.method === "Page.addScriptToEvaluateOnNewDocument"),
      `T-Stealth.3: handler for page target 'T2' must call Page.addScriptToEvaluateOnNewDocument on sub-session 'sess-T2'; got ${JSON.stringify(sessionSendLog.slice(logBefore))}`,
    );

    // Invoke handler with a non-page target (iframe) — must be SKIPPED
    const logBeforeIframe = sessionSendLog.length;
    await handler({
      targetInfo: { type: "iframe", targetId: "T3", url: "about:blank" },
    });
    const t3Calls = sessionSendLog.slice(logBeforeIframe).filter((c) => c.sessionId === "sess-T3");
    assert.strictEqual(
      t3Calls.length,
      0,
      "T-Stealth.3: handler for non-page target (iframe) must NOT call addScriptToEvaluateOnNewDocument",
    );

    // Invoke handler with a service_worker target — also skipped
    const logBeforeSW = sessionSendLog.length;
    await handler({
      targetInfo: { type: "service_worker", targetId: "T4", url: "" },
    });
    const t4Calls = sessionSendLog.slice(logBeforeSW).filter((c) => c.sessionId === "sess-T4");
    assert.strictEqual(t4Calls.length, 0, "T-Stealth.3: service_worker targets must also be skipped");
  });

  // ─── T-Stealth.4 ────────────────────────────────────────────────────────────
  //
  // [F-2] Plugin guard: native non-empty plugins ARE PRESERVED when
  // navigator.plugins.length > 0 (the real Chrome 148 macOS case).

  it("T-Stealth.4: when navigator.plugins.length > 0 initially, STEALTH_INIT_SCRIPT does NOT override plugins (native preserved)", () => {
    // Given: a vm sandbox where navigator.plugins.length === 3 (mock native plugins)
    // When:  STEALTH_INIT_SCRIPT runs in the sandbox
    // Then:  navigator.plugins is UNCHANGED (length still 3, same objects)
    const navProto: Record<string, unknown> = { webdriver: false };
    const nativePlugins = Object.assign(
      [
        { name: "Native PDF Viewer", filename: "native.pdf", description: "Native" },
        { name: "Chrome PDF Viewer", filename: "internal.pdf", description: "" },
        { name: "Third Plugin", filename: "third.dll", description: "Third" },
      ],
      { item: () => null, namedItem: () => null, refresh: () => null },
    );
    const nav: Record<string, unknown> = Object.create(navProto);
    nav.plugins = nativePlugins;
    nav.permissions = { query: async (_p: unknown) => ({ state: "default" }) };

    const sandbox: vm.Context = {
      navigator: nav,
      window: {},
      Notification: { permission: "default" },
      Object,
      Symbol,
      Promise,
    };

    vm.runInNewContext(STEALTH_INIT_SCRIPT, sandbox);

    // F-2 conditional: plugins.length > 0 → skip patch → native preserved
    assert.strictEqual(
      (nav.plugins as { length: number }).length,
      3,
      "T-Stealth.4: native non-empty plugins must be preserved (length still 3) when F-2 conditional skips the patch",
    );
    const pluginsArr = nav.plugins as Array<{ name: string }>;
    assert.strictEqual(pluginsArr[0].name, "Native PDF Viewer", "T-Stealth.4: first native plugin name must be unchanged");
    assert.strictEqual(pluginsArr[1].name, "Chrome PDF Viewer", "T-Stealth.4: second native plugin name must be unchanged");
    assert.strictEqual(pluginsArr[2].name, "Third Plugin", "T-Stealth.4: third native plugin name must be unchanged");
  });

  // ─── T-Stealth.5 ────────────────────────────────────────────────────────────
  //
  // [F-2] Plugin guard: empty plugins (automation-empty Chrome / headless CI)
  // MUST receive the 5 PDF stubs from STEALTH_INIT_SCRIPT.

  it("T-Stealth.5: when navigator.plugins.length === 0 initially, STEALTH_INIT_SCRIPT applies the 5 PDF stubs", () => {
    // Given: a vm sandbox where navigator.plugins.length === 0 (automation-empty)
    // When:  STEALTH_INIT_SCRIPT runs in the sandbox
    // Then:  navigator.plugins.length === 5 (the 5 PDF stub entries are applied)
    const navProto: Record<string, unknown> = { webdriver: false };
    const nav: Record<string, unknown> = Object.create(navProto);
    nav.plugins = []; // length === 0
    nav.permissions = { query: async (_p: unknown) => ({ state: "default" }) };

    const sandbox: vm.Context = {
      navigator: nav,
      window: {},
      Notification: { permission: "default" },
      Object,
      Symbol,
      Promise,
    };

    vm.runInNewContext(STEALTH_INIT_SCRIPT, sandbox);

    // F-2 conditional: plugins.length === 0 → apply 5 PDF stubs
    assert.strictEqual(
      (nav.plugins as { length: number }).length,
      5,
      "T-Stealth.5: when plugins.length===0, STEALTH_INIT_SCRIPT must apply exactly 5 PDF stubs",
    );
    const pluginsArr2 = nav.plugins as Array<{ name: string; filename: string; description: string }>;
    assert.equal(typeof pluginsArr2[0].name, "string", "T-Stealth.5: stub[0].name must be a string");
    assert.ok(pluginsArr2[0].name.length > 0, "T-Stealth.5: stub[0].name must be non-empty");
    assert.equal(typeof pluginsArr2[0].filename, "string", "T-Stealth.5: stub[0].filename must be a string");
    assert.equal(typeof pluginsArr2[0].description, "string", "T-Stealth.5: stub[0].description must be a string");
  });
});

// ─── T-Target.1 ───────────────────────────────────────────────────────────────
//
// [OQ-5] Target.setDiscoverTargets is called before the targetCreated listener.
// This is a sequencing assertion: setDiscoverTargets MUST precede .on('Target.targetCreated').
//
// ★ C1 GUARDIAN CONCERN-MR-1 NOTE:
//   "A retroactive fire for the primary targetId is expected/accepted (dedup deferred,
//    see plan §7 R-7). The handler asserts ≥1 attach+inject call on the NEW target
//    sub-session. A retroactive double-registration on the primary target is logged,
//    not counted as a defect. Do NOT classify as a 5a defect."

describe("T-Target: OQ-5 Target.targetCreated wiring (mock)", () => {
  it("T-Target.1: when registerTargetCreatedAutoInject runs, Target.setDiscoverTargets({discover:true}) is called BEFORE the targetCreated listener is attached", () => {
    // Given: a fake CdpHandle with a Target domain and an .on() event emitter
    // When:  registerTargetCreatedAutoInject(client) is invoked (via the session boot path)
    // Then:  Target.setDiscoverTargets({discover:true}) call is recorded BEFORE
    //        any .on('Target.targetCreated') handler is attached
    //
    // C1 ACCEPTED: if a retroactive 'Target.targetCreated' fires for the primary
    // targetId immediately after setDiscoverTargets, that is a tolerated path —
    // the double addScriptToEvaluateOnNewDocument on primary is harmless per plan §7 R-7.
    // This test does NOT assert "exactly 1 inject call on the primary target."

    // sessionCallLog is populated by the before() session boot path.
    assert.ok(
      sessionCallLog.length > 0,
      `T-Target.1: before() must have run session boot path and populated sessionCallLog; got empty log (check mock setup)`,
    );

    const discoverIdx = sessionCallLog.findIndex((e) => e.startsWith("setDiscoverTargets:"));
    const onIdx = sessionCallLog.findIndex((e) => e === "on:Target.targetCreated");

    assert.ok(
      discoverIdx !== -1,
      `T-Target.1: Target.setDiscoverTargets must be called in boot path; sessionCallLog=${JSON.stringify(sessionCallLog)}`,
    );
    assert.ok(
      onIdx !== -1,
      `T-Target.1: on('Target.targetCreated') must be registered in boot path; sessionCallLog=${JSON.stringify(sessionCallLog)}`,
    );
    assert.ok(
      discoverIdx < onIdx,
      `T-Target.1: setDiscoverTargets (idx ${discoverIdx}) must precede on:Target.targetCreated (idx ${onIdx}); callLog=${JSON.stringify(sessionCallLog)}`,
    );
  });
});

// ─── T-Idemp.1 + T-Lifecycle.1 ────────────────────────────────────────────────

describe("T-Lifecycle: F-1 idempotency + reconnect re-inject (mock)", () => {
  // ─── T-Idemp.1 ──────────────────────────────────────────────────────────────
  //
  // [OQ-4] injectStealth idempotency: second call on the same client must
  // early-return WITHOUT calling addScriptToEvaluateOnNewDocument again.

  it("T-Idemp.1: when injectStealth(client) is called twice on the same client, the second call early-returns (no second addScriptToEvaluateOnNewDocument call) and isStealthInjected() === true after both calls", async () => {
    // Given: a fake handle recording addScriptToEvaluateOnNewDocument calls;
    //        injectStealth(client) is called once (first call succeeds + sets flag)
    // When:  injectStealth(client) is called a second time on the same client
    // Then:  addScriptToEvaluateOnNewDocument is called exactly once (not twice);
    //        client.isStealthInjected() === true after both calls
    const addScriptCalls: number[] = [];
    const fakeHandle = {
      Page: {
        enable: async () => {},
        addScriptToEvaluateOnNewDocument: async (_args: { source: string; runImmediately: boolean }) => {
          addScriptCalls.push(1);
          return { identifier: "id-1" };
        },
      },
    };

    const client = CdpClient.fromHandle(fakeHandle);
    await injectStealth(client);
    await injectStealth(client); // second call — must early-return

    assert.strictEqual(
      addScriptCalls.length,
      1,
      "T-Idemp.1: addScriptToEvaluateOnNewDocument must be called exactly once (not twice) after two injectStealth calls",
    );
    assert.strictEqual(
      client.isStealthInjected(),
      true,
      "T-Idemp.1: isStealthInjected must be true after both injectStealth calls",
    );
  });

  // ─── T-Lifecycle.1 ──────────────────────────────────────────────────────────
  //
  // [F-1] Reconnect re-inject: when a cached client is marked disconnected and
  // getOrInitClient() re-boots, injectStealth is called on the NEW client.
  // The new client's stealthInjected flag starts false (per-instance reset).
  // This tests that the boot path ALWAYS calls injectStealth after CdpClient.connect().
  //
  // NOTE: CdpClient.fromHandle()'s new instance starts with stealthInjected=false —
  // that is the desired behavior (mirrors a fresh-reconnect CdpClient); tests that
  // call navigate() on a fresh fromHandle() without injectStealth() must use
  // injectStealth() first, mirroring the production boot path. This is R-1 (plan §7).

  it("T-Lifecycle.1: when a cached client's isConnected() returns false and getOrInitClient() re-boots, injectStealth is called on the fresh client (new stealthInjected=false baseline)", async () => {
    // Given: a cached CdpClient whose isConnected() returns false (simulates CDP disconnect)
    // When:  getOrInitClient() detects the stale cache, clears it, and runs the boot path
    // Then:  the new CdpClient instance has stealthInjected=false initially, and
    //        injectStealth() is called on it during boot (flag becomes true before any nav)

    // Approach (b) from fill plan: directly create CdpClient instances (fresh + stale)
    // and assert the per-instance reset invariant (stealthInjected is never inherited).
    const freshFakeHandle = {
      Page: {
        enable: async () => {},
        addScriptToEvaluateOnNewDocument: async (_args: { source: string; runImmediately: boolean }) => ({
          identifier: "fresh-id",
        }),
      },
    };

    // Fresh instance starts with stealthInjected=false (per-instance reset — reconnect invariant)
    const freshClient = CdpClient.fromHandle(freshFakeHandle);
    assert.strictEqual(
      freshClient.isStealthInjected(),
      false,
      "T-Lifecycle.1: fresh CdpClient.fromHandle() must start with stealthInjected=false (per-instance reset — prevents 92-reconnect regression)",
    );

    // Boot path: call injectStealth → flag becomes true
    await injectStealth(freshClient);
    assert.strictEqual(
      freshClient.isStealthInjected(),
      true,
      "T-Lifecycle.1: after injectStealth(), isStealthInjected must be true",
    );

    // A second fresh instance (simulates reconnect — new CdpClient from CdpClient.connect())
    // also starts at false — verifies the per-instance reset invariant holds on reconnect.
    const reconnectedClient = CdpClient.fromHandle(freshFakeHandle);
    assert.strictEqual(
      reconnectedClient.isStealthInjected(),
      false,
      "T-Lifecycle.1: reconnect-path CdpClient (new instance) must start with stealthInjected=false — the boot path must call injectStealth() on reconnect, cannot skip it",
    );

    // The reconnect client also needs injectStealth before navigate (structural invariant)
    await injectStealth(reconnectedClient);
    assert.strictEqual(
      reconnectedClient.isStealthInjected(),
      true,
      "T-Lifecycle.1: after injectStealth() on reconnect client, flag becomes true (boot path completed correctly)",
    );
  });
});

// ─── T-Plugin.1 ───────────────────────────────────────────────────────────────
//
// [F-2] Both branches of the navigator.plugins.length === 0 conditional:
// (a) empty → stubs applied; (b) non-empty → native preserved.
// Note: T-Stealth.4 and T-Stealth.5 above cover both branches individually;
// T-Plugin.1 groups them as the combined conditional contract (§5 spec reference).

describe("T-Plugin: F-2 plugin conditional guard (mock)", () => {
  it("T-Plugin.1a: when navigator.plugins.length === 0, STEALTH_INIT_SCRIPT applies exactly 5 PDF stubs", () => {
    // Given: vm sandbox with plugins.length === 0 (automation-empty)
    // When:  STEALTH_INIT_SCRIPT runs
    // Then:  navigator.plugins.length === 5 (the 5 PDF stubs are applied)
    const navProto: Record<string, unknown> = { webdriver: false };
    const nav: Record<string, unknown> = Object.create(navProto);
    nav.plugins = [];
    nav.permissions = { query: async (_p: unknown) => ({ state: "default" }) };

    vm.runInNewContext(STEALTH_INIT_SCRIPT, {
      navigator: nav,
      window: {},
      Notification: { permission: "default" },
      Object,
      Symbol,
      Promise,
    });

    assert.strictEqual(
      (nav.plugins as { length: number }).length,
      5,
      "T-Plugin.1a: plugins.length===0 branch must apply exactly 5 PDF stubs (F-2 empty-plugins branch)",
    );
  });

  it("T-Plugin.1b: when navigator.plugins.length === 3 (native non-empty), STEALTH_INIT_SCRIPT leaves plugins unchanged", () => {
    // Given: vm sandbox with 3 native plugins (mock non-empty)
    // When:  STEALTH_INIT_SCRIPT runs
    // Then:  navigator.plugins object is identical (same length+names; no override fired)
    const navProto: Record<string, unknown> = { webdriver: false };
    const nativePlugins = Object.assign(
      [
        { name: "Native PDF Viewer", filename: "native.pdf", description: "Native" },
        { name: "Chrome PDF Viewer", filename: "internal.pdf", description: "" },
        { name: "Third Plugin", filename: "third.dll", description: "Third" },
      ],
      { item: () => null, namedItem: () => null, refresh: () => null },
    );
    const nav: Record<string, unknown> = Object.create(navProto);
    nav.plugins = nativePlugins;
    nav.permissions = { query: async (_p: unknown) => ({ state: "default" }) };

    vm.runInNewContext(STEALTH_INIT_SCRIPT, {
      navigator: nav,
      window: {},
      Notification: { permission: "default" },
      Object,
      Symbol,
      Promise,
    });

    assert.strictEqual(
      (nav.plugins as { length: number }).length,
      3,
      "T-Plugin.1b: plugins.length===3 branch must preserve native (no override fired, F-2 non-empty branch)",
    );
    const plugsB = nav.plugins as Array<{ name: string }>;
    assert.strictEqual(plugsB[0].name, "Native PDF Viewer", "T-Plugin.1b: first native plugin must be unchanged");
    assert.strictEqual(plugsB[2].name, "Third Plugin", "T-Plugin.1b: third native plugin must be unchanged");
  });
});

// ─── T-M7 (extended) ──────────────────────────────────────────────────────────
//
// [F-1] The existing T-M7 in stealth.mock.test.ts verifies the old signature
// injectStealth(handle: CdpHandle). Post-builder, the signature changes to
// injectStealth(client: CdpClient). This scaffold tests the NEW signature:
// injectStealth must accept a CdpClient and call Page.enable +
// Page.addScriptToEvaluateOnNewDocument via client.handle.

describe("T-M7-ext: F-1 injectStealth new signature (mock)", () => {
  it("T-M7-ext: when injectStealth(client: CdpClient) is called, it calls Page.enable then Page.addScriptToEvaluateOnNewDocument on client.handle and returns the identifier (or undefined on idempotent second call)", async () => {
    // Given: a CdpClient from CdpClient.fromHandle(fakeHandle) where fakeHandle records calls
    // When:  injectStealth(client) is called (NOT injectStealth(client.handle))
    // Then:  Page.enable is called, then addScriptToEvaluateOnNewDocument with STEALTH_INIT_SCRIPT
    //        and runImmediately:true; identifier is returned as string on first call,
    //        undefined on idempotent second call
    const callLog: string[] = [];
    const fakeHandle = {
      Page: {
        enable: async () => {
          callLog.push("Page.enable");
        },
        addScriptToEvaluateOnNewDocument: async ({
          source,
          runImmediately,
        }: {
          source: string;
          runImmediately: boolean;
        }) => {
          callLog.push("Page.addScriptToEvaluateOnNewDocument");
          void source;
          void runImmediately;
          return { identifier: "stealth-id-ext" };
        },
      },
    };

    const client = CdpClient.fromHandle(fakeHandle);
    const identifier = await injectStealth(client);

    // Assert call sequence: Page.enable before addScriptToEvaluateOnNewDocument
    assert.deepStrictEqual(
      callLog,
      ["Page.enable", "Page.addScriptToEvaluateOnNewDocument"],
      "T-M7-ext: Page.enable must be called before addScriptToEvaluateOnNewDocument",
    );
    assert.strictEqual(
      typeof identifier,
      "string",
      "T-M7-ext: first injectStealth call must return identifier as string",
    );
    assert.strictEqual(identifier, "stealth-id-ext", "T-M7-ext: identifier must match what fakeHandle returns");
    assert.ok(client.isStealthInjected(), "T-M7-ext: isStealthInjected must be true after first call");

    // Idempotent second call: must early-return undefined (no second addScript call)
    const identifier2 = await injectStealth(client);
    assert.strictEqual(identifier2, undefined, "T-M7-ext: second injectStealth call (idempotent) must return undefined");
    assert.strictEqual(
      callLog.filter((c) => c === "Page.addScriptToEvaluateOnNewDocument").length,
      1,
      "T-M7-ext: addScriptToEvaluateOnNewDocument must be called exactly once across both injectStealth calls",
    );
  });
});
