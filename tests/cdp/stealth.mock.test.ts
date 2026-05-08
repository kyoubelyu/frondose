/**
 * P-2 mock tests — T-M4..T-M7: STEALTH_INIT_SCRIPT content + injectStealth().
 *
 * Tests run with no Chrome required.
 * Script execution uses node:vm so stealth patches apply to a fake global
 * context without touching the test process's own globals.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { injectStealth, STEALTH_INIT_SCRIPT } from "../../src/cdp/stealth.js";

// ─── T-M4 ─────────────────────────────────────────────────────────────────────

test("T-M4: STEALTH_INIT_SCRIPT parses as valid JS", () => {
  // If the script is syntactically invalid, new Function() throws a SyntaxError.
  assert.doesNotThrow(() => {
    new Function(STEALTH_INIT_SCRIPT);
  }, "STEALTH_INIT_SCRIPT must be syntactically valid JavaScript");
});

// ─── T-M5 ─────────────────────────────────────────────────────────────────────

test("T-M5: STEALTH_INIT_SCRIPT patches navigator.webdriver / cdc_* / chrome.runtime", () => {
  // Build a minimal fake global context matching what STEALTH_INIT_SCRIPT expects.
  const nav = {
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
    // Provide Object so Object.defineProperty resolves from sandbox globals
    Object: Object,
    Symbol: Symbol,
  };

  vm.runInNewContext(STEALTH_INIT_SCRIPT, sandbox);

  // 1. navigator.webdriver must return undefined via the installed getter
  assert.equal(
    // Object.getOwnPropertyDescriptor works on the nav object from outer context
    Object.getOwnPropertyDescriptor(nav, "webdriver")?.get?.(),
    undefined,
    "navigator.webdriver getter must return undefined",
  );

  // 2. cdc_* globals must be deleted from window
  assert.ok(!("cdc_adoQpoasnfa76pfcZLmcfl_Array" in win), "cdc_Array must be deleted");
  assert.ok(!("cdc_adoQpoasnfa76pfcZLmcfl_Promise" in win), "cdc_Promise must be deleted");
  assert.ok(!("cdc_adoQpoasnfa76pfcZLmcfl_Symbol" in win), "cdc_Symbol must be deleted");

  // 3. window.chrome.runtime must be an object
  const chrome = win.chrome as Record<string, unknown> | undefined;
  assert.ok(chrome, "window.chrome must exist after stealth patch");
  assert.equal(typeof chrome.runtime, "object", "window.chrome.runtime must be an object");
});

// ─── T-M6 ─────────────────────────────────────────────────────────────────────

test("T-M6: navigator.plugins stub returns 5 entries each with name/filename/description", () => {
  const nav: Record<string, unknown> = {
    permissions: {
      query: async (_p: unknown) => ({ state: "default" }),
    },
  };

  const win: Record<string, unknown> = {};

  const sandbox: vm.Context = {
    navigator: nav,
    window: win,
    Notification: { permission: "default" },
    Object: Object,
    Symbol: Symbol,
  };

  vm.runInNewContext(STEALTH_INIT_SCRIPT, sandbox);

  // After stealth, navigator.plugins must be a length-5 array-like with name/filename/description strings
  const plugins = nav.plugins as unknown;
  assert.ok(plugins !== null && typeof plugins === "object", "navigator.plugins must be an object");

  const pluginObj = plugins as { length: number; [index: number]: Record<string, unknown> };
  assert.equal(pluginObj.length, 5, "navigator.plugins.length must be 5");

  for (let i = 0; i < 5; i++) {
    const p = pluginObj[i];
    assert.ok(p !== undefined && p !== null, `plugins[${i}] must exist`);
    assert.equal(typeof p.name, "string", `plugins[${i}].name must be a string`);
    assert.ok((p.name as string).length > 0, `plugins[${i}].name must be non-empty`);
    assert.equal(typeof p.filename, "string", `plugins[${i}].filename must be a string`);
    // description may be empty per scout Q-P2.9 — assert typeof only
    assert.equal(typeof p.description, "string", `plugins[${i}].description must be a string`);
  }
});

// ─── T-M7 ─────────────────────────────────────────────────────────────────────

test("T-M7: injectStealth calls Page.enable then addScriptToEvaluateOnNewDocument with runImmediately:true", async () => {
  // Track call order with a shared sequence log
  const callLog: string[] = [];

  const fakeClient = {
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
        // Verify payload immediately
        assert.equal(source, STEALTH_INIT_SCRIPT, "source must equal STEALTH_INIT_SCRIPT");
        assert.equal(runImmediately, true, "runImmediately must be true");
        return { identifier: "stealth-id-1" };
      },
    },
  };

  const identifier = await injectStealth(fakeClient);

  assert.equal(identifier, "stealth-id-1", "injectStealth must return the identifier");
  assert.deepEqual(
    callLog,
    ["Page.enable", "Page.addScriptToEvaluateOnNewDocument"],
    "Page.enable must be called before addScriptToEvaluateOnNewDocument",
  );
});
