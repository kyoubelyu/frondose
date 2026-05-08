import { homedir } from "node:os";
import { join } from "node:path";
import { launch as chromeLaunch } from "chrome-launcher";
// @ts-expect-error chrome-remote-interface ships no types; any-bleed contained via CdpHandle in types.ts (plan R-P2-01)
import CDP from "chrome-remote-interface";
import type { ChromeHandle, ChromeLaunchOptions } from "./types.js";

const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE_DIR = (): string => join(homedir(), ".mai", "agent", "chrome-profile");

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

  const launched = await launchFn({
    port,
    userDataDir: profileDir,
    chromeFlags: opts.chromeFlags ?? [],
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
