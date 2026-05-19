/**
 * P-32 Step 4a — T-ST.1, T-ST.2
 *
 * Tests: STEALTH_INIT_SCRIPT navigator.webdriver 1-level toString fix (plan §6.5 / OQ-5).
 * Evaluates the stealth script in a VM sandbox — no Chrome, no network required.
 *
 * Gate coverage:
 *   G-P32.19 — T-ST.1, T-ST.2
 *
 * Note: after P-32, STEALTH_INIT_SCRIPT replaces the simple `get: () => undefined`
 * with a wrapper that also patches the getter's OWN toString to return
 * "function get webdriver() { [native code] }".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { STEALTH_INIT_SCRIPT } from "../../src/cdp/stealth.js";

// ─── VM sandbox helpers ───────────────────────────────────────────────────────

/**
 * Build a minimal JS sandbox that STEALTH_INIT_SCRIPT expects.
 * Returns the sandbox object so tests can inspect navigator post-execution.
 */
function makeStealthSandbox() {
  const nav: Record<string, unknown> & {
    permissions: { query: (p: unknown) => Promise<{ state: string }> };
  } = {
    permissions: {
      query: async (_p: unknown) => ({ state: "default" }),
    },
  };

  const win: Record<string, unknown> = {
    cdc_adoQpoasnfa76pfcZLmcfl_Array: 1,
    cdc_adoQpoasnfa76pfcZLmcfl_Promise: 1,
    cdc_adoQpoasnfa76pfcZLmcfl_Symbol: 1,
  };

  const sandbox: vm.Context = {
    navigator: nav,
    window: win,
    Notification: { permission: "default" },
    Object: Object,
    Symbol: Symbol,
    Function: Function,
  };

  vm.runInNewContext(STEALTH_INIT_SCRIPT, sandbox);
  return { nav, sandbox };
}

// ─── T-ST.1 ───────────────────────────────────────────────────────────────────

describe("STEALTH_INIT_SCRIPT navigator.webdriver toString fix — G-P32.19", () => {
  it("T-ST.1: after P-32 stealth edit, navigator.webdriver getter returns undefined", () => {
    // Given: STEALTH_INIT_SCRIPT evaluated in a VM sandbox
    // When:  navigator.webdriver is accessed
    // Then:  returns undefined (existing P-2 behavior unchanged)
    const { nav } = makeStealthSandbox();
    const descriptor = Object.getOwnPropertyDescriptor(nav, "webdriver");
    assert.ok(descriptor?.get !== undefined, "T-ST.1: navigator must have a 'webdriver' getter installed");
    const value = descriptor?.get?.call(nav);
    assert.equal(value, undefined, "T-ST.1: navigator.webdriver must return undefined");
  });

  it("T-ST.2: navigator.webdriver getter's own toString returns 'function get webdriver() { [native code] }' (1-level fix, OQ-5)", () => {
    // Given: STEALTH_INIT_SCRIPT evaluated in a VM sandbox; P-32 applies 1-level toString patch
    // When:  Object.getOwnPropertyDescriptor(navigator,"webdriver").get.toString() is called
    // Then:  returns exactly "function get webdriver() { [native code] }"
    //        (G-P32.19 — the 1-level fix; wd.toString.toString() residual is noted in R-8/OQ-5)
    const { nav } = makeStealthSandbox();
    const descriptor = Object.getOwnPropertyDescriptor(nav, "webdriver");
    assert.ok(descriptor?.get !== undefined, "T-ST.2: navigator must have a 'webdriver' getter");
    const getterToString = descriptor?.get?.toString();
    assert.equal(
      getterToString,
      "function get webdriver() { [native code] }",
      "T-ST.2: getter.toString() must return 'function get webdriver() { [native code] }' (1-level toString fix)",
    );
  });
});
