/**
 * P-Y2.3 Step 4a — T-Gate.1..4 + T-Ring.1..2 — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * Serve takeover gating (plan §6.4-D): `makeTakeoverVisualDriver(state, session)` (Auto-gated driver, returns
 * painted-bool) + `showEdgeRing` (Auto-gated) + `hideEdgeRing` (ungated, also clears the target). The Auto-gate
 * lives in the driver so the tool layer skips the cursor-dwell outside Auto+overlay.
 *
 * LOAD: GATE-ON-BUILDER. `src/cli/subcommands/serve/takeover.ts` is NEW (builder 4b §3 #4). It is captured via a
 * try/catch dynamic import in before(), AFTER `mock.module("…/overlay/inject.js")` spies `callInOverlay` (the
 * serve-p57f pattern). Until 4b the fns are undefined → every body is `assert.fail("TODO Step 5: …")`.
 *
 * Gate coverage: G-PY2.3.2 (driver Auto/overlay gate), G-PY2.3.5 (ring show gated / hide ungated + clears target).
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit --test-timeout=30000 \
 *   tests/cli/subcommands/serve-takeover-pY2.3.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// callInOverlay spy capture: [handle, ctxId, fn]
const callInOverlayCalls: Array<[unknown, number, string]> = [];
// biome-ignore lint/suspicious/noExplicitAny: gate-on-builder dynamic imports (takeover.ts is 4b).
let makeTakeoverVisualDriver: ((state: any, session: any) => (fn: string) => boolean) | undefined;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import
let showEdgeRing: ((state: any, session: any) => void) | undefined;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import
let hideEdgeRing: ((state: any, session: any) => void) | undefined;

// biome-ignore lint/suspicious/noExplicitAny: minimal state/session harness
function makeState(over: Record<string, unknown> = {}): any {
  return { overlayContextId: 7, cronEnabled: true, ...over };
}
// biome-ignore lint/suspicious/noExplicitAny: minimal session harness
function makeSession(client: any): any {
  return { getClient: () => client };
}
const FAKE_CLIENT = { handle: { __h: 1 } };

before(async () => {
  const injectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      OVERLAY_BOOTSTRAP_JS: "",
      installOverlay: async () => "id",
      subscribeContextId: async () => () => undefined,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      callInOverlay: async (handle: any, ctxId: number, fn: string) => {
        callInOverlayCalls.push([handle, ctxId, fn]);
      },
    },
  });
  try {
    const mod = await import("../../../src/cli/subcommands/serve/takeover.js");
    makeTakeoverVisualDriver = (mod as { makeTakeoverVisualDriver?: typeof makeTakeoverVisualDriver })
      .makeTakeoverVisualDriver;
    showEdgeRing = (mod as { showEdgeRing?: typeof showEdgeRing }).showEdgeRing;
    hideEdgeRing = (mod as { hideEdgeRing?: typeof hideEdgeRing }).hideEdgeRing;
  } catch {
    // takeover.ts not built yet (pre-4b) — bodies are assert.fail TODO regardless.
  }
});

describe("makeTakeoverVisualDriver — no-op without an overlay context (G-PY2.3.2)", () => {
  it("T-Gate.1: overlayContextId=undefined + cronEnabled + client → driver returns false, no callInOverlay", () => {
    assert.ok(makeTakeoverVisualDriver, "builder 4b must export makeTakeoverVisualDriver");
    callInOverlayCalls.length = 0;
    const d = makeTakeoverVisualDriver(makeState({ overlayContextId: undefined }), makeSession(FAKE_CLIENT));
    assert.equal(d("fn"), false, "no overlay context → not painted");
    assert.equal(callInOverlayCalls.length, 0, "no overlay push without a context");
  });
});

describe("makeTakeoverVisualDriver — no-op in Manual (G-PY2.3.2)", () => {
  it("T-Gate.2: overlayContextId=7 + cronEnabled=false + client → false, no callInOverlay", () => {
    assert.ok(makeTakeoverVisualDriver, "builder 4b must export makeTakeoverVisualDriver");
    callInOverlayCalls.length = 0;
    const d = makeTakeoverVisualDriver(makeState({ cronEnabled: false }), makeSession(FAKE_CLIENT));
    assert.equal(d("fn"), false, "Manual mode → not painted");
    assert.equal(callInOverlayCalls.length, 0, "no overlay push in Manual");
  });
});

describe("makeTakeoverVisualDriver — no-op without a client (G-PY2.3.2)", () => {
  it("T-Gate.3: overlayContextId=7 + cronEnabled + getClient()→undefined → false, no callInOverlay", () => {
    assert.ok(makeTakeoverVisualDriver, "builder 4b must export makeTakeoverVisualDriver");
    callInOverlayCalls.length = 0;
    const d = makeTakeoverVisualDriver(makeState(), makeSession(undefined));
    assert.equal(d("fn"), false, "no CDP client → not painted");
    assert.equal(callInOverlayCalls.length, 0, "no overlay push without a client");
  });
});

describe("makeTakeoverVisualDriver — paints in Auto + overlay (G-PY2.3.2)", () => {
  it("T-Gate.4: overlayContextId=7 + cronEnabled + client → driver returns true AND callInOverlay(handle,7,fn) once", () => {
    assert.ok(makeTakeoverVisualDriver, "builder 4b must export makeTakeoverVisualDriver");
    callInOverlayCalls.length = 0;
    const d = makeTakeoverVisualDriver(makeState(), makeSession(FAKE_CLIENT));
    assert.equal(d("FN"), true, "Auto + overlay + client → painted");
    assert.equal(callInOverlayCalls.length, 1, "exactly one overlay push");
    assert.equal(callInOverlayCalls[0]?.[0], FAKE_CLIENT.handle, "pushed to the CDP client handle");
    assert.equal(callInOverlayCalls[0]?.[1], 7, "into the overlay context id");
    assert.equal(callInOverlayCalls[0]?.[2], "FN", "with the supplied fn declaration verbatim");
  });
});

describe("showEdgeRing — gated on cronEnabled (G-PY2.3.5)", () => {
  it("T-Ring.1: showEdgeRing no-ops when cronEnabled=false; when true → callInOverlay with window.__frondoseShowEdgeRing()", () => {
    assert.ok(showEdgeRing, "builder 4b must export showEdgeRing");
    callInOverlayCalls.length = 0;
    showEdgeRing(makeState({ cronEnabled: false }), makeSession(FAKE_CLIENT));
    assert.equal(callInOverlayCalls.length, 0, "no ring in Manual");
    showEdgeRing(makeState(), makeSession(FAKE_CLIENT));
    assert.equal(callInOverlayCalls.length, 1, "ring shown in Auto");
    assert.ok(
      callInOverlayCalls[0]?.[2].includes("window.__frondoseShowEdgeRing()"),
      "Auto ring fn calls __frondoseShowEdgeRing()",
    );
  });
});

describe("hideEdgeRing — ungated, clears target too (G-PY2.3.5)", () => {
  it("T-Ring.2: hideEdgeRing (cronEnabled=false, overlay present) → callInOverlay fn has BOTH __frondoseHideEdgeRing() AND __frondoseClearAgentTarget(); overlayContextId=undefined → no call", () => {
    assert.ok(hideEdgeRing, "builder 4b must export hideEdgeRing");
    // ungated: retract fires even in Manual (cronEnabled=false) — always safe to clear
    callInOverlayCalls.length = 0;
    hideEdgeRing(makeState({ cronEnabled: false }), makeSession(FAKE_CLIENT));
    assert.equal(callInOverlayCalls.length, 1, "hide is ungated — fires even in Manual");
    const fn = callInOverlayCalls[0]?.[2] ?? "";
    assert.ok(fn.includes("window.__frondoseHideEdgeRing()"), "hide fn retracts the ring");
    assert.ok(fn.includes("window.__frondoseClearAgentTarget()"), "hide fn ALSO clears the target (cursor+highlight)");
    // but with no overlay context there is nothing to push to
    callInOverlayCalls.length = 0;
    hideEdgeRing(makeState({ overlayContextId: undefined }), makeSession(FAKE_CLIENT));
    assert.equal(callInOverlayCalls.length, 0, "no push without an overlay context");
  });
});
