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
  // P-32 (OQ-5): patch the getter's OWN toString so it reports native code.
  const wd = () => undefined;
  Object.defineProperty(wd, 'toString', {
    value: () => 'function get webdriver() { [native code] }',
    writable: true, configurable: true,
  });
  Object.defineProperty(navigator, 'webdriver', { get: wd, configurable: true });
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = window.chrome.runtime || {};
  const fakePlugin = (name, filename, description) => ({
    name, filename, description, length: 0,
    item: () => null, namedItem: () => null,
    [Symbol.iterator]: function*() {},
  });
  Object.defineProperty(navigator, 'plugins', {
    get: () => Object.assign([
      fakePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', ''),
      fakePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', ''),
      fakePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', ''),
      fakePlugin('WebKit built-in PDF', 'internal-pdf-viewer', ''),
    ], { item: () => null, namedItem: () => null, refresh: () => null }),
    configurable: true,
  });
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
