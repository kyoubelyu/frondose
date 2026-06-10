import { join } from "node:path";
import { launch as chromeLaunch } from "chrome-launcher";
import { DEFAULT_FLAGS } from "chrome-launcher/dist/flags.js";
// @ts-expect-error chrome-remote-interface ships no types; any-bleed contained via CdpHandle in types.ts (plan R-P2-01)
import CDP from "chrome-remote-interface";
import { getHomeBase } from "../persistence/paths.js";
import { clearStaleSingletonLocks } from "./profileLock.js";
import type { ChromeHandle, ChromeLaunchOptions } from "./types.js";

const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE_DIR = (): string => join(getHomeBase(), ".mai", "agent", "chrome-profile");

const TARGET_POLL_INTERVAL_MS = 300;
const TARGET_POLL_MAX_ATTEMPTS = 10;

/** Page target descriptor returned by CDP.List / CDP.New. */
export interface PageTarget {
  id: string;
  webSocketDebuggerUrl: string;
  type: "page";
}

/**
 * Test-only DI seam (per guardian critic CONCERN-MR-4): mirrors P-1's
 * `__resolveModelSpec` private-export pattern so validator T-M2 can inject a
 * fake launch fn without `mock.module()`. Not re-exported from `src/cdp/index.ts`.
 */
let launchFn: typeof chromeLaunch = chromeLaunch;

/** @internal — test-only DI hook; consumers should not call. */
export function __setLaunchFn(fn: typeof chromeLaunch): void {
  launchFn = fn;
}

/** DI hook for tests — defaults to chrome-remote-interface's CDP.List. */
// biome-ignore lint/suspicious/noExplicitAny: chrome-remote-interface has no types
let __listFn: (opts: { port: number; host: string }) => Promise<any[]> = async (opts) =>
  // biome-ignore lint/suspicious/noExplicitAny: same
  (await (CDP as any).List(opts)) as any[];

/** DI hook for tests — defaults to chrome-remote-interface's CDP.New. */
let __newFn: (
  opts: { port: number; host: string; url: string },
  // biome-ignore lint/suspicious/noExplicitAny: same
) => Promise<any> = async (opts) => (await (CDP as any).New(opts)) as any;

/** @internal — exposed for validator tests only; do not call from production code. */
export function __setListFn(fn: typeof __listFn): void {
  __listFn = fn;
}

/** @internal — exposed for validator tests only; do not call from production code. */
export function __setNewFn(fn: typeof __newFn): void {
  __newFn = fn;
}

/**
 * Wait until Chrome exposes at least one inspectable page target on /json/list.
 * Polls up to TARGET_POLL_MAX_ATTEMPTS × TARGET_POLL_INTERVAL_MS (3s).
 * If still no page target, calls CDP.New() to force-create about:blank.
 *
 * Resolves the "No inspectable targets" race: chrome-launcher.launch() returns
 * as soon as /json/version responds, but the new-tab page may not yet be listed.
 */
export async function waitForPageTarget(port: number): Promise<PageTarget> {
  for (let attempt = 0; attempt < TARGET_POLL_MAX_ATTEMPTS; attempt++) {
    const targets = await __listFn({ port, host: "127.0.0.1" });
    const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string") as
      | PageTarget
      | undefined;
    if (page) return page;
    if (attempt < TARGET_POLL_MAX_ATTEMPTS - 1) {
      await new Promise<void>((r) => setTimeout(r, TARGET_POLL_INTERVAL_MS));
    }
  }
  // Fallback: explicitly create a new tab.
  const newTab = await __newFn({ port, host: "127.0.0.1", url: "about:blank" });
  if (typeof newTab?.webSocketDebuggerUrl !== "string") {
    throw new Error(`waitForPageTarget: CDP.New({port:${port}}) returned no webSocketDebuggerUrl; cannot connect.`);
  }
  return newTab as PageTarget;
}

/**
 * Ensure a Chrome instance is running on the given port and return a handle.
 * Probe-first: HTTP-checks /json/version on the port via CDP.Version. If alive,
 * reuse without spawning. Otherwise launch via chrome-launcher with a persistent
 * user-data-dir.
 */
export async function ensureChrome(opts: ChromeLaunchOptions = {}): Promise<ChromeHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const profileDir = opts.profileDir ?? DEFAULT_PROFILE_DIR();

  // Probe: is Chrome already on this port?
  try {
    await CDP.Version({ port, host: "127.0.0.1" });
    return { port, launched: false, kill: undefined };
  } catch {
    // Not reachable; launch.
  }

  await clearStaleSingletonLocks(profileDir);

  // P-75 D-6.3 fix (supersedes P-15 rationale): the mai-browser shell-out is
  // retired (P-APP-1) so this profile dir is Frondose-exclusive. The Frondose
  // .app bundle is ad-hoc signed, so Chrome cannot read the macOS Keychain
  // "Chrome Safe Storage" ACL (errSecInteractionNotAllowed -25308) — every
  // cookie write under the default keychain path fails and the LinkedIn
  // session is lost on relaunch. chrome-launcher's DEFAULT_FLAGS already
  // include --use-mock-keychain, which makes Chromium derive the cookie
  // wrapping key from a constant in-binary string instead of the Keychain
  // (verified empirically 2026-06-10: cookie round-trip across graceful
  // restart, 3/3 stable runs). Let DEFAULT_FLAGS flow through unmodified.
  // NOTE: cookies are encrypted at rest under a constant, non-secret key;
  // treat ~/.mai/agent/chrome-profile/ as session-equivalent secret state.
  const launched = await launchFn({
    port,
    userDataDir: profileDir,
    chromeFlags: [...DEFAULT_FLAGS, ...(opts.chromeFlags ?? [])],
    ignoreDefaultFlags: true,
    handleSIGINT: true,
  });

  return {
    port: launched.port,
    launched: true,
    // chrome-launcher's kill() is synchronous (returns void); wrap in async to
    // honor the ChromeHandle.kill: () => Promise<void> contract in types.ts.
    kill: async () => {
      launched.kill();
    },
  };
}
