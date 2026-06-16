/**
 * P-55 Step 5 — T-Overlay.1, T-Overlay.2 (G-P55.2, G-P55.1)
 *
 * Mock tests for `src/overlay/inject.ts` (created at builder Step 4b).
 *
 * Gate coverage:
 *   G-P55.2 — `installOverlay` injects the bootstrap source into the `frondose-overlay`
 *              isolated world with `runImmediately:true` (T-Overlay.1)
 *   G-P55.1 — `installOverlay` registers the `__frondosePost` binding in ALL contexts;
 *              no `executionContextName` / `executionContextId` (OQ-5) (T-Overlay.2)
 *
 * No Chrome, no LLM, no filesystem I/O.  Fake CdpHandle (CdpHandle = any).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ─── G-P55.2 + G-P55.1: installOverlay — CDP call sequence + addBinding shape ─

describe("installOverlay — CDP call sequence and Runtime.addBinding arg shape (G-P55.2, G-P55.1)", () => {
  it("T-Overlay.1: given fakeHandle with spied Runtime.enable/Page.enable/Runtime.addBinding/Page.addScriptToEvaluateOnNewDocument, when installOverlay(fakeHandle), THEN addScriptToEvaluateOnNewDocument called ONCE with {source:<non-empty>, worldName:'frondose-overlay', runImmediately:true}; return value === identifier; call ORDER Runtime.enable[0]→Page.enable[1]→Runtime.addBinding[2]→Page.addScriptToEvaluateOnNewDocument[3]", async () => {
    // Given: fake CdpHandle (CdpHandle=any) with spy functions recording call order via
    //        a shared call-index counter; Page.addScriptToEvaluateOnNewDocument returns
    //        {identifier: "id-7"}
    // When:  await installOverlay(fakeHandle) — the 4-step CDP sequence fires
    // Then:  addScriptToEvaluateOnNewDocument called ONCE with locked arg shape
    //        {source:<non-empty string>, worldName:"frondose-overlay", runImmediately:true};
    //        installOverlay resolves to "id-7";
    //        call ORDER: Runtime.enable first, Page.enable second, Runtime.addBinding third,
    //        Page.addScriptToEvaluateOnNewDocument fourth (indices 0–3)
    // biome-ignore lint/suspicious/noExplicitAny: CdpHandle is typed as any (src/cdp/types.ts)
    let mod: any;
    try {
      mod = await import("../../src/overlay/inject.js");
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        assert.fail("TODO Step 5: T-Overlay.1 — src/overlay/inject.ts not yet created (builder Step 4b pending)");
      }
      throw e;
    }
    const { installOverlay } = mod;

    const calls: string[] = [];
    let addScriptArg: Record<string, unknown> = {};

    const fakeHandle = {
      Runtime: {
        enable: async () => {
          calls.push("Runtime.enable");
        },
        addBinding: async (_arg: unknown) => {
          calls.push("Runtime.addBinding");
        },
      },
      Page: {
        enable: async () => {
          calls.push("Page.enable");
        },
        addScriptToEvaluateOnNewDocument: async (arg: unknown) => {
          addScriptArg = arg as Record<string, unknown>;
          calls.push("Page.addScriptToEvaluateOnNewDocument");
          return { identifier: "id-7" };
        },
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: test-only fake handle
    const result = await installOverlay(fakeHandle as any);

    // Verify call ORDER (G-P55.2)
    assert.equal(calls.length, 4, "exactly 4 CDP calls fired");
    assert.equal(calls[0], "Runtime.enable", "index 0 must be Runtime.enable");
    assert.equal(calls[1], "Page.enable", "index 1 must be Page.enable");
    assert.equal(calls[2], "Runtime.addBinding", "index 2 must be Runtime.addBinding");
    assert.equal(
      calls[3],
      "Page.addScriptToEvaluateOnNewDocument",
      "index 3 must be Page.addScriptToEvaluateOnNewDocument",
    );

    // Verify addScriptToEvaluateOnNewDocument arg shape (G-P55.2)
    assert.ok(
      typeof addScriptArg.source === "string" && addScriptArg.source.length > 0,
      "source must be a non-empty string (OVERLAY_BOOTSTRAP_JS)",
    );
    assert.equal(addScriptArg.worldName, "frondose-overlay", "worldName must be 'frondose-overlay'");
    assert.equal(addScriptArg.runImmediately, true, "runImmediately must be true");

    // Verify return value
    assert.equal(result, "id-7", "return value must be identifier from addScriptToEvaluateOnNewDocument");
  });

  it("T-Overlay.2: given fakeHandle with spied Runtime.addBinding, when installOverlay(fakeHandle), THEN Runtime.addBinding called ONCE; arg deep-equals {name:'__frondosePost'}; Object.keys(arg).length === 1 (no executionContextName, no executionContextId — OQ-5 all-contexts)", async () => {
    // Given: same fake CdpHandle setup as T-Overlay.1 (spied Runtime.addBinding captures the
    //        single call argument)
    // When:  await installOverlay(fakeHandle)
    // Then:  Runtime.addBinding call count === 1;
    //        call arg deep-equals {name: "__frondosePost"};
    //        Object.keys(callArg).length === 1 — exactly one field, no context filter fields
    // biome-ignore lint/suspicious/noExplicitAny: CdpHandle is typed as any (src/cdp/types.ts)
    let mod: any;
    try {
      mod = await import("../../src/overlay/inject.js");
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        assert.fail("TODO Step 5: T-Overlay.2 — src/overlay/inject.ts not yet created (builder Step 4b pending)");
      }
      throw e;
    }
    const { installOverlay } = mod;

    let addBindingArg: unknown;
    let addBindingCallCount = 0;

    const fakeHandle = {
      Runtime: {
        enable: async () => {},
        addBinding: async (arg: unknown) => {
          addBindingArg = arg;
          addBindingCallCount++;
        },
      },
      Page: {
        enable: async () => {},
        addScriptToEvaluateOnNewDocument: async (_arg: unknown) => ({ identifier: "id-x" }),
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: test-only fake handle
    await installOverlay(fakeHandle as any);

    // G-P55.1: Runtime.addBinding called exactly once with {name:"__frondosePost"} and no extras
    assert.equal(addBindingCallCount, 1, "Runtime.addBinding called exactly once");
    assert.deepEqual(addBindingArg, { name: "__frondosePost" }, "arg must deep-equal {name:'__frondosePost'}");
    assert.equal(
      Object.keys(addBindingArg as object).length,
      1,
      "exactly 1 key: no executionContextName, no executionContextId (OQ-5 all-contexts)",
    );
  });
});
