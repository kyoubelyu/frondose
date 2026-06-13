/**
 * P-25 Step 5 — T-SRV.REPL.1..4
 *
 * Tests for runServerRepl (foreground server REPL + Telegram + cron).
 * Gate coverage: G-P25.14, G-P25.16
 *
 * Step-5a fix (D-SRV.DAEMON.CONFIGPATH resolved):
 * readTelegramConfig now receives SERVER_CONFIG_PATH() as its second arg in
 * serverRepl.ts. Tests write boundUserId to ~/.mai/server/config.json (the
 * server config), not the worker config.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { TurnLock } from "../../src/agent/turnSemaphore.js";
import { runServerRepl } from "../../src/cli/serverRepl.js";
import { writePid } from "../../src/persistence/processLock.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p25-srvrepl-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    return true;
  };
  return fn()
    .catch(() => {})
    .then(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origWrite;
      return chunks.join("");
    });
}

async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    return true;
  };
  return fn()
    .catch(() => {})
    .then(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = origWrite;
      return chunks.join("");
    });
}

/** Returns a mutable `captured` object — safe to check after mock throws. */
function mockProcessExit(): { captured: { value: number | null }; restore: () => void } {
  const captured = { value: null as number | null };
  const orig = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — throw to halt execution
  (process as any).exit = (code?: number) => {
    captured.value = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  };
  return {
    captured,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = orig;
    },
  };
}

// P-Z3 (cat-10): each test boots its own server REST listener; the config default
// rest_port (3031) collides → EADDRINUSE when multiple tests run in one process.
// Seed a UNIQUE ≥1024 port per writeServerEnv call (schema requires min 1024; true
// listen(0) is not expressible without a src affordance — §6.4). Collision-proof.
let pZ3RestPort = 31000;
function nextRestPort(): number {
  return ++pZ3RestPort; // 31001, 31002, … (≤ 65535, well clear of the 3031 default)
}
// NIT-2: serverRepl ALSO binds the web dashboard port (default 8090) → seed it unique too.
let pZ3WebPort = 38000;
function nextWebPort(): number {
  return ++pZ3WebPort; // 38001, 38002, … (well clear of the 8090 default)
}

/**
 * Write the minimal file tree under dir for a valid server environment:
 *   - .mai/server/identity.json
 *   - .mai/server/telegram.json  (runtime only)
 *   - .mai/server/config.json    (server config; holds boundUserId — Step-5a fix)
 *   - .mai/agent/secrets.json    (fake key for resolveModel)
 *
 * The sessions dir is auto-created by serverSessionFile().
 */
function writeServerEnv(dir: string): void {
  const maiServerDir = join(dir, ".frondose", "server");
  const maiAgentDir = join(dir, ".frondose", "agent");
  mkdirSync(maiServerDir, { recursive: true });
  mkdirSync(maiAgentDir, { recursive: true });

  // Server identity.json
  writeFileSync(
    join(maiServerDir, "identity.json"),
    JSON.stringify({
      operatorName: "TestOperator",
      orchestratorName: "mai-server",
      orchestratorRole: "Operator's chief-of-staff agent",
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    }),
    "utf-8",
  );

  // Telegram runtime config (telegram.json)
  writeFileSync(
    join(maiServerDir, "telegram.json"),
    JSON.stringify({
      lastUpdateOffset: 0,
      stickyFallbackIp: null,
      pollTimeoutSec: 1,
      pollBackoffSec: 1,
    }),
    "utf-8",
  );

  // Step-5a fix (D-SRV.DAEMON.CONFIGPATH): readTelegramConfig now reads boundUserId from
  // SERVER_CONFIG_PATH = ~/.mai/server/config.json. Write it there.
  writeFileSync(
    join(maiServerDir, "config.json"),
    // P-Z3 (cat-10 + NIT-2): unique rest_port + web_port per test → no EADDRINUSE.
    JSON.stringify({
      schema_version: 1,
      telegram: { boundUserId: null },
      server: { rest_port: nextRestPort(), web_port: nextWebPort() },
    }),
    "utf-8",
  );

  // Write fake secrets.json so resolveModel({}) can find the deepseek provider.
  // P-71: use deepseek (not anthropic which is now scope-disabled).
  // The key is never validated (no API call happens — readline exits on EOF before any turn).
  writeFileSync(
    join(maiAgentDir, "secrets.json"),
    JSON.stringify({
      schema_version: 1,
      providers: {
        deepseek: { key: "sk-fake-test-key-not-real", type: "openai", baseUrl: "https://api.deepseek.com/v1" },
      },
    }),
    "utf-8",
  );
}

// ─── T-SRV.REPL ───────────────────────────────────────────────────────────────

describe("runServerRepl (G-P25.14, G-P25.16)", () => {
  it("T-SRV.REPL.1: foreground runServerRepl creates readline on supplied stdin; emits startup message; returns after stdin EOF", async () => {
    // Given: mocked stdin (Readable.from([])) — emits EOF immediately; HOME overridden to tmp;
    //        server identity.json present; telegram runtime present; TELEGRAM_TOKEN set
    // When:  runServerRepl({stdin: mockStdin}) called
    // Then:  resolves as "done" (not "timeout") within 2s; stdout has "[server] mai-server ready"
    //        and "[server] session closed."
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    const savedToken = process.env.TELEGRAM_TOKEN;
    try {
      process.env.HOME = dir;
      process.env.TELEGRAM_TOKEN = "fake-repl-token-001";
      writeServerEnv(dir);

      const mockStdin = Readable.from([]);

      let stdout = "";
      const raceResult = await Promise.race([
        captureStdout(() => runServerRepl({ stdin: mockStdin })).then((s) => {
          stdout = s;
          return "done";
        }),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 2000)),
      ]);

      assert.equal(raceResult, "done", "runServerRepl must return after stdin EOF (not hang)");
      assert.ok(
        stdout.includes("[server] mai-server ready"),
        `stdout must contain '[server] mai-server ready'; got: ${stdout.slice(0, 300)}`,
      );
      assert.ok(
        stdout.includes("[server] session closed."),
        `stdout must contain '[server] session closed.'; got: ${stdout.slice(0, 300)}`,
      );
    } finally {
      process.env.HOME = savedHome;
      if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
      else delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });

  it("T-SRV.REPL.2: when readline turn + Telegram turn arrive concurrently, TurnLock serializes them (second waits for first)", async () => {
    // Given: TurnLock instance; two concurrent lock.run() callers — first holds for 40ms, second arrives immediately
    // When:  Promise.all([first.run(), second.run()]) awaited
    // Then:  execution log is [1, 2] — first completes entirely before second starts
    const lock = new TurnLock();
    const log: number[] = [];

    const first = lock.run(async () => {
      await new Promise<void>((r) => setTimeout(r, 40));
      log.push(1);
    });

    // Second is dispatched immediately after first is queued (both fire "concurrently" from
    // the perspective of the event loop — first is in the chain but hasn't started yet).
    const second = lock.run(async () => {
      log.push(2);
    });

    await Promise.all([first, second]);

    assert.deepEqual(log, [1, 2], "TurnLock must serialize: first completes before second starts");
  });

  it("T-SRV.REPL.3: when server.pid is alive, runServerRepl exits 1 with 'daemon already running' message", async () => {
    // Given: server.pid file containing current process.pid (alive)
    // When:  runServerRepl() called
    // Then:  process.exit(1) called; stderr contains "daemon already running"
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    const { captured, restore } = mockProcessExit();
    try {
      process.env.HOME = dir;
      const maiServerDir = join(dir, ".frondose", "server");
      mkdirSync(maiServerDir, { recursive: true });
      // Write live PID (current test runner process — guaranteed alive)
      writePid(join(maiServerDir, "server.pid"));

      const stderr = await captureStderr(() => runServerRepl().catch(() => {}));

      assert.equal(captured.value, 1, "process.exit(1) must be called");
      assert.ok(
        stderr.includes("daemon already running"),
        `stderr must contain 'daemon already running'; got: ${stderr}`,
      );
    } finally {
      process.env.HOME = savedHome;
      restore();
      cleanup();
    }
  });

  it("T-SRV.REPL.4: when stdin is a non-TTY piped stream, readline initialized in non-terminal mode; returns cleanly on EOF", async () => {
    // Given: mockStdin = Readable.from([]) — isTTY is undefined (not a terminal); HOME overridden;
    //        server identity + telegram runtime present; TELEGRAM_TOKEN set
    // When:  runServerRepl({stdin: mockStdin}) called
    // Then:  no throw on EOF (no ERR_USE_AFTER_CLOSE); raceResult is "done"
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    const savedToken = process.env.TELEGRAM_TOKEN;
    try {
      process.env.HOME = dir;
      process.env.TELEGRAM_TOKEN = "fake-repl-token-004";
      writeServerEnv(dir);

      const mockStdin = Readable.from([]);
      // Non-TTY contract: Readable.from([]) has isTTY === undefined
      assert.strictEqual(
        (mockStdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY,
        undefined,
        "mock stdin must be non-TTY (isTTY === undefined)",
      );

      let threw: unknown = null;
      const raceResult = await Promise.race([
        runServerRepl({ stdin: mockStdin })
          .catch((e) => {
            threw = e;
          })
          .then(() => "done"),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 2000)),
      ]);

      assert.equal(raceResult, "done", "runServerRepl must return cleanly on non-TTY EOF");
      assert.equal(threw, null, `runServerRepl must not throw on non-TTY EOF; threw: ${threw}`);
    } finally {
      process.env.HOME = savedHome;
      if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
      else delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });
});
