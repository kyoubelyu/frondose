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
import { CdpClient } from "../../src/cdp/client.js";
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
  // P-Z3 (cat-2): the current mechanism (stealth.ts:20) DELETES `webdriver` from
  // Navigator.prototype (not a getter on the instance), and step 4 captures
  // Object.getPrototypeOf(navigator.plugins) — so the sandbox must give navigator a
  // prototype carrying `webdriver` + a `plugins` object. Assert EFFECTS, not the script text.
  const navProto: Record<string, unknown> = { webdriver: false };
  const nav: Record<string, unknown> = Object.create(navProto);
  nav.permissions = { query: async (_p: unknown) => ({ state: "default" }) };
  nav.plugins = []; // has Array.prototype → step-4 getPrototypeOf works

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
    Promise: Promise,
  };

  vm.runInNewContext(STEALTH_INIT_SCRIPT, sandbox);

  // 1. `webdriver` deleted from the prototype → `"webdriver" in navigator` is false
  //    (Intoli "WebDriver New" checks property PRESENCE, which the prototype-delete defeats).
  assert.ok(!("webdriver" in nav), "navigator.webdriver must be absent after prototype-delete");

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
  // P-Z3 (cat-2): give navigator a prototype + a starting `plugins` (step-4 captures its proto).
  const navProto: Record<string, unknown> = { webdriver: false };
  const nav: Record<string, unknown> = Object.create(navProto);
  nav.permissions = { query: async (_p: unknown) => ({ state: "default" }) };
  nav.plugins = [];

  const win: Record<string, unknown> = {};

  const sandbox: vm.Context = {
    navigator: nav,
    window: win,
    Notification: { permission: "default" },
    Object: Object,
    Symbol: Symbol,
    Promise: Promise,
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
  // [P-62 Step 5 fix] injectStealth now takes CdpClient (not raw handle).
  // Use CdpClient.fromHandle(fakeHandle) to wrap the fake Page domain.
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
        // Verify payload immediately
        assert.equal(source, STEALTH_INIT_SCRIPT, "source must equal STEALTH_INIT_SCRIPT");
        assert.equal(runImmediately, true, "runImmediately must be true");
        return { identifier: "stealth-id-1" };
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  const identifier = await injectStealth(client);

  assert.equal(identifier, "stealth-id-1", "injectStealth must return the identifier");
  assert.deepEqual(
    callLog,
    ["Page.enable", "Page.addScriptToEvaluateOnNewDocument"],
    "Page.enable must be called before addScriptToEvaluateOnNewDocument",
  );
});
