/**
 * P-Y4 Step 4a — T-Rehome.2, T-Rehome.3 — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * Unit-tests the new `onClientBooted` post-boot hook on createLinkedinSession (plan §6.1 / §6.4.1).
 * Mocks every CDP/overlay dependency session.ts imports so getOrInitClient() can boot a FAKE client without
 * a real Chrome:
 *   - ../cdp/index.js        → ensureChrome (returns {launched:false, port}), injectStealth
 *   - ../cdp/client.js       → CdpClient.connect (returns the FAKE client)
 *   - ../overlay/inject.js   → installOverlay
 *   - ../overlay/eventBus.js → attachEventBus, appendOverlayEventRow
 *   - ../cdp/hardwareInput.js→ resolveInputMode (→ "cdp")
 * A shared `bootOrder` array records the boot sequence so a test can assert onClientBooted fires AFTER
 * overlay install.
 *
 * STATUS at Step 4a: this file RUNS now (createLinkedinSession exists; onClientBooted is passed as an extra
 * runtime property which tsx strips). It FAILS now because the current session.ts does NOT invoke the hook —
 * the assertion bodies are filled at Step 5 once builder's 4b wires Edit 2 (§6.4.1). It will not typecheck in
 * an editor until the opt is added to CreateLinkedinSessionOpts (tsconfig excludes tests/ → npm run check is
 * unaffected).
 *
 * Covers ask d, behavior (v): an agent-driven lazy boot must run the overlay-subscription hook exactly once.
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *   --test-timeout=30000 tests/linkedin/session-pY4.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Mock state ──────────────────────────────────────────────────────────────

const FAKE_HANDLE = { __h: "fake-handle" };
const FAKE_CLIENT = { isConnected: () => true, handle: FAKE_HANDLE };
let bootOrder: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: dynamic factory import.
let createLinkedinSession: ((opts: any) => any) | undefined;

before(async () => {
  // cdp/index.js — ensureChrome + injectStealth.
  const cdpIndexUrl = pathToFileURL(resolve(process.cwd(), "src/cdp/index.js")).href;
  mock.module(cdpIndexUrl, {
    namedExports: {
      ensureChrome: async () => {
        bootOrder.push("ensureChrome");
        return { launched: false, port: 9222 };
      },
      injectStealth: async () => {
        bootOrder.push("injectStealth");
      },
    },
  });

  // cdp/client.js — CdpClient.connect returns the fake client.
  const cdpClientUrl = pathToFileURL(resolve(process.cwd(), "src/cdp/client.js")).href;
  mock.module(cdpClientUrl, {
    namedExports: {
      CdpClient: {
        connect: async () => {
          bootOrder.push("connect");
          return FAKE_CLIENT;
        },
      },
    },
  });

  // overlay/inject.js — installOverlay + (placeholders for other importers).
  const injectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      OVERLAY_BOOTSTRAP_JS: "",
      installOverlay: async () => {
        bootOrder.push("installOverlay");
        return "id-overlay";
      },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      subscribeContextId: async (_h: any, _cb: any) => () => undefined,
      callInOverlay: async () => undefined,
    },
  });

  // overlay/eventBus.js — attachEventBus + appendOverlayEventRow.
  const eventBusUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/eventBus.js")).href;
  mock.module(eventBusUrl, {
    namedExports: {
      attachEventBus: () => {
        bootOrder.push("attachEventBus");
        return () => undefined;
      },
      appendOverlayEventRow: () => undefined,
    },
  });

  // cdp/hardwareInput.js — resolveInputMode → "cdp".
  const hardwareInputUrl = pathToFileURL(resolve(process.cwd(), "src/cdp/hardwareInput.js")).href;
  mock.module(hardwareInputUrl, {
    namedExports: {
      resolveInputMode: () => "cdp",
    },
  });

  const sessionMod = await import("../../src/linkedin/session.js");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  createLinkedinSession = (sessionMod as any).createLinkedinSession;
});

// ─── T-Rehome.2 — boot fires the hook exactly once, after overlay install ─────

describe("createLinkedinSession — onClientBooted fires once at boot, after overlay install (ask d, behavior v)", () => {
  it("T-Rehome.2: when getOrInitClient() boots the client, onClientBooted is called exactly once with the booted CdpClient (after overlay install) and a cached re-call does NOT re-fire it", async () => {
    // Given: createLinkedinSession({…, onClientBooted: spy}) with stubbed ensureChrome/connect/installOverlay
    // When:  getOrInitClient() is awaited (first boot), then awaited a SECOND time (cached client)
    // Then:  the spy fired exactly ONCE, with FAKE_CLIENT, AFTER "installOverlay" in bootOrder; both calls
    //        resolve { ok:true, client: FAKE_CLIENT }
    bootOrder = [];
    const hookArgs: unknown[] = [];
    assert.ok(createLinkedinSession, "createLinkedinSession must be imported");
    const session = createLinkedinSession({
      port: 9222,
      profileDir: "/tmp/p-y4-session",
      inputMode: "cdp",
      onClientBooted: (client: unknown) => {
        bootOrder.push("onClientBooted");
        hookArgs.push(client);
      },
    });
    const r1 = await session.getOrInitClient();
    const r2 = await session.getOrInitClient(); // cached — must NOT re-boot or re-fire the hook
    assert.equal(hookArgs.length, 1, "onClientBooted must fire exactly ONCE (not on the cached re-call)");
    assert.equal(hookArgs[0], FAKE_CLIENT, "onClientBooted must receive the booted CdpClient");
    const overlayIdx = bootOrder.indexOf("installOverlay");
    const hookIdx = bootOrder.indexOf("onClientBooted");
    assert.ok(overlayIdx >= 0, `installOverlay must have run (bootOrder=${JSON.stringify(bootOrder)})`);
    assert.ok(
      hookIdx > overlayIdx,
      `onClientBooted must fire AFTER installOverlay (bootOrder=${JSON.stringify(bootOrder)})`,
    );
    assert.deepEqual(r1, { ok: true, client: FAKE_CLIENT }, "first boot resolves { ok:true, client }");
    assert.deepEqual(r2, { ok: true, client: FAKE_CLIENT }, "cached re-call resolves { ok:true, client }");
  });
});

// ─── T-Rehome.3 — hook failure is swallowed (boot still succeeds) ─────────────

describe("createLinkedinSession — onClientBooted failure is best-effort swallowed (robustness)", () => {
  it("T-Rehome.3: when onClientBooted throws/rejects, getOrInitClient() still resolves { ok:true, client } and the error is logged via console.error (not silently dropped)", async () => {
    // Given: createLinkedinSession({…, onClientBooted: () => { throw … }}) with a console.error spy
    // When:  getOrInitClient() is awaited
    // Then:  it resolves { ok:true, client: FAKE_CLIENT } (boot NOT rejected) and console.error was called
    //        once with the hook failure
    bootOrder = [];
    const errSpy = mock.method(console, "error", () => {});
    try {
      assert.ok(createLinkedinSession, "createLinkedinSession must be imported");
      const session = createLinkedinSession({
        port: 9222,
        profileDir: "/tmp/p-y4-session",
        inputMode: "cdp",
        onClientBooted: () => {
          throw new Error("boom: overlay subscribe failed");
        },
      });
      const r = await session.getOrInitClient();
      // boot must NOT reject — the hook failure is best-effort swallowed
      assert.deepEqual(r, { ok: true, client: FAKE_CLIENT }, "boot resolves { ok:true, client } despite hook throw");
      assert.ok(
        errSpy.mock.calls.length >= 1,
        "the hook failure must be logged via console.error (not silently dropped)",
      );
      const logged = errSpy.mock.calls.some((c) => String(c.arguments[0] ?? "").includes("onClientBooted hook failed"));
      assert.ok(logged, "console.error message must identify the onClientBooted hook failure");
    } finally {
      errSpy.mock.restore();
    }
  });
});

// Step 4a: the factory is invoked when the assertion bodies are filled at Step 5.
void createLinkedinSession;
