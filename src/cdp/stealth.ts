import type { CdpHandle } from "./types.js";

/**
 * Stealth init script — applied via Page.addScriptToEvaluateOnNewDocument
 * with runImmediately: true. Body wrapped in an IIFE so inner declarations
 * don't pollute the page's global namespace.
 *
 * Patches per scout Q-P2.9 / 0.3 plan §6:
 *  1. navigator.webdriver → undefined
 *  2. Delete cdc_* Chromedriver globals (no-op under raw CDP, defense-in-depth)
 *  3. Restore window.chrome.runtime if absent
 *  4. navigator.plugins → 5 realistic PDF stubs
 *  5. permissions.query notification path returns Notification.permission
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. navigator.webdriver — delete from Navigator.prototype entirely.
  //    defineProperty on the instance alone still makes 'webdriver' in navigator
  //    return true (Intoli "WebDriver New" checks property presence, not value).
  delete Object.getPrototypeOf(navigator).webdriver;

  // 2. cdc_* Chromedriver globals (defense-in-depth under raw CDP)
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

  // 3. window.chrome.runtime
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = window.chrome.runtime || {};

  // 4. navigator.plugins — 5 PDF stubs. Capture the real PluginArray prototype
  //    from navigator.plugins BEFORE overriding it (PluginArray is not a global in
  //    modern Chrome, so PluginArray.prototype would ReferenceError).
  const realPluginsProto = Object.getPrototypeOf(navigator.plugins);
  const fakePlugin = (name, filename, description) => ({
    name, filename, description, length: 0,
    item: () => null, namedItem: () => null,
    [Symbol.iterator]: function*() {},
    [Symbol.toStringTag]: 'Plugin',  // makes .toString() return '[object Plugin]'
  });
  const fakePlugins = Object.assign([
    fakePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
    fakePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', ''),
    fakePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', ''),
    fakePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', ''),
    fakePlugin('WebKit built-in PDF', 'internal-pdf-viewer', ''),
  ], { item: () => null, namedItem: () => null, refresh: () => null });
  try { Object.setPrototypeOf(fakePlugins, realPluginsProto); } catch (_) {}
  Object.defineProperty(navigator, 'plugins', {
    get: () => fakePlugins,
    configurable: true,
  });

  // 5. permissions.query notifications path
  if (navigator.permissions && navigator.permissions.query) {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : orig(p);
  }
})();
`.trim();

/**
 * Inject the stealth script into the current page target.
 * MUST be called before the first navigation, OR with runImmediately: true to
 * patch an already-loaded page.
 */
export async function injectStealth(client: CdpHandle): Promise<string> {
  await client.Page.enable();
  const result = await client.Page.addScriptToEvaluateOnNewDocument({
    source: STEALTH_INIT_SCRIPT,
    runImmediately: true,
  });
  return result.identifier as string;
}
