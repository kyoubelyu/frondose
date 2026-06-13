/**
 * P-APP-6 Step 3a — Test scaffold for src/app/sidecarMain.ts
 *
 * WIN-1 migrated: --sock/sockPath/MAI_SOCK → --port-file/portFile/FRONDOSE_PORT_FILE
 *
 * Covers:
 *   T-Sidecar.Args.1  — flag parse: --port-file <p> --token <t>
 *   T-Sidecar.Args.2  — flag parse: --port-file=<p> --token=<t> form
 *   T-Sidecar.Args.3  — env fallback when flags absent (FRONDOSE_PORT_FILE + FRONDOSE_TOKEN)
 *   T-Sidecar.Args.4  — flag wins over env when both set
 *   T-Sidecar.Args.5  — missing both flags + env → exit(2) + stderr FATAL message
 *   T-Sidecar.Main.1  — main() registers crash handlers + calls runServeSubcommand
 *   T-Sidecar.Main.2  — importing module does NOT auto-run main() (entrypoint guard)
 *   T-Sidecar.Main.3  — crash-handler registered BEFORE serve graph dynamic-import
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/app/sidecarMain.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

const SIDECAR_SRC = resolve(process.cwd(), "src/app/sidecarMain.ts");

// Guard: if the source file does not exist yet, the describe bodies below
// fail on their assertions (not on ENOENT), keeping the scaffold "compilable
// but all-red" as required.
const sourceExists = existsSync(SIDECAR_SRC);

// ---------------------------------------------------------------------------
// Module-level dynamic import — resolved in before() after mocks are wired.
// ---------------------------------------------------------------------------

type ParseArgs = (argv: string[]) => { portFile: string; bearerToken: string };
type Main = () => Promise<void>;
type SidecarModule = { parseArgs: ParseArgs; main: Main };

let sidecarModule: SidecarModule | null = null;

// ── Arg-parsing tests (T-Sidecar.Args.*) ───────────────────────────────────
// These tests call parseArgs() directly; no module-level mocks needed here
// beyond isolating process.env side-effects.

describe("T-Sidecar.Args — parseArgs flag and env resolution", () => {
  before(async () => {
    if (sourceExists) {
      // Import after any env setup; mocks for crashLogger / serve not needed
      // because parseArgs() is a pure function with no side effects.
      const url = pathToFileURL(SIDECAR_SRC).href;
      sidecarModule = (await import(url).catch(() => null)) as SidecarModule | null;
    }
  });

  it("T-Sidecar.Args.1: when --port-file and --token flags are present, parseArgs returns both values", () => {
    // Given: argv = ["--port-file", "/tmp/frondose.port", "--token", "abc"]
    // When:  parseArgs(argv) runs
    // Then:  returns { portFile: "/tmp/frondose.port", bearerToken: "abc" }
    assert.ok(sourceExists, "src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure)");
    assert.ok(sidecarModule, "sidecarMain module must load");
    const result = sidecarModule.parseArgs(["--port-file", "/tmp/frondose.port", "--token", "abc"]);
    assert.deepEqual(result, { portFile: "/tmp/frondose.port", bearerToken: "abc" });
  });

  it("T-Sidecar.Args.2: when --port-file=<p> and --token=<t> forms are used, parseArgs returns both values", () => {
    // Given: argv = ["--port-file=/tmp/y.port", "--token=xyz"]
    // When:  parseArgs(argv) runs
    // Then:  returns { portFile: "/tmp/y.port", bearerToken: "xyz" }
    assert.ok(sourceExists, "src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure)");
    assert.ok(sidecarModule, "sidecarMain module must load");
    const result = sidecarModule.parseArgs(["--port-file=/tmp/y.port", "--token=xyz"]);
    assert.deepEqual(result, { portFile: "/tmp/y.port", bearerToken: "xyz" });
  });

  it("T-Sidecar.Args.3: when argv is empty, parseArgs falls back to FRONDOSE_PORT_FILE + FRONDOSE_TOKEN env", () => {
    // Given: argv = [], process.env.FRONDOSE_PORT_FILE = "/tmp/z.port", process.env.FRONDOSE_TOKEN = "tok"
    // When:  parseArgs(argv) runs
    // Then:  returns { portFile: "/tmp/z.port", bearerToken: "tok" }
    assert.ok(sourceExists, "src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure)");
    assert.ok(sidecarModule, "sidecarMain module must load");
    const prevPortFile = process.env.FRONDOSE_PORT_FILE;
    const prevToken = process.env.FRONDOSE_TOKEN;
    try {
      process.env.FRONDOSE_PORT_FILE = "/tmp/z.port";
      process.env.FRONDOSE_TOKEN = "tok";
      const result = sidecarModule.parseArgs([]);
      assert.deepEqual(result, { portFile: "/tmp/z.port", bearerToken: "tok" });
    } finally {
      if (prevPortFile === undefined) {
        delete process.env.FRONDOSE_PORT_FILE;
      } else {
        process.env.FRONDOSE_PORT_FILE = prevPortFile;
      }
      if (prevToken === undefined) {
        delete process.env.FRONDOSE_TOKEN;
      } else {
        process.env.FRONDOSE_TOKEN = prevToken;
      }
    }
  });

  it("T-Sidecar.Args.4: when flags and env are both set, flags win over env", () => {
    // Given: argv = ["--port-file", "/tmp/flag.port", "--token", "flag-tok"], FRONDOSE_PORT_FILE + FRONDOSE_TOKEN also set
    // When:  parseArgs(argv) runs
    // Then:  returns the flag values, not the env values
    assert.ok(sourceExists, "src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure)");
    assert.ok(sidecarModule, "sidecarMain module must load");
    const prevPortFile = process.env.FRONDOSE_PORT_FILE;
    const prevToken = process.env.FRONDOSE_TOKEN;
    try {
      process.env.FRONDOSE_PORT_FILE = "/tmp/env.port";
      process.env.FRONDOSE_TOKEN = "env-tok";
      const result = sidecarModule.parseArgs(["--port-file", "/tmp/flag.port", "--token", "flag-tok"]);
      assert.deepEqual(result, { portFile: "/tmp/flag.port", bearerToken: "flag-tok" });
    } finally {
      if (prevPortFile === undefined) {
        delete process.env.FRONDOSE_PORT_FILE;
      } else {
        process.env.FRONDOSE_PORT_FILE = prevPortFile;
      }
      if (prevToken === undefined) {
        delete process.env.FRONDOSE_TOKEN;
      } else {
        process.env.FRONDOSE_TOKEN = prevToken;
      }
    }
  });

  it("T-Sidecar.Args.5: when both flags and env are absent, parseArgs writes FATAL to stderr and calls process.exit(2)", () => {
    // Given: argv = [], FRONDOSE_PORT_FILE and FRONDOSE_TOKEN unset
    // When:  parseArgs(argv) runs
    // Then:  process.stderr receives line containing "FATAL: --port-file and --token required";
    //        process.exit(2) is invoked (stubbed to avoid aborting the test)
    assert.ok(sourceExists, "src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure)");
    assert.ok(sidecarModule, "sidecarMain module must load");

    // Stub process.exit to capture the call without killing the process
    const exitCalls: number[] = [];
    const exitStub = mock.method(process, "exit", (code?: number | string | null | undefined) => {
      exitCalls.push(typeof code === "number" ? code : Number(code ?? 0));
    });

    // Capture stderr writes
    const stderrChunks: string[] = [];
    const stderrStub = mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });

    const prevPortFile = process.env.FRONDOSE_PORT_FILE;
    const prevToken = process.env.FRONDOSE_TOKEN;
    try {
      delete process.env.FRONDOSE_PORT_FILE;
      delete process.env.FRONDOSE_TOKEN;
      try {
        sidecarModule.parseArgs([]);
      } catch {
        // parseArgs may throw after the exit stub is called; swallow
      }
    } finally {
      exitStub.mock.restore();
      stderrStub.mock.restore();
      if (prevPortFile !== undefined) process.env.FRONDOSE_PORT_FILE = prevPortFile;
      if (prevToken !== undefined) process.env.FRONDOSE_TOKEN = prevToken;
    }

    const stderrOutput = stderrChunks.join("");
    assert.match(stderrOutput, /FATAL.*--port-file.*--token|FATAL.*required/i);
    assert.ok(exitCalls.includes(2), `process.exit(2) must be called; got: ${JSON.stringify(exitCalls)}`);
  });
});

// ── Main() integration tests (T-Sidecar.Main.*) ─────────────────────────────

describe("T-Sidecar.Main — main() integration and ESM guard", () => {
  it("T-Sidecar.Main.1: when called with valid argv, main() invokes registerCrashHandlers then runServeSubcommand then process.exit(0)", async () => {
    // Given: stub runServeSubcommand resolves immediately; registerCrashHandlers is a spy;
    //        valid argv contains --sock and --token
    // When:  main() runs to completion
    // Then:  registerCrashHandlers called once BEFORE runServeSubcommand;
    //        runServeSubcommand called with { sockPath, bearerToken };
    //        process.exit(0) called after await resolves
    assert.ok(sourceExists, "src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure)");

    const crashLoggerUrl = pathToFileURL(resolve(process.cwd(), "src/cli/crashLogger.js")).href;
    const serveUrl = pathToFileURL(resolve(process.cwd(), "src/cli/subcommands/serve.js")).href;

    const callOrder: string[] = [];
    let capturedServeOpts: unknown = null;

    mock.module(crashLoggerUrl, {
      namedExports: {
        registerCrashHandlers: () => {
          callOrder.push("registerCrashHandlers");
        },
      },
    });

    mock.module(serveUrl, {
      namedExports: {
        runServeSubcommand: async (opts: unknown) => {
          capturedServeOpts = opts;
          callOrder.push("runServeSubcommand");
        },
      },
    });

    const exitCalls: number[] = [];
    const exitStub = mock.method(process, "exit", (code?: number | string | null | undefined) => {
      exitCalls.push(typeof code === "number" ? code : Number(code ?? 0));
    });

    const savedArgv = process.argv;
    process.argv = ["node", SIDECAR_SRC, "--port-file", "/tmp/main1.port", "--token", "tok1"];

    try {
      const mod = (await import(
        pathToFileURL(SIDECAR_SRC).href + `?bust=${Date.now()}`
      ).catch(() => null)) as SidecarModule | null;
      assert.ok(mod, "sidecarMain module must load under mocks");
      await mod.main();
    } finally {
      process.argv = savedArgv;
      exitStub.mock.restore();
      mock.restoreAll();
    }

    // crashHandlers BEFORE runServeSubcommand
    const crashIdx = callOrder.indexOf("registerCrashHandlers");
    const serveIdx = callOrder.indexOf("runServeSubcommand");
    assert.ok(crashIdx !== -1, "registerCrashHandlers must be called");
    assert.ok(serveIdx !== -1, "runServeSubcommand must be called");
    assert.ok(crashIdx < serveIdx, "registerCrashHandlers must be called BEFORE runServeSubcommand");
    assert.deepEqual(capturedServeOpts, { portFile: "/tmp/main1.port", bearerToken: "tok1" });
    assert.ok(exitCalls.includes(0), `process.exit(0) must be called after serve resolves; got: ${JSON.stringify(exitCalls)}`);
  });

  it("T-Sidecar.Main.2: importing the module with a test-runner argv[1] does NOT auto-invoke main()", async () => {
    // Given: process.argv[1] is the test runner path (not sidecarMain.js);
    //        parseArgs + main are exported from src/app/sidecarMain.ts
    // When:  the test runtime evaluates the module (no shell invocation)
    // Then:  the ESM entrypoint guard evaluates false → main() not invoked at import time;
    //        runServeSubcommand not called; process.exit not called; no socket opened
    assert.ok(sourceExists, "src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure)");

    // process.argv[1] under the test runner is the test runner script, not sidecarMain.js
    // The guard check is: import.meta.url === pathToFileURL(process.argv[1]).href
    // When running via node --test, process.argv[1] is the test file path — never sidecarMain.js
    const serveCallCount = { n: 0 };
    const exitCallCount = { n: 0 };

    const serveUrl = pathToFileURL(resolve(process.cwd(), "src/cli/subcommands/serve.js")).href;
    mock.module(serveUrl, {
      namedExports: {
        runServeSubcommand: async () => {
          serveCallCount.n += 1;
        },
      },
    });

    const exitStub = mock.method(process, "exit", () => {
      exitCallCount.n += 1;
    });

    try {
      // Fresh import (cache-busted) so module top-level runs again under mocks
      await import(pathToFileURL(SIDECAR_SRC).href + `?bust2=${Date.now()}`).catch(() => null);
    } finally {
      exitStub.mock.restore();
      mock.restoreAll();
    }

    assert.equal(serveCallCount.n, 0, "runServeSubcommand must NOT be called at import time");
    assert.equal(exitCallCount.n, 0, "process.exit must NOT be called at import time");
  });

  it("T-Sidecar.Main.3: crash-handler is registered BEFORE the serve graph dynamic-import fires", async () => {
    // Given: dynamic import of serve.js throws a synthetic import-time error;
    //        registerCrashHandlers is wrapped to record invocation order
    // When:  main() runs with valid argv
    // Then:  registerCrashHandlers is called BEFORE the dynamic import attempt;
    //        main() rejects with the synthetic error (not an unhandled pre-bootstrap exit)
    assert.ok(sourceExists, "src/app/sidecarMain.ts must exist (pre-impl: intentional scaffold failure)");

    const callOrder: string[] = [];

    const crashLoggerUrl = pathToFileURL(resolve(process.cwd(), "src/cli/crashLogger.js")).href;
    mock.module(crashLoggerUrl, {
      namedExports: {
        registerCrashHandlers: () => {
          callOrder.push("registerCrashHandlers");
        },
      },
    });

    // Stub the serve module to throw at import time by replacing it with a
    // module whose default export getter throws — we use a named export that
    // runServeSubcommand tries to call, which causes the dynamic import to
    // resolve but the function call to throw (simulating an import-time error
    // in the serve graph caught by the already-registered crash handler).
    const serveUrl = pathToFileURL(resolve(process.cwd(), "src/cli/subcommands/serve.js")).href;
    mock.module(serveUrl, {
      namedExports: {
        runServeSubcommand: async () => {
          callOrder.push("runServeSubcommand_throw");
          throw new Error("induced serve-graph import-time throw");
        },
      },
    });

    const exitStub = mock.method(process, "exit", () => {
      /* swallow */
    });
    const savedArgv = process.argv;
    process.argv = ["node", SIDECAR_SRC, "--port-file", "/tmp/main3.port", "--token", "tok3"];

    let caughtError: Error | null = null;
    try {
      const mod = (await import(
        pathToFileURL(SIDECAR_SRC).href + `?bust3=${Date.now()}`
      ).catch(() => null)) as SidecarModule | null;
      assert.ok(mod, "sidecarMain module must load");
      await mod.main();
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    } finally {
      process.argv = savedArgv;
      exitStub.mock.restore();
      mock.restoreAll();
    }

    const crashIdx = callOrder.indexOf("registerCrashHandlers");
    const serveThrowIdx = callOrder.indexOf("runServeSubcommand_throw");
    assert.ok(crashIdx !== -1, "registerCrashHandlers must be called");
    assert.ok(serveThrowIdx !== -1, "serve mock (throw path) must be reached");
    assert.ok(
      crashIdx < serveThrowIdx,
      `registerCrashHandlers (idx ${crashIdx}) must precede serve-graph call (idx ${serveThrowIdx})`,
    );
    assert.ok(
      caughtError !== null && /induced serve-graph import-time throw/.test(caughtError.message),
      `main() must reject with the induced error; got: ${caughtError?.message ?? "no error"}`,
    );
  });
});
