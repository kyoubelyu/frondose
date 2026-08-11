import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Options as ChromeLauncherOptions, launch as chromeLaunch, Launcher } from "chrome-launcher";
import { DEFAULT_FLAGS } from "chrome-launcher/dist/flags.js";
// @ts-expect-error chrome-remote-interface ships no types; any-bleed contained via CdpHandle in types.ts (plan R-P2-01)
import CDP from "chrome-remote-interface";
import { DATA_DIR_NAME, getHomeBase } from "../persistence/paths.js";
import { clearStaleSingletonLocks } from "./profileLock.js";
import type { ChromeHandle, ChromeLaunchOptions } from "./types.js";

const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE_DIR = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "chrome-profile");

const TARGET_POLL_INTERVAL_MS = 300;
const TARGET_POLL_MAX_ATTEMPTS = 10;
const CHROME_EXIT_TIMEOUT_MS = 5_000;

interface OwnedLauncher {
  launcher: Launcher;
  child: ChildProcess;
  pid: number;
  killBound: () => void;
  killExact: () => Promise<void>;
}

type LaunchOutcome =
  | { kind: "reused"; port: number }
  | { kind: "spawned"; port: number; killExact: () => Promise<void> };

/** Page target descriptor returned by CDP.List / CDP.New. */
export interface PageTarget {
  id: string;
  webSocketDebuggerUrl: string;
  type: "page";
}

/**
 * Test-only DI seam for public-shaped fakes that start no OS process. Passing
 * the real package export or undefined restores Frondose's exact-owner default.
 * Not re-exported from `src/cdp/index.ts`.
 */
let injectedLaunchFn: typeof chromeLaunch | undefined;

/** @internal — test-only DI hook; consumers should not call. */
export function __setLaunchFn(fn?: typeof chromeLaunch): void {
  injectedLaunchFn = fn && fn !== chromeLaunch ? fn : undefined;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function forceKillOwned(owned: Omit<OwnedLauncher, "killExact">): Promise<void> {
  if (hasExited(owned.child)) return Promise.resolve();
  if (owned.child.pid !== owned.pid) {
    return Promise.reject(new Error(`Exact Chrome identity changed from PID ${owned.pid}`));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const dispose = () => {
      owned.child.removeListener("exit", onTerminalState);
      owned.child.removeListener("close", onTerminalState);
      if (timer) clearTimeout(timer);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      dispose();
      if (error) reject(error);
      else resolve();
    };
    const onTerminalState = () => {
      if (hasExited(owned.child)) finish();
    };

    owned.child.once("exit", onTerminalState);
    owned.child.once("close", onTerminalState);
    timer = setTimeout(() => {
      if (hasExited(owned.child)) finish();
      else finish(new Error(`Exact Chrome PID ${owned.pid} did not exit within ${CHROME_EXIT_TIMEOUT_MS} ms`));
    }, CHROME_EXIT_TIMEOUT_MS);

    try {
      // Launcher.kill() contains the dependency's mature POSIX process-group /
      // Windows tree kill. Restore only this retained launcher's exact child so
      // mutable public fields cannot redirect that authority to another Chrome.
      owned.launcher.chromeProcess = owned.child;
      owned.launcher.pid = owned.pid;
      owned.killBound();
      onTerminalState();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function ownLauncher(launcher: Launcher, child: ChildProcess): OwnedLauncher {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Chrome launcher returned no valid exact child PID");
  }

  const base = {
    launcher,
    child,
    pid,
    killBound: launcher.kill.bind(launcher),
  };
  let cleanupPromise: Promise<void> | undefined;
  return {
    ...base,
    killExact: () => {
      cleanupPromise ??= forceKillOwned(base);
      return cleanupPromise;
    },
  };
}

function requireLauncherPort(port: number | undefined): number {
  if (!Number.isInteger(port) || (port ?? -1) < 0) throw new Error("Chrome launcher returned no valid port");
  return port as number;
}

async function launchOwned(options: ChromeLauncherOptions): Promise<LaunchOutcome> {
  let owned: OwnedLauncher | undefined;
  let launcher!: Launcher;
  const captureSpawn = new Proxy(spawnChild, {
    apply(target, thisArg, argArray) {
      const child = Reflect.apply(target, thisArg, argArray) as ChildProcess;
      if (owned) throw new Error("Chrome launcher spawned more than one root child");
      owned = ownLauncher(launcher, child);
      return child;
    },
  });
  launcher = new Launcher({ ...options, handleSIGINT: false }, { spawn: captureSpawn });

  try {
    await launcher.launch();
  } catch (error) {
    const captured = owned;
    if (!captured) throw error;
    try {
      await captured.killExact();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Chrome launch and exact cleanup failed", { cause: error });
    }
    throw error;
  }

  const captured = owned;
  if (!captured) return { kind: "reused", port: requireLauncherPort(launcher.port) };
  return { kind: "spawned", port: requireLauncherPort(launcher.port), killExact: captured.killExact };
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

  mkdirSync(profileDir, { recursive: true });
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
  // treat ~/.frondose/agent/chrome-profile/ as session-equivalent secret state.
  const launchOptions: ChromeLauncherOptions = {
    port,
    userDataDir: profileDir,
    chromeFlags: [...DEFAULT_FLAGS, ...(opts.chromeFlags ?? [])],
    ignoreDefaultFlags: true,
    handleSIGINT: true,
  };

  // Public-shaped injected fakes are a no-process test contract and retain the
  // historical options/kill behavior. Production always uses exact ownership.
  const injected = injectedLaunchFn;
  if (injected) {
    const launched = await injected(launchOptions);
    return {
      port: launched.port,
      launched: true,
      kill: async () => {
        launched.kill();
      },
    };
  }

  const outcome = await launchOwned(launchOptions);
  if (outcome.kind === "reused") {
    return { port: outcome.port, launched: false, kill: undefined };
  }

  return {
    port: outcome.port,
    launched: true,
    kill: outcome.killExact,
  };
}
