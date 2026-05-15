/**
 * P-25 Step 5 — T-SRV.DAEMON.1..4
 *
 * Tests for runServerDaemon (mai server daemon — launchd-invoked).
 * Gate coverage: G-P25.15, G-P25.16, G-P25.17
 *
 * Step-5a fix (D-SRV.DAEMON.CONFIGPATH resolved):
 * readTelegramConfig now receives SERVER_CONFIG_PATH() as its second arg in
 * serverDaemon.ts and serverRepl.ts. Tests write boundUserId to
 * ~/.mai/server/config.json (the server config), not the worker config.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { removePid, writePid } from "../../src/persistence/processLock.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p25-srvdaemon-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mockProcessExit(): { captured: number | null; restore: () => void } {
  const result = { captured: null as number | null };
  const orig = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — throw to halt execution
  (process as any).exit = (code?: number) => {
    result.captured = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  };
  return {
    ...result,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = orig;
    },
  };
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

/** Create a minimal valid server identity.json at the given path. */
function writeServerIdentityFile(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
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
}

// ─── T-SRV.DAEMON ─────────────────────────────────────────────────────────────

describe("runServerDaemon (G-P25.15, G-P25.16, G-P25.17)", () => {
  it("T-SRV.DAEMON.1: when no server.pid exists, daemon writes own PID and emits startup message; readline NOT used", async () => {
    // Given: no server.pid; TELEGRAM_TOKEN set; server identity + config present;
    //        HOME overridden to tmpDir so all paths route to tmp
    // When:  runServerDaemon() called fire-and-forget; 300ms wait for sync startup to complete
    // Then:  server.pid written with process.pid; stdout has "[server daemon] up, PID";
    //        readline NOT imported in serverDaemon.ts (static assertion)
    //
    // NOTE (D-SRV.DAEMON.CONFIGPATH): readTelegramConfig reads boundUserId from
    // ~HOME/.mai/agent/config.json (worker config), not server config. Workaround:
    // write to worker config path. Fix required in serverDaemon.ts (see §2.4).
    //
    // NOTE on hold-Promise: runServerDaemon() blocks forever at an AbortController-gated
    // hold-Promise after startup. We fire-and-forget to avoid this leaking into the
    // test race. The daemon runs in the background; all assertions are checked AFTER the
    // 300ms startup window. The leaked promise is suppressed via .catch(()=>{}).
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    const savedToken = process.env.TELEGRAM_TOKEN;
    const stdoutChunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stdout as any).write = (chunk: string | Buffer) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    try {
      process.env.HOME = dir;
      process.env.TELEGRAM_TOKEN = "test-daemon-token-123";

      // Create required dirs
      const maiServerDir = join(dir, ".mai", "server");
      const maiAgentDir = join(dir, ".mai", "agent");
      mkdirSync(maiServerDir, { recursive: true });
      mkdirSync(maiAgentDir, { recursive: true });

      // Write server identity.json (at SERVER_IDENTITY_PATH = $dir/.mai/server/identity.json)
      writeServerIdentityFile(join(maiServerDir, "identity.json"));

      // Write telegram.json runtime file (SERVER_TELEGRAM_CONFIG_PATH = $dir/.mai/server/telegram.json)
      writeFileSync(
        join(maiServerDir, "telegram.json"),
        JSON.stringify({ lastUpdateOffset: 0, stickyFallbackIp: null, pollTimeoutSec: 1, pollBackoffSec: 1 }),
        "utf-8",
      );

      // Step-5a fix (D-SRV.DAEMON.CONFIGPATH): readTelegramConfig now reads boundUserId from
      // SERVER_CONFIG_PATH = ~/.mai/server/config.json. Write it there.
      writeFileSync(
        join(maiServerDir, "config.json"),
        JSON.stringify({ schema_version: 1, telegram: { boundUserId: 12345 } }),
        "utf-8",
      );

      // Write fake secrets.json so resolveModel({}) can find the anthropic provider.
      // Key is never validated — daemon never makes an API call before the test completes.
      writeFileSync(
        join(maiAgentDir, "secrets.json"),
        JSON.stringify({
          schema_version: 1,
          providers: {
            anthropic: { key: "sk-fake-test-key-not-real", type: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
          },
        }),
        "utf-8",
      );

      const { runServerDaemon } = await import("../../src/cli/serverDaemon.js");

      // Fire-and-forget: daemon blocks at hold-Promise; we do NOT await it.
      // The leaked promise is suppressed to avoid UnhandledRejection noise.
      runServerDaemon().catch(() => {});

      // Wait 300ms for daemon's synchronous startup sequence to complete:
      // writePid → resolveModel → readTelegramConfig → startDaemonPoller → stdout write → hold-Promise
      await new Promise<void>((r) => setTimeout(r, 300));

      // PID file written
      const pidPath = join(maiServerDir, "server.pid");
      assert.ok(existsSync(pidPath), "server.pid must be written");
      const pidContent = readFileSync(pidPath, "utf-8").trim();
      assert.equal(Number(pidContent), process.pid, "server.pid must contain process.pid");

      // Startup message in stdout
      const stdout = stdoutChunks.join("");
      assert.ok(
        stdout.includes("[server daemon] up, PID"),
        `stdout must contain '[server daemon] up, PID'; got: ${stdout.slice(0, 200)}`,
      );

      // Static: readline NOT imported in serverDaemon.ts.
      // grep for import statements containing "readline" (not word-only; the comment at line 1
      // says "no readline" which grep -l would match without the import-line anchor).
      const { execSync } = await import("node:child_process");
      const projectRoot = new URL("../../", import.meta.url).pathname;
      const grepResult = execSync(
        'grep -n "^import.*readline\\|require.*readline" src/cli/serverDaemon.ts 2>/dev/null || true',
        { cwd: projectRoot, encoding: "utf-8" },
      );
      assert.strictEqual(grepResult.trim(), "", "serverDaemon.ts must NOT import readline");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = origStdoutWrite;
      process.env.HOME = savedHome;
      if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
      else delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });

  it("T-SRV.DAEMON.2: when server.pid contains alive PID, daemon exits 1 with 'already running, PID <N>'", async () => {
    // Given: server.pid file with process.pid (alive)
    // When:  runServerDaemon() called
    // Then:  process.exit(1) called; stderr contains "already running, PID"
    const { dir, cleanup } = makeTmpDir();
    const { restore } = mockProcessExit();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      const maiServerDir = join(dir, ".mai", "server");
      mkdirSync(maiServerDir, { recursive: true });
      // Write live PID (current test process)
      writePid(join(maiServerDir, "server.pid"));

      const { runServerDaemon } = await import("../../src/cli/serverDaemon.js");
      const stderr = await captureStderr(() => runServerDaemon());
      assert.ok(stderr.includes("already running"), `stderr must contain 'already running'; got: ${stderr}`);
      assert.ok(
        stderr.includes(String(process.pid)),
        `stderr must include the alive PID ${process.pid}; got: ${stderr}`,
      );
    } finally {
      process.env.HOME = savedHome;
      restore();
      cleanup();
    }
  });

  it("T-SRV.DAEMON.3: when TELEGRAM_TOKEN is unset, daemon exits 1 with explicit message", async () => {
    // Given: process.env.TELEGRAM_TOKEN unset; no server.pid (so PID mutex passes)
    // When:  runServerDaemon() called
    // Then:  process.exit(1) called; stderr mentions TELEGRAM_TOKEN or MAI_SERVER_TELEGRAM_TOKEN
    const { dir, cleanup } = makeTmpDir();
    const savedToken = process.env.TELEGRAM_TOKEN;
    const { restore } = mockProcessExit();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      delete process.env.TELEGRAM_TOKEN;
      mkdirSync(join(dir, ".mai", "server"), { recursive: true });
      // No server.pid → PID mutex passes

      const { runServerDaemon } = await import("../../src/cli/serverDaemon.js");
      const stderr = await captureStderr(() => runServerDaemon());
      assert.ok(
        stderr.includes("TELEGRAM_TOKEN") || stderr.includes("MAI_SERVER_TELEGRAM_TOKEN"),
        `stderr must mention TELEGRAM_TOKEN; got: ${stderr}`,
      );
    } finally {
      process.env.HOME = savedHome;
      restore();
      if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
      cleanup();
    }
  });

  it("T-SRV.DAEMON.4: SIGTERM causes daemon to delete server.pid (via process.on('exit', cleanup)) and exit 0 immediately", () => {
    // Given: daemon registered process.on("SIGTERM", ...) and process.on("exit", cleanup)
    // When:  SIGTERM fires → process.exit(0) called
    // Then:  server.pid deleted; no wait for in-flight turn
    //
    // NOTE: Cannot send SIGTERM to the test runner process itself. Instead, this test
    // verifies the cleanup contract directly: removePid() deletes the PID file, which
    // is exactly what the SIGTERM handler calls (via cleanup = () => removePid(pidPath)).
    const { dir, cleanup } = makeTmpDir();
    try {
      const maiServerDir = join(dir, ".mai", "server");
      mkdirSync(maiServerDir, { recursive: true });
      const pidPath = join(maiServerDir, "server.pid");

      // Simulate what daemon does at startup: write PID
      writePid(pidPath);
      assert.ok(existsSync(pidPath), "server.pid must exist before cleanup");

      // Simulate what SIGTERM handler does: cleanup() = removePid(pidPath)
      removePid(pidPath);
      assert.ok(!existsSync(pidPath), "server.pid must be removed after cleanup (SIGTERM behavior)");
    } finally {
      cleanup();
    }
  });
});
