/**
 * P-APP-9 Step 3 — Test scaffold for src/app/updateServerMain.ts
 *
 * Covers:
 *   T-UpdateSrv.Args.1  — --port/--site-dir space form
 *   T-UpdateSrv.Args.2  — --port=<n>/--site-dir=<d> equals form
 *   T-UpdateSrv.Args.3  — no flags → both undefined (body supplies defaults)
 *   T-UpdateSrv.Args.4  — unknown args + leading positional ignored
 *   T-UpdateSrv.Main.1  — registerCrashHandlers called BEFORE dynamic import of update-server body;
 *                         runUpdateServerSubcommand called with parsed {port, siteDir};
 *                         process.exit(0) called after await resolves
 *   T-UpdateSrv.Main.2  — importing the module does NOT auto-run main() (ESM entrypoint guard)
 *
 * All assertion bodies are fully wired — pre-impl these fail because
 * src/app/updateServerMain.ts does not exist yet (outside-in red).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/app/updateServerMain.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

const UPDATE_SERVER_SRC = resolve(process.cwd(), "src/app/updateServerMain.ts");

// Guard: if the source file does not exist yet, assertions below
// fail immediately with a clear pre-impl message (outside-in red).
const sourceExists = existsSync(UPDATE_SERVER_SRC);

type ParseArgs = (argv: string[]) => { port?: string; siteDir?: string };
type Main = () => Promise<void>;
type UpdateServerModule = { parseArgs: ParseArgs; main: Main };

let updateServerModule: UpdateServerModule | null = null;

// ── Arg-parsing tests (T-UpdateSrv.Args.*) ──────────────────────────────────
// parseArgs() is a pure exported function; no mocks needed beyond source existence.

describe("T-UpdateSrv.Args — parseArgs flag resolution", () => {
  before(async () => {
    if (sourceExists) {
      const url = pathToFileURL(UPDATE_SERVER_SRC).href;
      updateServerModule = (await import(url).catch(() => null)) as UpdateServerModule | null;
    }
  });

  it("T-UpdateSrv.Args.1: when --port and --site-dir flags are present in space form, parseArgs returns both values", async () => {
    // Given: argv = ["--port", "4875", "--site-dir", "/tmp/site"]
    // When:  parseArgs(argv) runs
    // Then:  returns { port: "4875", siteDir: "/tmp/site" } (raw strings; body does the Number() parse)
    assert.ok(
      sourceExists,
      "src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure)",
    );
    assert.ok(updateServerModule, "updateServerMain module must load");
    const result = updateServerModule.parseArgs(["--port", "4875", "--site-dir", "/tmp/site"]);
    assert.deepEqual(result, { port: "4875", siteDir: "/tmp/site" });
  });

  it("T-UpdateSrv.Args.2: when --port=<n> and --site-dir=<d> equals forms are used, parseArgs returns both values", async () => {
    // Given: argv = ["--port=4900", "--site-dir=/var/site"]
    // When:  parseArgs(argv) runs
    // Then:  returns { port: "4900", siteDir: "/var/site" }
    assert.ok(
      sourceExists,
      "src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure)",
    );
    assert.ok(updateServerModule, "updateServerMain module must load");
    const result = updateServerModule.parseArgs(["--port=4900", "--site-dir=/var/site"]);
    assert.deepEqual(result, { port: "4900", siteDir: "/var/site" });
  });

  it("T-UpdateSrv.Args.3: when no flags are present, parseArgs returns both fields undefined", async () => {
    // Given: argv = [] (the exact zero-flag shape the live launchd plist uses)
    // When:  parseArgs(argv) runs
    // Then:  returns { port: undefined, siteDir: undefined }; no FATAL exit (unlike sidecarMain)
    assert.ok(
      sourceExists,
      "src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure)",
    );
    assert.ok(updateServerModule, "updateServerMain module must load");
    const result = updateServerModule.parseArgs([]);
    assert.deepEqual(result, { port: undefined, siteDir: undefined });
  });

  it("T-UpdateSrv.Args.4: when unknown args and a leading positional are present, parseArgs ignores them", async () => {
    // Given: argv = ["update-server", "--port", "4875", "--bogus", "x"]
    // When:  parseArgs(argv) runs
    // Then:  returns { port: "4875", siteDir: undefined }; positional + --bogus silently dropped, no throw
    assert.ok(
      sourceExists,
      "src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure)",
    );
    assert.ok(updateServerModule, "updateServerMain module must load");
    const result = updateServerModule.parseArgs(["update-server", "--port", "4875", "--bogus", "x"]);
    assert.deepEqual(result, { port: "4875", siteDir: undefined });
  });

  it("T-UpdateSrv.Args.5: when --port is the last arg with no value following, parseArgs does not crash and port stays undefined", async () => {
    // Given: argv = ["--port"] (--port as last arg, no value token)
    // When:  parseArgs(argv) runs
    // Then:  returns { port: undefined, siteDir: undefined }; no throw, no out-of-bounds access
    //        (the i + 1 < argv.length guard in the parser prevents consuming a phantom next arg)
    assert.ok(
      sourceExists,
      "src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure)",
    );
    assert.ok(updateServerModule, "updateServerMain module must load");
    assert.doesNotThrow(() => {
      const result = updateServerModule!.parseArgs(["--port"]);
      assert.deepEqual(result, { port: undefined, siteDir: undefined });
    }, "--port as last arg must not throw");
  });

  it("T-UpdateSrv.Args.6: when --site-dir is the last arg with no value following, parseArgs does not crash and siteDir stays undefined", async () => {
    // Given: argv = ["--site-dir"] (--site-dir as last arg, no value token)
    // When:  parseArgs(argv) runs
    // Then:  returns { port: undefined, siteDir: undefined }; no throw
    assert.ok(
      sourceExists,
      "src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure)",
    );
    assert.ok(updateServerModule, "updateServerMain module must load");
    assert.doesNotThrow(() => {
      const result = updateServerModule!.parseArgs(["--site-dir"]);
      assert.deepEqual(result, { port: undefined, siteDir: undefined });
    }, "--site-dir as last arg must not throw");
  });
});

// ── Main() integration tests (T-UpdateSrv.Main.*) ───────────────────────────

describe("T-UpdateSrv.Main — main() integration and ESM entrypoint guard", () => {
  it("T-UpdateSrv.Main.1: main() registers crash handlers BEFORE the dynamic body import, then calls runUpdateServerSubcommand, then process.exit(0)", async () => {
    // Given: registerCrashHandlers is a spy recording call order; stub runUpdateServerSubcommand resolves immediately;
    //        argv carries --port and --site-dir
    // When:  main() runs to completion
    // Then:  registerCrashHandlers invoked exactly once BEFORE the dynamic import resolves;
    //        runUpdateServerSubcommand called with { port, siteDir } matching argv;
    //        process.exit(0) called after await resolves
    assert.ok(
      sourceExists,
      "src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure)",
    );

    const crashLoggerUrl = pathToFileURL(
      resolve(process.cwd(), "src/cli/crashLogger.js"),
    ).href;
    const updateServerBodyUrl = pathToFileURL(
      resolve(process.cwd(), "src/cli/subcommands/updateServer.js"),
    ).href;

    const callOrder: string[] = [];
    let capturedOpts: unknown = null;

    mock.module(crashLoggerUrl, {
      namedExports: {
        registerCrashHandlers: () => {
          callOrder.push("registerCrashHandlers");
        },
      },
    });

    mock.module(updateServerBodyUrl, {
      namedExports: {
        runUpdateServerSubcommand: async (opts: unknown) => {
          capturedOpts = opts;
          callOrder.push("runUpdateServerSubcommand");
        },
      },
    });

    const exitCalls: number[] = [];
    const exitStub = mock.method(
      process,
      "exit",
      (code?: number | string | null | undefined) => {
        exitCalls.push(typeof code === "number" ? code : Number(code ?? 0));
      },
    );

    const savedArgv = process.argv;
    process.argv = [
      "node",
      UPDATE_SERVER_SRC,
      "--port",
      "48751",
      "--site-dir",
      "/tmp/mai-app9-test",
    ];

    try {
      const mod = (await import(
        pathToFileURL(UPDATE_SERVER_SRC).href + `?bust=${Date.now()}`
      ).catch(() => null)) as UpdateServerModule | null;
      assert.ok(mod, "updateServerMain module must load under mocks");
      await mod.main();
    } finally {
      process.argv = savedArgv;
      exitStub.mock.restore();
      mock.restoreAll();
    }

    // Ordering assertion: crash handlers BEFORE the body (dynamic-import outcome)
    const crashIdx = callOrder.indexOf("registerCrashHandlers");
    const bodyIdx = callOrder.indexOf("runUpdateServerSubcommand");
    assert.ok(crashIdx !== -1, "registerCrashHandlers must be called");
    assert.ok(bodyIdx !== -1, "runUpdateServerSubcommand must be called");
    assert.ok(
      crashIdx < bodyIdx,
      `registerCrashHandlers (idx ${crashIdx}) must precede runUpdateServerSubcommand (idx ${bodyIdx})`,
    );

    // The opts passed must match parseArgs output for the argv above
    assert.deepEqual(
      capturedOpts,
      { port: "48751", siteDir: "/tmp/mai-app9-test" },
    );

    assert.ok(
      exitCalls.includes(0),
      `process.exit(0) must be called after runUpdateServerSubcommand resolves; got: ${JSON.stringify(exitCalls)}`,
    );
  });

  it("T-UpdateSrv.Main.2: importing the module with test-runner argv[1] does NOT auto-invoke main()", async () => {
    // Given: process.argv[1] is the test runner path (not updateServerMain.js);
    //        parseArgs + main are exported from src/app/updateServerMain.ts
    // When:  the test runtime evaluates the module (no shell invocation)
    // Then:  ESM entrypoint guard (import.meta.url === pathToFileURL(process.argv[1]).href) is false;
    //        main() is NOT invoked; runUpdateServerSubcommand not called; process.exit not called
    assert.ok(
      sourceExists,
      "src/app/updateServerMain.ts must exist (pre-impl: intentional scaffold failure)",
    );

    // process.argv[1] under node --test is the test file, never updateServerMain.ts
    const bodyCallCount = { n: 0 };
    const exitCallCount = { n: 0 };

    const updateServerBodyUrl = pathToFileURL(
      resolve(process.cwd(), "src/cli/subcommands/updateServer.js"),
    ).href;
    mock.module(updateServerBodyUrl, {
      namedExports: {
        runUpdateServerSubcommand: async () => {
          bodyCallCount.n += 1;
        },
      },
    });

    const exitStub = mock.method(process, "exit", () => {
      exitCallCount.n += 1;
    });

    try {
      // Cache-busted import; module top-level runs again under mocks
      await import(
        pathToFileURL(UPDATE_SERVER_SRC).href + `?bust2=${Date.now()}`
      ).catch(() => null);
    } finally {
      exitStub.mock.restore();
      mock.restoreAll();
    }

    assert.equal(
      bodyCallCount.n,
      0,
      "runUpdateServerSubcommand must NOT be called at import time",
    );
    assert.equal(
      exitCallCount.n,
      0,
      "process.exit must NOT be called at import time",
    );
  });
});
