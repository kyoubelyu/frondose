/**
 * P-56b Step 5 — T-Overlay.3, T-Overlay.4, T-Overlay.5 (G-P56b.2, G-P56b.3, G-P56b.4)
 *
 * Mock tests for P-56b additions to `src/overlay/inject.ts`:
 *   (a) `export const OVERLAY_BOOTSTRAP_JS` — ticker fn + 5s auto-reset + textContent safety
 *   (b) `subscribeContextId`             — filters `context.name === "mai-overlay"` only
 *   (c) `callInOverlay`                  — Runtime.callFunctionOn with silent:true
 *
 * Gate coverage:
 *   G-P56b.2 — Overlay JS ticker + 5s auto-reset (T-Overlay.4)
 *   G-P56b.3 — contextId tracking via subscribeContextId filter (T-Overlay.3)
 *   G-P56b.4 — callInOverlay uses Runtime.callFunctionOn with silent:true (T-Overlay.5)
 *
 * No Chrome, no LLM, no filesystem I/O.  Fake CdpHandle (CdpHandle = any).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/overlay/inject-p56b.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ─── Dynamic-import sentinel ─────────────────────────────────────────────────
// At Step 4a: src/overlay/inject.ts exists but does NOT yet export
//   OVERLAY_BOOTSTRAP_JS / subscribeContextId / callInOverlay.
// Test fails at the TODO assertion until builder Step 4b lands those exports.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import result typed as any
let mod: any;
try {
  mod = await import("../../src/overlay/inject.js");
} catch (e) {
  if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
    assert.fail("TODO Step 5: T-Overlay.3/4/5 — src/overlay/inject.ts not found; builder Step 4b pending");
  }
  throw e;
}
const { OVERLAY_BOOTSTRAP_JS, subscribeContextId, callInOverlay } = mod;

// ─── T-Overlay.4 — OVERLAY_BOOTSTRAP_JS ticker + Trusted Types safety ────────

describe("OVERLAY_BOOTSTRAP_JS — exported constant; ticker fn + auto-reset + textContent safety (G-P56b.2)", () => {
  it("T-Overlay.4a: given OVERLAY_BOOTSTRAP_JS imported from src/overlay/inject.ts, WHEN substring searches applied, THEN string contains 'window.__maiUpdateTicker = function' AND 'setTimeout' AND '5000' AND 'pill.textContent =' AND does NOT contain '.innerHTML'", () => {
    // Given: OVERLAY_BOOTSTRAP_JS is an exported string constant from inject.ts
    // When:  substring checks run against the constant
    // Then:  ticker function declaration present; setTimeout with 5000ms present;
    //        textContent assignment used (TT-safe); innerHTML ABSENT (TT enforcement)
    assert.ok(
      typeof OVERLAY_BOOTSTRAP_JS === "string" && OVERLAY_BOOTSTRAP_JS.length > 0,
      "OVERLAY_BOOTSTRAP_JS must be a non-empty exported string",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("window.__maiUpdateTicker = function"),
      "OVERLAY_BOOTSTRAP_JS must contain ticker function declaration: window.__maiUpdateTicker = function",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("setTimeout"),
      "OVERLAY_BOOTSTRAP_JS must contain setTimeout (5s auto-reset)",
    );
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("5000"), "OVERLAY_BOOTSTRAP_JS must contain '5000' (5s reset delay in ms)");
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("pill.textContent ="),
      "OVERLAY_BOOTSTRAP_JS must use pill.textContent= (Trusted Types safe)",
    );
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes(".innerHTML"),
      "OVERLAY_BOOTSTRAP_JS must NOT contain .innerHTML (Trusted Types violation)",
    );
  });

  it("T-Overlay.4b: given OVERLAY_BOOTSTRAP_JS imported, WHEN checking for middle-dot escape, THEN string contains 'mai \\xb7 idle' (U+00B7 escaped as \\xb7, not a raw middle-dot literal)", () => {
    // Given: OVERLAY_BOOTSTRAP_JS is the exported constant
    // When:  check for the hex-escaped middle-dot sentinel (template literal \\xb7 → \xb7 in value)
    // Then:  string contains the literal character sequence: m-a-i-space-backslash-x-b-7-space-i-d-l-e
    //        (inject.ts template literal uses \\xb7, so OVERLAY_BOOTSTRAP_JS value has \xb7 as 4 chars)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("mai \\xb7 idle"),
      "OVERLAY_BOOTSTRAP_JS must contain 'mai \\xb7 idle' (backslash-xb7 hex escape for browser JS context)",
    );
  });

  it("T-Overlay.4c: given OVERLAY_BOOTSTRAP_JS imported, WHEN checking it is a non-empty exported string, THEN typeof OVERLAY_BOOTSTRAP_JS === 'string' AND OVERLAY_BOOTSTRAP_JS.length > 0", () => {
    // Given: OVERLAY_BOOTSTRAP_JS should be an exported const (was previously unexported)
    // When:  typeof + length check
    // Then:  it is a non-empty string (confirming the export was added)
    assert.strictEqual(typeof OVERLAY_BOOTSTRAP_JS, "string", "OVERLAY_BOOTSTRAP_JS must be typeof 'string'");
    assert.ok(OVERLAY_BOOTSTRAP_JS.length > 0, "OVERLAY_BOOTSTRAP_JS must have length > 0 (non-empty export)");
  });
});

// ─── T-Overlay.3 — subscribeContextId filters by context.name ────────────────

describe("subscribeContextId — invokes onContext only for context.name === 'mai-overlay' (G-P56b.3)", () => {
  it("T-Overlay.3: given a fake CdpHandle with Page.getFrameTree (mainFrameId='main-1') + Runtime.executionContextCreated handler-capture + onContext=spy, WHEN await subscribeContextId(handle, spy) + handler invoked with (a) mai-overlay+main-1 (b) mai-overlay+iframe-2 (c) other+main-1, THEN onContext called exactly once with id=7; and the return is a function (unsubscribe)", async () => {
    // Given: P-57a evolved subscribeContextId to async + Page.getFrameTree() + top-frame filter
    //        (D-P57a-01 Option B fix). Mock CdpHandle now provides Page.getFrameTree returning
    //        {frameTree: {frame: {id: "main-1"}}}; Runtime.executionContextCreated captures handler.
    // When:  await subscribeContextId(fakeHandle, onContext) → registers handler;
    //        validator invokes captured handler with three payload variants in sequence.
    // Then:  onContext called count === 1 (only the mai-overlay context whose auxData.frameId
    //        matches the mainFrameId); other variants filtered; return is a function.

    // biome-ignore lint/suspicious/noExplicitAny: captured handler needs any to avoid never-type narrowing
    let capturedHandler: any = null;
    const fakeUnsubscribe = () => {
      /* noop */
    };
    const fakeHandle = {
      Page: {
        // P-57a Option B: subscribeContextId now reads frameTree to get mainFrameId for top-frame filter.
        getFrameTree: async () => ({ frameTree: { frame: { id: "main-1" } } }),
      },
      Runtime: {
        // biome-ignore lint/suspicious/noExplicitAny: fake CDP handle — typed loosely for test
        executionContextCreated: (handler: any) => {
          capturedHandler = handler;
          return fakeUnsubscribe;
        },
      },
    };

    const onContextCalls: number[] = [];
    const onContext = (id: number) => {
      onContextCalls.push(id);
    };

    // P-57a: subscribeContextId is now async — await it.
    // biome-ignore lint/suspicious/noExplicitAny: fake handle typed as any
    const unsub = await subscribeContextId(fakeHandle as any, onContext);

    // Verify handler was captured (after Page.getFrameTree() resolves)
    assert.ok(capturedHandler !== null, "executionContextCreated handler should have been registered");

    // Invoke handler with three payloads in sequence:
    //  (a) mai-overlay in TOP frame → accepted
    //  (b) mai-overlay in iframe → filtered by Option B mainFrameId check
    //  (c) non-mai-overlay name in top frame → filtered by name check
    capturedHandler?.({ context: { id: 7, name: "mai-overlay", auxData: { frameId: "main-1" } } });
    capturedHandler?.({ context: { id: 8, name: "mai-overlay", auxData: { frameId: "iframe-2" } } });
    capturedHandler?.({ context: { id: 9, name: "main", auxData: { frameId: "main-1" } } });

    // onContext should only be called once (for the top-frame mai-overlay context)
    assert.equal(
      onContextCalls.length,
      1,
      `onContext should be called exactly once (top-frame mai-overlay); got ${onContextCalls.length} call(s)`,
    );
    assert.equal(
      onContextCalls[0],
      7,
      `onContext should receive id=7 (top-frame mai-overlay); got ${onContextCalls[0]}`,
    );
    // Return value should be a function (unsubscribe handle)
    assert.strictEqual(typeof unsub, "function", "subscribeContextId must return a function (unsubscribe handle)");
  });
});

// ─── T-Overlay.5 — callInOverlay CDP call shape ───────────────────────────────

describe("callInOverlay — Runtime.callFunctionOn with silent:true + contextId (G-P56b.4)", () => {
  it("T-Overlay.5: given a fake CdpHandle whose Runtime.callFunctionOn is a spy returning Promise.resolve({}), WHEN await callInOverlay(fakeHandle, 42, 'function() { foo(); }'), THEN Runtime.callFunctionOn called exactly once deep-equal to {executionContextId:42, functionDeclaration:'function() { foo(); }', silent:true}", async () => {
    // Given: fake CdpHandle = { Runtime: { callFunctionOn: spy returning {} } }
    // When:  await callInOverlay(fakeHandle, 42, "function() { foo(); }")
    // Then:  spy call count === 1;
    //        spy first-call arg deep-equals
    //          { executionContextId: 42, functionDeclaration: "function() { foo(); }", silent: true }

    const callFunctionOnCalls: unknown[] = [];
    const fakeHandle = {
      Runtime: {
        callFunctionOn: async (opts: unknown) => {
          callFunctionOnCalls.push(opts);
          return {};
        },
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: fake handle typed as any
    await callInOverlay(fakeHandle as any, 42, "function() { foo(); }");

    assert.equal(
      callFunctionOnCalls.length,
      1,
      `Runtime.callFunctionOn should be called exactly once; got ${callFunctionOnCalls.length}`,
    );
    assert.deepEqual(
      callFunctionOnCalls[0],
      {
        executionContextId: 42,
        functionDeclaration: "function() { foo(); }",
        silent: true,
      },
      "callFunctionOn arg must include executionContextId, functionDeclaration, and silent:true",
    );
  });
});
