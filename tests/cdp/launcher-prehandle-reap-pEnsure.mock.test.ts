/**
 * P-ENSURECHROME-PREHANDLE-REAP Step-2 RED scaffold.
 *
 * The package-level mock makes the current public launch() path observable while
 * also supplying the Launcher class the planned implementation must own. No OS
 * browser is started by this file.
 */

import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, mock } from "node:test";

interface FakeOptions {
  port?: number;
  userDataDir?: string | boolean;
  chromeFlags?: string[];
  ignoreDefaultFlags?: boolean;
  handleSIGINT?: boolean;
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exitListenerAdds = 0;

  constructor(readonly pid: number) {
    super();
    this.on("newListener", (eventName) => {
      if (eventName === "exit" || eventName === "close") this.exitListenerAdds++;
    });
  }

  exit(signal: NodeJS.Signals = "SIGKILL"): void {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
  }
}

type Scenario = "reject" | "success" | "reuse";

interface HarnessState {
  scenario: Scenario;
  error: Error;
  child: FakeChild;
  unrelated: FakeChild;
  publicLaunchCalls: number;
  launcherConstructs: number;
  killCalls: number;
  unrelatedKillCalls: number;
  killThrows: Error | null;
  exitOnKill: boolean;
  eventOnlyOnKill: boolean;
  mutateToUnrelatedBeforeReject: boolean;
  mutateCapturedChildPidBeforeReject: boolean;
  spawnCalls: number;
  launcherSpawnArgs: string[] | null;
  launcherSpawnOptions: SpawnOptions | null;
  forwardedSpawnCommand: string | null;
  forwardedSpawnArgs: readonly string[] | null;
  forwardedSpawnOptions: SpawnOptions | null;
  capturedOptions: FakeOptions | null;
}

let state = makeState();

function makeState(overrides: Partial<HarnessState> = {}): HarnessState {
  return {
    scenario: "reject",
    error: new Error("debugger readiness rejected after spawn"),
    child: new FakeChild(41_001),
    unrelated: new FakeChild(41_002),
    publicLaunchCalls: 0,
    launcherConstructs: 0,
    killCalls: 0,
    unrelatedKillCalls: 0,
    killThrows: null,
    exitOnKill: true,
    eventOnlyOnKill: false,
    mutateToUnrelatedBeforeReject: false,
    mutateCapturedChildPidBeforeReject: false,
    spawnCalls: 0,
    launcherSpawnArgs: null,
    launcherSpawnOptions: null,
    forwardedSpawnCommand: null,
    forwardedSpawnArgs: null,
    forwardedSpawnOptions: null,
    capturedOptions: null,
    ...overrides,
  };
}

const fakeSpawn = ((command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess => {
  state.spawnCalls++;
  state.forwardedSpawnCommand = command;
  state.forwardedSpawnArgs = args ?? null;
  state.forwardedSpawnOptions = options ?? null;
  return state.child as unknown as ChildProcess;
}) as typeof import("node:child_process").spawn;

class FakeLauncher {
  chromeProcess?: ChildProcess;
  pid?: number;
  port?: number;
  private readonly spawnImpl: typeof import("node:child_process").spawn;

  constructor(options: FakeOptions = {}, moduleOverrides: { spawn?: typeof import("node:child_process").spawn } = {}) {
    state.launcherConstructs++;
    state.capturedOptions = { ...options, chromeFlags: [...(options.chromeFlags ?? [])] };
    this.port = options.port;
    this.spawnImpl = moduleOverrides.spawn ?? fakeSpawn;
  }

  async launch(): Promise<void> {
    if (state.scenario === "reuse") return;
    const spawnArgs = ["--fake-arg", "--fake-marker"];
    const spawnOptions: SpawnOptions = { detached: true, stdio: "ignore" };
    state.launcherSpawnArgs = spawnArgs;
    state.launcherSpawnOptions = spawnOptions;
    this.chromeProcess = this.spawnImpl("fake-chrome", spawnArgs, spawnOptions);
    this.pid = this.chromeProcess.pid;
    if (state.mutateToUnrelatedBeforeReject) {
      this.chromeProcess = state.unrelated as unknown as ChildProcess;
      this.pid = state.unrelated.pid;
    }
    if (state.mutateCapturedChildPidBeforeReject) {
      (state.child as unknown as { pid: number }).pid += 900;
    }
    if (state.scenario === "reject") throw state.error;
  }

  kill(): void {
    const target = this.chromeProcess as unknown as FakeChild | undefined;
    if (target === state.child) state.killCalls++;
    if (target === state.unrelated) state.unrelatedKillCalls++;
    if (state.killThrows) throw state.killThrows;
    if (state.eventOnlyOnKill) {
      target?.emit("exit", null, "SIGKILL");
      target?.emit("close", null, "SIGKILL");
    } else if (state.exitOnKill) {
      target?.exit();
    }
  }
}

async function unsafePublicLaunch(options: FakeOptions = {}) {
  state.publicLaunchCalls++;
  state.capturedOptions = { ...options, chromeFlags: [...(options.chromeFlags ?? [])] };
  if (state.scenario !== "success") throw state.error;
  return {
    pid: state.child.pid,
    port: options.port ?? 9222,
    process: state.child as unknown as ChildProcess,
    remoteDebuggingPipes: null,
    kill: () => {
      state.killCalls++;
      if (state.killThrows) throw state.killThrows;
      if (state.exitOnKill) state.child.exit();
    },
  };
}

mock.module("chrome-launcher", {
  namedExports: {
    Launcher: FakeLauncher,
    launch: unsafePublicLaunch,
  },
});
mock.module("node:child_process", {
  namedExports: {
    spawn: fakeSpawn,
  },
});

const launcherModule = await import("../../src/cdp/launcher.js");
const { ensureChrome } = launcherModule;

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function invokeEnsure(): Promise<Awaited<ReturnType<typeof ensureChrome>>> {
  const profileDir = mkdtempSync(join(tmpdir(), "frondose-prehandle-"));
  try {
    return await ensureChrome({
      port: await freePort(),
      profileDir,
      chromeFlags: ["--phase-prehandle-marker"],
    });
  } finally {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function selectProductionDefault(): void {
  const setter = launcherModule.__setLaunchFn as unknown as (fn?: typeof unsafePublicLaunch) => void;
  setter(unsafePublicLaunch);
}

async function settleAfterFakeTimeout(
  tc: Parameters<Parameters<typeof it>[2]>[0],
  operation: Promise<unknown>,
): Promise<unknown> {
  let settled = false;
  const outcome = operation.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  for (let turn = 0; turn < 30 && !settled && state.child.listenerCount("exit") === 0; turn++) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  tc.mock.timers.tick(4_999);
  await Promise.resolve();
  assert.equal(settled, false, "exact cleanup timeout must remain pending through 4,999 ms");
  tc.mock.timers.tick(1);
  return outcome;
}

describe("P-ENSURECHROME exact pre-handle ownership", { concurrency: false }, () => {
  it("T-PRE.1: when readiness rejects after spawn, exact child exits before the identical launch error is observed", async (tc) => {
    // Given: launcher A exposes its exact child and then rejects; When: ensureChrome runs; Then: A is killed/exited before the identical error reaches the caller.
    state = makeState();
    selectProductionDefault();
    const clearTimeoutMock = tc.mock.method(globalThis, "clearTimeout");

    let caught: unknown;
    try {
      await invokeEnsure();
      assert.fail("ensureChrome must reject");
    } catch (error) {
      caught = error;
    }

    assert.equal(state.publicLaunchCalls, 0, "production default must not use the handle-late public launch wrapper");
    assert.equal(state.launcherConstructs, 1, "production must retain one exact Launcher before awaiting readiness");
    assert.equal(state.killCalls, 1, "the exact spawned launcher must be force-killed once");
    assert.notEqual(state.child.signalCode, null, "caller rejection must wait for exact child exit state");
    assert.strictEqual(caught, state.error, "successful cleanup must preserve the exact original launch error");
    assert.equal(state.child.listenerCount("exit"), 0);
    assert.equal(state.child.listenerCount("close"), 0);
    assert.equal(clearTimeoutMock.mock.callCount(), 1, "successful exit must cancel its armed timeout");
  });

  it("T-PRE.2: when owned A rejects beside unrelated B, cleanup touches A only", async () => {
    // Given: live owned A and unrelated B; When: A readiness rejects; Then: only A's bound authority runs and B stays live.
    state = makeState();
    selectProductionDefault();

    assert.equal(state.unrelated.listenerCount("exit"), 0);
    assert.equal(state.unrelated.listenerCount("close"), 0);
    await assert.rejects(invokeEnsure(), (error) => error === state.error);

    assert.equal(state.killCalls, 1, "owned A must be killed once");
    assert.equal(state.unrelatedKillCalls, 0, "unrelated B must receive no cleanup authority");
    assert.equal(state.unrelated.exitCode, null);
    assert.equal(state.unrelated.signalCode, null);
    assert.equal(state.unrelated.listenerCount("exit"), 0);
    assert.equal(state.unrelated.listenerCount("close"), 0);
    assert.equal(state.unrelated.exitListenerAdds, 0, "B must never receive even a transient exit listener");
  });

  it("T-PRE.5: when launcher fields are redirected from captured A to B, cleanup restores and kills A only", async () => {
    // Given: spawn callback captured A before the launcher mutates its public fields to B; When: readiness rejects; Then: exact A is restored/killed and B stays untouched.
    state = makeState({ mutateToUnrelatedBeforeReject: true });
    selectProductionDefault();

    assert.equal(state.unrelated.listenerCount("exit"), 0);
    assert.equal(state.unrelated.listenerCount("close"), 0);
    await assert.rejects(invokeEnsure(), (error) => error === state.error);

    assert.equal(state.spawnCalls, 1, "the exact child must be captured at the dependency spawn boundary");
    assert.equal(state.killCalls, 1, "captured A must still be killed");
    assert.equal(state.unrelatedKillCalls, 0, "mutated launcher field B must not redirect cleanup");
    assert.notEqual(state.child.signalCode, null);
    assert.equal(state.unrelated.signalCode, null);
    assert.equal(state.unrelated.listenerCount("exit"), 0);
    assert.equal(state.unrelated.listenerCount("close"), 0);
    assert.equal(state.unrelated.exitListenerAdds, 0, "mutable B must never receive even a transient exit listener");
  });

  it("T-PRE.5c: the type-preserving spawn wrapper forwards all dependency arguments unchanged", async () => {
    // Given: the dependency invokes its overloaded spawn with command/args/options; When: readiness rejects; Then: the wrapper captures A and forwards every argument by identity.
    state = makeState();
    selectProductionDefault();

    await assert.rejects(invokeEnsure(), (error) => error === state.error);

    assert.equal(state.forwardedSpawnCommand, "fake-chrome");
    assert.strictEqual(state.forwardedSpawnArgs, state.launcherSpawnArgs);
    assert.strictEqual(state.forwardedSpawnOptions, state.launcherSpawnOptions);
    assert.equal(state.spawnCalls, 1);
    assert.equal(state.killCalls, 1);
  });

  it("T-PRE.5b: when captured A's own PID mutates, cleanup fails without granting PID-only kill authority", async (tc) => {
    // Given: spawn capture freezes A's PID and the retained child later reports another PID; When: readiness rejects; Then: identity failure is visible and neither A nor B kill authority runs.
    state = makeState({ mutateCapturedChildPidBeforeReject: true });
    selectProductionDefault();
    const clearTimeoutMock = tc.mock.method(globalThis, "clearTimeout");

    let caught: unknown;
    try {
      await invokeEnsure();
      assert.fail("ensureChrome must reject");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AggregateError);
    assert.strictEqual(caught.errors[0], state.error);
    assert.match(String(caught.errors[1]), /identity|pid/i);
    assert.equal(state.killCalls, 0);
    assert.equal(state.unrelatedKillCalls, 0);
    assert.equal(state.child.listenerCount("exit"), 0);
    assert.equal(state.child.listenerCount("close"), 0);
    assert.equal(state.unrelated.listenerCount("exit"), 0);
    assert.equal(state.unrelated.listenerCount("close"), 0);
    assert.equal(clearTimeoutMock.mock.callCount(), 0, "identity rejection must not arm a timer it cannot own");
  });

  it("T-PRE.3: when the exact spawned child already exited, rejection does not arm or kill it again", async (tc) => {
    // Given: A already has exit state when its launch rejects; When: cleanup inspects A; Then: kill is skipped and the original error survives.
    const child = new FakeChild(41_003);
    child.exit("SIGTERM");
    state = makeState({ child });
    selectProductionDefault();
    const setTimeoutMock = tc.mock.method(globalThis, "setTimeout");

    await assert.rejects(invokeEnsure(), (error) => error === state.error);

    assert.equal(state.publicLaunchCalls, 0);
    assert.equal(state.launcherConstructs, 1);
    assert.equal(state.killCalls, 0, "an already-exited exact child must not be killed again");
    assert.equal(state.child.exitListenerAdds, 0, "already-exited A must not receive transient cleanup listeners");
    assert.equal(setTimeoutMock.mock.callCount(), 0, "already-exited A must not create a cleanup timer");
  });

  it("T-PRE.4: when exact cleanup throws, launch and cleanup failures remain ordered and visible", async (tc) => {
    // Given: launch error E and cleanup error C; When: pre-handle cleanup fails; Then: AggregateError orders [E,C] and keeps E as cause.
    const cleanupError = new Error("exact kill failed");
    state = makeState({ killThrows: cleanupError });
    selectProductionDefault();
    const clearTimeoutMock = tc.mock.method(globalThis, "clearTimeout");

    let caught: unknown;
    try {
      await invokeEnsure();
      assert.fail("ensureChrome must reject");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AggregateError, "cleanup failure must not be hidden behind the launch error");
    assert.deepEqual(caught.errors, [state.error, cleanupError]);
    assert.strictEqual(caught.cause, state.error);
    assert.equal(state.child.listenerCount("exit"), 0);
    assert.equal(state.child.listenerCount("close"), 0);
    assert.equal(clearTimeoutMock.mock.callCount(), 1, "throwing kill must cancel its armed timeout");
  });

  it("T-PRE.4b: a never-exiting exact child times out, aggregates, and disposes exit listeners", async (tc) => {
    // Given: exact kill dispatch returns but A never exits; When: the five-second bound elapses; Then: timeout is ordered after E and listeners are removed.
    tc.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      state = makeState({ exitOnKill: false });
      selectProductionDefault();
      const caught = await settleAfterFakeTimeout(tc, invokeEnsure());

      assert.ok(caught instanceof AggregateError);
      assert.strictEqual(caught.errors[0], state.error);
      assert.match(String(caught.errors[1]), /did not exit|timed out/i);
      assert.equal(state.child.listenerCount("exit"), 0);
      assert.equal(state.child.listenerCount("close"), 0);
    } finally {
      tc.mock.timers.reset();
    }
  });

  it("T-PRE.4c: event-only exit without exitCode/signalCode is rejected as non-terminal", async (tc) => {
    // Given: A emits exit/close while both terminal state fields stay null; When: cleanup waits; Then: events alone do not prove exit and the timeout remains visible.
    tc.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      state = makeState({ eventOnlyOnKill: true });
      selectProductionDefault();
      const caught = await settleAfterFakeTimeout(tc, invokeEnsure());

      assert.ok(caught instanceof AggregateError);
      assert.strictEqual(caught.errors[0], state.error);
      assert.match(String(caught.errors[1]), /did not exit|timed out/i);
      assert.equal(state.child.exitCode, null);
      assert.equal(state.child.signalCode, null);
      assert.equal(state.child.listenerCount("exit"), 0);
      assert.equal(state.child.listenerCount("close"), 0);
    } finally {
      tc.mock.timers.reset();
    }
  });

  it("T-PRE.6: when the inner launcher wins a reuse race, no cleanup authority is returned", async () => {
    // Given: the outer probe missed but the inner launcher reuses the port without a child; When: ensureChrome resolves; Then: launched=false and no kill/listener ownership exists.
    state = makeState({ scenario: "reuse" });
    selectProductionDefault();

    const before = process.listenerCount("SIGINT");
    const handle = await invokeEnsure();

    assert.equal(state.publicLaunchCalls, 0);
    assert.equal(state.launcherConstructs, 1);
    assert.equal(handle.launched, false);
    assert.equal(handle.kill, undefined);
    assert.equal(state.killCalls, 0);
    assert.equal(process.listenerCount("SIGINT"), before, "reuse race must leave no exact SIGINT owner");
  });

  it("T-PRE.7: a successful handle kill remains pending until its exact child reaches exit state", async (tc) => {
    // Given: successful owned A whose kill signal does not immediately publish exit; When: handle.kill runs; Then: it settles only after A exits and invokes kill once.
    state = makeState({ scenario: "success", exitOnKill: false });
    selectProductionDefault();

    const handle = await invokeEnsure();
    assert.equal(handle.launched, true);
    assert.ok(handle.kill);
    tc.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const setTimeoutMock = tc.mock.method(globalThis, "setTimeout");
      const clearTimeoutMock = tc.mock.method(globalThis, "clearTimeout");
      let firstSettled = false;
      let secondSettled = false;
      const firstRawCleanup = handle.kill();
      const secondRawCleanup = handle.kill();
      assert.strictEqual(firstRawCleanup, secondRawCleanup, "concurrent cleanup calls must return the same promise");
      const firstCleanup = firstRawCleanup.then(() => {
        firstSettled = true;
      });
      const secondCleanup = secondRawCleanup.then(() => {
        secondSettled = true;
      });
      await Promise.resolve();
      assert.equal(firstSettled, false, "first kill promise must wait for exact exit");
      assert.equal(secondSettled, false, "concurrent second kill promise must share the same pending cleanup");
      assert.equal(state.killCalls, 1, "concurrent cleanup calls must dispatch exact kill once");
      assert.equal(state.child.listenerCount("exit"), 1);
      assert.equal(state.child.listenerCount("close"), 1);
      assert.equal(state.child.exitListenerAdds, 2, "shared cleanup must arm exactly one exit/close listener pair");
      assert.equal(setTimeoutMock.mock.callCount(), 1, "shared cleanup must create exactly one timer");
      state.child.exit();
      await Promise.all([firstCleanup, secondCleanup]);
      assert.equal(state.killCalls, 1, "repeated cleanup must share one idempotent exact cleanup");
      assert.equal(state.child.listenerCount("exit"), 0);
      assert.equal(state.child.listenerCount("close"), 0);
      assert.equal(clearTimeoutMock.mock.callCount(), 1, "shared successful cleanup must cancel one timeout owner");
      tc.mock.timers.tick(5_000);
      await Promise.resolve();
      assert.equal(setTimeoutMock.mock.callCount(), 1, "settlement must leave no residual timer owner");
      assert.equal(clearTimeoutMock.mock.callCount(), 1);
    } finally {
      tc.mock.timers.reset();
    }
  });

  it("T-PRE.9b: injected no-process test fakes keep the established public option contract", async () => {
    // Given: a DI-only public-shaped fake that starts no browser; When: ensureChrome calls it; Then: it sees handleSIGINT=true while owned production alone overrides false.
    state = makeState({ scenario: "success" });
    let injectedOptions: FakeOptions | undefined;
    let injectedKillCalls = 0;
    const setter = launcherModule.__setLaunchFn as unknown as (fn?: typeof unsafePublicLaunch) => void;
    setter(async (options: FakeOptions = {}) => {
      injectedOptions = options;
      return {
        pid: 0,
        port: options.port ?? 9222,
        process: null as unknown as ChildProcess,
        remoteDebuggingPipes: null,
        kill: () => {
          injectedKillCalls++;
        },
      };
    });
    try {
      const handle = await invokeEnsure();
      await handle.kill?.();
      assert.equal(injectedOptions?.handleSIGINT, true);
      assert.equal(injectedKillCalls, 1);
      assert.equal(state.launcherConstructs, 0);
      assert.equal(state.spawnCalls, 0);
    } finally {
      selectProductionDefault();
    }
  });

  it("T-PRE.9: owned class launch preserves current port/profile/default/custom flag options", async () => {
    // Given: a successful launch with a custom marker; When: the owned class is constructed; Then: current launch options reach that exact instance unchanged.
    state = makeState({ scenario: "success" });
    selectProductionDefault();

    const handle = await invokeEnsure();
    await handle.kill?.();

    assert.equal(state.publicLaunchCalls, 0);
    assert.equal(state.launcherConstructs, 1);
    assert.equal(state.capturedOptions?.ignoreDefaultFlags, true);
    assert.ok(state.capturedOptions?.chromeFlags?.includes("--phase-prehandle-marker"));
    assert.equal(typeof state.capturedOptions?.userDataDir, "string");
    assert.equal(state.capturedOptions?.handleSIGINT, false, "broad package SIGINT registry must stay disabled");
  });

  it("T-PRE.10: resetting the test seam with undefined still selects exact owned production", async () => {
    // Given: an injected launch seam; When: it is reset with undefined; Then: the next rejection still runs through the owned Launcher and exact cleanup.
    state = makeState();
    const setter = launcherModule.__setLaunchFn as unknown as (fn?: typeof unsafePublicLaunch) => void;
    setter(undefined);

    await assert.rejects(invokeEnsure(), (error) => error === state.error);

    assert.equal(state.publicLaunchCalls, 0);
    assert.equal(state.launcherConstructs, 1);
    assert.equal(state.killCalls, 1);
    assert.notEqual(state.child.signalCode, null);
  });

  it("T-PRE.8/10 structural: production owns Launcher/spawn directly and has no broad signal or cleanup registry", () => {
    // Given: the production launcher source; When: its acquisition/cleanup structure is inspected; Then: exact Launcher+spawn ownership exists and broad/public-default escape hatches do not.
    const source = readFileSync(resolve("src/cdp/launcher.ts"), "utf8");
    assert.match(source, /import\s*\{[^}]*\bLauncher\b[^}]*\}\s*from\s*["']chrome-launcher["']/s);
    assert.match(source, /from\s*["']node:child_process["']/);
    assert.doesNotMatch(source, /\bkillAll\s*\(/);
    assert.doesNotMatch(source, /(?:pkill|killall|taskkill)[^\n]*(?:chrome|chromium)/i);
    assert.doesNotMatch(source, /process\.(?:once|on)\(\s*["']SIGINT["']/);
    assert.doesNotMatch(
      source,
      /let\s+launchFn\s*:\s*typeof\s+chromeLaunch\s*=\s*chromeLaunch/,
      "the public handle-late wrapper must never again be the production default",
    );
  });
});
