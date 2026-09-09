import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options as ChromeOptions, Launcher } from "chrome-launcher";

export interface BrowserHandleLike {
  pid: number;
  port: number;
  process: ChildProcess;
  kill: () => void;
}

export interface TrackedBrowser {
  readonly handle: BrowserHandleLike;
  readonly pid: number;
  readonly child: ChildProcess;
  readonly killExact: () => void;
}

export interface BrowserOwner<TClient> {
  readonly browser: TrackedBrowser;
  readonly client: TClient;
  finish(primaryError?: unknown): Promise<void>;
}

export interface BrowserOwnerOptions<TClient> {
  acquire: (onSpawn: (handle: BrowserHandleLike) => void) => Promise<void>;
  connect: (browser: TrackedBrowser) => Promise<TClient>;
  setup?: (client: TClient) => Promise<void>;
  close: (client: TClient) => Promise<void>;
  stageTimeoutMs?: number;
  exitTimeoutMs?: number;
}

const DEFAULT_STAGE_TIMEOUT_MS = 10_000;
const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function throwOrdered(label: string, errors: unknown[]): never {
  const normalized = errors.map(asError);
  if (normalized.length === 1) throw normalized[0];
  throw new AggregateError(normalized, label);
}

export async function runIndependentCleanups(
  label: string,
  steps: Array<() => void | Promise<void>>,
  primaryError?: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  if (primaryError !== undefined) errors.push(primaryError);
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throwOrdered(label, errors);
}

function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function trackBrowser(handle: BrowserHandleLike): TrackedBrowser {
  const pid = handle.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || handle.process.pid !== pid) {
    throw new Error(`invalid browser identity: handle=${String(pid)} child=${String(handle.process.pid)}`);
  }
  return Object.freeze({
    handle,
    pid,
    child: handle.process,
    killExact: handle.kill.bind(handle),
  });
}

async function runBounded<T>(
  label: string,
  operation: Promise<T>,
  timeoutMs: number,
  onLateResolve?: (value: T) => void | Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      void operation.then(
        async (value) => {
          try {
            await onLateResolve?.(value);
          } catch {}
        },
        () => {},
      );
    }
  }
}

export async function forceKillTrackedBrowser(
  tracked: TrackedBrowser,
  timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
): Promise<void> {
  const identityErrors: Error[] = [];
  if (tracked.handle.pid !== tracked.pid)
    identityErrors.push(new Error("browser handle PID mutated after acquisition"));
  if (tracked.handle.process !== tracked.child) {
    identityErrors.push(new Error("browser handle ChildProcess mutated after acquisition"));
  }
  if (!Number.isSafeInteger(tracked.pid) || tracked.pid <= 0 || tracked.child.pid !== tracked.pid) {
    identityErrors.push(new Error("tracked browser identity is no longer valid"));
  }

  if (isExited(tracked.child)) {
    if (identityErrors.length > 0) throwOrdered("browser identity changed", identityErrors);
    return;
  }

  let resolveExit!: () => void;
  const exitObserved = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const onExitState = () => {
    if (isExited(tracked.child)) resolveExit();
  };
  tracked.child.once("exit", onExitState);
  tracked.child.once("close", onExitState);
  onExitState();

  const errors: unknown[] = [...identityErrors];
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!isExited(tracked.child)) {
      try {
        tracked.killExact();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await Promise.race([
        exitObserved,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`browser PID ${tracked.pid} did not exit within ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      errors.push(error);
    }
    if (!isExited(tracked.child)) errors.push(new Error(`browser PID ${tracked.pid} remains live after force-kill`));
  } finally {
    if (timer) clearTimeout(timer);
    tracked.child.removeListener("exit", onExitState);
    tracked.child.removeListener("close", onExitState);
  }
  if (errors.length > 0) throwOrdered("exact browser cleanup failed", errors);
}

async function finishOwned<TClient>(
  client: TClient | undefined,
  tracked: TrackedBrowser,
  close: (client: TClient) => Promise<void>,
  stageTimeoutMs: number,
  exitTimeoutMs: number,
  primaryError?: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  if (primaryError !== undefined) errors.push(primaryError);
  if (client !== undefined) {
    try {
      await runBounded(
        "browser client close",
        Promise.resolve().then(() => close(client)),
        stageTimeoutMs,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await forceKillTrackedBrowser(tracked, exitTimeoutMs);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throwOrdered("browser owner failed", errors);
}

export async function openOwnedBrowser<TClient>(options: BrowserOwnerOptions<TClient>): Promise<BrowserOwner<TClient>> {
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const exitTimeoutMs = options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
  let tracked: TrackedBrowser | undefined;
  let client: TClient | undefined;
  try {
    await options.acquire((handle) => {
      if (tracked) throw new Error("browser acquisition reported more than one child");
      tracked = trackBrowser(handle);
    });
    if (!tracked) throw new Error("browser acquisition completed without exposing its exact child");
    const exactTracked: TrackedBrowser = tracked;
    client = await runBounded(
      "browser client connect",
      Promise.resolve().then(() => options.connect(exactTracked)),
      stageTimeoutMs,
      (lateClient) =>
        runBounded("late browser client close", options.close(lateClient), stageTimeoutMs).then(() => undefined),
    );
    if (options.setup) {
      await runBounded(
        "browser client setup",
        Promise.resolve().then(() => options.setup?.(client as TClient)),
        stageTimeoutMs,
      );
    }
  } catch (error) {
    if (!tracked) throw error;
    await finishOwned(client, tracked, options.close, stageTimeoutMs, exitTimeoutMs, error);
    throw new Error("unreachable");
  }

  let finished = false;
  const exactTracked: TrackedBrowser = tracked;
  const exactClient: TClient = client;
  return {
    browser: exactTracked,
    client: exactClient,
    async finish(primaryError?: unknown): Promise<void> {
      if (finished) {
        if (primaryError !== undefined) throw asError(primaryError);
        return;
      }
      finished = true;
      await finishOwned(exactClient, exactTracked, options.close, stageTimeoutMs, exitTimeoutMs, primaryError);
    },
  };
}

export async function withOwnedBrowser<TClient, TResult>(
  options: BrowserOwnerOptions<TClient>,
  body: (owner: BrowserOwner<TClient>) => Promise<TResult>,
): Promise<TResult> {
  const owner = await openOwnedBrowser(options);
  try {
    const result = await body(owner);
    await owner.finish();
    return result;
  } catch (error) {
    await owner.finish(error);
    throw new Error("unreachable");
  }
}

export async function acquireChrome(
  options: ChromeOptions,
  onSpawn: (handle: BrowserHandleLike) => void,
): Promise<void> {
  // Explicit temp userDataDir: chrome-launcher's derived default resolves a
  // Windows-style profile path with undefined drive/user on WSL, creating a
  // literal `undefined:/Users/undefined/...` directory under the repo root.
  const userDataDir = options.userDataDir ?? join(tmpdir(), `frondose-test-chrome-${process.pid}`);
  const launcher = new Launcher({ ...options, userDataDir, handleSIGINT: false });
  let settled = false;
  const outcome = launcher.launch().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void outcome.then(() => {
    settled = true;
  });

  while (!launcher.chromeProcess && !settled) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const reportSpawn = () => {
    if (!launcher.chromeProcess || launcher.pid === undefined || launcher.port === undefined) return false;
    onSpawn({
      pid: launcher.pid,
      port: launcher.port,
      process: launcher.chromeProcess,
      kill: launcher.kill.bind(launcher),
    });
    return true;
  };
  let reported = reportSpawn();
  const result = await outcome;
  if (!reported) reported = reportSpawn();
  if (!result.ok) throw result.error;
  if (!reported) throw new Error("Chrome launcher completed without exposing its exact child");
}

export function openOwnedChrome<TClient>(
  options: Omit<BrowserOwnerOptions<TClient>, "acquire"> & { chromeOptions: ChromeOptions },
): Promise<BrowserOwner<TClient>> {
  return openOwnedBrowser({
    ...options,
    acquire: (onSpawn) => acquireChrome(options.chromeOptions, onSpawn),
  });
}

export function withOwnedChrome<TClient, TResult>(
  options: Omit<BrowserOwnerOptions<TClient>, "acquire"> & { chromeOptions: ChromeOptions },
  body: (owner: BrowserOwner<TClient>) => Promise<TResult>,
): Promise<TResult> {
  return withOwnedBrowser({ ...options, acquire: (onSpawn) => acquireChrome(options.chromeOptions, onSpawn) }, body);
}
