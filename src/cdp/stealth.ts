import type { CdpClient } from "./client.js";

/**
 * Stealth init script — applied via Page.addScriptToEvaluateOnNewDocument
 * with runImmediately: true. Body wrapped in an IIFE so inner declarations
 * don't pollute the page's global namespace.
 *
 * Patches per scout Q-P2.9 / 0.3 plan §6:
 *  1. navigator.webdriver → undefined
 *  2. Delete cdc_* Chromedriver globals (no-op under raw CDP, defense-in-depth)
 *  3. Restore window.chrome.runtime if absent
 *  4. navigator.plugins → 5 realistic PDF stubs only when native plugins are empty
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

  // 4. navigator.plugins — [P-62 F-2 / OQ-2] PRESERVE NATIVE non-empty. Only patch when Chrome
  //    natively exposes ZERO plugins (automation-empty Chrome / fresh container / some headless
  //    builds). Real Chrome 148 on macOS natively exposes PDF plugins → we leave them intact.
  if (navigator.plugins.length === 0) {
    const realPluginsProto = Object.getPrototypeOf(navigator.plugins);
    const fakePlugin = (name, filename, description) => ({
      name, filename, description, length: 0,
      item: () => null, namedItem: () => null,
      [Symbol.iterator]: function*() {},
      [Symbol.toStringTag]: 'Plugin',
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
  }
  // 4b. [P-62 F-3 / OQ-3] WebRTC policy: NATIVE — no mitigation in this script. See
  //     docs/phase-62-webrtc-policy.md for the operator-set decision + revisit conditions.

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
 * [P-62 F-1] Inject the stealth script into the current page target. Idempotent (OQ-4):
 * a second call on the same client EARLY-RETURNS without re-registering. The client's
 * `stealthInjected` flag becomes the navigate() precondition — see CdpClient.navigate().
 *
 * Signature change vs P-2: accepts a CdpClient (not a raw CdpHandle) so we can mark the
 * flag after registration. Callers that previously passed `client.handle` must pass `client`.
 */
export async function injectStealth(client: CdpClient): Promise<string | undefined> {
  if (client.isStealthInjected()) return undefined;
  await client.handle.Page.enable();
  const result = await client.handle.Page.addScriptToEvaluateOnNewDocument({
    source: STEALTH_INIT_SCRIPT,
    runImmediately: true,
  });
  client.markStealthInjected();
  return result.identifier as string;
}
