/**
 * P-2 CDP layer — public surface for P-3+ LinkedIn primitives.
 *
 * Imports from this module:
 *   - CdpClient                — typed wrapper around chrome-remote-interface
 *   - ensureChrome             — launch-or-reuse helper
 *   - injectStealth            — apply STEALTH_INIT_SCRIPT to a CDP client
 *   - STEALTH_INIT_SCRIPT      — the raw stealth script string
 *   - getSnapshot              — Accessibility-tree snapshot helper
 *   - waitForUrl/Load/Text/Fn  — wait primitives
 *   - WaitTimeoutError         — thrown by waitFor* on timeout
 *   - All P-2 types            — Snapshot, RefMap, ChromeHandle, etc.
 */

export { CdpClient } from "./client.js";
export type { PageTarget } from "./launcher.js";
export { ensureChrome, waitForPageTarget } from "./launcher.js";
export { getSnapshot } from "./snapshot.js";
export { injectStealth, STEALTH_INIT_SCRIPT } from "./stealth.js";
export type {
  CdpHandle,
  ChromeHandle,
  ChromeLaunchOptions,
  ElementRef,
  RefMap,
  ScreenshotOptions,
  Snapshot,
  SnapshotOptions,
  WaitFnOptions,
  WaitForOpts,
  WaitOptions,
  WaitState,
  WaitTextOptions,
} from "./types.js";
export { WaitTimeoutError } from "./types.js";
export { waitForFn, waitForLoad, waitForText, waitForUrl } from "./waitFor.js";
