/**
 * P-Y4 Step 4a — T-Rehome.1, T-Rehome.1b — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * Unit-tests the EXTRACTED, exported `ensureOverlaySubscription(state, deps, onOverlayEvent, client)` helper
 * (plan §6.4.2). It mocks the two overlay modules the helper depends on so the subscribe/attach calls can be
 * SPIED without a real Chrome:
 *   - ../overlay/inject.js   → subscribeContextId (spy: records each call, captures onContext, fires it)
 *   - ../overlay/eventBus.js → attachEventBus    (spy: records each call)
 *
 * IMPORTANT (harness design): the helper is captured via mock-then-dynamic-import (the serve-p57f pattern) —
 * mock.module MUST run before routes.js is loaded, so a static `import { ensureOverlaySubscription }` is NOT
 * usable here (static imports link before before() runs → the mocks would not apply, defeating the subscribe/
 * attach spies that the idempotency assertion needs). A static import is also incompatible with the unit-test
 * goal of spying subscribeContextId/attachEventBus call counts.
 *
 * STATUS at Step 4a: routes.js does NOT yet export `ensureOverlaySubscription` (builder adds it at 4b, §6.4.2
 * Edit 2). The dynamic import resolves it to `undefined` until then. The it() bodies are assert.fail TODOs and
 * are RED now; at Step 5 they call the real helper twice and assert the idempotency + reconnect behaviors.
 *
 * Covers ask d, behavior (v): one idempotent overlay-subscription implementation shared by POST /chrome/ensure
 * AND the lazy onClientBooted boot path.
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *   --test-timeout=30000 tests/cli/subcommands/serve-pY4.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { CdpClient } from "../../../src/cdp/client.js";
import type { ServeDeps, ServeState } from "../../../src/cli/subcommands/serve/context.js";
import type { OverlayEvent } from "../../../src/overlay/eventBus.js";

// ─── Mock state / spies ──────────────────────────────────────────────────────

const FAKE_HANDLE = { __h: "fake-handle" };
const FAKE_CLIENT = { handle: FAKE_HANDLE } as unknown as CdpClient;

let subscribeCalls = 0;
let attachCalls = 0;
let capturedOnContext: ((id: number) => void) | null = null;
// Driven per-test: the id the subscribeContextId spy reports on first fire.
let firstContextId = 101;

// Helper-under-test, captured after mocks (undefined until builder 4b exports it).
type EnsureOverlaySubscription = (
  state: ServeState,
  deps: ServeDeps,
  onOverlayEvent: (event: OverlayEvent) => void,
  client: CdpClient,
) => Promise<void>;
let ensureOverlaySubscription: EnsureOverlaySubscription | undefined;

function makeState(overrides: Partial<ServeState> = {}): ServeState {
  return {
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    ...overrides,
  } as unknown as ServeState;
}

let emitFrameCalls: unknown[] = [];
let emitOverlayEventCalls: unknown[] = [];
function makeDeps(): ServeDeps {
  return {
    emitFrame: (f: unknown) => emitFrameCalls.push(f),
    emitOverlayEvent: (e: unknown) => emitOverlayEventCalls.push(e),
  } as unknown as ServeDeps;
}

before(async () => {
  const injectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      OVERLAY_BOOTSTRAP_JS: "",
      installOverlay: async () => "id-overlay",
      // biome-ignore lint/suspicious/noExplicitAny: stub handle
      subscribeContextId: async (_handle: any, onContext: (id: number) => void) => {
        subscribeCalls++;
        capturedOnContext = onContext;
        onContext(firstContextId);
        return () => undefined;
      },
      callInOverlay: async () => undefined,
    },
  });

  const eventBusUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/eventBus.js")).href;
  mock.module(eventBusUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      attachEventBus: (_handle: any, _cb: any) => {
        attachCalls++;
        return () => undefined;
      },
      appendOverlayEventRow: () => undefined,
    },
  });

  const routesMod = await import("../../../src/cli/subcommands/serve/routes.js");
  // biome-ignore lint/suspicious/noExplicitAny: pending builder 4b export
  ensureOverlaySubscription = (routesMod as any).ensureOverlaySubscription;
});

// ─── T-Rehome.1 — idempotency ────────────────────────────────────────────────

describe("ensureOverlaySubscription — idempotent across two calls (ask d, behavior v)", () => {
  it("T-Rehome.1: when called twice with the same client on a fresh state, subscribeContextId fires exactly once and attachEventBus exactly once; overlayContextId is set from the first onContext(id)", async () => {
    // Given: a fresh ServeState (unsubscribeContextId/unsubscribeOverlayEvents both undefined) + spied
    //        subscribeContextId (returns an unsub fn) + attachEventBus (returns an unsub fn)
    // When:  ensureOverlaySubscription(state, deps, onOverlayEvent, FAKE_CLIENT) is awaited TWICE
    // Then:  subscribeCalls===1 and attachCalls===1 (second call no-ops via the !state.unsubscribe… guards),
    //        and state.overlayContextId === firstContextId (set by the first subscribe's onContext)
    subscribeCalls = 0;
    attachCalls = 0;
    firstContextId = 101;
    assert.ok(ensureOverlaySubscription, "builder 4b must export ensureOverlaySubscription from routes.ts");
    const state = makeState();
    const deps = makeDeps();
    const events: unknown[] = [];
    const onOverlayEvent = (e: OverlayEvent) => events.push(e);
    await ensureOverlaySubscription(state, deps, onOverlayEvent, FAKE_CLIENT);
    await ensureOverlaySubscription(state, deps, onOverlayEvent, FAKE_CLIENT); // idempotent — must no-op
    assert.equal(subscribeCalls, 1, "subscribeContextId must fire exactly once across two ensure() calls");
    assert.equal(attachCalls, 1, "attachEventBus must fire exactly once across two ensure() calls");
    assert.equal(state.overlayContextId, 101, "overlayContextId must be set from the first subscribe's onContext(id)");
    // guards latched: both unsubscribe handles captured after the first call
    assert.ok(state.unsubscribeContextId, "unsubscribeContextId handle must be latched after first call");
    assert.ok(state.unsubscribeOverlayEvents, "unsubscribeOverlayEvents handle must be latched after first call");
  });
});

// ─── T-Rehome.1b — reconnect frame on context-id change ──────────────────────

describe("ensureOverlaySubscription — reconnect path on overlay context-id change (ask d)", () => {
  it("T-Rehome.1b: when overlayContextId is already set and onContext fires with a DIFFERENT id, emitFrame({type:'overlay-reconnected'}) AND emitOverlayEvent({event_type:'overlay-reconnected', t0, latency_ms:0}) are emitted", async () => {
    // Given: state.overlayContextId already = A (101); ensureOverlaySubscription subscribed (capturing onContext)
    // When:  the captured onContext is fired with a different id B (202)
    // Then:  deps.emitFrame was called with { type:"overlay-reconnected" } AND deps.emitOverlayEvent was called
    //        with { kind:"overlay-event", event_type:"overlay-reconnected", t0:<ts>, latency_ms:0 }
    subscribeCalls = 0;
    attachCalls = 0;
    firstContextId = 101;
    emitFrameCalls = [];
    emitOverlayEventCalls = [];
    assert.ok(ensureOverlaySubscription, "builder 4b must export ensureOverlaySubscription from routes.ts");
    const state = makeState({ overlayContextId: 101 });
    const deps = makeDeps();
    await ensureOverlaySubscription(state, deps, () => {}, FAKE_CLIENT);
    // the subscribe spy already fired onContext(101) — same id, so NO reconnect emitted yet
    assert.equal(emitFrameCalls.length, 0, "no reconnect frame when the id is unchanged (101→101)");
    assert.ok(capturedOnContext, "subscribeContextId must have captured the onContext callback");
    // now the overlay execution-context id changes (a real re-nav): fire a DIFFERENT id
    capturedOnContext(202);
    assert.ok(
      emitFrameCalls.some((f) => (f as { type?: string }).type === "overlay-reconnected"),
      "emitFrame must fire { type:'overlay-reconnected' } on context-id change",
    );
    const reEvt = emitOverlayEventCalls.find(
      (e) => (e as { event_type?: string }).event_type === "overlay-reconnected",
    ) as { event_type?: string; latency_ms?: number; t0?: number } | undefined;
    assert.ok(reEvt, "emitOverlayEvent must fire an 'overlay-reconnected' event");
    assert.equal(reEvt?.latency_ms, 0, "reconnect overlay-event latency_ms must be 0");
    assert.equal(typeof reEvt?.t0, "number", "reconnect overlay-event must carry a numeric t0");
    assert.equal(state.overlayContextId, 202, "overlayContextId must update to the new id (202)");
  });
});

// Step 4a: bindings consumed (read) when the assertion bodies are filled at Step 5. The spy counters
// (subscribeCalls/attachCalls) are written by the mocks now but only READ in the Step-5 assertions, so they
// are listed here to keep biome's noUnusedVariables green at scaffold time.
void [
  FAKE_CLIENT,
  capturedOnContext,
  ensureOverlaySubscription,
  makeState,
  makeDeps,
  emitFrameCalls,
  emitOverlayEventCalls,
  subscribeCalls,
  attachCalls,
];
