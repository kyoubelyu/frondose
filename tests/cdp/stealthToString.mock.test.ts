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
  // P-Z3 (cat-2): current mechanism (stealth.ts:20) DELETES `webdriver` from the
  // Navigator prototype + step-4 captures Object.getPrototypeOf(navigator.plugins) —
  // so navigator needs a prototype carrying `webdriver` + a `plugins` object.
  const navProto: Record<string, unknown> = { webdriver: false };
  const nav: Record<string, unknown> & {
    permissions: { query: (p: unknown) => Promise<{ state: string }> };
  } = Object.assign(Object.create(navProto), {
    permissions: {
      query: async (_p: unknown) => ({ state: "default" }),
    },
    plugins: [],
  });

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
    Promise: Promise,
  };

  vm.runInNewContext(STEALTH_INIT_SCRIPT, sandbox);
  return { nav, sandbox };
}

// ─── T-ST.1 ───────────────────────────────────────────────────────────────────

describe("STEALTH_INIT_SCRIPT navigator.webdriver — prototype-delete mechanism (G-P32.19)", () => {
  it("T-ST.1: after stealth, navigator.webdriver is absent (deleted from the prototype)", () => {
    // Given: STEALTH_INIT_SCRIPT evaluated in a VM sandbox.
    // When:  navigator.webdriver presence is checked.
    // Then:  P-Z3 — the current mechanism (stealth.ts:20) DELETES `webdriver` from the
    //        Navigator prototype, so `"webdriver" in navigator` is false (stronger than the
    //        old getter-returns-undefined: Intoli "WebDriver New" checks property PRESENCE).
    const { nav } = makeStealthSandbox();
    assert.ok(!("webdriver" in nav), "T-ST.1: navigator.webdriver must be absent after prototype-delete");
    assert.equal(nav.webdriver, undefined, "T-ST.1: accessing navigator.webdriver yields undefined");
  });

  it("T-ST.2: no `webdriver` getter exists to fingerprint (prototype-delete supersedes the P-32 getter+toString fix)", () => {
    // Given: STEALTH_INIT_SCRIPT evaluated in a VM sandbox.
    // When:  the property descriptor for `webdriver` is sought on the instance AND prototype.
    // Then:  P-Z3 — there is NO getter anywhere (the prototype-delete removed the property
    //        entirely), so there is nothing whose `.toString()` could leak a fake getter —
    //        the old P-32 1-level toString-fingerprint concern is moot by construction.
    const { nav } = makeStealthSandbox();
    assert.equal(
      Object.getOwnPropertyDescriptor(nav, "webdriver"),
      undefined,
      "T-ST.2: no own `webdriver` descriptor (no instance getter installed)",
    );
    const proto = Object.getPrototypeOf(nav);
    assert.equal(
      proto && Object.getOwnPropertyDescriptor(proto, "webdriver"),
      undefined,
      "T-ST.2: no prototype `webdriver` descriptor (deleted) → no getter to fingerprint",
    );
  });
});
